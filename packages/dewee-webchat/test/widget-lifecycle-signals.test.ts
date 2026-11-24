// @vitest-environment happy-dom
// "The widget is on the page" is not "the channel answers". Drives <dewee-chat> against backends that
// fail at each step and checks the three signals (config, session, reply), the retry panel, and that
// nothing sensitive reaches the diagnostic snapshot.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement, type WidgetDiagnostics } from "../src/index";

type Step = (path: string, n: number) => Response | Promise<Response> | undefined;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const refused = (status: number, code: string) => json({ error: { code, message: `Secret upstream detail for ${code} at https://runtime.internal/x?key=sk-live-123` } }, status);
const CONFIG = { agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "0.5.0-test" };
const SESSION = () => ({ visitorId: "v1", token: "visitor-token-do-not-leak", expiresAt: Date.now() + 7 * 86_400_000 });
const sse = (frames: unknown[]) => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const answer = (content: string) => sse([{ type: "start", conversationId: "c", agent: "support" }, { type: "done", content }]);

/** Each route may be overridden; `n` counts the calls to that route so a step can fail and then recover. */
function backend(over: { config?: Step; session?: Step; chat?: Step } = {}) {
  const counts: Record<string, number> = { config: 0, session: 0, chat: 0 };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(url, "https://site.test").pathname;
    const route = path.endsWith("/config") ? "config" : path.endsWith("/session") ? "session" : path.endsWith("/history") ? "history" : "chat";
    if (route === "history") return json({ messages: [] });
    const n = ++counts[route];
    const custom = await over[route as "config"]?.(path, n);
    if (custom) return custom;
    return route === "config" ? json(CONFIG) : route === "session" ? json(SESSION()) : answer("Hello, how can I help?");
  }));
  return counts;
}

interface Mounted { el: DeweeChatElement; ready: any[]; status: WidgetDiagnostics[]; errors: any[] }

