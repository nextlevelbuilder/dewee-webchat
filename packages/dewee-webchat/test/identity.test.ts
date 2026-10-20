// Signed-in users through a Dewee identity session exchange, against a fake gateway that serves the
// identity HTTP routes and the WS v3 protocol on one port. Covers isolation between users, fail-closed
// session issuance, typed error forwarding, session reuse and rate limits, web-first linking and
// secret hygiene.
import { createHmac, generateKeyPairSync, randomUUID, verify as verifySignature, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { ChatStreamEvent } from "../src/protocol";
import {
  createDeweeHandler,
  signVisitorToken,
  verifyVisitorToken,
  type DeweeHandlerOptions,
  type DeweeIdentityOptions,
  type RateLimitBucket,
} from "../src/server";
import { deweeIdentitySdk } from "../src/server/identity";
import { constantTimeEqual } from "../src/server/security";
import { ApiClient } from "../src/widget/api-client";
import { pickStrings } from "../src/widget/i18n";

const GW_TOKEN = "gw-token-NEVER-IN-BROWSER-0001";
const ASSERTION_SECRET = "assertion-secret-NEVER-IN-BROWSER-0000000001";
const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";
const APP_ID = "8f0c6a2e-3b1d-4c5e-9a7f-1b2c3d4e5f60";
const ISSUER = "https://host.example";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privateJwk = { ...(ec.privateKey.export({ format: "jwk" }) as Record<string, string>), kid: "k1", alg: "ES256" } as { kty: string; kid: string; d: string; alg: string };
const ecPublic: KeyObject = ec.publicKey;

// ---------- fake gateway ----------

interface Session { principal: string; agent: string; expiresAt: number }
const sessions = new Map<string, Session>();
const expiredSessions = new Set<string>();
const revokeDuringRun = new Set<string>();
const seen = { connects: [] as any[], sends: [] as any[], exchanges: [] as { sub: string; agent: string; ttl?: number; token?: string }[] };
/** Simulates a gateway (or replica) that has identity switched off: it ignores `identity_session`. */
const gw = { ignoreIdentity: false, linkDisabled: false };
let gatewayUrl = "";
let server: Server;

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** Checks a partner assertion the way the gateway does (HS256 with the secret, or ES256 with the JWKS key). */
function verifyAssertion(jws: string): { sub: string } | null {
  const [h, p, s] = jws.split(".");
  if (!h || !p || !s) return null;
  const header = b64json(h);
  const claims = b64json(p);
  let ok = false;
  if (header.alg === "HS256") ok = createHmac("sha256", ASSERTION_SECRET).update(`${h}.${p}`).digest("base64url") === s;
  if (header.alg === "ES256") ok = verifySignature("sha256", Buffer.from(`${h}.${p}`), { key: ecPublic, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  if (!ok || header.typ !== "dewee-session+jwt" || claims.aud !== `dewee:${APP_ID}` || claims.iss !== ISSUER) return null;
  return { sub: claims.sub };
}

const identityError = (code: string, action: string, audience = "end_user") => ({ error: { code, message: code, type: "identity_error", remediation: { action, audience } } });

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function onHttp(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (req.method === "POST" && req.url === "/v1/identity/sessions/exchange") {
    const auth = String(req.headers.authorization ?? "");
    const proof = auth.startsWith("Dewee-Assertion ") ? verifyAssertion(auth.slice(16)) : null;
    if (!proof) return sendJson(res, 401, identityError("IDENTITY_REQUIRED", "reauthenticate"));
    const record: (typeof seen.exchanges)[number] = { sub: proof.sub, agent: body.agent_id, ttl: body.ttl_seconds };
    seen.exchanges.push(record);
    if (proof.sub === "suspended-user") return sendJson(res, 409, identityError("LINK_REVOKED", "reauthenticate"));
    if (proof.sub === "operator-problem") return sendJson(res, 403, identityError("PERMISSION_DENIED", "contact_admin", "operator"));
    const token = `idsess_${randomUUID()}`;
    record.token = token;
    const expiresAt = Date.now() + (body.ttl_seconds ?? 3600) * 1000;
    // One principal per subject: a stable fake id derived from it.
    const principal = createHmac("sha256", "principal").update(proof.sub).digest("hex").slice(0, 32);
    sessions.set(token, { principal, agent: body.agent_id, expiresAt });
    return sendJson(res, 201, {
      session_token: token, token_type: "identity_session", header: "X-Dewee-Identity-Session", session_id: randomUUID(),
      principal_id: principal, application_id: APP_ID, agent_id: randomUUID(), expires_at: new Date(expiresAt).toISOString(), test_mode: false,
    });
  }
  if (req.method === "POST" && req.url === "/v1/identity/links") {
    if (gw.linkDisabled) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "route not found" } });
    const s = sessions.get(String(req.headers["x-dewee-identity-session"] ?? ""));
    if (!s) return sendJson(res, 401, identityError("IDENTITY_REQUIRED", "reauthenticate"));
    const key = req.headers["idempotency-key"];
    if (key === "reused-key") return sendJson(res, 409, { error: { code: "IDEMPOTENCY_KEY_REUSED", message: "idempotency key reused" } });
    if (key === "busy-key") return sendJson(res, 409, { error: { code: "FAILED_PRECONDITION", message: "link already in progress" } });
    return sendJson(res, 201, {
      transaction_id: randomUUID(), kind: "web_first", state: "awaiting_channel_proof", proof_code: "482913",
      expires_at: new Date(Date.now() + 600_000).toISOString(), created: true,
      deep_links: [{ channel_type: "telegram", channel_instance_id: randomUUID(), name: "acme-bot", display_name: "Acme Bot" }],
    });
  }
  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
}

