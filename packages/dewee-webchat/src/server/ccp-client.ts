// HTTP + SSE client for the CCP-managed public webchat ingress
// (`{CCP}/api/public/webchat/v1/{integrationId}/…`, contract "webchat-ingress.v1").
//
// Server-to-server only. The integration secret is sent to exactly one origin, the one of the
// configured chat URL: every request URL is built from that base plus a fixed route name, and a
// redirect is never followed (it is refused as an error instead), so the secret cannot be carried to
// another origin. Nothing a visitor sends ever becomes part of a URL.

/** Routes of the public ingress this client calls. Fixed names: callers cannot inject path segments. */
export type CcpRoute = "config" | "session" | "chat" | "history" | "abort" | "identity/exchange" | "identity/revoke" | "link" | "job-access";

/** Validated CCP endpoint options (see {@link parseCcpOptions}). */
export interface CcpOptions {
  /**
   * The full ingress base the CCP "Website chat" page prints as `DEWEE_CCP_CHAT_URL`, e.g.
   * `https://app.dewee.sh/api/public/webchat/v1/wci_…`. Must be https, except plain http to a
   * loopback host (`localhost`, `127.0.0.1`, `[::1]`) for local development.
   */
  chatUrl: string;
  /** `DEWEE_WEBCHAT_INTEGRATION_ID` (`wci_…`); must equal the id at the end of `chatUrl`. */
  integrationId: string;
  /** `DEWEE_WEBCHAT_INTEGRATION_SECRET` (`dwc_…`). Server-only; never sent to a browser or another origin. */
  integrationSecret: string;
  /** Custom fetch (tests, instrumented hosts). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const INTEGRATION_ID_RE = /^wci_[a-z2-7]{26}$/;
const SECRET_RE = /^dwc_[A-Za-z0-9_-]{16,256}$/;
const INGRESS_PATH_RE = /\/api\/public\/webchat\/v1\/(wci_[a-z2-7]{26})$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Longest wait for one JSON call (headers and body); a hung ingress must not hold requests forever. */
export const CCP_JSON_TIMEOUT_MS = 15_000;

/** Remediation values of the identity contract; anything else from CCP is dropped before it can reach a browser. */
const REMEDIATION_ACTIONS = new Set(["send_connect_link", "ask_user_to_dm", "retry_later", "contact_admin", "reauthenticate"]);
const REMEDIATION_AUDIENCES = new Set(["end_user", "operator", "integrator"]);

/** A remediation CCP sent, kept only when both fields are known values. */
export function knownRemediation(raw: unknown): { action: string; audience: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { action, audience } = raw as { action?: unknown; audience?: unknown };
  return typeof action === "string" && typeof audience === "string" && REMEDIATION_ACTIONS.has(action) && REMEDIATION_AUDIENCES.has(audience) ? { action, audience } : undefined;
}

/**
 * The caller's signal combined with a deadline. A timer (not `AbortSignal.timeout`) so that the
 * deadline can be cleared as soon as the call is done and never keeps a process alive.
 */
function withDeadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut(): boolean; dispose(): void } {
  const ctl = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    ctl.abort(new DOMException("CCP request timed out", "TimeoutError"));
  }, ms);
  const onAbort = () => ctl.abort(signal?.reason);
  if (signal?.aborted) ctl.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: ctl.signal,
    timedOut: () => fired && !signal?.aborted,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Throws a startup error naming what is wrong. Never echoes the secret. */