async function mount(): Promise<Mounted> {
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  for (const [k, v] of Object.entries({ endpoint: "/api/dewee", mode: "inline", persist: "false", locale: "en" })) el.setAttribute(k, v);
  const ready: any[] = [];
  const status: WidgetDiagnostics[] = [];
  const errors: any[] = [];
  el.addEventListener("dewee:ready", (e) => ready.push((e as CustomEvent).detail));
  el.addEventListener("dewee:status", (e) => status.push((e as CustomEvent).detail));
  el.addEventListener("dewee:error", (e) => errors.push((e as CustomEvent).detail));
  document.body.appendChild(el);
  await settle();
  return { el, ready, status, errors };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const statusText = (el: DeweeChatElement) => el.shadowRoot!.querySelector(".status")!.textContent;
const retryButton = (el: DeweeChatElement) => el.shadowRoot!.querySelector<HTMLButtonElement>(".unavailable .retry");

beforeAll(() => defineDeweeChat());
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("<dewee-chat> lifecycle signals", () => {
  it("reports a loaded config as ready and online, with the later steps not yet checked", async () => {
    backend();
    const { el, ready, status } = await mount();
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ ok: true, agent: "support", config: { version: "0.5.0-test" } });
    expect(ready[0].error).toBeUndefined();
    expect(el.diagnostics()).toEqual({ embedded: true, config: { state: "ok" }, session: { state: "idle" }, reply: { state: "idle" }, version: "0.5.0-test" });
    expect(status.map((s) => s.config.state)).toEqual(["pending", "ok"]);
    expect(el.getAttribute("data-connection")).toBe("ready");
    expect(statusText(el)).toBe("Online");
    expect(retryButton(el)).toBeNull();
  });

  it("still fires dewee:ready when the config fails, but says it failed, and never claims to be online", async () => {
    backend({ config: () => refused(503, "upstream_unavailable") });
    const { el, ready, errors } = await mount();
    expect(ready).toHaveLength(1); // existing embeds that wait for dewee:ready are not left hanging
    expect(ready[0]).toMatchObject({ ok: false, config: null, error: { code: "upstream_unavailable" } });
    expect(el.diagnostics()).toEqual({ embedded: true, config: { state: "failed", code: "upstream_unavailable" }, session: { state: "idle" }, reply: { state: "idle" } });
    expect(el.getAttribute("data-connection")).toBe("unavailable");
    expect(statusText(el)).toBe("Chat is unavailable");
    expect(statusText(el)).not.toContain("Online");
    expect(errors).toHaveLength(1); // dewee:error keeps firing for hosts that listen to it
    const panel = el.shadowRoot!.querySelector(".unavailable")!;
    expect(panel.getAttribute("role")).toBe("alert");
    expect(panel.textContent).toContain("We could not connect right now.");
    expect(retryButton(el)!.textContent).toBe("Try again");
    expect(el.shadowRoot!.querySelector(".welcome")).toBeNull();
  });

  it("does not send a message while the config is unavailable, and keeps the visitor's text", async () => {
    const counts = backend({ config: () => refused(503, "upstream_unavailable") });
    const { el } = await mount();
    const input = el.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "Is anyone there?";
    await el.send(input.value);
    expect(counts.chat).toBe(0);
    expect(counts.session).toBe(0);
    expect(input.value).toBe("Is anyone there?");
  });

  it("recovers through Try again: the panel goes, the status turns online, a second ready says ok", async () => {
    const counts = backend({ config: (_p, n) => (n === 1 ? refused(503, "upstream_unavailable") : undefined) });
    const { el, ready, status } = await mount();
    retryButton(el)!.click();
    await settle();
    await settle();
    expect(counts.config).toBe(2);
    expect(ready.map((r) => r.ok)).toEqual([false, true]);
    expect(status.map((s) => s.config.state)).toEqual(["pending", "failed", "pending", "ok"]);
    expect(el.diagnostics().config).toEqual({ state: "ok" });
    expect(retryButton(el)).toBeNull();
    expect(statusText(el)).toBe("Online");
    expect(el.shadowRoot!.querySelector(".welcome")).not.toBeNull();
  });

  it("names a wrong domain by its code so an install checker can tell the owner what to fix", async () => {
    backend({ config: () => refused(403, "ORIGIN_NOT_ALLOWED") });
    const { el } = await mount();
    expect(el.diagnostics().config).toEqual({ state: "failed", code: "ORIGIN_NOT_ALLOWED" });
  });

  it("falls back to the HTTP status or network_error when the backend gives no usable code", async () => {
    backend({ config: () => new Response("<html>bad gateway</html>", { status: 502 }) });
    expect((await mount()).el.diagnostics().config).toEqual({ state: "failed", code: "http_502" });
    document.body.innerHTML = "";
    backend({ config: () => { throw new TypeError("Failed to fetch https://runtime.internal"); } });
    expect((await mount()).el.diagnostics().config).toEqual({ state: "failed", code: "network_error" });
    document.body.innerHTML = "";
    backend({ config: () => json({ error: { code: "has spaces <b>", message: "x" } }, 400) });
    expect((await mount()).el.diagnostics().config).toEqual({ state: "failed", code: "http_400" });
  });

  it("tells a session failure apart from a config failure", async () => {
    backend({ session: () => refused(401, "LOGIN_REQUIRED") });
    const { el } = await mount();
    const result = await el.checkConnection();
    expect(result).toMatchObject({ config: { state: "ok" }, session: { state: "failed", code: "LOGIN_REQUIRED" }, reply: { state: "idle" } });
    expect(statusText(el)).toBe("Online"); // the embed itself is fine; the session step carries the failure
  });

  it("checkConnection opens a session without sending any message", async () => {
    const counts = backend();
    const { el, status } = await mount();
    const result = await el.checkConnection();
    expect(result).toMatchObject({ config: { state: "ok" }, session: { state: "ok" }, reply: { state: "idle" } });
    expect(counts).toMatchObject({ config: 1, session: 1, chat: 0 });
    expect(status.at(-1)).toEqual(result);
  });

  it("checkConnection stops at the config step when the config is unavailable", async () => {
    const counts = backend({ config: () => refused(503, "upstream_unavailable") });
    const { el } = await mount();
    expect(await el.checkConnection()).toMatchObject({ config: { state: "failed" }, session: { state: "idle" } });
    expect(counts.session).toBe(0);
  });

  it("reports a good config whose agent does not answer as a reply failure", async () => {
    backend({ chat: () => sse([{ type: "start", conversationId: "c", agent: "support" }, { type: "error", message: "Agent run failed", code: "AGENT_UNAVAILABLE" }]) });
    const { el } = await mount();
    await el.send("test");
    expect(el.diagnostics()).toMatchObject({ config: { state: "ok" }, session: { state: "ok" }, reply: { state: "failed", code: "AGENT_UNAVAILABLE" } });
  });

  it("reports an empty answer and a refused chat request as reply failures, not as success", async () => {
    backend({ chat: () => answer("") });
    const empty = await mount();
    await empty.el.send("test");
    expect(empty.el.diagnostics().reply).toEqual({ state: "failed", code: "empty_reply" });
    document.body.innerHTML = "";
    backend({ chat: () => refused(502, "upstream_unavailable") });
    const down = await mount();
    await down.el.send("test");
    expect(down.el.diagnostics()).toMatchObject({ session: { state: "ok" }, reply: { state: "failed", code: "upstream_unavailable" } });
  });

  it("reports the full path as ok only after a real answer arrived", async () => {
    backend();
    const { el, status } = await mount();
    await el.send("test");
    expect(el.diagnostics()).toEqual({ embedded: true, config: { state: "ok" }, session: { state: "ok" }, reply: { state: "ok" }, version: "0.5.0-test" });
    expect(status.map((s) => `${s.config.state}/${s.session.state}/${s.reply.state}`)).toEqual([
      "pending/idle/idle", "ok/idle/idle", "ok/pending/idle", "ok/ok/idle", "ok/ok/pending", "ok/ok/ok",
    ]);
  });

  it("keeps tokens, server messages, URLs and conversation text out of every diagnostic event", async () => {
    backend({ chat: (_p, n) => (n === 1 ? answer("Your order ord_1001a ships tomorrow.") : refused(500, "upstream_unavailable")) });
    const { el, status, ready } = await mount();
    await el.send("Where is my order ord_1001a? My phone is 0901234567.");
    await el.send("And now?");
    backend({ config: () => refused(503, "upstream_unavailable") });
    const failed = await mount();
    const dump = JSON.stringify([status, el.diagnostics(), failed.status, failed.el.diagnostics(), failed.ready.map((r) => r.error), ready.map((r) => r.error)]);
    for (const secret of ["visitor-token-do-not-leak", "sk-live-123", "runtime.internal", "Secret upstream detail", "ord_1001a", "0901234567", "ships tomorrow"]) {
      expect(dump).not.toContain(secret);
    }
    const allowed = new Set(["embedded", "config", "session", "reply", "version"]);
    for (const s of [...status, ...failed.status]) {
      expect(Object.keys(s).every((k) => allowed.has(k))).toBe(true);
      for (const step of [s.config, s.session, s.reply]) expect(Object.keys(step).every((k) => k === "state" || k === "code")).toBe(true);
    }
  });
});
