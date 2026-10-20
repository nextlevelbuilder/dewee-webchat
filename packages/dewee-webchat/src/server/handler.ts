// Framework-agnostic backend: (Request) => Promise<Response>.
// Routes are matched by the last path segment, so mount it under any prefix
// (e.g. /api/dewee/[...path]): GET config | POST session | POST chat | GET history | POST link (identity) | OPTIONS.
import {
  HEADER_GATEWAY_TOKEN,
  HEADER_GATEWAY_URL,
  VERSION,
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
import {
  deriveVisitorId,
  memoryRateLimiter,
  randomId,
  signVisitorToken,
  constantTimeEqual,
  subjectDigest,
  verifyTurnstile,
  verifyVisitorToken,
  type RateLimiter,
  type VisitorClaims,
} from "./security";

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
  /** The agent identity sessions are bound to. Default: `defaultAgent`, else the first of `agents`. */
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

export interface DeweeHandlerOptions {
  /** Gateway runtime origin. Required unless every request brings its own credentials. */
  gatewayUrl?: string;
  /** Gateway token or operator API key (server-side only). */
  token?: string;
  tenantId?: string;
  /** HMAC secret for visitor tokens (>= 32 random chars). */
  secret?: string;
  /** Agents visitors may talk to. The first is the default. `"*"` = every active agent. */
  agents?: Array<string | AgentInfo> | "*";
  defaultAgent?: string;
  /** Let the widget switch between allowed agents. Default: true when more than one agent. */
  allowAgentSwitch?: boolean;
  /** Cross-origin sites allowed to call this backend. Same-origin is always allowed. */
  allowedOrigins?: string[] | "*";
  /**
   * Let visitors bring their own gateway URL + token (sent per request, never stored).
   * Meant for playgrounds. `allowedHosts` restricts which gateways may be targeted.
   */
  allowClientCredentials?: boolean | { allowedHosts?: string[] };
  /** Cloudflare Turnstile. When set, issuing a visitor session requires a valid challenge. */
  turnstile?: { siteKey: string; secretKey: string };
  /**
   * Custom limiter, or false to disable. Default (in memory): 20 messages/min per visitor and IP,
   * 10 new sessions/10 min per IP and, with `identity`, 120 `authenticate` calls/min per IP,
   * 30 signed-in sessions/10 min per user and 5 link starts/10 min per user.
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

type Handler = (request: Request) => Promise<Response>;

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]{1,255}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** HTTP status and fallback text of each identity error. The widget shows its own localized copy. */
const IDENTITY_ERRORS: Record<IdentityErrorCode, { status: number; message: string; action: string }> = {
  IDENTITY_REQUIRED: { status: 401, message: "Sign in to continue.", action: "reauthenticate" },
  LINK_EXPIRED: { status: 401, message: "Your session expired.", action: "reauthenticate" },
  LINK_REVOKED: { status: 401, message: "Your access was revoked.", action: "reauthenticate" },
  IDENTITY_LINK_REQUIRED: { status: 403, message: "Link your account to continue.", action: "send_connect_link" },
  PERMISSION_DENIED: { status: 403, message: "You are not allowed to do this.", action: "contact_admin" },
  IDENTITY_CONFLICT: { status: 409, message: "This account is linked to another user.", action: "contact_admin" },
  SOURCE_UNAVAILABLE: { status: 503, message: "Your sign-in could not be checked. Try again later.", action: "retry_later" },
};

/** Identity errors after which a cached identity session is dropped. */
const DEAD_SESSION_CODES = new Set(["IDENTITY_REQUIRED", "LINK_EXPIRED", "LINK_REVOKED"]);
/** Gateway default identity session lifetime, used when the expiry cannot be trusted (clock skew). */
const DEFAULT_IDENTITY_TTL_MS = 3600_000;
const MAX_IDENTITY_TTL_MS = 43_200_000;
/** Most identity sessions kept for reuse; each is a few hundred bytes. */
const MAX_CACHED_SESSIONS = 1000;
/** An anonymous token this far from expiry is handed back as is instead of minting a new one. */
const ANON_REUSE_MS = 86_400_000;

/** Validates the identity options once, at startup, and returns the agent sessions are bound to. */
function checkIdentityOptions(o: DeweeHandlerOptions, staticAgents: AgentInfo[]): string {
  const idn = o.identity!;
  const refuse = (why: string): never => {
    throw new Error(`[dewee-webchat] identity: ${why}`);
  };
  if (o.allowClientCredentials) refuse("cannot be combined with allowClientCredentials (a visitor-chosen gateway must never receive a user's session)");
  if (!o.gatewayUrl || !o.token) refuse("needs the server's own gatewayUrl and token");
  if (!idn.sdk || typeof idn.sdk.exchangeSession !== "function" || typeof idn.sdk.startLink !== "function") {
    refuse('sdk is required: import { deweeIdentitySdk } from "dewee-webchat/server/identity" (needs the @dewee/identity package)');
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
  const agent = idn.agent || o.defaultAgent || staticAgents[0]?.id;
  if (!agent || !AGENT_RE.test(agent)) refuse("no agent to bind sessions to: set identity.agent, defaultAgent or agents");
  if (staticAgents.length && !staticAgents.some((a) => a.id === agent)) refuse(`agent "${agent}" is not in agents`);
  return agent!;
}

export function createDeweeHandler(options: DeweeHandlerOptions): Handler {
  const o = {
    maxMessageLength: 4000,
    userIdPrefix: "webchat-",
    sessionTtlMs: 30 * 24 * 3600 * 1000,
    timeoutMs: 180000,
    ...options,
  };
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
  const identityAgent = idn ? checkIdentityOptions(o, staticAgents) : "";

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

  const json = (req: Request, body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders(req) },
    });
  const fail = (req: Request, status: number, message: string, code = "bad_request") => json(req, { error: { message, code } }, status);

  /** A typed identity error: `{error: {message, code, remediation}}`. Never carries a token or secret. */
  const identityFail = (req: Request, code: IdentityErrorCode, remediation?: Remediation) => {
    const e = IDENTITY_ERRORS[code];
    return json(req, { error: { message: e.message, code, remediation: remediation ?? { action: e.action, audience: "end_user" } } }, e.status);
  };

  const misconfigured = (req: Request) => fail(req, 500, "Signed-in chat is misconfigured on this server", "identity_misconfigured");

  /**
   * Gateway WebSocket failure: identity codes are forwarded typed, anything else stays a gateway error.
   * A dead identity session is dropped from the reuse cache.
   */
  const gatewayFail = (req: Request, e: unknown, sessionToken?: string) => {
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
  async function rebindRefusal(req: Request, claims: VisitorClaims): Promise<Response | null> {
    if (!idn?.rebindEachRequest || !claims.ids) return null;
    const throttled = await preauthRefusal(req);
    if (throttled) return throttled;
    let user: AuthenticatedUser | null;
    try {
      user = await idn.authenticate(req);
    } catch (e) {
      console.warn("[dewee-webchat] identity.authenticate failed:", e);
      return identityFail(req, "SOURCE_UNAVAILABLE", { action: "retry_later", audience: "end_user" });
    }
    const same =
      !!user && typeof user.subject === "string" && !!claims.sub && constantTimeEqual(await subjectDigest(secret!, user.subject), claims.sub);
    return same ? null : identityFail(req, "IDENTITY_REQUIRED");
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
  interface CachedSession { sessionToken: string; visitorId: string; deadline: number; margin: number }
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

  async function exchangeFor(subject: string): Promise<CachedSession> {
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

  /** A signed-in user's identity session, reused or exchanged, wrapped in a visitor token. */
  async function issueIdentitySession(req: Request, subject: string): Promise<Response> {
    const key = `${identityAgent}\n${subject}`;
    let s = sessionCache.get(key);
    if (!s || s.deadline - Date.now() <= s.margin) {
      let pending = exchanges.get(key);
      if (!pending) {
        pending = exchangeFor(subject).finally(() => exchanges.delete(key));
        exchanges.set(key, pending);
      }
      try {
        s = await pending;
      } catch (e) {
        return exchangeFail(req, e);
      }
      rememberSession(key, s);
    }
    const now = Date.now();
    const expiresAt = Math.min(s.deadline, now + o.sessionTtlMs);
    const sub = await subjectDigest(secret!, subject);
    const token = await signVisitorToken(secret!, { v: s.visitorId, exp: expiresAt, ids: s.sessionToken, ida: identityAgent, sub });
    const body: SessionResponse = { visitorId: s.visitorId, token, expiresAt, verified: true, expiresIn: expiresAt - now };
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

  /** Cloudflare Turnstile, when configured. */
  async function turnstilePassed(body: any, ip: string): Promise<boolean> {
    if (!o.turnstile) return true;
    return !!body?.turnstileToken && (await verifyTurnstile(o.turnstile.secretKey, String(body.turnstileToken), ip));
  }

  async function handleSession(req: Request): Promise<Response> {
    if (idn) return handleIdentitySession(req);
    const ip = clientIp(req);
    if (limiter && !(await limiter(ip, "session"))) return fail(req, 429, "Too many sessions, slow down", "rate_limited");
    const body: any = await req.json().catch(() => ({}));
    return issueAnonymousSession(req, body, ip);
  }

  async function issueAnonymousSession(req: Request, body: any, ip: string): Promise<Response> {
    if (!(await turnstilePassed(body, ip))) return fail(req, 403, "Verification failed", "turnstile_failed");
    // Refresh an existing visitor instead of minting a new identity, so history survives.
    // A signed-in user's token never seeds an anonymous visitor.
    const previous = typeof body?.token === "string" ? await verifyVisitorToken(secret!, body.token) : null;
    const visitorId = (previous && !previous.ids ? previous.v : undefined) ?? randomId(16);
    const expiresAt = Date.now() + o.sessionTtlMs;
    return json(req, { visitorId, token: await signVisitorToken(secret!, { v: visitorId, exp: expiresAt }), expiresAt });
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
      return issueIdentitySession(req, user.subject);
    }
    if (idn!.required) return identityFail(req, "IDENTITY_REQUIRED");
    const previous = typeof body?.token === "string" ? await verifyVisitorToken(secret!, body.token) : null;
    if (previous && !previous.ids && previous.exp - Date.now() > ANON_REUSE_MS) {
      const reused: SessionResponse = { visitorId: previous.v, token: body.token, expiresAt: previous.exp };
      return json(req, reused);
    }
    if (limiter && !(await limiter(ip, "session"))) return fail(req, 429, "Too many sessions, slow down", "rate_limited");
    return issueAnonymousSession(req, body, ip);
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
    if (!creds) return fail(req, 500, "Gateway is not configured", "not_configured");

    const body: any = await req.json().catch(() => null);
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return fail(req, 400, "Message is required");
    if (message.length > o.maxMessageLength) return fail(req, 413, `Message exceeds ${o.maxMessageLength} characters`, "too_long");
    const conversationId = typeof body?.conversationId === "string" && ID_RE.test(body.conversationId) ? body.conversationId : randomId(9);
    const agent = await agentFor(claims, body?.agent, creds, isByo);
    if (!agent) return fail(req, 403, "Agent not allowed", "agent_not_allowed");

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
            errMsg = ev.message;
            if (claims.ids && ev.code && DEAD_SESSION_CODES.has(ev.code)) forgetCachedSession(claims.ids);
          }
          await send(ev);
          if (abort.signal.aborted) break;
        }
      } catch (e) {
        errMsg = (e as Error).message;
        await send({ type: "error", message: errMsg, code: "gateway_error" });
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

  async function handleHistory(req: Request): Promise<Response> {
    const claims = await visitorFrom(req);
    if (!claims) return fail(req, 401, "Missing or expired visitor session", "unauthorized");
    if (idn?.required && !claims.ids) return identityFail(req, "IDENTITY_REQUIRED");
    const refused = await rebindRefusal(req, claims);
    if (refused) return refused;
    const visitorId = claims.v;
    const { creds, byo: isByo, error } = resolveCreds(req);
    if (error) return fail(req, 400, error, "bad_credentials");
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

  return async function deweeHandler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (!originAllowed(req)) return fail(req, 403, "Origin not allowed", "forbidden_origin");
    const action = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop();
    try {
      if (req.method === "GET" && action === "config") return await handleConfig(req);
      if (req.method === "POST" && action === "session") return await handleSession(req);
      if (req.method === "POST" && action === "chat") return await handleChat(req);
      if (req.method === "GET" && action === "history") return await handleHistory(req);
      if (req.method === "POST" && action === "link" && idn) return await handleLink(req);
      return fail(req, 404, "Not found", "not_found");
    } catch (e) {
      return fail(req, 500, (e as Error).message || "Internal error", "internal");
    }
  };
}

/** Reads options from environment variables (process.env, Workers env, import.meta.env…). */
export function optionsFromEnv(env: Record<string, string | undefined>, overrides: Partial<DeweeHandlerOptions> = {}): DeweeHandlerOptions {
  const list = (v?: string) => v?.split(",").map((s) => s.trim()).filter(Boolean);
  const agents = env.DEWEE_AGENTS?.trim() === "*" ? "*" : list(env.DEWEE_AGENTS);
  const origins = env.DEWEE_ALLOWED_ORIGINS?.trim() === "*" ? "*" : list(env.DEWEE_ALLOWED_ORIGINS);
  const byoHosts = list(env.DEWEE_CLIENT_CREDENTIAL_HOSTS);
  return {
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
