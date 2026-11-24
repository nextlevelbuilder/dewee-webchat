// @vitest-environment happy-dom
// <dewee-chat> and the control plane's install check: a valid `?dewee_check=` nonce is read once and
// removed from the address bar, goes with one `/session` request, and only a `check: true` answer makes
// the widget send its one localized test message, in a conversation of its own, with the nonce in that
// chat body. A malformed nonce, an unconfirmed or refused one, a challenge, a renewed session, a moved
// widget, a reload and a direct gateway widget send nothing more. The nonce never reaches a snapshot,
// an event, storage, page context or a page-action result.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";
import { createDomActions } from "../src/actions/dom-actions";
import { locales } from "../src/widget/i18n";
import { resetPageInstallCheck } from "../src/widget/install-check";
import { safePageUrl } from "../src/widget/page-context";

const CONFIG = { agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "0.5.0-test" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const sse = (frames: unknown[]) => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
};

let seq = 0;
/** A fresh nonce per test. Built by concatenation: fixtures shaped like tokens are never literal. */
const nonce = () => "chk_" + String(++seq).padStart(4, "0") + "Q".repeat(20);

interface BackendOptions {
  /** The nonce the control plane accepts (`check: true`), if any. */
  accepts?: string | null;
  config?: Record<string, unknown>;
  /** Answers every `/session` with this error. */
  sessionError?: { status: number; code: string };
  /** Answers a `/session` that carries `check` with this error (a control plane without install checks). */
  checkSessionError?: { status: number; code: string };
  sessionGate?: Promise<void>;
  /** Holds the first chat stream until it opens. */
  chatGate?: Promise<void>;
  /** Conversations a person holds: chat answers 202. */
  held?: string[];
  history?: Array<{ role: string; content: string }>;
}

function backend(o: BackendOptions = {}) {
  const calls: Array<{ path: string; url: string; body: any; headers: Record<string, string> }> = [];
  let chats = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site.test").pathname.split("/").pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, url, body, headers: { ...(init?.headers as Record<string, string>) } });
    if (path === "config") return json({ ...CONFIG, ...o.config });
    if (path === "session") {
      if (o.sessionGate) await o.sessionGate;
      if (o.sessionError) return json({ error: { message: "refused", code: o.sessionError.code } }, o.sessionError.status);
      if (o.checkSessionError && body?.check) return json({ error: { message: "refused", code: o.checkSessionError.code } }, o.checkSessionError.status);
      return json({ visitorId: "v1", token: "visitor-token", expiresAt: Date.now() + 86_400_000, ...(o.accepts && body?.check === o.accepts ? { check: true } : {}) });
    }
    if (path === "history") return json({ messages: o.history ?? [] });
    if (path === "chat") {
      if (chats++ === 0 && o.chatGate) await o.chatGate;
      if (o.held?.includes(body.conversationId)) return json({ held: true, control: "human_active" }, 202);
      return sse([{ type: "start", conversationId: body.conversationId, agent: "support" }, { type: "delta", text: "It works" }, { type: "done", content: "It works" }]);
    }
    throw new Error(`unexpected ${path}`);
  }));
  return calls;
}

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
const withUrl = (search: string, hash = "") => history.replaceState(null, "", `/shop${search}${hash}`);
const of = (calls: ReturnType<typeof backend>, path: string) => calls.filter((c) => c.path === path);
const checked = (calls: ReturnType<typeof backend>) => calls.filter((c) => c.body && "check" in c.body);

async function mount(attrs: Record<string, string> = {}, before?: (el: DeweeChatElement) => void) {
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  for (const [k, v] of Object.entries({ endpoint: "/api/dewee", mode: "inline", persist: "false", locale: "en", ...attrs })) el.setAttribute(k, v);
  before?.(el);
  const statuses: unknown[] = [];
  const sends: Array<Record<string, unknown>> = [];
  el.addEventListener("dewee:status", (e) => statuses.push((e as CustomEvent).detail));
  el.addEventListener("dewee:send", (e) => sends.push((e as CustomEvent).detail));
  const ready = new Promise<void>((r) => el.addEventListener("dewee:ready", () => r(), { once: true }));
  document.body.appendChild(el);
  await ready;
  await settle();
  return { el, statuses, sends };
}

beforeAll(() => defineDeweeChat());
// Every test is a new page load.
beforeEach(() => resetPageInstallCheck());
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  withUrl("");
});

