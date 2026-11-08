/** Returns the normalized URL when it is `https:` (and, if given, on one of `hosts`); otherwise null. */
export function safeHttpsUrl(value: string, hosts?: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (hosts && !hosts.includes(u.hostname)) return null;
  return u.toString();
}

/** Keeps only valid `https:` image URLs, preserving order. */
export function filterHttpsUrls(urls: readonly string[]): string[] {
  return urls.flatMap((u) => {
    const safe = safeHttpsUrl(u);
    return safe ? [safe] : [];
  });
}