beforeAll(async () => {
  server = createServer((req, res) => void onHttp(req, res));
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    let user = "";
    let sessionToken = "";
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      const ok = (payload: unknown) => ws.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload }));
      const err = (code: string, action?: string) =>
        ws.send(JSON.stringify({ type: "res", id: f.id, ok: false, error: { code, message: `${code} (gateway)`, ...(action ? { details: { remediation: { action, audience: "end_user" } } } : {}) } }));
      if (f.method === "connect") {
        seen.connects.push(f.params);
        if (f.params.token !== GW_TOKEN) return err("UNAUTHORIZED");
        if (f.params.identity_session !== undefined && !gw.ignoreIdentity) {
          const s = sessions.get(f.params.identity_session);
          if (expiredSessions.has(f.params.identity_session)) return err("LINK_EXPIRED", "reauthenticate");
          if (!s) return err("IDENTITY_REQUIRED", "reauthenticate");
          if (f.params.user_id !== undefined && f.params.user_id !== `tuc:${s.principal}`) return err("IDENTITY_CONFLICT", "contact_admin");
          user = `tuc:${s.principal}`;
          sessionToken = f.params.identity_session;
        } else user = f.params.user_id ?? ""; // identity switched off: the operator token's own (empty) user
        return ok({ role: "operator", user_id: user });
      }
      if (f.method === "chat.send") {
        seen.sends.push({ ...f.params, user });
        if (sessionToken && sessions.get(sessionToken)?.agent !== f.params.agentId) return err("PERMISSION_DENIED", "contact_admin");
        const base = { agentId: f.params.agentId, runId: "run-1", sessionKey: f.params.sessionKey };
        ws.send(JSON.stringify({ type: "event", event: "agent", payload: { ...base, type: "run.started", payload: {} } }));
        if (revokeDuringRun.has(sessionToken)) return err("LINK_REVOKED", "reauthenticate");
        ws.send(JSON.stringify({ type: "event", event: "agent", payload: { ...base, type: "chunk", payload: { content: `hello ${user}` } } }));
        return ok({ content: `hello ${user}` });
      }
      if (f.method === "chat.history") return ok({ messages: [{ role: "user", content: `history of ${user}` }] });
      ok({});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

// ---------- handler under test ----------

/** Every body this file's handlers sent to a browser; checked for secrets at the end. */
const browserBodies: string[] = [];

const cookieUser = async (req: Request) => {
  const uid = /(?:^|;\s*)uid=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  if (uid === "boom") throw new Error("login store down");
  return uid ? { subject: uid } : null;
};

const baseIdentity = { sdk: deweeIdentitySdk, authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET };

function makeHandler(identity: Partial<DeweeIdentityOptions> = {}, extra: Partial<DeweeHandlerOptions> = {}) {
  const h = createDeweeHandler({
    gatewayUrl,
    token: GW_TOKEN,
    secret: VISITOR_SECRET,
    agents: ["support", "sales"],
    rateLimit: false,
    identity: { ...baseIdentity, ...identity },
    ...extra,
  });
  return async (req: Request) => {
    const res = await h(req);
    const text = await res.text();
    browserBodies.push(text, JSON.stringify(Object.fromEntries(res.headers)));
    return { status: res.status, text, json: () => JSON.parse(text) };
  };
}
type TestHandler = ReturnType<typeof makeHandler>;

