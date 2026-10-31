// Framework-agnostic backend: (Request) => Promise<Response>.
// Routes are matched by the last path segment, so mount it under any prefix
// (e.g. /api/dewee/[...path]): GET config | POST session | POST chat | GET history | POST link (identity) | OPTIONS.
// Two transports carry the turns: "ccp" (the CCP-managed public webchat ingress, ccp-transport.ts) and
// "legacy-gateway" (deprecated: a direct Gateway WebSocket, gateway-client.ts). The browser contract
// (docs/http-contract.md) is the same for both.
import {
  HEADER_GATEWAY_TOKEN,
  HEADER_GATEWAY_URL,
  VERSION,
  isAdmissionErrorCode,
  isIdentityErrorCode,
  type AgentInfo,
  type ChatStreamEvent,
  type IdentityErrorCode,
  type LinkResponse,
  type PublicConfig,
  type Remediation,
  type SessionResponse,
} from "../protocol";
// This module never imports `@dewee/identity`, not even lazily, so bundlers of anonymous-only hosts never
// look for it. Identity mode gets the SDK through `identity.sdk` (from `dewee-webchat/server/identity`).
import { ActionInputError, buildPageBlock, hashManifest, normalizeManifest, serializePageContext } from "../actions/page-block";
import {
  GatewayConnection,
  GatewayError,
  buildSessionKey,
  fetchHistory,
  listAgents,
  streamChat,
  type GatewayActor,
  type GatewayCredentials,
} from "./gateway-client";
import { admissionErrorEvent, admissionErrorResponse, gatewayReasonOf } from "./admission-errors";
import {
  deriveVisitorId,
  memoryRateLimiter,
  randomId,
  signReuseHint,
  signVisitorToken,
  constantTimeEqual,
  subjectDigest,
  verifyTurnstile,
  verifyReuseHint,
  verifyVisitorToken,
  type RateLimiter,
  type VisitorClaims,
} from "./security";
import { DEAD_SESSION_CODES, IDENTITY_ERRORS } from "./identity-errors";
import { CcpClient, CcpError, parseCcpOptions, type CcpOptions } from "./ccp-client";
import { resolveTransport } from "./transport-selection";
import { JobAccessRefusal, mintJobAccess } from "./job-access";
import { CCP_AGENT_RE, CCP_ID_RE, EDGE_RESEAL_MS, browserErrorFor, createCcpTransport, type BrowserError, type CcpConfig, type EdgeSession, type VisitorContext } from "./ccp-transport";

/**
 * A signed-in user of the host app, as `identity.authenticate` reports it. Scopes are not part of
 * the session exchange: report scope changes with `lifecycle({ event: "scopes_changed" })` from
 * `@dewee/identity`.
 */
export interface AuthenticatedUser {
  /** Your stable, opaque user id. Never an email address (an id containing "@" is refused). */
  subject: string;
}

/** A private JWK whose public half is published in the application's `jwks_url`. */
export interface IdentityPrivateJwk {
  kty: string;
  kid: string;
  d: string;
  alg?: string;
  [key: string]: unknown;
}

/** Partner assertion signer, the shape `@dewee/identity` takes. */
export type IdentitySigner =
  | { applicationId: string; issuer: string; secret: string }
  | { applicationId: string; issuer: string; privateKeyJwk: IdentityPrivateJwk; algorithm?: "RS256" | "ES256" | "EdDSA" };

/**
 * The two `@dewee/identity` calls the handler uses. Pass `deweeIdentitySdk` from
 * `dewee-webchat/server/identity`; it is a separate entry so that only hosts that sign users in
 * need the SDK installed and bundled.
 */
export interface DeweeIdentitySdk {
  exchangeSession(opts: {
    gatewayUrl: string;
    allowInsecureHttp?: boolean;
    signer: IdentitySigner;
    subject: string;
    agent: string;
    ttlSeconds?: number;
  }): Promise<{ sessionToken: string; principalId: string; expiresAt: Date }>;
  startLink(opts: {
    gatewayUrl: string;
    allowInsecureHttp?: boolean;
    sessionToken: string;
    idempotencyKey?: string;
  }): Promise<{ proofCode: string; expiresAt: Date; deepLinks: Array<{ channelType: string; channelInstanceId: string; name: string; displayName?: string }> }>;
  /**
   * Signs a partner assertion. Used by `transport: "ccp"`, where the website signs and CCP exchanges.
   * `deweeIdentitySdk` provides it.
   */
  createAssertion?(opts: {
    purpose: "session";
    subject: string;
    applicationId: string;
    issuer: string;
    secret?: string;
    privateKeyJwk?: IdentityPrivateJwk;
    algorithm?: "RS256" | "ES256" | "EdDSA";
  }): Promise<string>;
}

/**
 * Verified signed-in users through a Dewee identity session exchange. The host passes one
 * server-side callback; the handler exchanges the user for a short-lived Dewee identity session bound
 * to one agent, and the gateway derives the user from it.
 */
export interface DeweeIdentityOptions {
  /** `deweeIdentitySdk` from `dewee-webchat/server/identity`. */
  sdk: DeweeIdentitySdk;
  /**
   * Reads your own login (cookie, header…). Return null for a visitor who is not signed in. Throwing
   * means the login could not be read: the visitor gets `503 SOURCE_UNAVAILABLE`, never an anonymous
   * session. Keep it cheap or cached: it runs on every `/session` (every page load) and, with
   * `rebindEachRequest`, on every `/chat`, `/history` and `/link`, behind a generous per-IP cap only.
   */
  authenticate(req: Request): Promise<AuthenticatedUser | null>;
  /** Dewee application id (`dewee identity setup` prints it). */
  appId: string;
  /** The issuer configured on the application, exactly. */
  issuer: string;
  /** Optional check: must equal `dewee:<appId>`, the audience Dewee issued the application. */
  audience?: string;
  /** Assertion secret of an `hmac` application. Exactly one of this or `privateKeyJwk`. */
  assertionSecret?: string;
  /** Private signing key of a `jwks` application (RS256, ES256 or EdDSA, with `kid`). */
  privateKeyJwk?: IdentityPrivateJwk;
  /** Algorithm of `privateKeyJwk`; defaults to its `alg`. */
  algorithm?: "RS256" | "ES256" | "EdDSA";
  /**
   * The agent identity sessions are bound to. Default: `defaultAgent`, else the first of `agents`
   * (with `transport: "ccp"`: the integration's default agent).
   */
  agent?: string;
  /**
   * Refuse visitors who are not signed in (no anonymous fallback). Default false: a visitor for whom
   * `authenticate` returns null chats anonymously exactly as without this option.
   */
  required?: boolean;
  /**
   * Check the signed-in user again on every `/chat`, `/history` and `/link`: `authenticate(req)` must
   * return the same subject the session was issued for, else the request is `401 IDENTITY_REQUIRED`
   * (the widget then asks `/session` again); if it throws, `503 SOURCE_UNAVAILABLE`. Recommended when
   * your login is a cookie: a widget token replayed under another user's cookie is then useless.
   * Default false.
   */
  rebindEachRequest?: boolean;
  /** Identity session lifetime, 60 to 43200 seconds. Default: the gateway default (3600). */
  sessionTtlSeconds?: number;
  /** Allow plain http to a gateway that is not loopback (private networks only). */
  allowInsecureHttp?: boolean;
}

/** How this backend reaches Dewee. */
export type DeweeTransport = "ccp" | "legacy-gateway";

