// Page action registry and the execution gate. DOM-free so the confirmation rule is unit-testable:
// a `mutate`/`destructive` handler runs only after the confirm hook resolves to exactly `true`.
import type { ActionManifestEntry, ActionSensitivity } from "../protocol";
import type { ActionResult, ParsedCall } from "./directives";
import { toJsonValue } from "./directives";
import { validateJsonSchema, type JsonSchema } from "./json-schema-subset";
import { ACTION_LIMITS, ACTION_NAME_RE, SENSITIVITIES } from "./page-block";

export interface PageActionContext {
  /** Id the agent gave this call. */
  callId: string;
  conversationId: string;
  agent: string;
  /** Aborted when the visitor stops the run, starts a new conversation, or the handler times out. */
  signal: AbortSignal;
}

export interface PageAction<Args = any> {
  /** `^[a-z][a-z0-9_.-]{0,63}$` */
  name: string;
  /** What the action does, written for the agent. */
  description: string;
  /** JSON Schema subset for `args` (an object schema). */
  parameters?: JsonSchema;
  sensitivity: ActionSensitivity;
  /** Runs in the page. Must return JSON-serializable data. Agent args are untrusted: validate before acting. */
  handler: (args: Args, ctx: PageActionContext) => unknown | Promise<unknown>;
}

/** An action as shown to the confirm hook (no handler). */
export type PageActionInfo = Omit<PageAction, "handler">;

/** Host-owned approval for `mutate`/`destructive` calls. Only a resolved `true` approves. */
export type ActionConfirmHook = (action: PageActionInfo & { callId: string }, args: Record<string, unknown>) => boolean | Promise<boolean>;

export type ActionCallStatus = "pending" | "awaiting-confirmation" | "running" | "done" | "denied" | "error" | "unknown";

const ACTION_ERROR_CODE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * How a handler reports a business failure. A handler that resolves has succeeded, whatever it
 * returns (a returned `{ error }` object is data, as before), so a failed lookup or a refused write
 * must throw:
 *
 *   if (!res.ok) throw new ActionError("not_found", "Order not found");
 *
 * `outcome: "unknown"` is for a write whose answer was lost and could not be reconciled with the
 * server: the agent is told the result is unconfirmed instead of failed, so it does not repeat it.
 */
export class ActionError extends Error {
  readonly code: string;
  readonly outcome: "failed" | "unknown";
  constructor(code: string, message?: string, options: { outcome?: "failed" | "unknown" } = {}) {
    super(message || code);
    this.name = "ActionError";
    this.code = ACTION_ERROR_CODE_RE.test(code) ? code : "action_failed";
    this.outcome = options.outcome === "unknown" ? "unknown" : "failed";
  }
}

/** Duck-typed so an `ActionError` from another copy of the package (CDN + bundle) is still recognised. */
function asActionError(e: unknown): { code: string; outcome: "failed" | "unknown"; message: string } | null {
  const x = e as { name?: unknown; code?: unknown; outcome?: unknown; message?: unknown } | null;
  if (!x || typeof x !== "object" || x.name !== "ActionError" || typeof x.code !== "string" || !ACTION_ERROR_CODE_RE.test(x.code)) return null;
  return { code: x.code, outcome: x.outcome === "unknown" ? "unknown" : "failed", message: typeof x.message === "string" ? x.message : x.code };
}

export const needsConfirmation = (s: ActionSensitivity) => s === "mutate" || s === "destructive";

export class ActionRegistry {
  private map = new Map<string, PageAction>();

  get size(): number { return this.map.size; }
  get(name: string): PageAction | undefined { return this.map.get(name); }
  names(): string[] { return [...this.map.keys()]; }

  /** Adds or replaces actions by name. Throws TypeError on an invalid definition. */
  register(actions: PageAction | PageAction[]): void {
    const list = Array.isArray(actions) ? actions : [actions];
    for (const a of list) assertAction(a);
    if (new Set([...this.map.keys(), ...list.map((a) => a.name)]).size > ACTION_LIMITS.maxActions) {
      throw new TypeError(`dewee-webchat: at most ${ACTION_LIMITS.maxActions} page actions`);
    }
    for (const a of list) this.map.set(a.name, a);
  }

