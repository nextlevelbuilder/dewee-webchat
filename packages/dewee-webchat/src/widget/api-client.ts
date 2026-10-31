// Browser client for the dewee-webchat backend HTTP contract.
import { parseJobAccessLaunch, type JobAccessLaunch } from "../job-access";
import {
  HEADER_GATEWAY_TOKEN,
  HEADER_GATEWAY_URL,
  type ChatRequestBody,
  type ChatStreamEvent,
  type HistoryMessage,
  type LinkResponse,
  type PublicConfig,
  type Remediation,
  type SessionResponse,
} from "../protocol";

/** Identity errors after which the signed-in session is dropped and `/session` is requested again. */
const RENEW_CODES = new Set(["LINK_EXPIRED", "LINK_REVOKED"]);
/** Signed-in sessions live minutes to hours: refresh this long before expiry, at most half the lifetime. */
const VERIFIED_REFRESH_MS = 60_000;

/** Extra request headers: a static map, or a function evaluated before every request. */
export type RequestHeadersOption =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

/**
 * Headers the widget owns; `headers` cannot override them (compared case-insensitively). The
 * session bearer token, signed-in or anonymous, travels in `authorization`.
 */
export const RESERVED_HEADERS: readonly string[] = ["content-type", "authorization", HEADER_GATEWAY_URL, HEADER_GATEWAY_TOKEN];

/** A session as held by the client: `obtainedAt` is the browser time it was received. */
type HeldSession = SessionResponse & { obtainedAt?: number };

export interface ApiClientOptions {
  /** Backend base URL, e.g. "/api/dewee" or "https://example.com/api/dewee". */
  endpoint: string;
  /** Bring-your-own gateway credentials (only if the backend allows it). */
  gatewayUrl?: string;
  gatewayToken?: string;
  /** Called when the backend requires a Turnstile challenge; must resolve to a token. */
  turnstile?: (siteKey: string) => Promise<string>;
  /** Extra headers merged into every request (reserved headers excluded). */
  headers?: RequestHeadersOption;
  /** Replaces `globalThis.fetch` for every request. */
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  /** `retryAfterMs`: how long to wait before sending again (`RATE_LIMITED`). */
  constructor(message: string, public status: number, public code?: string, public remediation?: Remediation, public retryAfterMs?: number) {
    super(message);
  }
}