export interface DeweeHandlerOptions {
  /**
   * `"ccp"`: the CCP-managed public webchat ingress, configured with `ccp` (recommended).
   * `"legacy-gateway"`: a direct Gateway WebSocket with `gatewayUrl` + `token` (deprecated).
   * Default: `"ccp"` when `ccp` is set, else `"legacy-gateway"`. Setting both `ccp` and the gateway
   * options is a startup error, so a credential is never sent to an origin it was not meant for.
   */
  transport?: DeweeTransport;
  /**
   * The CCP integration (`DEWEE_CCP_CHAT_URL`, `DEWEE_WEBCHAT_INTEGRATION_ID`,
   * `DEWEE_WEBCHAT_INTEGRATION_SECRET` from the CCP "Website chat" page). The integration decides the
   * agents, sign-in mode and whether reasoning and tool activity are shown, so `agents`,
   * `defaultAgent`, `tenantId` and `allowClientCredentials` do not apply to it.
   */
  ccp?: CcpOptions;
  /** Legacy gateway transport: Gateway runtime origin. Required unless every request brings its own credentials. */
  gatewayUrl?: string;
  /** Legacy gateway transport: Gateway token or operator API key (server-side only). */
  token?: string;
  /** Legacy gateway transport. */
  tenantId?: string;
  /** HMAC secret for visitor tokens (>= 32 random chars). */
  secret?: string;
  /** Legacy gateway transport: agents visitors may talk to. The first is the default. `"*"` = every active agent. */
  agents?: Array<string | AgentInfo> | "*";
  defaultAgent?: string;
  /** Let the widget switch between allowed agents. Default: true when more than one agent. */
  allowAgentSwitch?: boolean;
  /** Cross-origin sites allowed to call this backend. Same-origin is always allowed. */
  allowedOrigins?: string[] | "*";
  /**
   * Legacy gateway transport: let visitors bring their own gateway URL + token (sent per request, never stored).
   * Meant for playgrounds. `allowedHosts` restricts which gateways may be targeted.
   */
  allowClientCredentials?: boolean | { allowedHosts?: string[] };
  /** Cloudflare Turnstile. When set, issuing a visitor session requires a valid challenge. */
  turnstile?: { siteKey: string; secretKey: string };
  /**
   * Custom limiter, or false to disable. Default (in memory): 20 messages/min per visitor and IP,
   * 10 new sessions/10 min per IP and, with `identity`, 120 `authenticate` calls/min per IP,
   * 30 signed-in sessions/10 min per user and 5 link starts/10 min per user. Defense in depth: the
   * Dewee gateway owns the shared message limit and refuses with `RATE_LIMITED` (forwarded typed).
   */
  rateLimit?: RateLimiter | false;
  maxMessageLength?: number;
  /** Prefix for the per-visitor gateway user id. */
  userIdPrefix?: string;
  sessionTtlMs?: number;
  /** Max duration of one agent run. */
  timeoutMs?: number;
  /** Observe traffic (logging/analytics). Errors thrown here are ignored. */
  onChat?: (info: { visitorId: string; agent: string; message: string; reply?: string; error?: string }) => void;
  /**
   * Verified signed-in users through Dewee (needs the `@dewee/identity` package). Absent: every
   * visitor is anonymous, exactly as before. Cannot be combined with `allowClientCredentials`.
   */
  identity?: DeweeIdentityOptions;
}

/** The backend: one function for every route, plus the logout hook of signed-in users. */
export interface DeweeHandler {
  (request: Request): Promise<Response>;
  /**
   * Call from your logout: ends the Dewee identity sessions this backend holds for `subject` (every
   * bound agent) and forgets them, so the next `/session` exchanges again. With `transport: "ccp"` they
   * are revoked at CCP (`identity/revoke`). Pass the logout request so CCP sees the visitor's origin
   * and IP (without it, the origin of the request the session was issued for is used). `token` is the
   * widget's reuse hint (`reuseHint()`) or visitor token, sent along by your logout page: its identity
   * session is revoked too when it belongs to `subject`, so a host that keeps no memory between
   * requests still ends the exact session. Best effort: never throws. Other sessions held only by
   * other instances end at their expiry (`sessionTtlSeconds`). Without `identity` it does nothing.
   */
  revoke(subject: string, request?: Request, token?: string): Promise<void>;
}

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]{1,255}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gateway default identity session lifetime, used when the expiry cannot be trusted (clock skew). */
const DEFAULT_IDENTITY_TTL_MS = 3600_000;
const MAX_IDENTITY_TTL_MS = 43_200_000;
/** Most identity sessions kept for reuse; each is a few hundred bytes. */
const MAX_CACHED_SESSIONS = 1000;
/** An anonymous token this far from expiry is handed back as is instead of minting a new one. */
const ANON_REUSE_MS = 86_400_000;
/**
 * CCP: a reuse hint the widget sends back to `/session` (`reuseHint`) is reused for its
 * identity session only with at least this long left, so a refresh near the end exchanges instead.
 */
const VERIFIED_REUSE_MIN_MS = 120_000;

/** Validates the identity options once, at startup, and returns the agent sessions are bound to. */
function checkIdentityOptions(o: DeweeHandlerOptions, staticAgents: AgentInfo[], transport: DeweeTransport): string {
  const idn = o.identity!;
  const refuse = (why: string): never => {
    throw new Error(`[dewee-webchat] identity: ${why}`);
  };
  if (o.allowClientCredentials) refuse("cannot be combined with allowClientCredentials (a visitor-chosen gateway must never receive a user's session)");
  const sdkHint = 'import { deweeIdentitySdk } from "dewee-webchat/server/identity" (needs the @dewee/identity package)';
  if (transport === "ccp") {
    if (!idn.sdk || typeof idn.sdk.createAssertion !== "function") refuse(`sdk with createAssertion is required: ${sdkHint}`);
    if (idn.allowInsecureHttp) refuse("allowInsecureHttp does not apply to the ccp transport");
  } else {
    if (!o.gatewayUrl || !o.token) refuse("needs the server's own gatewayUrl and token");
    if (!idn.sdk || typeof idn.sdk.exchangeSession !== "function" || typeof idn.sdk.startLink !== "function") refuse(`sdk is required: ${sdkHint}`);
  }
  if (typeof idn.authenticate !== "function") refuse("authenticate(req) is required");
  if (typeof idn.appId !== "string" || !UUID_RE.test(idn.appId)) refuse("appId must be the Dewee application id (a UUID)");
  if (typeof idn.issuer !== "string" || idn.issuer.trim() === "") refuse("issuer is required");
  if (idn.audience !== undefined && String(idn.audience).toLowerCase() !== `dewee:${idn.appId.toLowerCase()}`) refuse("audience must be dewee:<appId>");
  const hasSecret = idn.assertionSecret !== undefined && idn.assertionSecret !== "";
  const hasJwk = idn.privateKeyJwk !== undefined;
  if (hasSecret === hasJwk) refuse("set exactly one of assertionSecret or privateKeyJwk");
  if (hasSecret && new TextEncoder().encode(idn.assertionSecret!).length < 32) refuse("assertionSecret is too short (at least 32 bytes)");
  if (hasJwk && (typeof idn.privateKeyJwk!.d !== "string" || typeof idn.privateKeyJwk!.kid !== "string")) refuse("privateKeyJwk must be a private JWK with a kid");
  const ttl = idn.sessionTtlSeconds;
  if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 60 || ttl > 43200)) refuse("sessionTtlSeconds must be an integer from 60 to 43200");
  // With ccp the integration names its agents; an unset identity.agent means its default agent.
  if (transport === "ccp") {
    if (idn.agent !== undefined && (typeof idn.agent !== "string" || !CCP_AGENT_RE.test(idn.agent))) refuse("agent must be an agent key");
    return idn.agent ?? "";
  }
  const agent = idn.agent || o.defaultAgent || staticAgents[0]?.id;
  if (!agent || !AGENT_RE.test(agent)) refuse("no agent to bind sessions to: set identity.agent, defaultAgent or agents");
  if (staticAgents.length && !staticAgents.some((a) => a.id === agent)) refuse(`agent "${agent}" is not in agents`);
  return agent!;
}

