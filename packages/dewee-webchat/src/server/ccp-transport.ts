// `transport: "ccp"`: the handler-side glue between the browser contract (docs/http-contract.md,
// unchanged) and the CCP public webchat ingress (contract "webchat-ingress.v1").
//
// What stays in the website backend: visitor tokens, Turnstile, the in-process rate limits, origin
// checks, page actions and `identity.authenticate` / `rebindEachRequest`. What CCP and the runtime
// decide: which agents the integration may use, sign-in mode, whether reasoning and tool activity are
// shown, quotas, and every authorization of the visitor. Nothing CCP says is passed to a browser
// verbatim: events and errors are rebuilt from known fields with this module's own messages.
import { stripPageBlock } from "../actions/page-block";
import { parseJobAccessLaunch, type JobAccessLaunch } from "../job-access";
import { isAdmissionErrorCode, isIdentityErrorCode, type AdmissionErrorCode, type AgentInfo, type ChatStreamEvent, type HistoryMessage, type IdentityErrorCode, type LinkResponse, type Remediation, type ToolCallView } from "../protocol";
import { CcpClient, CcpError, knownRemediation, readSseJson, type CcpRequest, type CcpRoute } from "./ccp-client";
import { DEAD_SESSION_CODES, IDENTITY_ERRORS } from "./identity-errors";
import { admissionErrorEvent } from "./admission-errors";
import { sha256B64url } from "./security";
import type { DeweeIdentitySdk, IdentitySigner } from "./handler";

// Upstream JSON is read as `any` only inside the parsers of this module; every field is type-checked
// before it is used or forwarded.

/** Agent keys as the ingress accepts them: up to 100 characters, an alphanumeric first, no `:`. */
export const CCP_AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
/**
 * The ingress takes `Idempotency-Key` as 8 to 128 of `[A-Za-z0-9._:-]`, narrower than the browser
 * contract's 1 to 255 printable characters. Every key is hashed to one it accepts, so the same host key
 * always names the same request and two different keys never meet.
 */
export async function ccpIdempotencyKey(key: string): Promise<string> {
  return sha256B64url(key);
}
/** Visitor and conversation ids as the ingress accepts them. */
export const CCP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const EDGE_TOKEN_RE = /^dws1\.[A-Za-z0-9_.-]{1,1019}$/;
/** Longest identity session the visitor token can seal (matches `security.ts`). */
const MAX_IDENTITY_SESSION_LENGTH = 512;
const CONFIG_TTL_MS = 60_000;
/** An edge session this close to expiry is refreshed before use. */
const EDGE_MARGIN_MS = 30_000;
/**
 * `/session` hands out an edge session with at least this long left, refreshing one that is closer
 * to its end. The widget comes back for a new token once a tenth of the lifetime it was given
 * remains (six minutes of a one-hour edge session), so a token it receives always carries an edge
 * session that is still fresh when it next asks.
 */
export const EDGE_RESEAL_MS = 15 * 60_000;
const CHANNEL_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** CCP refreshes an expired edge session for at most this long after its expiry (contract §1.4). */
const EDGE_REFRESH_WINDOW_MS = 24 * 3600_000;
const MAX_CACHED_EDGES = 5000;

/** What the integration allows, from CCP `GET config`. */
export interface CcpConfig {
  agents: AgentInfo[];
  defaultAgent: string;
  allowAgentSwitch: boolean;
  mode: "anonymous" | "signed_in_optional" | "signed_in_required";
  identityEnabled: boolean;
  showThinking: boolean;
  showToolActivity: boolean;
  maxMessageChars: number;
}

/** Per browser request: what CCP is told about the visitor. */
export interface VisitorContext {
  visitorOrigin?: string;
  visitorIp?: string;
  requestId: string;
}

export interface EdgeSession {
  token: string;
  /** Epoch ms on this server's clock. */
  expiresAt: number;
}

