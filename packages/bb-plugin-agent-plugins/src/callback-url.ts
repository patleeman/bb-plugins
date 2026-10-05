// Fastmail's dynamic registration accepts localhost but not an arbitrary
// HTTPS callback. A remote BB user can paste the failed browser redirect into
// BB; the OAuth state/PKCE grant still authorizes the code exchange.
export function oauthCallbackUrl(loopbackBaseUrl: string, bridgeId: string, pluginId: string, serverId: string): URL {
  const base = new URL(loopbackBaseUrl);
  if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || base.username || base.password) {
    throw new Error("MCP OAuth requires a local BB loopback URL");
  }
  base.hostname = "localhost";
  const redirect = new URL(`/api/v1/plugins/${encodeURIComponent(bridgeId)}/http/oauth/callback`, base);
  redirect.search = new URLSearchParams({ pluginId, serverId }).toString();
  return redirect;
}

export function validatePastedCallback(pasted: string, expected: URL): URLSearchParams {
  // Never include the supplied URL in an error: it carries a one-use code.
  if (pasted.length > 8192) throw new Error("Callback URL is too long");
  let actual: URL;
  try { actual = new URL(pasted); }
  catch { throw new Error("Paste the full callback URL from your browser's address bar"); }
  const expectedQuery = expected.searchParams;
  const actualQuery = actual.searchParams;
  if (actual.protocol !== expected.protocol ||
      ![expected.hostname, "127.0.0.1", "[::1]"].includes(actual.hostname) ||
      actual.port !== expected.port || actual.pathname !== expected.pathname ||
      actual.username || actual.password || actual.hash ||
      [...expectedQuery.keys()].some((key) => actualQuery.getAll(key).length !== 1 || actualQuery.get(key) !== expectedQuery.get(key))) {
    throw new Error("Callback URL does not match this MCP connection");
  }
  return actualQuery;
}
