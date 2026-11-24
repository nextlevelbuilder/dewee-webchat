// @vitest-environment happy-dom
// <dewee-chat> human takeover against a stateful mock backend: the "talk to a person" button only on a
// backend that offers it, one request per click, waiting / staff joined / nobody on duty, held sends,
// staff messages read by polling (also when staff write first), hand-back, a stopped agent run, reload
// restoring who wrote each turn, and a failed request that leaves the chat working.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";

type Control = "agent" | "waiting_human" | "human_active";
interface Turn { role: "user" | "assistant"; content: string; authorKind?: "human" | "system" }

const CONFIG = { agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "0.5.0-test" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const sse = (frames: unknown[]) => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

/** A backend that keeps one conversation, its control and its turns, like CCP does. */
function backend(opts: { handoff?: boolean; history?: Turn[]; control?: Control } = {}) {
  const state = {
    messages: [...(opts.history ?? [])] as Turn[],
    control: (opts.control ?? "agent") as Control,
    staffOnDuty: true,
    requestHuman: undefined as undefined | (() => Response),
    chatStream: undefined as undefined | (() => Response),
    calls: [] as Array<{ path: string; body: any }>,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "https://site.test");
    const path = u.pathname.split("/").pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    state.calls.push({ path, body });
    if (path === "config") return json(opts.handoff ? { ...CONFIG, humanHandoff: true } : CONFIG);
    if (path === "session") return json({ visitorId: "v1", token: "visitor-token", expiresAt: Date.now() + 86_400_000 });
    if (path === "history") return json({ messages: state.messages, ...(opts.handoff ? { control: state.control } : { control: "human_active" }) });
    if (path === "request-human") {
      if (state.requestHuman) return state.requestHuman();
      if (state.control !== "agent") return json({ control: state.control, staffOnDuty: true });
      state.control = state.staffOnDuty ? "waiting_human" : "agent";
      state.messages.push({ role: "assistant", content: state.staffOnDuty ? "Your request was received." : "Nobody is on duty. Please leave your contact details.", authorKind: "system" });
      return json({ control: state.control, staffOnDuty: state.staffOnDuty });
    }
    if (path === "chat") {
      state.messages.push({ role: "user", content: body.message });
      if (state.control !== "agent") return json({ held: true, control: state.control }, 202);
      if (state.chatStream) return state.chatStream();
      state.messages.push({ role: "assistant", content: "Agent answer" });
      return sse([{ type: "start", conversationId: body.conversationId, agent: "support" }, { type: "delta", text: "Agent answer" }, { type: "done", content: "Agent answer" }]);
    }
    throw new Error(`unexpected ${path}`);
  }));
  return state;
}

/** Lets fetch bodies and promise chains finish; the real setImmediate also works under fake timers. */
const realImmediate = globalThis.setImmediate;
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => realImmediate(r)); };
const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await settle(); };

async function mount(attrs: Record<string, string> = {}) {
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  for (const [k, v] of Object.entries({ endpoint: "/api/dewee", mode: "inline", persist: "false", locale: "en", ...attrs })) el.setAttribute(k, v);
  const events: Array<{ name: string; detail: unknown }> = [];
  for (const name of ["dewee:reply", "dewee:error"]) el.addEventListener(name, (e) => events.push({ name, detail: (e as CustomEvent).detail }));
  const ready = new Promise<void>((r) => el.addEventListener("dewee:ready", () => r(), { once: true }));
  document.body.appendChild(el);
  await ready;
  await settle();
  return { el, events };
}

const $ = <T extends Element = HTMLElement>(el: DeweeChatElement, sel: string) => el.shadowRoot!.querySelector<T & Element>(sel) as T | null;
const button = (el: DeweeChatElement) => $<HTMLButtonElement>(el, ".handoff-request")!;
const status = (el: DeweeChatElement) => $(el, ".handoff-status")!;
const announcer = (el: DeweeChatElement) => $(el, ".announcer")!.textContent;
const bubbles = (el: DeweeChatElement) => [...el.shadowRoot!.querySelectorAll<HTMLElement>(".log .msg")].filter((m) => !m.hidden).map((m) => `${m.className}: ${m.textContent?.trim()}`);
const count = (state: ReturnType<typeof backend>, path: string) => state.calls.filter((c) => c.path === path).length;