/** A browser-safe error: what the handler answers when the ingress refuses or fails. */
export interface BrowserError {
  status: number;
  code: string;
  message: string;
  /** Set for identity codes: the handler answers them through its typed identity error. */
  identity?: IdentityErrorCode;
  remediation?: Remediation;
  retryAfterSeconds?: number;
  /**
   * Set when a message was refused for admission (`chat` only): the handler answers it typed, as the
   * legacy gateway's `POLICY_DENIED` / `RATE_LIMITED`, with `retryAfterMs` (raw; normalized there).
   */
  admission?: AdmissionErrorCode;
  retryAfterMs?: number;
}

const GENERIC_UNAVAILABLE: BrowserError = { status: 502, code: "gateway_error", message: "Dewee is unavailable, try again later" };

/**
 * Maps an ingress error (contract §1.3) to the browser contract. CCP's message is never forwarded;
 * failures the visitor cannot act on are logged for the operator (without secrets) and answered
 * generically.
 */
export function browserErrorFor(e: unknown, route: CcpRoute): BrowserError {
  if (!(e instanceof CcpError)) {
    console.error(`[dewee-webchat] ccp ${route} failed:`, (e as Error)?.name ?? "error");
    return GENERIC_UNAVAILABLE;
  }
  const log = (level: "warn" | "error", hint: string) => console[level](`[dewee-webchat] ccp ${route}: ${e.code} (HTTP ${e.status}) ${hint}`);
  if (isIdentityErrorCode(e.code)) return { status: IDENTITY_ERRORS[e.code].status, code: e.code, message: IDENTITY_ERRORS[e.code].message, identity: e.code, remediation: e.remediation };
  const retryAfterMs = e.retryAfterSeconds ? e.retryAfterSeconds * 1000 : undefined;
  // A refused message is an admission error, the same typed refusal the legacy gateway gives, so the
  // widget shows its cooldown or the refusal note. Other routes keep their own codes.
  if (route === "chat") {
    if (isAdmissionErrorCode(e.code)) return { status: e.code === "RATE_LIMITED" ? 429 : 403, code: e.code, message: "", admission: e.code, retryAfterMs };
    if (e.code === "rate_limited" || e.code === "concurrency_limited" || e.status === 429) return { status: 429, code: "RATE_LIMITED", message: "", admission: "RATE_LIMITED", retryAfterMs };
  }
  switch (e.code) {
    case "invalid_request":
      log("error", "- the ingress refused the request shape; check the dewee-webchat version");
      return { status: 400, code: "bad_request", message: "Invalid request" };
    case "integration_unauthorized":
      log("error", "- check DEWEE_WEBCHAT_INTEGRATION_SECRET (wrong, rotated past its overlap, or revoked) and DEWEE_CCP_CHAT_URL");
      return { status: 500, code: "not_configured", message: "Chat is not configured on this server" };
    case "integration_disabled":
    case "workspace_unavailable":
    case "agent_unavailable":
      log("error", "- the integration, its workspace or its agent is not active (see the CCP Website chat page)");
      return { status: 503, code: "unavailable", message: "Chat is unavailable right now, try again later" };
    case "agent_not_allowed":
      return { status: 403, code: "agent_not_allowed", message: "Agent not allowed" };
    case "origin_not_allowed":
      log("warn", "- the visitor origin is not in the integration's allowed sites");
      return { status: 403, code: "forbidden_origin", message: "Origin not allowed" };
    case "not_found":
      return { status: 404, code: "not_found", message: "Not found" };
    case "run_in_progress":
      return { status: 409, code: "run_in_progress", message: "Still answering the previous message" };
    case "message_too_large":
      return { status: 413, code: "too_long", message: "Message is too long" };
    case "rate_limited":
    case "concurrency_limited":
      return { status: 429, code: "rate_limited", message: "Too many messages, please wait a moment", retryAfterSeconds: e.retryAfterSeconds };
    case "idempotency_key_reused":
      return { status: 409, code: "idempotency_key_reused", message: "This idempotency key was already used for a different link request" };
    case "link_in_progress":
      return { status: 409, code: "link_in_progress", message: "A link is already in progress. Use its code or wait until it expires." };
    case "linking_unavailable":
      return { status: 503, code: "linking_unavailable", message: "Linking is not available right now" };
    case "ccp_redirect":
      log("error", "- refused to follow a redirect; DEWEE_CCP_CHAT_URL must be the final ingress URL");
      return GENERIC_UNAVAILABLE;
    case "ccp_timeout":
      log("error", "- CCP did not answer in time");
      return GENERIC_UNAVAILABLE;
    default:
      if (e.status === 429) return { status: 429, code: "rate_limited", message: "Too many messages, please wait a moment", retryAfterSeconds: e.retryAfterSeconds };
      log("error", "");
      return GENERIC_UNAVAILABLE;
  }
}

