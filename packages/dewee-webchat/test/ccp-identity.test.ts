// Signed-in visitors over transport "ccp": the website signs the partner assertion, CCP exchanges
// it, and the identity session is sealed into the visitor token exactly as with the legacy gateway.
// Covers fail-closed issuance, no anonymous fallback, rebinding and logout, link, and secret hygiene.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "../src/protocol";
import { createDeweeHandler, memoryIdentitySessionStore, verifyVisitorToken, type DeweeHandlerOptions, type DeweeIdentityOptions } from "../src/server";
import { deweeIdentitySdk } from "../src/server/identity";
import { APP_ID, ASSERTION_SECRET, INTEGRATION_ID, INTEGRATION_SECRET, ISSUER, startFakeCcp, type FakeCcp } from "./helpers/fake-ccp-ingress";

const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";
const BASE = "https://shop.example/api/dewee";
let ccp: FakeCcp;

beforeAll(async () => {
  ccp = await startFakeCcp();
});
afterAll(() => ccp.close());
beforeEach(() => {
  ccp.reset();
  ccp.state.config = { ...ccp.state.config, mode: "signed_in_optional", identity_enabled: true };
});

const browserOutput: string[] = [];
const cookieUser = async (req: Request) => {
  const uid = /(?:^|;\s*)uid=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  if (uid === "boom") throw new Error("login store down");
  return uid ? { subject: uid } : null;
};

function makeHandler(identity: Partial<DeweeIdentityOptions> = {}, extra: Partial<DeweeHandlerOptions> = {}) {
  const h = createDeweeHandler({
    ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET },
    secret: VISITOR_SECRET,
    rateLimit: false,
    identity: { sdk: deweeIdentitySdk, authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET, ...identity },
    ...extra,
  });
  return async (req: Request) => {
    const res = await h(req);
    const text = await res.text();
    browserOutput.push(text, JSON.stringify(Object.fromEntries(res.headers)));
    return { status: res.status, text, json: () => JSON.parse(text) };
  };
}
type H = ReturnType<typeof makeHandler>;

const session = (h: H, uid?: string) => h(new Request(`${BASE}/session`, { method: "POST", headers: uid ? { cookie: `uid=${uid}` } : {}, body: "{}" }));
const chat = (h: H, token: string, body: Record<string, unknown> = {}, cookie?: string) =>
  h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ message: "hi", conversationId: "conv_ident_01", ...body }) }));
const sse = (text: string): ChatStreamEvent[] => text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
const rawIds = async (token: string) => (await verifyVisitorToken(VISITOR_SECRET, token))?.ids;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const spies = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  try {
    return await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
};

describe("ccp identity: startup", () => {
  it("needs an SDK that can sign assertions, and no gateway options", () => {
    const base = { ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET }, secret: VISITOR_SECRET };
    const idn = { authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET };
    const { createAssertion: _omit, ...noSigner } = deweeIdentitySdk;
    expect(() => createDeweeHandler({ ...base, identity: { ...idn, sdk: noSigner } })).toThrow(/createAssertion/);
    expect(() => createDeweeHandler({ ...base, identity: { ...idn, sdk: deweeIdentitySdk, agent: "bad agent!" } })).toThrow(/agent key/);
    expect(() => createDeweeHandler({ ...base, identity: { ...idn, sdk: deweeIdentitySdk } })).not.toThrow();
  });
});

