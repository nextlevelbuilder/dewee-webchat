import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeweeHandler, signVisitorToken, verifyVisitorToken } from "../src/server";
import { subjectDigest } from "../src/server/security";
import { deweeIdentitySdk } from "../src/server/identity";
import { mintJobAccess } from "../src/server/job-access";
import { parseJobAccessLaunch } from "../src/job-access";
import { APP_ID, ASSERTION_SECRET, INTEGRATION_ID, INTEGRATION_SECRET, ISSUER, startFakeCcp } from "./helpers/fake-ccp-ingress";

const SECRET = "visitor-secret-test-only-0000000000000000";
const SESSION = "idsess_test_private_identity_session";
const BASE = "https://shop.example/api/dewee";
const ticket = () => ({ bootstrap_url: "https://access.example/identity/job-access/launch", launch_token: "one_time_ticket_0123456789", expires_at: new Date(Date.now() + 45_000).toISOString() });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const authenticate = async (req: Request) => req.headers.get("cookie") ? { subject: req.headers.get("cookie")! } : null;
function handler() {
  return createDeweeHandler({ gatewayUrl: "https://gateway.example", token: "operator-secret", secret: SECRET, agents: ["support"], rateLimit: false,
    identity: { sdk: deweeIdentitySdk, authenticate, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET, agent: "support", rebindEachRequest: false } });
}
async function signed(agent = "support") {
  return signVisitorToken(SECRET, { v: "visitor_0123456789012345", exp: Date.now() + 60_000, ids: SESSION, ida: agent, sub: await subjectDigest(SECRET, "user-a") });
}
const request = (token: string, cookie = "user-a", body: unknown = {}, origin = "https://shop.example", method = "POST") => new Request(`${BASE}/job-access`, {
  method, headers: { authorization: `Bearer ${token}`, cookie, origin }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
});
afterEach(() => vi.restoreAllMocks());

describe("job access server boundary", () => {
  it("uses the sealed session and only the origin in the direct mint, stripping upstream extras", async () => {
    const launch = { ...ticket(), bootstrap_url: "https://gateway.example/identity/job-access/launch" };
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ ...launch, identity_session: SESSION, private: "secret" }));
    const response = await handler()(request(await signed()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(launch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://gateway.example/v1/identity/job-access/launch");
    expect(init).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify({ launch_origin: "https://shop.example" }) });
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ "content-type": "application/json", "x-dewee-identity-session": SESSION });
  });

  it("refuses an upstream bootstrap on another origin without leaking its ticket", async () => {
    const launch = { ...ticket(), bootstrap_url: "https://attacker.example/identity/job-access/launch" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(launch));
    const response = await handler()(request(await signed()));
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body).error.code).toBe("job_access_unavailable");
    for (const privateValue of [launch.bootstrap_url, launch.launch_token, SESSION]) expect(body).not.toContain(privateValue);
  });
  it("forces current login checks even when chat rebinding is disabled", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const h = handler(); const token = await signed();
    for (const cookie of ["", "user-b"]) {
      const response = await h(request(token, cookie));
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("IDENTITY_REQUIRED");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects untrusted tokens, noncanonical origins, caller overrides and disallowed agents before mint", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const h = handler(); const token = await signed();
    expect((await h(request(`${token}tampered`))).status).toBe(401);
    const anonymous = await signVisitorToken(SECRET, { v: "visitor_0123456789012345", exp: Date.now() + 60_000 });
    expect((await h(request(anonymous))).status).toBe(401);
    for (const origin of ["", "http://shop.example", "https://shop.example/", "https://shop.example/path", "https://shop.example:443"]) expect((await h(request(token, "user-a", {}, origin))).status).toBe(403);
    for (const body of [{ agent: "other" }, { identity_session: "other" }, { launch_origin: "https://evil.example" }, []]) expect((await h(request(token, "user-a", body))).status).toBe(400);
    expect((await h(request(await signed("other")))).status).toBe(403);
    expect((await h(request(token, "user-a", {}, "https://shop.example", "GET"))).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("scrubs unexpected upstream errors and refuses a raw session disguised as a ticket", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: { message: SESSION } }, 500));
    const h = handler(); const token = await signed();
    const response = await h(request(token));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(SESSION);
    fetcher.mockResolvedValue(json({ ...ticket(), bootstrap_url: "https://gateway.example/identity/job-access/launch", launch_token: SESSION }));
    await expect(mintJobAccess("https://gateway.example", SESSION, "https://shop.example")).rejects.toThrow("unavailable");
  });

  it("uses the established CCP edge with the bound agent and server-only identity session", async () => {
    const ccp = await startFakeCcp();
    try {
      ccp.state.config = { ...ccp.state.config, mode: "signed_in_optional", identity_enabled: true };
      const h = createDeweeHandler({ ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET }, secret: SECRET, rateLimit: false,
        identity: { sdk: deweeIdentitySdk, authenticate, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET, rebindEachRequest: false } });
      const issued = await h(new Request(`${BASE}/session`, { method: "POST", headers: { cookie: "user-a", origin: "https://shop.example" }, body: "{}" }));
      const { token } = await issued.json();
      const claims = await verifyVisitorToken(SECRET, token);
      const original = globalThis.fetch;
      const calls: { url: string; init?: RequestInit }[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).endsWith("/job-access")) { calls.push({ url: String(url), init }); return json(ticket()); }
        return original(url, init);
      });
      const response = await h(request(token));
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ identity_session: claims?.ids, agent: "shop" });
      expect(new Headers(calls[0].init?.headers).get("x-dewee-webchat-session")).toBe(claims?.es);
      const browser = await response.text();
      for (const secret of [claims!.ids!, claims!.es!, INTEGRATION_SECRET]) expect(browser).not.toContain(secret);
    } finally { await ccp.close(); }
  });
});

describe("job access ticket validation", () => {
  it.each(["http://access.example/identity/job-access/launch", "https://access.example/other", "https://access.example/identity/job-access/launch?token=secret", "https://user:pass@access.example/identity/job-access/launch", "https://access.example/identity/job-access/launch#secret"])("refuses unsafe destination %s", (bootstrap_url) => {
    expect(() => parseJobAccessLaunch({ ...ticket(), bootstrap_url })).toThrow("unavailable");
  });
  it("rejects expired and overlong lifetime tickets", () => {
    for (const delta of [-1, 61_000]) expect(() => parseJobAccessLaunch({ ...ticket(), expires_at: new Date(Date.now() + delta).toISOString() })).toThrow("unavailable");
  });
});

