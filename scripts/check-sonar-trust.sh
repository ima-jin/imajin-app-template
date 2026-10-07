#!/usr/bin/env bash
# Proof for ima-jin/imajin-app-template#15.
#
# A `workflow_run` workflow always runs from the default branch, so the
# privileged `sonarcloud-pr` job cannot run on the PR that changes it. This
# script instead extracts that job's OWN `run:` blocks from
# .github/workflows/sonarcloud.yml (steps `pr`, `trusted` and `scan_args`) and
# executes them, exactly as the runner would (bash --noprofile --norc -eo
# pipefail), against a hostile payload fixture. The `trusted` step fetches the
# default branch's sonar-project.properties with `gh api`; there is no network
# here, so `gh` is replaced by a stub that serves the trusted fixture and logs
# its arguments (#17). It asserts the effective scanner args still point at
# sonarcloud.io under the trusted organization/projectKey, that malformed
# metadata is refused, and that a head SHA differing from the triggering CI
# run's head commit is refused.
#
# Needs: bash, jq, yq (mikefarah, preinstalled on GitHub's ubuntu runners).
# Runs from any directory; no secrets, no network.

set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$root/.github/workflows/sonarcloud.yml"
fixtures="$root/.github/sonar-trust-fixtures"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0
good_sha=0123456789abcdef0123456789abcdef01234567

# Stub `gh`: logs its arguments and serves the trusted fixture on stdout, the
# way `gh api -H 'Accept: application/vnd.github.raw+json' .../contents/...`
# returns the raw file. GH_STUB_FAIL=1 makes it fail like an API error.
mkdir -p "$work/bin"
cat >"$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_STUB_LOG"
if [[ "${GH_STUB_FAIL:-}" == "1" ]]; then
  echo "gh: HTTP 404" >&2
  exit 1
fi
cat "$GH_STUB_FIXTURE"
exit 0
STUB
chmod +x "$work/bin/gh"

fail() {
  local message=$1
  echo "FAIL: $message" >&2
  failures=$((failures + 1))
  return 0
}

pass() {
  local message=$1
  echo "ok:   $message"
  return 0
}

step_run() {
  local step_id=$1
  yq ".jobs.sonarcloud-pr.steps[] | select(.id == \"$step_id\") | .run" "$workflow"
  return 0
}

# Executes a job step script the way the runner does. Args: <script> <dir> <output-file> [VAR=value...].
# EXPECTED_HEAD_SHA defaults to the fixture SHA; extra VAR=value args override it.
run_step() {
  local script=$1 dir=$2 out=$3
  shift 3
  (cd "$dir" && env GITHUB_OUTPUT="$out" EXPECTED_HEAD_SHA="$good_sha" PATH="$work/bin:$PATH" \
    GH_STUB_LOG="$dir/gh.log" GH_STUB_FIXTURE="$fixtures/trusted/sonar-project.properties" "$@" bash --noprofile --norc -eo pipefail -c "$script") >"$dir/step.log" 2>&1
  return $?
}

output_of() {
  local file=$1 name=$2
  grep -m1 "^${name}=" "$file" | cut -d= -f2-
  return 0
}

# Builds a scratch workspace: sonar-payload/ (hostile) + sonar-trusted/ (default branch copy).
new_workspace() {
  local dir
  dir=$(mktemp -d -p "$work")
  cp -r "$fixtures/hostile-payload" "$dir/sonar-payload"
  cp -r "$fixtures/trusted" "$dir/sonar-trusted"
  echo "$dir"
  return 0
}

pr_script=$(step_run pr)
trusted_script=$(step_run trusted)
args_script=$(step_run scan_args)
if [[ -z "$pr_script" || -z "$trusted_script" || -z "$args_script" ]]; then
  echo "FAIL: could not extract steps 'pr', 'trusted' and 'scan_args' from $workflow" >&2
  exit 1
fi

# ── Static guards on the privileged job ──────────────────────────────────────
if yq '.jobs.sonarcloud-pr.steps[].run // ""' "$workflow" | grep -qF '${{'; then
  fail "a sonarcloud-pr run: block interpolates \${{ }} (untrusted input must go through env:)"
else
  pass "no \${{ }} interpolation inside sonarcloud-pr run: blocks"
fi

if [[ "$(yq '[.jobs.sonarcloud-pr.steps[].uses // "" | select(test("^actions/checkout"))] | length' "$workflow")" == "0" ]]; then
  pass "no actions/checkout in the privileged sonarcloud-pr job"
else
  fail "sonarcloud-pr runs actions/checkout (fetch the trusted file with gh api instead)"
fi

if [[ "$(yq '.permissions // ""' "$workflow")" == "" ]]; then
  pass "no workflow-level permissions (declared per job)"
else
  fail "workflow-level permissions block present (declare permissions per job)"
