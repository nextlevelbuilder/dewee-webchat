// Business requests in the widget: the "request a callback" entry and form, the send with one
// idempotency key per confirmed intent (sending, unconfirmed, failed, recorded), and the receipts of the
// visitor's requests as the server reports them. A receipt is the business's record, apart from the
// conversation and from any human takeover: ending a takeover, staff going off duty or a new
// conversation never changes it. Only the server's view sets a code, a state or a due time.
import { callbackFieldError, type WorkRequestCreateBody, type WorkRequestCreateResponse, type WorkRequestKind, type WorkRequestView } from "../work-request";
import { ApiError, WORK_REQUEST_UNKNOWN, type ApiClient } from "./api-client";
import { claimKey, draftId, draftsFor, dropDraft } from "./work-request-draft";
import { CallbackForm, type CallbackFormValues } from "./work-request-form";
import type { Strings } from "./i18n";

/** Receipts are read again when the visitor comes back to the widget, at most this often. */
const ATTENTION_MIN_MS = 10_000;
/** After a send, receipts are read again from 30 s, twice as late each time, up to 5 min, for 30 min. */
const FOLLOW_FIRST_MS = 30_000;
const FOLLOW_MAX_MS = 5 * 60_000;
const FOLLOW_FOR_MS = 30 * 60_000;
const LIST_LIMIT = 20;

/** What the controller needs from the widget element. */
export interface WorkRequestHost {
  client(): ApiClient;
  strings(): Strings;
  /** The locale times are written in (undefined: the browser's). */
  locale(): string | undefined;
  endpoint(): string;
  /** The panel dialogs open in. */
  panel: HTMLElement;
  entry: HTMLElement;
  entryHint: HTMLElement;
  entryButton: HTMLButtonElement;
  receipts: HTMLElement;
  announce(text: string): void;
  /** The conversation a request belongs to, only once it exists on the server. */
  conversation(): { agent: string; conversationId: string } | null;
  /** A request for a person found nobody on duty (the handoff status says so). */
  unattended(): boolean;
  /** Tells the page a receipt's code and state, never anything the visitor typed. */
  emit(name: string, detail: { code: string; state: string }): void;
  /** Whether the widget is in the page and its tab visible: no timer runs otherwise. */
  live(): boolean;
}

/** The due time in the visitor's time zone, plus the business's when the two differ; "" when unreadable. */
export function formatDue(iso: string, zone: string, locale: string | undefined, s: Strings["workRequests"]): string {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return "";
  try {
    const local = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
    const mine = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || zone === mine) return local;
    const theirs = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: zone }).format(at);
    return `${local} (${s.dueLocal(theirs, zone)})`;
  } catch {
    return ""; // an unknown time zone or locale: no time is shown rather than a wrong one
  }
}

type Phase = "idle" | "sending" | "checking" | "unconfirmed" | "failed";

export class WorkRequests {
  private kinds: WorkRequestKind[] = [];
  private receipts = new Map<string, WorkRequestView>();
  private generation = 0;
  private form: CallbackForm | null = null;
  /** What the visitor typed, kept in memory while the form is closed and reopened; never stored. */
  private values: CallbackFormValues | null = null;
  private phase: Phase = "idle";
  /** The body sent under the current key: sent again unchanged until the outcome is known. */
  private frozen: WorkRequestCreateBody | null = null;
  private lastRead = 0;
  private reading: Promise<void> | null = null;
  private followTimer: ReturnType<typeof setTimeout> | undefined;
  private followUntil = 0;
  private followDelay = FOLLOW_FIRST_MS;
  /** What each receipt element shows, so an unchanged one is not redrawn (and not read out again). */
  private drawn = new WeakMap<HTMLElement, string>();
  /** Bumped when a request is recorded: a full list read that started before it may not know it yet. */
  private revision = 0;

  constructor(private host: WorkRequestHost) {
    host.entryButton.addEventListener("click", () => this.openForm());
  }

  /** The kind the callback entry sends, if the server offers one. */
  private get callback(): WorkRequestKind | undefined {
    return this.kinds.find((k) => k.schema === "callback");
  }

  get offered(): boolean {
    return this.kinds.length > 0;
  }

  /** The kinds the backend offers (`/config`); none = the feature is absent: no call, no timer. */
  configure(kinds: WorkRequestKind[] | undefined): void {
    this.kinds = Array.isArray(kinds) ? kinds : [];
    if (!this.offered) this.reset();
    this.render();
  }