export function createDeweeHandler(options: DeweeHandlerOptions): DeweeHandler {
  const o = {
    maxMessageLength: 4000,
    userIdPrefix: "webchat-",
    sessionTtlMs: 30 * 24 * 3600 * 1000,
    timeoutMs: 180000,
    ...options,
  };
  const transport = resolveTransport(o);
  let secret = o.secret;
  if (!secret) {
    secret = randomId(32);
    console.warn("[dewee-webchat] No secret configured: using an ephemeral one. Visitor sessions reset on restart.");
  }
  const limiter: RateLimiter | null =
    o.rateLimit === false
      ? null
      : o.rateLimit ??
        memoryRateLimiter({ chat: [20, 60_000], session: [10, 600_000], preauth: [120, 60_000], verified: [30, 600_000], link: [5, 600_000] });
  const staticAgents: AgentInfo[] =
    o.agents === "*" ? [] : (o.agents ?? []).map((a) => (typeof a === "string" ? { id: a } : a));
  const wildcardAgents = o.agents === "*";
  const byo = o.allowClientCredentials ? (o.allowClientCredentials === true ? {} : o.allowClientCredentials) : null;
  const idn = o.identity;
  /** Legacy: the agent sessions are bound to. CCP: identity.agent, or "" for the integration's default. */
  const identityAgent = idn ? checkIdentityOptions(o, staticAgents, transport) : "";
  const ccp =
    transport === "ccp"
      ? createCcpTransport(
          new CcpClient(parseCcpOptions(o.ccp)),
          idn ? { createAssertion: (a) => idn.sdk.createAssertion!(a), signer: () => identitySigner(), ttlSeconds: idn.sessionTtlSeconds } : undefined,
        )
      : null;

  /** What CCP is told about the browser request behind a call. */
  function visitorContext(req: Request): VisitorContext {
    const ip = clientIp(req);
    let visitorOrigin = req.headers.get("origin") || undefined;
    // Same-origin GETs may come without Origin; the request then reached this site's own backend.
    if (!visitorOrigin) {
      try {
        visitorOrigin = new URL(req.headers.get("referer") || req.url).origin;
      } catch {
        visitorOrigin = undefined;
      }
    }
    return { visitorOrigin: visitorOrigin === "null" ? undefined : visitorOrigin, visitorIp: ip === "unknown" ? undefined : ip, requestId: `dwc-${randomId(12)}` };
  }

  const sealedEdge = (claims: VisitorClaims | null | undefined): EdgeSession | undefined =>
    claims?.es && typeof claims.ese === "number" ? { token: claims.es, expiresAt: claims.ese } : undefined;

  /**
   * CCP: the session answer the widget refreshes from. The token itself lives `exp`; the widget is
   * told the edge session's end instead (`expiresAt`, `expiresIn`), so it asks `/session` again while
   * the sealed edge session can still be refreshed and a host without shared memory (serverless
   * isolates, PHP-style restarts) never has to refresh or create one on every request.
   */
  const ccpSessionTimes = (exp: number, edge: EdgeSession, now = Date.now()) => {
    const expiresAt = Math.min(exp, edge.expiresAt);
    return { expiresAt, expiresIn: Math.max(0, expiresAt - now) };
  };

  function serverCreds(): GatewayCredentials | null {
    return o.gatewayUrl && o.token ? { url: o.gatewayUrl, token: o.token, tenantId: o.tenantId } : null;
  }

  /** Resolves credentials: client-supplied (when allowed) or the server's own. */
  function resolveCreds(req: Request): { creds: GatewayCredentials | null; byo: boolean; error?: string } {
    const url = req.headers.get(HEADER_GATEWAY_URL);
    const token = req.headers.get(HEADER_GATEWAY_TOKEN);
    if (url || token) {
      if (!byo) return { creds: null, byo: true, error: "Client credentials are disabled on this server" };
      if (!url || !token) return { creds: null, byo: true, error: "Both gateway URL and token are required" };
      let u: URL;
      try { u = new URL(url); } catch { return { creds: null, byo: true, error: "Invalid gateway URL" }; }
      // The server connects wherever the client points it, so internal hosts need an explicit allowlist entry.
      const listed = !!byo.allowedHosts?.includes(u.hostname);
      if (byo.allowedHosts?.length && !listed) return { creds: null, byo: true, error: "Gateway host not allowed" };
      if (isInternalHost(u.hostname) && !listed) return { creds: null, byo: true, error: "Gateway host not allowed" };
      if (u.protocol !== "https:" && !(listed && u.protocol === "http:")) return { creds: null, byo: true, error: "Gateway URL must use https" };
      return { creds: { url: u.origin + u.pathname.replace(/\/$/, ""), token }, byo: true };
    }
    return { creds: serverCreds(), byo: false };
  }

  async function agentsFor(creds: GatewayCredentials | null, isByo: boolean): Promise<AgentInfo[]> {
    if ((isByo || wildcardAgents) && creds) return listAgents(creds);
    if (creds && staticAgents.some((a) => !a.name)) {
      // Fill missing display names from the gateway once; ids stay the allowlist.
      namedAgents ??= listAgents(creds)
        .then((all) => staticAgents.map((a) => ({ ...a, name: a.name ?? all.find((x) => x.id === a.id)?.name })))
        .catch(() => { namedAgents = undefined; return staticAgents; });
      return namedAgents;
    }
    return staticAgents;
  }
  let namedAgents: Promise<AgentInfo[]> | undefined;

  function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin");
    if (!origin) return {};
    const allowed = o.allowedOrigins === "*" || (o.allowedOrigins ?? []).includes(origin) || origin === new URL(req.url).origin;
    if (!allowed) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": `content-type, authorization, ${HEADER_GATEWAY_URL}, ${HEADER_GATEWAY_TOKEN}`,
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }

  function originAllowed(req: Request): boolean {
    const origin = req.headers.get("origin");
    if (!origin || origin === new URL(req.url).origin) return true;
    return o.allowedOrigins === "*" || (o.allowedOrigins ?? []).includes(origin);
  }

  const json = (req: Request, body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders, ...corsHeaders(req) },
    });
  const fail = (req: Request, status: number, message: string, code = "bad_request") => json(req, { error: { message, code } }, status);

  /** A typed identity error: `{error: {message, code, remediation}}`. Never carries a token or secret. */
  const identityFail = (req: Request, code: IdentityErrorCode, remediation?: Remediation) => {
    const e = IDENTITY_ERRORS[code];
    return json(req, { error: { message: e.message, code, remediation: remediation ?? { action: e.action, audience: "end_user" } } }, e.status);
  };

  const misconfigured = (req: Request) => fail(req, 500, "Signed-in chat is misconfigured on this server", "identity_misconfigured");

  /** A CCP refusal or failure, as the browser contract answers it. Never carries CCP's own text. */
  function ccpFail(req: Request, e: unknown, route: Parameters<typeof browserErrorFor>[1], sessionToken?: string): Response {
    const b: BrowserError = browserErrorFor(e, route);
    if (b.admission) {
      const r = admissionErrorResponse(b.admission, b.retryAfterMs);
      return json(req, r.body, r.status, r.headers);
    }
    if (b.identity) {
      if (sessionToken && DEAD_SESSION_CODES.has(b.identity)) forgetCachedSession(sessionToken);
      return identityFail(req, b.identity, b.remediation);
    }
    const res = fail(req, b.status, b.message, b.code);
    if (b.retryAfterSeconds) res.headers.set("retry-after", String(Math.ceil(b.retryAfterSeconds)));
    return res;
  }

  /**
   * Gateway WebSocket failure: admission and identity codes are forwarded typed, anything else stays a
   * gateway error.
   * A dead identity session is dropped from the reuse cache.
   */
  const gatewayFail = (req: Request, e: unknown, sessionToken?: string) => {
    if (e instanceof GatewayError && isAdmissionErrorCode(e.code)) {
      const r = admissionErrorResponse(e.code, e.retryAfterMs);
      return json(req, r.body, r.status, r.headers);
    }
    if (!(e instanceof GatewayError && isIdentityErrorCode(e.code))) return fail(req, 502, (e as Error).message, "gateway_error");
    if (sessionToken && DEAD_SESSION_CODES.has(e.code)) forgetCachedSession(sessionToken);
    if (e.remediation?.audience === "operator") console.error(`[dewee-webchat] identity: ${e.message} (${e.code})`);
    return identityFail(req, e.code, e.remediation);
  };

  /** `@dewee/identity` failure (exchange, link): typed identity codes are forwarded; SDK messages are not. */
  const sdkFail = (req: Request, e: unknown, what: string) => {
    const code = (e as { code?: unknown })?.code;
    if (isIdentityErrorCode(code)) {
      console.warn(`[dewee-webchat] identity ${what} refused: ${code}`);
      return identityFail(req, code, (e as { remediation?: Remediation }).remediation);
    }
    console.warn(`[dewee-webchat] identity ${what} failed:`, code ?? e);
    if (code === "RESOURCE_EXHAUSTED") return fail(req, 429, "Too many sign-ins, slow down", "rate_limited");
    if (code === "INVALID_ARGUMENT" || code === "SERVER_ONLY") return misconfigured(req);
    return fail(req, 502, "Dewee is unavailable, try again later", "gateway_error");
  };

  /**
   * Exchange failure. Only an error the signed-in user can act on reaches the browser typed; one
   * addressed to the operator or integrator (an application or agent set up wrong, exchange switched
   * off on the gateway) is this server's misconfiguration.
   */
  const exchangeFail = (req: Request, e: unknown) => {
    const { code, remediation } = (e ?? {}) as { code?: unknown; remediation?: Remediation };
    if ((isIdentityErrorCode(code) && remediation && remediation.audience !== "end_user") || code === "NOT_FOUND") {
      console.error(`[dewee-webchat] identity session exchange refused: ${String(code)} (remediation for ${remediation?.audience ?? "operator"}: ${remediation?.action ?? "check the gateway"})`);
      return misconfigured(req);
    }
    return sdkFail(req, e, "session exchange");
  };

  /**
   * CCP exchange failure, same policy as {@link exchangeFail}: only an error the signed-in user can act
   * on is typed; an operator or integrator problem is this server's misconfiguration.
   */
  const ccpExchangeFail = (req: Request, e: unknown) => {
    const { code, remediation } = (e ?? {}) as { code?: unknown; remediation?: Remediation };
    if (isIdentityErrorCode(code) && remediation && remediation.audience !== "end_user") {
      console.error(`[dewee-webchat] identity session exchange refused: ${code} (remediation for ${remediation.audience}: ${remediation.action})`);
      return misconfigured(req);
    }
    if (typeof (e as { code?: unknown })?.code !== "string") {
      console.warn("[dewee-webchat] identity session exchange failed:", (e as Error)?.name ?? e);
    }
    return ccpFail(req, e, "identity/exchange");
  };

  /** Link start failure: the gateway's conflict and availability codes get their own answers. */
  const linkFail = (req: Request, e: unknown, sessionToken: string) => {
    const code = (e as { code?: unknown })?.code;
    if (code === "IDEMPOTENCY_KEY_REUSED") return fail(req, 409, "This idempotency key was already used for a different link request", "idempotency_key_reused");
    if (code === "FAILED_PRECONDITION") return fail(req, 409, "A link is already in progress. Use its code or wait until it expires.", "link_in_progress");
    if (code === "NOT_FOUND") {
      console.error("[dewee-webchat] identity link start: the gateway has identity exchange switched off");
      return fail(req, 503, "Linking is not available right now", "linking_unavailable");
    }
    if (typeof code === "string" && DEAD_SESSION_CODES.has(code)) forgetCachedSession(sessionToken);
    return sdkFail(req, e, "link start");
  };

  const clientIp = (req: Request) =>
    req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

  /** The verified visitor token of the request. A token carrying an identity session is honored only in identity mode. */
  async function visitorFrom(req: Request): Promise<VisitorClaims | null> {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const claims = token ? await verifyVisitorToken(secret!, token) : null;
    if (claims?.ids && !idn) return null;
    return claims;
  }

  /**
   * Agent of a request: an identity session is bound to its agent, which must still be allowed by the
   * current `agents`; anything else follows the allowlist.
   */
  async function agentFor(claims: VisitorClaims, requested: string | null | undefined, creds: GatewayCredentials | null, isByo: boolean): Promise<string | null> {
    if (claims.ids) {
      const bound = claims.ida!;
      if (requested && requested !== bound) return null;
      return wildcardAgents || staticAgents.some((a) => a.id === bound) ? bound : null;
    }
    return pickAgent(requested, creds, isByo);
  }

  /**
   * With `rebindEachRequest`: the request's own login must still be the user the token was issued for.
   * Returns the refusal, or null to go on.
   */
  async function rebindRefusal(req: Request, claims: VisitorClaims, required = false): Promise<Response | null> {
    if (!idn || (!required && !idn.rebindEachRequest) || !claims.ids) return null;
    const throttled = await preauthRefusal(req);
    if (throttled) return throttled;
    let user: AuthenticatedUser | null;
    try {
      user = await idn.authenticate(req);
    } catch (e) {
      console.warn("[dewee-webchat] identity.authenticate failed:", e instanceof Error ? e.name : "unknown");
      return identityFail(req, "SOURCE_UNAVAILABLE", { action: "retry_later", audience: "end_user" });
    }
    const current = !!user && typeof user.subject === "string" && user.subject !== "" ? await subjectDigest(secret!, user.subject) : null;
    if (current && claims.sub && constantTimeEqual(current, claims.sub)) return null;
    if (ccp && current && claims.sub) {
      // Another user is signed in on this browser: the previous user's identity session is revoked at
      // CCP, not only refused here. A request with no user at all (signed out, or a cookie that did
      // not come along) is only refused: the session may be in use on the user's other devices, and
      // logout revokes it through `revoke`. The revoked session is the old user's one shared session,
      // so it also ends on their other devices; their widget recovers there with a 401 and a new
      // exchange at `/session`.
      forgetCachedSession(claims.ids);
      await ccp.revoke(visitorContext(req), claims.v, sealedEdge(claims), claims.ids, claims.ida);
    }
    return identityFail(req, "IDENTITY_REQUIRED");
  }

  /** A generous per-IP cap in front of every `authenticate` call, so a client cannot drive the host's login check at will. */
  async function preauthRefusal(req: Request): Promise<Response | null> {
    if (!limiter || (await limiter(clientIp(req), "preauth"))) return null;
    return fail(req, 429, "Too many requests, slow down", "rate_limited");
  }

  const actorOf = (claims: VisitorClaims): GatewayActor => (claims.ids ? { identitySession: claims.ids } : o.userIdPrefix + claims.v);

  function identitySigner(): IdentitySigner {
    if (idn!.assertionSecret) return { applicationId: idn!.appId, issuer: idn!.issuer, secret: idn!.assertionSecret };
    return { applicationId: idn!.appId, issuer: idn!.issuer, privateKeyJwk: idn!.privateKeyJwk!, algorithm: idn!.algorithm };
  }

  /**
   * One identity session per user (and bound agent), reused until it nears expiry, so a page load does
   * not cost an exchange. Bounded; a session the gateway reports dead is dropped.
   */
  /** `origin`: the visitor origin the session was issued for, used by a `revoke` without a request. */
  interface CachedSession { sessionToken: string; visitorId: string; deadline: number; margin: number; origin?: string }
  const sessionCache = new Map<string, CachedSession>();
  const exchanges = new Map<string, Promise<CachedSession>>();

  function forgetCachedSession(sessionToken: string): void {
    for (const [k, c] of sessionCache) if (c.sessionToken === sessionToken) sessionCache.delete(k);
  }

  function rememberSession(key: string, c: CachedSession): void {
    sessionCache.delete(key);
    sessionCache.set(key, c);
    if (sessionCache.size <= MAX_CACHED_SESSIONS) return;
    const now = Date.now();
    for (const [k, v] of sessionCache) if (v.deadline - now <= v.margin) sessionCache.delete(k);
    // Still full: drop the least recently issued.
    for (const k of sessionCache.keys()) {
      if (sessionCache.size <= MAX_CACHED_SESSIONS) break;
      sessionCache.delete(k);
    }
  }

  async function exchangeFor(subject: string, req: Request, sealed?: EdgeSession): Promise<CachedSession> {
    if (ccp) return ccpExchangeFor(subject, req, sealed);
    const session = await idn!.sdk.exchangeSession({
      gatewayUrl: o.gatewayUrl!,
      allowInsecureHttp: idn!.allowInsecureHttp,
      signer: identitySigner(),
      subject,
      agent: identityAgent,
      ttlSeconds: idn!.sessionTtlSeconds,
    });
    // Lifetime is measured from receipt on this server's clock. The gateway's absolute expiry is only
    // trusted while it fits the requested lifetime; otherwise the clocks disagree and the requested
    // (or default) lifetime is used.
    const receivedAt = Date.now();
    const bound = idn!.sessionTtlSeconds ? idn!.sessionTtlSeconds * 1000 : MAX_IDENTITY_TTL_MS;
    let lifetime = session.expiresAt.getTime() - receivedAt;
    if (!(lifetime > 0 && lifetime <= bound)) {
      console.warn("[dewee-webchat] identity session expiry does not match this server's clock; using the requested lifetime");
      lifetime = idn!.sessionTtlSeconds ? idn!.sessionTtlSeconds * 1000 : DEFAULT_IDENTITY_TTL_MS;
    }
    // Same principal, same visitor id: conversations follow the user across devices and page loads.
    const visitorId = await deriveVisitorId(secret!, `principal:${session.principalId}`);
    return { sessionToken: session.sessionToken, visitorId, deadline: receivedAt + lifetime, margin: Math.min(60_000, lifetime / 2) };
  }

  /** Lifetime of an identity session from receipt on this server's clock (see {@link exchangeFor}). */
  function identityLifetime(expiresAt: Date, receivedAt: number): number {
    const bound = idn!.sessionTtlSeconds ? idn!.sessionTtlSeconds * 1000 : MAX_IDENTITY_TTL_MS;
    const lifetime = expiresAt.getTime() - receivedAt;
    if (lifetime > 0 && lifetime <= bound) return lifetime;
    console.warn("[dewee-webchat] identity session expiry does not match this server's clock; using the requested lifetime");
    return idn!.sessionTtlSeconds ? idn!.sessionTtlSeconds * 1000 : DEFAULT_IDENTITY_TTL_MS;
  }

  /**
   * CCP: the website signs the assertion and CCP exchanges it. The visitor id is derived from the
   * host's subject (keyed, not guessable), so the edge session the exchange needs exists before the
   * principal is known; the runtime keys conversations by the verified principal either way.
   */
  async function ccpExchangeFor(subject: string, req: Request, sealed?: EdgeSession): Promise<CachedSession> {
    const visitorId = await deriveVisitorId(secret!, `subject:${subject}`);
    const ctx = visitorContext(req);
    const session = await ccp!.exchange(ctx, visitorId, subject, await boundAgent(), sealed);
    const receivedAt = Date.now();
    const lifetime = identityLifetime(session.expiresAt, receivedAt);
    return { sessionToken: session.sessionToken, visitorId, deadline: receivedAt + lifetime, margin: Math.min(60_000, lifetime / 2), origin: ctx.visitorOrigin };
  }

  /** The agent identity sessions are bound to: legacy fixed at startup; CCP `identity.agent` or the integration default. */
  async function boundAgent(): Promise<string> {
    if (!ccp || identityAgent) return identityAgent;
    return (await ccp.config()).defaultAgent;
  }

  /**
   * CCP: the identity session of the reuse hint the widget sent back (`reuseHint`), when it was issued
   * by this backend for this same user and agent and still has {@link VERIFIED_REUSE_MIN_MS} left. A host that
   * keeps no memory between requests then reuses it instead of exchanging on every page load. It is
   * never stretched: the deadline stays the token's own expiry. Anything else is ignored, never a
   * reason to answer anonymously.
   */
  async function verifiedReuse(req: Request, hint: VisitorClaims | null, subject: string, agent: string, userVisitor: string | undefined): Promise<CachedSession | null> {
    if (!ccp || !hint?.ids || hint.ida !== agent || !hint.sub || hint.v !== userVisitor) return null;
    if (hint.exp - Date.now() <= VERIFIED_REUSE_MIN_MS) return null;
    if (!constantTimeEqual(await subjectDigest(secret!, subject), hint.sub)) return null;
    return { sessionToken: hint.ids, visitorId: hint.v, deadline: hint.exp, margin: Math.min(60_000, VERIFIED_REUSE_MIN_MS / 2), origin: req.headers.get("origin") || undefined };
  }

  /**
   * A signed-in user's identity session, reused or exchanged, wrapped in a visitor token. `hint` is the
   * reuse hint the widget sent back (CCP only): its identity session and edge session are reused when
   * they belong to this user. With CCP the answer carries a new reuse hint (`reuseHint`) for the tab.
   */
  async function issueIdentitySession(req: Request, subject: string, hint: VisitorClaims | null = null): Promise<Response> {
    let agent: string;
    try {
      agent = await boundAgent();
    } catch (e) {
      return ccpFail(req, e, "config");
    }
    const key = `${agent}\n${subject}`;
    let s = sessionCache.get(key);
    const userVisitor = ccp ? await deriveVisitorId(secret!, `subject:${subject}`) : undefined;
    // The edge session of an earlier token of this user is refreshed rather than replaced.
    const sealed = hint && hint.ids && hint.v === userVisitor ? sealedEdge(hint) : undefined;
    if (!s || s.deadline - Date.now() <= s.margin) {
      const reused = await verifiedReuse(req, hint, subject, agent, userVisitor);
      if (reused) {
        s = reused;
      } else {
        let pending = exchanges.get(key);
        if (!pending) {
          pending = exchangeFor(subject, req, sealed).finally(() => exchanges.delete(key));
          exchanges.set(key, pending);
        }
        try {
          s = await pending;
        } catch (e) {
          return ccp ? ccpExchangeFail(req, e) : exchangeFail(req, e);
        }
      }
      rememberSession(key, s);
    }
    const now = Date.now();
    const expiresAt = Math.min(s.deadline, now + o.sessionTtlMs);
    const sub = await subjectDigest(secret!, subject);
    let edge: EdgeSession | undefined;
    if (ccp) {
      try {
        edge = await ccp.edgeFor(visitorContext(req), s.visitorId, sealed, undefined, EDGE_RESEAL_MS);
      } catch (e) {
        return ccpFail(req, e, "session");
      }
    }
    const claims: VisitorClaims = { v: s.visitorId, exp: expiresAt, ids: s.sessionToken, ida: agent, sub, ...(edge ? { es: edge.token, ese: edge.expiresAt } : {}) };
    const token = await signVisitorToken(secret!, claims);
    const times = edge ? ccpSessionTimes(expiresAt, edge) : { expiresAt, expiresIn: expiresAt - now };
    const body: SessionResponse = { visitorId: s.visitorId, token, expiresAt: times.expiresAt, verified: true, expiresIn: times.expiresIn };
    // CCP: what a later page load needs to rebuild this session, in a token no route accepts as a bearer.
    if (ccp) body.reuseHint = await signReuseHint(secret!, claims);
    return json(req, body);
  }

  async function pickAgent(requested: string | null | undefined, creds: GatewayCredentials | null, isByo: boolean): Promise<string | null> {
    if (isByo || wildcardAgents) {
      const a = requested || o.defaultAgent || (await agentsFor(creds, isByo))[0]?.id;
      return a && AGENT_RE.test(a) ? a : null;
    }
    const def = o.defaultAgent || staticAgents[0]?.id;
    if (!requested) return def ?? null;
    return staticAgents.some((a) => a.id === requested) ? requested : null;
  }

  async function handleConfig(req: Request): Promise<Response> {
    if (ccp) return handleCcpConfig(req);
    const { creds, byo: isByo, error } = resolveCreds(req);
    if (error) return fail(req, 400, error, "bad_credentials");
    let agents: AgentInfo[] = [];
    try {
      agents = await agentsFor(creds, isByo);
    } catch (e) {
      return fail(req, 502, (e as Error).message, "gateway_error");
    }
    const body: PublicConfig = {
      agents,
      defaultAgent: (!isByo && o.defaultAgent) || agents[0]?.id || "",
      allowAgentSwitch: o.allowAgentSwitch ?? (isByo || agents.length > 1),
      allowClientCredentials: !!byo,
      turnstileSiteKey: o.turnstile?.siteKey,
      maxMessageLength: o.maxMessageLength,
      version: VERSION,
    };
    if (idn) {
      // Identity sessions are bound to one agent, so the widget must not switch.
      body.defaultAgent = identityAgent;
      body.allowAgentSwitch = false;
      body.identity = true;
    }
    return json(req, body);
  }

  /** CCP: the integration's agents and limits, merged with this backend's own settings. */
  async function handleCcpConfig(req: Request): Promise<Response> {
    const { error } = resolveCreds(req);
    if (error) return fail(req, 400, error, "bad_credentials");
    let cfg: CcpConfig;
    try {
      cfg = await ccp!.config();
    } catch (e) {
      return ccpFail(req, e, "config");
    }
    const body: PublicConfig = {
      agents: cfg.agents,
      defaultAgent: cfg.defaultAgent,
      allowAgentSwitch: o.allowAgentSwitch === false ? false : cfg.allowAgentSwitch,
      allowClientCredentials: false,
      turnstileSiteKey: o.turnstile?.siteKey,
      ...(o.turnstile ? { refreshWithoutTurnstile: true } : {}),
      maxMessageLength: Math.min(o.maxMessageLength, cfg.maxMessageChars),
      version: VERSION,
    };
    if (idn) {
      // Identity sessions are bound to one agent, so the widget must not switch.
      body.defaultAgent = identityAgent || cfg.defaultAgent;
      body.allowAgentSwitch = false;
      body.identity = true;
    }
    return json(req, body);
  }

  /** Cloudflare Turnstile, when configured. */
  async function turnstilePassed(body: any, ip: string): Promise<boolean> {
    if (!o.turnstile) return true;
    return !!body?.turnstileToken && (await verifyTurnstile(o.turnstile.secretKey, String(body.turnstileToken), ip));
  }

  async function handleSession(req: Request): Promise<Response> {
    if (idn) return handleIdentitySession(req);
    const ip = clientIp(req);
    if (ccp) {
      // A returning visitor refreshes its own session: limited per visitor, so visitors behind one
      // address (an office, a carrier NAT) do not use up each other's budget. New visitors are per IP.
      const body: any = await req.json().catch(() => ({}));
      const previous = await anonymousPrevious(body);
      if (limiter && !(await limiter(previous ? `visitor:${previous.v}` : ip, "session"))) return fail(req, 429, "Too many sessions, slow down", "rate_limited");
      return issueAnonymousSession(req, body, ip, previous);
    }
    if (limiter && !(await limiter(ip, "session"))) return fail(req, 429, "Too many sessions, slow down", "rate_limited");
    const body: any = await req.json().catch(() => ({}));
    return issueAnonymousSession(req, body, ip);
  }

  /** The still-valid anonymous token a `/session` body brings. A signed-in user's token never seeds an anonymous visitor. */
  async function anonymousPrevious(body: any): Promise<VisitorClaims | null> {
    const previous = typeof body?.token === "string" ? await verifyVisitorToken(secret!, body.token) : null;
    return previous && !previous.ids ? previous : null;
  }

  async function issueAnonymousSession(req: Request, body: any, ip: string, known?: VisitorClaims | null): Promise<Response> {
    // Refresh an existing visitor instead of minting a new identity, so history survives.
    const previous = known === undefined ? await anonymousPrevious(body) : known;
    // Turnstile gates new visitors. With CCP a returning visitor refreshes about hourly (with its
    // edge session), so a valid token is proof enough; the legacy transport checks every time.
    if (!(ccp && previous) && !(await turnstilePassed(body, ip))) return fail(req, 403, "Verification failed", "turnstile_failed");
    const visitorId = previous?.v ?? randomId(16);
    const expiresAt = Date.now() + o.sessionTtlMs;
    if (!ccp) return json(req, { visitorId, token: await signVisitorToken(secret!, { v: visitorId, exp: expiresAt }), expiresAt });
    // CCP admits the visitor (its own quotas) before a token is issued. A stale sealed edge session
    // (a host without shared memory never saw it refreshed) is refreshed for the same visitor here, so
    // the token handed back carries a fresh one.
    let edge: EdgeSession;
    try {
      edge = await ccp.edgeFor(visitorContext(req), visitorId, sealedEdge(previous), undefined, EDGE_RESEAL_MS);
    } catch (e) {
      return ccpFail(req, e, "session");
    }
    const token = await signVisitorToken(secret!, { v: visitorId, exp: expiresAt, es: edge.token, ese: edge.expiresAt });
    const body2: SessionResponse = { visitorId, token, ...ccpSessionTimes(expiresAt, edge) };
    return json(req, body2);
  }

  /**
   * `/session` of a backend that signs users in. The widget calls it on every page load, so:
   * a signed-in user is limited per user (not per IP) and reuses a cached identity session; a visitor
   * who is not signed in gets a still-valid anonymous token back as is, and only minting a new one
   * counts against the per-IP session limit.
   */
  async function handleIdentitySession(req: Request): Promise<Response> {
    const ip = clientIp(req);
    const body: any = await req.json().catch(() => ({}));
    // Fail closed: a signed-in user gets an identity session or no session at all. A login that could
    // not be read is not "signed out", so it never falls back to anonymous.
    const throttled = await preauthRefusal(req);
    if (throttled) return throttled;
    let user: AuthenticatedUser | null;
    try {
      user = await idn!.authenticate(req);
    } catch (e) {
      console.warn("[dewee-webchat] identity.authenticate failed:", e);
      return identityFail(req, "SOURCE_UNAVAILABLE", { action: "retry_later", audience: "end_user" });
    }
    if (user != null) {
      if (typeof user !== "object" || typeof user.subject !== "string" || user.subject.trim() === "") {
        console.error("[dewee-webchat] identity.authenticate must return { subject } or null");
        return misconfigured(req);
      }
      if (limiter && !(await limiter(`subject:${user.subject}`, "verified"))) return fail(req, 429, "Too many sessions, slow down", "rate_limited");
      if (!(await turnstilePassed(body, ip))) return fail(req, 403, "Verification failed", "turnstile_failed");
      // CCP: the tab's reuse hint, checked against this user before anything in it is used.
      const hint = ccp && typeof body?.reuseHint === "string" ? await verifyReuseHint(secret!, body.reuseHint) : null;
      return issueIdentitySession(req, user.subject, hint);
    }
    if (idn!.required) return identityFail(req, "IDENTITY_REQUIRED");
    const previous = await anonymousPrevious(body);
    if (previous && previous.exp - Date.now() > ANON_REUSE_MS) {
      if (!ccp) {
        const reused: SessionResponse = { visitorId: previous.v, token: body.token, expiresAt: previous.exp };
        return json(req, reused);
      }
      // CCP: handed back as is only while its sealed edge session is fresh; else re-sealed below.
      const edge = sealedEdge(previous);
      if (edge && edge.expiresAt - Date.now() > EDGE_RESEAL_MS) {
        const reused: SessionResponse = { visitorId: previous.v, token: body.token, ...ccpSessionTimes(previous.exp, edge) };
        return json(req, reused);
      }
    }
    // CCP: a returning visitor is limited per visitor (see handleSession); new visitors per IP.
    const key = ccp && previous ? `visitor:${previous.v}` : ip;
    if (limiter && !(await limiter(key, "session"))) return fail(req, 429, "Too many sessions, slow down", "rate_limited");
    return issueAnonymousSession(req, body, ip, previous);
  }

  async function handleChat(req: Request): Promise<Response> {
    const claims = await visitorFrom(req);
    if (!claims) return fail(req, 401, "Missing or expired visitor session", "unauthorized");
    if (idn?.required && !claims.ids) return identityFail(req, "IDENTITY_REQUIRED");
    const refused = await rebindRefusal(req, claims);
    if (refused) return refused;
    const visitorId = claims.v;
    if (limiter && !(await limiter(`${visitorId}|${clientIp(req)}`, "chat"))) return fail(req, 429, "Too many messages, please wait a moment", "rate_limited");
    const { creds, byo: isByo, error } = resolveCreds(req);
    if (error) return fail(req, 400, error, "bad_credentials");
    if (!creds && !ccp) return fail(req, 500, "Gateway is not configured", "not_configured");

    const body: any = await req.json().catch(() => null);
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return fail(req, 400, "Message is required");
    if (message.length > o.maxMessageLength) return fail(req, 413, `Message exceeds ${o.maxMessageLength} characters`, "too_long");
    // CCP accepts 8 to 64 characters; a shorter id the browser chose counts as invalid and is replaced.
    const idRe = ccp ? CCP_ID_RE : ID_RE;
    const conversationId = typeof body?.conversationId === "string" && idRe.test(body.conversationId) ? body.conversationId : randomId(9);
    const agent = ccp ? ccpAgentFor(req, claims, body?.agent) : await agentFor(claims, body?.agent, creds, isByo);
    if (agent instanceof Response) return agent;
    if (agent === null) return fail(req, 403, "Agent not allowed", "agent_not_allowed");

    // Page actions: the manifest (no handlers) and page context become a delimited block in front of the
    // visitor's message. The manifest is repeated only when its hash differs from the one the widget
    // reports as already delivered in this conversation.
    let pageBlock = "";
    let actionsHash: string | undefined;
    try {
      const manifest = body?.actions != null ? normalizeManifest(body.actions) : undefined;
      const pageContext = serializePageContext(body?.pageContext);
      if (manifest?.length) actionsHash = await hashManifest(manifest);
      pageBlock = buildPageBlock({ manifest, hash: actionsHash, includeManifest: body?.actionsHash !== actionsHash, pageContext });
    } catch (e) {
      if (e instanceof ActionInputError) return fail(req, e.status, e.message, e.code);
      throw e;
    }

    if (ccp) return ccpChat(req, claims, { message: pageBlock + message, rawMessage: message, conversationId, agent, actionsHash });
    if (!creds) return fail(req, 500, "Gateway is not configured", "not_configured"); // narrowing only: checked above

    // A signed-in user's session is checked before streaming starts, so an expired or revoked
    // session answers with a typed HTTP error the widget can act on (re-request /session).
    let connection: GatewayConnection | undefined;
    if (claims.ids) {
      try {
        connection = await GatewayConnection.connect(creds, { identitySession: claims.ids });
      } catch (e) {
        return gatewayFail(req, e, claims.ids);
      }
    }

    const sessionKey = buildSessionKey(agent, `webchat-${visitorId}-${conversationId}`);
    const abort = new AbortController();
    req.signal?.addEventListener("abort", () => abort.abort(), { once: true });
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (e: ChatStreamEvent | string) =>
      writer.write(enc.encode(typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`)).catch(() => abort.abort());

    (async () => {
      const keepAlive = setInterval(() => send(": ping\n\n"), 15000);
      let reply = "";
      let errMsg: string | undefined;
      try {
        await send(actionsHash ? { type: "start", conversationId, agent, actionsHash } : { type: "start", conversationId, agent });
        const who = connection ? { connection } : { userId: o.userIdPrefix + visitorId };
        for await (const ev of streamChat({ creds, ...who, agent, sessionKey, message: pageBlock + message, signal: abort.signal, timeoutMs: o.timeoutMs })) {
          if (ev.type === "start") continue; // already announced with the conversation id
          if (ev.type === "done") reply = ev.content;
          if (ev.type === "error") {
            errMsg = gatewayReasonOf(ev) ?? ev.message; // onChat sees the gateway's reason; the browser does not
            if (claims.ids && ev.code && DEAD_SESSION_CODES.has(ev.code)) forgetCachedSession(claims.ids);
          }
          await send(ev);
          if (abort.signal.aborted) break;
        }
      } catch (e) {
        // A refused connect (anonymous visitors connect inside streamChat) is still an admission refusal.
        const admission = e instanceof GatewayError && isAdmissionErrorCode(e.code) ? admissionErrorEvent(e.code, e.retryAfterMs) : null;
        errMsg = (e as Error).message;
        await send(admission ?? { type: "error", message: errMsg, code: "gateway_error" });
      } finally {
        connection?.close(); // idempotent; covers a turn that ended before the stream took the connection
        clearInterval(keepAlive);
        try { o.onChat?.({ visitorId, agent, message, reply, error: errMsg }); } catch { /* observer errors are ignored */ }
        writer.close().catch(() => {});
      }
    })();

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        ...corsHeaders(req),
      },
    });
  }

  /**
   * CCP: the agent a request names is forwarded for CCP to authorize against the integration's set;
   * a signed-in token stays on the agent its identity session is bound to. "" = the integration default.
   * A name that is not an agent key CCP accepts is refused here (400), one the token may not use is 403.
   */
  function ccpAgentFor(req: Request, claims: VisitorClaims, requested: unknown): string | Response {
    if (requested !== undefined && requested !== null && requested !== "" && (typeof requested !== "string" || !CCP_AGENT_RE.test(requested))) {
      return fail(req, 400, "Invalid agent");
    }
    const asked = (requested as string | undefined) || "";
    if (claims.ids && asked && asked !== claims.ida) return fail(req, 403, "Agent not allowed", "agent_not_allowed");
    return claims.ids ? claims.ida! : asked;
  }

  /** CCP: one turn. CCP's verdict arrives before the stream, so refusals are typed JSON errors. */
  async function ccpChat(
    req: Request,
    claims: VisitorClaims,
    turn: { message: string; rawMessage: string; conversationId: string; agent: string; actionsHash?: string },
  ): Promise<Response> {
    const ctx = visitorContext(req);
    const visitorId = claims.v;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, o.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    };
    let cfg: CcpConfig;
    let upstream: Response;
    try {
      cfg = await ccp!.config();
      if (turn.rawMessage.length > cfg.maxMessageChars) {
        cleanup();
        return fail(req, 413, `Message exceeds ${cfg.maxMessageChars} characters`, "too_long");
      }
      upstream = await ccp!.startChat(ctx, visitorId, sealedEdge(claims), {
        message: turn.message,
        conversationId: turn.conversationId,
        agent: turn.agent || undefined,
        identitySession: claims.ids,
        signal: abort.signal,
      });
    } catch (e) {
      cleanup();
      if (timedOut) return fail(req, 504, "The agent took too long to answer", "timeout");
      if (abort.signal.aborted && !(e instanceof CcpError)) return fail(req, 499, "Request cancelled", "cancelled");
      return ccpFail(req, e, "chat", claims.ids);
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (e: ChatStreamEvent | string) =>
      writer.write(enc.encode(typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`)).catch(() => abort.abort());

    let runId: string | undefined;
    let finished = false;
    abort.signal.addEventListener(
      "abort",
      () => {
        if (finished) return;
        // The browser went away (or the turn timed out): stop the run at CCP too. Cancelling the fetch
        // already tells CCP; the explicit abort covers proxies that keep the upstream open.
        void ccp!.abort(ctx, visitorId, sealedEdge(claims), { conversationId: turn.conversationId, runId, agent: turn.agent || undefined, identitySession: claims.ids });
        // A browser that stopped reading leaves writes pending; release them so the turn ends.
        if (!timedOut) writer.abort().catch(() => {});
      },
      { once: true },
    );

    (async () => {
      const keepAlive = setInterval(() => send(": ping\n\n"), 15000);
      let reply = "";
      let errMsg: string | undefined;
      let agent = turn.agent || cfg.defaultAgent;
      try {
        for await (const ev of ccp!.chatEvents(upstream, cfg, turn.conversationId, agent)) {
          if (ev.type === "start") {
            runId = ev.runId;
            agent = ev.agent;
            await send(turn.actionsHash ? { ...ev, actionsHash: turn.actionsHash } : ev);
            continue;
          }
          if (ev.type === "done") {
            reply = ev.content;
            finished = true;
          }
          if (ev.type === "error") {
            errMsg = ev.message;
            finished = true;
            if (claims.ids && ev.code && DEAD_SESSION_CODES.has(ev.code)) forgetCachedSession(claims.ids);
          }
          await send(ev);
          if (abort.signal.aborted) break;
        }
      } catch (e) {
        if (timedOut) {
          errMsg = "The agent took too long to answer";
          await send({ type: "error", message: errMsg, code: "timeout" });
        } else if (!abort.signal.aborted) {
          console.error("[dewee-webchat] ccp chat stream failed:", (e as Error)?.name ?? "error");
          errMsg = "Dewee is unavailable, try again later";
          await send({ type: "error", message: errMsg, code: "gateway_error" });
          finished = true;
        }
      } finally {
        clearInterval(keepAlive);
        cleanup();
        if (!finished && abort.signal.aborted) errMsg ??= "cancelled";
        finished = true;
        try { o.onChat?.({ visitorId, agent, message: turn.rawMessage, reply, error: errMsg }); } catch { /* observer errors are ignored */ }
        writer.close().catch(() => {});
      }
    })();

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        ...corsHeaders(req),
      },
    });
  }

  /** CCP: the visitor's own conversation. */
  async function ccpHistory(req: Request, claims: VisitorClaims): Promise<Response> {
    const url = new URL(req.url);
    const conversationId = url.searchParams.get("conversationId") || "";
    if (!ID_RE.test(conversationId)) return fail(req, 400, "Invalid conversationId");
    const agent = ccpAgentFor(req, claims, url.searchParams.get("agent"));
    if (agent instanceof Response) return agent;
    // A browser-valid id CCP cannot hold has no conversation yet.
    if (!CCP_ID_RE.test(conversationId)) return json(req, { messages: [] });
    try {
      const messages = await ccp!.history(visitorContext(req), claims.v, sealedEdge(claims), { conversationId, agent: agent || undefined, identitySession: claims.ids });
      return json(req, { messages });
    } catch (e) {
      return ccpFail(req, e, "history", claims.ids);
    }
  }

  async function handleHistory(req: Request): Promise<Response> {
    const claims = await visitorFrom(req);
    if (!claims) return fail(req, 401, "Missing or expired visitor session", "unauthorized");
    if (idn?.required && !claims.ids) return identityFail(req, "IDENTITY_REQUIRED");
    const refused = await rebindRefusal(req, claims);
    if (refused) return refused;
    const visitorId = claims.v;
    const { creds, byo: isByo, error } = resolveCreds(req);
    if (error) return fail(req, 400, error, "bad_credentials");
    if (ccp) return ccpHistory(req, claims);
    if (!creds) return fail(req, 500, "Gateway is not configured", "not_configured");
    const url = new URL(req.url);
    const conversationId = url.searchParams.get("conversationId") || "";
    if (!ID_RE.test(conversationId)) return fail(req, 400, "Invalid conversationId");
    const agent = await agentFor(claims, url.searchParams.get("agent"), creds, isByo);
    if (!agent) return fail(req, 403, "Agent not allowed", "agent_not_allowed");
    try {
      const messages = await fetchHistory(creds, actorOf(claims), agent, buildSessionKey(agent, `webchat-${visitorId}-${conversationId}`));
      return json(req, { messages });
    } catch (e) {
      // A conversation that has not sent its first message yet does not exist on the gateway.
      if ((e as GatewayError).code === "NOT_FOUND") return json(req, { messages: [] });
      return gatewayFail(req, e, claims.ids);
    }
  }

  /** A launch is a human browser action, checked against the current login even when chat rebind is optional. */
  async function handleJobAccess(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    try {
      const parsed = new URL(origin ?? "");
      if (parsed.protocol !== "https:" || parsed.origin !== origin) return fail(req, 403, "Open job access from your signed-in chat", "forbidden_origin");
    } catch { return fail(req, 403, "Open job access from your signed-in chat", "forbidden_origin"); }
    const claims = await visitorFrom(req);
    if (!claims?.ids || !claims.ida) return identityFail(req, "IDENTITY_REQUIRED");
    const refused = await rebindRefusal(req, claims, true);
    if (refused) return refused;
    const agent = ccp ? ccpAgentFor(req, claims, claims.ida) : await agentFor(claims, claims.ida, serverCreds(), false);
    if (agent instanceof Response) return agent;
    if (!agent) return fail(req, 403, "Agent not allowed", "agent_not_allowed");
    if (limiter && !(await limiter(`visitor:${claims.v}`, "link"))) return fail(req, 429, "Too many requests, try again later", "rate_limited");
    let body: unknown;
    try { body = await req.json(); } catch { return fail(req, 400, "Invalid request", "invalid_request"); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) return fail(req, 400, "Invalid request", "invalid_request");
    try {
      const launch = ccp
        ? await ccp.jobAccess(visitorContext(req), claims.v, sealedEdge(claims), { identitySession: claims.ids, agent })
        : await mintJobAccess(o.gatewayUrl!, claims.ids, origin!);
      return json(req, launch);
    } catch (error) {
      if (error instanceof JobAccessRefusal) return identityFail(req, error.code);
      if (error instanceof CcpError) return ccpFail(req, error, "job-access", claims.ids);
      return fail(req, 502, "Job access is unavailable. Try again later.", "job_access_unavailable");
    }
  }

  /** Web-first linking: starts a Dewee link for the signed-in user and returns the proof code. */
  async function handleLink(req: Request): Promise<Response> {
    const claims = await visitorFrom(req);
    if (!claims?.ids) return identityFail(req, "IDENTITY_REQUIRED");
    const refused = await rebindRefusal(req, claims);
    if (refused) return refused;
    // Its own bucket, per user: linking never eats into the session budget, and the reverse.
    if (limiter && !(await limiter(`visitor:${claims.v}`, "link"))) return fail(req, 429, "Too many link requests, slow down", "rate_limited");
    const body: any = await req.json().catch(() => ({}));
    const idempotencyKey = body?.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_RE.test(idempotencyKey))) {
      return fail(req, 400, "idempotencyKey must be 1 to 255 printable ASCII characters without spaces");
    }
    if (ccp) {
      try {
        const res = await ccp.link(visitorContext(req), claims.v, sealedEdge(claims), { identitySession: claims.ids, agent: claims.ida, idempotencyKey });
        return json(req, res);
      } catch (e) {
        return ccpFail(req, e, "link", claims.ids);
      }
    }
    try {
      const link = await idn!.sdk.startLink({ gatewayUrl: o.gatewayUrl!, allowInsecureHttp: idn!.allowInsecureHttp, sessionToken: claims.ids, idempotencyKey });
      const res: LinkResponse = {
        proofCode: link.proofCode,
        expiresAt: link.expiresAt.getTime(),
        deepLinks: link.deepLinks.map((t) => ({ channelType: t.channelType, channelInstanceId: t.channelInstanceId, name: t.name, ...(t.displayName ? { displayName: t.displayName } : {}) })),
      };
      return json(req, res);
    } catch (e) {
      return linkFail(req, e, claims.ids);
    }
  }

  /** Logout hook (see {@link DeweeHandler.revoke}). */
  async function revoke(subject: string, request?: Request, token?: string): Promise<void> {
    if (!idn || typeof subject !== "string" || subject === "") return;
    try {
      const held: Array<{ agent: string; session: CachedSession; edge?: EdgeSession }> = [];
      for (const [k, c] of sessionCache) {
        const cut = k.indexOf("\n");
        if (k.slice(cut + 1) === subject) held.push({ agent: k.slice(0, cut), session: c });
      }
      // The session the logout page sent along (reuse hint or visitor token), when it is this user's.
      if (ccp && typeof token === "string" && token !== "") {
        const c = (await verifyReuseHint(secret!, token)) ?? (await verifyVisitorToken(secret!, token));
        if (c?.ids && c.ida && c.sub && constantTimeEqual(await subjectDigest(secret!, subject), c.sub) && !held.some((h) => h.session.sessionToken === c.ids)) {
          held.push({ agent: c.ida, session: { sessionToken: c.ids, visitorId: c.v, deadline: c.exp, margin: 0 }, edge: sealedEdge(c) });
        }
      }
      for (const { session } of held) forgetCachedSession(session.sessionToken);
      if (!ccp) return; // the legacy gateway has no revoke call; the forgotten sessions expire on their own
      const fromRequest = request ? visitorContext(request) : null;
      await Promise.all(
        held.map(({ agent, session, edge }) => {
          // Without the logout request, CCP is told the origin the session was issued for, so an
          // integration with an origin allowlist still accepts the call.
          const ctx: VisitorContext = fromRequest ?? { visitorOrigin: session.origin, requestId: `dwc-${randomId(12)}` };
          return ccp.revoke(ctx, session.visitorId, edge, session.sessionToken, agent || undefined).catch(() => {});
        }),
      );
    } catch (e) {
      console.warn("[dewee-webchat] revoke failed:", e instanceof CcpError ? e.code : "unexpected error");
    }
  }

  const deweeHandler = async function deweeHandler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (!originAllowed(req)) return fail(req, 403, "Origin not allowed", "forbidden_origin");
    const action = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop();
    try {
      if (req.method === "GET" && action === "config") return await handleConfig(req);
      if (req.method === "POST" && action === "session") return await handleSession(req);
      if (req.method === "POST" && action === "chat") return await handleChat(req);
      if (req.method === "GET" && action === "history") return await handleHistory(req);
      if (req.method === "POST" && action === "link" && idn) return await handleLink(req);
      if (req.method === "POST" && action === "job-access" && idn) return await handleJobAccess(req);
      return fail(req, 404, "Not found", "not_found");
    } catch (e) {
      if (!ccp) return fail(req, 500, (e as Error).message || "Internal error", "internal");
      // CCP: the browser gets no detail, and the log only a CCP error's code (never CCP's text).
      console.error("[dewee-webchat] internal error:", e instanceof CcpError ? e.code : e);
      return fail(req, 500, "Internal error", "internal");
    }
  };
  return Object.assign(deweeHandler, { revoke });
}

