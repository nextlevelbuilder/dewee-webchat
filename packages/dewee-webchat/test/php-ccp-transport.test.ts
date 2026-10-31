// php/dewee-webchat.php with transport "ccp" (anonymous visitors only), against the same fake CCP
// ingress as the TS tests: transport selection, visitor token interop with the TS handler, the browser
// contract next to the TS handler's answers, error mapping and redaction, redirect refusal, timeout
// abort. Runs when a PHP 8.1+ binary is available (PHP_BIN or `php` on PATH); skipped otherwise.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "../src/protocol";
import { createDeweeHandler, signVisitorToken, verifyVisitorToken } from "../src/server";
import { INTEGRATION_ID, INTEGRATION_SECRET, mintEdge, startFakeCcp, startTrap, type FakeCcp } from "./helpers/fake-ccp-ingress";

const PHP = process.env.PHP_BIN || "php";
const hasPhp = spawnSync(PHP, ["-v"]).status === 0;
const phpFile = resolve(__dirname, "../../../php/dewee-webchat.php");
const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";

/** Runs a PHP snippet with the backend loaded; stdin is JSON, stdout is parsed as JSON. */
function php(code: string, input: unknown = null): any {
  const dir = mkdtempSync(join(tmpdir(), "dewee-php-ccp-"));
  const file = join(dir, "case.php");
  writeFileSync(file, `<?php\nrequire ${JSON.stringify(phpFile)};\n$in = json_decode(stream_get_contents(STDIN), true);\n${code}\n`);
  return JSON.parse(execFileSync(PHP, [file], { input: JSON.stringify(input), stdio: ["pipe", "pipe", "pipe"] }).toString());
}

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });

