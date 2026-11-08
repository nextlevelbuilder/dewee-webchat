// transport "ccp" against a fake CCP public webchat ingress: startup validation, transport selection,
// the browser contract (unchanged), error mapping and redaction, edge session refresh, isolation
// between visitors, redirect/SSRF refusal, abort propagation and the website's own limits.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "../src/protocol";
import { createDeweeHandler, optionsFromEnv, verifyVisitorToken, type DeweeHandlerOptions } from "../src/server";
import { INTEGRATION_ID, INTEGRATION_SECRET, mintEdge, startFakeCcp, startTrap, type FakeCcp } from "./helpers/fake-ccp-ingress";

const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";
const BASE = "https://shop.example/api/dewee";
let ccp: FakeCcp;

beforeAll(async () => {
  ccp = await startFakeCcp();
});
afterAll(() => ccp.close());
beforeEach(() => ccp.reset());

/** Every body and header set sent to a browser in this file; scanned for secrets at the end. */
const browserOutput: string[] = [];

function makeHandler(extra: Partial<DeweeHandlerOptions> = {}) {
  const h = createDeweeHandler({
    ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET },
    secret: VISITOR_SECRET,
    rateLimit: false,
    ...extra,
  });
  return async (req: Request) => {
    const res = await h(req);
    const text = await res.text();
    browserOutput.push(text, JSON.stringify(Object.fromEntries(res.headers)));
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  };
}
type H = ReturnType<typeof makeHandler>;

