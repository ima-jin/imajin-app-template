#!/usr/bin/env bash
# Proof for ima-jin/imajin-app-template#15.
#
# A `workflow_run` workflow always runs from the default branch, so the
# privileged `sonarcloud-pr` job cannot run on the PR that changes it. This
# script instead extracts that job's OWN `run:` blocks from
# .github/workflows/sonarcloud.yml (steps `pr` and `scan_args`) and executes
# them, exactly as the runner would (bash --noprofile --norc -eo pipefail),
# against a hostile payload fixture. It asserts the effective scanner args
# still point at sonarcloud.io under the trusted organization/projectKey, and
# that malformed metadata is refused.
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

# Executes a job step script the way the runner does. Args: <script> <dir> <output-file>.
run_step() {
  local script=$1 dir=$2 out=$3
  shift 3
  (cd "$dir" && env GITHUB_OUTPUT="$out" "$@" bash --noprofile --norc -eo pipefail -c "$script") >"$dir/step.log" 2>&1
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
args_script=$(step_run scan_args)
if [[ -z "$pr_script" || -z "$args_script" ]]; then
  echo "FAIL: could not extract steps 'pr' and 'scan_args' from $workflow" >&2
  exit 1
fi

# ── Static guards on the privileged job ──────────────────────────────────────
if yq '.jobs.sonarcloud-pr.steps[].run // ""' "$workflow" | grep -qF '${{'; then
  fail "a sonarcloud-pr run: block interpolates \${{ }} (untrusted input must go through env:)"
else
  pass "no \${{ }} interpolation inside sonarcloud-pr run: blocks"
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

good_sha=0123456789abcdef0123456789abcdef01234567
meta_case "SHA too short" "{\"prNumber\":1,\"headSha\":\"abc123\",\"headRef\":\"a\",\"baseRef\":\"main\"}"
meta_case "SHA 41 chars" "{\"prNumber\":1,\"headSha\":\"${good_sha}0\",\"headRef\":\"a\",\"baseRef\":\"main\"}"
meta_case "SHA non-hex" "{\"prNumber\":1,\"headSha\":\"${good_sha:0:39}z\",\"headRef\":\"a\",\"baseRef\":\"main\"}"
meta_case "SHA with injection" "{\"prNumber\":1,\"headSha\":\"${good_sha:0:30}; curl evil\",\"headRef\":\"a\",\"baseRef\":\"main\"}"
meta_case "SHA missing" "{\"prNumber\":1,\"headRef\":\"a\",\"baseRef\":\"main\"}"
meta_case "unsafe branch name" "{\"prNumber\":1,\"headSha\":\"$good_sha\",\"headRef\":\"a b\$(id)\",\"baseRef\":\"main\"}"
meta_case "non-numeric PR number" "{\"prNumber\":\"1;id\",\"headSha\":\"$good_sha\",\"headRef\":\"a\",\"baseRef\":\"main\"}"

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