describe.skipIf(!hasPhp)("PHP ccp transport", () => {
  let ccp: FakeCcp;
  let server: ChildProcess;
  let dir: string;
  let base: string;
  const browserOutput: string[] = [];
  const ccpOptions = () => ({ chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET });
  /**
   * The PHP endpoint reads its options from the file a test header names. Each change is a new file:
   * a rewritten file can be seen stale through a container's bind mount.
   */
  let optionsFile = "";
  let optionsSeq = 0;
  const setOptions = (extra: Record<string, unknown> = {}) => {
    optionsFile = `options-${++optionsSeq}.json`;
    writeFileSync(join(dir, optionsFile), JSON.stringify({ ccp: ccpOptions(), secret: VISITOR_SECRET, rateLimit: false, ...extra }));
  };
  /** The integration config is cached for a minute in a private temp dir; tests that change it drop the cache. */
  const dropConfigCache = () => spawnSync("sh", ["-c", `rm -f ${JSON.stringify(dir)}/tmp/dewee-webchat-*/ccp-config-*`]);
  /** The private cache directory (`dewee-webchat-<uid>`) the PHP server created, if any. */
  const cacheDirs = () => readdirSync(join(dir, "tmp")).filter((n) => /^dewee-webchat-\d+$/.test(n)).map((n) => join(dir, "tmp", n));

  async function call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), "x-test-options": optionsFile } });
    const text = await res.text();
    browserOutput.push(text, JSON.stringify(Object.fromEntries(res.headers)));
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  }
  const session = async (body: unknown = {}) => (await call("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const chat = (token: string, body: Record<string, unknown> = {}) =>
    call("/chat", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ message: "hi", conversationId: "conv_php_0001", ...body }) });
  const sse = (text: string): ChatStreamEvent[] => text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));

  beforeAll(async () => {
    ccp = await startFakeCcp();
    dir = mkdtempSync(join(tmpdir(), "dewee-php-srv-"));
    spawnSync("mkdir", [join(dir, "tmp")]);
    writeFileSync(
      join(dir, "router.php"),
      `<?php\nrequire ${JSON.stringify(phpFile)};\n$f = basename((string) ($_SERVER['HTTP_X_TEST_OPTIONS'] ?? ''));\n$o = preg_match('/^options-\\d+\\.json$/', $f) ? json_decode((string) file_get_contents(__DIR__ . '/' . $f), true) : null;\nif (!is_array($o)) { http_response_code(599); exit; }\nDeweeWebchat::handle($o);\n`,
    );
    setOptions();
    const port = await freePort();
    base = `http://127.0.0.1:${port}/api/dewee`;
    server = spawn(PHP, ["-d", `sys_temp_dir=${join(dir, "tmp")}`, "-d", "log_errors=1", "-d", "error_log=/dev/null", "-S", `127.0.0.1:${port}`, join(dir, "router.php")], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("PHP server did not start");
  }, 30_000);
  afterAll(async () => {
    server?.kill("SIGTERM");
    await ccp?.close();
  });
  beforeEach(() => {
    ccp.reset();
    setOptions();
    dropConfigCache();
  });

  it("selects the transport explicitly and refuses conflicting or unsafe options", () => {
    const url = `http://127.0.0.1:1/api/public/webchat/v1/${INTEGRATION_ID}`;
    const ok = { chatUrl: url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET };
    const cases: Array<Record<string, unknown>> = [
      { ccp: ok, secret: VISITOR_SECRET },
      { ccp: ok, secret: VISITOR_SECRET, gatewayUrl: "https://gw.example", token: "gw-token" },
      { ccp: ok, secret: VISITOR_SECRET, transport: "legacy-gateway" },
      { ccp: ok, secret: VISITOR_SECRET, transport: "websocket" },
      { transport: "ccp", gatewayUrl: "https://gw.example", token: "t" },
      { ccp: ok, secret: "short" },
      { ccp: ok, secret: VISITOR_SECRET, agents: ["shop"] },
      { ccp: ok, secret: VISITOR_SECRET, identity: { required: true } },
      { ccp: { ...ok, chatUrl: `http://ccp.example.com/api/public/webchat/v1/${INTEGRATION_ID}` }, secret: VISITOR_SECRET },
      { ccp: { ...ok, chatUrl: `https://ccp.example.com/api/public/webchat/v1/wci_bcdefghijklmnopqrstuvwxyza` }, secret: VISITOR_SECRET },
      { ccp: { ...ok, integrationSecret: "sk-gateway-token" }, secret: VISITOR_SECRET },
      { ccp: { ...ok, chatUrl: `${url}?x=1` }, secret: VISITOR_SECRET },
      { gatewayUrl: "https://gw.example", token: "t", secret: VISITOR_SECRET },
      { gatewayUrl: "https://gw.example", token: "t" },
      { gatewayUrl: "https://gw.example", token: "t", secret: "short" },
    ];
    const out = php(
      `$r = [];
foreach ($in as $o) {
  try { $r[] = DeweeWebchat::resolveTransport($o) . ($o['ccp'] ?? null ? '|' . DeweeCcpClient::fromOptions($o['ccp'])->base : ''); }
  catch (DeweeConfigError $e) { $r[] = 'refused: ' . $e->getMessage(); }
}
echo json_encode($r);`,
      cases,
    );
    expect(out[0]).toBe(`ccp|${url}`);
    expect(out[1]).toMatch(/refused: .*both CCP and gateway options are set \(gatewayUrl, token\)/);
    expect(out[2]).toMatch(/refused: .*legacy-gateway" is set together with ccp options/);
    expect(out[3]).toMatch(/refused: .*transport must be/);
    expect(out[4]).toMatch(/refused: .*needs ccp options/);
    expect(out[5]).toMatch(/refused: .*at least 32 bytes/);
    expect(out[6]).toMatch(/refused: .*agents does not apply/);
    expect(out[7]).toMatch(/refused: .*no signed-in \(identity\) mode/);
    expect(out[8]).toMatch(/refused: .*must use https/);
    expect(out[9]).toMatch(/refused: .*does not match/);
    expect(out[10]).toMatch(/refused: .*dwc_ secret/);
    expect(out[11]).toMatch(/refused: .*query or fragment/);
    expect(out[12]).toBe("legacy-gateway");
    expect(out[13]).toMatch(/refused: .*legacy-gateway transport needs secret .* at least 32 bytes/);
    expect(out[14]).toMatch(/refused: .*legacy-gateway transport needs secret .* at least 32 bytes/);
    expect(out.join("\n")).not.toContain(INTEGRATION_SECRET);
  });

  it("reads the CCP variables from the environment", () => {
    const env = { DEWEE_CCP_CHAT_URL: "https://ccp.example/x", DEWEE_WEBCHAT_INTEGRATION_ID: INTEGRATION_ID, DEWEE_WEBCHAT_INTEGRATION_SECRET: INTEGRATION_SECRET, DEWEE_WEBCHAT_TRANSPORT: "ccp" };
    const o = php(`$o = DeweeWebchat::optionsFromEnv($in); echo json_encode(['t' => $o['transport'], 'ccp' => $o['ccp'], 'none' => DeweeWebchat::optionsFromEnv([])['ccp']]);`, env);
    expect(o).toEqual({ t: "ccp", ccp: { chatUrl: env.DEWEE_CCP_CHAT_URL, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET }, none: null });
  });

  it("answers a misconfigured backend with not_configured and no detail", async () => {
    setOptions({ gatewayUrl: "https://gw.example", token: "gw-token-NEVER-IN-BROWSER" });
    const r = await call("/config");
    expect([r.status, r.json()]).toEqual([500, { error: { message: "Chat is not configured on this server", code: "not_configured" } }]);
    expect(ccp.seen).toHaveLength(0);
  });

  it("shares the visitor token format with the TS handler, edge session sealed", async () => {
    const out = php(
      `$t = DeweeWebchat::signVisitorToken($in['secret'], ['v' => 'visitor_0001', 'exp' => $in['exp'], 'es' => 'dws1.php.token', 'ese' => $in['exp']]);
echo json_encode(['token' => $t, 'fromTs' => DeweeWebchat::verifyVisitorToken($in['secret'], $in['ts']), 'withIds' => DeweeWebchat::verifyVisitorToken($in['secret'], $in['ids'])]);`,
      {
        secret: VISITOR_SECRET,
        exp: Date.now() + 60_000,
        ts: await signVisitorToken(VISITOR_SECRET, { v: "visitor_0002", exp: Date.now() + 60_000, es: "dws1.ts.token", ese: 1234 }),
        ids: await signVisitorToken(VISITOR_SECRET, { v: "visitor_0003", exp: Date.now() + 60_000, ids: "idsess_x", ida: "shop" }),
      },
    );
    expect(Buffer.from(out.token.split(".")[0], "base64url").toString()).not.toContain("dws1.");
    expect(await verifyVisitorToken(VISITOR_SECRET, out.token)).toMatchObject({ v: "visitor_0001", es: "dws1.php.token" });
    expect(out.fromTs).toMatchObject({ v: "visitor_0002", es: "dws1.ts.token", ese: 1234 });
    // A signed-in token is never downgraded to an anonymous visitor by a backend without identity mode.
    expect(out.withIds).toBeNull();
  });

  it("matches the TS handler for config, session, stream and history", async () => {
    const ts = createDeweeHandler({ ccp: ccpOptions(), secret: VISITOR_SECRET, rateLimit: false });
    const tsJson = async (path: string, init?: RequestInit) => (await ts(new Request(`https://shop.example/api/dewee${path}`, init))).json();

    const { version: _v, ...tsConfig } = await tsJson("/config");
    expect((await call("/config")).json()).toEqual({ ...tsConfig, version: "0.4.0" });

    const s = await session();
    expect(s.visitorId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ccp.routes("session")[0].body).toEqual({ visitor_id: s.visitorId });
    const claims = await verifyVisitorToken(VISITOR_SECRET, s.token);
    expect(claims?.es).toMatch(/^dws1\./);
    // Refreshing keeps the visitor and reuses the still-fresh edge session.
    const again = await session({ token: s.token });
    expect(again.visitorId).toBe(s.visitorId);
    expect(ccp.routes("session")).toHaveLength(1);

    const r = await chat(s.token, { agent: "shop" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/event-stream/);
    const phpEvents = sse(r.text);
    const sent = ccp.routes("chat")[0];
    expect(sent.body).toEqual({ message: "hi", conversation_id: "conv_php_0001", agent: "shop" });
    expect(sent.headers["x-dewee-webchat-session"]).toBe(claims?.es);
    expect(sent.headers["x-request-id"]).toMatch(/^dwc-/);

    const tsSession = await tsJson("/session", { method: "POST", body: "{}" });
    const tsEvents = sse(await (await ts(new Request("https://shop.example/api/dewee/chat", { method: "POST", headers: { authorization: `Bearer ${tsSession.token}` }, body: JSON.stringify({ message: "hi", conversationId: "conv_php_0002", agent: "shop" }) }))).text());
    const norm = (evs: ChatStreamEvent[]) => evs.map((e) => JSON.parse(JSON.stringify(e).replace(/wcv:[^"]+/g, "ACTOR").replace(/conv_php_000\d/g, "CONV")));
    expect(norm(phpEvents)).toEqual(norm(tsEvents));
    expect(phpEvents.map((e) => e.type)).toEqual(["start", "delta", "done"]);

    const h = await call(`/history?agent=shop&conversationId=conv_php_0001`, { headers: { authorization: `Bearer ${s.token}` } });
    expect(h.json()).toEqual({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: `hello wcv:${INTEGRATION_ID}:${s.visitorId}` }] });
    // Another visitor never sees this conversation.
    const other = await session();
    expect((await call(`/history?agent=shop&conversationId=conv_php_0001`, { headers: { authorization: `Bearer ${other.token}` } })).json()).toEqual({ messages: [] });
    // A browser-valid id that CCP cannot hold has no conversation yet.
    expect((await call(`/history?conversationId=short1`, { headers: { authorization: `Bearer ${s.token}` } })).json()).toEqual({ messages: [] });
  });

  it("refuses an agent name the ingress would not accept locally, without asking CCP", async () => {
    const s = await session();
    const before = { chat: ccp.routes("chat").length, history: ccp.routes("history").length };
    for (const agent of ["../../tenant", "agent:shop", "-shop", "a".repeat(101), "shop\n"]) {
      const r = await chat(s.token, { agent });
      expect([agent, r.status, r.json().error.code]).toEqual([agent, 400, "bad_request"]);
      const h = await call(`/history?agent=${encodeURIComponent(agent)}&conversationId=conv_php_0001`, { headers: { authorization: `Bearer ${s.token}` } });
      expect(h.status).toBe(400);
    }
    expect([ccp.routes("chat").length, ccp.routes("history").length]).toEqual([before.chat, before.history]);
    expect((await chat(s.token, { agent: "a".repeat(100) })).status).toBe(403); // reaches CCP, which decides
    expect(ccp.routes("chat")).toHaveLength(before.chat + 1);
  });

  it("shows reasoning and tool names only when the integration does, never tool arguments", async () => {
    const s = await session();
    ccp.state.leaky = true;
    expect(sse((await chat(s.token)).text).map((e) => e.type)).toEqual(["start", "delta", "done"]);
    ccp.state.config = { ...ccp.state.config, show_thinking: true, show_tool_activity: true };
    dropConfigCache();
    const events = sse((await chat(s.token, { conversationId: "conv_php_0003" })).text);
    expect(events.map((e) => e.type)).toEqual(["start", "thinking", "tool_call", "tool_result", "delta", "done"]);
    expect(events[2]).toEqual({ type: "tool_call", id: "t1", name: "search_products" });
    expect(JSON.stringify(events)).not.toContain("internal");
  });

  it("maps CCP refusals to the browser contract without CCP's text", async () => {
    const s = await session();
    const table: Array<[number, string, number, string]> = [
      [401, "integration_unauthorized", 500, "not_configured"],
      [403, "integration_disabled", 503, "unavailable"],
      [403, "origin_not_allowed", 403, "forbidden_origin"],
      [403, "agent_not_allowed", 403, "agent_not_allowed"],
      [409, "run_in_progress", 409, "run_in_progress"],
      [413, "message_too_large", 413, "too_long"],
      [429, "concurrency_limited", 429, "RATE_LIMITED"],
      [400, "invalid_request", 400, "bad_request"],
      [500, "internal", 502, "gateway_error"],
      [401, "IDENTITY_REQUIRED", 401, "IDENTITY_REQUIRED"],
    ];
    for (const [status, code, want, wantCode] of table) {
      ccp.state.failNext.set("chat", { status, code });
      const r = await chat(s.token);
      expect([code, r.status, r.json().error.code]).toEqual([code, want, wantCode]);
      expect(r.text).not.toContain("postgres");
    }
    ccp.state.failNext.set("chat", { status: 429, code: "rate_limited", retryAfter: 7 });
    const limited = await chat(s.token);
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "7"]);
    expect(limited.json()).toEqual({ error: { message: "Too many messages, please wait a moment.", code: "RATE_LIMITED", retryAfterMs: 7000 } });
    // Without a Retry-After the widget still gets a bounded cooldown; a policy refusal is typed, no CCP text.
    ccp.state.failNext.set("chat", { status: 429, code: "concurrency_limited", message: "cap wid=0193" });
    const capped = await chat(s.token);
    expect([capped.status, capped.headers.get("retry-after"), capped.json()]).toEqual([429, "5", { error: { message: "Too many messages, please wait a moment.", code: "RATE_LIMITED", retryAfterMs: 5000 } }]);
    ccp.state.failNext.set("chat", { status: 403, code: "POLICY_DENIED", message: "blocked by rule 0193" });
    const denied = await chat(s.token);
    expect([denied.status, denied.json()]).toEqual([403, { error: { message: "This message can't be sent.", code: "POLICY_DENIED" } }]);
    // A run CCP rate-limits mid-stream ends with the typed admission event, not CCP's text.
    const mid = await chat(s.token, { message: "now midlimit" });
    expect(sse(mid.text).at(-1)).toEqual({ type: "error", code: "RATE_LIMITED", message: "Too many messages, please wait a moment.", retryAfterMs: 5000 });
    expect(mid.text).not.toMatch(/wid=|runtime\.internal/);
    // A run that fails mid-stream ends with this backend's own message.
    expect(sse((await chat(s.token, { message: "now fail" })).text).at(-1)).toEqual({ type: "error", code: "run_failed", message: "The agent could not answer, please try again" });
    // A wrong or revoked integration secret: typed, redacted.
    ccp.state.secrets.clear();
    dropConfigCache();
    expect((await call("/config")).json()).toEqual({ error: { message: "Chat is not configured on this server", code: "not_configured" } });
  });

  it("refreshes an expired edge session and replaces an invalid one, once", async () => {
    ccp.state.edgeTtlSeconds = 1;
    const s = await session();
    await new Promise((r) => setTimeout(r, 1100));
    expect((await chat(s.token)).status).toBe(200);
    expect(ccp.routes("session").map((r) => r.body)).toEqual([{ visitor_id: s.visitorId }, {}]);
    ccp.state.failNext.set("chat", { status: 401, code: "ingress_session_invalid" });
    ccp.state.edgeTtlSeconds = 3600;
    expect((await chat(s.token, { conversationId: "conv_php_0004" })).status).toBe(200);
    expect(ccp.routes("session").at(-1)?.body).toEqual({ visitor_id: s.visitorId });
  });

  it("on every fresh request, refreshes a lapsed sealed edge session once at /session and keeps the visitor", async () => {
    const v = "visitor_php_aged_1";
    const edge = mintEdge(v, -7200);
    const token = await signVisitorToken(VISITOR_SECRET, { v, exp: Date.now() + 28 * 86_400_000, es: edge, ese: Date.now() - 7_200_000 });
    const s = await session({ token });
    expect(s.visitorId).toBe(v);
    expect(ccp.routes("session")).toHaveLength(1);
    expect(ccp.routes("session")[0].headers["x-dewee-webchat-session"]).toBe(edge);
    const claims = await verifyVisitorToken(VISITOR_SECRET, s.token);
    expect(claims?.es).not.toBe(edge);
    // The widget comes back before the new edge session lapses.
    expect(s.expiresAt).toBeLessThanOrEqual(claims!.ese!);
    expect(s.expiresIn).toBeGreaterThan(0);
    expect(s.expiresIn).toBeLessThanOrEqual(3_600_000);
    for (const id of ["conv_php_0101", "conv_php_0102", "conv_php_0103"]) expect((await chat(s.token, { conversationId: id })).status).toBe(200);
    expect(ccp.routes("session")).toHaveLength(1);
    // A fresh one is handed back without a CCP call.
    const again = await session({ token: s.token });
    expect([again.visitorId, ccp.routes("session").length]).toEqual([v, 1]);
  });

  it("opens one new edge session for the same visitor once the old one is past CCP's refresh window", async () => {
    const v = "visitor_php_aged_2";
    const token = await signVisitorToken(VISITOR_SECRET, { v, exp: Date.now() + 25 * 86_400_000, es: mintEdge(v, -90_000), ese: Date.now() - 90_000_000 });
    const s = await session({ token });
    expect(s.visitorId).toBe(v);
    expect(ccp.routes("session").map((r) => r.body)).toEqual([{ visitor_id: v }]);
    await chat(s.token);
    expect(ccp.routes("session")).toHaveLength(1);
  });

  it("limits returning visitors per visitor, so visitors behind one address keep the new-visitor budget", async () => {
    setOptions({ rateLimit: true });
    const headers = { "x-forwarded-for": "198.51.100.77", "content-type": "application/json" };
    for (let i = 0; i < 12; i++) {
      const v = `visitor_php_nat_${String(i).padStart(2, "0")}`;
      const token = await signVisitorToken(VISITOR_SECRET, { v, exp: Date.now() + 86_400_000, es: mintEdge(v, 3600), ese: Date.now() + 3_600_000 });
      expect((await call("/session", { method: "POST", headers, body: JSON.stringify({ token }) })).status).toBe(200);
    }
    expect((await call("/session", { method: "POST", headers, body: "{}" })).status).toBe(200);
  });

  it("caches the integration config only in a directory private to this user", async () => {
    await call("/config");
    await call("/config");
    expect(ccp.routes("config")).toHaveLength(1);
    const [cache] = cacheDirs();
    expect(cache).toBeDefined();
    // Opened to others (as another account on a shared host could have created it): not used.
    chmodSync(cache, 0o777);
    try {
      dropConfigCache();
      ccp.reset();
      await call("/config");
      await call("/config");
      expect(ccp.routes("config")).toHaveLength(2);
    } finally {
      chmodSync(cache, 0o700);
    }
  });

  it("challenges new visitors with Turnstile but lets a returning visitor refresh without one", async () => {
    setOptions({ turnstile: { siteKey: "site-key", secretKey: "turnstile-secret-NEVER-IN-BROWSER" } });
    expect((await call("/config")).json()).toMatchObject({ turnstileSiteKey: "site-key", refreshWithoutTurnstile: true });
    const fresh = await call("/session", { method: "POST", body: "{}" });
    expect([fresh.status, fresh.json().error.code]).toEqual([403, "turnstile_failed"]);
    const v = "visitor_php_turnst";
    const token = await signVisitorToken(VISITOR_SECRET, { v, exp: Date.now() + 86_400_000, es: mintEdge(v, -7200), ese: Date.now() - 7_200_000 });
    expect((await session({ token })).visitorId).toBe(v);
  });

  it("sends CCP the visitor IP only in CCP's address format", async () => {
    for (const xff of ["2001:db8::9", "evil<script>"]) await call("/session", { method: "POST", headers: { "x-forwarded-for": xff }, body: "{}" });
    expect(ccp.routes("session").map((r) => r.headers["x-dewee-visitor-ip"])).toEqual(["2001:db8::9", undefined]);
  });

  it("leaves the legacy gateway transport's /session unchanged", async () => {
    setOptions({ ccp: undefined, gatewayUrl: "https://gw.example", token: "gw-token", agents: ["shop"] });
    const s = await session();
    expect(Object.keys(s).sort()).toEqual(["expiresAt", "token", "visitorId"]);
    expect(await verifyVisitorToken(VISITOR_SECRET, s.token)).toEqual({ v: s.visitorId, exp: s.expiresAt });
    expect(s.expiresAt - Date.now()).toBeGreaterThan(29 * 86_400_000);
    // A returning visitor keeps its id, also from a token a CCP backend issued.
    const fromCcp = await signVisitorToken(VISITOR_SECRET, { v: "visitor_php_move_1", exp: Date.now() + 60_000, es: mintEdge("visitor_php_move_1", 3600), ese: Date.now() + 3_600_000 });
    expect((await session({ token: fromCcp })).visitorId).toBe("visitor_php_move_1");
    expect(ccp.seen).toHaveLength(0);
  });

  it("never follows a redirect with the integration secret", async () => {
    const trap = await startTrap();
    try {
      const s = await session();
      ccp.state.redirectTo = trap.url;
      const r = await chat(s.token);
      expect([r.status, r.json().error.code]).toEqual([502, "gateway_error"]);
      expect(trap.hits).toHaveLength(0);
    } finally {
      await trap.close();
    }
  });

  it("answers an unreachable CCP generically", async () => {
    const port = await freePort();
    setOptions({ ccp: { ...ccpOptions(), chatUrl: `http://127.0.0.1:${port}/api/public/webchat/v1/${INTEGRATION_ID}` } });
    expect((await call("/config")).json()).toEqual({ error: { message: "Dewee is unavailable, try again later", code: "gateway_error" } });
    expect((await call("/session", { method: "POST", body: "{}" })).status).toBe(502);
  });

  it("keeps the website's own origin check and rate limit", async () => {
    const r = await call("/config", { headers: { origin: "https://evil.example" } });
    expect([r.status, r.json().error.code]).toEqual([403, "forbidden_origin"]);
    expect(ccp.seen).toHaveLength(0);
    setOptions({ rateLimit: true });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call("/session", { method: "POST", headers: { "x-forwarded-for": "198.51.100.99" }, body: "{}" })).status);
    expect(statuses.slice(0, 10).every((x) => x === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("keeps rate-limit counters in the private temp directory, never in a shared one", async () => {
    // Another account on a shared host could have created the old shared directory first.
    const shared = join(dir, "tmp", "dewee-webchat-rl");
    spawnSync("mkdir", ["-p", shared]);
    chmodSync(shared, 0o777);
    setOptions({ rateLimit: true });
    expect((await call("/session", { method: "POST", headers: { "x-forwarded-for": "198.51.100.42" }, body: "{}" })).status).toBe(200);
    expect(readdirSync(shared)).toEqual([]);
    const [priv] = cacheDirs();
    const counters = readdirSync(priv).filter((n) => n.startsWith("rl-"));
    expect(counters.length).toBeGreaterThan(0);
    for (const n of counters) expect(statSync(join(priv, n)).mode & 0o077).toBe(0);
  });

  it(
    "stops the run at CCP when the turn times out",
    async () => {
      setOptions({ timeoutMs: 1500 });
      const s = await session();
      const r = await chat(s.token, { message: "think slow" });
      const events = sse(r.text);
      expect(r.status).toBe(200);
      expect(events.map((e) => e.type)).toEqual(["start", "delta", "error"]);
      expect(events.at(-1)).toMatchObject({ code: "timeout" });
      await vi.waitFor(() => expect(ccp.routes("abort")).toHaveLength(1), { timeout: 5000 });
      expect(ccp.routes("abort")[0].body).toEqual({ conversation_id: "conv_php_0001", run_id: "run-42" });
    },
    20_000,
  );

  it("never sends the integration secret, edge session or internal URLs to a browser", () => {
    const all = browserOutput.join("\n");
    for (const needle of [INTEGRATION_SECRET, VISITOR_SECRET, "dws1.", ccp.origin, "postgres://", "runtime.internal", "gw-token"]) expect(all, needle).not.toContain(needle);
  });
});