const BASE = "https://site.test/api/dewee";
const session = (h: TestHandler, uid?: string, body: unknown = {}) =>
  h(new Request(`${BASE}/session`, { method: "POST", headers: uid ? { cookie: `uid=${uid}` } : {}, body: JSON.stringify(body) }));
const chat = (h: TestHandler, token: string, body: Record<string, unknown> = {}, cookie?: string) =>
  h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ message: "hi", conversationId: "conv_ident1", ...body }) }));
const history = (h: TestHandler, token: string, cookie?: string) =>
  h(new Request(`${BASE}/history?agent=support&conversationId=conv_ident1`, { headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) } }));
const link = (h: TestHandler, token: string, body: unknown = {}, cookie?: string) =>
  h(new Request(`${BASE}/link`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
const sse = (text: string): ChatStreamEvent[] => text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
const claimsOf = (token: string) => b64json(token.split(".")[0]);
/** The raw identity session inside a visitor token, as only the server can read it. */
const rawIds = async (token: string) => (await verifyVisitorToken(VISITOR_SECRET, token))?.ids;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const spies = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  try {
    return await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
};

describe("identity sessions: isolation", () => {
  it("gives users A and B different identity sessions and never sends a client-chosen user_id", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const b = (await session(h, "user-b")).json();
    expect(a.verified).toBe(true);
    expect(b.verified).toBe(true);
    const [idsA, idsB] = [await rawIds(a.token), await rawIds(b.token)];
    expect(idsA).toMatch(/^idsess_/);
    expect(idsA).not.toBe(idsB);
    expect(a.visitorId).not.toBe(b.visitorId);

    const ra = sse((await chat(h, a.token, { agent: "support", userId: "evil" })).text);
    const connA = seen.connects.at(-1);
    expect(connA).toEqual({ token: GW_TOKEN, identity_session: idsA });
    expect(connA).not.toHaveProperty("user_id");
    const rb = sse((await chat(h, b.token)).text);
    expect(seen.connects.at(-1).identity_session).toBe(idsB);
    expect(ra.at(-1)).toMatchObject({ type: "done" });
    expect((ra.at(-1) as any).content).not.toBe((rb.at(-1) as any).content);
  });

  it("keeps chatting as A when A's visitor token is replayed with B's cookie (no switch)", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const asA = sse((await chat(h, a.token)).text).at(-1) as any;
    const replay = sse((await chat(h, a.token, {}, "uid=user-b")).text).at(-1) as any;
    expect(seen.connects.at(-1).identity_session).toBe(await rawIds(a.token));
    expect(replay.content).toBe(asA.content);
  });

  it("keeps the same visitor id for the same user, so history follows them", async () => {
    const h = makeHandler();
    const first = (await session(h, "user-a")).json();
    const second = (await session(h, "user-a")).json();
    expect(second.visitorId).toBe(first.visitorId);
  });

  it("answers 401 to a tampered or foreign-signed token", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const b = (await session(h, "user-b")).json();
    const [, sig] = a.token.split(".");
    const swapped = Buffer.from(JSON.stringify({ ...claimsOf(a.token), ids: claimsOf(b.token).ids })).toString("base64url");
    expect((await chat(h, `${swapped}.${sig}`)).status).toBe(401);
    const forged = await signVisitorToken("another-secret-of-at-least-32-chars!!", { v: "visitor_123", exp: Date.now() + 60_000, ids: (await rawIds(b.token))!, ida: "support" });
    expect((await chat(h, forged)).status).toBe(401);
  });

  it("binds the session to one agent that must still be allowed", async () => {
    const h = makeHandler();
    const cfg = (await h(new Request(`${BASE}/config`))).json();
    expect(cfg).toMatchObject({ identity: true, allowAgentSwitch: false, defaultAgent: "support" });
    const a = (await session(h, "user-a")).json();
    expect(seen.exchanges.at(-1)).toMatchObject({ sub: "user-a", agent: "support" });
    expect((await chat(h, a.token, { agent: "sales" })).status).toBe(403);
    // The same secret after "support" left the allowlist: the old token is refused for chat and history.
    const narrowed = makeHandler({ agent: "sales" }, { agents: ["sales"] });
    const r = await chat(narrowed, a.token);
    expect([r.status, r.json().error.code]).toEqual([403, "agent_not_allowed"]);
    expect((await history(narrowed, a.token)).status).toBe(403);
  });
});

