// Built-in, opt-in page actions that let the agent read and operate the host page's DOM:
// page.snapshot lists interactive elements as short refs, page.scroll/page.click/page.fill act on them.
// Refs belong to one snapshot generation; a ref from an older snapshot is refused. Password, payment
// card and one-time-code fields, hidden elements, `data-dewee-ignore` subtrees and the widget itself
// are never listed or touched. Events are synthetic (isTrusted=false).
import type { PageAction } from "./action-runner";

export const DOM_ACTION_NAMES = ["page.snapshot", "page.scroll", "page.click", "page.fill"] as const;

/** Where the agent may act: a selector, an element, or (default) the whole document body. */
export type DomActionsRoot = string | Element;

export interface DomActionsOptions {
  /** Current root (read on every call, so it can change at runtime). */
  root: () => DomActionsRoot | undefined;
  /** Elements that must never be listed or touched (the widget itself). */
  exclude?: (el: Element) => boolean;
}

const INTERACTIVE = [
  "a[href]", "button", "input", "select", "textarea", "summary", "[contenteditable]:not([contenteditable=false])",
  ...["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "combobox", "textbox", "searchbox"].map((r) => `[role=${r}]`),
].join(",");
const UNFILLABLE_INPUTS = new Set(["checkbox", "radio", "file", "submit", "button", "image", "reset", "hidden", "password"]);
const SENSITIVE_AUTOCOMPLETE = /\b(cc-[a-z-]+|one-time-code|current-password|new-password)\b/i;
const SENSITIVE_NAME = /(passw|passcode|\bpin\b|otp|one.?time|cvv|cvc|card.?(num|no)|cc.?num|security.?code|\bssn\b)/i;
const MAX_NAME = 80;
const MAX_VALUE = 60;
const DEFAULT_LIMIT = 40;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

const refSchema = { type: "string", pattern: "^e[0-9]{1,4}$" };
const genSchema = { type: "integer", minimum: 1 };

export interface DomActions {
  actions: PageAction[];
  /** One-line label of the element a click/fill call targets (for approval), or undefined when the ref does not resolve. */
  target(args: Record<string, unknown>): string | undefined;
}

/** Creates the four built-in actions. One instance keeps the ref table of the latest snapshot. */
export function createDomActions(o: DomActionsOptions): DomActions {
  let generation = 0;
  let refs = new Map<string, Element>();

  const rootEl = (): Element => {
    const r = o.root();
    const el = typeof r === "string" ? document.querySelector(r) : r;
    if (r !== undefined && !el) throw new Error(`domActionsRoot ${JSON.stringify(r)} matches no element`);
    return el ?? document.body;
  };

  const allowed = (el: Element, root: Element) =>
    el.isConnected && root.contains(el) && !o.exclude?.(el) && !el.closest("[data-dewee-ignore]") && !isSensitive(el) && isVisible(el);

  const resolve = (args: { ref: string; generation: number }): Element => {
    if (args.generation !== generation) {
      throw new Error(`Stale ref: generation ${args.generation} is not the latest snapshot (${generation || "none"}). Call page.snapshot again.`);
    }
    const el = refs.get(args.ref);
    if (!el) throw new Error(`Unknown ref "${args.ref}". Call page.snapshot again.`);
    if (!allowed(el, rootEl())) throw new Error(`Ref "${args.ref}" is no longer available. Call page.snapshot again.`);
    return el;
  };

  const snapshot: PageAction<{ query?: string; offset?: number; limit?: number }> = {
    name: "page.snapshot",
    description:
      "List the interactive elements visible on the page (links, buttons, form fields) as lines `ref role \"name\" [state]`. " +
      "Use the ref together with the returned generation in page.scroll, page.click and page.fill. Every snapshot invalidates older refs. " +
      "Use query to filter by visible name, offset/limit to page through long lists.",
    sensitivity: "read",
    parameters: {
      type: "object",
      properties: { query: { type: "string", maxLength: 100 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
    handler: ({ query, offset = 0, limit = DEFAULT_LIMIT }) => {
      const root = rootEl();
      generation++;
      refs = new Map();
      const q = squash(query).toLowerCase();
      const lines: string[] = [];
      let total = 0;
      for (const el of root.querySelectorAll(INTERACTIVE)) {
        if (!allowed(el, root)) continue;
        const line = describe(el);
        if (q && !line.toLowerCase().includes(q)) continue;
        total++;
        if (total <= offset || lines.length >= limit) continue;
        const ref = `e${total}`;
        refs.set(ref, el);
        lines.push(`${ref} ${line}`);
      }
      return { generation, url: location.pathname + location.search, title: clip(document.title, MAX_NAME), total, offset, elements: lines, ...scrollState(root) };
    },
  };

  const scroll: PageAction<{ direction?: "up" | "down" | "top" | "bottom"; ref?: string; generation?: number }> = {
    name: "page.scroll",
    description: "Scroll the page by about one screen (direction up/down) or to the top/bottom, or scroll an element from page.snapshot into view (ref + generation).",
    sensitivity: "read",
    parameters: {
      type: "object",
      properties: { direction: { type: "string", enum: ["up", "down", "top", "bottom"] }, ref: refSchema, generation: genSchema },
      additionalProperties: false,
    },
    handler: ({ direction, ref, generation: gen }) => {
      const root = rootEl();
      if (ref !== undefined) {
        if (gen === undefined) throw new Error("generation is required with ref");
        const el = resolve({ ref, generation: gen });
        el.scrollIntoView?.({ block: "center", inline: "nearest" });
        return { ref, ...scrollState(root) };
      }
      if (!direction) throw new Error("Give a direction or a ref");
      const box = scroller(root);
      const page = box === null ? window.innerHeight : box.clientHeight;
      const current = box === null ? window.scrollY : box.scrollTop;
      const max = box === null ? document.documentElement.scrollHeight : box.scrollHeight;
      const top = direction === "top" ? 0 : direction === "bottom" ? max : current + (direction === "down" ? 0.8 : -0.8) * page;
      if (box === null) window.scrollTo({ top });
      else box.scrollTop = top;
      return { direction, ...scrollState(root) };
    },
  };

  const click: PageAction<{ ref: string; generation: number }> = {
    name: "page.click",
    description: "Click an element from page.snapshot (ref + generation). The visitor approves every click.",
    sensitivity: "mutate",
    parameters: { type: "object", properties: { ref: refSchema, generation: genSchema }, required: ["ref", "generation"], additionalProperties: false },
    handler: (args) => {
      const el = resolve(args);
      if (isDisabled(el)) throw new Error(`Ref "${args.ref}" is disabled`);
      el.scrollIntoView?.({ block: "center", inline: "nearest" });
      if (el instanceof HTMLElement) {
        el.focus({ preventScroll: true });
        el.click();
      } else {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
      }
      return { ref: args.ref, clicked: describe(el) };
    },
  };

  const fill: PageAction<{ ref: string; generation: number; text: string }> = {
    name: "page.fill",
    description: "Replace the value of a text field, textarea, select (option value or label) or editable area from page.snapshot (ref + generation). The visitor approves every fill.",
    sensitivity: "mutate",
    parameters: {
      type: "object",
      properties: { ref: refSchema, generation: genSchema, text: { type: "string", maxLength: 10000 } },
      required: ["ref", "generation", "text"],
      additionalProperties: false,
    },
    handler: (args) => {
      const el = resolve(args);
      if (isDisabled(el) || (el as HTMLInputElement).readOnly) throw new Error(`Ref "${args.ref}" is not editable`);
      setValue(el, args.text);
      return { ref: args.ref, value: clip(currentValue(el), MAX_VALUE) };
    },
  };

  return {
    actions: [snapshot, scroll, click, fill],
    target: (args) => {
      try {
        return describe(resolve(args as { ref: string; generation: number }));
      } catch {
        return undefined;
      }
    },
  };
}

function setValue(el: Element, text: string) {
  if (el instanceof HTMLInputElement) {
    if (UNFILLABLE_INPUTS.has(el.type)) throw new Error(`Inputs of type "${el.type}" cannot be filled; use page.click`);
    nativeSet(HTMLInputElement.prototype, el, text);
  } else if (el instanceof HTMLTextAreaElement) {
    nativeSet(HTMLTextAreaElement.prototype, el, text);
  } else if (el instanceof HTMLSelectElement) {
    const opt = [...el.options].find((op) => op.value === text) ?? [...el.options].find((op) => squash(op.textContent).toLowerCase() === squash(text).toLowerCase());
    if (!opt) throw new Error(`No option "${clip(text, MAX_VALUE)}"`);
    nativeSet(HTMLSelectElement.prototype, el, opt.value);
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    el.focus({ preventScroll: true });
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: text }));
    return;
  } else {
    throw new Error("This element cannot be filled; use page.click");
  }
  (el as HTMLElement).focus({ preventScroll: true });
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// Frameworks (React) track `value` through the instance property; the prototype setter updates the
// DOM without bypassing their change detection, so the dispatched input event is seen as a change.
function nativeSet(proto: object, el: Element, value: string) {
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (set) set.call(el, value);
  else (el as HTMLInputElement).value = value;
}

function currentValue(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
  return squash(el.textContent);
}

function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || el.closest("fieldset[disabled]") !== null || el.getAttribute("aria-disabled") === "true";
}

function isSensitive(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === "password") return true;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return false;
  if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute("autocomplete") ?? "")) return true;
  const hint = [el.name, el.id, el.getAttribute("aria-label"), (el as HTMLInputElement).placeholder].filter(Boolean).join(" ");
  return SENSITIVE_NAME.test(hint);
}

