import { getBuildInfo } from '@/lib/build-info';

/** Port of the kernel BuildInfo presentation, linking directly to this app's source. */
export function BuildInfo({ appName }: Readonly<{ appName: string }>) {
  const { version, sha, repo } = getBuildInfo();
  const source = repo ? `https://github.com/${repo}` : '';
  const commit = source && /^[a-f0-9]{7,40}$/i.test(sha);
  const release = source && version !== 'dev';
  const hash = sha.slice(0, 7);
  const linkStyle = 'underline underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2';
  return (
    <footer className="border-t border-field-border px-4 py-3 text-xs text-foreground/70">
      {appName}{' '}
      {release ? (
        <a className={linkStyle} href={`${source}/releases/tag/v${encodeURIComponent(version)}`} aria-label={`Release v${version}`}>
          v{version}
        </a>
      ) : <span>v{version}</span>}
      {' · build '}
      {commit ? (
        <a className={linkStyle} href={`${source}/commit/${sha}`} aria-label={`Source commit ${sha}`}>
          {hash}
        </a>
      ) : <span>{hash}</span>}
    </footer>
  );
}
