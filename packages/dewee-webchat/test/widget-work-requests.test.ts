// @vitest-environment happy-dom
// <dewee-chat> business requests against a stateful mock backend that keeps requests per visitor with
// real idempotency: the "request a callback" entry only when a callback kind is offered, the form
// (labels, errors tied to fields, consent, focus), one key per confirmed intent (double click, two
// widgets on one page, retry, reload), unknown outcomes reconciled by key, definite refusals, an expired
// session, another visitor, receipts restored and kept apart from each other and from the takeover, and
// no contact data in storage, events or the console.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";
import { formatDue } from "../src/widget/work-requests";
import { locales } from "../src/widget/i18n";

const CONFIG = { agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "0.5.0-test" };
const KINDS = [
  { kind: "callback", title: "Call me back", schema: "callback", staffedNow: false },
  { kind: "quote", title: "Ask for a quote", schema: "generic", staffedNow: true },
];
// Built by concatenation: phone-like fixtures are never literal.
const PHONE = "+84 " + "912" + " 345 " + "678";
const DUE = "2026-11-25T09:30:00Z";
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const sse = (frames: unknown[]) => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

interface Stored { visitor: string; key: string; content: string; view: Record<string, string> }
type Fault = "drop" | "unknown" | "limited" | "unavailable" | "invalid" | "expired" | "hang" | "lost" | "not-mine";

let codeSeq = 0;
const nextCode = () => "WR-" + String(++codeSeq).padStart(8, "0").replace(/[ILOU]/g, "0");