/** Reads options from environment variables (process.env, Workers env, import.meta.env…). */
export function optionsFromEnv(env: Record<string, string | undefined>, overrides: Partial<DeweeHandlerOptions> = {}): DeweeHandlerOptions {
  const list = (v?: string) => v?.split(",").map((s) => s.trim()).filter(Boolean);
  const agents = env.DEWEE_AGENTS?.trim() === "*" ? "*" : list(env.DEWEE_AGENTS);
  const origins = env.DEWEE_ALLOWED_ORIGINS?.trim() === "*" ? "*" : list(env.DEWEE_ALLOWED_ORIGINS);
  const byoHosts = list(env.DEWEE_CLIENT_CREDENTIAL_HOSTS);
  const ccpEnv = {
    chatUrl: env.DEWEE_CCP_CHAT_URL?.trim() || undefined,
    integrationId: env.DEWEE_WEBCHAT_INTEGRATION_ID?.trim() || undefined,
    integrationSecret: env.DEWEE_WEBCHAT_INTEGRATION_SECRET?.trim() || undefined,
  };
  const transport = env.DEWEE_WEBCHAT_TRANSPORT?.trim() || undefined;
  return {
    // Validated by createDeweeHandler, which refuses unknown values.
    transport: transport as DeweeTransport | undefined,
    // Partial CCP settings are kept so createDeweeHandler can name the missing variable.
    ccp: ccpEnv.chatUrl || ccpEnv.integrationId || ccpEnv.integrationSecret ? (ccpEnv as CcpOptions) : undefined,
    gatewayUrl: env.DEWEE_GATEWAY_URL || env.GOCLAW_GATEWAY_URL,
    token: env.DEWEE_GATEWAY_TOKEN || env.GOCLAW_GATEWAY_TOKEN,
    tenantId: env.DEWEE_TENANT_ID,
    secret: env.DEWEE_WEBCHAT_SECRET,
    agents,
    defaultAgent: env.DEWEE_DEFAULT_AGENT,
    allowedOrigins: origins,
    allowClientCredentials: env.DEWEE_ALLOW_CLIENT_CREDENTIALS === "true" ? (byoHosts?.length ? { allowedHosts: byoHosts } : true) : false,
    turnstile: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? { siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY } : undefined,
    // undefined overrides must not erase env-derived values
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };
}

/** Loopback, private, link-local and metadata addresses (plus bare/internal names). */
function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || !h.includes(".") && !h.includes(":")) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h.includes(":") && (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:"));
}
