// @vitest-environment happy-dom
// <dewee-chat> and the control plane's install check: a valid `?dewee_check=` nonce goes with one
// `/session` request; only a `check: true` answer makes the widget send its one localized test message,
// with the nonce in that chat body. A malformed nonce, an unconfirmed one, a renewed session, a moved
// widget and a direct gateway widget send nothing more. The nonce never reaches a snapshot or storage.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";
import { locales } from "../src/widget/i18n";

const CONFIG = { agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "0.5.0-test" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const sse = (frames: unknown[]) => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

let seq = 0;
/** A fresh nonce per test: a nonce is used once per page load, and the test file is one page load. Built by concatenation. */
const nonce = () => "chk_" + String(++seq).padStart(4, "0") + "Q".repeat(20);

/** A backend that confirms `accepts` (or nothing) and records every request. */
function backend(accepts: string | null) {
  const calls: Array<{ path: string; body: any; headers: Record<string, string> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site.test").pathname.split("/").pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body, headers: { ...(init?.headers as Record<string, string>) } });
    if (path === "config") return json(CONFIG);
    if (path === "session") return json({ visitorId: "v1", token: "visitor-token", expiresAt: Date.now() + 86_400_000, ...(accepts && body?.check === accepts ? { check: true } : {}) });
    if (path === "history") return json({ messages: [] });
    if (path === "chat") return sse([{ type: "start", conversationId: body.conversationId, agent: "support" }, { type: "delta", text: "It works" }, { type: "done", content: "It works" }]);
    throw new Error(`unexpected ${path}`);
  }));
  return calls;
}

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const withUrl = (search: string) => history.replaceState(null, "", `/shop${search}`);

async function mount(attrs: Record<string, string> = {}) {
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  for (const [k, v] of Object.entries({ endpoint: "/api/dewee", mode: "inline", persist: "false", locale: "en", ...attrs })) el.setAttribute(k, v);
  const statuses: unknown[] = [];
  const sends: unknown[] = [];
  el.addEventListener("dewee:status", (e) => statuses.push((e as CustomEvent).detail));
  el.addEventListener("dewee:send", (e) => sends.push((e as CustomEvent).detail));
  const ready = new Promise<void>((r) => el.addEventListener("dewee:ready", () => r(), { once: true }));
  document.body.appendChild(el);
  await ready;
  await settle();
  return { el, statuses, sends };
}

const of = (calls: ReturnType<typeof backend>, path: string) => calls.filter((c) => c.path === path);

beforeAll(() => defineDeweeChat());
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  withUrl("");
});

describe("<dewee-chat> install check", () => {
  it("ignores a malformed nonce: no check is sent, nothing is sent automatically", async () => {
    for (const bad of ["short", "Q".repeat(65), "chk." + "Q".repeat(22), encodeURIComponent("chk_" + "Q".repeat(22) + "\n")]) {
      const calls = backend(bad);
      withUrl(`?dewee_check=${bad}`);
      const { el } = await mount();
      expect(calls.some((c) => c.body && "check" in c.body), bad).toBe(false);
      expect(of(calls, "chat"), bad).toHaveLength(0);
      expect(el.diagnostics().check, bad).toBeUndefined();
      el.remove();
    }
  });

  it("sends the nonce with the session and never sends a message the backend did not confirm", async () => {
    const n = nonce();
    const calls = backend(null);
    withUrl(`?utm_source=x&dewee_check=${n}`);
    const { el } = await mount();
    expect(of(calls, "session")).toHaveLength(1);
    expect(of(calls, "session")[0].body.check).toBe(n);
    expect(of(calls, "chat")).toHaveLength(0);
    expect(el.diagnostics()).toMatchObject({ session: { state: "ok" }, reply: { state: "idle" }, check: "ignored" });
  });

  it("after check: true, sends one localized test message carrying the nonce, and never another", async () => {
    const n = nonce();
    const calls = backend(n);
    withUrl(`?dewee_check=${n}`);
    const { el, statuses, sends } = await mount();
    const chats = of(calls, "chat");
    expect(chats).toHaveLength(1);
    expect(chats[0].body).toMatchObject({ message: locales.en.installCheck, check: n, agent: "support" });
    expect(el.diagnostics()).toMatchObject({ session: { state: "ok" }, reply: { state: "ok" }, check: "accepted" });
    // The nonce is never in a snapshot, an event, storage, or a request URL.
    expect(JSON.stringify([statuses, sends, el.diagnostics()])).not.toContain(n);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(n);
    expect(JSON.stringify({ ...localStorage })).not.toContain('"check"');
    expect(calls.some((c) => c.headers && JSON.stringify(c.headers).includes(n))).toBe(false);

    // A renewed session or a moved widget asks again without the nonce and sends nothing.
    await el.renewSession();
    await settle();
    document.body.appendChild(el);
    await settle();
    expect(of(calls, "session").slice(1).every((c) => !("check" in (c.body ?? {})))).toBe(true);
    expect(of(calls, "chat")).toHaveLength(1);
    // A visitor's own message never carries it.
    await el.send("hello");
    await settle();
    expect(of(calls, "chat")).toHaveLength(2);
    expect(of(calls, "chat")[1].body.check).toBeUndefined();
    // Another widget on the same page load does not run the check again.
    await mount();
    expect(of(calls, "session").filter((c) => c.body?.check)).toHaveLength(1);
    expect(of(calls, "chat")).toHaveLength(2);
  });

  it("asks the backend with the nonce even when a stored session is still fresh", async () => {
    const n = nonce();
    localStorage.setItem("dewee-webchat:session:/api/dewee", JSON.stringify({ visitorId: "v1", token: "stored-token", expiresAt: Date.now() + 86_400_000, expiresIn: 86_400_000, obtainedAt: Date.now() }));
    const calls = backend(n);
    withUrl(`?dewee_check=${n}`);
    await mount();
    expect(of(calls, "session")).toHaveLength(1);
    expect(of(calls, "session")[0].body).toMatchObject({ token: "stored-token", check: n });
    expect(of(calls, "chat")).toHaveLength(1);
  });

  it("boots a closed floating widget for the check and uses the page's locale", async () => {
    const n = nonce();
    const calls = backend(n);
    withUrl(`?dewee_check=${n}`);
    await mount({ mode: "floating", locale: "vi" });
    expect(of(calls, "chat")).toHaveLength(1);
    expect(of(calls, "chat")[0].body).toMatchObject({ message: locales.vi.installCheck, check: n });
  });

  it("without a nonce, a closed floating widget stays idle", async () => {
    const calls = backend(null);
    const el = document.createElement("dewee-chat") as DeweeChatElement;
    el.setAttribute("endpoint", "/api/dewee");
    document.body.appendChild(el);
    await settle();
    expect(calls).toHaveLength(0);
    expect(el.diagnostics().check).toBeUndefined();
  });

  it("ignores the nonce when the widget talks to a gateway directly", async () => {
    const n = nonce();
    const calls = backend(n);
    withUrl(`?dewee_check=${n}`);
    const { el } = await mount({ "gateway-url": "https://gw.example.com", "gateway-token": "gw-" + "token" });
    expect(calls.some((c) => c.body && "check" in c.body)).toBe(false);
    expect(of(calls, "chat")).toHaveLength(0);
    expect(el.diagnostics().check).toBeUndefined();
  });
});
