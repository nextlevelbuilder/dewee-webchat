// The browser contract every host must keep over `transport: "ccp"`: /api/dewee/{config,session,chat,
// history}, SSE, refresh, expired and forged tokens, origins, agents, limits and secret hygiene.
// Shared by the Astro Node and Next.js suites; checks that need the fake ingress's failure switches
// run against the fake only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { signVisitorToken } from "dewee-webchat/server";
import { expect, it } from "vitest";
import { browser, nextIp, servedScripts, sseEvents, type Browser } from "../src/browser";
import type { Host } from "../src/hosts";
import { PARTNER_ORIGIN, STAGING, VISITOR_SECRET, type Target } from "../src/target";

/** Text that marks a leak: CCP internals the fake puts in its error messages, raw edge sessions, the ingress path. */
const LEAK_MARKERS = ["postgres://internal-db", "runtime.internal", "dws1.", "/api/public/webchat", "secret plan", "internal rows"];
/** Legacy Gateway configuration must not appear anywhere on the CCP path. */
const GATEWAY_MARKERS = ["DEWEE_GATEWAY_TOKEN", "DEWEE_GATEWAY_URL", "GOCLAW_GATEWAY", "dewee.zuey.me"];
const KNOWN_CCP_ROUTES = new Set(["config", "session", "chat", "history", "abort", "identity/exchange", "identity/revoke", "link", "job-access"]);

export interface ContractContext {
  host: Host;
  target: Target;
  /** Built client files of the host (scanned for secrets). */
  clientDir: string;
  /** Browser output collected by host-specific tests too. */
  outputs: Browser[];
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

export function ccpContract(ctx: () => ContractContext): void {
  const open = (opts: { origin?: string } = {}) => {
    const c = ctx();
    const b = browser(c.host.origin, { origin: opts.origin ?? c.target.visitorOrigin });
    c.outputs.push(b);
    return b;
  };
  const newSession = async (b: Browser) => {
    const res = await b.request("/api/dewee/session", { body: {} });
    expect(res.status, res.text).toBe(200);
    return res.json() as { visitorId: string; token: string; expiresIn: number; verified?: boolean };
  };
  const fake = () => ctx().target.fake!;

  it("config: the integration's agents and limits, nothing secret", async () => {
    const res = await open().request("/api/dewee/config");
    expect(res.status).toBe(200);
    const cfg = res.json();
    expect(cfg.agents.length).toBeGreaterThan(0);
    expect(typeof cfg.defaultAgent).toBe("string");
    expect(cfg.maxMessageLength).toBeGreaterThan(0);
    expect(cfg.allowClientCredentials).toBe(false);
    expect(res.text).not.toMatch(/secret|wci_|dwc_/i);
  });

  it("session: a sealed visitor token; refresh keeps the same visitor", async () => {
    const b = open();
    const s = await newSession(b);
    expect(s.expiresIn).toBeGreaterThan(0);
    expect(s.token).not.toContain("dws1.");
    const again = await b.request("/api/dewee/session", { body: { token: s.token } });
    expect(again.status).toBe(200);
    expect(again.json().visitorId).toBe(s.visitorId);
    if (!STAGING) {
      const call = fake().routes("session").at(-1)!;
      expect(call.headers.authorization).toBe(`Bearer ${ctx().target.env.DEWEE_WEBCHAT_INTEGRATION_SECRET}`);
      expect(call.headers["x-dewee-visitor-origin"]).toBe(ctx().target.visitorOrigin);
      expect(call.headers["x-dewee-visitor-ip"]).toBeDefined();
    }
  });

  it("chat streams SSE end to end, and history returns the turn", async () => {
    const b = open();
    const { token } = await newSession(b);
    if (!STAGING) fake().state.leaky = true; // CCP frames a public widget must never forward
    const res = await b
      .request("/api/dewee/chat", { token, body: { message: "Xin chào", conversationId: "conv_smoke_0001" } })
      .finally(() => !STAGING && (fake().state.leaky = false));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = sseEvents(res.text);
    expect(events[0].type).toBe("start");
    expect(events.at(-1)!.type).toBe("done");
    expect(events.some((e) => e.type === "error")).toBe(false);
    if (!STAGING) {
      expect(events.map((e) => e.type)).toEqual(["start", "delta", "done"]);
    }
    const history = await b.request("/api/dewee/history?conversationId=conv_smoke_0001", { token });
    expect(history.status).toBe(200);
    const messages = history.json().messages as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.role === "user" && m.content === "Xin chào")).toBe(true);
    expect(messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });

  it("expired, forged and missing visitor tokens are 401", async () => {
    const b = open();
    const { token, visitorId } = await newSession(b);
    const expired = await signVisitorToken(VISITOR_SECRET, { v: visitorId, exp: Date.now() - 1_000 });
    const forged = await signVisitorToken("another-secret-of-at-least-32-characters", { v: visitorId, exp: Date.now() + 60_000 });
    for (const bad of [expired, forged, `${token.slice(0, -2)}xx`, undefined]) {
      const chat = await b.request("/api/dewee/chat", { token: bad, body: { message: "hi" } });
      expect(chat.status).toBe(401);
      expect(chat.json().error.code).toBe("unauthorized");
      const history = await b.request("/api/dewee/history?conversationId=conv_smoke_0001", { token: bad });
      expect(history.status).toBe(401);
    }
  });