const session = async (h: H, body: unknown = {}) => (await h(new Request(`${BASE}/session`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body) }))).json();
const chat = (h: H, token: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://shop.example", ...headers }, body: JSON.stringify({ message: "hi", conversationId: "conv_ccp_0001", ...body }) }));
const history = (h: H, token: string, conversationId = "conv_ccp_0001", agent = "shop") =>
  h(new Request(`${BASE}/history?agent=${agent}&conversationId=${conversationId}`, { headers: { authorization: `Bearer ${token}` } }));
const sse = (text: string): ChatStreamEvent[] => text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const spies = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  try {
    return await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
};

describe("ccp transport: startup", () => {
  const ccpOpts = () => ({ chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET });
  const make = (o: Partial<DeweeHandlerOptions>) => () => createDeweeHandler({ secret: VISITOR_SECRET, ...o });

  it("refuses an unsafe or inconsistent CCP endpoint", () => {
    expect(make({ ccp: { ...ccpOpts(), chatUrl: `http://ccp.example.com/api/public/webchat/v1/${INTEGRATION_ID}` } })).toThrow(/https/);
    expect(make({ ccp: { ...ccpOpts(), chatUrl: `https://u:p@ccp.example.com/api/public/webchat/v1/${INTEGRATION_ID}` } })).toThrow(/credentials/);
    expect(make({ ccp: { ...ccpOpts(), chatUrl: "https://ccp.example.com/somewhere" } })).toThrow(/must end with/);
    expect(make({ ccp: { ...ccpOpts(), integrationId: "wci_bbbbbbbbbbbbbbbbbbbbbbbbbb" } })).toThrow(/does not match/);
    expect(make({ ccp: { ...ccpOpts(), integrationSecret: "sk_live_admin_key_0000000000" } })).toThrow(/dwc_/);
    expect(make({ ccp: { ...ccpOpts(), integrationSecret: "" } })).toThrow(/DEWEE_WEBCHAT_INTEGRATION_SECRET/);
    // https anywhere and http to loopback are fine
    expect(make({ ccp: { ...ccpOpts(), chatUrl: `https://app.dewee.sh/api/public/webchat/v1/${INTEGRATION_ID}/` } })).not.toThrow();
    expect(make({ ccp: ccpOpts() })).not.toThrow();
  });

  it("never error messages carry the secret", () => {
    try {
      createDeweeHandler({ secret: VISITOR_SECRET, ccp: { ...ccpOpts(), chatUrl: "https://ccp.example.com/x" } });
    } catch (e) {
      expect(String(e)).not.toContain(INTEGRATION_SECRET);
    }
  });

  it("refuses CCP and gateway options together instead of picking one", () => {
    expect(make({ ccp: ccpOpts(), gatewayUrl: "https://gw.example.com", token: "gw" })).toThrow(/both CCP and gateway/);
    expect(make({ transport: "ccp", ccp: ccpOpts(), token: "gw" })).toThrow(/both CCP and gateway/);
    expect(make({ transport: "legacy-gateway", ccp: ccpOpts(), gatewayUrl: "https://gw.example.com", token: "gw" })).toThrow(/legacy-gateway/);
    expect(make({ transport: "ccp" })).toThrow(/needs ccp options/);
    expect(make({ transport: "websocket" as never, ccp: ccpOpts() })).toThrow(/transport must be/);
  });

  it("refuses legacy-only options and a missing visitor secret with ccp", () => {
    expect(make({ ccp: ccpOpts(), agents: ["shop"] })).toThrow(/agents/);
    expect(make({ ccp: ccpOpts(), defaultAgent: "shop" })).toThrow(/defaultAgent/);
    expect(make({ ccp: ccpOpts(), allowClientCredentials: true })).toThrow(/allowClientCredentials/);
    expect(() => createDeweeHandler({ ccp: ccpOpts() })).toThrow(/DEWEE_WEBCHAT_SECRET/);
    expect(() => createDeweeHandler({ ccp: ccpOpts(), secret: "short" })).toThrow(/32 bytes/);
  });

  it("reads the CCP environment variables and keeps explicit selection", () => {
    const env = { DEWEE_CCP_CHAT_URL: ccp.url, DEWEE_WEBCHAT_INTEGRATION_ID: INTEGRATION_ID, DEWEE_WEBCHAT_INTEGRATION_SECRET: INTEGRATION_SECRET, DEWEE_WEBCHAT_SECRET: VISITOR_SECRET };
    const o = optionsFromEnv(env);
    expect(o.ccp).toEqual({ chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET });
    expect(o.gatewayUrl).toBeUndefined();
    expect(() => createDeweeHandler(o)).not.toThrow();
    // Both sets in the environment: refused, never a silent pick.
    expect(() => createDeweeHandler(optionsFromEnv({ ...env, DEWEE_GATEWAY_URL: "https://gw.example.com", DEWEE_GATEWAY_TOKEN: "gw" }))).toThrow(/both CCP and gateway/);
    // A partial CCP environment names what is missing.
    expect(() => createDeweeHandler(optionsFromEnv({ DEWEE_CCP_CHAT_URL: ccp.url, DEWEE_WEBCHAT_SECRET: VISITOR_SECRET }))).toThrow(/DEWEE_WEBCHAT_INTEGRATION_ID/);
    expect(() => createDeweeHandler(optionsFromEnv({ ...env, DEWEE_WEBCHAT_TRANSPORT: "legacy-gateway" }))).toThrow(/legacy-gateway/);
  });

  it("warns once that the legacy gateway transport is deprecated", async () => {
    vi.resetModules();
    const { createDeweeHandler: fresh } = await import("../src/server/handler");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fresh({ gatewayUrl: "https://gw.example.com", token: "gw", secret: VISITOR_SECRET, agents: ["a"] });
      fresh({ transport: "legacy-gateway", gatewayUrl: "https://gw.example.com", token: "gw", secret: VISITOR_SECRET, agents: ["a"] });
      fresh({ ccp: ccpOpts(), secret: VISITOR_SECRET });
      const notices = warn.mock.calls.filter((c) => String(c[0]).includes("deprecated"));
      expect(notices).toHaveLength(1);
      expect(String(notices[0][0])).toContain("migrating-to-ccp-transport");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("ccp transport: browser contract", () => {
  it("forwards supported page context separately and rejects unsupported or oversized attachments", async () => {
    const attachment = { version: 1, url: "https://shop.example/item", content: { format: "text", text: "A page", truncated: false } };
    const old = makeHandler();
    const oldSession = await session(old);
    const refused = await chat(old, oldSession.token, { page_context: attachment });
    expect([refused.status, refused.json().error.code]).toEqual([400, "page_context_unsupported"]);
    expect(ccp.routes("chat")).toHaveLength(0);
    ccp.reset();
    ccp.state.config = { ...ccp.state.config, page_context: { versions: [1] } };
    const h = makeHandler();
    expect((await h(new Request(`${BASE}/config`))).json().pageContextVersions).toEqual([1]);
    const s = await session(h);
    const ok = await chat(h, s.token, { page_context: attachment });
    expect(ok.status).toBe(200);
    expect(ccp.routes("chat")[0].body).toMatchObject({ message: "hi", page_context: attachment });
    const multibyte = { ...attachment, content: { format: "text", text: "\u2028\u2029".repeat(5500), truncated: false } };
    expect((await chat(h, s.token, { page_context: multibyte })).status).toBe(200);
    const big = await chat(h, s.token, { page_context: { ...attachment, title: "x".repeat(66000) } });
    expect([big.status, big.json().error.code]).toEqual([400, "page_context_invalid"]);
    const huge = await chat(h, s.token, { padding: "x".repeat(131072) });
    expect([huge.status, huge.json().error.code]).toEqual([413, "too_long"]);
    ccp.state.failNext.set("chat", { status: 400, code: "page_context_invalid", message: "secret page contents" });
    const upstream = await chat(h, s.token, { page_context: attachment });
    expect([upstream.status, upstream.json().error.code]).toEqual([400, "page_context_invalid"]);
    expect(upstream.text).not.toContain("secret page contents");
  });
  it("serves the integration's agents in the unchanged config shape, cached", async () => {
    const h = makeHandler({ maxMessageLength: 8000 });
    const cfg = (await h(new Request(`${BASE}/config`))).json();
    expect(cfg).toEqual({
      agents: [{ id: "shop", name: "Shop assistant", description: "Orders and products" }, { id: "support", name: "Support" }],
      defaultAgent: "shop",
      allowAgentSwitch: true,
      allowClientCredentials: false,
      maxMessageLength: 4000,
      version: expect.any(String),
    });
    await h(new Request(`${BASE}/config`));
    expect(ccp.routes("config")).toHaveLength(1);
    expect(ccp.routes("config")[0].headers.authorization).toBe(`Bearer ${INTEGRATION_SECRET}`);
  });

  it("follows the integration's allow_agent_switch and a host override", async () => {
    ccp.state.config = { ...ccp.state.config, allow_agent_switch: false };
    expect((await makeHandler()(new Request(`${BASE}/config`))).json().allowAgentSwitch).toBe(false);
    ccp.reset();
    expect((await makeHandler({ allowAgentSwitch: false })(new Request(`${BASE}/config`))).json().allowAgentSwitch).toBe(false);
  });

  it("admits the visitor at CCP and seals the edge session in the visitor token", async () => {
    const h = makeHandler();
    const s = await session(h);
    expect(s.visitorId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    const created = ccp.routes("session")[0];
    expect(created.body).toEqual({ visitor_id: s.visitorId });
    expect(created.headers["x-dewee-visitor-ip"]).toBe("203.0.113.7");
    expect(String(created.headers["x-request-id"])).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    expect(created.headers["x-dewee-webchat-session"]).toBeUndefined();
    const decoded = Buffer.from(s.token.split(".")[0], "base64url").toString("utf8");
    expect(decoded).not.toContain("dws1.");
    const claims = await verifyVisitorToken(VISITOR_SECRET, s.token);
    expect(claims?.es).toMatch(/^dws1\./);
    // Refreshing the visitor keeps it and refreshes the edge session with the sealed one.
    const again = await session(h, { token: s.token });
    expect(again.visitorId).toBe(s.visitorId);
  });

  it("streams a turn with the visitor's edge session; reasoning and tool activity hidden by default", async () => {
    const h = makeHandler();
    const s = await session(h);
    ccp.state.leaky = true; // CCP should filter these; the adapter drops them as well
    const r = await chat(h, s.token, { agent: "support" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const events = sse(r.text);
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "done"]);
    expect(events[0]).toEqual({ type: "start", conversationId: "conv_ccp_0001", agent: "support", runId: "run-42" });
    expect(events[2]).toEqual({ type: "done", content: `hello wcv:${INTEGRATION_ID}:${s.visitorId}`, usage: { total_tokens: 12 } });
    const call = ccp.routes("chat")[0];
    expect(call.body).toEqual({ message: "hi", conversation_id: "conv_ccp_0001", agent: "support" });
    expect(call.headers["x-dewee-visitor-origin"]).toBe("https://shop.example");
    expect(call.headers["x-dewee-webchat-session"]).toBe((await verifyVisitorToken(VISITOR_SECRET, s.token))?.es);
    expect(r.text).not.toContain("secret plan");
    expect(r.text).not.toContain("internal");
  });

  it("shows reasoning and tool names when the integration enables them, never tool arguments or results", async () => {
    ccp.state.config = { ...ccp.state.config, show_thinking: true, show_tool_activity: true };
    const h = makeHandler();
    const s = await session(h);
    const events = sse((await chat(h, s.token)).text);
    expect(events.map((e) => e.type)).toEqual(["start", "thinking", "tool_call", "tool_result", "delta", "done"]);
    expect(events[2]).toEqual({ type: "tool_call", id: "t1", name: "search_products" });
    expect(events[3]).toEqual({ type: "tool_result", id: "t1", name: "search_products", isError: false });
    const msgs = (await history(h, s.token)).json().messages;
    expect(msgs[1].toolCalls).toEqual([{ id: "t1", name: "search_products", status: "done", isError: false }]);
    expect(msgs[1].thinking).toBe("plan");
  });

  it("composes page actions into the message exactly as the legacy transport does", async () => {
    const h = makeHandler();
    const s = await session(h);
    const nav = { name: "navigate", description: "Go", sensitivity: "navigate", parameters: { type: "object", properties: {} } };
    const events = sse((await chat(h, s.token, { message: "open", actions: [nav] })).text);
    expect((events[0] as any).actionsHash).toMatch(/^[0-9a-f]{16}$/);
    const sent = ccp.routes("chat")[0].body.message as string;
    expect(sent.startsWith("[[dewee-page v1]]\n")).toBe(true);
    expect(sent.endsWith("[[/dewee-page]]\n\nopen")).toBe(true);
  });

  it("returns the visitor's own history without tool rows, reasoning or the page block", async () => {
    const h = makeHandler();
    const s = await session(h);
    await chat(h, s.token, { conversationId: "conv_hist_0001" });
    const r = await history(h, s.token, "conv_hist_0001");
    expect(r.json()).toEqual({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: `hello wcv:${INTEGRATION_ID}:${s.visitorId}` }] });
    expect(ccp.routes("history")[0].body).toEqual({ conversation_id: "conv_hist_0001", limit: 50, agent: "shop" });
  });

  it("keeps visitors apart: another visitor's conversation id reads as empty", async () => {
    const h = makeHandler();
    const a = await session(h);
    const b = await session(h);
    await chat(h, a.token, { conversationId: "conv_shared_01" });
    expect((await history(h, b.token, "conv_shared_01")).json()).toEqual({ messages: [] });
    const [, readB] = ccp.routes("history").length ? [null, ccp.routes("history").at(-1)!] : [];
    const edgeB = (await verifyVisitorToken(VISITOR_SECRET, b.token))?.es;
    expect(readB!.headers["x-dewee-webchat-session"]).toBe(edgeB);
    // B's history never names A in any way the browser could change
    expect(JSON.stringify(readB!.body)).not.toContain(a.visitorId);
  });

  it("refuses gateway credential headers from the browser", async () => {
    const h = makeHandler();
    const s = await session(h);
    const r = await chat(h, s.token, {}, { "x-dewee-gateway-url": "https://evil.example", "x-dewee-gateway-token": "t" });
    expect(r.status).toBe(400);
    expect(ccp.routes("chat")).toHaveLength(0);
  });
});

describe("ccp transport: refusals and failures", () => {
  it("answers 401 to a forged or expired visitor token without calling CCP", async () => {
    const h = makeHandler();
    const s = await session(h);
    const before = ccp.seen.length;
    const [body, sig] = s.token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ v: "attacker_visitor", exp: Date.now() + 1e6 })).toString("base64url")}.${sig}`;
    expect((await chat(h, forged)).status).toBe(401);
    expect((await chat(h, `${body}.AAAA`)).status).toBe(401);
    const { signVisitorToken } = await import("../src/server/security");
    const expired = await signVisitorToken(VISITOR_SECRET, { v: s.visitorId, exp: Date.now() - 1 });
    expect((await chat(h, expired)).status).toBe(401);
    expect((await history(h, expired)).status).toBe(401);
    expect(ccp.seen.length).toBe(before);
  });

  it("maps a wrong or revoked integration secret to a redacted not_configured", async () => {
    const h = makeHandler();
    const s = await session(h);
    ccp.state.secrets.clear(); // revoked
    const r = await quiet(() => chat(h, s.token));
    expect(r.status).toBe(500);
    expect(r.json()).toEqual({ error: { message: "Chat is not configured on this server", code: "not_configured" } });
    const cfg = await quiet(() => makeHandler()(new Request(`${BASE}/config`)));
    expect(cfg.status).toBe(500);
    expect(cfg.text).not.toContain("integration_unauthorized");
  });

  it.each([
    [403, "integration_disabled", 503, "unavailable"],
    [403, "workspace_unavailable", 503, "unavailable"],
    [403, "agent_unavailable", 503, "unavailable"],
    [403, "agent_not_allowed", 403, "agent_not_allowed"],
    [403, "origin_not_allowed", 403, "forbidden_origin"],
    [409, "run_in_progress", 409, "run_in_progress"],
    [413, "message_too_large", 413, "too_long"],
    [429, "rate_limited", 429, "RATE_LIMITED"],
    [429, "concurrency_limited", 429, "RATE_LIMITED"],
    [400, "invalid_request", 400, "bad_request"],
    [502, "upstream_failed", 502, "gateway_error"],
    [503, "ingress_unavailable", 502, "gateway_error"],
    [500, "weird_internal_code", 502, "gateway_error"],
  ])("maps CCP %i %s to browser %i %s without CCP's text", async (status, code, browserStatus, browserCode) => {
    const h = makeHandler();
    const s = await session(h);
    ccp.state.failNext.set("chat", { status, code, retryAfter: status === 429 ? 30 : undefined });
    const r = await quiet(() => chat(h, s.token));
    expect(r.status).toBe(browserStatus);
    expect(r.json().error.code).toBe(browserCode);
    expect(r.text).not.toMatch(/postgres|tenant|runtime|internal/);
    if (status === 429) {
      expect(r.headers.get("retry-after")).toBe("30");
      expect(r.json()).toEqual({ error: { message: "Too many messages, please wait a moment.", code: "RATE_LIMITED", retryAfterMs: 30_000 } });
    }
  });

  it("answers a refused message as the typed admission refusal the widget understands, with fixed text", async () => {
    const h = makeHandler();
    const s = await session(h);
    // No Retry-After from CCP: the widget still gets a bounded cooldown.
    ccp.state.failNext.set("chat", { status: 429, code: "rate_limited", message: "bucket wid=0193 at https://runtime.internal" });
    const limited = await quiet(() => chat(h, s.token));
    expect(limited.status).toBe(429);
    expect(limited.json()).toEqual({ error: { message: "Too many messages, please wait a moment.", code: "RATE_LIMITED", retryAfterMs: 5000 } });
    expect(limited.headers.get("retry-after")).toBe("5");
    // A policy refusal, should CCP send one, is typed and carries no CCP text.
    ccp.state.failNext.set("chat", { status: 403, code: "POLICY_DENIED", message: "blocked by rule 0193" });
    const denied = await quiet(() => chat(h, s.token));
    expect(denied.status).toBe(403);
    expect(denied.json()).toEqual({ error: { message: "This message can't be sent.", code: "POLICY_DENIED" } });
    // A rate refusal at /session is not a message refusal and keeps its own code.
    ccp.state.failNext.set("session", { status: 429, code: "rate_limited", retryAfter: 9 });
    const opened = await quiet(() => h(new Request(`${BASE}/session`, { method: "POST", body: "{}" })));
    expect([opened.status, opened.json().error.code, opened.headers.get("retry-after")]).toEqual([429, "rate_limited", "9"]);
  });

  it("ends a run CCP rate-limits mid-stream with the typed admission event", async () => {
    const h = makeHandler();
    const s = await session(h);
    const r = await chat(h, s.token, { message: "please midlimit" });
    expect(sse(r.text).at(-1)).toEqual({ type: "error", code: "RATE_LIMITED", message: "Too many messages, please wait a moment.", retryAfterMs: 5000 });
    expect(r.text).not.toMatch(/wid=|runtime\.internal/);
  });

  it("refuses an agent outside the integration's set (CCP decides) and a malformed one locally", async () => {
    const h = makeHandler();
    const s = await session(h);
    const r = await chat(h, s.token, { agent: "admin-agent" });
    expect(r.status).toBe(403);
    expect(r.json().error.code).toBe("agent_not_allowed");
    expect(ccp.routes("chat")).toHaveLength(1);
    // Not an agent key the ingress accepts: refused here, CCP is not asked.
    for (const agent of ["../../tenant", "agent:shop", "-shop", "a".repeat(101)]) {
      const bad = await chat(h, s.token, { agent });
      expect([agent, bad.status, bad.json().error.code]).toEqual([agent, 400, "bad_request"]);
      expect((await history(h, s.token, "conv_ccp_0001", encodeURIComponent(agent))).status).toBe(400);
    }
    expect(ccp.routes("chat")).toHaveLength(1);
    expect(ccp.routes("history")).toHaveLength(0);
    // The longest key the ingress accepts reaches it.
    expect((await chat(h, s.token, { agent: "a".repeat(100) })).status).toBe(403);
    expect(ccp.routes("chat")).toHaveLength(2);
  });

  it("replaces a failed run's message with its own text", async () => {
    const h = makeHandler();
    const s = await session(h);
    const events = sse((await chat(h, s.token, { message: "please fail" })).text);
    expect(events.at(-1)).toEqual({ type: "error", code: "run_failed", message: "The agent could not answer, please try again" });
  });

  it("answers 502 when CCP is unreachable", async () => {
    const port = Number(new URL(ccp.origin).port);
    const dead = `http://127.0.0.1:1/api/public/webchat/v1/${INTEGRATION_ID}`;
    expect(port).toBeGreaterThan(1);
    const h = makeHandler({ ccp: { chatUrl: dead, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET } });
    const r = await quiet(() => h(new Request(`${BASE}/session`, { method: "POST", body: "{}" })));
    expect(r.status).toBe(502);
    expect(r.json()).toEqual({ error: { message: "Dewee is unavailable, try again later", code: "gateway_error" } });
  });

  it("refreshes an expired edge session and retries once; opens a new one when it is invalid", async () => {
    const h = makeHandler();
    const s = await session(h);
    ccp.state.failNext.set("chat", { status: 401, code: "ingress_session_expired" });
    expect(sse((await chat(h, s.token)).text).at(-1)?.type).toBe("done");
    const refresh = ccp.routes("session").at(-1)!;
    expect(refresh.headers["x-dewee-webchat-session"]).toMatch(/^dws1\./);
    expect(ccp.routes("chat")).toHaveLength(2);

    ccp.state.failNext.set("chat", { status: 401, code: "ingress_session_invalid" });
    expect(sse((await chat(h, s.token)).text).at(-1)?.type).toBe("done");
    expect(ccp.routes("session").at(-1)!.body).toEqual({ visitor_id: s.visitorId });
  });

  it("uses a sealed edge session that is already past its expiry only to refresh it", async () => {
    const h = makeHandler();
    const { signVisitorToken } = await import("../src/server/security");
    const stale = mintEdge("visitor_stale_01", -10);
    const token = await signVisitorToken(VISITOR_SECRET, { v: "visitor_stale_01", exp: Date.now() + 60_000, es: stale, ese: Date.now() - 10_000 });
    expect(sse((await chat(h, token)).text).at(-1)?.type).toBe("done");
    expect(ccp.routes("session")[0].headers["x-dewee-webchat-session"]).toBe(stale);
    expect(ccp.routes("chat")[0].headers["x-dewee-webchat-session"]).not.toBe(stale);
  });

  it("never follows a redirect, so the secret cannot reach another origin", async () => {
    const trap = await startTrap();
    try {
      const h = makeHandler();
      const s = await session(h);
      ccp.state.redirectTo = trap.url;
      const r = await quiet(() => chat(h, s.token));
      expect(r.status).toBe(502);
      expect(r.json().error.code).toBe("gateway_error");
      expect(trap.hits).toHaveLength(0);
    } finally {
      await trap.close();
    }
  });

  it("cancels the CCP request and aborts the run when the browser goes away", async () => {
    const h = createDeweeHandler({ ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET }, secret: VISITOR_SECRET, rateLimit: false });
    const s = (await (await h(new Request(`${BASE}/session`, { method: "POST", body: "{}" }))).json()) as { token: string };
    const browser = new AbortController();
    const res = await h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify({ message: "go slow", conversationId: "conv_abort_01" }), signal: browser.signal }));
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"type":"start"');
    browser.abort();
    await vi.waitFor(() => {
      expect(ccp.routes("chat")[0].closedEarly).toBe(true);
      expect(ccp.routes("abort")).toHaveLength(1);
    });
    expect(ccp.routes("abort")[0].body).toEqual({ conversation_id: "conv_abort_01", run_id: "run-42" });
    reader.cancel().catch(() => {});
  });
});