function isVisible(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === "hidden") return false;
  if (el.closest("[hidden],[inert],[aria-hidden=true]")) return false;
  for (let n: Element | null = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === "none" || (n === el && (cs.visibility === "hidden" || cs.visibility === "collapse"))) return false;
  }
  return true;
}

function role(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "summary") return "button";
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    if (t === "checkbox" || t === "radio") return t;
    if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
    if (t === "search") return "searchbox";
    if (t === "range") return "slider";
    return t === "text" ? "textbox" : `textbox:${t}`;
  }
  if ((el as HTMLElement).isContentEditable) return "textbox";
  return tag;
}

function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => squash(document.getElementById(id)?.textContent)).filter(Boolean).join(" ");
    if (text) return text;
  }
  const aria = squash(el.getAttribute("aria-label"));
  if (aria) return aria;
  const labels = (el as HTMLInputElement).labels;
  if (labels?.length) {
    const text = squash([...labels].map((l) => l.textContent).join(" "));
    if (text) return text;
  }
  if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type)) return squash(el.value);
  const text = el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? "" : squash(el.textContent);
  return text || squash(el.getAttribute("placeholder")) || squash(el.getAttribute("title")) || squash(el.querySelector("img[alt]")?.getAttribute("alt")) || squash(el.getAttribute("name"));
}

function describe(el: Element): string {
  const parts = [role(el), JSON.stringify(clip(accessibleName(el), MAX_NAME))];
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) parts.push(el.checked ? "checked" : "unchecked");
  else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const v = currentValue(el);
    if (v && !(el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type))) parts.push(`value=${JSON.stringify(clip(v, MAX_VALUE))}`);
  }
  if (el instanceof HTMLAnchorElement) parts.push(`href=${JSON.stringify(clip(el.getAttribute("href") ?? "", MAX_NAME))}`);
  if (isDisabled(el)) parts.push("disabled");
  return parts.join(" ");
}

/** The scrollable element for a custom root, or null for the window. */
function scroller(root: Element): Element | null {
  if (root === document.body || root === document.documentElement) return null;
  return root.scrollHeight > root.clientHeight ? root : null;
}

function scrollState(root: Element) {
  const box = scroller(root);
  if (box === null) return { scrollY: Math.round(window.scrollY), maxScrollY: Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight)) };
  return { scrollY: Math.round(box.scrollTop), maxScrollY: Math.max(0, Math.round(box.scrollHeight - box.clientHeight)) };
}