  it("unknown routes and methods are 404", async () => {
    const b = open();
    for (const [path, method] of [["/api/dewee/nope", "GET"], ["/api/dewee/chat", "GET"], ["/api/dewee/config", "POST"]] as const) {
      const res = await b.request(path, { method, ...(method === "POST" ? { body: {} } : {}) });
      expect(res.status).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
  });

  it("origins: a foreign site is refused, an allowed one gets CORS", async () => {
    const evil = open({ origin: "https://evil.example" });
    const refused = await evil.request("/api/dewee/session", { body: {} });
    expect(refused.status).toBe(403);
    expect(refused.json().error.code).toBe("forbidden_origin");
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    const partner = open({ origin: PARTNER_ORIGIN });
    const preflight = await partner.request("/api/dewee/session", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(PARTNER_ORIGIN);
    const cfg = await partner.request("/api/dewee/config");
    expect(cfg.status).toBe(200);
    expect(cfg.headers.get("access-control-allow-origin")).toBe(PARTNER_ORIGIN);
  });

  it("agents: only the integration's agents; malformed keys are refused locally", async () => {
    const b = open();
    const { token } = await newSession(b);
    const outsider = await b.request("/api/dewee/chat", { token, body: { message: "hi", agent: "not-in-this-integration" } });
    expect(outsider.status).toBe(403);
    expect(outsider.json().error.code).toBe("agent_not_allowed");
    const malformed = await b.request("/api/dewee/chat", { token, body: { message: "hi", agent: "bad agent!" } });
    expect(malformed.status).toBe(400);
  });

  it("limits: message length and new sessions per address", async () => {
    const b = open();
    const { token } = await newSession(b);
    const long = await b.request("/api/dewee/chat", { token, body: { message: "x".repeat(4001) } });
    expect(long.status).toBe(413);
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await b.request("/api/dewee/session", { body: {}, ip })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it.skipIf(STAGING)("CCP refusals become typed answers without CCP's own text", async () => {
    const b = open();
    fake().state.failNext.set("session", { status: 503, code: "integration_disabled" });
    const paused = await b.request("/api/dewee/session", { body: {} });
    expect(paused.status).toBe(503);
    expect(paused.json().error.code).toBe("unavailable");

    const { token } = await newSession(b);
    fake().state.failNext.set("chat", { status: 429, code: "rate_limited", retryAfter: 7 });
    const limited = await b.request("/api/dewee/chat", { token, body: { message: "hi" } });
    expect(limited.status).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");

    const failed = sseEvents((await b.request("/api/dewee/chat", { token, body: { message: "please fail" } })).text);
    expect(failed.at(-1)).toMatchObject({ type: "error", code: "run_failed" });

    fake().state.secrets.clear(); // the integration secret was revoked or rotated away
    const revoked = await b
      .request("/api/dewee/session", { body: {} })
      .finally(() => fake().state.secrets.add(ctx().target.env.DEWEE_WEBCHAT_INTEGRATION_SECRET));
    expect(revoked.status).toBe(500);
    expect(revoked.json().error.code).toBe("not_configured");
  });

  it.skipIf(STAGING)("an expired edge session is refreshed through /session", async () => {
    const b = open();
    fake().state.edgeTtlSeconds = 1;
    const first = await newSession(b).finally(() => (fake().state.edgeTtlSeconds = 3600));
    await new Promise((r) => setTimeout(r, 1_500));
    const refreshes = fake().routes("session").length;
    const second = await b.request("/api/dewee/session", { body: { token: first.token } });
    expect(second.json().visitorId).toBe(first.visitorId);
    const refresh = fake().routes("session").slice(refreshes);
    expect(refresh.some((r) => typeof r.headers["x-dewee-webchat-session"] === "string")).toBe(true);
    const chat = await b.request("/api/dewee/chat", { token: second.json().token, body: { message: "after refresh" } });
    expect(sseEvents(chat.text).at(-1)!.type).toBe("done");
  });

  it("nothing secret reached the browser, the page or the logs; no Gateway on the path", async () => {
    const c = ctx();
    const served = await servedScripts(c.host.origin);
    const built = filesUnder(c.clientDir).filter((f) => /\.(m?js|css|html)$/.test(f)).map((f) => readFileSync(f, "utf8"));
    const browserSide = [...c.outputs.flatMap((b) => b.received), ...served, ...built].join("\n");
    expect(browserSide.length).toBeGreaterThan(0);
    for (const s of c.target.secrets) {
      expect(browserSide).not.toContain(s);
      expect(c.host.logs()).not.toContain(s);
    }
    for (const marker of [...LEAK_MARKERS, ...GATEWAY_MARKERS]) expect(browserSide).not.toContain(marker);
    if (!STAGING) {
      expect(fake().seen.length).toBeGreaterThan(0);
      expect(fake().seen.every((r) => KNOWN_CCP_ROUTES.has(r.route))).toBe(true);
    }
  });
}
