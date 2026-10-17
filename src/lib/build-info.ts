/** Immutable public metadata injected by next.config.js, never runtime git. */
export function getBuildInfo() {
  return {
    version: process.env.NEXT_PUBLIC_VERSION || 'dev',
    sha: process.env.NEXT_PUBLIC_BUILD_HASH || 'local',
    repo: process.env.NEXT_PUBLIC_SOURCE_REPO || '',
    builtAt: process.env.NEXT_PUBLIC_BUILD_TIME || '',
  };
}
