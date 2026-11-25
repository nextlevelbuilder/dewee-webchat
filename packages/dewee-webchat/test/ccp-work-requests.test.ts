// Work requests over transport "ccp": the opt-in `workRequests` host option, the `work-requests`
// feature header, the offered kinds in `/config`, `POST /work-requests` and `POST /work-requests/list`,
// idempotency end to end, the unknown outcome, refusals, and that a host without the option is unchanged.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { featuresHeader } from "../src/server/ccp-client";
import { createDeweeHandler, optionsFromEnv, verifyVisitorToken, type DeweeHandlerOptions } from "../src/server";
import { deweeIdentitySdk } from "../src/server/identity";
import { APP_ID, ASSERTION_SECRET, INTEGRATION_ID, INTEGRATION_SECRET, ISSUER, startFakeCcp, type FakeCcp } from "./helpers/fake-ccp-ingress";

const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";
const BASE = "https://shop.example/api/dewee";
const CONVERSATION = "conv_work_0001";
// Built by concatenation: phone-like fixtures are never literal.
const PHONE = "+84 " + "912" + " 345 " + "678";
const KINDS = [
  { kind: "callback", title: "Call me back", schema: "callback" as const, staffed_now: false },
  { kind: "quote", title: "Ask for a quote", schema: "generic" as const, staffed_now: true },
];
let ccp: FakeCcp;
/** Everything the hosts wrote to the console during a test: must never hold a contact or a summary. */
let logged: string[] = [];

beforeAll(async () => {
  ccp = await startFakeCcp();
});
afterAll(() => ccp.close());
beforeEach(() => {
  ccp.reset();
  ccp.state.workRequestKinds = KINDS.map((k) => ({ ...k }));
  logged = [];
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const line of logged) expect(line).not.toMatch(/912|345 678|Call me after|leaked-contact|Quote for/);
});

function makeHandler(extra: Partial<DeweeHandlerOptions> = {}) {
  const h = createDeweeHandler({ ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET }, secret: VISITOR_SECRET, rateLimit: false, ...extra });
  return async (req: Request) => {
    const res = await h(req);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  };
}
type H = ReturnType<typeof makeHandler>;

const session = async (h: H) => (await h(new Request(`${BASE}/session`, { method: "POST", body: "{}" }))).json();
const chat = (h: H, token: string) =>
  h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ message: "hi", conversationId: CONVERSATION, agent: "shop" }) }));
const callback = (over: Record<string, unknown> = {}) => ({
  kind: "callback",
  summary: "  Call me after 5pm about my order  ",
  payload: { contact_method: "phone", contact_value: PHONE, purpose: "Call me after 5pm about my order", consent: true },
  idempotencyKey: "wr_key_" + "0001abcd",
  agent: "shop",
  ...over,
});
const create = (h: H, token: string | null, body: unknown) =>
  h(new Request(`${BASE}/work-requests`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }));
const list = (h: H, token: string, body: Record<string, unknown> = {}) =>
  h(new Request(`${BASE}/work-requests/list`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));

describe("work requests: host without the option", () => {
  it("lists no kinds, never advertises the feature and answers neither route", async () => {
    const h = makeHandler();
    expect((await h(new Request(`${BASE}/config`))).json().workRequests).toBeUndefined();
    expect(ccp.routes("config")[0].headers["x-dewee-webchat-features"]).toBeUndefined();
    const s = await session(h);
    for (const r of [await create(h, s.token, callback()), await list(h, s.token)]) expect([r.status, r.json().error.code]).toEqual([404, "not_found"]);
    expect(ccp.seen.filter((r) => r.route.startsWith("work-requests"))).toHaveLength(0);
  });

  it("is refused at startup on the legacy gateway, and read from the environment only as true", () => {
    expect(() => createDeweeHandler({ gatewayUrl: "https://gw.example.com", token: "gw", secret: VISITOR_SECRET, workRequests: true })).toThrow(/workRequests requires the ccp transport/);
    expect(() => createDeweeHandler({ ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET }, secret: VISITOR_SECRET, workRequests: "yes" as unknown as boolean })).toThrow(/workRequests must be/);
    expect(optionsFromEnv({ DEWEE_WEBCHAT_WORK_REQUESTS: "true" }).workRequests).toBe(true);
    expect(optionsFromEnv({ DEWEE_WEBCHAT_WORK_REQUESTS: " true " }).workRequests).toBe(true);
    for (const v of [undefined, "", "1", "false", "yes"]) expect(optionsFromEnv({ DEWEE_WEBCHAT_WORK_REQUESTS: v }).workRequests, String(v)).toBeUndefined();
  });

  it("appends the work-requests token after the others", () => {
    expect(featuresHeader({ workRequests: true })).toBe("work-requests");
    expect(featuresHeader({ humanHandoff: true, credentialRequests: true, workRequests: true })).toBe("human-handoff, credential-requests, work-requests");
  });
});