/** A backend that keeps work requests per visitor like the hosts and CCP do. */
function backend(opts: { feature?: boolean; kinds?: typeof KINDS; handoff?: boolean } = {}) {
  const state = {
    requests: [] as Stored[],
    /** One fault per create, applied in order. */
    faults: [] as Fault[],
    listFailures: 0,
    calls: [] as Array<{ path: string; body: any; visitor: string | null }>,
    sessions: 0,
    /** Tokens refused once with 401 (an expired session). */
    expired: new Set<string>(),
    gate: undefined as undefined | Promise<void>,
  };
  const visitorOf = (init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    const m = /^Bearer tok-(\d+)$/.exec(auth);
    return m ? `v${m[1]}` : null;
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "https://site.test");
    const path = u.pathname.replace(/^\/api\/dewee\//, "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const visitor = visitorOf(init);
    state.calls.push({ path, body, visitor });
    if (path === "config") return json({ ...CONFIG, ...(opts.handoff ? { humanHandoff: true } : {}), ...(opts.feature === false ? {} : { workRequests: opts.kinds ?? KINDS }) });
    if (path === "session") {
      const reused = typeof body?.token === "string" && /^tok-\d+$/.test(body.token) ? body.token : `tok-${++state.sessions}`;
      return json({ visitorId: `v${reused.slice(4)}`, token: reused, expiresAt: Date.now() + 86_400_000 });
    }
    if (path === "history") return json({ messages: [] });
    if (path === "chat") return sse([{ type: "start", conversationId: body.conversationId, agent: "support" }, { type: "delta", text: "Hello" }, { type: "done", content: "Hello" }]);
    if (path === "request-human") return json({ control: "agent", staffOnDuty: false });
    if (!visitor) return json({ error: { code: "unauthorized", message: "Missing or expired visitor session" } }, 401);
    const token = `tok-${visitor.slice(1)}`;
    if (path === "work-requests") {
      const fault = state.faults.shift();
      if (fault === "expired" || state.expired.has(token)) {
        state.expired.delete(token);
        return json({ error: { code: "unauthorized", message: "Missing or expired visitor session" } }, 401);
      }
      if (fault === "limited") return json({ error: { code: "rate_limited", message: "Too many requests" } }, 429, { "retry-after": "60" });
      if (fault === "unavailable") return json({ error: { code: "work_requests_unavailable", message: "This request cannot be sent here" } }, 403);
      if (fault === "not-mine" && body.conversationId) return json({ error: { code: "not_found", message: "Not found" } }, 404);
      if (fault === "invalid") return json({ error: { code: "bad_request", message: "Invalid request" } }, 400);
      if (state.gate) await state.gate;
      if (fault === "lost") return new Promise<Response>(() => {}); // never reaches the server
      const content = JSON.stringify([body.kind, body.payload, body.summary, body.conversationId ?? ""]);
      const same = state.requests.find((r) => r.visitor === visitor && r.key === body.idempotencyKey);
      if (same) {
        if (same.content !== content) return json({ error: { code: "idempotency_conflict", message: "This request was already sent with other details" } }, 409);
        return json({ workRequest: same.view, replayed: true });
      }
      const now = new Date(Date.UTC(2026, 10, 25, 5, 30, state.requests.length)).toISOString();
      const view = {
        code: nextCode(), kind: body.kind, summary: body.summary, state: "received", receivedAt: now, respondDueAt: DUE, dueTimezone: "Asia/Ho_Chi_Minh",
        publicNote: "", contactHint: "***" + String(body.payload.contact_value ?? "").slice(-3), updatedAt: now,
      };
      state.requests.push({ visitor, key: body.idempotencyKey, content, view });
      if (fault === "drop") throw new TypeError("Failed to fetch"); // stored, then the connection was lost
      if (fault === "hang") return new Promise<Response>(() => {}); // stored, the answer never comes
      if (fault === "unknown") return json({ error: { code: "work_request_outcome_unknown", message: "The request may have been received." } }, 503, { "retry-after": "5" });
      return json({ workRequest: view, replayed: false }, 201);
    }
    if (path === "work-requests/list") {
      if (state.listFailures > 0) {
        state.listFailures--;
        return json({ error: { code: "gateway_error", message: "Dewee is unavailable" } }, 502);
      }
      const mine = state.requests.filter((r) => r.visitor === visitor && (!body.idempotencyKey || r.key === body.idempotencyKey)).reverse();
      return json({ workRequests: mine.slice(0, body.limit ?? 50).map((r) => r.view) });
    }
    throw new Error(`unexpected ${path}`);
  }));
  return {
    state,
    creates: () => state.calls.filter((c) => c.path === "work-requests"),
    lists: () => state.calls.filter((c) => c.path === "work-requests/list"),
    update(code: string, patch: Record<string, string>) {
      const r = state.requests.find((x) => x.view.code === code)!;
      r.view = { ...r.view, ...patch };
    },
    seed(visitor: string, kind: string, summary: string) {
      const now = new Date(Date.UTC(2026, 10, 24, 1, 0, state.requests.length)).toISOString();
      const view = { code: nextCode(), kind, summary, state: "received", receivedAt: now, respondDueAt: DUE, dueTimezone: "Asia/Ho_Chi_Minh", publicNote: "", contactHint: kind === "callback" ? "***678" : "", updatedAt: now };
      state.requests.push({ visitor, key: "seed-" + view.code, content: "", view });
      return view.code;
    },
  };
}

const realImmediate = globalThis.setImmediate;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => realImmediate(r)); };
const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await settle(); };

const events: Array<{ name: string; detail: unknown }> = [];
async function mount(attrs: Record<string, string> = {}) {
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  for (const [k, v] of Object.entries({ endpoint: "/api/dewee", mode: "inline", persist: "false", locale: "en", ...attrs })) el.setAttribute(k, v);
  for (const name of ["dewee:work-request", "dewee:reply", "dewee:error", "dewee:status"]) el.addEventListener(name, (e) => events.push({ name, detail: (e as CustomEvent).detail }));
  const ready = new Promise<void>((r) => el.addEventListener("dewee:ready", () => r(), { once: true }));
  document.body.appendChild(el);
  await ready;
  await settle();
  return el;
}