  unregister(name: string): boolean {
    return this.map.delete(name);
  }

  /** What is sent to the backend: everything but the handler. */
  manifest(): ActionManifestEntry[] {
    return [...this.map.values()].map((a) => ({
      name: a.name,
      description: a.description,
      sensitivity: a.sensitivity,
      parameters: a.parameters ?? { type: "object", properties: {} },
    }));
  }
}

function assertAction(a: PageAction): void {
  const fail = (why: string) => { throw new TypeError(`dewee-webchat: invalid page action ${JSON.stringify(a?.name)}: ${why}`); };
  if (!a || typeof a !== "object") fail("not an object");
  if (typeof a.name !== "string" || !ACTION_NAME_RE.test(a.name)) fail("name must match ^[a-z][a-z0-9_.-]{0,63}$");
  if (typeof a.description !== "string" || a.description.length > ACTION_LIMITS.maxDescription) fail(`description must be a string up to ${ACTION_LIMITS.maxDescription} chars`);
  if (!SENSITIVITIES.includes(a.sensitivity)) fail(`sensitivity must be one of ${SENSITIVITIES.join(", ")}`);
  if (typeof a.handler !== "function") fail("handler must be a function");
  if (a.parameters !== undefined && (typeof a.parameters !== "object" || a.parameters === null || Array.isArray(a.parameters))) fail("parameters must be a JSON Schema object");
}

export interface RunCallOptions {
  registry: ActionRegistry;
  confirm: ActionConfirmHook;
  conversationId: string;
  agent: string;
  /** Cancels the whole chain (Stop / new conversation). */
  signal: AbortSignal;
  timeoutMs?: number;
  onStatus?: (status: ActionCallStatus) => void;
}

/** Validates, gates and executes one parsed call. Never throws; always returns a result for the agent. */
export async function runActionCall(call: ParsedCall, o: RunCallOptions): Promise<ActionResult> {
  const fail = (error: string): ActionResult => { o.onStatus?.("error"); return { id: call.id, name: call.name, status: "error", error }; };
  if (!call.ok) return fail(call.error);
  if (o.signal.aborted) return fail("Cancelled");
  const action = o.registry.get(call.name);
  if (!action) return fail(`Unknown action "${call.name}". Available: ${o.registry.names().join(", ") || "none"}`);
  const invalid = validateJsonSchema(call.args, action.parameters ?? { type: "object" });
  if (invalid) return fail(`Invalid arguments: ${invalid}`);

  if (needsConfirmation(action.sensitivity)) {
    o.onStatus?.("awaiting-confirmation");
    const { handler: _omit, ...info } = action;
    let approved = false;
    try {
      approved = (await raceAbort(Promise.resolve(o.confirm({ ...info, callId: call.id }, call.args)), o.signal)) === true;
    } catch {
      approved = false;
    }
    if (!approved || o.signal.aborted) {
      o.onStatus?.("denied");
      return { id: call.id, name: call.name, status: "denied", error: "The user declined this action." };
    }
  }

  o.onStatus?.("running");
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  o.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, o.timeoutMs ?? 30000);
  try {
    const value = await raceAbort(Promise.resolve().then(() => action.handler(call.args, { callId: call.id, conversationId: o.conversationId, agent: o.agent, signal: ctrl.signal })), ctrl.signal);
    o.onStatus?.("done");
    return { id: call.id, name: call.name, status: "ok", result: toJsonValue(value) ?? null };
  } catch (e) {
    const unknown = (error: string, code?: string): ActionResult => {
      o.onStatus?.("unknown");
      return { id: call.id, name: call.name, status: "unknown", error, ...(code ? { code } : {}) };
    };
    if (ctrl.signal.aborted) {
      const why = o.signal.aborted ? "Cancelled" : "Timed out";
      // The handler was already running: a write may have reached the server before it was stopped.
      return needsConfirmation(action.sensitivity) ? unknown(`${why} while running; the outcome is not confirmed`) : fail(why);
    }
    const known = asActionError(e);
    if (!known) return fail(String((e as Error)?.message ?? e).slice(0, 500) || "Action failed");
    const message = known.message.slice(0, 500);
    if (known.outcome === "unknown") return unknown(message, known.code);
    return { ...fail(message), code: known.code };
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", stop);
  }
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