describe("<dewee-chat> install check: the page URL", () => {
  it("removes the parameter from the address bar, keeping the path, the other parameters and the hash", async () => {
    const n = nonce();
    backend({ accepts: n });
    history.replaceState({ from: "site" }, "", `/shop/item?utm_source=mail&dewee_check=${n}&q=a%20b#reviews`);
    await mount();
    expect(location.pathname + location.search + location.hash).toBe("/shop/item?utm_source=mail&q=a+b#reviews");
    expect(history.state).toEqual({ from: "site" });
  });

  it("ignores and removes a malformed nonce: no check is sent, nothing is sent automatically", async () => {
    for (const bad of ["short", "Q".repeat(65), "chk." + "Q".repeat(22), encodeURIComponent("chk_" + "Q".repeat(22) + "\n")]) {
      resetPageInstallCheck();
      const calls = backend({ accepts: bad });
      withUrl(`?dewee_check=${bad}`);
      const { el } = await mount();
      expect(location.search, bad).toBe("");
      expect(checked(calls), bad).toHaveLength(0);
      expect(of(calls, "chat"), bad).toHaveLength(0);
      expect(el.diagnostics().check, bad).toBeUndefined();
      el.remove();
    }
  });

  it("redacts the nonce from page context and page-action results for a widget that mounts late", async () => {
    const n = nonce();
    withUrl(`?a=1&dewee_check=${n}`);
    expect(safePageUrl(location.href)).toBe(`${location.origin}/shop?a=1&dewee_check=%5BREDACTED%5D`);
    const snapshot = createDomActions({ root: () => undefined }).actions.find((a) => a.name === "page.snapshot")!;
    const result = await snapshot.handler({}, { signal: new AbortController().signal } as never);
    expect(JSON.stringify(result)).not.toContain(n);
    expect((result as { url: string }).url).toBe("/shop?a=1&dewee_check=%5BREDACTED%5D");
  });
});

describe("<dewee-chat> install check: the gate", () => {
  it("sends the nonce with the session and never sends a message the backend did not confirm", async () => {
    const n = nonce();
    const calls = backend({ accepts: null });
    withUrl(`?utm_source=x&dewee_check=${n}`);
    const { el } = await mount();
    expect(of(calls, "session")).toHaveLength(1);
    expect(of(calls, "session")[0].body.check).toBe(n);
    expect(of(calls, "chat")).toHaveLength(0);
    expect(el.diagnostics()).toMatchObject({ session: { state: "ok" }, reply: { state: "idle" }, check: "ignored" });
  });

  it("asks the backend with the nonce even when a stored session is still fresh", async () => {
    const n = nonce();
    localStorage.setItem("dewee-webchat:session:/api/dewee", JSON.stringify({ visitorId: "v1", token: "stored-token", expiresAt: Date.now() + 86_400_000, expiresIn: 86_400_000, obtainedAt: Date.now() }));
    const calls = backend({ accepts: n });
    withUrl(`?dewee_check=${n}`);
    await mount();
    expect(of(calls, "session")).toHaveLength(1);
    expect(of(calls, "session")[0].body).toMatchObject({ token: "stored-token", check: n });
    expect(of(calls, "chat")).toHaveLength(1);
  });

  it("gives up as ignored rather than render a Turnstile challenge", async () => {
    const n = nonce();
    const calls = backend({ accepts: n, config: { turnstileSiteKey: "0x" + "4AAAAAAA" } });
    withUrl(`?dewee_check=${n}`);
    const { el } = await mount({ mode: "floating" });
    expect(of(calls, "session")).toHaveLength(0);
    expect(of(calls, "chat")).toHaveLength(0);
    expect(document.querySelector("script[src*='turnstile']")).toBeNull();
    expect(el.querySelector("[slot=challenge]")).toBeNull();
    expect(el.diagnostics()).toMatchObject({ session: { state: "idle" }, check: "ignored" });
  });

  it("reports a refused check session as failed and opens a session without it, so chat works", async () => {
    const n = nonce();
    const calls = backend({ accepts: n, checkSessionError: { status: 400, code: "invalid_request" } });
    withUrl(`?dewee_check=${n}`);
    const { el } = await mount();
    expect(of(calls, "session").map((c) => c.body.check)).toEqual([n, undefined]);
    expect(of(calls, "chat")).toHaveLength(0);
    expect(el.diagnostics()).toMatchObject({ session: { state: "ok" }, check: "failed" });
    await el.send("hello");
    await settle();
    expect(of(calls, "chat")).toHaveLength(1);
    expect(of(calls, "chat")[0].body.check).toBeUndefined();
  });

  it("on a site that requires sign-in, reports the refusal with the identity code and sends nothing", async () => {
    const n = nonce();
    const calls = backend({ accepts: n, sessionError: { status: 401, code: "IDENTITY_REQUIRED" } });
    withUrl(`?dewee_check=${n}`);
    const { el } = await mount();
    expect(of(calls, "session").map((c) => c.body.check)).toEqual([n, undefined]);
    expect(of(calls, "chat")).toHaveLength(0);
    expect(el.diagnostics()).toMatchObject({ session: { state: "failed", code: "IDENTITY_REQUIRED" }, check: "failed" });
  });

  it("ignores the nonce when the widget talks to a gateway directly", async () => {
    const n = nonce();
    const calls = backend({ accepts: n });
    withUrl(`?dewee_check=${n}`);
    const { el } = await mount({ "gateway-url": "https://gw.example.com", "gateway-token": "gw-" + "token" });
    expect(checked(calls)).toHaveLength(0);
    expect(of(calls, "chat")).toHaveLength(0);
    expect(el.diagnostics().check).toBeUndefined();
  });

  it("without a nonce, a closed floating widget stays idle", async () => {
    const calls = backend();
    const el = document.createElement("dewee-chat") as DeweeChatElement;
    el.setAttribute("endpoint", "/api/dewee");
    document.body.appendChild(el);
    await settle();
    expect(calls).toHaveLength(0);
    expect(el.diagnostics().check).toBeUndefined();
  });
});