describe("ccp transport: the website's own guards stay", () => {
  it("refuses a foreign browser origin before calling CCP", async () => {
    const h = makeHandler({ allowedOrigins: ["https://ok.example"] });
    const r = await h(new Request(`${BASE}/config`, { headers: { origin: "https://evil.example" } }));
    expect(r.status).toBe(403);
    expect(r.json().error.code).toBe("forbidden_origin");
    expect(ccp.seen).toHaveLength(0);
  });

  it("rate-limits messages per visitor with the default limiter", async () => {
    const h = makeHandler({ rateLimit: undefined });
    const s = await session(h);
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await chat(h, s.token)).status);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
    expect(ccp.routes("chat")).toHaveLength(20);
  });

  it("enforces the smaller message limit locally", async () => {
    ccp.state.config = { ...ccp.state.config, max_message_chars: 10 };
    const h = makeHandler();
    const s = await session(h);
    const r = await chat(h, s.token, { message: "x".repeat(11) });
    expect(r.status).toBe(413);
    expect(ccp.routes("chat")).toHaveLength(0);
  });
});

describe("ccp transport: secret hygiene", () => {
  it("never sends the integration secret, edge session, CCP URL or runtime details to a browser", () => {
    const all = browserOutput.join("\n");
    expect(all.length).toBeGreaterThan(1000);
    for (const needle of [INTEGRATION_SECRET, "dwc_", "dws1.", ccp.origin, "127.0.0.1", "/api/public/webchat", "session_key", "tenant", "postgres", "runtime.internal"]) {
      expect(all, needle).not.toContain(needle);
    }
  });
});