  /** Another visitor (sign-in, sign-out) or backend: their receipts, form and pending send are dropped. */
  reset(): void {
    this.generation++;
    this.stopFollowing();
    this.closeForm(false);
    this.values = null;
    this.frozen = null;
    this.phase = "idle";
    this.receipts.clear();
    this.lastRead = 0;
    this.reading = null;
    this.renderReceipts();
  }

  /** Stops timers (the widget left the page or its tab was hidden). */
  pause(): void {
    this.stopFollowing();
  }

  /** Redraws the entry and the receipts (strings or the handoff state changed). */
  render(): void {
    const kind = this.callback;
    const s = this.host.strings().workRequests;
    this.host.entry.hidden = !kind;
    this.host.entryButton.textContent = s.entry;
    const offHours = !!kind && (!kind.staffedNow || this.host.unattended());
    this.host.entryHint.hidden = !offHours;
    this.host.entryHint.textContent = offHours ? s.offHours : "";
    this.renderReceipts();
  }

  /**
   * Reads the visitor's receipts (boot, a restored conversation, a visit back), and finds the requests of
   * this tab's drafts left by a reload during a send. Only for a visitor who already holds a session.
   */
  refresh(): Promise<void> {
    if (!this.offered || !this.host.client().hasSession()) return Promise.resolve();
    if (this.reading) return this.reading;
    const generation = this.generation;
    const run = (async () => {
      this.lastRead = Date.now();
      try {
        const revision = this.revision;
        const views = await this.host.client().workRequestList({ limit: LIST_LIMIT });
        if (generation !== this.generation) return;
        this.apply(views, revision === this.revision);
        await this.reconcileDrafts(generation);
      } catch {
        /* receipts are read again on the next visit */
      }
    })().finally(() => { if (this.reading === run) this.reading = null; });
    return (this.reading = run);
  }

  /** The visitor opened or focused the widget: receipts are read again (throttled), and followed again. */
  attention(): void {
    if (!this.offered) return;
    if (Date.now() - this.lastRead >= ATTENTION_MIN_MS) void this.refresh();
    if (Date.now() < this.followUntil) this.scheduleFollow();
  }

  // ---------- form ----------

  private openForm(): void {
    const kind = this.callback;
    if (!kind) return;
    if (this.form) { this.form.focusFirst(); return; }
    const s = this.host.strings().workRequests;
    const form = new CallbackForm(s, kind.title, {
      submit: () => void this.submit(),
      cancel: () => this.closeForm(true),
      check: () => void this.check(),
      resend: () => void this.send(),
      edit: () => this.edited(),
    });
    this.form = form;
    if (this.values) form.fill(this.values);
    form.setPhase(this.phase, this.phase === "unconfirmed" ? s.unconfirmed : "");
    this.host.panel.appendChild(form.root);
    form.focusFirst();
  }

  /** Closes the form; what the visitor typed stays in memory for this page view, unless the request was recorded. */
  private closeForm(restoreFocus: boolean): void {
    if (!this.form) return;
    this.values = this.form.values();
    // The focus leaves a form that goes away. Read only when it is in this widget (another widget may hold it).
    const root = this.form.root.getRootNode();
    const active = root instanceof ShadowRoot && document.activeElement === root.host ? root.activeElement : null;
    if (active && this.form.root.contains(active)) (active as HTMLElement).blur();
    this.form.root.remove();
    this.form = null;
    if (restoreFocus && !this.host.entry.hidden) this.host.entryButton.focus();
  }

  /** A definite refusal keeps its key until the visitor changes what they send: then it is a new intent. */
  private edited(): void {
    if (this.phase !== "failed" || !this.frozen) return;
    dropDraft(this.draft(this.frozen.kind), this.frozen.idempotencyKey);
    this.frozen = null;
    this.phase = "idle";
    this.form?.setPhase("idle");
  }

  private draft(kind: string): string {
    return draftId(this.host.endpoint(), kind);
  }

  /** The visitor confirmed the form: checked here as the server will, then sent with the intent's key. */
  private async submit(): Promise<void> {
    const kind = this.callback;
    const form = this.form;
    if (!kind || !form || this.phase === "sending" || this.phase === "checking") return;
    const v = form.values();
    const field = callbackFieldError(v);
    form.fieldError(field);
    if (field) return;
    if (!this.frozen) {
      const purpose = v.purpose.trim();
      const conversation = this.host.conversation();
      this.frozen = {
        kind: kind.kind,
        summary: purpose,
        payload: { contact_method: v.method, contact_value: v.contact.trim(), purpose, consent: true },
        idempotencyKey: claimKey(this.draft(kind.kind)),
        ...(conversation ? { conversationId: conversation.conversationId, agent: conversation.agent } : {}),
      };
    }
    await this.send();
  }