describe("<dewee-chat> install check: the test message", () => {
  it("after check: true, sends one localized message carrying the nonce, and never another", async () => {
    const n = nonce();
    const calls = backend({ accepts: n });
    withUrl(`?dewee_check=${n}`);
    const { el, statuses, sends } = await mount();
    const chats = of(calls, "chat");
    expect(chats).toHaveLength(1);
    expect(chats[0].body).toMatchObject({ message: locales.en.installCheck, check: n, agent: "support" });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ message: locales.en.installCheck, check: true });
    expect(el.diagnostics()).toMatchObject({ session: { state: "ok" }, reply: { state: "ok" }, check: "accepted" });
    // The nonce is never in a snapshot, an event, storage, a request URL or a header.
    expect(JSON.stringify([statuses, sends, el.diagnostics()])).not.toContain(n);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(n);
    expect(JSON.stringify({ ...localStorage })).not.toContain('"check"');
    expect(calls.some((c) => c.url.includes(n) || JSON.stringify(c.headers).includes(n))).toBe(false);

    // A renewed session or a moved widget asks again without the nonce and sends nothing.
    await el.renewSession();
    await settle();
    document.body.appendChild(el);
    await settle();
    expect(checked(calls)).toHaveLength(2); // the session and the one chat
    expect(of(calls, "chat")).toHaveLength(1);
    // A visitor's own message never carries it.
    await el.send("hello");
    await settle();
    expect(of(calls, "chat")).toHaveLength(2);
    expect(of(calls, "chat")[1].body.check).toBeUndefined();
    expect(sends[1].check).toBeUndefined();
    // Another widget on the same page load does not run the check again.
    await mount();
    expect(checked(calls)).toHaveLength(2);
    expect(of(calls, "chat")).toHaveLength(2);
  });

  it("never sends it twice in a tab: a reload or back-navigation with the same link sends nothing", async () => {
    const n = nonce();
    const calls = backend({ accepts: n });
    withUrl(`?dewee_check=${n}`);
    const first = await mount();
    expect(of(calls, "chat")).toHaveLength(1);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(n);
    first.el.remove();
    // A new page load of the same link.
    resetPageInstallCheck();
    withUrl(`?dewee_check=${n}`);
    await mount();
    expect(checked(calls)).toHaveLength(2);
    expect(of(calls, "chat")).toHaveLength(1);
    expect(location.search).toBe("");
  });

  it("runs in a conversation of its own and leaves the visitor's restored conversation in place", async () => {
    const n = nonce();
    const own = "conv_visitor_0001";
    localStorage.setItem("dewee-webchat:conv:/api/dewee::support", own);
    const calls = backend({ accepts: n, history: [{ role: "user", content: "my order" }, { role: "assistant", content: "Shipped" }] });
    withUrl(`?dewee_check=${n}`);
    const { el } = await mount({ persist: "true" });
    const test = of(calls, "chat")[0];
    expect(test.body.check).toBe(n);
    expect(test.body.conversationId).not.toBe(own);
    expect(localStorage.getItem("dewee-webchat:conv:/api/dewee::support")).toBe(own);
    expect(JSON.stringify({ ...localStorage })).not.toContain(test.body.conversationId);
    // The visitor's next message goes to their own conversation.
    await el.send("and the invoice?");
    await settle();
    expect(of(calls, "chat")[1].body.conversationId).toBe(own);
    // A reload shows the visitor's conversation.
    el.remove();
    resetPageInstallCheck();
    await mount({ persist: "true" });
    expect(of(calls, "history").at(-1)!.url).toContain(own);
  });

  it("is never delivered to a conversation a person holds", async () => {
    const n = nonce();
    const own = "conv_visitor_0002";
    localStorage.setItem("dewee-webchat:conv:/api/dewee::support", own);
    const calls = backend({ accepts: n, held: [own], config: { humanHandoff: true } });
    withUrl(`?dewee_check=${n}`);
    const { el } = await mount({ persist: "true" });
    const chats = of(calls, "chat");
    expect(chats).toHaveLength(1);
    expect(chats[0].body.conversationId).not.toBe(own);
    expect(el.diagnostics().reply.state).toBe("ok");
  });

  it("carries no page context and no action manifest, also when page actions are on", async () => {
    const n = nonce();
    const calls = backend({ accepts: n, config: { pageContextVersions: [1] } });
    withUrl(`?dewee_check=${n}`);
    const { el } = await mount({ "dom-actions": "true", "page-context": "metadata" }, (e) => {
      e.registerActions({ name: "cart.add", description: "Add to cart", parameters: { type: "object", properties: {} }, sensitivity: "mutate", handler: () => ({ ok: true }) });
      e.configure({ getPageContext: () => ({ cart: 2 }) });
    });
    const test = of(calls, "chat")[0];
    expect(Object.keys(test.body).sort()).toEqual(["agent", "check", "conversationId", "message"]);
    // A visitor message still carries them.
    await el.send("hi");
    await settle();
    expect(of(calls, "chat")[1].body).toHaveProperty("actions");
    expect(of(calls, "chat")[1].body).toHaveProperty("pageContext");
  });

  it("boots a closed widget, opens it without taking the focus, and keeps the visitor's draft", async () => {
    const n = nonce();
    const sessionGate = gate();
    const calls = backend({ accepts: n, sessionGate: sessionGate.promise });
    withUrl(`?dewee_check=${n}`);
    const { el } = await mount({ mode: "floating", locale: "vi" });
    const input = el.shadowRoot!.querySelector("textarea")!;
    input.value = "my draft";
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    sessionGate.open();
    await settle();
    await new Promise((r) => setTimeout(r, 200));
    expect(of(calls, "chat")).toHaveLength(1);
    expect(of(calls, "chat")[0].body).toMatchObject({ message: locales.vi.installCheck, check: n });
    expect(el.hasAttribute("data-open")).toBe(true);
    expect(input.value).toBe("my draft");
    expect(document.activeElement).toBe(outside);
  });

  it("waits for a running turn instead of dropping the test message", async () => {
    const n = nonce();
    const sessionGate = gate();
    const chatGate = gate();
    const calls = backend({ accepts: n, sessionGate: sessionGate.promise, chatGate: chatGate.promise });
    withUrl(`?dewee_check=${n}`);
    const { el } = await mount();
    const visitor = el.send("hello");
    sessionGate.open();
    await settle();
    expect(of(calls, "chat")).toHaveLength(1);
    chatGate.open();
    await visitor;
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    const chats = of(calls, "chat");
    expect(chats.map((c) => c.body.check)).toEqual([undefined, n]);
  });

  it("leaves the check to the next boot when the boot is superseded before the message is sent", async () => {
    const n = nonce();
    const sessionGate = gate();
    const calls = backend({ accepts: n, sessionGate: sessionGate.promise });
    withUrl(`?dewee_check=${n}`);
    const { el } = await mount();
    // The host changes how the widget asks the backend: a new boot starts while the check waits.
    el.setAttribute("page-context", "metadata");
    sessionGate.open();
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    await settle();
    // The superseded boot's session is not reused for the message: the new boot asks again, then sends once.
    expect(of(calls, "session").filter((c) => c.body?.check === n)).toHaveLength(2);
    expect(of(calls, "chat")).toHaveLength(1);
    expect(of(calls, "chat")[0].body.check).toBe(n);
    expect(el.diagnostics().check).toBe("accepted");
  });
});