fi
for job in $(yq '.jobs | keys | .[]' "$workflow"); do
  if [[ "$(yq ".jobs.\"$job\".permissions // \"\"" "$workflow")" == "" ]]; then
    fail "job $job declares no permissions of its own"
  else
    pass "job $job declares its own permissions"
  fi
done
if [[ "$(yq '[.jobs[].permissions // {} | to_entries | .[] | select(.key == "pull-requests" and .value == "write")] | length' "$workflow")" == "0" ]]; then
  pass "no job requests pull-requests: write"
else
  fail "a job requests pull-requests: write"
fi

scan_uses=$(yq '.jobs.sonarcloud-pr.steps[] | select(.name == "SonarCloud Scan") | .uses' "$workflow")
if [[ "$scan_uses" =~ ^SonarSource/sonarqube-scan-action@[0-9a-f]{40}$ ]]; then
  pass "scan action is sonarqube-scan-action pinned by full commit SHA"
else
  fail "scan step is not SonarSource/sonarqube-scan-action pinned by full SHA (got: $scan_uses)"
fi

if [[ "$(yq '.jobs.sonarcloud-pr.steps[] | select(.name == "SonarCloud Scan") | .env.GITHUB_TOKEN // ""' "$workflow")" == "" ]]; then
  pass "scan step does not receive GITHUB_TOKEN"
else
  fail "scan step receives GITHUB_TOKEN"
fi

# ── Trusted properties are fetched with `gh api` from the default branch ─────
ws=$(mktemp -d -p "$work")
cp -r "$fixtures/hostile-payload" "$ws/sonar-payload"
: >"$ws/out"
if run_step "$trusted_script" "$ws" "$ws/out" GH_TOKEN=dummy REPO=ima-jin/example DEFAULT_BRANCH=trunk; then
  if cmp -s "$ws/sonar-trusted/sonar-project.properties" "$fixtures/trusted/sonar-project.properties"; then
    pass "trusted properties written to sonar-trusted/ from the contents API response"
  else
    fail "sonar-trusted/sonar-project.properties differs from the API response"
  fi
  if grep -qxF "api -H Accept: application/vnd.github.raw+json repos/ima-jin/example/contents/sonar-project.properties?ref=trunk" "$ws/gh.log"; then
    pass "gh api requests the raw file from the default branch of this repository"
  else
    fail "unexpected gh invocation: $(cat "$ws/gh.log")"
  fi
else
  fail "trusted fetch failed unexpectedly: $(cat "$ws/step.log")"
fi

ws=$(mktemp -d -p "$work")
: >"$ws/out"
if run_step "$trusted_script" "$ws" "$ws/out" GH_TOKEN=dummy REPO=ima-jin/example DEFAULT_BRANCH=trunk GH_STUB_FAIL=1; then
  fail "trusted fetch succeeded although gh api failed"
else
  pass "trusted fetch fails when gh api fails (no scan without trusted properties)"
fi

# ── Hostile payload ──────────────────────────────────────────────────────────
ws=$(new_workspace)
out="$ws/out"
: >"$out"
if run_step "$pr_script" "$ws" "$out" && run_step "$args_script" "$ws" "$out" \
  PR_NUMBER="$(output_of "$out" number)" PR_HEAD_REF="$(output_of "$out" headRef)" \
  PR_BASE_REF="$(output_of "$out" baseRef)" PR_HEAD_SHA="$(output_of "$out" headSha)"; then
  args=$(output_of "$out" args)
  echo "Effective Sonar scanner args (hostile payload): $args"
  grep -m1 "Effective Sonar scanner args" "$ws/step.log" >/dev/null && pass "effective-args log line emitted"

  for want in \
    "-Dsonar.host.url=https://sonarcloud.io" \
    "-Dsonar.scanner.sonarcloudUrl=https://sonarcloud.io" \
    "-Dsonar.organization=trusted-org" \
    "-Dsonar.projectKey=trusted-org_trusted-key" \
    "-Dsonar.pullrequest.key=123" \
    "-Dsonar.pullrequest.branch=feature/hostile" \
    "-Dsonar.pullrequest.base=main" \
    "-Dsonar.scm.revision=0123456789abcdef0123456789abcdef01234567"; do
    if [[ " $args " == *" $want "* ]]; then
      pass "args contain $want"
    else
      fail "args missing $want"
    fi
  done

  for bad in example.invalid attacker.invalid evil-org victim-project; do
    if [[ "$args" == *"$bad"* ]]; then
      fail "args leak hostile value '$bad'"
    else
      pass "args free of hostile value '$bad'"
    fi
  done

  if cmp -s "$ws/sonar-payload/sonar-project.properties" "$fixtures/trusted/sonar-project.properties"; then
    pass "payload sonar-project.properties was replaced by the trusted copy (byte-identical)"
  else
    fail "payload sonar-project.properties still differs from the trusted copy"
  fi
  if grep -rqE 'example\.invalid|attacker\.invalid|evil-org' "$ws/sonar-payload/sonar-project.properties"; then
    fail "hostile property survives in the scanned properties file"
  else
    pass "no hostile property survives in the scanned properties file"
  fi
else
  fail "hostile-payload run failed unexpectedly: $(cat "$ws/step.log")"
fi

# ── Symlinked properties file in the artifact must not redirect the overwrite ─
ws=$(new_workspace)
out="$ws/out"
: >"$out"
echo "victim-original" >"$ws/victim"
rm -f "$ws/sonar-payload/sonar-project.properties"
ln -s "$ws/victim" "$ws/sonar-payload/sonar-project.properties"
if run_step "$pr_script" "$ws" "$out" && run_step "$args_script" "$ws" "$out" \
  PR_NUMBER=123 PR_HEAD_REF=feature/x PR_BASE_REF=main PR_HEAD_SHA=0123456789abcdef0123456789abcdef01234567; then
  if [[ "$(cat "$ws/victim")" == "victim-original" && ! -L "$ws/sonar-payload/sonar-project.properties" ]]; then
    pass "symlinked payload properties replaced, symlink target untouched"
  else
    fail "symlinked payload properties file redirected the overwrite"
  fi
else
  fail "symlink case failed unexpectedly: $(cat "$ws/step.log")"
fi

# ── Metadata validation (head SHA, branch names, missing file) ───────────────
meta_case() {
  local label=$1 meta=$2 ws
  ws=$(new_workspace)
  printf '%s' "$meta" >"$ws/sonar-payload/sonar-pr-meta.json"
  : >"$ws/out"
  if run_step "$pr_script" "$ws" "$ws/out"; then
    fail "metadata accepted but should be refused: $label"
  else
    pass "metadata refused: $label"
  fi
  return 0
}

meta_case "SHA too short" "{\"prNumber\":1,\"headSha\":\"abc123\",\"headRef\":\"a\",\"baseRef\":\"main\"}"
meta_case "SHA 41 chars" "{\"prNumber\":1,\"headSha\":\"${good_sha}0\",\"headRef\":\"a\",\"baseRef\":\"main\"}"
meta_case "SHA non-hex" "{\"prNumber\":1,\"headSha\":\"${good_sha:0:39}z\",\"headRef\":\"a\",\"baseRef\":\"main\"}"
meta_case "SHA with injection" "{\"prNumber\":1,\"headSha\":\"${good_sha:0:30}; curl evil\",\"headRef\":\"a\",\"baseRef\":\"main\"}"
meta_case "SHA missing" "{\"prNumber\":1,\"headRef\":\"a\",\"baseRef\":\"main\"}"
meta_case "unsafe branch name" "{\"prNumber\":1,\"headSha\":\"$good_sha\",\"headRef\":\"a b\$(id)\",\"baseRef\":\"main\"}"
meta_case "non-numeric PR number" "{\"prNumber\":\"1;id\",\"headSha\":\"$good_sha\",\"headRef\":\"a\",\"baseRef\":\"main\"}"

# A well-formed artifact whose headSha differs from the triggering CI run's head commit.
ws=$(new_workspace)
: >"$ws/out"
if run_step "$pr_script" "$ws" "$ws/out" EXPECTED_HEAD_SHA=fedcba9876543210fedcba9876543210fedcba98; then
  fail "artifact headSha differing from the CI run's head commit accepted"
else
  pass "artifact headSha differing from the CI run's head commit refused"
fi

# Case-insensitive match against the CI run's head commit is accepted.
ws=$(new_workspace)
: >"$ws/out"
if run_step "$pr_script" "$ws" "$ws/out" EXPECTED_HEAD_SHA="${good_sha^^}"; then
  pass "headSha matching the CI run's head commit (case-insensitive) accepted"
else
  fail "matching headSha refused: $(cat "$ws/step.log")"
fi

ws=$(new_workspace)
rm -f "$ws/sonar-payload/sonar-pr-meta.json"
if run_step "$pr_script" "$ws" "$ws/out"; then
  fail "missing metadata file accepted"
else
  pass "missing metadata file refused (no PR params -> no scan)"
fi

# ── Trusted file problems must refuse to scan ────────────────────────────────
trusted_case() {
  local label=$1 content=$2 ws
  ws=$(new_workspace)
  printf '%b' "$content" >"$ws/sonar-trusted/sonar-project.properties"
  : >"$ws/out"
  if run_step "$args_script" "$ws" "$ws/out" PR_NUMBER=1 PR_HEAD_REF=a PR_BASE_REF=main PR_HEAD_SHA="$good_sha"; then
    fail "trusted file accepted but should be refused: $label"
  else
    pass "trusted file refused: $label"
  fi
  return 0
}

trusted_case "missing projectKey" "sonar.organization=o\n"
trusted_case "unsafe organization" "sonar.organization=o --evil\nsonar.projectKey=k\n"
trusted_case "empty file" ""

ws=$(new_workspace)
rm -rf "$ws/sonar-trusted"
if run_step "$args_script" "$ws" "$ws/out" PR_NUMBER=1 PR_HEAD_REF=a PR_BASE_REF=main PR_HEAD_SHA="$good_sha"; then
  fail "missing trusted file accepted"
else
  pass "missing trusted file refused"
fi

if [[ "$failures" -ne 0 ]]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "All Sonar trusted-properties checks passed."
