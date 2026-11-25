// The "request a callback" form, a modal dialog inside the widget panel: contact method, contact value,
// what it is about, and an explicit consent naming the request. Every field has a label and its own
// error line (aria-describedby); state changes are read out by the dialog's status line. Tab stays
// inside; Escape cancels unless a send is in flight. What the visitor typed lives in these fields only.
import { CALLBACK_CONTACT_METHODS, WORK_REQUEST_LIMITS, type CallbackContactMethod } from "../work-request";
import type { Strings } from "./i18n";

export type CallbackFormPhase = "idle" | "sending" | "checking" | "unconfirmed" | "failed" | "signin";
export type CallbackField = "contact_method" | "contact_value" | "purpose" | "consent";

export interface CallbackFormValues {
  method: string;
  contact: string;
  purpose: string;
  consent: boolean;
}

export interface CallbackFormHandlers {
  submit(): void;
  cancel(): void;
  check(): void;
  resend(): void;
  /** The visitor changed a field. */
  edit(): void;
}

let seq = 0;

export class CallbackForm {
  readonly root: HTMLElement;
  private phase: CallbackFormPhase = "idle";
  private canResend = true;
  private readonly q: <T extends Element>(sel: string) => T;

  constructor(private s: Strings["workRequests"], title: string, private h: CallbackFormHandlers) {
    const id = `dw-wr-${++seq}`;
    const root = document.createElement("div");
    root.className = "confirm-backdrop wr-dialog";
    root.innerHTML = `<form class="confirm wr-form" role="dialog" aria-modal="true" aria-labelledby="${id}-t" aria-describedby="${id}-i" novalidate>
      <h3 id="${id}-t"></h3><p class="wr-intro" id="${id}-i"></p>
      <fieldset class="wr-methods" aria-describedby="${id}-em"><legend></legend>
        ${CALLBACK_CONTACT_METHODS.map((m) => `<label class="wr-method"><input type="radio" name="${id}-m" value="${m}"${m === "phone" ? " checked" : ""}> <span data-m="${m}"></span></label>`).join("")}
      </fieldset>
      <p class="wr-error" data-for="contact_method" id="${id}-em" hidden></p>
      <label class="wr-field"><span class="wr-contact-label"></span><input class="wr-contact" id="${id}-c" aria-describedby="${id}-ec" maxlength="${WORK_REQUEST_LIMITS.contactValueChars}" spellcheck="false"></label>
      <p class="wr-error" data-for="contact_value" id="${id}-ec" hidden></p>
      <label class="wr-field"><span class="wr-purpose-label"></span><textarea class="wr-purpose" rows="3" aria-describedby="${id}-ep" maxlength="${WORK_REQUEST_LIMITS.purposeChars}"></textarea></label>
      <p class="wr-error" data-for="purpose" id="${id}-ep" hidden></p>
      <label class="wr-consent"><input type="checkbox" class="wr-consent-box" aria-describedby="${id}-eo"> <span class="wr-consent-label"></span></label>
      <p class="wr-error" data-for="consent" id="${id}-eo" hidden></p>
      <p class="wr-status" role="status" aria-live="polite"></p>
      <div class="confirm-buttons"><button type="button" class="btn deny wr-cancel"></button><button type="button" class="btn wr-check" hidden></button><button type="submit" class="btn allow wr-submit"></button></div>
    </form>`;
    this.root = root;
    this.q = <T extends Element>(sel: string) => root.querySelector(sel) as T;
    this.q<HTMLElement>("h3").textContent = title;
    this.q<HTMLElement>(".wr-intro").textContent = s.intro;
    this.q<HTMLElement>("legend").textContent = s.method;
    for (const m of CALLBACK_CONTACT_METHODS) this.q<HTMLElement>(`[data-m="${m}"]`).textContent = s.methods[m];
    this.q<HTMLElement>(".wr-purpose-label").textContent = s.purpose;
    this.q<HTMLElement>(".wr-consent-label").textContent = s.consent(title);
    this.q<HTMLElement>(".wr-cancel").textContent = s.cancel;
    this.q<HTMLElement>(".wr-check").textContent = s.checkAgain;
    this.syncMethod();

    const form = this.q<HTMLFormElement>("form");
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (this.phase === "sending" || this.phase === "checking") return;
      if (this.phase === "unconfirmed") { if (this.canResend) this.h.resend(); }
      else this.h.submit();
    });
    this.q<HTMLButtonElement>(".wr-cancel").addEventListener("click", () => { if (this.phase !== "sending" && this.phase !== "checking") this.h.cancel(); });
    this.q<HTMLButtonElement>(".wr-check").addEventListener("click", () => { if (this.phase === "unconfirmed") this.h.check(); });
    form.addEventListener("change", (ev) => {
      if ((ev.target as HTMLInputElement).type === "radio") this.syncMethod();
    });
    form.addEventListener("input", () => this.h.edit());
    form.addEventListener("change", () => this.h.edit());
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation(); // do not also close the chat panel
        if (this.phase !== "sending" && this.phase !== "checking") this.h.cancel();
      } else if (ev.key === "Tab") {
        const targets = [...root.querySelectorAll<HTMLElement>("input, textarea, button")].filter((el) => !(el as HTMLButtonElement).disabled && !el.hidden && !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked));
        const active = (root.getRootNode() as ShadowRoot | Document).activeElement as HTMLElement | null;
        const at = active ? targets.indexOf(active) : -1;
        ev.preventDefault();
        targets[(at + (ev.shiftKey ? targets.length - 1 : 1)) % targets.length]?.focus();
      }
    });
  }

  values(): CallbackFormValues {
    return {
      method: this.root.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value ?? "",
      contact: this.q<HTMLInputElement>(".wr-contact").value,
      purpose: this.q<HTMLTextAreaElement>(".wr-purpose").value,
      consent: this.q<HTMLInputElement>(".wr-consent-box").checked,
    };
  }

  /** Puts back what the visitor typed (the form was closed and opened again in this page view). */
  fill(v: CallbackFormValues): void {
    for (const r of this.root.querySelectorAll<HTMLInputElement>("input[type=radio]")) r.checked = r.value === v.method;
    this.q<HTMLInputElement>(".wr-contact").value = v.contact;
    this.q<HTMLTextAreaElement>(".wr-purpose").value = v.purpose;
    this.q<HTMLInputElement>(".wr-consent-box").checked = v.consent;
    this.syncMethod();
  }

  /** Shows one field's error (or clears them all) and moves the focus to that field. */
  fieldError(field: CallbackField | null): void {
    const targets: Record<CallbackField, string> = {
      contact_method: "input[type=radio]:checked, input[type=radio]",
      contact_value: ".wr-contact",
      purpose: ".wr-purpose",
      consent: ".wr-consent-box",
    };
    const email = this.values().method === "email";
    for (const name of Object.keys(targets) as CallbackField[]) {
      const on = name === field;
      const line = this.q<HTMLElement>(`.wr-error[data-for="${name}"]`);
      line.hidden = !on;
      line.textContent = !on ? "" : name === "contact_value" ? this.s.errors[email ? "contact_value_email" : "contact_value_phone"] : this.s.errors[name];
      const marked = name === "contact_method" ? this.q<HTMLElement>(".wr-methods") : this.q<HTMLElement>(targets[name]);
      if (on) marked.setAttribute("aria-invalid", "true");
      else marked.removeAttribute("aria-invalid");
    }
    if (field) this.q<HTMLElement>(targets[field]).focus();
  }

  /**
   * The form's state: fields are locked while a send is in flight and while its outcome is unknown (the
   * same request is sent again, never other content under its key).
   */
  setPhase(phase: CallbackFormPhase, message = "", canResend = true): void {
    this.phase = phase;
    this.canResend = canResend;
    const locked = phase !== "idle" && phase !== "failed" && phase !== "signin";
    // A field about to be disabled drops the focus: it moves to the submit button, which stays focusable.
    const root = this.root.getRootNode();
    const active = root instanceof ShadowRoot && document.activeElement === root.host ? root.activeElement : null;
    if (locked && active && this.root.contains(active) && (active.matches("input, textarea"))) this.q<HTMLButtonElement>(".wr-submit").focus();
    for (const el of this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) el.disabled = locked;
    const submit = this.q<HTMLButtonElement>(".wr-submit");
    const check = this.q<HTMLButtonElement>(".wr-check");
    const cancel = this.q<HTMLButtonElement>(".wr-cancel");
    const busy = phase === "sending" || phase === "checking";
    // aria-disabled, not disabled, on the button that has the focus: a disabled button drops it.
    submit.setAttribute("aria-disabled", String(busy));
    cancel.setAttribute("aria-disabled", String(busy));
    submit.textContent = phase === "unconfirmed" ? this.s.sendAgain : this.s.submit;
    cancel.textContent = phase === "unconfirmed" ? this.s.close : this.s.cancel;
    check.hidden = phase !== "unconfirmed";
    // While the outcome is unknown and no check has answered yet, only "check again" is offered.
    submit.hidden = phase === "unconfirmed" && !canResend;
    this.root.querySelector("form")!.setAttribute("aria-busy", String(busy));
    const status = this.q<HTMLElement>(".wr-status");
    status.textContent = message;
    status.dataset.phase = phase;
  }

  /** Focus into the form: the chosen method, or the first control that can take it while the fields are locked. */
  focusFirst(): void {
    const checked = this.root.querySelector<HTMLInputElement>("input[type=radio]:checked");
    const first = checked && !checked.disabled ? checked : [...this.root.querySelectorAll<HTMLElement>("input, textarea, button")].find((el) => !(el as HTMLButtonElement).disabled && !el.hidden);
    first?.focus();
  }

  private syncMethod(): void {
    const method = (this.values().method || "phone") as CallbackContactMethod;
    const input = this.q<HTMLInputElement>(".wr-contact");
    this.q<HTMLElement>(".wr-contact-label").textContent = this.s.contact[method];
    input.type = method === "email" ? "email" : "tel";
    input.autocomplete = method === "email" ? "email" : "tel";
    input.inputMode = method === "email" ? "email" : "tel";
    input.maxLength = method === "email" ? WORK_REQUEST_LIMITS.contactValueChars : WORK_REQUEST_LIMITS.phoneChars;
  }
}
