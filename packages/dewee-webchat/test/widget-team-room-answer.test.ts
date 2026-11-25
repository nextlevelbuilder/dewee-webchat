// @vitest-environment happy-dom
// <dewee-chat> and a colleague agent's answer (Team Room): the answer reaches the conversation after
// the visitor's run ended, so the widget reads history until it shows up, without a takeover backend
// and without a reload. No reads when no colleague can have been asked; none after the answer, the
// deadline or a conversation switch.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";

interface Turn { role: "user" | "assistant"; content: string }

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const sse = (frames: unknown[]) => new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

/** A backend without takeovers whose run may ask a colleague (a `room_ask` tool frame). */
function backend(opts: { agents: number; askTool?: boolean; otherTool?: boolean }) {
  const state = { messages: [] as Turn[], calls: [] as string[] };
  const agents = Array.from({ length: opts.agents }, (_, i) => ({ id: i === 0 ? "support" : `colleague${i}` }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site.test").pathname.split("/").pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    state.calls.push(path);
    if (path === "config") return json({ agents, defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "0.5.0-test" });
    if (path === "session") return json({ visitorId: "v1", token: "visitor-token", expiresAt: Date.now() + 86_400_000 });
    if (path === "history") return json({ messages: state.messages.slice(-50) });
    if (path === "chat") {
      state.messages.push({ role: "user", content: body.message }, { role: "assistant", content: "Let me ask a colleague." });
      const tool = opts.askTool ? "room_ask" : opts.otherTool ? "web_search" : undefined;
      return sse([
        { type: "start", conversationId: body.conversationId, agent: "support" },
        ...(tool ? [{ type: "tool_call", id: "t1", name: tool }, { type: "tool_result", id: "t1", name: tool, isError: false }] : []),
        { type: "delta", text: "Let me ask a colleague." },
        { type: "done", content: "Let me ask a colleague." },
      ]);
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

const bubbles = (el: DeweeChatElement) => [...el.shadowRoot!.querySelectorAll<HTMLElement>(".log .msg")].filter((m) => !m.hidden).map((m) => m.textContent?.trim() ?? "");
const reads = (state: ReturnType<typeof backend>) => state.calls.filter((c) => c === "history").length;

beforeAll(() => defineDeweeChat());
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("<dewee-chat> colleague agent answer", () => {
  it("shows the answer written after the run without a reload, on a backend without takeovers, then stops reading", async () => {
    const state = backend({ agents: 2, askTool: true });
    const el = await mount();
    vi.useFakeTimers();
    await el.send("What is the refund policy?");
    await settle();
    // The colleague answers after the gateway's wait for the visitor's run: about 40 s later.
    await tick(40_000);
    const before = reads(state);
    expect(before).toBeGreaterThanOrEqual(9); // read every 4 s, not backed off
    state.messages.push({ role: "assistant", content: "Refunds are accepted within 30 days." });
    await tick(4_000);
    expect(bubbles(el).some((b) => b.includes("Refunds are accepted within 30 days."))).toBe(true);
    const after = reads(state);
    await tick(120_000);
    expect(reads(state)).toBe(after);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("watches after a run on a multi-agent integration that shows no tool activity, backing off", async () => {
    const state = backend({ agents: 2 });
    const el = await mount();
    vi.useFakeTimers();
    await el.send("hi");
    await settle();
    await tick(60_000);
    expect(reads(state)).toBeGreaterThan(0);
    expect(reads(state)).toBeLessThan(10);
    state.messages.push({ role: "assistant", content: "A colleague's answer." });
    await tick(30_000);
    expect(bubbles(el).some((b) => b.includes("A colleague's answer."))).toBe(true);
  });

  it("stops at the deadline when no answer comes", async () => {
    const state = backend({ agents: 2, askTool: true });
    const el = await mount();
    vi.useFakeTimers();
    await el.send("hi");
    await settle();
    await tick(6 * 60_000 + 5_000);
    const last = reads(state);
    await tick(120_000);
    expect(reads(state)).toBe(last);
    expect(vi.getTimerCount()).toBe(0);
    expect(el).toBeTruthy();
  });

  it("does not read history when no colleague can have been asked", async () => {
    for (const opts of [{ agents: 1 }, { agents: 2, otherTool: true }]) {
      const state = backend(opts);
      const el = await mount();
      vi.useFakeTimers();
      await el.send("hi");
      await settle();
      await tick(120_000);
      expect(reads(state)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      el.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("forgets the watch when the visitor starts another conversation", async () => {
    const state = backend({ agents: 2, askTool: true });
    const el = await mount();
    vi.useFakeTimers();
    await el.send("hi");
    await settle();
    await tick(8_000);
    const before = reads(state);
    expect(before).toBeGreaterThan(0);
    el.newConversation();
    await tick(120_000);
    expect(reads(state)).toBe(before);
  });
});
