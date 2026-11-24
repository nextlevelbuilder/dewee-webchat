// The control plane's install check over transport "ccp": the widget's `check` nonce is validated,
// forwarded to the ingress on `session` (CCP is asked even when a fresh edge session is at hand) and on
// `chat`, and `check: true` comes back only when the ingress accepted it. Requests without `check`
// reach the ingress byte for byte as before.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeweeHandler, verifyVisitorToken, type DeweeHandlerOptions } from "../src/server";
import { deweeIdentitySdk } from "../src/server/identity";
import { APP_ID, ASSERTION_SECRET, INTEGRATION_ID, INTEGRATION_SECRET, ISSUER, startFakeCcp, type FakeCcp } from "./helpers/fake-ccp-ingress";

const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";
const BASE = "https://shop.example/api/dewee";
// Built by concatenation: fixtures shaped like tokens are never literal.
const NONCE = "chk_" + "A1b2C3d4".repeat(3);
const OTHER_NONCE = "chk_" + "Z9y8X7w6".repeat(3);
let ccp: FakeCcp;

beforeAll(async () => {
  ccp = await startFakeCcp();
});
afterAll(() => ccp.close());
beforeEach(() => ccp.reset());

function makeHandler(extra: Partial<DeweeHandlerOptions> = {}) {
  const h = createDeweeHandler({ ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET }, secret: VISITOR_SECRET, rateLimit: false, ...extra });
  return async (req: Request) => {
    const res = await h(req);
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) };
  };
}
type H = ReturnType<typeof makeHandler>;

const session = (h: H, body: unknown = {}, headers: Record<string, string> = {}) => h(new Request(`${BASE}/session`, { method: "POST", headers, body: JSON.stringify(body) }));
const chat = (h: H, token: string, body: Record<string, unknown> = {}) =>
  h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ message: "hi", conversationId: "conv_ccp_0001", agent: "shop", ...body }) }));

describe("ccp install check: /session", () => {
  it("forwards the nonce to the ingress and answers check: true only when the ingress accepted it", async () => {
    const h = makeHandler();
    ccp.state.checkNonce = NONCE;
    const accepted = (await session(h, { check: NONCE })).json();
    expect(accepted.check).toBe(true);
    expect(ccp.routes("session")[0].body).toEqual({ visitor_id: accepted.visitorId, check: NONCE });

    // A nonce the control plane does not know is forwarded all the same, but nothing is confirmed.
    const ignored = (await session(h, { check: OTHER_NONCE })).json();
    expect(ignored.check).toBeUndefined();
    expect(ccp.routes("session")[1].body).toEqual({ visitor_id: ignored.visitorId, check: OTHER_NONCE });

    // An ingress that knows no nonce at all never confirms one.
    ccp.state.checkNonce = undefined;
    expect((await session(h, { check: NONCE })).json().check).toBeUndefined();
  });

  it("asks the ingress even when the visitor's edge session is still fresh, and keeps the visitor", async () => {
    const h = makeHandler();
    const first = (await session(h)).json();
    expect(ccp.routes("session")).toHaveLength(1);
    // A plain refresh reuses the fresh edge session: nothing reaches the ingress.
    await session(h, { token: first.token });
    expect(ccp.routes("session")).toHaveLength(1);

    ccp.state.checkNonce = NONCE;
    const checked = (await session(h, { token: first.token, check: NONCE })).json();
    expect(checked).toMatchObject({ visitorId: first.visitorId, check: true });
    const refresh = ccp.routes("session")[1];
    expect(refresh.body).toEqual({ check: NONCE });
    expect(typeof refresh.headers["x-dewee-webchat-session"]).toBe("string");
    // The answer flag is never sealed in the token.
    const claims = await verifyVisitorToken(VISITOR_SECRET, checked.token);
    expect(JSON.stringify(claims)).not.toContain("check");
  });

  it("refuses a malformed nonce with 400 before calling the ingress", async () => {
    const h = makeHandler();
    const bad: unknown[] = [null, 42, "", "short_" + "x", "A".repeat(65), NONCE + "\n", NONCE.slice(0, 21), "chk." + "A".repeat(22), ["x"], { v: NONCE }];
    for (const check of bad) {
      const r = await session(h, { check });
      expect([JSON.stringify(check), r.status, r.json().error.code]).toEqual([JSON.stringify(check), 400, "bad_request"]);
    }
    expect(ccp.seen).toHaveLength(0);
    // The bounds of the pattern are accepted.
    expect((await session(h, { check: "a".repeat(22) })).status).toBe(200);
    expect((await session(h, { check: "Z-_9".repeat(16) })).status).toBe(200);
  });

  it("without check: the ingress receives exactly the bytes it did before", async () => {
    const h = makeHandler();
    const first = (await session(h)).json();
    expect(ccp.routes("session")[0].raw).toBe(`{"visitor_id":"${first.visitorId}"}`);
    // An edge session closer to its end than /session hands out is refreshed, with an empty body.
    ccp.state.edgeTtlSeconds = 60;
    const short = (await session(h)).json();
    await session(h, { token: short.token });
    const refresh = ccp.routes("session").at(-1)!;
    expect(typeof refresh.headers["x-dewee-webchat-session"]).toBe("string");
    expect(refresh.raw).toBe("{}");
    expect((await session(h)).json().check).toBeUndefined();
  });
});

