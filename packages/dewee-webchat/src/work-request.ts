// Work requests: business requests a visitor confirms in the widget ("call me back"), stored by the
// control plane as their own records, apart from the conversation and from any human takeover. This
// module holds the browser shapes, their parsers (used by the TypeScript host and the widget alike) and
// the limits a visitor's form is checked against before it is sent.

/** Request kinds the integration lets a visitor create (`/config` `workRequests`). */
export interface WorkRequestKind {
  /** Workspace-defined slug, e.g. `callback`. */
  kind: string;
  /** What the widget calls it (the workspace's title). */
  title: string;
  /** The payload schema: `callback` has a form in the widget, `generic` only receipts. */
  schema: "callback" | "generic";
  /** Someone who would answer is on duty and the kind's working window is open. A hint for wording only. */
  staffedNow: boolean;
}

/**
 * A request's state as the visitor sees it. Only `resolved` and `cancelled` are final. `updated` stands
 * for a state the control plane added after this version: the request is shown, neutrally, never dropped.
 */
export type WorkRequestState = "received" | "in_progress" | "waiting" | "resolved" | "cancelled" | "updated";

export const WORK_REQUEST_STATES: readonly WorkRequestState[] = ["received", "in_progress", "waiting", "resolved", "cancelled", "updated"];
/** What a state this version does not know looks like (it is shown as `updated`). */
const FUTURE_STATE_RE = /^[a-z][a-z_]{0,31}$/;

/**
 * A receipt: what the visitor may see of one of their requests. Never the assignee, an internal note,
 * the payload or the raw contact value (`contactHint` is `***` plus its last three characters).
 */
export interface WorkRequestView {
  /** `WR-` plus 8 Crockford base32 characters; exists only once the server stored the request. */
  code: string;
  kind: string;
  summary: string;
  state: WorkRequestState;
  receivedAt: string;
  /** When the business committed to answer (ISO 8601); empty when the kind sets no due time. */
  respondDueAt: string;
  /** IANA time zone of the business the due time is set in, e.g. `Asia/Ho_Chi_Minh`. */
  dueTimezone: string;
  publicNote: string;
  contactHint: string;
  updatedAt: string;
}

/** Body of `POST {basePath}/work-requests`. */
export interface WorkRequestCreateBody {
  kind: string;
  /** 1..500 characters. */
  summary: string;
  /** Validated by the kind's schema on the server (`callback`: see {@link CallbackPayload}). */
  payload: Record<string, unknown>;
  /** One per confirmed intent, `^[A-Za-z0-9._:-]{8,128}$`; a retry of the same intent sends the same key. */
  idempotencyKey: string;
  /** One of the visitor's own conversations with `agent`, when the request belongs to it. */
  conversationId?: string;
  agent?: string;
}

/** Answer of `POST {basePath}/work-requests`: `201` for a new request, `200` with `replayed` for a retry. */
export interface WorkRequestCreateResponse {
  workRequest: WorkRequestView;
  replayed: boolean;
}

/** Body of `POST {basePath}/work-requests/list`. */
export interface WorkRequestListBody {
  conversationId?: string;
  idempotencyKey?: string;
  /** 1..100, default 50. */
  limit?: number;
  agent?: string;
}

/** Answer of `POST {basePath}/work-requests/list`: the visitor's own requests, newest first. */
export interface WorkRequestListResponse {
  workRequests: WorkRequestView[];
}

/** The `callback` payload. */
export interface CallbackPayload {
  contact_method: CallbackContactMethod;
  contact_value: string;
  purpose: string;
  consent: true;
}

export type CallbackContactMethod = "phone" | "zalo" | "email";
export const CALLBACK_CONTACT_METHODS: readonly CallbackContactMethod[] = ["phone", "zalo", "email"];

/** Bounds of the control plane (characters are Unicode code points, as the server counts them). */
export const WORK_REQUEST_LIMITS = {
  summaryChars: 500,
  purposeChars: 500,
  contactValueChars: 254,
  phoneChars: 32,
  payloadBytes: 16 * 1024,
} as const;

export const WORK_REQUEST_KIND_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const WORK_REQUEST_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
export const WORK_REQUEST_CODE_RE = /^WR-[0-9A-HJKMNP-TV-Z]{8}$/;
/** A workspace member linking code is never sent in a request (the server refuses it too). */
export const MEMBER_PROOF_RE = /MEM-[A-Z2-7]{16}/i;

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** A string within `max` UTF-16 units, else empty: a field that is not one is dropped, never cut. */
const field = (v: unknown, max: number): string => (typeof v === "string" && v.length <= max ? v : "");

