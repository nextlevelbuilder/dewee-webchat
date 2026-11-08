// transport "ccp" on a host that keeps no memory between requests (serverless, PHP-FPM style): every
// request gets a fresh handler, so only what the visitor token carries survives. A returning visitor
// must cost at most one CCP session refresh or create per page session, and a signed-in user's page
// loads must reuse the identity session instead of exchanging every time, without ever handing one
// user's session to another or answering a refused signed-in user anonymously.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "../src/protocol";
import { createDeweeHandler, verifyVisitorToken, type DeweeHandlerOptions, type DeweeIdentityOptions, type RateLimiter } from "../src/server";
import { EDGE_RESEAL_MS } from "../src/server/ccp-transport";
import { deweeIdentitySdk } from "../src/server/identity";
import { signReuseHint, signVisitorToken } from "../src/server/security";
import { APP_ID, ASSERTION_SECRET, INTEGRATION_ID, INTEGRATION_SECRET, ISSUER, mintEdge, startFakeCcp, type FakeCcp } from "./helpers/fake-ccp-ingress";
import { forgeToken } from "./helpers/forge-token";

const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";
const BASE = "https://shop.example/api/dewee";
const DAY = 24 * 3600_000;
let ccp: FakeCcp;

beforeAll(async () => {
  ccp = await startFakeCcp();
});
afterAll(() => ccp.close());
beforeEach(() => ccp.reset());

const cookieUser = async (req: Request) => {
  const uid = /(?:^|;\s*)uid=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  return uid ? { subject: uid } : null;
};

/** A new handler for every request: nothing is remembered between calls, as on a stateless host. */
function stateless(extra: Partial<DeweeHandlerOptions> = {}, identity?: Partial<DeweeIdentityOptions>) {
  const opts: DeweeHandlerOptions = {
    ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET },
    secret: VISITOR_SECRET,
    rateLimit: false,
    ...(identity ? { identity: { sdk: deweeIdentitySdk, authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET, ...identity } } : {}),
    ...extra,
  };
  return async (req: Request) => {
    const res = await createDeweeHandler(opts)(req);
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) };
  };
}
type H = ReturnType<typeof stateless>;

const session = (h: H, body: Record<string, unknown> = {}, uid?: string) =>
  h(new Request(`${BASE}/session`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.7", ...(uid ? { cookie: `uid=${uid}` } : {}) }, body: JSON.stringify(body) }));
const chat = (h: H, token: string, uid?: string) =>
  h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...(uid ? { cookie: `uid=${uid}` } : {}) }, body: JSON.stringify({ message: "hi", conversationId: "conv_stateless_1" }) }));
const sse = (text: string): ChatStreamEvent[] => text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
const claims = (token: string) => verifyVisitorToken(VISITOR_SECRET, token);

/** An anonymous token issued `ageMs` ago (30-day lifetime) whose sealed edge session lapsed `edgeAgeMs` ago. */
async function agedToken(v: string, ageMs: number, edgeAgeMs: number): Promise<{ token: string; edge: string }> {
  const edge = mintEdge(v, -Math.round(edgeAgeMs / 1000));
  const token = await signVisitorToken(VISITOR_SECRET, { v, exp: Date.now() + 30 * DAY - ageMs, es: edge, ese: Date.now() - edgeAgeMs });
  return { token, edge };
}