describe("sealed edge session claim", () => {
  it("round-trips, binds to the visitor and refuses tampering", async () => {
    const { signVisitorToken } = await import("../src/server/security");
    const es = mintEdge("visitor_seal_01", 3600);
    const t = await signVisitorToken(VISITOR_SECRET, { v: "visitor_seal_01", exp: Date.now() + 60_000, es, ese: 123 });
    expect(await verifyVisitorToken(VISITOR_SECRET, t)).toEqual({ v: "visitor_seal_01", exp: expect.any(Number), es, ese: 123 });
    const wire = JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString());
    expect(wire.es).not.toContain("dws1");
    // Moving the sealed value to another visitor (even with a valid signature) fails to open.
    const moved = await signVisitorToken(VISITOR_SECRET, { v: "visitor_other1", exp: Date.now() + 60_000 });
    const movedWire = { ...JSON.parse(Buffer.from(moved.split(".")[0], "base64url").toString()), es: wire.es, ese: 1 };
    const { createHmac } = await import("node:crypto");
    const body = Buffer.from(JSON.stringify(movedWire)).toString("base64url");
    const sig = createHmac("sha256", VISITOR_SECRET).update(body).digest("base64url");
    expect(await verifyVisitorToken(VISITOR_SECRET, `${body}.${sig}`)).toBeNull();
    // es without ese, or ese without es, is refused
    const half = Buffer.from(JSON.stringify({ v: "visitor_seal_01", exp: Date.now() + 60_000, ese: 1 })).toString("base64url");
    expect(await verifyVisitorToken(VISITOR_SECRET, `${half}.${createHmac("sha256", VISITOR_SECRET).update(half).digest("base64url")}`)).toBeNull();
    // identity and edge claims together
    const both = await signVisitorToken(VISITOR_SECRET, { v: "visitor_seal_01", exp: Date.now() + 60_000, ids: "idsess_1", ida: "shop", sub: "digest", es, ese: 5 });
    expect(await verifyVisitorToken(VISITOR_SECRET, both)).toMatchObject({ ids: "idsess_1", ida: "shop", sub: "digest", es, ese: 5 });
  });
});