export function parseCcpOptions(raw: Partial<CcpOptions> | undefined): Required<Omit<CcpOptions, "fetch">> & { fetch?: typeof fetch; origin: string } {
  const refuse = (why: string): never => {
    throw new Error(`[dewee-webchat] ccp: ${why}`);
  };
  if (!raw || typeof raw !== "object") return refuse("options are required (chatUrl, integrationId, integrationSecret)");
  const { chatUrl, integrationId, integrationSecret } = raw;
  if (typeof chatUrl !== "string" || chatUrl.trim() === "") refuse("chatUrl (DEWEE_CCP_CHAT_URL) is required");
  if (typeof integrationId !== "string" || integrationId === "") refuse("integrationId (DEWEE_WEBCHAT_INTEGRATION_ID) is required");
  if (typeof integrationSecret !== "string" || integrationSecret === "") refuse("integrationSecret (DEWEE_WEBCHAT_INTEGRATION_SECRET) is required");
  let u: URL;
  try {
    u = new URL(chatUrl!.trim());
  } catch {
    return refuse("chatUrl is not a valid URL");
  }
  if (u.username || u.password) refuse("chatUrl must not contain credentials");
  if (u.search || u.hash) refuse("chatUrl must not contain a query or fragment");
  const loopback = LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) refuse("chatUrl must use https (plain http is allowed for localhost only)");
  const path = u.pathname.replace(/\/+$/, "");
  const m = INGRESS_PATH_RE.exec(path);
  if (!m) refuse("chatUrl must end with /api/public/webchat/v1/<integration id> (copy it from the CCP Website chat page)");
  if (!INTEGRATION_ID_RE.test(integrationId!)) refuse("integrationId must look like wci_ followed by 26 characters");
  if (m![1] !== integrationId) refuse("integrationId does not match the id in chatUrl");
  if (!SECRET_RE.test(integrationSecret!)) refuse("integrationSecret must be the dwc_ secret the CCP Website chat page shows (not a CCP or gateway API key)");
  if (raw.fetch !== undefined && typeof raw.fetch !== "function") refuse("fetch must be a function");
  return { chatUrl: `${u.origin}${path}`, integrationId: integrationId!, integrationSecret: integrationSecret!, fetch: raw.fetch, origin: u.origin };
}

/**
 * A refusal or failure of the ingress. `code` is the contract's public code (`integration_unauthorized`,
 * `rate_limited`, an identity code…), or a local one: `ccp_unreachable` (network), `ccp_redirect`
 * (a redirect was refused), `ccp_bad_response` (not the contract's shape). `message` is CCP's text and
 * is for logs only; it is never sent to a browser.
 */
export class CcpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSeconds?: number,
    public remediation?: { action: string; audience: string },
  ) {
    super(message);
    this.name = "CcpError";
  }
}

/** `X-Dewee-Visitor-IP` as CCP accepts it (contract): an IPv4 or IPv6 literal. */
const VISITOR_IP_RE = /^[0-9A-Fa-f:.]{2,64}$/;

export interface CcpRequest {
  method?: "GET" | "POST";
  body?: unknown;
  /** Edge session token (`X-Dewee-Webchat-Session`). */
  session?: string;
  /** Browser `Origin` the website received (`X-Dewee-Visitor-Origin`). */
  visitorOrigin?: string;
  /** Visitor IP as the website sees it (`X-Dewee-Visitor-IP`), a rate-limit key only. */
  visitorIp?: string;
  requestId?: string;
  idempotencyKey?: string;
  accept?: string;
  signal?: AbortSignal;
}