describe("work requests: opted-in host", () => {
  it("lists the offered kinds in /config only when the workspace offers some", async () => {
    const h = makeHandler({ workRequests: true });
    expect((await h(new Request(`${BASE}/config`))).json().workRequests).toEqual([
      { kind: "callback", title: "Call me back", schema: "callback", staffedNow: false },
      { kind: "quote", title: "Ask for a quote", schema: "generic", staffedNow: true },
    ]);
    expect(ccp.routes("config")[0].headers["x-dewee-webchat-features"]).toBe("work-requests");
    ccp.state.workRequestKinds = [];
    const fresh = makeHandler({ workRequests: true });
    expect((await fresh(new Request(`${BASE}/config`))).json().workRequests).toBeUndefined();
  });

  it("creates a request, forwards the visitor's key unchanged, and answers a retry with the same receipt", async () => {
    const h = makeHandler({ workRequests: true });
    const s = await session(h);
    await chat(h, s.token);
    const first = await create(h, s.token, callback({ conversationId: CONVERSATION }));
    expect(first.status).toBe(201);
    const receipt = first.json();
    expect(receipt).toEqual({
      workRequest: {
        code: expect.stringMatching(/^WR-[0-9A-HJKMNP-TV-Z]{8}$/), kind: "callback", summary: "Call me after 5pm about my order", state: "received",
        receivedAt: expect.any(String), respondDueAt: expect.any(String), dueTimezone: "Asia/Ho_Chi_Minh", publicNote: "", contactHint: "***678", updatedAt: expect.any(String),
      },
      replayed: false,
    });
    expect(first.text).not.toMatch(/staff_0193|VIP|leaked-contact|912 345/);
    const sent = ccp.routes("work-requests/create")[0];
    expect(sent.headers["x-dewee-webchat-features"]).toBe("work-requests");
    expect(sent.body).toEqual({ kind: "callback", summary: "Call me after 5pm about my order", payload: callback().payload, idempotency_key: "wr_key_0001abcd", conversation_id: CONVERSATION, agent: "shop" });
    expect(sent.headers["idempotency-key"]).toBeUndefined();

    const again = await create(h, s.token, callback({ conversationId: CONVERSATION }));
    expect([again.status, again.json().replayed, again.json().workRequest.code]).toEqual([200, true, receipt.workRequest.code]);
    const conflict = await create(h, s.token, callback({ conversationId: CONVERSATION, summary: "Something else" }));
    expect([conflict.status, conflict.json().error.code]).toEqual([409, "idempotency_conflict"]);
    expect(conflict.text).not.toContain(receipt.workRequest.code);
  });

  it("keeps each visitor's requests apart: the same key is another request, and another visitor never lists them", async () => {
    const h = makeHandler({ workRequests: true });
    const a = await session(h);
    const b = await session(h);
    const mine = (await create(h, a.token, callback())).json().workRequest.code;
    const theirs = await create(h, b.token, callback());
    expect(theirs.status).toBe(201);
    expect(theirs.json().workRequest.code).not.toBe(mine);
    expect((await list(h, b.token, { idempotencyKey: "wr_key_0001abcd" })).json().workRequests.map((v: { code: string }) => v.code)).toEqual([theirs.json().workRequest.code]);
    expect((await list(h, a.token)).json().workRequests.map((v: { code: string }) => v.code)).toEqual([mine]);
  });

  it("answers a lost or unknown outcome as unknown, and the request is found by its key", async () => {
    const h = makeHandler({ workRequests: true });
    const s = await session(h);
    ccp.state.workRequestFault = "drop";
    const lost = await create(h, s.token, callback());
    expect([lost.status, lost.json().error.code, lost.headers.get("retry-after")]).toEqual([503, "work_request_outcome_unknown", "5"]);
    const found = (await list(h, s.token, { idempotencyKey: "wr_key_0001abcd" })).json().workRequests;
    expect(found).toHaveLength(1);
    const retried = await create(h, s.token, callback());
    expect([retried.status, retried.json().replayed, retried.json().workRequest.code]).toEqual([200, true, found[0].code]);

    ccp.state.workRequestFault = "unknown";
    const unknown = await create(h, s.token, callback({ idempotencyKey: "wr_key_0002abcd" }));
    expect([unknown.status, unknown.json().error.code, unknown.headers.get("retry-after")]).toEqual([503, "work_request_outcome_unknown", "5"]);
    expect(unknown.text).not.toContain("postgres");
    expect((await list(h, s.token)).json().workRequests).toHaveLength(2);
  });

  it("refreshes an expired edge session and sends the same key again", async () => {
    const h = makeHandler({ workRequests: true });
    const s = await session(h);
    ccp.state.failNext.set("work-requests/create", { status: 401, code: "ingress_session_expired" });
    expect((await create(h, s.token, callback())).status).toBe(201);
    expect(ccp.routes("work-requests/create").map((r) => r.body.idempotency_key)).toEqual(["wr_key_0001abcd", "wr_key_0001abcd"]);
  });

  it("validates the request before calling CCP", async () => {
    const h = makeHandler({ workRequests: true });
    const s = await session(h);
    const bad: Array<[unknown, number]> = [
      [callback({ idempotencyKey: "short" }), 400],
      [callback({ idempotencyKey: "has space in it" }), 400],
      [callback({ kind: "Not A Kind" }), 400],
      [callback({ summary: "   " }), 400],
      [callback({ summary: "é".repeat(501) }), 413],
      [callback({ summary: "my code MEM-ABCDEFGHIJKLMNOP" }), 400],
      [callback({ payload: { contact_value: "MEM-ABCDEFGHIJKLMNOP" } }), 400],
      [callback({ payload: [] }), 400],
      [callback({ payload: { note: "x".repeat(17 * 1024) } }), 413],
      [callback({ conversationId: "bad id" }), 400],
      [callback({ extra: 1 }), 400],
      [callback({ agent: "../x" }), 400],
      [[1], 400],
    ];
    for (const [body, status] of bad) expect((await create(h, s.token, body)).status, JSON.stringify(body).slice(0, 80)).toBe(status);
    for (const body of [{ limit: 0 }, { limit: 101 }, { idempotencyKey: "short" }, { other: 1 }]) expect((await list(h, s.token, body)).status, JSON.stringify(body)).toBe(400);
    expect((await create(h, null, callback())).status).toBe(401);
    expect((await create(h, `${s.token}x`, callback())).status).toBe(401);
    expect(ccp.seen.filter((r) => r.route.startsWith("work-requests"))).toHaveLength(0);
  });

  it("maps CCP refusals without CCP's text", async () => {
    const h = makeHandler({ workRequests: true });
    const s = await session(h);
    const cases: Array<[() => Promise<{ status: number; json(): any; text: string; headers: Headers }>, number, string]> = [
      [() => create(h, s.token, callback({ kind: "repair" })), 403, "work_requests_unavailable"],
      [() => create(h, s.token, callback({ conversationId: "conv_not_mine_01" })), 404, "not_found"],
      [() => create(h, s.token, callback({ payload: { contact_method: "fax", contact_value: "1", purpose: "x", consent: true } })), 400, "bad_request"],
      [() => create(h, s.token, callback({ payload: { ...callback().payload, consent: false } })), 400, "bad_request"],
    ];
    for (const [call, status, code] of cases) {
      const r = await call();
      expect([r.status, r.json().error.code]).toEqual([status, code]);
      expect(r.text).not.toMatch(/postgres|0193/);
    }
    ccp.state.failNext.set("work-requests/create", { status: 429, code: "rate_limited", retryAfter: 120 });
    const limited = await create(h, s.token, callback());
    expect([limited.status, limited.json().error.code, limited.headers.get("retry-after")]).toEqual([429, "rate_limited", "120"]);
    ccp.state.failNext.set("work-requests/list", { status: 502, code: "upstream_failed" });
    const failed = await list(h, s.token);
    expect([failed.status, failed.json().error.code]).toEqual([502, "gateway_error"]);
    expect(failed.text).not.toContain("postgres");
  });

  it("answers a host with the wrong integration secret as not configured, and stores nothing", async () => {
    const h = createDeweeHandler({ ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: "dwc_" + "W".repeat(24) }, secret: VISITOR_SECRET, rateLimit: false, workRequests: true });
    const good = makeHandler({ workRequests: true });
    const s = await session(good);
    const r = await h(new Request(`${BASE}/work-requests`, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify(callback()) }));
    expect([r.status, (await r.json()).error.code]).toEqual([403, "not_configured"]);
    expect(ccp.state.workRequests.size).toBe(0);
  });

  it("keeps two requests of one conversation independent: updating one leaves the other unchanged", async () => {
    const h = makeHandler({ workRequests: true });
    const s = await session(h);
    await chat(h, s.token);
    const call = (await create(h, s.token, callback({ conversationId: CONVERSATION }))).json().workRequest;
    const quote = (await create(h, s.token, { kind: "quote", summary: "Quote for 20 chairs", payload: { items: "20 chairs", city: "Da Nang" }, idempotencyKey: "wr_key_" + "0002abcd", conversationId: CONVERSATION, agent: "shop" })).json().workRequest;
    expect(quote).toMatchObject({ kind: "quote", state: "received", contactHint: "" });
    expect(quote.code).not.toBe(call.code);
    const before = (await list(h, s.token, { conversationId: CONVERSATION })).json().workRequests;
    expect(before.map((v: { code: string }) => v.code)).toEqual([quote.code, call.code]);

    ccp.updateWorkRequest(call.code, { state: "in_progress", public_note: "We will call you today." });
    const after = (await list(h, s.token, { conversationId: CONVERSATION })).json().workRequests;
    expect(after.find((v: { code: string }) => v.code === call.code)).toMatchObject({ state: "in_progress", publicNote: "We will call you today." });
    expect(after.find((v: { code: string }) => v.code === quote.code)).toEqual(before.find((v: { code: string }) => v.code === quote.code));
  });
});