const $ = <T extends Element = HTMLElement>(el: DeweeChatElement, sel: string) => el.shadowRoot!.querySelector(sel) as T | null;
const entry = (el: DeweeChatElement) => $<HTMLButtonElement>(el, ".wr-open")!;
const dialog = (el: DeweeChatElement) => $(el, ".wr-dialog");
const announcer = (el: DeweeChatElement) => $(el, ".announcer")!.textContent;
const receipts = (el: DeweeChatElement) => [...el.shadowRoot!.querySelectorAll<HTMLElement>(".wr-receipt")];
const receiptText = (r: HTMLElement) => ({
  code: r.querySelector(".wr-code")!.textContent, kind: r.querySelector(".wr-kind")!.textContent, state: r.querySelector(".wr-state")!.textContent,
  due: r.querySelector(".wr-due time")?.textContent ?? null, contact: r.querySelector(".wr-contact-hint")?.textContent ?? null, note: r.querySelector(".wr-note")?.textContent ?? null,
});

/** Opens the form and fills it like a visitor. */
async function fill(el: DeweeChatElement, v: { method?: string; contact?: string; purpose?: string; consent?: boolean } = {}) {
  if (!dialog(el)) entry(el).click();
  const d = dialog(el)!;
  const method = v.method ?? "phone";
  const radio = d.querySelector<HTMLInputElement>(`input[type=radio][value="${method}"]`)!;
  radio.checked = true;
  radio.dispatchEvent(new Event("change", { bubbles: true }));
  const contact = d.querySelector<HTMLInputElement>(".wr-contact")!;
  contact.value = v.contact ?? PHONE;
  contact.dispatchEvent(new Event("input", { bubbles: true }));
  const purpose = d.querySelector<HTMLTextAreaElement>(".wr-purpose")!;
  purpose.value = v.purpose ?? "Please call me about my order";
  purpose.dispatchEvent(new Event("input", { bubbles: true }));
  d.querySelector<HTMLInputElement>(".wr-consent-box")!.checked = v.consent ?? true;
  return d;
}
const submit = (el: DeweeChatElement) => dialog(el)!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

