// @vitest-environment happy-dom
// <dewee-chat> and a colleague agent's answer (Team Room): the answer reaches the conversation after
// the visitor's run ended, so the widget reads history until it shows up, without a takeover backend
// and without a reload. A run seen calling `room_ask` is watched every 4 s for 6 minutes; a run that
// may have asked (no visible tool, several agents) gets 3 reads over 90 s. Reads back off on errors,
// honour Retry-After, stop on a refusal, and stop only on an agent reply newer than the run.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";

interface Turn { role: "user" | "assistant"; content: string; createdAt?: string }

const REPLY = "Let me ask a colleague.";
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const sse = (frames: unknown[]) => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

interface Opts { agents: number; askTool?: boolean; otherTool?: boolean; storeReply?: boolean; hang?: boolean }

/** A backend without takeovers whose run may ask a colleague (a `room_ask` tool frame). */
function backend(opts: Opts) {
  const state = {
    messages: [] as Turn[],
    calls: [] as string[],
    /** Answers for the next history reads, before the stored conversation. */
    historyReplies: [] as Array<() => Response>,
  };
  const agents = Array.from({ length: opts.agents }, (_, i) => ({ id: i === 0 ? "support" : `colleague${i}` }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site.test").pathname.split("/").pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    state.calls.push(path);
    if (path === "config") return json({ agents, defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "0.5.0-test" });
    if (path === "session") return json({ visitorId: "v1", token: "visitor-token", expiresAt: Date.now() + 86_400_000 });
    if (path === "history") {
      const next = state.historyReplies.shift();
      return next ? next() : json({ messages: state.messages.slice(-50) });
    }
    if (path === "chat") {
      state.messages.push({ role: "user", content: body.message });
      if (opts.storeReply !== false) state.messages.push({ role: "assistant", content: REPLY });
      const tool = opts.askTool ? "room_ask" : opts.otherTool ? "web_search" : undefined;
      const frames = [
        { type: "start", conversationId: body.conversationId, agent: "support" },
        ...(tool ? [{ type: "tool_call", id: "t1", name: tool }, { type: "tool_result", id: "t1", name: tool, isError: false }] : []),
        { type: "delta", text: REPLY },
      ];
      if (opts.hang) {
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
            init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return sse([...frames, { type: "done", content: REPLY }]);
    }
    throw new Error(`unexpected ${path}`);
  }));
  return state;
}

const realImmediate = globalThis.setImmediate;
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => realImmediate(r)); };
const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await settle(); };

async function mount() {
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  for (const [k, v] of Object.entries({ endpoint: "/api/dewee", mode: "inline", persist: "false", locale: "en" })) el.setAttribute(k, v);
  const ready = new Promise<void>((r) => el.addEventListener("dewee:ready", () => r(), { once: true }));
  document.body.appendChild(el);
  await ready;
  await settle();
  return el;
}

/** Mounts, switches to fake timers and sends one message. */
async function asked(opts: Opts) {
  const state = backend(opts);
  const el = await mount();
  vi.useFakeTimers();
  await el.send("What is the refund policy?");
  await settle();
  return { state, el };
}