describe("identity sessions: sealed token", () => {
  it("never puts the raw identity session or the subject in the browser token", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const raw = (await rawIds(a.token))!;
    const decoded = Buffer.from(a.token.split(".")[0], "base64url").toString("utf8");
    expect(decoded).not.toContain(raw);
    expect(decoded).not.toContain("user-a");
    expect(Object.keys(claimsOf(a.token)).sort()).toEqual(["exp", "ida", "ids", "v"]);
    // Sealed for this visitor and agent: moving the ciphertext into another visitor's claims breaks it.
    const other = await signVisitorToken(VISITOR_SECRET, { v: "visitor_other1", exp: Date.now() + 60_000 });
    const moved = { ...claimsOf(other), ids: claimsOf(a.token).ids, ida: "support" };
    const body = Buffer.from(JSON.stringify(moved)).toString("base64url");
    const sig = createHmac("sha256", VISITOR_SECRET).update(body).digest("base64url");
    expect(await verifyVisitorToken(VISITOR_SECRET, `${body}.${sig}`)).toBeNull();
  });
});

describe("identity sessions: sealed token limits", () => {
  it("seals and opens a session token of the SDK's 512-character maximum, with a subject digest", async () => {
    for (const ids of ["a".repeat(512), '"\\'.repeat(256), "\u0001".repeat(512), "é".repeat(512)]) {
      const token = await signVisitorToken(VISITOR_SECRET, { v: "visitor_max512", exp: Date.now() + 60_000, ids, ida: "support", sub: "d".repeat(43) });
      expect(await verifyVisitorToken(VISITOR_SECRET, token)).toEqual({ v: "visitor_max512", exp: expect.any(Number), ids, ida: "support", sub: "d".repeat(43) });
    }
    const tooLong = await signVisitorToken(VISITOR_SECRET, { v: "visitor_max512", exp: Date.now() + 60_000, ids: "a".repeat(513), ida: "support" });
    expect(await verifyVisitorToken(VISITOR_SECRET, tooLong)).toBeNull();
  });

  it("compares strings in constant time without changing the answer", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("identity sessions: fail closed", () => {
  it("refuses identity mode combined with client credentials and other misconfiguration", () => {
    const base = { gatewayUrl: "https://gw.example.com", token: GW_TOKEN, secret: VISITOR_SECRET, agents: ["support"] };
    const identity = baseIdentity;
    expect(() => createDeweeHandler({ ...base, identity, allowClientCredentials: true })).toThrow(/allowClientCredentials/);
    expect(() => createDeweeHandler({ ...base, identity, allowClientCredentials: { allowedHosts: ["gw.example.com"] } })).toThrow(/allowClientCredentials/);
    expect(() => createDeweeHandler({ ...base, token: undefined, identity })).toThrow(/gatewayUrl and token/);
    expect(() => createDeweeHandler({ ...base, identity: { ...identity, sdk: undefined as never } })).toThrow(/dewee-webchat\/server\/identity/);
    expect(() => createDeweeHandler({ ...base, identity: { ...identity, privateKeyJwk: privateJwk } })).toThrow(/exactly one/);
    expect(() => createDeweeHandler({ ...base, identity: { ...identity, audience: "dewee:someone-else" } })).toThrow(/audience/);
    expect(() => createDeweeHandler({ ...base, identity: { ...identity, appId: "acme" } })).toThrow(/appId/);
    expect(() => createDeweeHandler({ ...base, identity: { ...identity, agent: "admin" } })).toThrow(/not in agents/);
    expect(() => createDeweeHandler({ ...base, identity: { ...identity, assertionSecret: "short" } })).toThrow(/too short/);
    // The error never echoes a secret.
    try { createDeweeHandler({ ...base, identity, allowClientCredentials: true }); } catch (e) { expect(String(e)).not.toContain(ASSERTION_SECRET); }
  });

  it("falls back to an anonymous visitor only for a visitor who is not signed in", async () => {
    const h = makeHandler();
    const s = (await session(h)).json();
    expect(s.verified).toBeUndefined();
    expect(s).not.toHaveProperty("expiresIn");
    expect(claimsOf(s.token)).not.toHaveProperty("ids");
    await chat(h, s.token);
    expect(seen.connects.at(-1)).toEqual({ token: GW_TOKEN, user_id: `webchat-${s.visitorId}` });
  });

  it("answers 503 and issues nothing when authenticate throws, required or not", async () => {
    for (const required of [false, true]) {
      const r = await quiet(() => session(makeHandler({ required }), "boom"));
      expect(r.status).toBe(503);
      expect(r.json()).toEqual({ error: { message: expect.any(String), code: "SOURCE_UNAVAILABLE", remediation: { action: "retry_later", audience: "end_user" } } });
    }
  });

  it("issues no session at all when identity is required and the user is not signed in", async () => {
    const h = makeHandler({ required: true });
    const none = await session(h);
    expect(none.status).toBe(401);
    expect(none.json()).toEqual({ error: { message: expect.any(String), code: "IDENTITY_REQUIRED", remediation: { action: "reauthenticate", audience: "end_user" } } });
    // An anonymous visitor token from before the switch is refused too.
    const anon = await signVisitorToken(VISITOR_SECRET, { v: "visitor_123", exp: Date.now() + 60_000 });
    const r = await chat(h, anon);
    expect([r.status, r.json().error.code]).toEqual([401, "IDENTITY_REQUIRED"]);
  });

  it("never downgrades a signed-in user whose exchange is refused", async () => {
    const h = makeHandler();
    const [r, bad, email, operator] = await quiet(async () => [
      await session(h, "suspended-user"),
      await makeHandler({ assertionSecret: "wrong-secret-but-long-enough-0000000000001" })(
        new Request(`${BASE}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" }),
      ),
      await session(h, "someone@example.com"),
      await session(h, "operator-problem"),
    ]);
    expect(r.status).toBe(401);
    expect(r.json()).toEqual({ error: { message: expect.any(String), code: "LINK_REVOKED", remediation: { action: "reauthenticate", audience: "end_user" } } });
    expect([bad.status, bad.json().error.code]).toEqual([401, "IDENTITY_REQUIRED"]);
    expect([email.status, email.json().error.code]).toEqual([500, "identity_misconfigured"]);
    // A refusal addressed to the operator is this server's misconfiguration, not the user's problem.
    expect(operator.json()).toEqual({ error: { message: expect.any(String), code: "identity_misconfigured" } });
    expect(operator.status).toBe(500);
    for (const res of [r, bad, email, operator]) expect(res.json()).not.toHaveProperty("token");
  });

  it("refuses to chat when the gateway ignores the identity session (identity switched off)", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const sends = seen.sends.length;
    gw.ignoreIdentity = true;
    try {
      const r = await quiet(() => chat(h, a.token));
      expect(r.status).toBe(503);
      expect(r.json().error.code).toBe("SOURCE_UNAVAILABLE");
      const hist = await quiet(() => history(h, a.token));
      expect([hist.status, hist.json().error.code]).toEqual([503, "SOURCE_UNAVAILABLE"]);
      expect(seen.sends.length).toBe(sends); // nothing ran as the operator's user
    } finally {
      gw.ignoreIdentity = false;
    }
  });

  it("caps the visitor token at the identity session lifetime, measured from receipt", async () => {
    const short = (await session(makeHandler({ sessionTtlSeconds: 120 }), "user-a")).json();
    expect(seen.exchanges.at(-1)?.ttl).toBe(120);
    expect(short.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(short.expiresAt).toBeGreaterThan(Date.now() + 100_000);
    expect(short.expiresIn).toBeGreaterThan(100_000);
    expect(short.expiresIn).toBeLessThanOrEqual(120_000);
    expect(claimsOf(short.token).exp).toBe(short.expiresAt);
    const visitorCap = (await session(makeHandler({}, { sessionTtlMs: 30_000 }), "user-a")).json();
    expect(visitorCap.expiresAt).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it("anonymous handlers ignore identity tokens and expose no link route", async () => {
    const h = createDeweeHandler({ gatewayUrl, token: GW_TOKEN, secret: VISITOR_SECRET, agents: ["support"], rateLimit: false });
    const withIds = await signVisitorToken(VISITOR_SECRET, { v: "visitor_123", exp: Date.now() + 60_000, ids: "idsess_x", ida: "support" });
    const r = await h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${withIds}` }, body: JSON.stringify({ message: "hi" }) }));
    expect(r.status).toBe(401);
    expect((await h(new Request(`${BASE}/link`, { method: "POST", body: "{}" }))).status).toBe(404);
    const cfg = await (await h(new Request(`${BASE}/config`))).json();
    expect(cfg).not.toHaveProperty("identity");
  });
});

describe("identity sessions: rebinding each request", () => {
  it("refuses A's token under B's cookie or no cookie, and accepts it under A's cookie", async () => {
    const h = makeHandler({ rebindEachRequest: true });
    const a = (await session(h, "user-a")).json();
    const asA = await chat(h, a.token, {}, "uid=user-a");
    expect(asA.status).toBe(200);
    expect(sse(asA.text).at(-1)).toMatchObject({ type: "done" });
    expect((await history(h, a.token, "uid=user-a")).status).toBe(200);
    for (const cookie of ["uid=user-b", undefined]) {
      const r = await chat(h, a.token, {}, cookie);
      expect(r.json()).toEqual({ error: { message: expect.any(String), code: "IDENTITY_REQUIRED", remediation: { action: "reauthenticate", audience: "end_user" } } });
      expect(r.status).toBe(401);
      expect((await history(h, a.token, cookie)).status).toBe(401);
      expect((await link(h, a.token, {}, cookie)).status).toBe(401);
    }
  });

  it("answers 503 when authenticate throws", async () => {
    const h = makeHandler({ rebindEachRequest: true });
    const a = (await session(h, "user-a")).json();
    const r = await quiet(() => chat(h, a.token, {}, "uid=boom"));
    expect([r.status, r.json().error.code]).toEqual([503, "SOURCE_UNAVAILABLE"]);
  });

  it("is off by default (see the isolation tests) and ignores anonymous visitors", async () => {
    const h = makeHandler({ rebindEachRequest: true });
    const anon = (await session(h)).json();
    expect((await chat(h, anon.token, {}, "uid=user-b")).status).toBe(200);
  });
});

describe("identity sessions: reuse and rate limits", () => {
  it("reuses one identity session per user until it nears expiry, and drops it once the gateway says it is dead", async () => {
    const h = makeHandler();
    const before = seen.exchanges.length;
    const first = (await session(h, "user-a")).json();
    const second = (await session(h, "user-a")).json();
    expect(seen.exchanges.length).toBe(before + 1);
    expect(await rawIds(second.token)).toBe(await rawIds(first.token));
    expiredSessions.add((await rawIds(first.token))!);
    expect((await chat(h, first.token)).status).toBe(401);
    const third = (await session(h, "user-a")).json();
    expect(seen.exchanges.length).toBe(before + 2);
    expect(await rawIds(third.token)).not.toBe(await rawIds(first.token));
  });

  it("re-exchanges a short session only near its end (min(60s, ttl/2))", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const h = makeHandler({ sessionTtlSeconds: 60 });
      const before = seen.exchanges.length;
      await session(h, "user-a");
      vi.setSystemTime(Date.now() + 20_000);
      await session(h, "user-a");
      expect(seen.exchanges.length).toBe(before + 1);
      vi.setSystemTime(Date.now() + 15_000); // 35 s in: inside the last 30 s
      await session(h, "user-a");
      expect(seen.exchanges.length).toBe(before + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("limits signed-in sessions per user, links per user, and returns a valid anonymous token without minting", async () => {
    const calls: Array<[string, RateLimitBucket]> = [];
    const h = makeHandler({}, { rateLimit: (key, bucket) => (calls.push([key, bucket]), true) });
    const a = (await session(h, "user-a")).json();
    expect(calls).toEqual([["unknown", "preauth"], ["subject:user-a", "verified"]]);
    calls.length = 0;
    expect((await link(h, a.token)).status).toBe(200);
    expect(calls).toEqual([[`visitor:${a.visitorId}`, "link"]]);
    calls.length = 0;
    const anon = (await session(h)).json();
    expect(calls.map(([, b]) => b)).toEqual(["preauth", "session"]);
    calls.length = 0;
    const again = (await session(h, undefined, { token: anon.token })).json();
    expect(again).toEqual({ visitorId: anon.visitorId, token: anon.token, expiresAt: anon.expiresAt });
    expect(calls).toEqual([["unknown", "preauth"]]);
  });

  it("caps authenticate calls per IP before running it, on /session and on rebinding", async () => {
    let authCalls = 0;
    const counted = async (req: Request) => (authCalls++, cookieUser(req));
    const h = makeHandler({ authenticate: counted, rebindEachRequest: true }, { rateLimit: undefined });
    const a = (await session(h, "user-a")).json();
    for (let i = 0; i < 118; i++) await session(h, undefined, { token: "x" });
    expect((await chat(h, a.token, {}, "uid=user-a")).status).toBe(200); // the 120th call
    const before = authCalls;
    const r = await chat(h, a.token, {}, "uid=user-a");
    expect([r.status, r.json().error.code]).toEqual([429, "rate_limited"]);
    expect((await session(h, "user-a")).status).toBe(429);
    expect(authCalls).toBe(before); // refused before authenticate ran
  });

  it("answers 429 once a user's signed-in session budget is spent", async () => {
    const h = makeHandler({}, { rateLimit: undefined });
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await session(h, "busy-user")).status;
    expect(last).toBe(429);
    expect((await session(h, "user-b")).status).toBe(200);
  });
});

describe("identity sessions: typed gateway errors", () => {
  it("forwards LINK_EXPIRED at connect as a typed 401 for chat and history", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    expiredSessions.add((await rawIds(a.token))!);
    const r = await chat(h, a.token);
    expect(r.status).toBe(401);
    expect(r.json()).toEqual({ error: { message: expect.any(String), code: "LINK_EXPIRED", remediation: { action: "reauthenticate", audience: "end_user" } } });
    const hist = await history(h, a.token);
    expect([hist.status, hist.json().error.code]).toEqual([401, "LINK_EXPIRED"]);
  });

  it("forwards an identity error raised during the run in the event stream", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    revokeDuringRun.add((await rawIds(a.token))!);
    const events = sse((await chat(h, a.token)).text);
    expect(events.at(-1)).toEqual({ type: "error", message: expect.any(String), code: "LINK_REVOKED", remediation: { action: "reauthenticate", audience: "end_user" } });
  });

  it("reads history as the session's user", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const r = await history(h, a.token);
    expect(r.json().messages[0].content).toMatch(/^history of tuc:/);
    expect(seen.connects.at(-1)).not.toHaveProperty("user_id");
  });
});

describe("web-first linking", () => {
  it("returns the proof code and the chat accounts to send it to", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const r = await link(h, a.token, { idempotencyKey: "req-1" });
    expect(r.status).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ proofCode: "482913", deepLinks: [{ channelType: "telegram", name: "acme-bot", displayName: "Acme Bot" }] });
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refuses visitors who are not signed in", async () => {
    const h = makeHandler();
    const anon = (await session(h)).json();
    const r = await link(h, anon.token);
    expect([r.status, r.json().error.code]).toEqual([401, "IDENTITY_REQUIRED"]);
  });

  it("maps the gateway's link conflicts and a switched-off gateway to their own codes", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const reused = await quiet(() => link(h, a.token, { idempotencyKey: "reused-key" }));
    expect([reused.status, reused.json().error.code]).toEqual([409, "idempotency_key_reused"]);
    const busy = await quiet(() => link(h, a.token, { idempotencyKey: "busy-key" }));
    expect([busy.status, busy.json().error.code]).toEqual([409, "link_in_progress"]);
    gw.linkDisabled = true;
    try {
      const off = await quiet(() => link(h, a.token));
      expect([off.status, off.json().error.code]).toEqual([503, "linking_unavailable"]);
    } finally {
      gw.linkDisabled = false;
    }
  });
});