  /** Sends the frozen body (first send, or "send again" with the same key). */
  private async send(): Promise<void> {
    const body = this.frozen;
    if (!body || this.phase === "sending" || this.phase === "checking") return;
    const s = this.host.strings().workRequests;
    const generation = this.generation;
    this.setPhase("sending", s.sending);
    let result: WorkRequestCreateResponse;
    try {
      try {
        result = await this.host.client().workRequestCreate(body);
      } catch (error) {
        // Not one of the visitor's conversations (another visitor's session now): nothing was stored, so
        // the request is sent once more on its own, with the same key.
        if (!(error instanceof ApiError && error.status === 404 && error.code === "not_found" && body.conversationId)) throw error;
        const { conversationId: _c, agent: _a, ...alone } = body;
        this.frozen = alone;
        if (generation !== this.generation) return;
        result = await this.host.client().workRequestCreate(alone);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      const code = error instanceof ApiError ? error.code : undefined;
      if (code === WORK_REQUEST_UNKNOWN) return void (await this.check(true));
      if (code === "idempotency_conflict") return void (await this.conflict());
      const status = error instanceof ApiError ? error.status : 0;
      this.setPhase("failed", code === "rate_limited" ? s.limited : code === "work_requests_unavailable" ? s.unavailable
        : status === 400 || status === 413 ? s.invalid : s.failed);
      return;
    }
    if (generation !== this.generation) return;
    this.recorded(result.workRequest);
  }

  /** Lists by the key: found = recorded; else the outcome stays unknown, and the visitor may check or send again. */
  private async check(automatic = false): Promise<void> {
    const body = this.frozen;
    if (!body || (!automatic && this.phase !== "unconfirmed")) return;
    const s = this.host.strings().workRequests;
    const generation = this.generation;
    this.setPhase("checking", s.checking);
    let found: WorkRequestView | undefined;
    try {
      found = (await this.host.client().workRequestList({ idempotencyKey: body.idempotencyKey, limit: 1 }))[0];
    } catch { /* still unknown */ }
    if (generation !== this.generation) return;
    if (found) this.recorded(found);
    else this.setPhase("unconfirmed", s.unconfirmed);
  }

  /** The key already holds another request (a draft from before a reload): that one is shown, this content was not sent. */
  private async conflict(): Promise<void> {
    const body = this.frozen!;
    const s = this.host.strings().workRequests;
    const generation = this.generation;
    dropDraft(this.draft(body.kind), body.idempotencyKey);
    this.frozen = null;
    try {
      const views = await this.host.client().workRequestList({ idempotencyKey: body.idempotencyKey, limit: 1 });
      if (generation !== this.generation) return;
      this.apply(views, false);
    } catch { /* shown on the next read */ }
    if (generation !== this.generation) return;
    this.setPhase("failed", s.conflict);
  }

  private recorded(view: WorkRequestView): void {
    const body = this.frozen;
    if (body) dropDraft(this.draft(body.kind), body.idempotencyKey);
    this.frozen = null;
    this.phase = "idle";
    this.closeForm(true);
    this.values = null; // the request is recorded: what the visitor typed is not kept
    const fresh = !this.receipts.has(view.code);
    this.revision++;
    this.receipts.set(view.code, view);
    this.renderReceipts();
    this.host.announce(this.host.strings().workRequests.recorded(view.code));
    if (fresh) this.host.emit("dewee:work-request", { code: view.code, state: view.state });
    this.follow();
  }

  private setPhase(phase: Phase, message: string): void {
    this.phase = phase;
    this.form?.setPhase(phase, message);
    if (!this.form && message) this.host.announce(message);
  }

  /** Finds the request a draft left by a reload created; a draft nothing was stored under keeps its key. */
  private async reconcileDrafts(generation: number): Promise<void> {
    for (const { id, draft } of draftsFor(this.host.endpoint())) {
      if (this.frozen?.idempotencyKey === draft.key) continue; // sent from this page view: its own flow decides
      const views = await this.host.client().workRequestList({ idempotencyKey: draft.key, limit: 1 });
      if (generation !== this.generation) return;
      if (views.length) {
        this.apply(views, false);
        dropDraft(id, draft.key);
      }
    }
  }

  // ---------- receipts ----------

  /** Merges server views; `all`: the visitor's full recent list. Announces and emits state changes only. */
  private apply(views: WorkRequestView[], all: boolean): void {
    const s = this.host.strings().workRequests;
    for (const view of views) {
      const before = this.receipts.get(view.code);
      this.receipts.set(view.code, view);
      if (before && before.state !== view.state) {
        this.host.announce(s.changed(view.code, s.states[view.state]));
        this.host.emit("dewee:work-request", { code: view.code, state: view.state });
      }
    }
    if (all && views.length < LIST_LIMIT) {
      // The full list: a request no longer listed is no longer the visitor's to see.
      const listed = new Set(views.map((v) => v.code));
      for (const code of [...this.receipts.keys()]) if (!listed.has(code)) this.receipts.delete(code);
    }
    this.renderReceipts();
    if (this.followUntil && [...this.receipts.values()].every((r) => r.state === "resolved" || r.state === "cancelled")) {
      this.followUntil = 0;
      this.stopFollowing();
    }
  }

  private follow(): void {
    this.followUntil = Date.now() + FOLLOW_FOR_MS;
    this.followDelay = FOLLOW_FIRST_MS;
    this.scheduleFollow();
  }

  private scheduleFollow(): void {
    if (this.followTimer !== undefined || !this.offered || !this.host.live() || Date.now() >= this.followUntil) return;
    this.followTimer = setTimeout(() => {
      this.followTimer = undefined;
      if (!this.host.live()) return;
      void this.refresh().then(() => {
        this.followDelay = Math.min(this.followDelay * 2, FOLLOW_MAX_MS);
        this.scheduleFollow();
      });
    }, this.followDelay);
  }

  private stopFollowing(): void {
    if (this.followTimer !== undefined) clearTimeout(this.followTimer);
    this.followTimer = undefined;
  }

  /** Each receipt is its own item, patched in place by code so unchanged ones are not read out again. */
  private renderReceipts(): void {
    const box = this.host.receipts;
    const s = this.host.strings().workRequests;
    const views = [...this.receipts.values()].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
    box.hidden = views.length === 0;
    let heading = box.querySelector<HTMLElement>(".wr-receipts-title");
    let list = box.querySelector<HTMLElement>(".wr-list");
    if (!heading || !list) {
      heading = document.createElement("h3");
      heading.className = "wr-receipts-title";
      list = document.createElement("ul");
      list.className = "wr-list";
      box.replaceChildren(heading, list);
    }
    heading.textContent = s.receipts;
    const existing = new Map([...list.querySelectorAll<HTMLElement>(".wr-receipt")].map((el) => [el.dataset.code!, el]));
    const ordered: HTMLElement[] = [];
    for (const view of views) {
      const el = existing.get(view.code) ?? document.createElement("li");
      existing.delete(view.code);
      this.fillReceipt(el, view);
      ordered.push(el);
    }
    for (const gone of existing.values()) gone.remove();
    ordered.forEach((el, i) => { if (list!.children[i] !== el) list!.insertBefore(el, list!.children[i] ?? null); });
  }

  private fillReceipt(el: HTMLElement, view: WorkRequestView): void {
    const s = this.host.strings().workRequests;
    const title = this.kinds.find((k) => k.kind === view.kind)?.title || view.kind;
    const due = formatDue(view.respondDueAt, view.dueTimezone, this.host.locale(), s);
    const signature = JSON.stringify([view, title, due, s.receipts]);
    if (this.drawn.get(el) === signature) return;
    this.drawn.set(el, signature);
    el.className = "wr-receipt";
    el.dataset.code = view.code;
    el.dataset.state = view.state;
    const line = (cls: string, label: string, value: string) => {
      const p = document.createElement("p");
      p.className = cls;
      const b = document.createElement("span");
      b.className = "wr-label";
      b.textContent = label + ": ";
      p.append(b, value);
      return p;
    };
    const head = document.createElement("div");
    head.className = "wr-receipt-head";
    const name = document.createElement("span");
    name.className = "wr-kind";
    name.textContent = title;
    const code = document.createElement("code");
    code.className = "wr-code";
    code.textContent = view.code;
    head.append(name, code);
    const state = document.createElement("p");
    state.className = "wr-state";
    const dot = document.createElement("span");
    dot.className = "wr-dot";
    dot.setAttribute("aria-hidden", "true");
    const word = document.createElement("span");
    word.textContent = s.states[view.state];
    state.append(dot, word);
    const parts: HTMLElement[] = [head, state];
    if (due) {
      const p = line("wr-due", s.due, "");
      const time = document.createElement("time");
      time.dateTime = view.respondDueAt;
      time.textContent = due;
      p.appendChild(time);
      parts.push(p);
    }
    if (view.publicNote) parts.push(line("wr-note", s.note, view.publicNote));
    if (view.contactHint) parts.push(line("wr-contact-hint", s.contactHint, view.contactHint));
    el.replaceChildren(...parts);
  }
}
