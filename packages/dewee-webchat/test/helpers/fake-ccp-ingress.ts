// A fake CCP public webchat ingress (contract "webchat-ingress.v1", §1) on a loopback port. It checks
// the integration secret and edge sessions the way CCP does, records every request it receives, and
// can be switched into failure modes (redirect, rate limit, revoked secret…) per test.
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const INTEGRATION_ID = "wci_abcdefghijklmnopqrstuvwxyz";
export const INTEGRATION_SECRET = `dwc_${"S".repeat(20)}NEVER-IN-BROWSER${"x".repeat(6)}`;
export const ASSERTION_SECRET = "assertion-secret-NEVER-IN-BROWSER-0000000001";
export const APP_ID = "8f0c6a2e-3b1d-4c5e-9a7f-1b2c3d4e5f60";
export const ISSUER = "https://host.example";
const EDGE_KEY = "edge-session-key-of-the-fake-ccp-000000000";

export interface Recorded {
  route: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
  closedEarly?: boolean;
}

export interface FakeCcpState {
  /** Secrets CCP accepts; empty = every call is `integration_unauthorized` (revoked). */
  secrets: Set<string>;
  config: Record<string, unknown>;
  /** Next call of these routes answers this error instead (consumed once per entry). */
  failNext: Map<string, { status: number; code: string; message?: string; retryAfter?: number; remediation?: unknown }>;
  /** Every chat answers with a redirect to this URL (credential-leak check). */
  redirectTo?: string;
  /** Chat emits frames CCP should have filtered (reasoning, tool arguments): checks the adapter drops them. */
  leaky: boolean;
  identitySessions: Map<string, { principal: string; agent: string; revoked: boolean }>;
  /** Conversations by `${actor}|${conversationId}`. */
  conversations: Map<string, Array<{ role: string; content: string; thinking?: string; tool_calls?: unknown[] }>>;
  edgeTtlSeconds: number;
  credentialCard?: Record<string, unknown>;
  credentialHandoffUrl?: string;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

export function mintEdge(vis: string, ttlSeconds: number, iid = INTEGRATION_ID): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = b64({ v: 1, iid, wid: "ws_1", vis, iat: now, exp: now + ttlSeconds });
  return `dws1.${claims}.${createHmac("sha256", EDGE_KEY).update(claims).digest("base64url")}`;
}

/** Verifies an edge session; `expiredOk` accepts one up to 24 h past expiry (refresh). */
function readEdge(token: string | undefined, expiredOk = false): { vis: string } | "invalid" | "expired" {
  if (!token?.startsWith("dws1.")) return "invalid";
  const [, claims, sig] = token.split(".");
  if (!claims || createHmac("sha256", EDGE_KEY).update(claims).digest("base64url") !== sig) return "invalid";
  const c = unb64(claims);
  if (c.iid !== INTEGRATION_ID) return "invalid";
  const now = Math.floor(Date.now() / 1000);
  if (c.exp < now && !(expiredOk && now - c.exp < 86400)) return "expired";
  return { vis: c.vis };
}

/** Checks a partner assertion (HS256) the way the runtime does. */
function verifyAssertion(jws: string): string | null {
  const [h, p, s] = jws.split(".");
  if (!h || !p || !s) return null;
  const header = unb64(h);
  const claims = unb64(p);
  if (header.alg !== "HS256" || header.typ !== "dewee-session+jwt") return null;
  if (createHmac("sha256", ASSERTION_SECRET).update(`${h}.${p}`).digest("base64url") !== s) return null;
  if (claims.aud !== `dewee:${APP_ID}` || claims.iss !== ISSUER) return null;
  return claims.sub;
}

export interface FakeCcp {
  url: string;
  origin: string;
  state: FakeCcpState;
  seen: Recorded[];
  reset(): void;
  close(): Promise<void>;
  routes(name: string): Recorded[];
}

const defaultConfig = () => ({
  integration: { id: INTEGRATION_ID, name: "Storefront chat" },
  agents: [
    { key: "shop", name: "Shop assistant", description: "Orders and products" },
    { key: "support", name: "Support" },
  ],
  default_agent_key: "shop",
  allow_agent_switch: true,
  mode: "anonymous",
  identity_enabled: false,
  show_thinking: false,
  show_tool_activity: false,
  max_message_chars: 4000,
  contract_version: "webchat-ingress.v1",
});