/** Builds a view from known fields only, or null without a valid code and a known state. */
function view(raw: unknown, snake: boolean): WorkRequestView | null {
  const r = record(raw);
  if (!r) return null;
  const pick = (camel: string, under: string) => r[snake ? under : camel];
  const code = r.code;
  const state = r.state;
  if (typeof code !== "string" || !WORK_REQUEST_CODE_RE.test(code) || typeof state !== "string" || !FUTURE_STATE_RE.test(state)) return null;
  const kind = field(r.kind, 64);
  return {
    code,
    kind: WORK_REQUEST_KIND_RE.test(kind) ? kind : "",
    summary: field(r.summary, 2000),
    state: (WORK_REQUEST_STATES as readonly string[]).includes(state) ? (state as WorkRequestState) : "updated",
    receivedAt: field(pick("receivedAt", "received_at"), 64),
    respondDueAt: field(pick("respondDueAt", "respond_due_at"), 64),
    dueTimezone: field(pick("dueTimezone", "due_timezone"), 64),
    publicNote: field(pick("publicNote", "public_note"), 2000),
    contactHint: field(pick("contactHint", "contact_hint"), 16),
    updatedAt: field(pick("updatedAt", "updated_at"), 64),
  };
}

/** A view as the control plane sends it (snake_case), rebuilt for the browser. */
export function workRequestFromCcp(raw: unknown): WorkRequestView | null {
  return view(raw, true);
}

/** A view as a backend sent it to the browser (camelCase). */
export function parseWorkRequestView(raw: unknown): WorkRequestView | null {
  return view(raw, false);
}

/** Offered kinds; at most 50, each kind once, unknown schemas dropped. `snake`: the control plane's shape. */
export function parseWorkRequestKinds(raw: unknown, snake: boolean): WorkRequestKind[] {
  const out: WorkRequestKind[] = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, 50) : []) {
    const k = record(item);
    if (!k || typeof k.kind !== "string" || !WORK_REQUEST_KIND_RE.test(k.kind) || out.some((x) => x.kind === k.kind)) continue;
    if (k.schema !== "callback" && k.schema !== "generic") continue;
    const title = field(k.title, 200).trim();
    out.push({ kind: k.kind, title: title || k.kind, schema: k.schema, staffedNow: (snake ? k.staffed_now : k.staffedNow) === true });
  }
  return out;
}

/** Characters as the server counts them (code points). */
export const codePoints = (s: string): number => [...s].length;

/** Valid UTF-8-encodable text within `max` code points, without control characters other than tab and newlines. */
export function boundedText(s: string, max: number): boolean {
  // eslint-disable-next-line no-control-regex
  return codePoints(s) <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s) && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}

/** A phone or Zalo number as the server accepts it: digits with common separators, 6 to 15 digits. */
export function validPhone(v: string): boolean {
  if (!v || codePoints(v) > WORK_REQUEST_LIMITS.phoneChars || !/^\+?[0-9][0-9 ().-]*$/.test(v)) return false;
  const digits = v.replace(/[^0-9]/g, "").length;
  return digits >= 6 && digits <= 15;
}

/** A plain address (no display name), with a dot in its domain. */
export function validEmail(v: string): boolean {
  return !!v && codePoints(v) <= WORK_REQUEST_LIMITS.contactValueChars && /^[^\s@<>"(),;:\\[\]]+@[^\s@<>"(),;:\\[\]]+\.[^\s@<>"(),;:\\[\]]+$/.test(v);
}

/** Which callback field a visitor must fix, or null when the form can be sent. */
export function callbackFieldError(input: { method: string; contact: string; purpose: string; consent: boolean }): "contact_method" | "contact_value" | "purpose" | "consent" | null {
  if (!(CALLBACK_CONTACT_METHODS as readonly string[]).includes(input.method)) return "contact_method";
  const contact = input.contact.trim();
  if (input.method === "email" ? !validEmail(contact) : !validPhone(contact)) return "contact_value";
  const purpose = input.purpose.trim();
  if (!purpose || !boundedText(purpose, WORK_REQUEST_LIMITS.purposeChars) || MEMBER_PROOF_RE.test(purpose)) return "purpose";
  if (!input.consent) return "consent";
  return null;
}
