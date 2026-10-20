// Browser client for the dewee-webchat backend HTTP contract.
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
/** Refresh margin of anonymous visitor tokens (they live 30 days). */
const ANON_REFRESH_MS = 86_400_000;
/** Signed-in sessions live minutes to hours: refresh this long before expiry, at most half the lifetime. */
const VERIFIED_REFRESH_MS = 60_000;

export interface ApiClientOptions {
  /** Backend base URL, e.g. "/api/dewee" or "https://example.com/api/dewee". */
  endpoint: string;
  /** Bring-your-own gateway credentials (only if the backend allows it). */
  gatewayUrl?: string;
  gatewayToken?: string;
  /** Called when the backend requires a Turnstile challenge; must resolve to a token. */
  turnstile?: (siteKey: string) => Promise<string>;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public remediation?: Remediation) {
    super(message);
  }
}

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};

export class ApiClient {
  private session: SessionResponse | null = null;
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

  private headers(auth = false): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.o.gatewayUrl && this.o.gatewayToken) {
      h[HEADER_GATEWAY_URL] = this.o.gatewayUrl;
      h[HEADER_GATEWAY_TOKEN] = this.o.gatewayToken;
    }
    if (auth && this.session) h.authorization = `Bearer ${this.session.token}`;
    return h;
  }

  private async parse<T>(res: Response): Promise<T> {
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const r = body?.error?.remediation;
      const remediation = r && typeof r.action === "string" && typeof r.audience === "string" ? { action: r.action, audience: r.audience } : undefined;
      throw new ApiError(body?.error?.message || `HTTP ${res.status}`, res.status, body?.error?.code, remediation);
    }
    return body as T;
  }

  async getConfig(force = false): Promise<PublicConfig> {
    if (this.config && !force) return this.config;
    this.config = await this.parse<PublicConfig>(await fetch(this.url("config"), { headers: this.headers() }));
    return this.config;
  }

  /** When each signed-in session should be refreshed, on this browser's clock. */
  private refreshAt = new WeakMap<SessionResponse, number>();

  private fresh(s: SessionResponse): boolean {
    if (s.verified) return Date.now() < (this.refreshAt.get(s) ?? 0);
    return s.expiresAt - Date.now() > ANON_REFRESH_MS;
  }

  /**
   * A signed-in session is refreshed `min(60s, lifetime/2)` before it ends, with the lifetime the
   * backend reports (`expiresIn`) counted from receipt, so a short lifetime is not refreshed on every
   * request and a skewed browser clock does not matter.
   */
  private scheduleRefresh(s: SessionResponse): void {
    const now = Date.now();
    const life = typeof s.expiresIn === "number" && s.expiresIn > 0 ? s.expiresIn : s.expiresAt - now;
    this.refreshAt.set(s, now + life - Math.min(VERIFIED_REFRESH_MS, life / 2));
  }

  /** The stored anonymous visitor session, if any. Signed-in sessions are never stored. */
  private stored(): SessionResponse | null {
    const saved = store.get(this.storageKey);
    if (!saved) return null;
    try {
      const s = JSON.parse(saved) as SessionResponse;
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
    if (cfg.turnstileSiteKey) {
      if (!this.o.turnstile) throw new ApiError("Verification is required but no Turnstile handler is set", 403, "turnstile_required");
      body.turnstileToken = await this.o.turnstile(cfg.turnstileSiteKey);
    }
    const s = await this.parse<SessionResponse>(
      await fetch(this.url("session"), { method: "POST", headers: this.headers(), body: JSON.stringify(body) }),
    );
    this.session = s;
    // A signed-in session stays in memory only: the next page load asks the backend again, so a
    // sign-out or a different user never inherits it.
    if (s.verified) this.scheduleRefresh(s);
    else store.set(this.storageKey, JSON.stringify(s));
    return s;
  }

  /** Drops the session; the next request creates a new one. A stored anonymous visitor is kept for a signed-in session. */
  forgetSession(): void {
    if (this.session?.verified) {
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

  /** Starts a web-first link of a chat account for the signed-in user (identity backends only). */
  async link(): Promise<LinkResponse> {
    const res = await this.signedInRequest(() => fetch(this.url("link"), { method: "POST", headers: this.headers(true), body: "{}" }));
    return this.parse<LinkResponse>(res);
  }

  async history(agent: string, conversationId: string): Promise<HistoryMessage[]> {
    const res = await this.signedInRequest(() => fetch(this.url("history", { agent, conversationId }), { headers: this.headers(true) }));
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
    let res = await fetch(this.url("chat"), { method: "POST", headers: this.headers(true), body: JSON.stringify(input), signal });
    if (res.status === 401) {
      this.forgetSession();
      await this.ensureSession();
      res = await fetch(this.url("chat"), { method: "POST", headers: this.headers(true), body: JSON.stringify(input), signal });
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