/** Cooldown of a refused request: the body's `retryAfterMs`, else the `Retry-After` header (seconds). */
function retryAfterOf(bodyMs: unknown, res: Response): number | undefined {
  if (typeof bodyMs === "number" && Number.isFinite(bodyMs) && bodyMs > 0) return bodyMs;
  const header = Number(res.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
}

const storage = (pick: () => Storage) => ({
  get(k: string): string | null { try { return pick().getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { pick().setItem(k, v); } catch { /* storage blocked */ } },
  del(k: string) { try { pick().removeItem(k); } catch { /* storage blocked */ } },
});
/** The anonymous visitor session, kept across visits. */
const store = storage(() => localStorage);
/**
 * The reuse hint of this tab's last signed-in session (`SessionResponse.reuseHint`), present only
 * when the backend sends one (ccp transport). It is not a bearer token: the backend accepts it only at
 * `/session`, for the user it authenticates then. Requests use the session `/session` returned.
 */
const tabStore = storage(() => sessionStorage);

export class ApiClient {
  private session: HeldSession | null = null;
  private config: PublicConfig | null = null;
  private sessionPromise: Promise<SessionResponse> | null = null;

  constructor(private o: ApiClientOptions) {}

  private url(action: string, qs?: Record<string, string>): string {
    const base = this.o.endpoint.replace(/\/+$/, "");
    const q = qs ? "?" + new URLSearchParams(qs).toString() : "";
    return `${base}/${action}${q}`;
  }

  private get storageKey(): string {
    return `dewee-webchat:session:${this.o.endpoint}`;
  }

  private get reuseKey(): string {
    return `dewee-webchat:reuse:${this.o.endpoint}`;
  }

  /**
   * The tab's reuse hint for signed-in sessions, or null (none sent by this backend). A logout page can
   * send it to the backend's logout route, whose `handler.revoke(subject, request, hint)` then ends
   * exactly that session.
   */
  reuseHint(): string | null {
    return tabStore.get(this.reuseKey);
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    return (this.o.fetch ?? globalThis.fetch)(url, init);
  }

  private async headers(auth = false): Promise<Record<string, string>> {
    const h: Record<string, string> = {};
    const extra = typeof this.o.headers === "function" ? await this.o.headers() : this.o.headers;
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (typeof v === "string" && !RESERVED_HEADERS.includes(k.toLowerCase())) h[k.toLowerCase()] = v;
    }
    h["content-type"] = "application/json";
    if (this.o.gatewayUrl && this.o.gatewayToken) {
      h[HEADER_GATEWAY_URL] = this.o.gatewayUrl;
      h[HEADER_GATEWAY_TOKEN] = this.o.gatewayToken;
    }
    if (auth) {
      // Read the token only after the host headers resolved: a renewSession() during that await
      // clears the session, and the request must carry the renewed one, never none or a stale one.
      const s = this.session && this.fresh(this.session) ? this.session : await this.ensureSession();
      h.authorization = `Bearer ${s.token}`;
    }
    return h;
  }

  private async parse<T>(res: Response): Promise<T> {
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const r = body?.error?.remediation;
      const remediation = r && typeof r.action === "string" && typeof r.audience === "string" ? { action: r.action, audience: r.audience } : undefined;
      throw new ApiError(body?.error?.message || `HTTP ${res.status}`, res.status, body?.error?.code, remediation, retryAfterOf(body?.error?.retryAfterMs, res));
    }
    return body as T;
  }

  async getConfig(force = false): Promise<PublicConfig> {
    if (this.config && !force) return this.config;
    this.config = await this.parse<PublicConfig>(await this.request(this.url("config"), { headers: await this.headers() }));
    return this.config;
  }

  /** When each signed-in session should be refreshed, on this browser's clock. */
  private refreshAt = new WeakMap<SessionResponse, number>();

  /**
   * Session reuse. A signed-in session follows its schedule (see `scheduleRefresh`). An anonymous
   * token is refreshed once less than 10% of its lifetime (at most 24 h, at least 30 s) remains; a
   * stored token from before `obtainedAt` existed uses the 24 h margin. When the backend reports the
   * lifetime (`expiresIn`), it is counted from receipt, so a skewed browser clock does not matter.
   */
  private fresh(s: HeldSession): boolean {
    if (s.verified) return Date.now() < (this.refreshAt.get(s) ?? 0);
    const reported = typeof s.expiresIn === "number" && s.expiresIn >= 0 && s.obtainedAt;
    const end = reported ? s.obtainedAt! + s.expiresIn! : s.expiresAt;
    const lifetime = reported ? s.expiresIn! : s.obtainedAt ? s.expiresAt - s.obtainedAt : Infinity;
    const margin = Math.min(86_400_000, Math.max(30_000, lifetime * 0.1));
    return end - Date.now() > margin;
  }

  /**
   * A signed-in session is refreshed `min(60s, lifetime/2)` before it ends, with the lifetime the
   * backend reports (`expiresIn`) counted from receipt, so a short lifetime is not refreshed on every
   * request and a skewed browser clock does not matter.
   */
  private scheduleRefresh(s: HeldSession, now: number): void {
    const life = typeof s.expiresIn === "number" && s.expiresIn > 0 ? s.expiresIn : s.expiresAt - now;
    this.refreshAt.set(s, now + life - Math.min(VERIFIED_REFRESH_MS, life / 2));
  }

  /** The stored anonymous visitor session, if any. Signed-in sessions are never stored. */
  private stored(): HeldSession | null {
    const saved = store.get(this.storageKey);
    if (!saved) return null;
    try {
      const s = JSON.parse(saved) as HeldSession;
      return s.verified ? null : s;
    } catch {
      return null; // corrupted entry
    }
  }

  /** Returns a valid visitor session, creating or refreshing it when needed. */
  ensureSession(): Promise<SessionResponse> {
    if (this.session && this.fresh(this.session)) return Promise.resolve(this.session);
    return (this.sessionPromise ??= this.loadSession().finally(() => (this.sessionPromise = null)));
  }

  private async loadSession(): Promise<SessionResponse> {
    if (!this.session) {
      const s = this.stored();
      if (s) {
        // A backend that signs users in decides who the visitor is on every page load: the
        // stored anonymous token only seeds the visitor id when the user is not signed in.
        if (this.fresh(s) && !(await this.getConfig()).identity) return (this.session = s);
        this.session = s; // close to expiry: refresh below, keeping the same visitor id
      }
    }
    return this.createSession();
  }

  private async createSession(): Promise<SessionResponse> {
    const cfg = await this.getConfig();
    const body: Record<string, string> = {};
    const previous = this.session && !this.session.verified ? this.session : this.stored();
    if (previous?.token) body.token = previous.token;
    if (cfg.identity) {
      const hint = this.session?.verified ? this.session.reuseHint : tabStore.get(this.reuseKey);
      if (hint) body.reuseHint = hint;
    }
    const post = async () =>
      this.parse<SessionResponse>(await this.request(this.url("session"), { method: "POST", headers: await this.headers(), body: JSON.stringify(body) }));
    const challenge = async () => {
      if (!this.o.turnstile) throw new ApiError("Verification is required but no Turnstile handler is set", 403, "turnstile_required");
      body.turnstileToken = await this.o.turnstile(cfg.turnstileSiteKey!);
    };
    let s: SessionResponse;
    try {
      // A returning anonymous visitor refreshes without a challenge when the backend says it needs
      // none; should it ask for one anyway (turnstile_failed), it gets it on the retry. A backend that
      // signs users in may turn the same refresh into a sign-in, which is always challenged.
      if (cfg.turnstileSiteKey && !(cfg.refreshWithoutTurnstile && !cfg.identity && body.token && !body.reuseHint)) await challenge();
      try {
        s = await post();
      } catch (e) {
        if (!(cfg.turnstileSiteKey && !body.turnstileToken && e instanceof ApiError && e.code === "turnstile_failed")) throw e;
        await challenge();
        s = await post();
      }
    } catch (e) {
      // Nobody is signed in (or sign-in is required): the hint has no user left to serve.
      if (e instanceof ApiError && e.status === 401) tabStore.del(this.reuseKey);
      throw e;
    }
    // obtainedAt lets fresh() size the refresh margin to the server's token lifetime.
    const now = Date.now();
    const held: HeldSession = { ...s, obtainedAt: now };
    this.session = held;
    // A signed-in session is used from memory only: the next page load asks the backend again, so a
    // sign-out or a different user never inherits it. Only its reuse hint, when the backend sent one,
    // stays in the tab; the bearer token is never stored.
    if (held.verified) {
      this.scheduleRefresh(held, now);
      if (typeof held.reuseHint === "string" && held.reuseHint !== "") tabStore.set(this.reuseKey, held.reuseHint);
      else tabStore.del(this.reuseKey);
    } else {
      tabStore.del(this.reuseKey);
      const { reuseHint: _none, ...anonymous } = held;
      store.set(this.storageKey, JSON.stringify(anonymous));
    }
    return held;
  }

  /** Drops the session; the next request creates a new one. A stored anonymous visitor is kept for a signed-in session. */
  forgetSession(): void {
    if (this.session?.verified) {
      // Refused by the backend: never offered again as a reuse hint.
      tabStore.del(this.reuseKey);
      this.session = null;
      return;
    }
    this.session = null;
    store.del(this.storageKey);
  }

  /**
   * Asks the backend for a new session now (after a sign-in or sign-out on the host page). The
   * stored anonymous visitor id is kept, so an anonymous visitor's history survives.
   */
  async renewSession(): Promise<SessionResponse> {
    this.session = null;
    return this.ensureSession();
  }

  /** Requests a single-use launch ticket. Does not refresh or swap the signed-in session after refusal. */
  async jobAccess(signal: AbortSignal): Promise<JobAccessLaunch> {
    try {
      const session = await this.ensureSession();
      if (!session.verified) throw new ApiError("Sign in to open job access", 401, "IDENTITY_REQUIRED");
      if (signal.aborted) throw new ApiError("Job access was cancelled", 0, "job_access_unavailable");
      const response = await this.request(this.url("job-access"), {
        method: "POST", headers: await this.headers(true), body: "{}", signal, redirect: "error",
      });
      return parseJobAccessLaunch(await this.parse<unknown>(response));
    } catch (error) {
      const code = error instanceof ApiError && typeof error.code === "string" &&
        ["IDENTITY_REQUIRED", "LINK_EXPIRED", "LINK_REVOKED", "PERMISSION_DENIED", "SOURCE_UNAVAILABLE"].includes(error.code)
        ? error.code : "job_access_unavailable";
      throw new ApiError("Job access is unavailable. Sign in again or retry.", error instanceof ApiError ? error.status : 0, code);
    }
  }

  /** Starts a web-first link of a chat account for the signed-in user (identity backends only). */
  async link(): Promise<LinkResponse> {
    const res = await this.signedInRequest(async () =>
      this.request(this.url("link"), { method: "POST", headers: await this.headers(true), body: "{}" }),
    );
    return this.parse<LinkResponse>(res);
  }

  async history(agent: string, conversationId: string): Promise<HistoryMessage[]> {
    const res = await this.signedInRequest(async () =>
      this.request(this.url("history", { agent, conversationId }), { headers: await this.headers(true) }),
    );
    return (await this.parse<{ messages: HistoryMessage[] }>(res)).messages;
  }

  /**
   * Sends a request with the current session. A signed-in session the backend refuses (expired,
   * revoked, or another user signed in) is dropped and renewed once, as chat() does. An anonymous
   * visitor's 401 is final, and its stored visitor is kept.
   */
  private async signedInRequest(send: () => Promise<Response>): Promise<Response> {
    await this.ensureSession();
    const res = await send();
    if (res.status !== 401 || !this.session?.verified) return res;
    this.forgetSession();
    await this.ensureSession();
    return send();
  }

  /** Sends a message and calls `onEvent` for every streamed event. Resolves when the run ends. */
  async chat(
    input: ChatRequestBody & { agent: string; conversationId: string },
    onEvent: (e: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureSession();
    let res = await this.request(this.url("chat"), { method: "POST", headers: await this.headers(true), body: JSON.stringify(input), signal });
    if (res.status === 401) {
      this.forgetSession();
      await this.ensureSession();
      res = await this.request(this.url("chat"), { method: "POST", headers: await this.headers(true), body: JSON.stringify(input), signal });
    }
    if (!res.ok || !res.body) await this.parse(res);

    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let renew = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let event: ChatStreamEvent;
        try { event = JSON.parse(data) as ChatStreamEvent; } catch { continue; /* malformed frame */ }
        if (event.type === "error" && event.code && RENEW_CODES.has(event.code)) renew = true;
        try { onEvent(event); } catch { /* a failing listener never breaks the stream */ }
      }
    }
    // The signed-in session ended during the run: ask /session again so the next message uses a fresh one.
    if (renew && this.session?.verified) {
      this.forgetSession();
      await this.ensureSession().catch(() => { /* reported on the next message */ });
    }
  }
}
