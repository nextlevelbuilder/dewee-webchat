import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { createDeweeHandler, foldHistory, signVisitorToken, verifyVisitorToken } from "../src/server";
import type { ChatStreamEvent } from "../src/protocol";

// A fake gateway speaking the WS v3 protocol: connect, chat.send (streams agent events), chat.history.
let wss: WebSocketServer;
let gatewayUrl = "";
const seen: { connects: any[]; sends: any[] } = { connects: [], sends: [] };

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  gatewayUrl = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      const res = (payload: unknown, ok = true) => ws.send(JSON.stringify({ type: "res", id: f.id, ok, payload, error: ok ? undefined : payload }));
      if (f.method === "connect") {
        seen.connects.push(f.params);
        return f.params.token === "good" ? res({ role: "operator" }) : res({ code: "unauthorized", message: "bad token" }, false);
      }
      if (f.method === "chat.send") {
        seen.sends.push(f.params);
        const base = { agentId: f.params.agentId, runId: "run-1", sessionKey: f.params.sessionKey };
        const ev = (type: string, payload: unknown) => ws.send(JSON.stringify({ type: "event", event: "agent", payload: { ...base, type, payload } }));
        // noise from another session must be ignored
        ws.send(JSON.stringify({ type: "event", event: "agent", payload: { ...base, sessionKey: "agent:x:ws:direct:other", type: "chunk", payload: { content: "LEAK" } } }));
        ev("run.started", {});
        ev("thinking", { content: "Let me " });
        ev("thinking", { content: "check." });
        ev("tool.call", { id: "t1", name: "mcp_anymd__read_url", arguments: { url: "https://dewee.sh" } });
        ev("tool.result", { id: "t1", name: "mcp_anymd__read_url", is_error: false, result: "page text" });
        ev("chunk", { content: "Hello " });
        ev("chunk", { content: "world" });
        ev("run.completed", { content: "Hello world" });
        return res({ content: "Hello world", usage: { total_tokens: 42 } });
      }
      if (f.method === "chat.history") {
        return res({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "", thinking: "plan", tool_calls: [{ id: "t1", name: "search", arguments: { q: "x" } }] },
            { role: "tool", content: "result", tool_call_id: "t1" },
            { role: "assistant", content: "answer" },
          ],
        });
      }
      res({});
    });
  });
});

afterAll(() => wss.close());

const handler = () =>
  createDeweeHandler({ gatewayUrl, token: "good", secret: "s".repeat(32), agents: ["support", { id: "sales", name: "Sales" }], rateLimit: false });

async function session(h: ReturnType<typeof createDeweeHandler>) {
  const r = await h(new Request("https://site.test/api/dewee/session", { method: "POST", body: "{}" }));
  return (await r.json()) as { token: string; visitorId: string };
}

async function readSse(res: Response): Promise<ChatStreamEvent[]> {
  const text = await res.text();
  return text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
}

describe("visitor tokens", () => {
  it("requires a stable secret unless legacy ephemeral sessions are explicitly enabled", () => {
    expect(() => createDeweeHandler({ gatewayUrl, token: "good" })).toThrow(/secret/i);
    expect(() => createDeweeHandler({ gatewayUrl, token: "good", secret: "short" })).toThrow(/32 bytes/i);
    expect(() => createDeweeHandler({ gatewayUrl, token: "good", secret: "short", allowEphemeralSecret: true })).toThrow(/32 bytes/i);
    expect(() => createDeweeHandler({ gatewayUrl, token: "good", allowEphemeralSecret: true })).not.toThrow();
  });
  it("round-trips and rejects tampering/expiry", async () => {
    const t = await signVisitorToken("k".repeat(32), { v: "visitor_123", exp: Date.now() + 1000 });
    expect((await verifyVisitorToken("k".repeat(32), t))?.v).toBe("visitor_123");
    expect(await verifyVisitorToken("x".repeat(32), t)).toBeNull();
    expect(await verifyVisitorToken("k".repeat(32), t.slice(0, -2) + "aa")).toBeNull();
    const old = await signVisitorToken("k".repeat(32), { v: "visitor_123", exp: Date.now() - 1 });
    expect(await verifyVisitorToken("k".repeat(32), old)).toBeNull();
  });
});

