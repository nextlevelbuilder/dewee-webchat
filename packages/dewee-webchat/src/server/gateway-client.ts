// Minimal Dewee gateway WebSocket RPC client (protocol v3).
// Runs on Cloudflare Workers (fetch upgrade) and on any runtime with a global WebSocket
// (Node >= 22, Bun, Deno, Workers with the WebSocket constructor).
import type { AgentInfo, ChatStreamEvent, HistoryMessage, Remediation, ToolCallView } from "../protocol";
import { stripPageBlock } from "../actions/page-block";

export interface GatewayCredentials {
  /** Gateway runtime origin, e.g. https://gateway.example.com */
  url: string;
  /** Gateway token or operator API key. Never sent to browsers. */
  token: string;
  /** Optional tenant id/slug for multi-tenant gateways. */
  tenantId?: string;
}

/**
 * Who a connection acts as: a gateway user id chosen by this server (anonymous visitors), or a Dewee
 * identity session, in which case the gateway derives the user and no `user_id` is sent.
 */
export type GatewayActor = string | { identitySession: string };

interface Frame {
  type: "res" | "event";
  id?: string;
  ok?: boolean;
  payload?: any;
  error?: { code?: string; message?: string; details?: { remediation?: unknown } };
  event?: string;
}

type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, cb: (ev: any) => void): void;
};

export class GatewayError extends Error {
  constructor(message: string, public code?: string, public remediation?: Remediation) {
    super(message);
  }
}

function parseRemediation(raw: unknown): Remediation | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const { action, audience } = raw as Record<string, unknown>;
  return typeof action === "string" && typeof audience === "string" ? { action, audience } : undefined;
}

/** A user the gateway derived from an identity session: `tuc:<principal>`. */
function isIdentityUser(userId: unknown): boolean {
  return typeof userId === "string" && userId.startsWith("tuc:") && userId.length > 4;
}

function wsUrl(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = u.pathname.replace(/\/$/, "") + "/ws";
  return u.toString();
}

async function openSocket(base: string, timeoutMs: number): Promise<SocketLike> {
  // Cloudflare Workers: outbound WebSockets go through fetch() with an Upgrade header.
  if (typeof (globalThis as any).WebSocketPair !== "undefined") {
    const httpUrl = wsUrl(base).replace(/^ws/, "http");
    const res = await fetch(httpUrl, { headers: { Upgrade: "websocket" } });
    const ws = (res as any).webSocket;
    if (!ws) throw new GatewayError(`Gateway refused WebSocket upgrade (HTTP ${res.status})`, "upgrade_failed");
    ws.accept();
    return ws;
  }
  const WS = (globalThis as any).WebSocket;
  if (!WS) throw new GatewayError("No WebSocket implementation available (Node >= 22 required)", "no_websocket");
  const ws = new WS(wsUrl(base));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new GatewayError("Gateway connection timed out", "timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new GatewayError("Gateway connection failed", "connect_failed")); });
  });
  return ws;
}

/** One authenticated gateway connection. Short-lived: one per chat turn or lookup. */
export class GatewayConnection {
  private seq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(event: string, payload: any) => void>();
  private closed = false;