const bubbles = (el: DeweeChatElement) => [...el.shadowRoot!.querySelectorAll<HTMLElement>(".log .msg")].filter((m) => !m.hidden).map((m) => m.textContent?.trim() ?? "");
const reads = (state: ReturnType<typeof backend>) => state.calls.filter((c) => c === "history").length;
const shows = (el: DeweeChatElement, text: string) => bubbles(el).some((b) => b.includes(text));
const setVisibility = (v: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeAll(() => defineDeweeChat());
afterEach(() => {
  document.body.innerHTML = "";
  setVisibility("visible");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("<dewee-chat> colleague agent answer", () => {
  it("shows the answer written after the run without a reload, on a backend without takeovers, then stops reading", async () => {
    const { state, el } = await asked({ agents: 2, askTool: true });
    // The colleague answers after the gateway's wait for the visitor's run: about 40 s later.
    await tick(40_000);
    expect(reads(state)).toBeGreaterThanOrEqual(9); // every 4 s, not backed off
    state.messages.push({ role: "assistant", content: "Refunds are accepted within 30 days." });
    await tick(4_000);
    expect(shows(el, "Refunds are accepted within 30 days.")).toBe(true);
    const after = reads(state);
    await tick(120_000);
    expect(reads(state)).toBe(after);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads 3 times over 90 s after a run that may have asked with tool activity hidden", async () => {
    const { state, el } = await asked({ agents: 2 });
    await tick(60_000);
    expect(reads(state)).toBe(2);
    state.messages.push({ role: "assistant", content: "A colleague's answer." });
    await tick(30_000);
    expect(reads(state)).toBe(3);
    expect(shows(el, "A colleague's answer.")).toBe(true);
    await tick(120_000);
    expect(reads(state)).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops at the deadline when no answer comes", async () => {
    const { state } = await asked({ agents: 2, askTool: true });
    await tick(6 * 60_000 + 5_000);
    const last = reads(state);
    expect(last).toBeGreaterThan(80);
    await tick(120_000);
    expect(reads(state)).toBe(last);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not read history when no colleague can have been asked", async () => {
    // One agent; and an integration that shows tool activity, whose run called another tool.
    for (const opts of [{ agents: 1 }, { agents: 2, otherTool: true }]) {
      const { state, el } = await asked(opts);
      await tick(120_000);
      expect(reads(state)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      el.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not watch after a run the visitor stopped", async () => {
    const state = backend({ agents: 2, askTool: true, hang: true });
    const el = await mount();
    vi.useFakeTimers();
    const sent = el.send("hi");
    await settle();
    el.stop();
    await sent;
    await tick(120_000);
    expect(reads(state)).toBe(0);
  });

  it("backs off on failed reads, waits as long as a 429 asks, and stops on a refusal", async () => {
    const { state } = await asked({ agents: 2, askTool: true });
    state.historyReplies.push(
      () => json({ error: { code: "gateway_error", message: "unavailable" } }, 502),
      () => json({ error: { code: "rate_limited", message: "slow down" } }, 429, { "retry-after": "50" }),
    );
    await tick(4_000); // 502
    expect(reads(state)).toBe(1);
    await tick(5_900); // backed off to 6 s
    expect(reads(state)).toBe(1);
    await tick(200); // 429
    expect(reads(state)).toBe(2);
    await tick(49_000);
    expect(reads(state)).toBe(2); // Retry-After: 50 s
    await tick(1_100);
    expect(reads(state)).toBe(3);
    state.historyReplies.push(() => json({ error: { code: "unauthorized", message: "no" } }, 401));
    await tick(4_000);
    const last = reads(state);
    await tick(120_000);
    expect(reads(state)).toBe(last);
  });

  it("keeps watching when only the run's own reply shows up late, or the log is redrawn", async () => {
    const { state, el } = await asked({ agents: 2, askTool: true, storeReply: false });
    // The run's reply is stored after the first read: not the colleague's answer.
    await tick(4_000);
    state.messages.push({ role: "assistant", content: REPLY });
    await tick(4_000);
    // A redraw that holds no newer agent reply (history starts with an older turn).
    state.messages.unshift({ role: "assistant", content: "Welcome back." });
    await tick(4_000);
    const before = reads(state);
    await tick(8_000);
    expect(reads(state)).toBe(before + 2);
    state.messages.push({ role: "assistant", content: "The colleague's answer." });
    await tick(4_000);
    expect(shows(el, "The colleague's answer.")).toBe(true);
    const last = reads(state);
    await tick(60_000);
    expect(reads(state)).toBe(last);
  });

  it("pauses while the tab is hidden and resumes before the deadline", async () => {
    const { state, el } = await asked({ agents: 2, askTool: true });
    await tick(4_000);
    expect(reads(state)).toBe(1);
    setVisibility("hidden");
    await tick(60_000);
    expect(reads(state)).toBe(1);
    state.messages.push({ role: "assistant", content: "Answered while hidden." });
    setVisibility("visible");
    await tick(4_000);
    expect(shows(el, "Answered while hidden.")).toBe(true);
  });

  it("forgets the watch when the visitor starts another conversation, also from a dewee:reply listener", async () => {
    const { state, el } = await asked({ agents: 2, askTool: true });
    await tick(8_000);
    const before = reads(state);
    expect(before).toBeGreaterThan(0);
    el.newConversation();
    await tick(120_000);
    expect(reads(state)).toBe(before);

    el.addEventListener("dewee:reply", () => el.newConversation(), { once: true });
    await el.send("again");
    await settle();
    const after = reads(state);
    await tick(120_000);
    expect(reads(state)).toBe(after);
  });
});
