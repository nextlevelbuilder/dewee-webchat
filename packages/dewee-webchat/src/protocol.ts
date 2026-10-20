// Wire contract shared by the browser widget and every backend (Node/Workers/PHP).
// Keep in sync with php/dewee-webchat.php and docs/http-contract.md.

/** Server-Sent Events emitted by `POST {basePath}/chat`. */
export type ChatStreamEvent =
  | { type: "start"; runId?: string; conversationId: string; agent: string; actionsHash?: string }
  | { type: "thinking"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments?: unknown }
  | { type: "tool_result"; id: string; name: string; isError: boolean; result?: string }
  | { type: "done"; content: string; usage?: Record<string, number> }
  | { type: "error"; message: string; code?: string; remediation?: Remediation };

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

/** What to do about an identity error: `action` (e.g. `reauthenticate`, `retry_later`) and who acts (`end_user`, `operator`, `integrator`). */
export interface Remediation {
  action: string;
  audience: string;
}

/** Error body of every JSON route. `remediation` is present for identity errors only. */
export interface ErrorBody {
  error: { message: string; code: string; remediation?: Remediation };
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
  /** Present (true) when the backend signs users in through Dewee: the widget then asks `/session` on every page load. */
  identity?: boolean;
}

/** Response of `POST {basePath}/session`. */
export interface SessionResponse {
  visitorId: string;
  token: string;
  expiresAt: number;
  /** Present (true) when the session carries a verified Dewee identity. Such sessions are short-lived and never persisted. */
  verified?: boolean;
  /**
   * Verified sessions only: milliseconds the session stays valid, counted from when the response is
   * received. The widget refreshes from this rather than `expiresAt`, so a skewed browser clock does not
   * matter.
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
}

export const HEADER_GATEWAY_URL = "x-dewee-gateway-url";
export const HEADER_GATEWAY_TOKEN = "x-dewee-gateway-token";
export const VERSION = "__DEWEE_WEBCHAT_VERSION__";