/** Everything a page or a log could see: storage, events, console lines. */
function exposed(consoleSpy: ReturnType<typeof vi.spyOn>[]) {
  const store = (s: Storage) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`).join("\n");
  return [store(localStorage), store(sessionStorage), JSON.stringify(events), ...consoleSpy.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" ")))].join("\n");
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeAll(() => defineDeweeChat());
beforeEach(() => {
  events.length = 0;
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  // Focus leaves the widgets before they are removed, as a browser would move it.
  let active = document.activeElement as (HTMLElement & { shadowRoot: ShadowRoot | null }) | null;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement as typeof active;
  active?.blur?.();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("<dewee-chat> business requests: backend without them", () => {
  it("shows no entry and no receipts, never calls the routes and runs no timer", async () => {
    const b = backend({ feature: false });
    const el = await mount();
    await el.send("hi");
    await settle();
    expect($(el, ".wr-entry")!.hidden).toBe(true);
    expect($(el, ".wr-receipts")!.hidden).toBe(true);
    vi.useFakeTimers();
    el.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    await tick(60 * 60_000);
    expect(b.creates()).toHaveLength(0);
    expect(b.lists()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("offers no entry when only generic kinds are offered, but still shows their receipts", async () => {
    const b = backend({ kinds: [KINDS[1]] });
    b.seed("v1", "quote", "A quote");
    localStorage.setItem("dewee-webchat:session:/api/dewee", JSON.stringify({ visitorId: "v1", token: "tok-1", expiresAt: Date.now() + 86_400_000, obtainedAt: Date.now() }));
    const el = await mount();
    expect($(el, ".wr-entry")!.hidden).toBe(true);
    expect(receipts(el).map(receiptText)).toEqual([expect.objectContaining({ kind: "Ask for a quote", state: "Received" })]);
  });
});

describe("<dewee-chat> callback request", () => {
  it("shows the entry with the off-hours hint, opens a labelled form with focus inside, and a declined form sends nothing", async () => {
    const b = backend();
    const el = await mount();
    expect(entry(el).hidden).toBe(false);
    expect(entry(el).textContent).toBe("Request a callback");
    expect($(el, ".wr-hint")!.textContent).toBe("No one is available right now. You can ask us to call you back.");
    expect(b.lists()).toHaveLength(0); // no session yet: nothing to list, none opened for it
    entry(el).click();
    const d = dialog(el)!;
    const form = d.querySelector("form")!;
    expect(form.getAttribute("role")).toBe("dialog");
    expect(d.querySelector(`#${form.getAttribute("aria-labelledby")}`)!.textContent).toBe("Call me back");
    expect(el.shadowRoot!.activeElement).toBe(d.querySelector("input[type=radio][value=phone]"));
    expect(d.querySelector(".wr-contact-label")!.textContent).toBe("Phone number");
    expect(d.querySelector(".wr-consent-label")!.textContent).toBe("I agree to be contacted at these details only for this request (Call me back).");
    // Escape closes the form only (not the chat), and the focus returns to the entry.
    d.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog(el)).toBeNull();
    expect(el.shadowRoot!.activeElement).toBe(entry(el));
    // Declining: filled, consent not given, then cancelled: nothing is sent and the chat keeps working.
    await fill(el, { consent: false });
    submit(el);
    await settle();
    const consentError = dialog(el)!.querySelector<HTMLElement>('.wr-error[data-for="consent"]')!;
    expect(consentError.hidden).toBe(false);
    expect(dialog(el)!.querySelector(".wr-consent-box")!.getAttribute("aria-describedby")).toBe(consentError.id);
    dialog(el)!.querySelector<HTMLButtonElement>(".wr-cancel")!.click();
    expect(dialog(el)).toBeNull();
    await el.send("still chatting");
    await settle();
    expect(b.creates()).toHaveLength(0);
    expect(b.state.calls.some((c) => c.path === "chat")).toBe(true);
  });

  it("checks fields like the server before sending, with the error tied to its field", async () => {
    const b = backend();
    const el = await mount();
    await fill(el, { contact: "12-34" });
    submit(el);
    await settle();
    const d = dialog(el)!;
    const contact = d.querySelector<HTMLInputElement>(".wr-contact")!;
    const error = d.querySelector<HTMLElement>('.wr-error[data-for="contact_value"]')!;
    expect([error.hidden, error.textContent]).toEqual([false, "Enter a phone number with 6 to 15 digits."]);
    expect(contact.getAttribute("aria-invalid")).toBe("true");
    expect(contact.getAttribute("aria-describedby")).toBe(error.id);
    expect(el.shadowRoot!.activeElement).toBe(contact);
    await fill(el, { method: "email", contact: "not-an-address" });
    submit(el);
    await settle();
    expect(error.textContent).toBe("Enter a valid email address.");
    await fill(el, { purpose: "  " });
    submit(el);
    await settle();
    expect(d.querySelector<HTMLElement>('.wr-error[data-for="purpose"]')!.hidden).toBe(false);
    expect(b.creates()).toHaveLength(0);
  });

  it("sends one request for a double click and shows the server's receipt; nothing the visitor typed is kept or told", async () => {
    const b = backend();
    const el = await mount();
    await el.send("hi");
    await settle();
    await fill(el);
    submit(el);
    submit(el);
    expect(dialog(el)!.querySelector(".wr-status")!.textContent).toBe("Sending your request…");
    expect(dialog(el)!.querySelector<HTMLInputElement>(".wr-contact")!.disabled).toBe(true);
    await settle();
    expect(b.creates()).toHaveLength(1);
    const sent = b.creates()[0].body;
    expect(sent).toEqual({
      kind: "callback", summary: "Please call me about my order", idempotencyKey: expect.stringMatching(/^wr-[A-Za-z0-9_-]{24}$/),
      payload: { contact_method: "phone", contact_value: PHONE, purpose: "Please call me about my order", consent: true },
      conversationId: b.state.calls.find((c) => c.path === "chat")!.body.conversationId, agent: "support",
    });
    expect(sent.idempotencyKey).not.toContain(sent.conversationId);
    expect(dialog(el)).toBeNull();
    expect(el.shadowRoot!.activeElement).toBe(entry(el));
    const code = b.state.requests[0].view.code;
    expect(receipts(el).map(receiptText)).toEqual([{
      code, kind: "Call me back", state: "Received", due: formatDue(DUE, "Asia/Ho_Chi_Minh", "en", locales.en.workRequests), contact: "Contact: ***678", note: null,
    }]);
    expect(announcer(el)).toBe(`Request received. Your code is ${code}.`);
    expect(events.filter((e) => e.name === "dewee:work-request")).toEqual([{ name: "dewee:work-request", detail: { code, state: "received" } }]);
    // The recorded intent's key is gone: the next request is a new intent with a new key.
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith("dewee-webchat:wr-draft:"))).toEqual([]);
    await fill(el, { purpose: "Another question" });
    submit(el);
    await settle();
    expect(b.creates()).toHaveLength(2);
    expect(b.creates()[1].body.idempotencyKey).not.toBe(sent.idempotencyKey);
    expect(receipts(el)).toHaveLength(2);
    const leaks = exposed(consoleSpies);
    expect(leaks).not.toContain("912 345");
    expect(leaks).not.toContain("call me about");
  });

  it("two widgets on one page send the same intent once: the second gets the stored request back", async () => {
    const b = backend();
    const one = await mount();
    const two = await mount();
    let open!: () => void;
    b.state.gate = new Promise<void>((r) => { open = r; });
    await fill(one);
    await fill(two);
    submit(one);
    await settle();
    submit(two);
    await settle();
    open();
    await settle();
    expect(b.creates()).toHaveLength(2);
    expect(b.creates()[1].body.idempotencyKey).toBe(b.creates()[0].body.idempotencyKey);
    expect(b.state.requests).toHaveLength(1);
    expect(receipts(one).map(receiptText)).toEqual(receipts(two).map(receiptText));
  });

  it("finds a request whose answer was lost after it was stored, by its key, without sending it again", async () => {
    const b = backend();
    const el = await mount();
    b.state.faults.push("drop");
    await fill(el);
    submit(el);
    await settle();
    expect(b.creates()).toHaveLength(1);
    expect(b.lists().filter((c) => c.body.idempotencyKey).map((c) => c.body)).toEqual([{ idempotencyKey: b.creates()[0].body.idempotencyKey, limit: 1 }]);
    expect(b.state.requests).toHaveLength(1);
    expect(receipts(el).map((r) => r.dataset.code)).toEqual([b.state.requests[0].view.code]);
    expect(dialog(el)).toBeNull();
  });

  it("an outcome it cannot confirm offers check again and send again, both with the same key and content", async () => {
    const b = backend();
    const el = await mount();
    b.state.faults.push("unknown");
    b.state.listFailures = 1; // the automatic check fails too
    await fill(el);
    submit(el);
    await settle();
    const d = dialog(el)!;
    expect(d.querySelector(".wr-status")!.textContent).toBe("We couldn't confirm that your request was received. Check again, or send it again: it won't be sent twice.");
    expect(d.querySelector<HTMLInputElement>(".wr-contact")!.disabled).toBe(true);
    expect(d.querySelector<HTMLButtonElement>(".wr-check")!.hidden).toBe(false);
    expect(d.querySelector(".wr-submit")!.textContent).toBe("Send again");
    expect(receipts(el)).toHaveLength(0); // no code before the server confirms one
    // Closed and reopened: still unconfirmed, nothing lost.
    d.querySelector<HTMLButtonElement>(".wr-cancel")!.click();
    entry(el).click();
    expect(dialog(el)!.querySelector(".wr-submit")!.textContent).toBe("Send again");
    // The fields are locked: the focus still goes into the dialog, on the first control that can take it.
    expect(dialog(el)!.contains(el.shadowRoot!.activeElement)).toBe(true);
    submit(el); // send again
    await settle();
    expect(b.creates()).toHaveLength(2);
    expect(b.creates()[1].body).toEqual(b.creates()[0].body);
    expect(b.state.requests).toHaveLength(1);
    expect(receipts(el)).toHaveLength(1);
  });

  it("a reload during the send finds the request by the key kept in the tab, which holds no contact data", async () => {
    const b = backend();
    const first = await mount();
    b.state.faults.push("hang");
    await fill(first);
    submit(first);
    await settle();
    const drafts = Object.keys(sessionStorage).filter((k) => k.startsWith("dewee-webchat:wr-draft:"));
    expect(drafts).toEqual(["dewee-webchat:wr-draft:/api/dewee|callback"]);
    const stored = JSON.parse(sessionStorage.getItem(drafts[0])!);
    expect(Object.keys(stored).sort()).toEqual(["at", "key"]);
    expect(stored.key).toBe(b.creates()[0].body.idempotencyKey);
    first.remove(); // the page reloads; the hanging request was stored by the server
    const second = await mount();
    expect(b.lists().filter((c) => c.body.idempotencyKey).map((c) => c.body)).toEqual([{ idempotencyKey: stored.key, limit: 1 }]);
    expect(receipts(second).map((r) => r.dataset.code)).toEqual([b.state.requests[0].view.code]);
    expect(sessionStorage.getItem(drafts[0])).toBeNull();
  });

  it("a definite refusal keeps the key for the same content, and a change makes a new intent", async () => {
    const b = backend();
    const el = await mount();
    b.state.faults.push("limited", "unavailable");
    await fill(el);
    submit(el);
    await settle();
    expect(dialog(el)!.querySelector(".wr-status")!.textContent).toBe("You've sent several requests already. Please wait a while and try again.");
    expect(dialog(el)!.querySelector<HTMLInputElement>(".wr-contact")!.disabled).toBe(false);
    submit(el);
    await settle();
    expect(dialog(el)!.querySelector(".wr-status")!.textContent).toBe("This request can't be sent here right now.");
    expect(b.creates()[1].body.idempotencyKey).toBe(b.creates()[0].body.idempotencyKey);
    await fill(el, { purpose: "Changed my mind" });
    submit(el);
    await settle();
    expect(b.creates()).toHaveLength(3);
    expect(b.creates()[2].body.idempotencyKey).not.toBe(b.creates()[0].body.idempotencyKey);
    expect(receipts(el)).toHaveLength(1);
    expect(b.lists().filter((c) => c.body.idempotencyKey)).toHaveLength(0); // definite refusals are never "checked"
  });

  it("a key that already holds other details shows that request and says the new details were not sent", async () => {
    const b = backend();
    const el = await mount();
    b.state.faults.push("lost");
    await fill(el, { purpose: "First version" });
    submit(el);
    await settle();
    el.remove(); // reloaded mid-send
    const again = await mount();
    // The reload's check ran before the hanging request was stored: the draft keeps its key.
    expect(receipts(again)).toHaveLength(0);
    const key = b.creates()[0].body.idempotencyKey;
    b.state.requests.push({ visitor: "v1", key, content: "other", view: { code: "WR-0000CQNF", kind: "callback", summary: "First version", state: "received", receivedAt: "2026-11-25T01:00:00Z", respondDueAt: DUE, dueTimezone: "Asia/Ho_Chi_Minh", publicNote: "", contactHint: "***678", updatedAt: "2026-11-25T01:00:00Z" } });
    await fill(again, { purpose: "Second version" });
    submit(again);
    await settle();
    expect(b.creates().at(-1)!.body.idempotencyKey).toBe(key);
    expect(dialog(again)!.querySelector(".wr-status")!.textContent).toBe("A request was already sent with other details. Your new details weren't sent.");
    expect(receipts(again).map((r) => r.dataset.code)).toEqual(["WR-0000CQNF"]);
    submit(again);
    await settle();
    expect(b.creates().at(-1)!.body.idempotencyKey).not.toBe(key);
  });

  it("renews an expired session and sends the same request again with the same key", async () => {
    const b = backend();
    const el = await mount();
    b.state.faults.push("expired");
    await fill(el);
    submit(el);
    await settle();
    expect(b.creates()).toHaveLength(2);
    expect(b.creates()[1].body.idempotencyKey).toBe(b.creates()[0].body.idempotencyKey);
    expect(b.creates()[1].visitor).not.toBe(b.creates()[0].visitor);
    expect(receipts(el)).toHaveLength(1);
  });

  it("sends the request on its own, with the same key, when its conversation is not the visitor's", async () => {
    const b = backend();
    const el = await mount();
    await el.send("hi");
    await settle();
    b.state.faults.push("not-mine");
    await fill(el);
    submit(el);
    await settle();
    expect(b.creates().map((c) => [c.body.idempotencyKey, c.body.conversationId])).toEqual([
      [b.creates()[0].body.idempotencyKey, expect.any(String)],
      [b.creates()[0].body.idempotencyKey, undefined],
    ]);
    expect(receipts(el)).toHaveLength(1);
  });

  it("is in Vietnamese for a Vietnamese page", async () => {
    backend();
    const el = await mount({ locale: "vi" });
    expect(entry(el).textContent).toBe("Nhờ gọi lại");
    expect($(el, ".wr-hint")!.textContent).toBe("Hiện chưa có ai trực. Bạn có thể nhờ chúng tôi gọi lại.");
    entry(el).click();
    const d = dialog(el)!;
    expect(d.querySelector("legend")!.textContent).toBe("Liên hệ bạn qua đâu?");
    expect(d.querySelector(".wr-contact-label")!.textContent).toBe("Số điện thoại");
    expect(d.querySelector(".wr-submit")!.textContent).toBe("Gửi yêu cầu");
    for (const key of Object.keys(locales.en.workRequests) as Array<keyof typeof locales.en.workRequests>) expect(locales.vi.workRequests[key], key).toBeTruthy();
    expect(locales.vi.workRequests.states).toEqual({ received: "Đã nhận", in_progress: "Đang xử lý", waiting: "Đang tạm chờ", resolved: "Đã giải quyết", cancelled: "Đã hủy" });
  });
});

