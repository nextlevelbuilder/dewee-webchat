// Characterization of the browser-facing responses of the legacy (direct Gateway WebSocket)
// transport. The snapshots were recorded before the transport switch was introduced; they must
// track intentional contract changes for hosts on `transport: "legacy-gateway"`.
// Random values (tokens, visitor ids, conversation ids) are
// normalized before comparison.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { createDeweeHandler, type DeweeHandlerOptions } from "../src/server";

let wss: WebSocketServer;
let gatewayUrl = "";
let pageContextSupported = false;
let lastChat: any;
let pageContextRefusal = false;

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  gatewayUrl = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      const res = (payload: unknown, ok = true) => ws.send(JSON.stringify({ type: "res", id: f.id, ok, payload, error: ok ? undefined : payload }));
      if (f.method === "connect") return f.params.token === "good" ? res({ role: "operator", ...(pageContextSupported ? { page_context_versions: [1] } : {}) }) : res({ code: "unauthorized", message: "bad token" }, false);
      if (f.method === "chat.send") {
        lastChat = f.params;
        if (pageContextRefusal) return res({ code: "INVALID_REQUEST", message: "private page content", details: { reason: "page_context_invalid" } }, false);
        const base = { agentId: f.params.agentId, runId: "run-1", sessionKey: f.params.sessionKey };
        const ev = (type: string, payload: unknown) => ws.send(JSON.stringify({ type: "event", event: "agent", payload: { ...base, type, payload } }));
        if (f.params.message.endsWith("fail")) {
          ev("run.started", {});
          ev("run.failed", { error: "provider exploded" });
          return res({ code: "run_failed", message: "provider exploded" }, false);
        }
        ev("run.started", {});
        ev("thinking", { content: "Let me check." });
        ev("tool.call", { id: "t1", name: "search", arguments: { q: "x" } });
        ev("tool.result", { id: "t1", name: "search", is_error: false, result: "found" });
        if (f.params.message.endsWith("credential-test")) {
          ev("tool.call", { id: "s1", name: "request_credentials", arguments: { value: "credential-argument-secret" } });
          ev("tool.call", { id: "s1", name: "search", arguments: { value: "reused-call-secret" } });
          ev("tool.result", { id: "s1", result: "credential-result-secret" });
          ev("tool.result", { id: "unknown", result: "unmatched-result-secret" });
        }
        ev("chunk", { content: "Hello " });
        ev("chunk", { content: "world" });
        ev("run.completed", { content: "Hello world" });
        return res({ content: "Hello world", usage: { total_tokens: 42 } });
      }
      if (f.method === "chat.history") {
        if (String(f.params.sessionKey).includes("conv_cred")) return res({ messages: [
          { role: "assistant", content: "", tool_calls: [{ id: "s1", name: "request_credentials", arguments: { value: "credential-argument-secret" } }, { id: "s1", name: "search", arguments: { value: "reused-call-secret" } }, { name: "request_credentials" }, { name: "search" }, { id: "safe", name: "search", arguments: { q: "public" } }] },
          { role: "tool", content: "credential-result-secret", tool_call_id: "s1" }, { role: "tool", content: "missing-id-secret" }, { role: "tool", content: "public-result", tool_call_id: "safe" },
        ] });
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

const BASE = "https://site.test/api/dewee";
const opts = (extra: Partial<DeweeHandlerOptions> = {}): DeweeHandlerOptions => ({
  gatewayUrl,
  token: "good",
  secret: "s".repeat(32),
  agents: ["support", { id: "sales", name: "Sales" }],
  rateLimit: false,
  ...extra,
});

/** Replaces random values with stable placeholders, keeping their shape visible. */
function normalize(text: string, extra: Record<string, string> = {}): string {
  let out = text.replace(new RegExp(gatewayUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "<gateway>");
  for (const [value, label] of Object.entries(extra)) out = out.split(value).join(label);
  return out
    .replace(/"token":"[^"]+"/g, '"token":"<token>"')
    .replace(/"expiresAt":\d+/g, '"expiresAt":"<epoch-ms>"')
    .replace(/"expiresIn":\d+/g, '"expiresIn":"<duration-ms>"')
    .replace(/"version":"[^"]+"/g, '"version":"<version>"');
}

async function capture(res: Response, extra: Record<string, string> = {}) {
  const headers = Object.fromEntries([...res.headers].filter(([k]) => k !== "date").sort(([a], [b]) => a.localeCompare(b)));
  return { status: res.status, headers, body: normalize(await res.text(), extra) };
}

async function visitor(h: ReturnType<typeof createDeweeHandler>) {
  const r = await h(new Request(`${BASE}/session`, { method: "POST", body: "{}" }));
  return (await r.json()) as { token: string; visitorId: string };
}

describe("legacy-gateway transport: browser responses", () => {
  it("does not expose credential tool arguments or results in stream and history", async () => {
    const h=createDeweeHandler(opts()); const s=await visitor(h); const headers={authorization:`Bearer ${s.token}`};
    const response=await h(new Request(`${BASE}/chat`,{method:"POST",headers,body:JSON.stringify({message:"credential-test",agent:"support",conversationId:"conv_cred"})}));
    const stream=await response.text();
    for (const secret of ["credential-argument-secret","reused-call-secret","credential-result-secret","unmatched-result-secret"]) expect(stream).not.toContain(secret);
    expect(stream).toContain('"result":"found"');
    const history=await (await h(new Request(`${BASE}/history?agent=support&conversationId=conv_cred`,{headers}))).text();
    expect(history).not.toContain("secret"); expect(history).toContain("public-result");
  });
  it("negotiates and forwards page context only when the connected runtime supports it", async () => {
    const h = createDeweeHandler(opts({ agents: [{ id: "support", name: "Support" }] }));
    const context = { version: 1, url: "https://site.test/page", content: { format: "text", text: "A page", truncated: false } };
    const s = await visitor(h);
    const post = () => h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify({ message: "hello", page_context: context }) }));
    try {
      pageContextSupported = false;
      expect((await (await h(new Request(`${BASE}/config?pageContext=1`))).json()).pageContextVersions).toBeUndefined();
      const old = await post();
      expect([old.status, (await old.json()).error.code]).toEqual([400, "page_context_unsupported"]);
      pageContextSupported = true;
      expect((await (await h(new Request(`${BASE}/config?pageContext=1`))).json()).pageContextVersions).toEqual([1]);
      const ok = await post();
      await ok.text();
      expect(lastChat.message).toBe("hello");
      expect(lastChat.pageContext).toEqual(context);
      pageContextRefusal = true;
      const refused = await (await post()).text();
      expect(refused).toContain('"code":"page_context_invalid"');
      expect(refused).not.toContain("private page content");
      pageContextRefusal = false;
      pageContextSupported = false;
      const downgraded = await post();
      expect([downgraded.status, (await downgraded.json()).error.code]).toEqual([400, "page_context_unsupported"]);
    } finally { pageContextSupported = false; pageContextRefusal = false; }
  });
  it("config", async () => {
    const h = createDeweeHandler(opts());
    expect(await capture(await h(new Request(`${BASE}/config`)))).toMatchSnapshot();
  });

  it("session (new and refreshed)", async () => {
    const h = createDeweeHandler(opts());
    const first = await h(new Request(`${BASE}/session`, { method: "POST", body: "{}" }));
    const s = (await first.clone().json()) as { token: string; visitorId: string; expiresIn: number };
    expect(s.expiresIn).toBeGreaterThan(0);
    expect(await capture(first, { [s.visitorId]: "<visitor>" })).toMatchSnapshot();
    const refreshed = await h(new Request(`${BASE}/session`, { method: "POST", body: JSON.stringify({ token: s.token }) }));
    expect((await refreshed.clone().json()).expiresIn).toBeGreaterThan(0);
    expect(await capture(refreshed, { [s.visitorId]: "<visitor>" })).toMatchSnapshot();
  });

  it("chat stream", async () => {
    const h = createDeweeHandler(opts());
    const s = await visitor(h);
    const r = await h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify({ message: "hello", agent: "sales", conversationId: "conv_abc123" }) }));
    expect(await capture(r)).toMatchSnapshot();
  });

  it("chat stream with a run failure", async () => {
    const h = createDeweeHandler(opts());
    const s = await visitor(h);
    const r = await h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify({ message: "please fail", conversationId: "conv_abc123" }) }));
    expect(await capture(r)).toMatchSnapshot();
  });

  it("history", async () => {
    const h = createDeweeHandler(opts());
    const s = await visitor(h);
    const r = await h(new Request(`${BASE}/history?agent=support&conversationId=conv_abc123`, { headers: { authorization: `Bearer ${s.token}` } }));
    expect(await capture(r)).toMatchSnapshot();
  });

  it("errors", async () => {
    const h = createDeweeHandler(opts({ allowedOrigins: ["https://ok.test"] }));
    const s = await visitor(h);
    const auth = { authorization: `Bearer ${s.token}` };
    const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
      h(new Request(`${BASE}/${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
    const cases = {
      chatWithoutSession: await post("chat", { message: "hi" }, {}),
      emptyMessage: await post("chat", { message: "  " }),
      agentNotAllowed: await post("chat", { message: "x", agent: "admin-agent" }),
      tooLong: await post("chat", { message: "x".repeat(5000) }),
      invalidActions: await post("chat", { message: "x", actions: "nope" }),
      badHistoryId: await h(new Request(`${BASE}/history?conversationId=bad`, { headers: auth })),
      unknownRoute: await h(new Request(`${BASE}/nope`)),
      linkWithoutIdentity: await post("link", {}),
      foreignOrigin: await h(new Request(`${BASE}/config`, { headers: { origin: "https://evil.test" } })),
      preflight: await h(new Request(`${BASE}/chat`, { method: "OPTIONS", headers: { origin: "https://ok.test" } })),
      clientCredentialsOff: await h(new Request(`${BASE}/config`, { headers: { "x-dewee-gateway-url": gatewayUrl, "x-dewee-gateway-token": "good" } })),
    };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cases)) out[k] = await capture(v);
    expect(out).toMatchSnapshot();
  });

  it("gateway unavailable", async () => {
    const h = createDeweeHandler(opts({ gatewayUrl: "http://127.0.0.1:1", agents: ["support"] }));
    const s = await visitor(h);
    const r = await h(new Request(`${BASE}/history?conversationId=conv_abc123`, { headers: { authorization: `Bearer ${s.token}` } }));
    const c = await capture(r);
    expect({ status: c.status, code: JSON.parse(c.body).error.code }).toMatchSnapshot();
  });

  it("warns nothing for hosts that keep the gateway options", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createDeweeHandler(opts());
      // Recorded before the transport switch: legacy hosts got no startup warning other than the
      // missing-secret one. The deprecation notice is added on purpose and asserted separately.
      expect(warn.mock.calls.filter((c) => !String(c[0]).includes("deprecated"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