describe("stateless host: returning anonymous visitor", () => {
  it("refreshes a lapsed edge session once at /session, keeps the visitor, and then needs no session calls", async () => {
    const h = stateless();
    const v = "visitor_aged_0001";
    const { token, edge } = await agedToken(v, 2 * DAY, 2 * 3600_000);
    const r = await session(h, { token });
    expect(r.status).toBe(200);
    const s = r.json();
    expect(s.visitorId).toBe(v);
    const calls = ccp.routes("session");
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["x-dewee-webchat-session"]).toBe(edge);
    // The widget is told to come back before the new edge session lapses, not in 30 days.
    const sealed = await claims(s.token);
    expect(sealed?.es).not.toBe(edge);
    expect(s.expiresAt).toBeLessThanOrEqual(sealed!.ese!);
    expect(s.expiresIn).toBeGreaterThan(0);
    expect(s.expiresIn).toBeLessThanOrEqual(3600_000);
    expect(sealed!.exp - Date.now()).toBeGreaterThan(29 * DAY);

    for (let i = 0; i < 5; i++) expect(sse((await chat(h, s.token)).text).at(-1)?.type).toBe("done");
    expect(ccp.routes("session")).toHaveLength(1);
    for (const c of ccp.routes("chat")) expect(c.headers["x-dewee-webchat-session"]).toBe(sealed!.es);
  });

  it("opens one new edge session for the same visitor when the old one is past CCP's refresh window", async () => {
    const h = stateless();
    const v = "visitor_aged_0002";
    const { token } = await agedToken(v, 5 * DAY, 25 * 3600_000);
    const s = (await session(h, { token })).json();
    expect(s.visitorId).toBe(v);
    expect(ccp.routes("session")).toHaveLength(1);
    expect(ccp.routes("session")[0].body).toEqual({ visitor_id: v });
    expect(ccp.routes("session")[0].headers["x-dewee-webchat-session"]).toBeUndefined();
    await chat(h, s.token);
    await chat(h, s.token);
    expect(ccp.routes("session")).toHaveLength(1);
  });

  it("re-seals an edge session that is about to lapse, and leaves a fresh one alone", async () => {
    const h = stateless();
    const v = "visitor_aged_0003";
    const soon = mintEdge(v, 60);
    const nearly = await signVisitorToken(VISITOR_SECRET, { v, exp: Date.now() + 20 * DAY, es: soon, ese: Date.now() + 60_000 });
    const s = (await session(h, { token: nearly })).json();
    expect(ccp.routes("session")).toHaveLength(1);
    expect(ccp.routes("session")[0].headers["x-dewee-webchat-session"]).toBe(soon);
    expect((await claims(s.token))!.ese! - Date.now()).toBeGreaterThan(EDGE_RESEAL_MS);

    ccp.reset();
    const again = (await session(h, { token: s.token })).json();
    expect(again.visitorId).toBe(v);
    // Fresh enough: the sealed edge session is kept and CCP is not asked again.
    expect(again.token).not.toBe("");
    expect((await claims(again.token))?.es).toBe((await claims(s.token))?.es);
    expect(ccp.routes("session")).toHaveLength(0);
  });

  it("limits a returning visitor's /session per visitor, a new visitor per IP", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = (key, bucket) => {
      if (bucket === "session") keys.push(key);
      return true;
    };
    const h = stateless({ rateLimit: limiter });
    const { token } = await agedToken("visitor_aged_0004", DAY, 2 * 3600_000);
    await session(h, { token });
    await session(h);
    expect(keys).toEqual(["visitor:visitor_aged_0004", "203.0.113.7"]);
  });

  it("keeps the 10-per-10-minutes budget of one address for new visitors when many returning visitors share it", async () => {
    // One handler with the default in-memory limiter (a stateless host would use a shared store).
    const shared = createDeweeHandler({ ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET }, secret: VISITOR_SECRET });
    const post = (body: unknown) => shared(new Request(`${BASE}/session`, { method: "POST", headers: { "x-forwarded-for": "198.51.100.9" }, body: JSON.stringify(body) }));
    for (let i = 0; i < 12; i++) {
      const { token } = await agedToken(`visitor_office_${String(i).padStart(4, "0")}`, DAY, 2 * 3600_000);
      expect((await post({ token })).status).toBe(200);
    }
    expect((await post({})).status).toBe(200);
  });

  it("in a signed-in backend, re-seals a returning anonymous visitor's lapsed edge session instead of handing it back", async () => {
    ccp.state.config = { ...ccp.state.config, mode: "signed_in_optional", identity_enabled: true };
    const h = stateless({}, {});
    const v = "visitor_aged_0005";
    const { token, edge } = await agedToken(v, DAY, 2 * 3600_000);
    const s = (await session(h, { token })).json();
    expect(s.verified).toBeUndefined();
    expect(s.visitorId).toBe(v);
    expect(s.token).not.toBe(token);
    expect(ccp.routes("session")).toHaveLength(1);
    expect(ccp.routes("session")[0].headers["x-dewee-webchat-session"]).toBe(edge);
    // A token whose edge session is fresh comes back as is, with no CCP call.
    ccp.reset();
    ccp.state.config = { ...ccp.state.config, mode: "signed_in_optional", identity_enabled: true };
    const same = (await session(h, { token: s.token })).json();
    expect(same.token).toBe(s.token);
    expect(same.expiresAt).toBeLessThanOrEqual((await claims(s.token))!.ese!);
    expect(ccp.routes("session")).toHaveLength(0);
  });
});