describe("handler", () => {
  it("exposes public config without secrets", async () => {
    const r = await handler()(new Request("https://site.test/api/dewee/config"));
    const body = await r.json();
    expect(body.agents.map((a: any) => a.id)).toEqual(["support", "sales"]);
    expect(body.defaultAgent).toBe("support");
    expect(body.allowAgentSwitch).toBe(true);
    expect(JSON.stringify(body)).not.toContain("good");
  });

  it("requires a visitor session for chat", async () => {
    const r = await handler()(new Request("https://site.test/api/dewee/chat", { method: "POST", body: JSON.stringify({ message: "hi" }) }));
    expect(r.status).toBe(401);
  });

  it("streams normalized events scoped to the visitor's session", async () => {
    const h = handler();
    const s = await session(h);
    const r = await h(
      new Request("https://site.test/api/dewee/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${s.token}` },
        body: JSON.stringify({ message: "hello", agent: "sales", conversationId: "conv_abc123" }),
      }),
    );
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(r);
    expect(events.map((e) => e.type)).toEqual(["start", "thinking", "thinking", "tool_call", "tool_result", "delta", "delta", "done"]);
    expect(JSON.stringify(events)).not.toContain("LEAK");
    const send = seen.sends.at(-1);
    expect(send.agentId).toBe("sales");
    expect(send.sessionKey).toBe(`agent:sales:ws:direct:webchat-${s.visitorId}-conv_abc123`);
    expect(seen.connects.at(-1).user_id).toBe(`webchat-${s.visitorId}`);
  });

  it("rejects agents outside the allowlist and oversize messages", async () => {
    const h = handler();
    const s = await session(h);
    const post = (body: unknown) =>
      h(new Request("https://site.test/api/dewee/chat", { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify(body) }));
    expect((await post({ message: "x", agent: "admin-agent" })).status).toBe(403);
    expect((await post({ message: "x".repeat(5000) })).status).toBe(413);
  });

  it("blocks foreign origins unless allowed, and answers CORS preflight for allowed ones", async () => {
    const h = createDeweeHandler({ gatewayUrl, token: "good", secret: "s".repeat(32), agents: ["a"], allowedOrigins: ["https://ok.test"], allowedHeaders: ["X-CSRF-Token"] });
    const bad = await h(new Request("https://site.test/api/dewee/config", { headers: { origin: "https://evil.test" } }));
    expect(bad.status).toBe(403);
    const pre = await h(new Request("https://site.test/api/dewee/chat", { method: "OPTIONS", headers: { origin: "https://ok.test" } }));
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://ok.test");
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-csrf-token");
    expect(() => createDeweeHandler({ secret: "s".repeat(32), allowedHeaders: ["x-bad\r\nheader"] })).toThrow(/allowedHeaders/);
  });

  it("only accepts client credentials when enabled", async () => {
    const headers = { "x-dewee-gateway-url": gatewayUrl, "x-dewee-gateway-token": "good" };
    const off = await handler()(new Request("https://site.test/api/dewee/config", { headers }));
    expect(off.status).toBe(400);
    const h = createDeweeHandler({ secret: "s".repeat(32), allowClientCredentials: { allowedHosts: ["gw.example.com"] } });
    const blocked = await h(new Request("https://site.test/api/dewee/config", { headers: { ...headers, "x-dewee-gateway-url": "https://evil.example.com" } }));
    expect(blocked.status).toBe(400);
  });

  it("returns folded history", async () => {
    const h = handler();
    const s = await session(h);
    const r = await h(new Request("https://site.test/api/dewee/history?agent=support&conversationId=conv_abc123", { headers: { authorization: `Bearer ${s.token}` } }));
    const { messages } = await r.json();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "answer", thinking: "plan", toolCalls: [{ id: "t1", name: "search", result: "result" }] });
  });
});

describe("foldHistory", () => {
  it("drops empty assistant shells", () => {
    expect(foldHistory([{ role: "user", content: "a" }, { role: "assistant", content: "" }])).toHaveLength(1);
  });
});

describe("page actions", () => {
  const nav = { name: "navigate", description: "Go to a route", sensitivity: "navigate", parameters: { type: "object", properties: { route: { type: "string", enum: ["/", "/runs"] } } } };
  const chat = async (body: Record<string, unknown>) => {
    const h = handler();
    const s = await session(h);
    return h(new Request("https://site.test/api/dewee/chat", { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify({ conversationId: "conv_actions1", ...body }) }));
  };

  it("leaves the gateway message and start event unchanged without actions", async () => {
    const events = await readSse(await chat({ message: "plain" }));
    expect(seen.sends.at(-1).message).toBe("plain");
    expect(events[0]).not.toHaveProperty("actionsHash");
  });

  it("prepends the manifest and page context, then only a reference once acknowledged", async () => {
    const first = await readSse(await chat({ message: "open runs", actions: [nav], pageContext: { route: "/" } }));
    const hash = (first[0] as any).actionsHash;
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    const sent = seen.sends.at(-1).message as string;
    expect(sent.startsWith("[[dewee-page v1]]\n")).toBe(true);
    expect(sent).toContain('"name":"navigate"');
    expect(sent).toContain('Page context: {"route":"/"}');
    expect(sent.endsWith("[[/dewee-page]]\n\nopen runs")).toBe(true);

    await readSse(await chat({ message: "again", actions: [nav], actionsHash: hash }));
    const short = seen.sends.at(-1).message as string;
    expect(short).not.toContain('"name":"navigate"');
    expect(short).toContain(`Page actions unchanged (manifest ${hash})`);
  });

  it("rejects invalid or oversized actions and page context", async () => {
    const code = async (body: Record<string, unknown>) => {
      const r = await chat({ message: "x", ...body });
      return [r.status, (await r.json()).error.code];
    };
    expect(await code({ actions: [{ ...nav, name: "Bad Name" }] })).toEqual([400, "invalid_actions"]);
    expect(await code({ actions: "nope" })).toEqual([400, "invalid_actions"]);
    expect(await code({ actions: Array.from({ length: 33 }, (_, i) => ({ ...nav, name: `a${i}` })) })).toEqual([413, "actions_too_large"]);
    expect(await code({ pageContext: { blob: "x".repeat(5000) } })).toEqual([413, "context_too_large"]);
  });

  it("strips the page block from user messages in history", () => {
    const folded = foldHistory([{ role: "user", content: "[[dewee-page v1]]\nPage context: {}\n[[/dewee-page]]\n\nhello" }]);
    expect(folded[0].content).toBe("hello");
  });
});