describe("<dewee-chat> receipts", () => {
  const holdSession = (visitor: string) =>
    localStorage.setItem("dewee-webchat:session:/api/dewee", JSON.stringify({ visitorId: visitor, token: `tok-${visitor.slice(1)}`, expiresAt: Date.now() + 86_400_000, obtainedAt: Date.now() }));

  it("restores each request of the visitor as its own receipt, and a change to one leaves the other as it was", async () => {
    const b = backend();
    const callback = b.seed("v7", "callback", "Call me");
    const quote = b.seed("v7", "quote", "A quote for 20 chairs");
    b.seed("v8", "callback", "Someone else");
    holdSession("v7");
    const el = await mount();
    expect(b.lists()[0]).toMatchObject({ visitor: "v7", body: { limit: 20 } });
    const [newest, oldest] = receipts(el);
    expect([newest.dataset.code, oldest.dataset.code]).toEqual([quote, callback]);
    expect(receiptText(oldest)).toMatchObject({ kind: "Call me back", state: "Received", contact: "Contact: ***678" });
    expect(receiptText(newest)).toMatchObject({ kind: "Ask for a quote", state: "Received", contact: null });
    const before = newest.outerHTML;
    b.update(callback, { state: "in_progress", publicNote: "We will call after 2 pm" });
    vi.useFakeTimers();
    await tick(11_000);
    el.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    await tick(0);
    const [quoteAfter, callbackAfter] = receipts(el);
    expect(quoteAfter).toBe(newest);
    expect(quoteAfter.outerHTML).toBe(before);
    expect(callbackAfter).toBe(oldest);
    expect(receiptText(callbackAfter)).toMatchObject({ state: "In progress", note: "Note: We will call after 2 pm" });
    expect(announcer(el)).toBe(`Request ${callback}: In progress`);
    expect(events.filter((e) => e.name === "dewee:work-request").map((e) => e.detail)).toEqual([{ code: callback, state: "in_progress" }]);
  });

  it("never words a request that is not finished as done", () => {
    for (const s of [locales.en.workRequests, locales.vi.workRequests]) {
      for (const state of ["received", "in_progress", "waiting"] as const) expect(s.states[state]).not.toMatch(/done|complete|resolved|xong|hoàn tất|giải quyết/i);
    }
  });

  it("another visitor sees none of them, and a sign-in or sign-out drops the previous visitor's receipts", async () => {
    const b = backend();
    b.seed("v7", "callback", "Call me");
    holdSession("v9");
    const el = await mount();
    expect(b.lists()[0].visitor).toBe("v9");
    expect(receipts(el)).toHaveLength(0);
    expect($(el, ".wr-receipts")!.hidden).toBe(true);
    document.body.innerHTML = "";
    holdSession("v7");
    const owner = await mount();
    expect(receipts(owner)).toHaveLength(1);
    localStorage.clear();
    await owner.renewSession();
    await settle();
    expect(receipts(owner)).toHaveLength(0);
  });

  it("keeps receipts apart from the takeover and the conversation: neither changes them", async () => {
    const b = backend({ handoff: true });
    const code = b.seed("v7", "callback", "Call me");
    holdSession("v7");
    const el = await mount();
    const receipt = receipts(el)[0];
    const before = receipt.outerHTML;
    await el.send("hi");
    await settle();
    $<HTMLButtonElement>(el, ".handoff-request")!.click(); // nobody on duty
    await settle();
    expect($(el, ".handoff-status")!.textContent).toBe("No one is available right now. The assistant will keep helping you.");
    el.newConversation();
    await settle();
    expect(receipts(el)).toHaveLength(1);
    expect(receipts(el)[0]).toBe(receipt);
    expect(receipt.outerHTML).toBe(before);
    expect(receipt.dataset.code).toBe(code);
  });

  it("a failed read keeps the receipts shown and the chat working", async () => {
    const b = backend();
    b.seed("v7", "callback", "Call me");
    holdSession("v7");
    const el = await mount();
    b.state.listFailures = 5;
    vi.useFakeTimers();
    await tick(11_000);
    el.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    await tick(0);
    expect(receipts(el)).toHaveLength(1);
    vi.useRealTimers();
    await el.send("hi");
    await settle();
    expect(b.state.calls.some((c) => c.path === "chat")).toBe(true);
  });

  it("follows a new request with backoff, and stops when the widget leaves the page", async () => {
    const b = backend();
    const el = await mount();
    vi.useFakeTimers();
    await fill(el);
    submit(el);
    await tick(0);
    const after = b.lists().length;
    await tick(30_000);
    expect(b.lists().length).toBe(after + 1);
    await tick(30_000);
    expect(b.lists().length).toBe(after + 1); // the next read is 60 s after the last one
    await tick(30_000);
    expect(b.lists().length).toBe(after + 2);
    el.remove();
    await tick(10 * 60_000);
    expect(b.lists().length).toBe(after + 2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
