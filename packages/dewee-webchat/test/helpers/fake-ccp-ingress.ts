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
  /** The body exactly as it arrived, to compare request bytes. */
  raw: string;
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
  /** Conversations by `${actor}|${conversationId}`. Tests may add staff or system turns (`author_kind`). */
  conversations: Map<string, Array<{ role: string; content: string; thinking?: string; tool_calls?: unknown[]; author_kind?: string; [extra: string]: unknown }>>;
  /** Human takeover control by `${actor}|${conversationId}`; absent = the agent answers. */
  control: Map<string, "agent" | "waiting_human" | "human_active">;
  /** Whether a staff member is on duty when a visitor asks for a person. */
  staffOnDuty: boolean;
  /** Chat streams some text, then ends with `chat.stopped` (a person took the conversation over mid-run). */
  stopMidRun: boolean;
  edgeTtlSeconds: number;
  credentialCard?: Record<string, unknown>;
  credentialHandoffUrl?: string;
  /** The install check nonce the control plane accepts: a `session` carrying it as `check` answers `check: true`. */
  checkNonce?: string;
  /** Request kinds the workspace offers; listed in `config` only to a host advertising `work-requests`. */
  workRequestKinds: Array<{ kind: string; title: string; schema: "callback" | "generic"; staffed_now: boolean }>;
  /** Stored work requests by requester actor, oldest first. */
  workRequests: Map<string, FakeWorkRequest[]>;
  /**
   * The next create that stores a request (or replays one) fails after storing it: `drop` closes the
   * connection without an answer, `unknown` answers `503 work_request_outcome_unknown`. Consumed once.
   */
  workRequestFault?: "drop" | "unknown";
}

/** A stored work request: its visitor view plus what idempotency is judged on. */
export interface FakeWorkRequest {
  key: string;
  /** kind, payload, summary and conversation, as the runtime hashes them. */
  content: string;
  view: { code: string; kind: string; summary: string; state: string; received_at: string; respond_due_at: string; due_timezone: string; public_note: string; contact_hint: string; updated_at: string };
}

/** Builds the stored view's code: `WR-` plus 8 Crockford base32 characters. */
function workRequestCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return "WR-" + Array.from(randomBytes(8), (b) => alphabet[b & 31]).join("");
}