describe("ccp install check: /chat", () => {
  it("forwards check as the last body field, and nothing else changes", async () => {
    const h = makeHandler();
    const s = (await session(h)).json();
    expect((await chat(h, s.token, { check: NONCE })).status).toBe(200);
    expect(ccp.routes("chat")[0].raw).toBe(`{"message":"hi","conversation_id":"conv_ccp_0001","agent":"shop","check":"${NONCE}"}`);
    expect((await chat(h, s.token)).status).toBe(200);
    expect(ccp.routes("chat")[1].raw).toBe(`{"message":"hi","conversation_id":"conv_ccp_0001","agent":"shop"}`);
  });

  it("refuses a malformed nonce with 400 before calling the ingress", async () => {
    const h = makeHandler();
    const s = (await session(h)).json();
    for (const check of [null, 1, "x", NONCE + "!"]) {
      const r = await chat(h, s.token, { check });
      expect([r.status, r.json().error.code]).toEqual([400, "bad_request"]);
    }
    expect(ccp.routes("chat")).toHaveLength(0);
  });

  it("never hands the nonce to onChat with the visitor's text", async () => {
    const seen: unknown[] = [];
    const h = makeHandler({ onChat: (e) => seen.push(e) });
    const s = (await session(h)).json();
    await chat(h, s.token, { check: NONCE });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain(NONCE);
  });
});

describe("ccp install check: signed-in backends", () => {
  const cookieUser = async (req: Request) => {
    const uid = /(?:^|;\s*)uid=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
    return uid ? { subject: uid } : null;
  };
  const identity = () => makeHandler({ identity: { sdk: deweeIdentitySdk, authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET } });
  beforeEach(() => {
    ccp.state.config = { ...ccp.state.config, mode: "signed_in_optional", identity_enabled: true };
  });

  it("confirms the nonce for a signed-in user", async () => {
    const h = identity();
    ccp.state.checkNonce = NONCE;
    const s = (await session(h, { check: NONCE }, { cookie: "uid=lan" })).json();
    expect(s).toMatchObject({ verified: true, check: true });
    expect(ccp.routes("session").some((r) => r.body?.check === NONCE)).toBe(true);
  });

  it("does not hand back a still-valid anonymous token as is when it carries a nonce", async () => {
    const h = identity();
    const first = (await session(h)).json();
    const before = ccp.routes("session").length;
    // Without a nonce the token comes back as is, without asking the ingress.
    expect((await session(h, { token: first.token })).json().token).toBe(first.token);
    expect(ccp.routes("session")).toHaveLength(before);
    ccp.state.checkNonce = NONCE;
    const checked = (await session(h, { token: first.token, check: NONCE })).json();
    expect(checked).toMatchObject({ visitorId: first.visitorId, check: true });
    expect(ccp.routes("session").at(-1)!.body).toEqual({ check: NONCE });
  });

  it("refuses a malformed nonce with 400", async () => {
    const r = await session(identity(), { check: "nope" }, { cookie: "uid=lan" });
    expect([r.status, r.json().error.code]).toEqual([400, "bad_request"]);
  });
});

describe("legacy gateway transport", () => {
  it("validates the nonce but never forwards or confirms it", async () => {
    vi.spyOn(console, "warn").mockImplementationOnce(() => {}); // the deprecation notice
    const h = createDeweeHandler({ gatewayUrl: "https://gw.example.com", token: "gw-" + "token", secret: VISITOR_SECRET, rateLimit: false, agents: ["shop"] });
    const ok = await h(new Request(`${BASE}/session`, { method: "POST", body: JSON.stringify({ check: NONCE }) }));
    const body = await ok.json();
    expect(ok.status).toBe(200);
    expect(body.check).toBeUndefined();
    const bad = await h(new Request(`${BASE}/session`, { method: "POST", body: JSON.stringify({ check: "x" }) }));
    expect(bad.status).toBe(400);
  });
});