export async function startFakeCcp(): Promise<FakeCcp> {
  const seen: Recorded[] = [];
  const state: FakeCcpState = {
    secrets: new Set([INTEGRATION_SECRET]),
    config: defaultConfig(),
    failNext: new Map(),
    leaky: false,
    identitySessions: new Map(),
    conversations: new Map(),
    edgeTtlSeconds: 3600,
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const error = (res: ServerResponse, status: number, code: string, message = `${code} at runtime postgres://internal-db tenant 0193-secret`, extra: Record<string, unknown> = {}) =>
    send(res, status, { error: { code, message, ...extra } }, extra.retry_after_seconds ? { "retry-after": String(extra.retry_after_seconds) } : {});

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const prefix = `/api/public/webchat/v1/${INTEGRATION_ID}/`;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = undefined;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      return error(res, 400, "invalid_request");
    }
    const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : `?${url.pathname}`;
    const rec: Recorded = { route, method: req.method ?? "", headers: { ...req.headers }, body };
    seen.push(rec);
    res.on("close", () => {
      if (!res.writableFinished) rec.closedEarly = true;
    });

    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("Bearer ") || !state.secrets.has(auth.slice(7))) return error(res, 401, "integration_unauthorized");
    const injected = state.failNext.get(route);
    if (injected) {
      state.failNext.delete(route);
      const extra: Record<string, unknown> = {};
      if (injected.retryAfter) extra.retry_after_seconds = injected.retryAfter;
      if (injected.remediation) extra.remediation = injected.remediation;
      return error(res, injected.status, injected.code, injected.message, extra);
    }
    if (route === "config") return send(res, 200, state.config);
    if (route === "session") {
      const prev = req.headers["x-dewee-webchat-session"] as string | undefined;
      if (prev) {
        const e = readEdge(prev, true);
        if (typeof e === "string") return error(res, 401, "ingress_session_invalid");
        return send(res, 200, { session: mintEdge(e.vis, state.edgeTtlSeconds), visitor_id: e.vis, expires_in: state.edgeTtlSeconds });
      }
      const vis = body?.visitor_id ?? randomBytes(16).toString("base64url");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(vis)) return error(res, 400, "invalid_request");
      return send(res, 200, { session: mintEdge(vis, state.edgeTtlSeconds), visitor_id: vis, expires_in: state.edgeTtlSeconds, expires_at: new Date(Date.now() + state.edgeTtlSeconds * 1000).toISOString() });
    }
    const edge = readEdge(req.headers["x-dewee-webchat-session"] as string | undefined);
    if (edge === "invalid") return error(res, 401, "ingress_session_invalid");
    if (edge === "expired") return error(res, 401, "ingress_session_expired");
    const cfg = state.config as ReturnType<typeof defaultConfig>;
    const agent = body?.agent ?? cfg.default_agent_key;
    if (!cfg.agents.some((a) => a.key === agent)) return error(res, 403, "agent_not_allowed");
    if (body && ("agent_key" in body || "tenant_id" in body || "session_key" in body)) return error(res, 400, "invalid_request");

    // Actor: the verified identity session's principal, else the edge session's visitor.
    let actor = `wcv:${INTEGRATION_ID}:${edge.vis}`;
    if (route !== "identity/exchange" && body?.identity_session !== undefined) {
      const s = state.identitySessions.get(body.identity_session);
      if (!s) return error(res, 401, "IDENTITY_REQUIRED", "unknown", { remediation: { action: "reauthenticate", audience: "end_user" } });
      if (s.revoked) return error(res, 401, "LINK_REVOKED", "revoked", { remediation: { action: "reauthenticate", audience: "end_user" } });
      if (s.agent !== agent) return error(res, 409, "IDENTITY_CONFLICT", "other agent");
      actor = `tuc:${s.principal}`;
    } else if (cfg.mode === "signed_in_required" && route !== "identity/exchange") {
      return error(res, 401, "IDENTITY_REQUIRED", "sign in", { remediation: { action: "reauthenticate", audience: "end_user" } });
    }

    if (route === "chat") {
      if (state.redirectTo) {
        res.writeHead(307, { location: state.redirectTo });
        return res.end();
      }
      const message: string = body?.message ?? "";
      if (message.endsWith("busy")) return error(res, 409, "run_in_progress");
      const key = `${actor}|${body.conversation_id}`;
      const conv = state.conversations.get(key) ?? [];
      state.conversations.set(key, conv);
      conv.push({ role: "user", content: message });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform" });
      const frame = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      frame({ type: "start", runId: "run-42", conversationId: body.conversation_id, agent });
      res.write(": ping\n\n");
      if (message.endsWith("slow")) {
        frame({ type: "delta", text: "thinking about it" });
        return; // never finishes; the test aborts
      }
      if (message.endsWith("fail")) {
        frame({ type: "error", code: "run_failed", message: "provider exploded at https://runtime.internal:8443 tenant=0193" });
        return res.end();
      }
      if (message.endsWith("midlimit")) {
        frame({ type: "error", code: "rate_limited", message: "bucket wid=0193 exceeded at https://runtime.internal:8443" });
        return res.end();
      }
      if (message.endsWith("midrevoke")) {
        frame({ type: "error", code: "LINK_REVOKED", message: "revoked", remediation: { action: "reauthenticate", audience: "end_user" } });
        return res.end();
      }
      if (cfg.show_thinking || state.leaky) frame({ type: "thinking", text: "secret plan" });
      if (state.credentialCard && actor.startsWith("tuc:") && req.headers["x-dewee-webchat-features"] === "credential-requests") frame({ type: "credential_request", credential_request: state.credentialCard });
      if (cfg.show_tool_activity || state.leaky) {
        frame({ type: "tool_call", id: "t1", name: "search_products", arguments: { q: "internal" } });
        frame({ type: "tool_result", id: "t1", name: "search_products", isError: false, result: "internal rows" });
      }
      frame({ type: "unknown_frame", session_key: "agent:shop:webchat:direct:leak" });
      frame({ type: "delta", text: `hello ${actor.startsWith("tuc:") ? "member" : "visitor"}` });
      frame({ type: "done", content: `hello ${actor}`, usage: { total_tokens: 12, model: "gpt-internal" } });
      conv.push({ role: "assistant", content: `hello ${actor}`, thinking: "plan", tool_calls: [{ id: "t1", name: "search_products", status: "done", is_error: false, arguments: { q: "x" } }] });
      return res.end();
    }
    if (route === "history") {
      const conv = state.conversations.get(`${actor}|${body?.conversation_id}`);
      if (!conv) return error(res, 404, "not_found");
      return send(res, 200, { conversation_id: body.conversation_id, messages: [...conv, { role: "tool", content: "raw tool output" }], ...(state.credentialCard && actor.startsWith("tuc:") && req.headers["x-dewee-webchat-features"] === "credential-requests" ? { credential_requests: [state.credentialCard] } : {}) });
    }
    if (route === "abort") return send(res, 200, { aborted: true });
    if (route === "identity/exchange") {
      const sub = typeof body?.assertion === "string" ? verifyAssertion(body.assertion) : null;
      if (!sub) return error(res, 401, "IDENTITY_REQUIRED", "bad assertion", { remediation: { action: "reauthenticate", audience: "end_user" } });
      if (sub === "operator-problem") return error(res, 403, "PERMISSION_DENIED", "app misconfigured", { remediation: { action: "contact_admin", audience: "operator" } });
      const token = `idsess_${randomBytes(12).toString("hex")}`;
      const principal = createHmac("sha256", "p").update(sub).digest("hex").slice(0, 24);
      state.identitySessions.set(token, { principal, agent, revoked: false });
      const ttl = body.ttl_seconds ?? 3600;
      return send(res, 201, { identity_session: token, session_id: "s1", principal_ref: `pr_${principal}`, visitor_id: edge.vis, expires_at: new Date(Date.now() + ttl * 1000).toISOString() });
    }
    if (route === "identity/revoke") {
      const s = state.identitySessions.get(body?.identity_session);
      if (s) s.revoked = true;
      return send(res, 200, { revoked: true });
    }
    if (route === "identity/member-link-proof") {
      if (!actor.startsWith("tuc:") || !/^MEM-[A-Z2-7]{16}$/.test(body?.code ?? "")) return error(res, 400, "invalid_request");
      return send(res, 200, { state: "proved" });
    }
    if (route === "link") {
      // The real shape: `{channel, url}` per chat account (contract §1.8).
      return send(res, 201, { proof_code: "482913", expires_at: new Date(Date.now() + 600_000).toISOString(), deep_links: [{ channel: "telegram", url: "https://t.me/acme_bot?start=482913" }, { channel: "bad channel!", url: "https://x.example" }] });
    }
    if (route === "job-access") {
      return send(res, 200, { bootstrap_url: "https://access.example/identity/job-access/launch", launch_token: "one_time_ticket_0123456789", expires_at: new Date(Date.now() + 45_000).toISOString() });
    }
    if (["credential-request", "credential-request-handoff", "credential-request-cancel"].includes(route)) {
      if (!actor.startsWith("tuc:") || req.headers["x-dewee-webchat-features"] !== "credential-requests" || !state.credentialCard || !state.conversations.has(`${actor}|${body?.conversation_id}`) || body?.credential_request_id !== state.credentialCard.id) return error(res, 404, "credential_request_not_found");
      if (route === "credential-request-handoff") return send(res, 200, { credential_request_id: state.credentialCard.id, url: state.credentialHandoffUrl ?? "https://app.example/credential-requests/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expires_at: state.credentialCard.expires_at });
      return send(res, 200, { credential_request: { ...state.credentialCard, ...(route === "credential-request-cancel" ? { status: "cancelled" } : {}) } });
    }
    return error(res, 404, "not_found");
  }

  const server: Server = createServer((req, res) => void onRequest(req, res).catch(() => res.destroy()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/api/public/webchat/v1/${INTEGRATION_ID}`,
    origin,
    state,
    seen,
    reset() {
      seen.length = 0;
      state.secrets = new Set([INTEGRATION_SECRET]);
      state.config = defaultConfig();
      state.failNext.clear();
      state.redirectTo = undefined;
      state.leaky = false;
      state.edgeTtlSeconds = 3600;
      state.credentialCard = undefined;
      state.credentialHandoffUrl = undefined;
    },
    routes: (name) => seen.filter((r) => r.route === name),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A server that records whether anything reached it (the target of a refused redirect). */
export async function startTrap(): Promise<{ url: string; hits: Array<Record<string, unknown>>; close(): Promise<void> }> {
  const hits: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    hits.push({ ...req.headers });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/steal`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