describe("jwks applications", () => {
  it("signs with a private JWK", async () => {
    const h = makeHandler({ assertionSecret: undefined, privateKeyJwk: privateJwk });
    const s = await session(h, "user-c");
    expect(s.status).toBe(200);
    expect(s.json().verified).toBe(true);
  });
});

describe("widget client", () => {
  const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const config = { agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "t", identity: true };
  const done = () => new Response(`data: ${JSON.stringify({ type: "done", content: "ok" })}\n\n`, { headers: { "content-type": "text/event-stream" } });

  /** Runs `fn` with a fake backend; `route` answers each call by path. Returns the paths called. */
  async function withBackend(route: (path: string, n: number, init?: RequestInit) => Response, fn: (api: ApiClient) => Promise<void>, storage = new Map<string, string>()) {
    vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "https://site.test").pathname.split("/").pop()!;
      calls.push(path);
      if (path === "config") return json(200, config);
      return route(path, calls.filter((c) => c === path).length, init);
    }));
    try {
      await fn(new ApiClient({ endpoint: "/api/dewee" }));
    } finally {
      vi.unstubAllGlobals();
    }
    return calls;
  }

  const signedIn = (n: number, extra: Record<string, unknown> = {}) => json(200, { visitorId: "v_signed_in1", token: `tok${n}`, expiresAt: Date.now() + 3_600_000, verified: true, ...extra });

  it("re-requests /session on LINK_EXPIRED and keeps signed-in sessions out of storage", async () => {
    const storage = new Map<string, string>();
    const events: ChatStreamEvent[] = [];
    const calls = await withBackend((path, n, init) => {
      if (path === "session") return signedIn(n);
      if (path === "chat" && n === 1) return json(401, { error: { message: "expired", code: "LINK_EXPIRED", remediation: { action: "reauthenticate", audience: "end_user" } } });
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok2");
      return done();
    }, (api) => api.chat({ message: "hi", agent: "support", conversationId: "conv_ident1" }, (e) => events.push(e)), storage);
    expect(calls).toEqual(["config", "session", "chat", "session", "chat"]);
    expect(events).toEqual([{ type: "done", content: "ok" }]);
    expect([...storage.keys()]).toEqual([]);
  });

  it("renews the session after a LINK_REVOKED event in the stream", async () => {
    const calls = await withBackend((path, n) => {
      if (path === "session") return signedIn(n);
      return new Response(`data: ${JSON.stringify({ type: "error", message: "revoked", code: "LINK_REVOKED" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }, async (api) => {
      await api.chat({ message: "hi", agent: "support", conversationId: "conv_ident1" }, () => {});
      expect((await api.ensureSession()).token).toBe("tok2");
    });
    expect(calls).toEqual(["config", "session", "chat", "session"]);
  });

  it("renews an expired or revoked session once when starting a link", async () => {
    const calls = await withBackend((path, n, init) => {
      if (path === "session") return signedIn(n);
      if (n === 1) return json(401, { error: { message: "revoked", code: "LINK_REVOKED" } });
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok2");
      return json(200, { proofCode: "482913", expiresAt: Date.now() + 600_000, deepLinks: [] });
    }, async (api) => {
      expect((await api.link()).proofCode).toBe("482913");
    });
    expect(calls).toEqual(["config", "session", "link", "session", "link"]);
  });

  it("refreshes a signed-in session from expiresIn, counted from receipt, not from a skewed expiresAt", async () => {
    const calls = await withBackend((path, n) => {
      // The browser clock is ahead: expiresAt already looks past, but the session has 90 s left.
      if (path === "session") return signedIn(n, { expiresAt: Date.now() - 5_000, expiresIn: 90_000 });
      return done();
    }, async (api) => {
      await api.chat({ message: "1", agent: "support", conversationId: "conv_ident1" }, () => {});
      await api.chat({ message: "2", agent: "support", conversationId: "conv_ident1" }, () => {});
    });
    expect(calls.filter((c) => c === "session")).toHaveLength(1);
  });

  it("has localized copy for every identity and link error", () => {
    for (const locale of ["en", "vi"]) {
      const s = pickStrings(locale);
      for (const code of ["IDENTITY_REQUIRED", "IDENTITY_LINK_REQUIRED", "IDENTITY_CONFLICT", "LINK_EXPIRED", "LINK_REVOKED", "PERMISSION_DENIED", "SOURCE_UNAVAILABLE"] as const) {
        expect(s.identityErrors[code]).toBeTruthy();
      }
      for (const code of ["idempotency_key_reused", "link_in_progress", "linking_unavailable"] as const) expect(s.linkErrors[code]).toBeTruthy();
    }
    expect(pickStrings("vi").identityErrors.LINK_EXPIRED).not.toBe(pickStrings("en").identityErrors.LINK_EXPIRED);
  });
});

describe("secret hygiene", () => {
  it("never sends the gateway token, assertion secret, visitor secret, private key or a raw identity session to a browser", () => {
    expect(browserBodies.length).toBeGreaterThan(40);
    const all = browserBodies.join("\n");
    for (const secret of [GW_TOKEN, ASSERTION_SECRET, VISITOR_SECRET, privateJwk.d]) expect(all).not.toContain(secret);
    const issued = seen.exchanges.map((e) => e.token).filter((t): t is string => !!t);
    expect(issued.length).toBeGreaterThan(10);
    for (const token of issued) expect(all).not.toContain(token);
  });
});