beforeAll(() => defineDeweeChat());
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("<dewee-chat> human takeover: backend without it", () => {
  it("shows no button, never asks for a person and never polls, whatever history says", async () => {
    const state = backend({ handoff: false });
    const { el } = await mount();
    await el.send("hi");
    await settle();
    expect($(el, ".handoff")!.hidden).toBe(true);
    expect(button(el).hidden).toBe(true);
    vi.useFakeTimers();
    await tick(120_000);
    expect(count(state, "request-human")).toBe(0);
    expect(count(state, "history")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("<dewee-chat> human takeover", () => {
  it("offers the button once a conversation exists, sends one request for a double click, and waits for staff", async () => {
    const state = backend({ handoff: true });
    const { el } = await mount();
    expect(button(el).hidden).toBe(true); // nothing to hand over yet
    await el.send("hi");
    await settle();
    expect(button(el).hidden).toBe(false);
    expect(button(el).textContent).toBe("Talk to a person");
    vi.useFakeTimers();
    button(el).click();
    button(el).click();
    expect(button(el).getAttribute("aria-disabled")).toBe("true");
    expect(status(el).textContent).toBe("Contacting support staff…");
    await tick(0);
    expect(count(state, "request-human")).toBe(1);
    expect(state.calls.find((c) => c.path === "request-human")!.body).toEqual({ agent: "support", conversationId: state.calls.find((c) => c.path === "chat")!.body.conversationId });
    expect(status(el).textContent).toBe("Waiting for a support staff member to join…");
    expect(announcer(el)).toBe("Waiting for a support staff member to join…");
    expect(button(el).hidden).toBe(true);
    // The request's notice is shown as a neutral notice, never as an agent bubble.
    expect(bubbles(el).at(-1)).toBe("msg assistant system: Your request was received.");
  });

  it("holds a message while staff are asked: shown as sent, no fake reply, no error, reply check untouched", async () => {
    const state = backend({ handoff: true });
    const { el, events } = await mount();
    await el.send("hi");
    await settle();
    vi.useFakeTimers();
    button(el).click();
    await tick(0);
    const replyBefore = el.diagnostics().reply;
    const shown = bubbles(el).length;
    events.length = 0;
    await el.send("are you there?");
    await tick(0);
    expect(bubbles(el)).toHaveLength(shown + 1);
    expect(bubbles(el).at(-1)).toBe("msg user: are you there?");
    expect(el.shadowRoot!.querySelector(".msg.error")).toBeNull();
    expect(events).toEqual([]);
    expect(el.diagnostics().reply).toEqual(replyBefore);
    expect(announcer(el)).toBe("Message sent. Support staff will see it.");
    expect(state.calls.at(-1)?.path).toBe("chat");
  });

  it("reads staff replies by polling, also when staff write first, labelled without any staff identity", async () => {
    const state = backend({ handoff: true });
    const { el } = await mount();
    await el.send("hi");
    await settle();
    vi.useFakeTimers();
    button(el).click();
    await tick(0);
    const reads = count(state, "history");
    // Staff accept and write first, before the visitor says anything else.
    state.control = "human_active";
    state.messages.push({ role: "assistant", content: "Staff joined.", authorKind: "system" }, { role: "assistant", content: "Hi, this is support. How can I help?", authorKind: "human" });
    await tick(4_000);
    expect(count(state, "history")).toBe(reads + 1);
    expect(status(el).textContent).toBe("You're chatting with support staff.");
    expect(announcer(el)).toBe("You're chatting with support staff.");
    const staff = el.shadowRoot!.querySelector<HTMLElement>(".msg.human")!;
    expect(staff.querySelector(".author")!.textContent).toBe("Support staff");
    expect(staff.textContent).toContain("Hi, this is support. How can I help?");
    expect(bubbles(el).slice(-2)).toEqual(["msg assistant system: Staff joined.", "msg assistant human: Support staffHi, this is support. How can I help?"]);
  });

  it("backs off while nothing changes, follows the hand-back from the server and then stops polling", async () => {
    const state = backend({ handoff: true });
    const { el } = await mount();
    await el.send("hi");
    await settle();
    vi.useFakeTimers();
    button(el).click();
    await tick(0);
    const start = count(state, "history");
    await tick(4_000); // 4 s
    await tick(6_000); // then 6 s
    await tick(5_000); // 9 s is not due yet
    expect(count(state, "history")).toBe(start + 2);
    await tick(4_000);
    expect(count(state, "history")).toBe(start + 3);
    // Staff release the conversation: the agent answers again.
    state.control = "agent";
    state.messages.push({ role: "assistant", content: "The assistant is taking over again.", authorKind: "system" });
    await tick(30_000);
    expect(status(el).hidden).toBe(true);
    expect(announcer(el)).toBe("The assistant is back in the conversation.");
    expect(button(el).hidden).toBe(false);
    const stopped = count(state, "history");
    await tick(300_000);
    expect(count(state, "history")).toBe(stopped);
    expect(vi.getTimerCount()).toBe(0);
    await el.send("thanks");
    await tick(0);
    expect(bubbles(el).at(-1)).toBe("msg assistant: Agent answer");
  });

  it("with nobody on duty, says so and lets the agent keep answering", async () => {
    const state = backend({ handoff: true });
    state.staffOnDuty = false;
    const { el } = await mount();
    await el.send("hi");
    await settle();
    vi.useFakeTimers();
    button(el).click();
    await tick(0);
    expect(status(el).textContent).toBe("No one is available right now. The assistant will keep helping you.");
    expect(announcer(el)).toBe("No one is available right now. The assistant will keep helping you.");
    expect(button(el).hidden).toBe(true);
    expect(bubbles(el).at(-1)).toBe("msg assistant system: Nobody is on duty. Please leave your contact details.");
    await el.send("my email is on file");
    await tick(0);
    expect(bubbles(el).at(-1)).toBe("msg assistant: Agent answer");
    // Someone comes on duty and accepts the waiting request: the poll picks it up.
    state.control = "human_active";
    await tick(30_000);
    expect(status(el).textContent).toBe("You're chatting with support staff.");
  });

  it("drops the agent's partial text when a person takes over mid-run and redraws from history", async () => {
    const state = backend({ handoff: true });
    const { el, events } = await mount();
    await el.send("hi");
    await settle();
    state.chatStream = () => {
      state.control = "human_active";
      state.messages.push({ role: "assistant", content: "Staff joined.", authorKind: "system" });
      return sse([{ type: "start", conversationId: "c", agent: "support" }, { type: "delta", text: "partial agent text" }, { type: "error", code: "cancelled", message: "Cancelled" }]);
    };
    const replyBefore = el.diagnostics().reply;
    events.length = 0;
    await el.send("one more thing");
    await settle();
    expect(el.shadowRoot!.textContent).not.toContain("partial agent text");
    expect(el.shadowRoot!.querySelector(".msg.error")).toBeNull();
    expect(events).toEqual([]);
    expect(el.diagnostics().reply).toEqual(replyBefore);
    expect(bubbles(el).slice(-2)).toEqual(["msg user: one more thing", "msg assistant system: Staff joined."]);
    expect(status(el).textContent).toBe("You're chatting with support staff.");
  });

  it("restores who wrote each turn after a reload and resumes watching the takeover", async () => {
    localStorage.setItem("dewee-webchat:conv:/api/dewee::support", "conv_reload_0001");
    const state = backend({
      handoff: true,
      control: "human_active",
      history: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Agent answer" },
        { role: "assistant", content: "Staff joined.", authorKind: "system" },
        { role: "assistant", content: "Hello from support.", authorKind: "human" },
      ],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { el } = await mount({ persist: "true", locale: "vi" });
    expect(bubbles(el)).toEqual(["msg user: hi", "msg assistant: Agent answer", "msg assistant system: Staff joined.", "msg assistant human: Nhân viên hỗ trợHello from support."]);
    expect(status(el).textContent).toBe("Bạn đang trò chuyện với nhân viên hỗ trợ.");
    expect(button(el).hidden).toBe(true);
    const reads = count(state, "history");
    await tick(4_000);
    expect(count(state, "history")).toBe(reads + 1);
    // Moved out of the page: no more polling.
    el.remove();
    await tick(120_000);
    expect(count(state, "history")).toBe(reads + 1);
  });

  it("keeps the chat working and the button retryable when the request fails; hides it when unavailable", async () => {
    const state = backend({ handoff: true });
    const { el, events } = await mount();
    await el.send("hi");
    await settle();
    state.requestHuman = () => json({ error: { code: "gateway_error", message: "Dewee is unavailable, try again later" } }, 502);
    vi.useFakeTimers();
    button(el).click();
    await tick(0);
    expect(el.shadowRoot!.querySelector(".notice")!.textContent).toBe("We couldn't reach support staff. Please try again.");
    expect(button(el).hidden).toBe(false);
    expect(button(el).getAttribute("aria-disabled")).toBe("false");
    expect(status(el).hidden).toBe(true);
    expect(el.diagnostics().reply.state).toBe("ok");
    await el.send("still there?");
    await tick(0);
    expect(bubbles(el).at(-1)).toBe("msg assistant: Agent answer");
    await tick(120_000);
    expect(count(state, "history")).toBe(0); // no polling after a failed request
    state.requestHuman = () => json({ error: { code: "human_handoff_unavailable", message: "Talking to a person is not available" } }, 403);
    button(el).click();
    await tick(0);
    expect([...el.shadowRoot!.querySelectorAll(".notice")].at(-1)!.textContent).toBe("Talking to a person isn't available right now.");
    expect(button(el).hidden).toBe(true);
    expect(events.filter((e) => e.name === "dewee:error")).toEqual([]);
    expect(count(state, "request-human")).toBe(2);
  });
});