/** The SSE `error` event for a code a run ended with. Messages are this module's own. */
function streamError(code: unknown, remediation: unknown, retryAfterMs?: unknown): ChatStreamEvent {
  if (isIdentityErrorCode(code)) {
    const valid: Remediation | undefined = knownRemediation(remediation);
    return { type: "error", code, message: IDENTITY_ERRORS[code].message, ...(valid ? { remediation: valid } : {}) };
  }
  if (code === "cancelled") return { type: "error", code: "cancelled", message: "Cancelled" };
  // Rate and quota refusals during a run are the typed admission refusal, with the widget's cooldown.
  if (code === "rate_limited" || code === "concurrency_limited") return admissionErrorEvent("RATE_LIMITED", retryAfterMs);
  if (isAdmissionErrorCode(code)) return admissionErrorEvent(code, retryAfterMs);
  if (code === "run_failed") return { type: "error", code: "run_failed", message: "The agent could not answer, please try again" };
  return { type: "error", code: "gateway_error", message: "Dewee is unavailable, try again later" };
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);

function parseConfig(data: Record<string, any>): CcpConfig {
  const bad = (why: string): never => {
    throw new CcpError(200, "ccp_bad_response", `CCP config: ${why}`);
  };
  // The integration's allowed agents (`agents[]` + `default_agent_key`).
  const rawAgents: any[] = Array.isArray(data.agents) ? data.agents : [];
  const agents: AgentInfo[] = [];
  for (const a of rawAgents.slice(0, 50)) {
    const key = a?.key;
    if (typeof key !== "string" || !CCP_AGENT_RE.test(key) || agents.some((x) => x.id === key)) continue;
    const name = str(a.name, 200);
    const description = str(a.description, 1000);
    agents.push({ id: key, ...(name ? { name } : {}), ...(description ? { description } : {}) });
  }
  if (!agents.length) bad("no agent");
  const def = typeof data.default_agent_key === "string" && agents.some((a) => a.id === data.default_agent_key) ? data.default_agent_key : agents[0].id;
  const mode = data.mode === "signed_in_optional" || data.mode === "signed_in_required" ? data.mode : "anonymous";
  const max = Number(data.max_message_chars);
  return {
    agents,
    defaultAgent: def,
    // Without the flag, switching follows the number of agents.
    allowAgentSwitch: typeof data.allow_agent_switch === "boolean" ? data.allow_agent_switch && agents.length > 1 : agents.length > 1,
    mode,
    identityEnabled: data.identity_enabled === true,
    // Reasoning and tool activity stay hidden unless the integration turns them on explicitly.
    showThinking: data.show_thinking === true,
    showToolActivity: data.show_tool_activity === true,
    maxMessageChars: Number.isInteger(max) && max > 0 ? max : Number.POSITIVE_INFINITY,
  };
}

function numericUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 32)) if (typeof v === "number" && Number.isFinite(v) && /^[a-z0-9_]{1,64}$/i.test(k)) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

