import { describe, expect, it } from "vitest";
import { oauthCallbackUrl, validatePastedCallback } from "./callback-url.js";

describe("MCP OAuth loopback callback", () => {
  const expected = "http://localhost:38886/api/v1/plugins/agent-plugins/http/oauth/callback?pluginId=pa-fastmail-spike&serverId=fastmail";

  it("uses localhost even when BB has a remote public URL", () => {
    expect(oauthCallbackUrl("http://127.0.0.1:38886", "agent-plugins", "pa-fastmail-spike", "fastmail").toString()).toBe(expected);
  });

  it("preserves an already-localhost loopback address", () => {
    expect(oauthCallbackUrl("http://localhost:38886", "agent-plugins", "pa-fastmail-spike", "fastmail").toString()).toBe(expected);
  });

  it("only accepts loopback as the callback base", () => {
    expect(() => oauthCallbackUrl("http://remote.example:38886", "agent-plugins", "pa-fastmail-spike", "fastmail")).toThrow();
  });

  it("accepts the complete pasted callback URL after browser sign-in", () => {
    const params = validatePastedCallback(`${expected}&code=one-time-code&state=nonce`, new URL(expected));
    expect(params.get("code")).toBe("one-time-code");
    expect(params.get("state")).toBe("nonce");
  });

  it.each([
    "https://attacker.example/oauth/callback?code=secret&state=nonce",
    "http://localhost:38886/other?code=secret&state=nonce",
    "http://localhost:38886/api/v1/plugins/agent-plugins/http/oauth/callback?pluginId=other&serverId=fastmail&code=secret&state=nonce",
    "http://localhost:38886/api/v1/plugins/agent-plugins/http/oauth/callback?pluginId=pa-fastmail-spike&serverId=other&code=secret&state=nonce",
  ])("rejects a callback from a different URL or server without returning it (%s)", (pasted) => {
    expect(() => validatePastedCallback(pasted, new URL(expected))).toThrow("Callback URL does not match this MCP connection");
  });
});
