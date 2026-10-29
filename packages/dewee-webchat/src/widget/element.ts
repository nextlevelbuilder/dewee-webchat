// <dewee-chat> — framework-agnostic chat widget (Shadow DOM, zero dependencies).
import { isAdmissionErrorCode, isIdentityErrorCode, isLinkErrorCode, type ActionSensitivity, type AgentInfo, type ChatRequestBody, type ChatStreamEvent, type HistoryMessage, type LinkResponse, type PublicConfig, type ToolCallView } from "../protocol";
import { ActionRegistry, runActionCall, type ActionCallStatus, type ActionConfirmHook, type PageAction, type PageActionInfo } from "../actions/action-runner";
import {
  formatActionResults,
  isActionResultMessage,
  parseActionResults,
  parseDirectives,
  stripDirectives,
  type ActionResult,
  type ActionResultStatus,
  type ParsedCall,
} from "../actions/directives";
import { ACTION_LIMITS, stripPageBlock } from "../actions/page-block";
import { ApiClient, ApiError, type RequestHeadersOption } from "./api-client";
import { JobAccessPopupError, openJobAccessTicket } from "./job-access";
import { showConfirmDialog } from "./confirm-dialog";
import { icons, pickStrings, type Strings } from "./i18n";
import { renderMarkdown } from "./markdown";
import { SendCooldown } from "./send-cooldown";
import { styles } from "./styles";

/** Pause after a RATE_LIMITED refusal that says nothing about when to retry. */
const DEFAULT_COOLDOWN_MS = 5_000;

export interface DeweeChatConfig {
  /** Backend base URL (the server handler). Default: "/api/dewee". */
  endpoint: string;
  /** Agent key to talk to. Default: the backend's default agent. */
  agent?: string;
  title?: string;
  subtitle?: string;
  /** Welcome heading and text shown before the first message. */
  greeting?: string;
  intro?: string;
  placeholder?: string;
  /** Quick-reply prompts shown on the welcome screen. */
  suggestions?: string[];
  /** Image URL used for the header avatar (and launcher when `launcherAvatar`). */
  avatar?: string;
  launcherAvatar?: boolean;
  position?: "bottom-right" | "bottom-left";
  /** "floating" (launcher + popup) or "inline" (fills its container). */
  mode?: "floating" | "inline";
  theme?: "light" | "dark" | "auto";
  accentColor?: string;
  locale?: string;
  /** Show the model's reasoning stream. Default true. */
  showReasoning?: boolean;
  /** Show tool calls and their results. Default true. */
  showToolCalls?: boolean;
  /** Show an agent picker when the backend allows switching. Default true. */
  allowAgentSwitch?: boolean;
  /** Start opened. */
  open?: boolean;
  /** Remember the conversation across page loads. Default true. */
  persist?: boolean;
  hideBranding?: boolean;
  /** Bring-your-own gateway credentials (backend must enable allowClientCredentials). */
  gatewayUrl?: string;
  gatewayToken?: string;
  width?: string;
  height?: string;
  zIndex?: number;
  /** Page actions the agent may invoke. Replaces the set previously passed through this option. */
  actions?: PageAction[];
  /** Approval for `mutate`/`destructive` actions. Default: the built-in confirm dialog. Only `true` approves. */
  confirm?: ActionConfirmHook;
  /** Small, host-redacted snapshot of page state sent with every message (max 4 KB as JSON). */
  getPageContext?: () => unknown;
  /** Automatic action rounds allowed per visitor message. Default 5. */
  maxActionRounds?: number;
  /** Per-handler timeout. Default 30000 ms. */
  actionTimeoutMs?: number;
  /**
   * Extra headers for every request to `endpoint` (e.g. a CSRF token). A function is called before
   * each request. Cannot override content-type, authorization or the gateway credential headers.
   */
  headers?: RequestHeadersOption;
  /** Replaces `globalThis.fetch` for every widget request (e.g. to add credentials or tracing). */
  fetch?: typeof fetch;
}

/** A page action call as shown in the transcript. */
export interface ActionCallView {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  status: ActionCallStatus;
  error?: string;
}

/** `detail` of the `dewee:action` event (host telemetry). */
export interface ActionEventDetail {
  phase: "start" | "result";
  id: string;
  name: string;
  sensitivity?: ActionSensitivity;
  args?: Record<string, unknown>;
  status?: ActionResultStatus;
  result?: unknown;
  error?: string;
  agent: string;
  conversationId: string;
}

/** Option keys that hold functions/objects: applied without re-rendering the widget. */
type BehaviorKey = "actions" | "confirm" | "getPageContext" | "headers" | "fetch";

interface ViewRefs {
  root: HTMLElement;
  trace: HTMLElement;
  md: HTMLElement;
  thinking?: HTMLDetailsElement;
  tools: Map<string, HTMLDetailsElement>;
  actions: HTMLElement;
}

interface ViewMessage extends HistoryMessage {
  status?: "streaming" | "done" | "error";
  startedAt?: number;
  thinkingMs?: number;
  view?: ViewRefs;
  /** Automatic action-result follow-up: kept in the transcript model, not shown. */
  hidden?: boolean;
  /** Visitor message the gateway refused (POLICY_DENIED): the localized reason shown next to it. */
  refusal?: string;
  /** The visitor pressed Stop: never execute directives from a cut-off answer. */
  stopped?: boolean;
  actionsHash?: string;
  actions?: ActionCallView[];
}

const BOOL_ATTRS = ["show-reasoning", "show-tool-calls", "allow-agent-switch", "open", "persist", "hide-branding", "launcher-avatar"];
const ATTRS = [
  "endpoint", "agent", "title", "subtitle", "greeting", "intro", "placeholder", "suggestions", "avatar", "position",
  "mode", "theme", "accent-color", "locale", "gateway-url", "gateway-token", "width", "height", "z-index", ...BOOL_ATTRS,
];

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const parseBool = (v: string | null) => v !== null && !/^(false|0|off|no)$/i.test(v);
const randomConversationId = () => {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, (x) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[x & 63]).join("");
};
const prettyToolName = (n: string) => n.replace(/^mcp_[^_]+(?:_[^_]+)*?__/, "").replace(/_/g, " ");
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