  private constructor(private ws: SocketLike) {
    ws.addEventListener("message", (ev: any) => this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data)));
    ws.addEventListener("close", () => this.fail(new GatewayError("Gateway connection closed", "closed")));
    ws.addEventListener("error", () => this.fail(new GatewayError("Gateway connection error", "socket_error")));
  }

  static async connect(creds: GatewayCredentials, actor: GatewayActor, timeoutMs = 15000): Promise<GatewayConnection> {
    const conn = new GatewayConnection(await openSocket(creds.url, timeoutMs));
    const params: Record<string, string> =
      typeof actor === "string" ? { token: creds.token, user_id: actor } : { token: creds.token, identity_session: actor.identitySession };
    if (creds.tenantId) params.tenant_id = creds.tenantId;
    try {
      const res = await conn.call<{ user_id?: unknown } | undefined>("connect", params, timeoutMs);
      // Fail closed: a gateway that did not apply the identity session (identity switched off, or a
      // replica that failed to start it) would otherwise run the turn as the operator token's own user.
      if (typeof actor !== "string" && !isIdentityUser(res?.user_id)) {
        throw new GatewayError("Gateway did not apply the identity session", "SOURCE_UNAVAILABLE", { action: "retry_later", audience: "operator" });
      }
    } catch (e) {
      conn.close();
      throw e;
    }
    return conn;
  }

  call<T = any>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new GatewayError("Gateway connection closed", "closed"));
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) timer = setTimeout(() => { this.pending.delete(id); reject(new GatewayError(`${method} timed out`, "timeout")); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  onEvent(cb: (event: string, payload: any) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(1000, "done"); } catch { /* already closed */ }
    this.fail(new GatewayError("Gateway connection closed", "closed"));
  }

  private onMessage(raw: string): void {
    let frame: Frame;
    try { frame = JSON.parse(raw); } catch { return; }
    if (frame.type === "res" && frame.id && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.payload);
      else p.reject(new GatewayError(frame.error?.message || "Gateway request failed", frame.error?.code, parseRemediation(frame.error?.details?.remediation)));
    } else if (frame.type === "event" && frame.event) {
      for (const cb of this.listeners) cb(frame.event, frame.payload);
    }
  }

  private fail(err: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

export function buildSessionKey(agent: string, conversationId: string): string {
  return `agent:${agent}:ws:direct:${conversationId}`;
}

export interface StreamChatOptions {
  creds: GatewayCredentials;
  /** Gateway user id (anonymous visitors). Ignored when `identitySession` or `connection` is set. */
  userId?: string;
  /** Dewee identity session: the gateway derives the user; no `user_id` is sent. */
  identitySession?: string;
  /** An already connected connection to use (and close) instead of opening one. */
  connection?: GatewayConnection;
  agent: string;
  sessionKey: string;
  message: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function actorOf(opts: { userId?: string; identitySession?: string }): GatewayActor {
  if (opts.identitySession) return { identitySession: opts.identitySession };
  if (opts.userId) return opts.userId;
  throw new GatewayError("A user id or an identity session is required", "invalid_actor");
}

/** Runs one chat turn and yields normalized stream events until the run ends. */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<ChatStreamEvent> {
  const conn = opts.connection ?? (await GatewayConnection.connect(opts.creds, actorOf(opts)));
  const queue: ChatStreamEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const push = (e: ChatStreamEvent) => { queue.push(e); wake?.(); };
  const end = () => { finished = true; wake?.(); };

  const off = conn.onEvent((event, payload) => {
    if (event !== "agent" || !payload) return;
    const key = payload.visibleSessionKey || payload.sessionKey;
    if (key && key !== opts.sessionKey && payload.runSessionKey !== opts.sessionKey) return;
    const p = payload.payload || {};
    switch (payload.type) {
      case "run.started": push({ type: "start", runId: payload.runId, conversationId: "", agent: opts.agent }); break;
      case "thinking": if (p.content) push({ type: "thinking", text: p.content }); break;
      case "chunk": if (p.content) push({ type: "delta", text: p.content }); break;
      case "tool.call": push({ type: "tool_call", id: p.id || "", name: p.name || "tool", arguments: p.arguments }); break;
      case "tool.result": push({ type: "tool_result", id: p.id || "", name: p.name || "tool", isError: !!p.is_error, result: clip(p.result ?? p.content) }); break;
      case "run.failed": push({ type: "error", message: p.error || p.message || "Agent run failed", code: "run_failed" }); end(); break;
      case "run.cancelled": push({ type: "error", message: "Run cancelled", code: "cancelled" }); end(); break;
    }
  });

  const onAbort = () => {
    conn.call("chat.abort", { sessionKey: opts.sessionKey }, 3000).catch(() => {}).finally(() => conn.close());
    end();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  conn
    .call("chat.send", { agentId: opts.agent, sessionKey: opts.sessionKey, message: opts.message, stream: true }, opts.timeoutMs ?? 180000)
    .then((res) => { push({ type: "done", content: res?.content ?? "", usage: res?.usage }); end(); })
    .catch((err: GatewayError) => {
      if (!finished) push(err.remediation ? { type: "error", message: err.message, code: err.code, remediation: err.remediation } : { type: "error", message: err.message, code: err.code });
      end();
    });

  try {
    while (true) {
      if (queue.length) { yield queue.shift()!; continue; }
      if (finished) break;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  } finally {
    off();
    opts.signal?.removeEventListener("abort", onAbort);
    conn.close();
  }
}

function clip(v: unknown, max = 4000): string | undefined {
  if (v == null) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Fetches a session transcript and folds tool calls/results into assistant turns. */
export async function fetchHistory(creds: GatewayCredentials, actor: GatewayActor, agent: string, sessionKey: string): Promise<HistoryMessage[]> {
  const conn = await GatewayConnection.connect(creds, actor);
  try {
    const res = await conn.call<{ messages?: any[] }>("chat.history", { agentId: agent, sessionKey }, 15000);
    return foldHistory(res?.messages ?? []);
  } finally {
    conn.close();
  }
}

export function foldHistory(raw: any[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  let current: HistoryMessage | null = null;
  for (const m of raw) {
    if (m.role === "user") {
      current = null;
      out.push({ role: "user", content: stripPageBlock(String(m.content ?? "")), createdAt: m.created_at });
    } else if (m.role === "assistant") {
      if (!current) {
        current = { role: "assistant", content: "", createdAt: m.created_at };
        out.push(current);
      }
      if (m.thinking) current.thinking = (current.thinking ? current.thinking + "\n\n" : "") + m.thinking;
      if (m.content) current.content = current.content ? `${current.content}\n\n${m.content}` : String(m.content);
      for (const tc of m.tool_calls ?? []) {
        const view: ToolCallView = { id: tc.id, name: tc.name ?? tc.function?.name ?? "tool", arguments: tc.arguments ?? tc.function?.arguments, status: "done" };
        (current.toolCalls ??= []).push(view);
      }
    } else if (m.role === "tool" && current?.toolCalls) {
      const tc = current.toolCalls.find((t) => t.id === m.tool_call_id);
      if (tc) {
        tc.result = clip(m.content);
        if (m.is_error) { tc.isError = true; tc.status = "error"; }
      }
    }
  }
  return out.filter((m) => m.role === "user" || m.content || m.toolCalls?.length);
}

/** Lists agents via the gateway REST API. */
export async function listAgents(creds: GatewayCredentials): Promise<AgentInfo[]> {
  // Ownerless operator API keys must name a user; "system" sees every agent of the tenant.
  const headers: Record<string, string> = { Authorization: `Bearer ${creds.token}`, "X-GoClaw-User-Id": "system" };
  if (creds.tenantId) headers["X-GoClaw-Tenant-Id"] = creds.tenantId;
  const res = await fetch(creds.url.replace(/\/$/, "") + "/v1/agents", { headers });
  if (!res.ok) throw new GatewayError(`Listing agents failed (HTTP ${res.status})`, "agents_failed");
  const body: any = await res.json();
  return (body.agents ?? [])
    .filter((a: any) => !a.status || a.status === "active")
    .map((a: any) => ({ id: a.agent_key || a.id, name: a.display_name || a.agent_key || a.id }));
}