describe("work requests: signed-in visitors", () => {
  const signedIn = (extra: { required?: boolean; rebindEachRequest?: boolean } = {}) => {
    ccp.state.config = { ...ccp.state.config, mode: "signed_in_optional", identity_enabled: true };
    return makeHandler({
      workRequests: true,
      identity: { sdk: deweeIdentitySdk, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET, authenticate: async (req: Request) => (/uid=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ? { subject: /uid=([^;]+)/.exec(req.headers.get("cookie")!)![1] } : null), ...extra },
    });
  };
  const as = (h: H, path: string, token: string, body: unknown, uid = "alice") =>
    h(new Request(`${BASE}/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, cookie: `uid=${uid}` }, body: JSON.stringify(body) }));

  it("forwards the identity session and the bound agent, and keeps the request the signed-in user's", async () => {
    const h = signedIn();
    const s = (await h(new Request(`${BASE}/session`, { method: "POST", headers: { cookie: "uid=alice" }, body: "{}" }))).json();
    expect(s.verified).toBe(true);
    const ids = (await verifyVisitorToken(VISITOR_SECRET, s.token))?.ids;
    const { agent: _a, ...noAgent } = callback();
    const created = await as(h, "work-requests", s.token, noAgent);
    expect(created.status).toBe(201);
    expect(ccp.routes("work-requests/create")[0].body).toMatchObject({ idempotency_key: "wr_key_0001abcd", agent: "shop", identity_session: ids });
    expect([...ccp.state.workRequests.keys()]).toEqual([expect.stringMatching(/^tuc:/)]);
    const listed = await as(h, "work-requests/list", s.token, {});
    expect(listed.json().workRequests.map((v: { code: string }) => v.code)).toEqual([created.json().workRequest.code]);
    expect(ccp.routes("work-requests/list")[0].body).toMatchObject({ agent: "shop", identity_session: ids });
    // Another agent than the one the sign-in is bound to is refused before CCP.
    const other = await as(h, "work-requests", s.token, callback({ agent: "support", idempotencyKey: "wr_key_" + "0002abcd" }));
    expect([other.status, other.json().error.code]).toEqual([403, "agent_not_allowed"]);
    expect(ccp.routes("work-requests/create")).toHaveLength(1);
  });

  it("refuses an anonymous visitor where sign-in is required, and a signed-out user's token, with IDENTITY_REQUIRED", async () => {
    const anonymous = await session(makeHandler({ workRequests: true }));
    const h = signedIn({ required: true });
    for (const path of ["work-requests", "work-requests/list"]) {
      const r = await h(new Request(`${BASE}/${path}`, { method: "POST", headers: { authorization: `Bearer ${anonymous.token}` }, body: JSON.stringify(path === "work-requests" ? callback() : {}) }));
      expect([r.status, r.json().error.code]).toEqual([401, "IDENTITY_REQUIRED"]);
    }
    // A host that checks the login on every request: the user signed out since the session was issued.
    const rebinding = signedIn({ rebindEachRequest: true });
    const s = (await rebinding(new Request(`${BASE}/session`, { method: "POST", headers: { cookie: "uid=alice" }, body: "{}" }))).json();
    const signedOut = await rebinding(new Request(`${BASE}/work-requests`, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify(callback()) }));
    expect([signedOut.status, signedOut.json().error.code]).toEqual([401, "IDENTITY_REQUIRED"]);
    expect(ccp.routes("work-requests/create")).toHaveLength(0);
  });
});