let turnstileScript: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  return (turnstileScript ??= new Promise((resolve, reject) => {
    if ((window as any).turnstile) return resolve();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load Turnstile"));
    document.head.appendChild(s);
  }));
}

// SSR-safe base: importing the package on a server (Next.js, Astro, Nuxt) must not touch the DOM.
const ElementBase = (typeof HTMLElement === "undefined" ? class {} : HTMLElement) as typeof HTMLElement;

export class DeweeChatElement extends ElementBase {
  static get observedAttributes() { return ATTRS; }

  private root: ShadowRoot;
  private overrides: Partial<DeweeChatConfig> = {};
  private api: ApiClient | null = null;
  private apiKey = "";
  private server: PublicConfig | null = null;
  private agentId = "";
  private conversationId = "";
  private messages: ViewMessage[] = [];
  private running: AbortController | null = null;
  private jobAccessLaunch: AbortController | null = null;
  private activated = false;
  private strings: Strings = pickStrings();
  private mql: MediaQueryList | null = null;
  private registry = new ActionRegistry();
  private propActionNames = new Set<string>();
  private hooks: Pick<DeweeChatConfig, "confirm" | "getPageContext" | "headers" | "fetch"> = {};
  private acks = new Map<string, string>();
  /** Pause after a RATE_LIMITED refusal; send stays disabled until it ends. */
  private cooldown = new SendCooldown((s) => this.renderCooldown(s), () => this.endCooldown());
  private els!: {
    launcher: HTMLButtonElement; panel: HTMLElement; log: HTMLElement; title: HTMLElement; subtitle: HTMLElement;
    status: HTMLElement; avatar: HTMLElement; select: HTMLSelectElement; input: HTMLTextAreaElement; send: HTMLButtonElement;
    newChat: HTMLButtonElement; jobAccess: HTMLButtonElement; close: HTMLButtonElement; foot: HTMLElement; cooldown: HTMLElement; announcer: HTMLElement;
  };

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  // ---------- public API ----------

  /** Current effective configuration (attributes merged with `configure()` overrides). */
  get config(): DeweeChatConfig {
    const c: Record<string, unknown> = { endpoint: "/api/dewee" };
    for (const a of ATTRS) {
      const v = this.getAttribute(a);
      if (v === null) continue;
      if (BOOL_ATTRS.includes(a)) c[camel(a)] = parseBool(v);
      else if (a === "suggestions") c.suggestions = v.trim().startsWith("[") ? safeJson(v, []) : v.split("|").map((s) => s.trim()).filter(Boolean);
      else if (a === "z-index") c.zIndex = Number(v);
      else c[camel(a)] = v;
    }
    return { ...c, ...this.overrides, ...this.hooks } as DeweeChatConfig;
  }

  /** Updates configuration at runtime (wins over attributes). */
  configure(partial: Partial<DeweeChatConfig>): void {
    const { actions, confirm, getPageContext, headers, fetch, ...rest } = partial;
    const has = (k: BehaviorKey) => Object.prototype.hasOwnProperty.call(partial, k);
    if (has("actions")) this.setPropActions(actions ?? []);
    if (has("confirm")) this.hooks.confirm = confirm;
    if (has("getPageContext")) this.hooks.getPageContext = getPageContext;
    if (has("headers")) this.hooks.headers = headers;
    if (has("fetch")) this.hooks.fetch = fetch;
    if (!Object.keys(rest).length) return;
    this.overrides = { ...this.overrides, ...rest };
    if (this.els) this.applyConfig(); // otherwise applied on connect
  }

  /** Adds or replaces page actions the agent may invoke. Throws TypeError on an invalid definition. */
  registerActions(actions: PageAction | PageAction[]): void {
    this.registry.register(actions);
  }

  /** Removes a page action. Returns false when it was not registered. */
  unregisterAction(name: string): boolean {
    this.propActionNames.delete(name);
    return this.registry.unregister(name);
  }

  /** Extra request headers (property only; same as `configure({ headers })`). */
  get headers(): RequestHeadersOption | undefined { return this.hooks.headers; }
  set headers(v: RequestHeadersOption | undefined) { this.hooks.headers = v; }

  /** Custom fetch for widget requests (property only; same as `configure({ fetch })`). */
  get fetch(): typeof fetch | undefined { return this.hooks.fetch; }
  set fetch(v: typeof fetch | undefined) { this.hooks.fetch = v; }

  /** Names of the currently registered page actions. */
  get actionNames(): string[] {
    return this.registry.names();
  }

  private setPropActions(actions: PageAction[]) {
    const next = new Set(actions.map((a) => a.name));
    for (const name of this.propActionNames) if (!next.has(name)) this.registry.unregister(name);
    if (actions.length) this.registry.register(actions);
    this.propActionNames = next;
  }

  open(): void {
    if (this.config.mode === "inline") return;
    this.setAttribute("data-open", "");
    this.removeAttribute("data-unread");
    this.els.launcher.setAttribute("aria-expanded", "true");
    this.activate();
    setTimeout(() => this.els.input.focus(), 120);
    this.emit("dewee:open");
  }

  close(): void {
    if (this.config.mode === "inline") return;
    this.removeAttribute("data-open");
    this.els.launcher.setAttribute("aria-expanded", "false");
    this.emit("dewee:close");
  }

  toggle(): void {
    this.hasAttribute("data-open") ? this.close() : this.open();
  }