describe("ccp /session edges", () => {
  const turnstile = { siteKey: "site-key", secretKey: "turnstile-secret-NEVER-IN-BROWSER" };

  it("challenges new visitors with Turnstile but lets a returning visitor refresh without one", async () => {
    const h = stateless({ turnstile });
    const cfg = (await h(new Request(`${BASE}/config`))).json();
    expect(cfg).toMatchObject({ turnstileSiteKey: "site-key", refreshWithoutTurnstile: true });
    const fresh = await session(h);
    expect([fresh.status, fresh.json().error.code]).toEqual([403, "turnstile_failed"]);
    const { token } = await agedToken("visitor_turnstile_1", DAY, 2 * 3600_000);
    const r = await session(h, { token });
    expect(r.status).toBe(200);
    expect(r.json().visitorId).toBe("visitor_turnstile_1");
    // An expired or forged token is no proof.
    expect((await session(h, { token: forgeToken(token) })).status).toBe(403);
  });

  it("keeps the legacy gateway transport challenging every /session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = createDeweeHandler({ gatewayUrl: "https://gw.example.com", token: "gw-token", agents: ["shop"], secret: VISITOR_SECRET, rateLimit: false, turnstile });
      const cfg = await (await h(new Request(`${BASE}/config`))).json();
      expect(cfg.refreshWithoutTurnstile).toBeUndefined();
      const token = await signVisitorToken(VISITOR_SECRET, { v: "visitor_turnstile_2", exp: Date.now() + DAY });
      const r = await h(new Request(`${BASE}/session`, { method: "POST", body: JSON.stringify({ token }) }));
      expect(r.status).toBe(403);
    } finally {
      warn.mockRestore();
    }
  });

  it("sends CCP the visitor IP only in CCP's address format", async () => {
    const h = stateless();
    const post = (xff: string) => h(new Request(`${BASE}/session`, { method: "POST", headers: { "x-forwarded-for": xff }, body: "{}" }));
    await post("2001:db8::7");
    await post("evil<script>");
    expect(ccp.routes("session").map((r) => r.headers["x-dewee-visitor-ip"])).toEqual(["2001:db8::7", undefined]);
  });

  it("answers an unexpected failure without its detail", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = stateless({ rateLimit: () => { throw new Error("limiter store at redis://10.0.0.5 down"); } });
      const r = await session(h);
      expect(r.status).toBe(500);
      expect(r.json()).toEqual({ error: { message: "Internal error", code: "internal" } });
    } finally {
      err.mockRestore();
    }
  });
});