/** The runtime's callback schema check (`internal/workrequest/payload.go`); returns the field at fault. */
function callbackFault(p: Record<string, unknown>): string | null {
  if (Object.keys(p).some((k) => !["contact_method", "contact_value", "purpose", "consent", "preferred_time"].includes(k))) return "payload";
  const method = typeof p.contact_method === "string" ? p.contact_method.trim().toLowerCase() : "";
  const value = typeof p.contact_value === "string" ? p.contact_value.trim() : "";
  if (method === "phone" || method === "zalo") {
    const digits = value.replace(/[^0-9]/g, "").length;
    if (!/^\+?[0-9][0-9 ().-]*$/.test(value) || value.length > 32 || digits < 6 || digits > 15) return "payload.contact_value";
  } else if (method === "email") {
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value)) return "payload.contact_value";
  } else return "payload.contact_method";
  if (typeof p.purpose !== "string" || !p.purpose.trim() || [...p.purpose.trim()].length > 500) return "payload.purpose";
  if (p.consent !== true) return "payload.consent";
  return null;
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
  /** Staff work one request: changes its state or public note, nothing else. */
  updateWorkRequest(code: string, patch: { state?: string; public_note?: string }): void;
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
    control: new Map(),
    staffOnDuty: true,
    stopMidRun: false,
    edgeTtlSeconds: 3600,
    workRequestKinds: [],
    workRequests: new Map(),
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
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
      body = chunks.length ? JSON.parse(raw) : undefined;
    } catch {
      return error(res, 400, "invalid_request");
    }
    const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : `?${url.pathname}`;
    const rec: Recorded = { route, method: req.method ?? "", headers: { ...req.headers }, body, raw };
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
    // `X-Dewee-Webchat-Features`: comma-separated, case-insensitive host capabilities (contract §1.2).
    const features = String(req.headers["x-dewee-webchat-features"] ?? "").split(",").map((t) => t.trim().toLowerCase());
    const workRequestFeature = features.includes("work-requests");
    if (route === "config") {
      // Listed only to a host that declared work-requests, and only when the workspace offers a kind.
      const kinds = workRequestFeature && state.workRequestKinds.length ? { work_requests: state.workRequestKinds } : {};
      return send(res, 200, { ...state.config, ...kinds });
    }
    if (route === "session") {
      const checked = state.checkNonce !== undefined && body?.check === state.checkNonce ? { check: true } : {};
      const prev = req.headers["x-dewee-webchat-session"] as string | undefined;
      if (prev) {
        const e = readEdge(prev, true);
        if (typeof e === "string") return error(res, 401, "ingress_session_invalid");
        return send(res, 200, { session: mintEdge(e.vis, state.edgeTtlSeconds), visitor_id: e.vis, expires_in: state.edgeTtlSeconds, ...checked });
      }
      const vis = body?.visitor_id ?? randomBytes(16).toString("base64url");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(vis)) return error(res, 400, "invalid_request");
      return send(res, 200, { session: mintEdge(vis, state.edgeTtlSeconds), visitor_id: vis, expires_in: state.edgeTtlSeconds, expires_at: new Date(Date.now() + state.edgeTtlSeconds * 1000).toISOString(), ...checked });
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

    const credentialFeature = features.includes("credential-requests");
    const handoffFeature = features.includes("human-handoff");

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
      const held = state.control.get(key);
      if (held && held !== "agent") return send(res, 202, { held: true, control: held });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform" });
      const frame = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      frame({ type: "start", runId: "run-42", conversationId: body.conversation_id, agent });
      res.write(": ping\n\n");
      if (state.stopMidRun) {
        frame({ type: "delta", text: "partial agent text" });
        frame({ type: "error", code: "cancelled", message: "stopped: staff accepted case 0193" });
        return res.end();
      }
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
      if (state.credentialCard && actor.startsWith("tuc:") && credentialFeature) frame({ type: "credential_request", credential_request: state.credentialCard });
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
      const control = state.control.get(`${actor}|${body?.conversation_id}`) ?? "agent";
      return send(res, 200, { conversation_id: body.conversation_id, messages: [...conv, { role: "tool", content: "raw tool output" }], control, ...(state.credentialCard && actor.startsWith("tuc:") && credentialFeature ? { credential_requests: [state.credentialCard] } : {}) });
    }
    if (route === "request-human") {
      if (!handoffFeature) return error(res, 403, "PERMISSION_DENIED", "human_handoff_unavailable for tenant 0193");
      const key = `${actor}|${body?.conversation_id}`;
      const conv = state.conversations.get(key);
      if (!conv) return error(res, 404, "not_found");
      const current = state.control.get(key);
      if (current && current !== "agent") return send(res, 200, { case_id: "case_0193_internal", control: current, staff_on_duty: true });
      const control = state.staffOnDuty ? "waiting_human" : "agent";
      state.control.set(key, control);
      conv.push({ role: "assistant", content: state.staffOnDuty ? "A support staff member will join shortly." : "Nobody is on duty right now. Please leave your contact details.", author_kind: "system" });
      return send(res, 200, { case_id: "case_0193_internal", control, staff_on_duty: state.staffOnDuty });
    }
    if (route === "work-requests/create" || route === "work-requests/list") {
      if (!workRequestFeature) return error(res, 403, "work_requests_unavailable");
      const mine = state.workRequests.get(actor) ?? [];
      // Fields the runtime keeps from the visitor; a host must drop them before the browser sees a view.
      const leak = { assignee: "staff_0193@shop.example", internal_note: "VIP, call before 5pm", payload: { contact_value: "leaked-contact" } };
      if (route === "work-requests/list") {
        const limit = body?.limit ?? 50;
        if (body?.limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return error(res, 400, "invalid_request");
        const found = mine.filter((r) => (!body?.idempotency_key || r.key === body.idempotency_key) && (!body?.conversation_id || JSON.parse(r.content)[3] === body.conversation_id));
        return send(res, 200, { work_requests: found.reverse().slice(0, limit).map((r) => ({ ...r.view, ...leak })) });
      }
      const key = body?.idempotency_key;
      if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return error(res, 400, "invalid_request");
      const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
      if (!summary) return error(res, 400, "invalid_request");
      if ([...summary].length > 500) return error(res, 413, "message_too_large");
      const payload = body?.payload ?? {};
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return error(res, 400, "invalid_request");
      const conversation = typeof body?.conversation_id === "string" ? body.conversation_id : "";
      const content = JSON.stringify([body.kind, payload, summary, conversation]);
      // A retry of a stored request is answered from the stored row, even if the kind is no longer offered.
      const stored = mine.find((r) => r.key === key);
      let answer: { status: number; record: FakeWorkRequest };
      if (stored) {
        if (stored.content !== content) return error(res, 409, "idempotency_conflict");
        answer = { status: 200, record: stored };
      } else {
        const kind = state.workRequestKinds.find((k) => k.kind === body?.kind);
        if (!kind) return error(res, 403, "work_requests_unavailable");
        if (conversation && !state.conversations.has(`${actor}|${conversation}`)) return error(res, 404, "not_found");
        const fault = kind.schema === "callback" ? callbackFault(payload) : Object.values(payload).every((v) => typeof v === "string") ? null : "payload";
        if (fault) return error(res, 400, "invalid_request", "invalid field", { details: { field: fault } });
        const now = new Date().toISOString();
        const contact = kind.schema === "callback" ? String(payload.contact_value).trim() : "";
        const record: FakeWorkRequest = {
          key,
          content,
          view: { code: workRequestCode(), kind: kind.kind, summary, state: "received", received_at: now, respond_due_at: new Date(Date.now() + 4 * 3600_000).toISOString(), due_timezone: "Asia/Ho_Chi_Minh", public_note: "", contact_hint: contact ? `***${contact.slice(-3)}` : "", updated_at: now },
        };
        state.workRequests.set(actor, [...mine, record]);
        answer = { status: 201, record };
      }
      const fault = state.workRequestFault;
      state.workRequestFault = undefined;
      if (fault === "drop") return void res.destroy();
      if (fault === "unknown") return error(res, 503, "work_request_outcome_unknown", "commit failed on runtime postgres://internal-db", { retry_after_seconds: 5 });
      return send(res, answer.status, { work_request: { ...answer.record.view, ...leak }, replayed: answer.status === 200 });
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
      if (!actor.startsWith("tuc:") || !credentialFeature || !state.credentialCard || !state.conversations.has(`${actor}|${body?.conversation_id}`) || body?.credential_request_id !== state.credentialCard.id) return error(res, 404, "credential_request_not_found");
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
      state.control.clear();
      state.staffOnDuty = true;
      state.stopMidRun = false;
      state.checkNonce = undefined;
      state.workRequestKinds = [];
      state.workRequests.clear();
      state.workRequestFault = undefined;
    },
    routes: (name) => seen.filter((r) => r.route === name),
    updateWorkRequest(code, patch) {
      for (const list of state.workRequests.values()) {
        const found = list.find((r) => r.view.code === code);
        if (found) {
          found.view = { ...found.view, ...patch, updated_at: new Date().toISOString() };
          return;
        }
      }
      throw new Error(`no work request ${code}`);
    },
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
