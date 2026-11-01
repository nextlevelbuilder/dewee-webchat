// @vitest-environment happy-dom
// The page-action ack belongs to the backend conversation, which is keyed by the session's visitor:
// a sign-in, a sign-out or another user must not inherit the ack, or the agent never sees the manifest.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";

/** A backend that signs users in: `/session` answers for whoever `who.visitor` currently is. */
function mockBackend() {
  const who = { visitor: "anon-1", verified: false, refuseNextChat: false };
  const chats: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site.test").pathname;
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (path.endsWith("/config")) return json({ agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "test", identity: true });
    if (path.endsWith("/session")) {
      const s = { visitorId: who.visitor, token: `t-${who.visitor}`, expiresAt: Date.now() + 3_600_000, expiresIn: 3_600_000 };
      return json(who.verified ? { ...s, verified: true } : s);
    }
    if (path.endsWith("/history")) return json({ messages: [] });
    const body = JSON.parse(String(init?.body));
    chats.push(body);
    if (who.refuseNextChat) {
      who.refuseNextChat = false;
      return new Response(JSON.stringify({ error: "Session expired" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    const frames = [{ type: "start", conversationId: body.conversationId, agent: body.agent, actionsHash: "h1" }, { type: "done", content: "Sure." }];
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }));
  return { who, chats, last: () => chats[chats.length - 1] };
}

async function mount(persist: boolean): Promise<DeweeChatElement> {
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  el.setAttribute("endpoint", "/api/dewee");
  el.setAttribute("mode", "inline");
  if (!persist) el.setAttribute("persist", "false");
  document.body.appendChild(el);
  await new Promise((r) => setTimeout(r, 0));
  el.registerActions({ name: "navigate", description: "Go", sensitivity: "navigate", handler: async () => ({ ok: true }) });
  return el;
}

beforeAll(() => defineDeweeChat());
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("<dewee-chat> page-action ack across identity changes", () => {
  it("resends the manifest after a sign-in, another user's sign-in and a sign-out only when that conversation has not seen it", async () => {
    const b = mockBackend();
    const el = await mount(true); // the default: the conversation id outlives renewSession()
    await el.send("hi");
    expect(b.last().actionsHash).toBeUndefined();
    await el.send("again");
    expect(b.last().actionsHash).toBe("h1"); // same anonymous conversation: acknowledged

    Object.assign(b.who, { visitor: "user-1", verified: true });
    await el.renewSession();
    await el.send("which kit fits a solo developer?");
    expect(b.last().actionsHash).toBeUndefined(); // signed in: new backend conversation, manifest resent
    await el.send("open the changelog");
    expect(b.last().actionsHash).toBe("h1");

    Object.assign(b.who, { visitor: "user-2", verified: true });
    await el.renewSession();
    await el.send("hello");
    expect(b.last().actionsHash).toBeUndefined(); // a second user on the same browser

    Object.assign(b.who, { visitor: "anon-1", verified: false });
    await el.renewSession();
    await el.send("signed out");
    expect(b.last().actionsHash).toBe("h1"); // back in the anonymous conversation, which saw the manifest
    expect(new Set(b.chats.map((c) => c.conversationId)).size).toBe(1);
  });

  it("does not carry a stored anonymous ack into a signed-in page load", async () => {
    const b = mockBackend();
    let el = await mount(true);
    await el.send("hi");
    await el.send("again");
    expect(b.last().actionsHash).toBe("h1");
    el.remove();

    // The host signs the visitor in and reloads; the conversation id and the ack are in localStorage.
    Object.assign(b.who, { visitor: "user-1", verified: true });
    el = await mount(true);
    await el.send("which kit fits a solo developer?");
    expect(b.last().conversationId).toBe(b.chats[0].conversationId);
    expect(b.last().actionsHash).toBeUndefined();
  });

  it("drops the ack when the backend refuses the session and the retry runs for another visitor", async () => {
    const b = mockBackend();
    const el = await mount(true);
    await el.send("hi");
    await el.send("again");
    expect(b.last().actionsHash).toBe("h1");

    // The visitor signed in elsewhere in the tab; the held anonymous token is refused once.
    Object.assign(b.who, { visitor: "user-1", verified: true, refuseNextChat: true });
    await el.send("open the changelog");
    expect(b.chats.at(-2).actionsHash).toBe("h1"); // refused request
    expect(b.last().actionsHash).toBeUndefined(); // retried for user-1
    await el.send("thanks");
    expect(b.last().actionsHash).toBe("h1"); // acknowledged for user-1's conversation
  });
});