describe("stateless host: signed-in user", () => {
  beforeEach(() => {
    ccp.state.config = { ...ccp.state.config, mode: "signed_in_optional", identity_enabled: true };
  });

  it("reuses the identity and edge sessions of the tab's reuse hint across cold page loads", async () => {
    const h = stateless({}, {});
    const first = (await session(h, {}, "user-a")).json();
    expect(first.verified).toBe(true);
    expect(first.reuseHint).toEqual(expect.any(String));
    expect(first.reuseHint).not.toBe(first.token);
    let hint = first.reuseHint;
    let token = first.token;
    for (let i = 0; i < 12; i++) {
      const s = (await session(h, { reuseHint: hint }, "user-a")).json();
      expect(s.verified).toBe(true);
      expect(s.visitorId).toBe(first.visitorId);
      expect((await claims(s.token))?.ids).toBe((await claims(first.token))?.ids);
      // never stretched past the identity session's own end
      expect((await claims(s.token))!.exp).toBeLessThanOrEqual((await claims(first.token))!.exp);
      hint = s.reuseHint;
      token = s.token;
    }
    expect(ccp.routes("identity/exchange")).toHaveLength(1);
    expect(ccp.routes("session")).toHaveLength(1);
    expect(sse((await chat(h, token, "user-a")).text).at(-1)?.type).toBe("done");
  });

  it("refuses the reuse hint as a bearer on every route, and the bearer token as a reuse hint", async () => {
    const h = stateless({}, {});
    const a = (await session(h, {}, "user-a")).json();
    const bearer = (path: string, method = "GET", body?: unknown) =>
      h(new Request(`${BASE}/${path}`, { method, headers: { authorization: `Bearer ${a.reuseHint}`, cookie: "uid=user-a" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    expect((await bearer("chat", "POST", { message: "hi", conversationId: "conv_hint_00001" })).status).toBe(401);
    expect((await bearer("history?agent=shop&conversationId=conv_hint_00001")).status).toBe(401);
    expect((await bearer("link", "POST", {})).status).toBe(401);
    expect(ccp.routes("chat")).toHaveLength(0);
    expect(ccp.routes("history")).toHaveLength(0);
    expect(ccp.routes("link")).toHaveLength(0);
    // Nor is it ever an anonymous visitor's token to refresh.
    const anon = (await session(stateless(), { token: a.reuseHint })).json();
    expect(anon.visitorId).not.toBe(a.visitorId);
    // The bearer token offered as a hint is ignored: the user is exchanged again.
    expect((await session(h, { reuseHint: a.token }, "user-a")).json().verified).toBe(true);
    expect(ccp.routes("identity/exchange")).toHaveLength(2);
  });

  it("never reuses another user's session: a hint under a different login exchanges for that user", async () => {
    const h = stateless({}, {});
    const a = (await session(h, {}, "user-a")).json();
    const b = (await session(h, { reuseHint: a.reuseHint }, "user-b")).json();
    expect(b.verified).toBe(true);
    expect(b.visitorId).not.toBe(a.visitorId);
    expect((await claims(b.token))?.ids).not.toBe((await claims(a.token))?.ids);
    expect(ccp.routes("identity/exchange")).toHaveLength(2);
    // B's exchange did not run on A's edge session either.
    expect(ccp.routes("identity/exchange")[1].headers["x-dewee-webchat-session"]).not.toBe((await claims(a.token))?.es);
  });

  it("a hint with no one signed in gives a new anonymous visitor, and 401 when sign-in is required", async () => {
    const a = (await session(stateless({}, {}), {}, "user-a")).json();
    const anon = (await session(stateless({}, {}), { reuseHint: a.reuseHint })).json();
    expect(anon.verified).toBeUndefined();
    expect(anon.reuseHint).toBeUndefined();
    expect(anon.visitorId).not.toBe(a.visitorId);
    expect((await claims(anon.token))?.ids).toBeUndefined();

    const required = await session(stateless({}, { required: true }), { reuseHint: a.reuseHint, token: a.token });
    expect(required.status).toBe(401);
    expect(required.json().error.code).toBe("IDENTITY_REQUIRED");
  });

  it("ignores a hint that is tampered with, about to expire, or for another agent", async () => {
    const h = stateless({}, {});
    const a = (await session(h, {}, "user-a")).json();
    const c = (await claims(a.token))!;
    const tampered = forgeToken(a.reuseHint);
    const expiring = await signReuseHint(VISITOR_SECRET, { ...c, exp: Date.now() + 60_000 });
    const otherAgent = await signReuseHint(VISITOR_SECRET, { ...c, ida: "support" });
    for (const hint of [tampered, expiring, otherAgent]) {
      const s = (await session(h, { reuseHint: hint }, "user-a")).json();
      expect(s.verified).toBe(true);
    }
    expect(ccp.routes("identity/exchange")).toHaveLength(4);
  });

  it("a revoked session reused from a hint is refused as LINK_REVOKED, never answered anonymously", async () => {
    const h = stateless({}, {});
    const a = (await session(h, {}, "user-a")).json();
    for (const s of ccp.state.identitySessions.values()) s.revoked = true;
    const again = (await session(h, { reuseHint: a.reuseHint }, "user-a")).json();
    const r = await chat(h, again.token, "user-a");
    expect(r.status).toBe(401);
    expect(r.json().error.code).toBe("LINK_REVOKED");
    expect(ccp.routes("chat").every((c) => typeof c.body.identity_session === "string")).toBe(true);
    // Without the hint (the widget drops it on that refusal) the next page load exchanges again.
    expect((await session(h, {}, "user-a")).json().verified).toBe(true);
    expect(ccp.routes("identity/exchange")).toHaveLength(2);
  });

  it("revoke with the logout page's hint ends that exact session on a host that holds nothing", async () => {
    const opts = (): DeweeHandlerOptions => ({
      ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET },
      secret: VISITOR_SECRET,
      rateLimit: false,
      identity: { sdk: deweeIdentitySdk, authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET },
    });
    const h = stateless({}, {});
    const a = (await session(h, {}, "user-a")).json();
    const ids = (await claims(a.token))?.ids;
    // Another user's subject never revokes it.
    await createDeweeHandler(opts()).revoke("user-b", undefined, a.reuseHint);
    expect(ccp.routes("identity/revoke")).toHaveLength(0);
    await createDeweeHandler(opts()).revoke("user-a", new Request(`${BASE}/logout`, { headers: { origin: "https://shop.example" } }), a.reuseHint);
    expect(ccp.routes("identity/revoke").map((r) => r.body)).toEqual([{ identity_session: ids, agent: "shop" }]);
    expect(ccp.routes("identity/revoke")[0].headers["x-dewee-visitor-origin"]).toBe("https://shop.example");
    expect((await chat(h, a.token, "user-a")).json().error.code).toBe("LINK_REVOKED");
    // A token that does not verify is ignored.
    await createDeweeHandler(opts()).revoke("user-a", undefined, "not-a-token");
    expect(ccp.routes("identity/revoke")).toHaveLength(1);
  });
});