  /** Sends a message programmatically (opens the widget first). */
  async send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || this.running || this.cooldown.active) return;
    if (this.config.mode !== "inline" && !this.hasAttribute("data-open")) this.open();
    await this.activate();
    this.els.input.value = "";
    this.autosize();
    // Agent turn, then (when the answer calls page actions) run them and send the results back,
    // at most `maxActionRounds` times per visitor message.
    let next: { message: string; hidden: boolean } | null = { message, hidden: false };
    for (let round = 0; next; round++) {
      const reply = await this.runTurn(next.message, next.hidden);
      next = null;
      if (reply.status !== "done" || reply.stopped || !this.registry.size) break;
      const { calls } = parseDirectives(reply.content);
      if (!calls.length) break;
      reply.actions = calls.map((c) => ({ id: c.id, name: c.name, args: c.ok ? c.args : undefined, status: "pending" as const }));
      const limit = this.config.maxActionRounds ?? 5;
      if (round >= limit) {
        for (const a of reply.actions) Object.assign(a, { status: "error", error: "Automatic action limit reached" });
        this.updateMessage(reply);
        this.showNotice(this.strings.actionLimit(limit));
        break;
      }
      this.updateMessage(reply);
      const results = await this.runActions(reply, calls);
      if (results) next = { message: formatActionResults(results, this.server?.maxMessageLength ?? 4000), hidden: true };
    }
  }

  /** One request/response with the agent. */
  private async runTurn(message: string, hidden: boolean): Promise<ViewMessage> {
    this.pushMessage({ role: "user", content: message, hidden });
    const reply: ViewMessage = { role: "assistant", content: "", status: "streaming", startedAt: Date.now() };
    this.pushMessage(reply);
    this.setRunning(new AbortController());
    this.emit("dewee:send", { message, agent: this.agentId, conversationId: this.conversationId, auto: hidden || undefined });
    try {
      await this.client().chat(this.chatBody(message), (e) => this.onStreamEvent(reply, e), this.running!.signal);
      if (reply.status === "streaming") reply.status = "done";
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        reply.status = "done";
        reply.stopped = true;
        if (!reply.content) reply.content = `_${this.strings.stopped}_`;
      } else {
        reply.status = "error";
        this.showError(reply, e as Error);
      }
    } finally {
      this.finishThinking(reply);
      this.updateMessage(reply);
      this.setRunning(null);
      if (reply.status === "done") {
        if (reply.actionsHash && !reply.stopped) this.setAck(reply.actionsHash);
        this.emit("dewee:reply", { content: reply.content, agent: this.agentId, conversationId: this.conversationId });
        if (this.config.mode !== "inline" && !this.hasAttribute("data-open")) this.setAttribute("data-unread", "");
      }
    }
    return reply;
  }

  private chatBody(message: string): ChatRequestBody & { agent: string; conversationId: string } {
    const body: ChatRequestBody & { agent: string; conversationId: string } = { message, agent: this.agentId, conversationId: this.conversationId };
    if (this.registry.size) {
      body.actions = this.registry.manifest();
      const ack = this.getAck();
      if (ack) body.actionsHash = ack;
    }
    const ctx = this.pageContext();
    if (ctx !== undefined) body.pageContext = ctx;
    return body;
  }

  /** Host snapshot, dropped (with a warning) when it fails or exceeds the backend cap. */
  private pageContext(): unknown {
    const get = this.hooks.getPageContext;
    if (!get) return undefined;
    try {
      const v = get();
      if (v === undefined || v === null) return undefined;
      const size = new TextEncoder().encode(JSON.stringify(v)).length;
      if (size <= ACTION_LIMITS.maxPageContextBytes) return v;
      console.warn(`[dewee-webchat] getPageContext() returned ${size} bytes; the limit is ${ACTION_LIMITS.maxPageContextBytes}. Context not sent.`);
      return { truncated: true };
    } catch (e) {
      console.warn("[dewee-webchat] getPageContext() failed:", e);
      return undefined;
    }
  }

  private ackKey() {
    return `dewee-webchat:actions:${this.config.endpoint}:${this.agentId}:${this.conversationId}`;
  }

  private getAck(): string | undefined {
    return this.acks.get(this.ackKey()) ?? (this.config.persist !== false ? store.get(this.ackKey()) ?? undefined : undefined);
  }

  private setAck(hash: string) {
    this.acks.set(this.ackKey(), hash);
    if (this.config.persist !== false) store.set(this.ackKey(), hash);
  }

  /** Executes the calls of one answer in order. Resolves null when the visitor stopped the chain. */
  private async runActions(reply: ViewMessage, calls: ParsedCall[]): Promise<ActionResult[] | null> {
    const ctrl = new AbortController();
    this.setRunning(ctrl);
    const results: ActionResult[] = [];
    const base = { agent: this.agentId, conversationId: this.conversationId };
    try {
      for (const [i, call] of calls.entries()) {
        const view = reply.actions![i];
        const sensitivity = call.ok ? this.registry.get(call.name)?.sensitivity : undefined;
        const args = call.ok ? call.args : undefined;
        this.emit("dewee:action", { phase: "start", id: call.id, name: call.name, sensitivity, args, ...base } satisfies ActionEventDetail);
        const r = await runActionCall(call, {
          registry: this.registry,
          confirm: (action, a) => this.confirmAction(action, a, ctrl.signal),
          signal: ctrl.signal,
          timeoutMs: this.config.actionTimeoutMs,
          ...base,
          onStatus: (status) => {
            view.status = status;
            this.updateMessage(reply);
          },
        });
        if (r.error) view.error = r.error;
        this.updateMessage(reply);
        results.push(r);
        this.emit("dewee:action", { phase: "result", id: r.id, name: r.name, sensitivity, args, status: r.status, result: r.result, error: r.error, ...base } satisfies ActionEventDetail);
      }
    } finally {
      this.setRunning(null);
    }
    return ctrl.signal.aborted ? null : results;
  }

  private confirmAction(action: PageActionInfo & { callId: string }, args: Record<string, unknown>, signal: AbortSignal): Promise<boolean> | boolean {
    if (this.hooks.confirm) return this.hooks.confirm(action, args);
    if (this.config.mode !== "inline" && !this.hasAttribute("data-open")) this.open();
    return showConfirmDialog(this.els.panel, this.strings, action, args, signal);
  }

  private showNotice(text: string) {
    const div = document.createElement("div");
    div.className = "notice";
    div.setAttribute("role", "status");
    div.textContent = text;
    this.els.log.appendChild(div);
    this.scrollToBottom(true);
  }

  /** Stops the running reply. */
  stop(): void {
    this.running?.abort();
  }

  /**
   * Call after the visitor signs in or out on the host page: the next message uses a session for
   * the current user, and the conversation is reloaded for them.
   */
  async renewSession(): Promise<void> {
    this.stop();
    try {
      await this.client().renewSession();
    } catch (e) {
      this.showError(null, e as Error);
      return;
    }
    if (this.activated) await this.loadConversation();
  }

  /**
   * The tab's signed-in reuse hint, or null. Not a credential: send it to your logout route for
   * `handler.revoke(subject, request, hint)`, which then ends exactly that session.
   */
  reuseHint(): string | null {
    return this.client().reuseHint();
  }

  /**
   * Web-first linking for a signed-in user: shows a proof code and the chat apps to send it to
   * ("Continue on Telegram"). The user never types an account id. Resolves null on failure (the
   * error is shown in the chat and emitted as `dewee:error`).
   */
  async startLink(): Promise<LinkResponse | null> {
    if (this.config.mode !== "inline" && !this.hasAttribute("data-open")) this.open();
    await this.activate();
    try {
      const link = await this.client().link();
      this.renderLink(link);
      this.emit("dewee:link", { expiresAt: link.expiresAt, deepLinks: link.deepLinks });
      return link;
    } catch (e) {
      this.showError(null, e as Error);
      return null;
    }
  }

  /** Opens the hosted permission review; the verified session stays on the backend. */
  async openJobAccess(): Promise<void> {
    if (this.jobAccessLaunch) return;
    const controller = new AbortController();
    this.jobAccessLaunch = controller;
    this.els.jobAccess.disabled = true;
    try {
      await openJobAccessTicket((signal) => this.client().jobAccess(signal), controller.signal);
      this.showNotice(this.strings.jobAccessOpened);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof JobAccessPopupError) {
        this.showNotice(error.code === "popup_blocked" ? this.strings.jobAccessPopupBlocked :
          error.code === "popup_closed" ? this.strings.jobAccessPopupClosed : this.strings.jobAccessUnavailable);
      } else if (error instanceof ApiError && isIdentityErrorCode(error.code)) {
        this.showError(null, error);
      } else this.showNotice(this.strings.jobAccessUnavailable);
    } finally {
      this.jobAccessLaunch = null;
      this.els.jobAccess.disabled = false;
    }
  }

  private renderLink(link: LinkResponse) {
    const s = this.strings;
    const root = document.createElement("div");
    root.className = "msg assistant link";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const md = document.createElement("div");
    md.className = "md";
    const p = (text: string) => {
      const el = document.createElement("p");
      el.textContent = text;
      return el;
    };
    const code = document.createElement("code");
    code.textContent = link.proofCode;
    const codeLine = document.createElement("p");
    codeLine.appendChild(code);
    md.append(p(s.linkIntro), codeLine);
    if (link.deepLinks.length) {
      const list = document.createElement("ul");
      for (const t of link.deepLinks) {
        const li = document.createElement("li");
        const label = t.displayName || t.name;
        li.textContent = s.linkContinueOn(channelLabel(t.channelType)) + (label ? ` · ${label}` : "");
        list.appendChild(li);
      }
      md.appendChild(list);
    } else md.appendChild(p(s.linkNoTargets));
    md.appendChild(p(s.linkExpires(Math.max(1, Math.round((link.expiresAt - Date.now()) / 60_000)))));
    bubble.appendChild(md);
    root.appendChild(bubble);
    if (!this.messages.length) this.els.log.replaceChildren();
    this.els.log.appendChild(root);
    this.scrollToBottom(true);
  }

  /** Starts a fresh conversation with the current agent. */
  newConversation(): void {
    this.stop();
    this.conversationId = randomConversationId();
    if (this.config.persist !== false) store.set(this.convKey(), this.conversationId);
    this.messages = [];
    this.renderLog();
    this.els.input.focus();
  }

  // ---------- lifecycle ----------

  connectedCallback(): void {
    if (!this.els) this.renderShell();
    this.applyConfig();
    if (this.config.mode === "inline" || this.config.open) {
      if (this.config.mode !== "inline") this.open();
      else this.activate();
    }
  }

  disconnectedCallback(): void {
    this.jobAccessLaunch?.abort();
    this.stop();
    this.mql?.removeEventListener("change", this.onScheme);
  }

  attributeChangedCallback(): void {
    if (this.els) this.applyConfig();
  }

  // ---------- internals ----------

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private client(): ApiClient {
    const c = this.config;
    const key = [c.endpoint, c.gatewayUrl, c.gatewayToken].join("|");
    if (!this.api || key !== this.apiKey) {
      this.apiKey = key;
      this.api = new ApiClient({
        endpoint: c.endpoint,
        gatewayUrl: c.gatewayUrl,
        gatewayToken: c.gatewayToken,
        turnstile: (siteKey) => this.challenge(siteKey),
        // Read the current hooks on every request so configure({ headers, fetch }) applies at once.
        headers: () => {
          const h = this.hooks.headers;
          return (typeof h === "function" ? h() : h) ?? {};
        },
        fetch: (input, init) => (this.hooks.fetch ?? globalThis.fetch)(input, init),
      });
    }
    return this.api;
  }

  private convKey(): string {
    return `dewee-webchat:conv:${this.config.endpoint}:${this.config.gatewayUrl || ""}:${this.agentId}`;
  }

  private onScheme = () => this.applyTheme();

  private applyTheme() {
    const t = this.config.theme || "light";
    const dark = t === "dark" || (t === "auto" && !!this.mql?.matches);
    this.setAttribute("data-theme", dark ? "dark" : "light");
  }

  private applyConfig(): void {
    const c = this.config;
    this.strings = pickStrings(c.locale);
    const s = this.strings;
    this.setAttribute("data-position", c.position || "bottom-right");
    this.setAttribute("data-mode", c.mode || "floating");
    if (c.theme === "auto" && !this.mql) {
      this.mql = matchMedia("(prefers-color-scheme: dark)");
      this.mql.addEventListener("change", this.onScheme);
    }
    this.applyTheme();
    const setVar = (k: string, v?: string | number) => (v !== undefined && v !== "" ? this.style.setProperty(k, String(v)) : this.style.removeProperty(k));
    setVar("--dw-accent", c.accentColor);
    setVar("--dw-width", c.width);
    setVar("--dw-height", c.height);
    setVar("--dw-z", c.zIndex);

    const e = this.els;
    e.title.textContent = c.title || s.title;
    e.avatar.replaceChildren();
    if (c.avatar) {
      const img = document.createElement("img");
      img.src = c.avatar;
      img.alt = "";
      e.avatar.appendChild(img);
    } else e.avatar.textContent = (c.title || s.title).trim().charAt(0).toUpperCase();
    e.launcher.innerHTML = c.avatar && c.launcherAvatar ? "" : icons.chat;
    if (c.avatar && c.launcherAvatar) {
      const img = document.createElement("img");
      img.src = c.avatar;
      img.alt = "";
      e.launcher.appendChild(img);
    }
    e.launcher.insertAdjacentHTML("beforeend", `<span class="badge"></span>`);
    e.launcher.setAttribute("aria-label", s.open);
    e.close.setAttribute("aria-label", s.close);
    e.close.title = s.close;
    e.newChat.setAttribute("aria-label", s.newChat);
    e.newChat.title = s.newChat;
    e.jobAccess.setAttribute("aria-label", s.jobAccess);
    e.jobAccess.title = s.jobAccess;
    e.input.placeholder = c.placeholder || s.placeholder;
    e.foot.hidden = !!c.hideBranding;
    e.foot.querySelector(".by")!.textContent = s.poweredBy + " ";
    this.renderSubtitle();
    this.updateSendButton();

    // Credentials or endpoint changed after activation: reload server config.
    if (this.activated && this.api && this.apiKey !== [c.endpoint, c.gatewayUrl, c.gatewayToken].join("|")) {
      this.activated = false;
      this.server = null;
      this.activate();
    } else if (this.activated && c.agent && c.agent !== this.agentId && this.server) {
      this.switchAgent(c.agent);
    } else if (this.activated) {
      this.renderLog();
    }
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <style>${styles}</style>
      <button class="launcher" part="launcher" aria-expanded="false" aria-haspopup="dialog"></button>
      <section class="panel" part="panel" role="dialog" aria-label="Chat">
        <header class="head" part="header">
          <div class="avatar"></div>
          <div class="who">
            <div class="title"></div>
            <div class="subtitle"><span class="dot"></span><span class="status"></span><select class="agent-select" hidden></select></div>
          </div>
          <button class="icon-btn new">${icons.newChat}</button>
          <button class="icon-btn job-access" hidden>${icons.jobAccess}</button>
          <button class="icon-btn close">${icons.close}</button>
        </header>
        <div class="log" part="log" role="log" aria-live="polite"></div>
        <div class="challenge"><slot name="challenge"></slot></div>
        <form class="composer" part="composer">
          <div class="cooldown" part="cooldown" aria-hidden="true" hidden></div>
          <div class="sr-only announcer" role="status" aria-live="polite"></div>
          <div class="box">
            <textarea rows="1" maxlength="4000"></textarea>
            <button class="send" type="submit"></button>
          </div>
          <div class="foot"><span><span class="by"></span><a href="https://dewee.sh" target="_blank" rel="noopener">dewee</a></span><span class="meta"></span></div>
        </form>
      </section>`;
    const $ = <T extends Element>(sel: string) => this.root.querySelector(sel) as T;
    this.els = {
      launcher: $(".launcher"), panel: $(".panel"), log: $(".log"), title: $(".title"), subtitle: $(".subtitle"),
      status: $(".status"), avatar: $(".avatar"), select: $(".agent-select"), input: $("textarea"), send: $(".send"),
      newChat: $(".new"), jobAccess: $(".job-access"), close: $(".close"), foot: $(".foot"), cooldown: $(".cooldown"), announcer: $(".announcer"),
    };
    const e = this.els;
    e.launcher.addEventListener("click", () => this.toggle());
    e.close.addEventListener("click", () => this.close());
    // Follow the stream until the visitor scrolls up; content growth alone fires no scroll event.
    e.log.addEventListener("scroll", () => { this.following = this.nearBottom(); }, { passive: true });
    e.newChat.addEventListener("click", () => this.newConversation());
    e.jobAccess.addEventListener("click", () => { void this.openJobAccess(); });
    e.select.addEventListener("change", () => this.switchAgent(e.select.value));
    $<HTMLFormElement>("form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.running ? this.stop() : this.send(e.input.value);
    });
    e.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        if (!this.running) this.send(e.input.value);
      }
    });
    e.input.addEventListener("input", () => { this.autosize(); this.updateSendButton(); });
    e.panel.addEventListener("keydown", (ev) => { if (ev.key === "Escape") this.close(); });
  }

  private autosize() {
    const t = this.els.input;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 140) + "px";
  }

  private updateSendButton() {
    const b = this.els.send;
    b.innerHTML = this.running ? icons.stop : icons.send;
    b.setAttribute("aria-label", this.running ? this.strings.stop : this.strings.send);
    b.title = b.getAttribute("aria-label")!;
    b.disabled = !this.running && (this.cooldown.active || !this.els.input.value.trim());
  }

  /** Disables sending for `ms` and announces it; the visible countdown is not read out every second. */
  private startCooldown(ms?: number) {
    // Only a positive finite value is trusted; anything else from a custom backend gets the default.
    this.cooldown.start(typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_COOLDOWN_MS);
    if (!this.cooldown.active) return;
    this.renderCooldown(this.cooldown.secondsLeft);
    this.els.announcer.textContent = this.strings.cooldownStart(this.cooldown.secondsLeft);
    this.updateSendButton();
  }

  private renderCooldown(secondsLeft: number) {
    this.els.cooldown.hidden = false;
    this.els.cooldown.textContent = this.strings.cooldown(secondsLeft);
  }

  private endCooldown() {
    this.els.cooldown.hidden = true;
    this.els.cooldown.textContent = "";
    this.els.announcer.textContent = this.strings.cooldownOver;
    this.updateSendButton();
  }

  private setRunning(ctrl: AbortController | null) {
    this.running = ctrl;
    this.updateSendButton();
  }

  private renderSubtitle() {
    this.els.jobAccess.hidden = this.server?.identity !== true;
    const e = this.els;
    const c = this.config;
    const agents = this.server?.agents ?? [];
    const canSwitch = c.allowAgentSwitch !== false && !!this.server?.allowAgentSwitch && agents.length > 1;
    e.select.hidden = !canSwitch;
    e.status.hidden = canSwitch;
    if (canSwitch) {
      e.select.replaceChildren(...agents.map((a) => new Option(a.name || a.id, a.id, false, a.id === this.agentId)));
      e.select.setAttribute("aria-label", "Agent");
    }
    const current = agents.find((a) => a.id === this.agentId);
    e.status.textContent = c.subtitle || (current?.name && current.name !== c.title ? `${this.strings.online} · ${current.name}` : this.strings.online);
  }

  /** Loads backend config and the persisted conversation once. */
  private async activate(): Promise<void> {
    if (this.activated) return;
    this.activated = true;
    this.renderLog();
    try {
      this.server = await this.client().getConfig(true);
      this.els.input.maxLength = this.server.maxMessageLength;
      const wanted = this.config.agent;
      const known = (id?: string) => !!id && (this.server!.agents.length === 0 || this.server!.agents.some((a: AgentInfo) => a.id === id));
      this.agentId = known(wanted) ? wanted! : this.server.defaultAgent || this.server.agents[0]?.id || wanted || "";
      await this.loadConversation();
    } catch (e) {
      this.activated = false;
      this.renderLog();
      this.showError(null, e as Error);
    }
    this.renderSubtitle();
    this.emit("dewee:ready", { agent: this.agentId, config: this.server });
  }

  private async switchAgent(id: string) {
    if (id === this.agentId) return;
    this.stop();
    this.agentId = id;
    this.renderSubtitle();
    await this.loadConversation();
  }

  private async loadConversation() {
    const persist = this.config.persist !== false;
    const saved = persist ? store.get(this.convKey()) : null;
    this.conversationId = saved || randomConversationId();
    if (persist && !saved) store.set(this.convKey(), this.conversationId);
    this.messages = [];
    this.renderLog();
    if (!saved) return;
    try {
      const history = await this.client().history(this.agentId, this.conversationId);
      this.messages = decorateHistory(history.map((m) => ({ ...m, status: "done" as const })));
      this.renderLog();
    } catch {
      /* history is a nicety: a fresh conversation still works */
    }
  }

  private renderLog() {
    const log = this.els.log;
    log.replaceChildren();
    if (!this.messages.length) log.appendChild(this.renderWelcome());
    for (const m of this.messages) log.appendChild(this.renderMessage(m));
    log.scrollTop = log.scrollHeight;
  }

  private renderWelcome(): HTMLElement {
    const c = this.config;
    const s = this.strings;
    const w = document.createElement("div");
    w.className = "welcome";
    const h = document.createElement("h2");
    h.textContent = c.greeting || s.greeting;
    const p = document.createElement("p");
    p.textContent = c.intro || s.greetingBody;
    w.append(h, p);
    if (c.suggestions?.length) {
      const list = document.createElement("div");
      list.className = "suggestions";
      for (const text of c.suggestions) {
        const b = document.createElement("button");
        b.className = "chip";
        b.type = "button";
        b.textContent = text;
        b.addEventListener("click", () => this.send(text));
        list.appendChild(b);
      }
      w.appendChild(list);
    }
    return w;
  }

  private pushMessage(m: ViewMessage) {
    if (!this.messages.length) this.els.log.replaceChildren();
    this.messages.push(m);
    this.els.log.appendChild(this.renderMessage(m));
    this.scrollToBottom(true);
  }

  private renderMessage(m: ViewMessage): HTMLElement {
    const root = document.createElement("div");
    root.className = `msg ${m.role}${m.status === "error" ? " error" : ""}`;
    root.hidden = !!m.hidden;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    root.appendChild(bubble);
    const trace = document.createElement("div");
    trace.className = "trace";
    const md = document.createElement("div");
    md.className = m.role === "assistant" ? "md" : "";
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.hidden = true;
    if (m.role === "assistant") bubble.appendChild(trace);
    bubble.appendChild(md);
    if (m.role === "assistant") bubble.appendChild(actions);
    m.view = { root, trace, md, tools: new Map(), actions };
    this.updateMessage(m);
    return root;
  }

  private updateMessage(m: ViewMessage) {
    const v = m.view;
    if (!v) return;
    const c = this.config;
    if (m.role === "user") {
      v.md.textContent = m.content;
      v.root.classList.toggle("refused", !!m.refusal);
      let note = v.root.querySelector<HTMLElement>(".refusal");
      if (m.refusal && !note) {
        note = document.createElement("div");
        note.className = "refusal";
        v.root.appendChild(note);
      }
      if (note && m.refusal) note.textContent = `⚠️ ${m.refusal}`;
      else note?.remove();
      return;
    }
    v.root.classList.toggle("error", m.status === "error");

    // reasoning
    if (c.showReasoning !== false && m.thinking) {
      if (!v.thinking) {
        v.thinking = document.createElement("details");
        v.thinking.className = "thinking";
        v.thinking.innerHTML = `<summary></summary><div class="thinking-body"></div>`;
        v.trace.prepend(v.thinking);
      }
      const streaming = m.status === "streaming" && !m.thinkingMs;
      const label = streaming ? this.strings.thinking : m.thinkingMs ? this.strings.thoughtFor(Math.max(1, Math.round(m.thinkingMs / 1000))) : this.strings.reasoning;
      const summary = v.thinking.querySelector("summary")!;
      summary.innerHTML = `${streaming ? '<span class="spin"></span>' : icons.brain}<span></span>${icons.down.replace("<svg", '<svg class="chev"')}`;
      summary.querySelector("span:not(.spin)")!.textContent = label;
      v.thinking.querySelector(".thinking-body")!.textContent = m.thinking;
    } else if (v.thinking) {
      v.thinking.remove();
      v.thinking = undefined;
    }

    // tools
    if (c.showToolCalls !== false) {
      for (const t of m.toolCalls ?? []) this.renderTool(v, t);
    } else {
      v.tools.forEach((d) => d.remove());
      v.tools.clear();
    }
    v.trace.hidden = !v.trace.childElementCount;

    // content (page action directives are hidden; their calls render as chips below)
    const shown = this.registry.size || m.actions ? stripDirectives(m.content) : m.content;
    const typing = m.status === "streaming" && !shown;
    v.md.hidden = !typing && !shown && !!m.actions?.length;
    if (typing) {
      v.md.innerHTML = `<span class="typing" aria-label="${this.strings.thinking}"><i></i><i></i><i></i></span>`;
    } else {
      v.md.replaceChildren(renderMarkdown(document, shown));
      v.md.classList.toggle("cursor", m.status === "streaming");
    }
    this.renderActions(v, m.actions ?? []);
  }

  private renderActions(v: ViewRefs, list: ActionCallView[]) {
    v.actions.hidden = !list.length;
    v.actions.replaceChildren(
      ...list.map((a) => {
        const chip = document.createElement("div");
        chip.className = "action";
        chip.dataset.status = a.status;
        const busy = a.status === "running" || a.status === "awaiting-confirmation";
        chip.innerHTML = `${busy ? '<span class="spin"></span>' : icons.action}<span class="action-name"></span><span class="action-state"></span>`;
        chip.querySelector(".action-name")!.textContent = a.name || "?";
        chip.querySelector(".action-state")!.textContent = this.strings.actionStatus[a.status];
        const tip = [a.args && Object.keys(a.args).length ? JSON.stringify(a.args) : "", a.error ?? ""].filter(Boolean).join("\n");
        if (tip) chip.title = tip;
        return chip;
      }),
    );
  }

  private renderTool(v: ViewRefs, t: ToolCallView) {
    let d = v.tools.get(t.id);
    if (!d) {
      d = document.createElement("details");
      d.className = "tool";
      d.innerHTML = `<summary><span class="lead"></span><span class="tool-name"></span><span class="tool-state"></span>${icons.down.replace("<svg", '<svg class="chev"')}</summary><div class="tool-body"></div>`;
      v.tools.set(t.id, d);
      v.trace.appendChild(d);
    }
    d.dataset.status = t.status;
    d.querySelector(".lead")!.innerHTML = t.status === "running" ? '<span class="spin"></span>' : icons.tool;
    const name = d.querySelector(".tool-name")!;
    name.textContent = prettyToolName(t.name);
    name.setAttribute("title", t.name);
    d.querySelector(".tool-state")!.textContent =
      t.status === "running" ? this.strings.toolRunning : t.status === "error" ? this.strings.toolError : this.strings.toolDone;
    const body = d.querySelector(".tool-body")!;
    body.replaceChildren();
    const block = (label: string, value: unknown) => {
      if (value === undefined || value === null || value === "") return;
      const l = document.createElement("div");
      l.className = "label";
      l.textContent = label;
      const pre = document.createElement("pre");
      pre.textContent = typeof value === "string" ? tryPretty(value) : JSON.stringify(value, null, 2);
      body.append(l, pre);
    };
    block(this.strings.args, t.arguments);
    block(this.strings.result, t.result);
  }

  private onStreamEvent(m: ViewMessage, e: ChatStreamEvent) {
    switch (e.type) {
      case "start":
        if (e.actionsHash) m.actionsHash = e.actionsHash;
        if (e.conversationId && e.conversationId !== this.conversationId) {
          this.conversationId = e.conversationId;
          if (this.config.persist !== false) store.set(this.convKey(), e.conversationId);
        }
        break;
      case "thinking":
        m.thinking = (m.thinking || "") + e.text;
        break;
      case "delta":
        this.finishThinking(m);
        m.content += e.text;
        break;
      case "tool_call":
        this.finishThinking(m);
        (m.toolCalls ??= []).push({ id: e.id, name: e.name, arguments: e.arguments, status: "running" });
        break;
      case "tool_result": {
        const t = m.toolCalls?.find((x) => x.id === e.id) ?? (m.toolCalls ??= [])[m.toolCalls.push({ id: e.id, name: e.name, status: "running" }) - 1];
        t.status = e.isError ? "error" : "done";
        t.result = e.result;
        t.isError = e.isError;
        break;
      }
      case "done":
        this.finishThinking(m);
        if (e.content && e.content.length >= m.content.length) m.content = e.content;
        m.status = "done";
        break;
      case "error":
        m.status = "error";
        this.showError(m, new ApiError(e.message, 500, e.code, e.remediation, e.retryAfterMs));
        break;
    }
    this.scheduleUpdate(m);
  }

  private pendingFrame = 0;
  private following = true;
  private scheduleUpdate(m: ViewMessage) {
    if (this.pendingFrame) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = 0;
      this.updateMessage(m);
      if (this.following) this.scrollToBottom(true);
    });
  }

  private finishThinking(m: ViewMessage) {
    if (m.thinking && !m.thinkingMs && m.startedAt) m.thinkingMs = Date.now() - m.startedAt;
  }

  private nearBottom() {
    const l = this.els.log;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 96;
  }

  private scrollToBottom(force = false) {
    const l = this.els.log;
    if (force || this.nearBottom()) {
      l.scrollTop = l.scrollHeight;
      this.following = true;
    }
  }

  private showError(m: ViewMessage | null, err: Error) {
    const { code, remediation, retryAfterMs } = err as ApiError;
    // Identity and admission errors get the widget's own localized copy; the server text is only a fallback.
    const localized = isIdentityErrorCode(code)
      ? this.strings.identityErrors[code]
      : isAdmissionErrorCode(code)
        ? this.strings.admissionErrors[code]
        : isLinkErrorCode(code)
          ? this.strings.linkErrors[code]
          : "";
    const text = localized || err.message || this.strings.errorGeneric;
    this.emit("dewee:error", { message: text, code, ...(remediation && { remediation }), ...(retryAfterMs && { retryAfterMs }) });
    if (code === "RATE_LIMITED") this.startCooldown(retryAfterMs);
    if (m && isAdmissionErrorCode(code) && this.refuseInline(m, code, text)) return;
    if (m) {
      m.content = m.content ? `${m.content}\n\n> ⚠️ ${text}` : `⚠️ ${text}`;
      m.status = "error";
      this.updateMessage(m);
      return;
    }
    const div = document.createElement("div");
    div.className = "msg error";
    div.innerHTML = `<div class="bubble"></div>`;
    div.firstElementChild!.textContent = `⚠️ ${text}`;
    this.els.log.appendChild(div);
  }

  /**
   * An admission refusal: the visitor's message never reached the agent, so it goes back to an empty
   * composer to edit or resend. `POLICY_DENIED` is shown next to that message instead of as an empty
   * reply. Returns true when the error was shown here.
   */
  private refuseInline(reply: ViewMessage, code: string, text: string): boolean {
    const i = this.messages.indexOf(reply);
    const question = i > 0 ? this.messages[i - 1] : undefined;
    if (question?.role !== "user" || question.hidden) return false;
    if (!this.els.input.value.trim()) {
      this.els.input.value = question.content;
      this.autosize();
    }
    if (code !== "POLICY_DENIED" || reply.content) return false;
    reply.status = "error";
    reply.hidden = true;
    if (reply.view) reply.view.root.hidden = true;
    question.refusal = text;
    this.updateMessage(question);
    return true;
  }

  /** Renders a Turnstile challenge in light DOM (slotted) and resolves with its token. */
  private async challenge(siteKey: string): Promise<string> {
    await loadTurnstile();
    const holder = document.createElement("div");
    holder.slot = "challenge";
    this.appendChild(holder);
    try {
      return await new Promise<string>((resolve, reject) => {
        (window as any).turnstile.render(holder, {
          sitekey: siteKey,
          appearance: "interaction-only",
          theme: this.getAttribute("data-theme") === "dark" ? "dark" : "light",
          callback: resolve,
          "error-callback": () => reject(new ApiError("Verification failed", 403, "turnstile_failed")),
        });
      });
    } finally {
      holder.remove();
    }
  }
}

/** Hides automatic action-result messages and restores action chips when loading history. */
function decorateHistory(messages: ViewMessage[]): ViewMessage[] {
  messages.forEach((m, i) => {
    if (m.role === "user") {
      m.content = stripPageBlock(m.content);
      if (isActionResultMessage(m.content)) m.hidden = true;
      return;
    }
    if (!m.content.includes("```dewee-action")) return;
    const { calls } = parseDirectives(m.content);
    if (!calls.length) return;
    const next = messages[i + 1];
    const nextContent = next?.role === "user" ? stripPageBlock(next.content) : "";
    const results = isActionResultMessage(nextContent) ? parseActionResults(nextContent) : [];
    m.actions = calls.map((c) => {
      const r = results.find((x) => x.id === c.id);
      const status: ActionCallStatus = !r ? "error" : r.status === "ok" ? "done" : r.status;
      return { id: c.id, name: c.name, args: c.ok ? c.args : undefined, status, error: r ? r.error : "Not run" };
    });
  });
  return messages;
}

const CHANNEL_LABELS: Record<string, string> = { telegram: "Telegram", discord: "Discord", zalo: "Zalo", slack: "Slack", whatsapp: "WhatsApp", messenger: "Messenger", feishu: "Feishu", line: "LINE" };

function channelLabel(type: string): string {
  const key = type.toLowerCase().split(/[_-]/)[0];
  return CHANNEL_LABELS[key] ?? (type ? type.charAt(0).toUpperCase() + type.slice(1) : "chat");
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s); } catch { return fallback; }
}

function tryPretty(s: string): string {
  const t = s.trim();
  if (!/^[[{]/.test(t)) return s;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return s; }
}
