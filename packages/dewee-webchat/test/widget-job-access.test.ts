// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openJobAccessTicket } from "../src/widget/job-access";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";

const TOKEN = "one_time_ticket_0123456789";
const ticket = () => ({ bootstrap_url: "https://access.example/identity/job-access/launch", launch_token: TOKEN, expires_at: new Date(Date.now() + 45_000).toISOString() });
function popup() {
  const win = { closed: false, opener: window, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
  return win;
}
afterEach(() => { document.body.innerHTML = ""; localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeAll(() => defineDeweeChat());

describe("job access popup lifecycle", () => {
  it("opens synchronously, then POSTs the ticket only in a transient form", async () => {
    const win = popup();
    let complete!: (value: ReturnType<typeof ticket>) => void;
    const load = vi.fn((_signal: AbortSignal) => new Promise<ReturnType<typeof ticket>>((resolve) => { complete = resolve; }));
    let submitted: HTMLFormElement | undefined;
    let field: HTMLInputElement | undefined;
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
      submitted = this; field = this.querySelector("input")!;
      expect(this.method.toUpperCase()).toBe("POST");
      expect(this.action).toBe(ticket().bootstrap_url);
      expect(this.action).not.toContain(TOKEN);
      expect(this.target).toMatch(/^dewee-job-access-/);
      expect(new FormData(this).get("launch_token")).toBe(TOKEN);
      expect(this.querySelectorAll("input")).toHaveLength(1);
      expect(this.isConnected).toBe(true);
    });
    const pending = openJobAccessTicket(load);
    expect(window.open).toHaveBeenCalledWith("about:blank", expect.stringMatching(/^dewee-job-access-/), expect.any(String));
    expect(win.opener).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    complete(ticket()); await pending;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submitted?.isConnected).toBe(false);
    expect(field?.value).toBe("");
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(load.mock.calls[0][0].aborted).toBe(true);
    expect(win.close).not.toHaveBeenCalled();
  });

  it("never requests a ticket when the popup is blocked", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const load = vi.fn();
    await expect(openJobAccessTicket(load)).rejects.toMatchObject({ code: "popup_blocked" });
    expect(load).not.toHaveBeenCalled();
  });

  it.each(["closed", "timeout", "abort", "pagehide"])("cleans up when %s interrupts ticket loading", async (mode) => {
    vi.useFakeTimers(); const win = popup(); const outer = new AbortController();
    let inner!: AbortSignal;
    const load = (signal: AbortSignal) => { inner = signal; return new Promise<ReturnType<typeof ticket>>(() => {}); };
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    const pending = openJobAccessTicket(load, outer.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: mode === "closed" ? "popup_closed" : "job_access_unavailable" });
    if (mode === "closed") { win.closed = true; await vi.advanceTimersByTimeAsync(200); }
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(30_000);
    if (mode === "abort") outer.abort();
    if (mode === "pagehide") window.dispatchEvent(new Event("pagehide"));
    await rejected;
    expect(inner.aborted).toBe(true); expect(win.close).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled(); expect(document.querySelector("form")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the token and closes the popup if native submission fails", async () => {
    const win = popup(); let field: HTMLInputElement | undefined;
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) { field = this.querySelector("input")!; throw new Error("submit failed"); });
    await expect(openJobAccessTicket(async () => ticket())).rejects.toThrow("submit failed");
    expect(field?.value).toBe(""); expect(document.querySelector("form")).toBeNull(); expect(win.close).toHaveBeenCalledTimes(1);
  });
});

function backend(identity = true, refuse = false) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site.test").pathname; calls.push(path);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (path.endsWith("/config")) return json({ identity, agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "test" });
    if (path.endsWith("/session")) return json({ visitorId: "v1", token: "sealed-visitor", verified: true, expiresAt: Date.now() + 60_000 });
    if (path.endsWith("/history")) return json({ messages: [] });
    if (path.endsWith("/job-access")) {
      expect(init?.method).toBe("POST"); expect(init?.body).toBe("{}");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sealed-visitor");
      return refuse ? json({ error: { code: "LINK_REVOKED", message: `private ${TOKEN}`, remediation: { secret: TOKEN } } }, 401) : json(ticket());
    }
    throw new Error(`Unexpected route ${path}`);
  }));
  return calls;
}
async function mount(locale = "en") {
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  for (const [name, value] of Object.entries({ endpoint: "/api/dewee", mode: "inline", persist: "false", locale })) el.setAttribute(name, value);
  document.body.append(el);
  await vi.waitFor(() => expect(el.shadowRoot?.querySelector(".job-access")).not.toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return el;
}
describe("job access widget integration", () => {
  it.each(["en", "vi"])("automatically exposes an accessible localized button for identity config (%s)", async (locale) => {
    const calls = backend(); const el = await mount(locale);
    const button = el.shadowRoot!.querySelector<HTMLButtonElement>(".job-access")!;
    expect(button.hidden).toBe(false); expect(button.getAttribute("aria-label")).toBeTruthy();
    if (locale === "en") expect(button.getAttribute("aria-label")).toBe("Job access");
    else expect(button.getAttribute("aria-label")).toBe("Quyền công việc");
    vi.spyOn(window, "open").mockReturnValue(null); button.click();
    await vi.waitFor(() => expect(el.shadowRoot!.textContent).toMatch(locale === "en" ? /popup|pop-up/i : /cửa sổ/i));
    expect(calls.filter((path) => path.endsWith("/job-access"))).toHaveLength(0);
  });
  it("launches through the real widget client without retaining tickets in storage, markup or events", async () => {
    const calls = backend(); const el = await mount(); popup();
    const events: unknown[] = [];
    for (const name of ["dewee:error", "dewee:send", "dewee:reply"]) el.addEventListener(name, (event) => events.push((event as CustomEvent).detail));
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
      expect(new FormData(this).get("launch_token")).toBe(TOKEN);
      expect(this.action).toBe(ticket().bootstrap_url);
    });
    await el.openJobAccess();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(calls.filter((path) => path.endsWith("/job-access"))).toHaveLength(1);
    expect(document.querySelector("form")).toBeNull();
    for (const value of [document.body.innerHTML, el.shadowRoot!.innerHTML, JSON.stringify(events), JSON.stringify(localStorage), JSON.stringify(sessionStorage)]) expect(value).not.toContain(TOKEN);
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>(".job-access")!.disabled).toBe(false);
  });
  it("hides the launcher without identity configuration", async () => {
    backend(false); const el = await mount();
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>(".job-access")!.hidden).toBe(true);
  });
  it("scrubs refusal text and events and never refreshes into another session", async () => {
    const calls = backend(true, true); const el = await mount(); const win = popup();
    const errors: unknown[] = []; el.addEventListener("dewee:error", (event) => errors.push((event as CustomEvent).detail));
    await el.openJobAccess();
    expect(calls.filter((path) => path.endsWith("/job-access"))).toHaveLength(1);
    expect(calls.filter((path) => path.endsWith("/session"))).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain(TOKEN); expect(el.shadowRoot!.textContent).not.toContain(TOKEN);
    expect(win.close).toHaveBeenCalledTimes(1); expect(document.querySelector("form")).toBeNull();
  });
});


