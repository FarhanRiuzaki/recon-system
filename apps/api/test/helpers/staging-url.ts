// The staging database's URL of the tests, apart from staging.ts so the preload reads it before anything loads the config.

/** `<test database>_staging`'s URL. */
export function stagingUrl(testUrl: string): string {
  const u = new URL(testUrl);
  u.pathname = `${u.pathname}_staging`;
  return u.href;
}
