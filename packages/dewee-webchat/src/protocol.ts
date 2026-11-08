// Wire contract shared by the browser widget and every backend (Node/Workers/PHP).
// Keep in sync with php/dewee-webchat.php and docs/http-contract.md.

/** Server-Sent Events emitted by `POST {basePath}/chat`. */
export type ChatStreamEvent =
  | { type: "start"; runId?: string; conversationId: string; agent: string; actionsHash?: string }
  | { type: "thinking"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments?: unknown }
  | { type: "tool_result"; id: string; name: string; isError: boolean; result?: string }
  | { type: "credential_request"; credentialRequest: import("./credential-request").CredentialRequestView }
  | { type: "done"; content: string; usage?: Record<string, number> }
  | { type: "error"; message: string; code?: string; remediation?: Remediation; retryAfterMs?: number };

/** The seven typed identity errors of the Dewee gateway, forwarded as `error.code` for signed-in users. */
export const IDENTITY_ERROR_CODES = [
  "IDENTITY_REQUIRED",
  "IDENTITY_LINK_REQUIRED",
  "IDENTITY_CONFLICT",
  "LINK_EXPIRED",
  "LINK_REVOKED",
  "PERMISSION_DENIED",
  "SOURCE_UNAVAILABLE",
] as const;

export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number];

export function isIdentityErrorCode(code: unknown): code is IdentityErrorCode {
  return typeof code === "string" && (IDENTITY_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Admission refusals of the gateway for `chat.send`, forwarded as `error.code`: `POLICY_DENIED` (the
 * message is outside the policy, e.g. too long; not retryable) and `RATE_LIMITED` (rate limit, a run
 * still answering the previous message, or the counter backend unavailable; carries `retryAfterMs`).
 * `CHALLENGE_REQUIRED` is reserved for the gateway challenge protocol and carries no payload yet.
 */
export const ADMISSION_ERROR_CODES = ["POLICY_DENIED", "RATE_LIMITED", "CHALLENGE_REQUIRED"] as const;

export type AdmissionErrorCode = (typeof ADMISSION_ERROR_CODES)[number];

export function isAdmissionErrorCode(code: unknown): code is AdmissionErrorCode {
  return typeof code === "string" && (ADMISSION_ERROR_CODES as readonly string[]).includes(code);
}

/** What to do about an identity error: `action` (e.g. `reauthenticate`, `retry_later`) and who acts (`end_user`, `operator`, `integrator`). */
export interface Remediation {
  action: string;
  audience: string;
}

/**
 * Error body of every JSON route. `remediation` is present for identity errors only, `retryAfterMs`
 * for `RATE_LIMITED` refusals of the gateway (also sent as the `Retry-After` header, in seconds).
 */
export interface ErrorBody {
  error: { message: string; code: string; remediation?: Remediation; retryAfterMs?: number };
}

export interface AgentInfo {
  id: string;
  name?: string;
  description?: string;
}

/** Response of `GET {basePath}/config` — safe to expose publicly. */
export interface PublicConfig {
  agents: AgentInfo[];
  defaultAgent: string;
  allowAgentSwitch: boolean;
  allowClientCredentials: boolean;
  turnstileSiteKey?: string;
  maxMessageLength: number;
  version: string;
  /** Attachment versions advertised by the connected runtime. */
  pageContextVersions?: number[];
  /** Present (true) when the backend signs users in through Dewee: the widget then asks `/session` on every page load. */
  identity?: boolean;
  /** Trusted origin of the hosted credential form, present only when explicitly enabled. */
  credentialFormOrigin?: string;
  /**
   * Present (true) when a returning visitor's `/session` refresh (a valid anonymous `token` in the
   * body) needs no Turnstile token (ccp transport); only new visitors are challenged then. With
   * `identity` the widget still challenges: a signed-in user's `/session` always needs a token.
   */
  refreshWithoutTurnstile?: boolean;
}

/** Response of `POST {basePath}/session`. */
export interface SessionResponse {
  visitorId: string;
  token: string;
  /**
   * When the widget should come back to `/session` (refreshing with `token`). With the ccp transport
   * this is when the CCP edge session sealed in the token ends, earlier than the token itself.
   */
  expiresAt: number;
  /**
   * Present (true) when the session carries a verified Dewee identity. Such sessions are short-lived and
   * are used from memory only.
   */
  verified?: boolean;
  /**
   * ccp transport, verified sessions only: an opaque token that lets a later page load of this tab
   * reuse the session instead of exchanging a new one. It is no bearer token (every route but
   * `/session` refuses it), and `/session` uses it only for the user the host authenticates at that
   * moment. The widget keeps it in `sessionStorage` and sends it back as `reuseHint`; it stores
   * nothing when the answer has none (legacy gateway, PHP).
   */
  reuseHint?: string;
  /**
   * Milliseconds until `expiresAt`, counted
   * from when the response is received. The widget refreshes from this rather than `expiresAt`, so a
   * skewed browser clock does not matter.
   */
  expiresIn?: number;
}

/** Error codes of `POST {basePath}/link` besides the identity codes. */
export const LINK_ERROR_CODES = ["idempotency_key_reused", "link_in_progress", "linking_unavailable"] as const;

export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];

export function isLinkErrorCode(code: unknown): code is LinkErrorCode {
  return typeof code === "string" && (LINK_ERROR_CODES as readonly string[]).includes(code);
}

/** A chat account the proof code of a web-first link can be sent to. */
export interface LinkTarget {
  /** e.g. `telegram`, `discord`, `zalo`. */
  channelType: string;
  channelInstanceId: string;
  name: string;
  displayName?: string;
}

/** Response of `POST {basePath}/link`. */
export interface LinkResponse {
  /** Show it exactly as given; the user sends it in a direct chat from the account to link. */
  proofCode: string;
  /** Epoch ms. */
  expiresAt: number;
  deepLinks: LinkTarget[];
}

export interface ToolCallView {
  id: string;
  name: string;
  arguments?: unknown;
  result?: string;
  isError?: boolean;
  status: "running" | "done" | "error";
}

/** A transcript message as returned by `GET {basePath}/history`. */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolCalls?: ToolCallView[];
  createdAt?: string;
}

/** How much an agent-invoked page action can change. `mutate`/`destructive` always need user approval. */
export type ActionSensitivity = "read" | "navigate" | "mutate" | "destructive";

/** What the backend (and the agent) learns about a page action. Handlers never leave the browser. */
export interface ActionManifestEntry {
  name: string;
  description: string;
  /** JSON Schema subset describing `args` (object). */
  parameters: Record<string, unknown>;
  sensitivity: ActionSensitivity;
}

/** Body of `POST {basePath}/chat`. `actions`/`actionsHash`/`pageContext` are optional (page actions). */
export interface ChatRequestBody {
  message: string;
  agent?: string;
  conversationId?: string;
  actions?: ActionManifestEntry[];
  /** Hash from the `start` event of the last completed turn; the manifest is re-sent to the agent only when it differs. */
  actionsHash?: string;
  pageContext?: unknown;
  /** Ephemeral, untrusted content for this turn; distinct from the legacy page-action context. */
  page_context?: import("./widget/page-context").PageContextAttachment;
  credentialRequestId?: string;
}

export const HEADER_GATEWAY_URL = "x-dewee-gateway-url";
export const HEADER_GATEWAY_TOKEN = "x-dewee-gateway-token";
export const VERSION = "__DEWEE_WEBCHAT_VERSION__";