/** Thin client bound to one validated ingress base. */
export class CcpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: ReturnType<typeof parseCcpOptions>) {
    this.fetchImpl = cfg.fetch ?? ((input, init) => fetch(input, init));
  }

  get integrationId(): string {
    return this.cfg.integrationId;
  }

  /** Sends one request and returns the response when it is a 2xx; throws {@link CcpError} otherwise. */
  async send(route: CcpRoute, req: CcpRequest = {}): Promise<Response> {
    const url = `${this.cfg.chatUrl}/${route}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.integrationSecret}`,
      accept: req.accept ?? "application/json",
    };
    if (req.body !== undefined) headers["content-type"] = "application/json";
    if (req.session) headers["x-dewee-webchat-session"] = req.session;
    if (req.visitorOrigin) headers["x-dewee-visitor-origin"] = req.visitorOrigin;
    // CCP's own format for the address; anything else (a forged X-Forwarded-For) is left out.
    if (req.visitorIp && VISITOR_IP_RE.test(req.visitorIp)) headers["x-dewee-visitor-ip"] = req.visitorIp;
    if (req.requestId) headers["x-request-id"] = req.requestId;
    if (req.idempotencyKey) headers["idempotency-key"] = req.idempotencyKey;
    let res: Response;
    try {
      // "manual" instead of "error": Cloudflare Workers reject redirect "error"; a 3xx (or an opaque
      // redirect) is refused below, so no redirect is ever followed with the secret.
      res = await this.fetchImpl(url, {
        method: req.method ?? (req.body !== undefined ? "POST" : "GET"),
        headers,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        redirect: "manual",
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal?.aborted) throw e;
      throw new CcpError(0, "ccp_unreachable", `CCP request failed: ${(e as Error)?.name ?? "error"}`);
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => {});
      throw new CcpError(res.status, "ccp_redirect", `CCP answered ${res.status} with a redirect; redirects are never followed`);
    }
    if (res.ok) return res;
    throw await errorFrom(res);
  }

  /**
   * {@link send} and parse a JSON object body, within {@link CCP_JSON_TIMEOUT_MS} (headers and body)
   * on top of the caller's own signal. A deadline that passes is `ccp_timeout`; a caller that aborts
   * gets its own abort error.
   */
  async json<T = Record<string, unknown>>(route: CcpRoute, req: CcpRequest = {}): Promise<T> {
    const deadline = withDeadline(req.signal, CCP_JSON_TIMEOUT_MS);
    const timeout = () => new CcpError(0, "ccp_timeout", `CCP ${route} did not answer within ${CCP_JSON_TIMEOUT_MS} ms`);
    try {
      const res = await this.send(route, { ...req, signal: deadline.signal });
      const data = await res.json().catch(() => null);
      if (deadline.timedOut()) throw timeout();
      if (data === null || typeof data !== "object" || Array.isArray(data)) throw new CcpError(res.status, "ccp_bad_response", `CCP ${route} returned a body that is not a JSON object`);
      return data as T;
    } catch (e) {
      if (deadline.timedOut() && !(e instanceof CcpError && e.code === "ccp_timeout")) throw timeout();
      throw e;
    } finally {
      deadline.dispose();
    }
  }
}

/** Reads the contract's error envelope; anything else becomes a status-only error. */
async function errorFrom(res: Response): Promise<CcpError> {
  const data: any = await res.json().catch(() => null);
  const e = data?.error;
  const code = typeof e?.code === "string" && CODE_RE.test(e.code) ? e.code : `http_${res.status}`;
  const message = typeof e?.message === "string" ? e.message.slice(0, 500) : `HTTP ${res.status}`;
  const header = Number(res.headers.get("retry-after"));
  const retry = Number.isFinite(e?.retry_after_seconds) && e.retry_after_seconds > 0 ? Number(e.retry_after_seconds) : header > 0 ? header : undefined;
  return new CcpError(res.status, code, message, retry, knownRemediation(e?.remediation));
}

/**
 * Parses an SSE body into the JSON payloads of its `data:` frames. Comment frames (`: ping`) are
 * skipped; a frame whose data is not JSON is skipped too. Line endings may be `\n`, `\r\n` or `\r`,
 * also when a `\r\n` is split across two chunks, and a last frame without its closing blank line is
 * still delivered at the end of the stream. Frames are bounded so a misbehaving upstream cannot grow
 * the buffer without limit.
 */
export async function* readSseJson(body: ReadableStream<Uint8Array>, maxFrameBytes = 1_048_576): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // A chunk ending in "\r" may be the first half of "\r\n": it is held until the next chunk shows.
  let heldCr = false;
  const frameData = (frame: string): string =>
    frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
  try {
    while (true) {
      const { done, value } = await reader.read();
      let text = done ? dec.decode() : dec.decode(value, { stream: true });
      if (heldCr) text = `\r${text}`;
      heldCr = !done && text.endsWith("\r");
      if (heldCr) text = text.slice(0, -1);
      buf += text.replace(/\r\n?/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const data = frameData(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (!data) continue;
        try {
          yield JSON.parse(data);
        } catch {
          /* not JSON: skipped */
        }
      }
      if (buf.length > maxFrameBytes) throw new CcpError(502, "ccp_bad_response", "CCP stream frame too large");
      if (done) break;
    }
    // The stream ended inside a frame: what it holds is a complete event all the same.
    const data = frameData(buf);
    if (data) {
      try {
        yield JSON.parse(data);
      } catch {
        /* not JSON: skipped */
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