export interface CcpIdentityDeps {
  createAssertion: NonNullable<DeweeIdentitySdk["createAssertion"]>;
  signer(): IdentitySigner;
  ttlSeconds?: number;
}

export interface CcpExchangeResult {
  sessionToken: string;
  principalRef: string;
  expiresAt: Date;
}

export type CcpTransport = ReturnType<typeof createCcpTransport>;

export function createCcpTransport(client: CcpClient, identity?: CcpIdentityDeps) {
  let config: { value: CcpConfig; at: number } | undefined;
  let pendingConfig: Promise<CcpConfig> | undefined;
  const edges = new Map<string, EdgeSession>();

  /** The integration's config, cached for a minute (failures are not cached). */
  async function getConfig(): Promise<CcpConfig> {
    if (config && Date.now() - config.at < CONFIG_TTL_MS) return config.value;
    pendingConfig ??= client
      .json("config")
      .then((data) => {
        const value = parseConfig(data);
        config = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        pendingConfig = undefined;
      });
    return pendingConfig;
  }

  function remember(visitorId: string, edge: EdgeSession): EdgeSession {
    edges.delete(visitorId);
    edges.set(visitorId, edge);
    if (edges.size > MAX_CACHED_EDGES) {
      const now = Date.now();
      for (const [k, v] of edges) if (now - v.expiresAt > EDGE_REFRESH_WINDOW_MS) edges.delete(k);
      for (const k of edges.keys()) {
        if (edges.size <= MAX_CACHED_EDGES) break;
        edges.delete(k);
      }
    }
    return edge;
  }

  const base = (ctx: VisitorContext): CcpRequest => ({ visitorOrigin: ctx.visitorOrigin, visitorIp: ctx.visitorIp, requestId: ctx.requestId });

  /** `POST session`: creates an edge session for the visitor, or refreshes `previous` (the visitor is kept). */
  async function openEdge(ctx: VisitorContext, visitorId: string, previous?: string): Promise<EdgeSession> {
    const data = await client.json<Record<string, unknown>>("session", { ...base(ctx), body: previous ? {} : { visitor_id: visitorId }, session: previous });
    const token = data.session;
    if (typeof token !== "string" || !EDGE_TOKEN_RE.test(token)) throw new CcpError(200, "ccp_bad_response", "CCP session: no edge session token");
    if (data.visitor_id !== undefined && data.visitor_id !== visitorId) throw new CcpError(200, "ccp_bad_response", "CCP session: visitor mismatch");
    // Lifetime from receipt on this server's clock; the absolute expiry is not trusted across clocks.
    const seconds = Number(data.expires_in);
    const lifetime = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, EDGE_REFRESH_WINDOW_MS) : 3600_000;
    return remember(visitorId, { token, expiresAt: Date.now() + lifetime });
  }

  /**
   * A usable edge session: cached, sealed in the visitor token, refreshed, or new. One with no more
   * than `minRemainingMs` left is refreshed (while CCP still accepts it) instead of used.
   */
  async function edgeFor(ctx: VisitorContext, visitorId: string, sealed?: EdgeSession, force?: "refresh" | "create", minRemainingMs = EDGE_MARGIN_MS): Promise<EdgeSession> {
    const now = Date.now();
    const cached = edges.get(visitorId);
    const known = [cached, sealed].filter((e): e is EdgeSession => !!e).sort((a, b) => b.expiresAt - a.expiresAt)[0];
    if (!force && known && known.expiresAt - now > minRemainingMs) return known;
    if (force !== "create" && known && now - known.expiresAt < EDGE_REFRESH_WINDOW_MS - EDGE_MARGIN_MS) {
      try {
        return await openEdge(ctx, visitorId, known.token);
      } catch (e) {
        if (!(e instanceof CcpError && (e.code === "ingress_session_invalid" || e.code === "ingress_session_expired"))) throw e;
      }
    }
    return openEdge(ctx, visitorId);
  }

  /**
   * Runs one ingress call with an edge session. On `ingress_session_expired` the session is refreshed
   * and on `ingress_session_invalid` a new one is opened, then the call is retried once. Both errors
   * are JSON answers before any stream opens, so the retry never repeats a turn.
   */
  async function withEdge<T>(ctx: VisitorContext, visitorId: string, sealed: EdgeSession | undefined, call: (edge: EdgeSession) => Promise<T>): Promise<T> {
    const edge = await edgeFor(ctx, visitorId, sealed);
    try {
      return await call(edge);
    } catch (e) {
      if (!(e instanceof CcpError)) throw e;
      if (e.code === "ingress_session_expired") return call(await edgeFor(ctx, visitorId, edge, "refresh"));
      if (e.code === "ingress_session_invalid") {
        edges.delete(visitorId);
        return call(await edgeFor(ctx, visitorId, undefined, "create"));
      }
      throw e;
    }
  }

  const withAgent = (agent: string | undefined) => (agent ? { agent } : {});

  return {
    config: getConfig,
    edgeFor,

    /** Starts a turn. Resolves once CCP accepted it (2xx, SSE); refusals reject with {@link CcpError}. */
    async startChat(
      ctx: VisitorContext,
      visitorId: string,
      sealed: EdgeSession | undefined,
      input: { message: string; conversationId: string; agent?: string; identitySession?: string; signal: AbortSignal },
    ): Promise<Response> {
      const body = {
        message: input.message,
        conversation_id: input.conversationId,
        ...withAgent(input.agent),
        ...(input.identitySession ? { identity_session: input.identitySession } : {}),
      };
      return withEdge(ctx, visitorId, sealed, (edge) => client.send("chat", { ...base(ctx), body, session: edge.token, accept: "text/event-stream", signal: input.signal }));
    },

    /**
     * Browser events of an accepted turn: exactly one `start` first and exactly one terminal event
     * (`done` or `error`) last. Reasoning and tool frames pass only when the integration shows them,
     * tool arguments and results never; unknown frames are dropped.
     */
    async *chatEvents(res: Response, cfg: CcpConfig, conversationId: string, requestedAgent: string): AsyncGenerator<ChatStreamEvent> {
      let started = false;
      const start = (f?: any): ChatStreamEvent => {
        started = true;
        const agent = typeof f?.agent === "string" && CCP_AGENT_RE.test(f.agent) ? f.agent : requestedAgent;
        const runId = typeof f?.runId === "string" && f.runId.length <= 128 ? f.runId : undefined;
        return { type: "start", conversationId, agent, ...(runId ? { runId } : {}) };
      };
      if (!res.body) {
        yield start();
        yield streamError("gateway_error", undefined);
        return;
      }
      for await (const f of readSseJson(res.body) as AsyncGenerator<any>) {
        if (!f || typeof f !== "object") continue;
        if (f.type === "start") {
          if (!started) yield start(f);
          continue;
        }
        if (!started) yield start();
        switch (f.type) {
          case "delta":
            if (typeof f.text === "string") yield { type: "delta", text: f.text };
            break;
          case "thinking":
            if (cfg.showThinking && typeof f.text === "string") yield { type: "thinking", text: f.text };
            break;
          case "tool_call":
            if (cfg.showToolActivity && typeof f.id === "string" && typeof f.name === "string") yield { type: "tool_call", id: f.id.slice(0, 128), name: f.name.slice(0, 128) };
            break;
          case "tool_result":
            if (cfg.showToolActivity && typeof f.id === "string" && typeof f.name === "string") yield { type: "tool_result", id: f.id.slice(0, 128), name: f.name.slice(0, 128), isError: f.isError === true };
            break;
          case "done": {
            const usage = numericUsage(f.usage);
            yield { type: "done", content: typeof f.content === "string" ? f.content : "", ...(usage ? { usage } : {}) };
            return;
          }
          case "error":
            yield streamError(f.code, f.remediation, f.retryAfterMs ?? (typeof f.retry_after_seconds === "number" ? f.retry_after_seconds * 1000 : undefined));
            return;
          default:
            break; // unknown frames are dropped
        }
      }
      if (!started) yield start();
      yield streamError("gateway_error", undefined); // the stream ended without a terminal event
    },

    /** Best-effort `POST abort` after the browser went away mid-turn. Never throws. */
    async abort(ctx: VisitorContext, visitorId: string, sealed: EdgeSession | undefined, input: { conversationId: string; runId?: string; agent?: string; identitySession?: string }): Promise<void> {
      const body = {
        conversation_id: input.conversationId,
        ...(input.runId ? { run_id: input.runId } : {}),
        ...withAgent(input.agent),
        ...(input.identitySession ? { identity_session: input.identitySession } : {}),
      };
      await withEdge(ctx, visitorId, sealed, (edge) => client.json("abort", { ...base(ctx), body, session: edge.token, signal: AbortSignal.timeout(5000) })).catch(() => {});
    },

    /** The visitor's own conversation, folded for the widget. An unknown or foreign conversation is empty. */
    async history(ctx: VisitorContext, visitorId: string, sealed: EdgeSession | undefined, input: { conversationId: string; agent?: string; identitySession?: string }): Promise<HistoryMessage[]> {
      const cfg = await getConfig();
      const body = {
        conversation_id: input.conversationId,
        limit: 50,
        ...withAgent(input.agent),
        ...(input.identitySession ? { identity_session: input.identitySession } : {}),
      };
      let data: Record<string, any>;
      try {
        data = await withEdge(ctx, visitorId, sealed, (edge) => client.json("history", { ...base(ctx), body, session: edge.token }));
      } catch (e) {
        if (e instanceof CcpError && e.code === "not_found") return [];
        throw e;
      }
      const out: HistoryMessage[] = [];
      for (const m of Array.isArray(data.messages) ? data.messages.slice(0, 200) : []) {
        if (m?.role !== "user" && m?.role !== "assistant") continue;
        const content = typeof m.content === "string" ? (m.role === "user" ? stripPageBlock(m.content) : m.content) : "";
        const msg: HistoryMessage = { role: m.role, content };
        if (cfg.showThinking && typeof m.thinking === "string" && m.thinking) msg.thinking = m.thinking;
        if (cfg.showToolActivity && Array.isArray(m.tool_calls)) {
          const calls: ToolCallView[] = [];
          for (const t of m.tool_calls.slice(0, 64)) {
            if (typeof t?.id !== "string" || typeof t?.name !== "string") continue;
            const status = t.status === "running" || t.status === "error" ? t.status : "done";
            calls.push({ id: t.id.slice(0, 128), name: t.name.slice(0, 128), status, isError: t.is_error === true });
          }
          if (calls.length) msg.toolCalls = calls;
        }
        if (typeof m.created_at === "string") msg.createdAt = m.created_at.slice(0, 64);
        if (!msg.content && !msg.thinking && !msg.toolCalls) continue;
        out.push(msg);
      }
      return out;
    },

    /**
     * Signs a partner assertion for `subject` and exchanges it at CCP for an identity session. `sealed`
     * is the user's edge session from an earlier token, refreshed rather than replaced when stale.
     */
    async exchange(ctx: VisitorContext, visitorId: string, subject: string, agent?: string, sealed?: EdgeSession): Promise<CcpExchangeResult> {
      if (!identity) throw new Error("identity is not configured");
      const assertion = await identity.createAssertion({ ...identity.signer(), purpose: "session", subject });
      const body = { assertion, ...(identity.ttlSeconds ? { ttl_seconds: identity.ttlSeconds } : {}), ...withAgent(agent) };
      const data = await withEdge(ctx, visitorId, sealed, (edge) => client.json<Record<string, unknown>>("identity/exchange", { ...base(ctx), body, session: edge.token }));
      const token = data.identity_session;
      const principal = data.principal_ref;
      const expiresAt = new Date(String(data.expires_at));
      if (typeof token !== "string" || token === "" || token.length > MAX_IDENTITY_SESSION_LENGTH) throw new CcpError(201, "ccp_bad_response", "CCP identity exchange: no usable identity session");
      if (typeof principal !== "string" || principal === "") throw new CcpError(201, "ccp_bad_response", "CCP identity exchange: no principal");
      return { sessionToken: token, principalRef: principal, expiresAt };
    },

    /** Best-effort `POST identity/revoke` (the user signed out or switched). Never throws. */
    async revoke(ctx: VisitorContext, visitorId: string, sealed: EdgeSession | undefined, identitySession: string, agent?: string): Promise<void> {
      await withEdge(ctx, visitorId, sealed, (edge) => client.json("identity/revoke", { ...base(ctx), body: { identity_session: identitySession, ...withAgent(agent) }, session: edge.token, signal: AbortSignal.timeout(5000) })).catch((e) => {
        if (e instanceof CcpError && DEAD_SESSION_CODES.has(e.code)) return; // already dead: nothing to revoke
        console.warn("[dewee-webchat] ccp identity/revoke failed:", e instanceof CcpError ? e.code : (e as Error)?.name);
      });
    },

    /** One-time hosted-page launch, with the original session kept server-side. */
    async jobAccess(ctx: VisitorContext, visitorId: string, sealed: EdgeSession | undefined, input: { identitySession: string; agent: string }): Promise<JobAccessLaunch> {
      const data = await withEdge(ctx, visitorId, sealed, (edge) => client.json<unknown>("job-access", {
        ...base(ctx), session: edge.token, body: { identity_session: input.identitySession, agent: input.agent },
      }));
      try {
        const launch = parseJobAccessLaunch(data);
        if (launch.launch_token === input.identitySession) throw new Error("Invalid launch ticket");
        return launch;
      } catch { throw new CcpError(502, "ccp_bad_response", "Job access is unavailable"); }
    },

    /** Web-first link for a signed-in visitor. */
    async link(ctx: VisitorContext, visitorId: string, sealed: EdgeSession | undefined, input: { identitySession: string; agent?: string; idempotencyKey?: string }): Promise<LinkResponse> {
      const body = { identity_session: input.identitySession, ...withAgent(input.agent) };
      const idempotencyKey = input.idempotencyKey === undefined ? undefined : await ccpIdempotencyKey(input.idempotencyKey);
      const data = await withEdge(ctx, visitorId, sealed, (edge) => client.json<Record<string, any>>("link", { ...base(ctx), body, session: edge.token, idempotencyKey }));
      if (typeof data.proof_code !== "string" || data.proof_code === "") throw new CcpError(201, "ccp_bad_response", "CCP link: no proof code");
      const expires = Date.parse(String(data.expires_at));
      // CCP names each chat account by its channel (`{channel, url}`); the browser shape has no URL,
      // so the channel is also its name.
      const deepLinks = (Array.isArray(data.deep_links) ? data.deep_links.slice(0, 20) : [])
        .map((t: any) => (typeof t?.channel === "string" && CHANNEL_RE.test(t.channel) ? { channelType: t.channel, channelInstanceId: "", name: t.channel } : null))
        .filter((t: unknown): t is LinkResponse["deepLinks"][number] => t !== null);
      return { proofCode: data.proof_code.slice(0, 64), expiresAt: Number.isFinite(expires) ? expires : Date.now() + 600_000, deepLinks };
    },

    /** Drops a cached identity session's dependents when CCP reports it dead. */
    isDeadSessionCode: (code: unknown) => typeof code === "string" && DEAD_SESSION_CODES.has(code),
  };
}