describe("ccp identity: sessions", () => {
  it("shares identity sessions between handlers while keeping subjects isolated", async () => {
    const store = memoryIdentitySessionStore();
    const first = makeHandler({ sessionStore: store });
    const second = makeHandler({ sessionStore: store });
    const a = (await session(first, "user-a")).json();
    const a2 = (await session(second, "user-a")).json();
    const b = (await session(second, "user-b")).json();
    expect(await rawIds(a.token)).toBe(await rawIds(a2.token));
    expect(await rawIds(a.token)).not.toBe(await rawIds(b.token));
    expect(ccp.routes("identity/exchange")).toHaveLength(2);
  });

  it("does not expose storage failures or fall back to an anonymous session", async () => {
    const store = memoryIdentitySessionStore();
    store.read = async () => { throw new Error("private store connection details"); };
    const h = makeHandler({ sessionStore: store });
    const response = await h(new Request(`${BASE}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" }));
    expect(response.status).toBe(503);
    expect(response.text).not.toContain("private store connection details");
    expect(ccp.routes("identity/exchange")).toHaveLength(0);
  });

  it.each(["commit", "read-after-conflict"] as const)("revokes a newly exchanged session when %s fails", async (mode) => {
    const store = memoryIdentitySessionStore();
    if (mode === "commit") store.commit = async () => { throw new Error("private store failure"); };
    else {
      const read = store.read.bind(store);
      let reads = 0;
      store.read = async (...args) => { if (++reads > 1) throw new Error("private store failure"); return read(...args); };
      store.commit = async () => false;
    }
    const h = makeHandler({ sessionStore: store });
    const response = await session(h, "user-a");
    expect(response.status).toBe(503);
    expect(response.text).not.toContain("private store failure");
    expect(ccp.routes("identity/revoke")).toHaveLength(1);
  });

  it("fails closed when checking or invalidating a stored session fails", async () => {
    const store = memoryIdentitySessionStore();
    const h = makeHandler({ sessionStore: store });
    const a = (await session(h, "user-a")).json();
    const check = store.check.bind(store);
    store.check = async () => { throw new Error("private store failure"); };
    const cannotCheck = await session(h, "user-a");
    expect(cannotCheck.status).toBe(503);
    expect(cannotCheck.text).not.toContain("private store failure");
    store.check = check;
    store.deleteToken = async () => { throw new Error("private store failure"); };
    for (const entry of ccp.state.identitySessions.values()) entry.revoked = true;
    const refused = await chat(h, a.token);
    expect(refused.status).toBe(503);
    expect(refused.text).not.toContain("private store failure");
  });

  it("does not publish an exchange that finishes after logout", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let exchanged = false;
    const delayedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/identity/exchange")) { exchanged = true; await gate; }
      return response;
    };
    const store = memoryIdentitySessionStore();
    const opts: DeweeHandlerOptions = {
      ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET, fetch: delayedFetch },
      secret: VISITOR_SECRET,
      rateLimit: false,
      identity: { sdk: deweeIdentitySdk, authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET, sessionStore: store },
    };
    const first = createDeweeHandler(opts);
    const second = createDeweeHandler(opts);
    const issuing = first(new Request(`${BASE}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" }));
    await vi.waitFor(() => expect(exchanged).toBe(true));
    await second.revoke("user-a");
    release();
    expect((await issuing).status).toBe(503);
    expect(ccp.routes("identity/revoke")).toHaveLength(1);
  });

  it("does not publish both concurrent exchanges from separate handlers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let exchanged = 0;
    const delayedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/identity/exchange")) { exchanged++; await gate; }
      return response;
    };
    const store = memoryIdentitySessionStore();
    const extra = { ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET, fetch: delayedFetch } };
    const first = makeHandler({ sessionStore: store }, extra);
    const second = makeHandler({ sessionStore: store }, extra);
    const a = session(first, "user-a");
    const b = session(second, "user-a");
    await vi.waitFor(() => expect(exchanged).toBe(2));
    release();
    const results = await Promise.all([a, b]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 503]);
    expect(ccp.routes("identity/revoke")).toHaveLength(1);
  });

  it("revokes an exact reuse hint even if the shared store is unavailable", async () => {
    const store = memoryIdentitySessionStore();
    const h = createDeweeHandler({
      ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET },
      secret: VISITOR_SECRET, rateLimit: false,
      identity: { sdk: deweeIdentitySdk, authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET, sessionStore: store },
    });
    const response = await h(new Request(`${BASE}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" }));
    const data = await response.json();
    store.takeSubject = async () => { throw new Error("private store failure"); };
    await h.revoke("user-a", undefined, data.reuseHint);
    expect(ccp.routes("identity/revoke")).toHaveLength(1);
  });
  it("exchanges a signed assertion at CCP and seals the identity session; the bound agent cannot switch", async () => {
    const h = makeHandler();
    const cfg = (await h(new Request(`${BASE}/config`))).json();
    expect(cfg).toMatchObject({ identity: true, allowAgentSwitch: false, defaultAgent: "shop" });
    const a = (await session(h, "user-a")).json();
    expect(a.verified).toBe(true);
    expect(a.expiresIn).toBeGreaterThan(0);
    const ex = ccp.routes("identity/exchange")[0];
    expect(ex.body.agent).toBe("shop");
    expect(ex.body.assertion.split(".")).toHaveLength(3);
    expect(ex.headers["x-dewee-webchat-session"]).toMatch(/^dws1\./);
    const ids = await rawIds(a.token);
    expect(ids).toMatch(/^idsess_/);
    expect(Buffer.from(a.token.split(".")[0], "base64url").toString()).not.toContain(ids!);

    const events = sse((await chat(h, a.token)).text);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect((events.at(-1) as any).content).toMatch(/^hello tuc:/);
    expect(ccp.routes("chat")[0].body).toEqual({ message: "hi", conversation_id: "conv_ident_01", agent: "shop", identity_session: ids });
    expect((await chat(h, a.token, { agent: "support" })).status).toBe(403);
  });

  it("keeps users apart and reuses one identity session per user", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const a2 = (await session(h, "user-a")).json();
    const b = (await session(h, "user-b")).json();
    expect(a2.visitorId).toBe(a.visitorId);
    expect(b.visitorId).not.toBe(a.visitorId);
    expect(await rawIds(a2.token)).toBe(await rawIds(a.token));
    expect(await rawIds(b.token)).not.toBe(await rawIds(a.token));
    expect(ccp.routes("identity/exchange")).toHaveLength(2);
  });

  it("fails closed: a login that cannot be read is 503, a required sign-in is 401, never anonymous", async () => {
    const h = makeHandler({ required: true });
    expect((await quiet(() => session(h, "boom"))).json().error.code).toBe("SOURCE_UNAVAILABLE");
    const none = await session(h);
    expect(none.status).toBe(401);
    expect(none.json().error.code).toBe("IDENTITY_REQUIRED");
    expect(ccp.routes("identity/exchange")).toHaveLength(0);
  });

  it("answers an operator-side exchange refusal as misconfiguration, without detail", async () => {
    const h = makeHandler();
    const r = await quiet(() => session(h, "operator-problem"));
    expect(r.status).toBe(500);
    expect(r.json()).toEqual({ error: { message: "Signed-in chat is misconfigured on this server", code: "identity_misconfigured" } });
  });

  it("forwards a revoked identity session as a typed error and never falls back to anonymous", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    for (const s of ccp.state.identitySessions.values()) s.revoked = true;
    const r = await chat(h, a.token);
    expect(r.status).toBe(401);
    expect(r.json().error).toEqual({ message: "Your access was revoked.", code: "LINK_REVOKED", remediation: { action: "reauthenticate", audience: "end_user" } });
    // CCP saw the identity session, so no anonymous turn was attempted
    expect(ccp.routes("chat").every((c) => typeof c.body.identity_session === "string")).toBe(true);
    // The dead session is not reused: the next /session exchanges again
    await session(h, "user-a");
    expect(ccp.routes("identity/exchange")).toHaveLength(2);
  });

  it("forwards an identity error raised during the run in the stream", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    expect(sse((await chat(h, a.token, { message: "now midrevoke" })).text).at(-1)).toEqual({ type: "error", code: "LINK_REVOKED", message: "Your access was revoked.", remediation: { action: "reauthenticate", audience: "end_user" } });
  });
});

describe("ccp identity: rebinding and logout", () => {
  it("refuses A's token under B's cookie or after logout, and revokes A's session at CCP", async () => {
    const h = makeHandler({ rebindEachRequest: true });
    const a = (await session(h, "user-a")).json();
    expect((await chat(h, a.token, {}, "uid=user-a")).status).toBe(200);
    const chats = ccp.routes("chat").length;
    const switched = await chat(h, a.token, {}, "uid=user-b");
    expect(switched.status).toBe(401);
    expect(switched.json().error.code).toBe("IDENTITY_REQUIRED");
    expect(ccp.routes("chat")).toHaveLength(chats);
    expect(ccp.routes("identity/revoke")[0].body).toEqual({ identity_session: await rawIds(a.token), agent: "shop" });
    // logged out: no cookie at all
    expect((await chat(h, a.token)).status).toBe(401);
    // the revoked session is dead at CCP even if replayed without rebinding
    const replay = await chat(makeHandler(), a.token);
    expect(replay.json().error.code).toBe("LINK_REVOKED");
  });

  it("refuses a request without a login locally and leaves the user's other devices working", async () => {
    const h = makeHandler({ rebindEachRequest: true });
    const phone = (await session(h, "user-a")).json();
    const laptop = (await session(h, "user-a")).json();
    const signedOut = await chat(h, phone.token);
    expect(signedOut.status).toBe(401);
    expect(signedOut.json().error.code).toBe("IDENTITY_REQUIRED");
    expect(ccp.routes("identity/revoke")).toHaveLength(0);
    expect((await chat(h, laptop.token, {}, "uid=user-a")).status).toBe(200);
    expect((await chat(h, phone.token, {}, "uid=user-a")).status).toBe(200);
  });

  it("revoke(subject) ends the user's identity session at CCP for the logout", async () => {
    const raw = createDeweeHandler({
      ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET },
      secret: VISITOR_SECRET,
      rateLimit: false,
      identity: { sdk: deweeIdentitySdk, authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET },
    });
    const h: H = async (req) => {
      const res = await raw(req);
      const text = await res.text();
      return { status: res.status, text, json: () => JSON.parse(text) };
    };
    const a = (await session(h, "user-a")).json();
    const ids = await rawIds(a.token);
    await raw.revoke("user-a", new Request(`${BASE}/logout`, { headers: { origin: "https://shop.example" } }));
    expect(ccp.routes("identity/revoke").map((r) => r.body)).toEqual([{ identity_session: ids, agent: "shop" }]);
    expect((await chat(h, a.token, {}, "uid=user-a")).json().error.code).toBe("LINK_REVOKED");
    // The next sign-in exchanges a new session instead of reusing the revoked one.
    const next = (await session(h, "user-a")).json();
    expect(await rawIds(next.token)).not.toBe(ids);
    expect(ccp.routes("identity/exchange")).toHaveLength(2);
    // Unknown or empty subjects are a no-op, and revoke never throws.
    await raw.revoke("nobody");
    await raw.revoke("");
    expect(ccp.routes("identity/revoke")).toHaveLength(1);
    ccp.state.secrets.clear();
    await expect(raw.revoke("user-a")).resolves.toBeUndefined();
  });

  it("revoke(subject) without a request tells CCP the origin the session was issued for", async () => {
    const raw = createDeweeHandler({
      ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET },
      secret: VISITOR_SECRET,
      rateLimit: false,
      identity: { sdk: deweeIdentitySdk, authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET },
    });
    await raw(new Request(`${BASE}/session`, { method: "POST", headers: { cookie: "uid=user-a", origin: "https://shop.example" }, body: "{}" }));
    await raw.revoke("user-a");
    expect(ccp.routes("identity/revoke")).toHaveLength(1);
    expect(ccp.routes("identity/revoke")[0].headers["x-dewee-visitor-origin"]).toBe("https://shop.example");
  });

  it("answers 503 when the login check fails during rebinding", async () => {
    const h = makeHandler({ rebindEachRequest: true });
    const a = (await session(h, "user-a")).json();
    const r = await quiet(() => chat(h, a.token, {}, "uid=boom"));
    expect(r.status).toBe(503);
    expect(r.json().error.code).toBe("SOURCE_UNAVAILABLE");
  });
});

describe("ccp identity: link", () => {
  it("returns the proof code and chat accounts in the browser shape", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const r = await h(new Request(`${BASE}/link`, { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify({ idempotencyKey: "k-1" }) }));
    expect(r.status).toBe(200);
    // CCP's `{channel, url}`: the channel names the account; the URL and a malformed channel are dropped.
    expect(r.json()).toEqual({ proofCode: "482913", expiresAt: expect.any(Number), deepLinks: [{ channelType: "telegram", channelInstanceId: "", name: "telegram" }] });
    expect(r.text).not.toContain("t.me");
    // The host's key is mapped to one the ingress accepts (8 to 128 of [A-Za-z0-9._:-]), the same each time.
    const sent = ccp.routes("link")[0].headers["idempotency-key"];
    expect(sent).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(sent).not.toBe("k-1");
  });

  it("maps any key the browser contract allows to a stable ingress key, and leaves an absent one absent", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const link = (idempotencyKey?: string) =>
      h(new Request(`${BASE}/link`, { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify(idempotencyKey === undefined ? {} : { idempotencyKey }) }));
    const long = "~".repeat(255);
    for (const key of ["k", long, "a/b?c=d#e!", long]) expect((await link(key)).status).toBe(200);
    await link();
    const keys = ccp.routes("link").map((r) => r.headers["idempotency-key"]);
    for (const k of keys.slice(0, 4)) expect(k).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(new Set(keys.slice(0, 4)).size).toBe(3);
    expect(keys[1]).toBe(keys[3]);
    expect(keys[4]).toBeUndefined();
  });

  it("refuses anonymous visitors and maps CCP link conflicts", async () => {
    const h = makeHandler();
    const anon = (await session(h)).json();
    expect((await h(new Request(`${BASE}/link`, { method: "POST", headers: { authorization: `Bearer ${anon.token}` }, body: "{}" }))).json().error.code).toBe("IDENTITY_REQUIRED");
    const a = (await session(h, "user-a")).json();
    for (const code of ["link_in_progress", "idempotency_key_reused"]) {
      ccp.state.failNext.set("link", { status: 409, code });
      const r = await h(new Request(`${BASE}/link`, { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: "{}" }));
      expect([r.status, r.json().error.code]).toEqual([409, code]);
    }
    ccp.state.failNext.set("link", { status: 503, code: "linking_unavailable" });
    const off = await h(new Request(`${BASE}/link`, { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: "{}" }));
    expect([off.status, off.json().error.code]).toEqual([503, "linking_unavailable"]);
  });
});

describe("ccp identity: secret hygiene", () => {
  it("never sends the integration secret, assertion secret, raw identity session or edge session to a browser", () => {
    const all = browserOutput.join("\n");
    for (const needle of [INTEGRATION_SECRET, ASSERTION_SECRET, VISITOR_SECRET, "idsess_", "dws1.", ccp.origin, "user-a", "principal"]) expect(all, needle).not.toContain(needle);
  });
});
