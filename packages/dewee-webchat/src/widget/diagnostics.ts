// What the widget knows about its own connection, as a host page or an install checker can read it.
// Three separate steps, because "the widget is on the page" is not "the channel answers":
//   config  - the backend's /config answered (the embed points at a working backend)
//   session - a visitor session was opened
//   reply   - the agent answered the last message
// A snapshot holds states and short error codes only: never a token, a key, a URL or message text.

export type CheckState = "idle" | "pending" | "ok" | "failed";
export type CheckStep = "config" | "session" | "reply";

export interface CheckResult {
  state: CheckState;
  /** Why the step failed, e.g. `ORIGIN_NOT_ALLOWED`, `http_503`, `network_error`, `empty_reply`. */
  code?: string;
}

/** `detail` of `dewee:status` and the value of `element.diagnostics()`. */
export interface WidgetDiagnostics {
  /** The element is defined and attached. True in every snapshot: its presence is the signal. */
  embedded: true;
  config: CheckResult;
  session: CheckResult;
  reply: CheckResult;
  /** The backend's package version, once its config loaded. */
  version?: string;
}

const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A short machine-readable reason for a failed request. Never the server's message text. */
export function errorCode(e: unknown): string {
  const x = e as { code?: unknown; status?: unknown } | null;
  if (x && typeof x.code === "string" && CODE_RE.test(x.code)) return x.code;
  if (x && typeof x.status === "number" && x.status >= 100 && x.status <= 599) return `http_${x.status}`;
  return "network_error";
}

export class Diagnostics {
  private steps: Record<CheckStep, CheckResult> = { config: { state: "idle" }, session: { state: "idle" }, reply: { state: "idle" } };
  private version?: string;

  state(step: CheckStep): CheckState {
    return this.steps[step].state;
  }

  /** Records a step. Returns false when nothing changed, so no event is needed. */
  set(step: CheckStep, state: CheckState, code?: string): boolean {
    const next: CheckResult = state === "failed" ? { state, code: code && CODE_RE.test(code) ? code : "network_error" } : { state };
    const current = this.steps[step];
    if (current.state === next.state && current.code === next.code) return false;
    this.steps[step] = next;
    return true;
  }

  setVersion(version: unknown): void {
    this.version = typeof version === "string" && /^[A-Za-z0-9_.+-]{1,64}$/.test(version) ? version : undefined;
  }

  /** A new backend: nothing known about it yet. */
  reset(): void {
    this.steps = { config: { state: "idle" }, session: { state: "idle" }, reply: { state: "idle" } };
    this.version = undefined;
  }

  snapshot(): WidgetDiagnostics {
    return {
      embedded: true,
      config: { ...this.steps.config },
      session: { ...this.steps.session },
      reply: { ...this.steps.reply },
      ...(this.version ? { version: this.version } : {}),
    };
  }
}
