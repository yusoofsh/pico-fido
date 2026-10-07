/**
 * Pure validation primitives for configured local paths and URLs.
 *
 * The rules are documented in host/README.md ("Config schema"); they are
 * intentionally stricter than what `open` would accept. Validators return
 * either null (acceptable) or a short, single-line rule description that
 * never echoes the offending value: paths can contain control characters
 * and URLs can contain credentials.
 */

export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Validate one configured local path. */
export function checkPath(p: string): string | null {
  if (p.length === 0) return 'path must not be empty';
  if (CONTROL_CHARS.test(p)) return 'path must not contain control characters (NUL, newline, escape, ...)';
  if (!p.startsWith('/')) return 'path must be absolute (start with "/"); relative paths and unexpanded "~" are not allowed';
  for (const seg of p.slice(1).split('/')) {
    if (seg === '..') return 'path must not contain ".." segments (traversal is never allowed)';
    if (seg === '.') return 'path must be normalized (no "." segments)';
    if (seg === '') return 'path must be normalized (no empty segments: no "//" and no trailing "/")';
  }
  return null;
}

/** Hosts for which plain http: is accepted. Everything else requires https:. */
export const LOCAL_HTTP_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Validate one configured URL. */
export function checkUrl(u: string): string | null {
  if (u.length === 0) return 'URL must not be empty';
  if (/\s/.test(u) || CONTROL_CHARS.test(u)) return 'URL must not contain whitespace or control characters';
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return 'URL is not parseable (use https://... or http://localhost/...)';
  }
  if (url.username !== '' || url.password !== '') return 'URLs with embedded credentials are not allowed';
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'URL scheme must be https: (http: is allowed only for localhost; javascript:, file:, data: and every other scheme is rejected)';
  }
  if (url.protocol === 'http:' && !LOCAL_HTTP_HOSTS.has(url.hostname)) {
    return 'http: is allowed only for localhost (localhost, 127.0.0.1, [::1]); use https: for every other host';
  }
  return null;
}
