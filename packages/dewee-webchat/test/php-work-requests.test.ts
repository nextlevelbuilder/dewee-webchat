// php/dewee-webchat.php work requests next to the TypeScript handler, against the same fake CCP ingress:
// the option and its environment variable, the feature header, `/config`, and for one scripted sequence
// of creates and lists (new, replay, conflict, unknown outcome, refusals, validation) the same answers and
// the same upstream calls. Runs when a PHP 8.1+ binary is available (PHP_BIN or `php` on PATH).
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDeweeHandler } from "../src/server";
import { INTEGRATION_ID, INTEGRATION_SECRET, startFakeCcp, type FakeCcp } from "./helpers/fake-ccp-ingress";

const PHP = process.env.PHP_BIN || "php";
const hasPhp = spawnSync(PHP, ["-v"]).status === 0;
const phpFile = resolve(__dirname, "../../../php/dewee-webchat.php");
const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";
const packageVersion = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")).version;
// Built by concatenation: phone-like fixtures are never literal.
const PHONE = "+84 " + "912" + " 345 " + "678";
const KINDS = [
  { kind: "callback", title: "Call me back", schema: "callback" as const, staffed_now: false },
  { kind: "quote", title: "  Ask for a quote ", schema: "generic" as const, staffed_now: true },
];

function php(code: string, input: unknown = null): any {
  const dir = mkdtempSync(join(tmpdir(), "dewee-php-wr-"));
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

interface Answer { status: number; retryAfter: string | null; body: any; text: string }
/** JSON answers parse; a chat stream (SSE) has no JSON body to compare. */
const parseBody = (text: string): any => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

/** Codes and times are per request: replaced so two hosts' answers compare. */
const normal = (v: unknown): unknown => JSON.parse(JSON.stringify(v)
  .replace(/WR-[0-9A-HJKMNP-TV-Z]{8}/g, "WR-CODE")
  .replace(/"\d{4}-\d{2}-\d{2}T[0-9:.]+Z"/g, '"TIME"'));

describe.skipIf(!hasPhp)("PHP work requests", () => {
  let ccp: FakeCcp;
  let server: ChildProcess;
  let dir: string;
  let base: string;
  const ccpOptions = () => ({ chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET });
  let optionsFile = "";
  let optionsSeq = 0;
  const setOptions = (extra: Record<string, unknown> = {}) => {
    optionsFile = `options-${++optionsSeq}.json`;
    writeFileSync(join(dir, optionsFile), JSON.stringify({ ccp: ccpOptions(), secret: VISITOR_SECRET, rateLimit: false, ...extra }));
  };
  const dropConfigCache = () => {
    for (const n of readdirSync(join(dir, "tmp")).filter((x) => /^dewee-webchat-\d+$/.test(x))) {
      for (const f of readdirSync(join(dir, "tmp", n))) if (f.startsWith("ccp-config-")) rmSync(join(dir, "tmp", n, f), { force: true });
    }
  };

  async function phpCall(path: string, init: RequestInit = {}): Promise<Answer> {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), "x-test-options": optionsFile } });
    const text = await res.text();
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body: parseBody(text), text };
  }

  beforeAll(async () => {
    ccp = await startFakeCcp();
    dir = mkdtempSync(join(tmpdir(), "dewee-php-wr-srv-"));
    mkdirSync(join(dir, "tmp"));
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
    ccp.state.workRequestKinds = KINDS.map((k) => ({ ...k }));
    setOptions();
    dropConfigCache();
  });

  it("refuses an unsafe option at startup and reads the environment only as true", () => {
    const url = `http://127.0.0.1:1/api/public/webchat/v1/${INTEGRATION_ID}`;
    const ccpOk = { chatUrl: url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET };
    const ccpEnv = { DEWEE_CCP_CHAT_URL: url, DEWEE_WEBCHAT_INTEGRATION_ID: INTEGRATION_ID, DEWEE_WEBCHAT_INTEGRATION_SECRET: INTEGRATION_SECRET, DEWEE_WEBCHAT_SECRET: VISITOR_SECRET };
    const out = php(
      `$class = new ReflectionClass(DeweeWebchat::class);
$build = function (array $o) use ($class): string {
  $h = $class->newInstanceWithoutConstructor();
  try { $class->getConstructor()->invoke($h, $o); return 'ok'; } catch (DeweeConfigError $e) { return 'refused: ' . $e->getMessage(); }
};
$r = array_map($build, $in['cases']);
$fromEnv = [$build(DeweeWebchat::optionsFromEnv($in['ccpEnv'])), $build(DeweeWebchat::optionsFromEnv($in['ccpEnv'] + ['DEWEE_WEBCHAT_WORK_REQUESTS' => 'true']))];
$env = [];
foreach ($in['env'] as $v) $env[] = DeweeWebchat::optionsFromEnv(['DEWEE_WEBCHAT_WORK_REQUESTS' => $v])['workRequests'] ?? null;
echo json_encode(['cases' => $r, 'fromEnv' => $fromEnv, 'env' => $env, 'features' => [DeweeCcpClient::featuresHeader(false, false, true), DeweeCcpClient::featuresHeader(true, true, true), DeweeCcpClient::featuresHeader(true, false)]]);`,
      {
        cases: [
          { ccp: ccpOk, secret: VISITOR_SECRET, workRequests: true },
          { ccp: ccpOk, secret: VISITOR_SECRET, workRequests: "yes" },
          { gatewayUrl: "https://gw.example", token: "t", secret: VISITOR_SECRET, workRequests: true },
          { ccp: ccpOk, secret: VISITOR_SECRET, workRequests: null },
        ],
        ccpEnv,
        env: ["true", " true ", "", "1", "false"],
      },
    );
    expect(out.cases[0]).toBe("ok");
    expect(out.cases[1]).toMatch(/refused: .*workRequests must be true or false/);
    expect(out.cases[2]).toMatch(/refused: .*workRequests requires the ccp transport/);
    expect(out.cases[3]).toBe("ok");
    expect(out.fromEnv).toEqual(["ok", "ok"]);
    expect(out.env).toEqual([true, true, null, null, null]);
    expect(out.features).toEqual(["work-requests", "human-handoff, credential-requests, work-requests", "human-handoff"]);
  });

  it("without the option: no kinds, no feature header and no routes, even when the workspace offers kinds", async () => {
    expect((await phpCall("/config")).body.workRequests).toBeUndefined();
    expect(ccp.routes("config").at(-1)?.headers["x-dewee-webchat-features"]).toBeUndefined();
    const s = (await phpCall("/session", { method: "POST", body: "{}" })).body;
    for (const path of ["/work-requests", "/work-requests/list"]) {
      const r = await phpCall(path, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: "{}" });
      expect([r.status, r.body.error.code]).toEqual([404, "not_found"]);
    }
    expect(ccp.seen.filter((r) => r.route.startsWith("work-requests"))).toHaveLength(0);
  });

  it("matches the TS handler's /config", async () => {
    setOptions({ workRequests: true });
    const ts = createDeweeHandler({ ccp: ccpOptions(), secret: VISITOR_SECRET, rateLimit: false, workRequests: true });
    const { version: _v, ...tsConfig } = await (await ts(new Request("https://shop.example/api/dewee/config"))).json();
    expect(tsConfig.workRequests).toEqual([
      { kind: "callback", title: "Call me back", schema: "callback", staffedNow: false },
      { kind: "quote", title: "Ask for a quote", schema: "generic", staffedNow: true },
    ]);
    expect((await phpCall("/config")).body).toEqual({ ...tsConfig, version: packageVersion });
    expect(ccp.routes("config").at(-1)?.headers["x-dewee-webchat-features"]).toBe("work-requests");
  });

  it("answers a scripted sequence of creates and lists like the TS handler, with the same upstream calls", async () => {
    setOptions({ workRequests: true });
    const ts = createDeweeHandler({ ccp: ccpOptions(), secret: VISITOR_SECRET, rateLimit: false, workRequests: true });
    const tsCall = async (path: string, init: RequestInit = {}): Promise<Answer> => {
      const res = await ts(new Request(`https://shop.example/api/dewee${path}`, init));
      const text = await res.text();
      return { status: res.status, retryAfter: res.headers.get("retry-after"), body: parseBody(text), text };
    };
    const callback = (over: Record<string, unknown> = {}) => ({
      kind: "callback", summary: "  Call me after 5pm  ", agent: "shop", idempotencyKey: "wr_key_" + "0001abcd",
      payload: { contact_method: "phone", contact_value: PHONE, purpose: "Call me after 5pm", consent: true }, ...over,
    });
    type Step = { path: string; body: unknown; before?: () => void };
    const steps: Step[] = [
      { path: "/work-requests", body: callback({ conversationId: "conv_wr_php_0001" }) },
      { path: "/work-requests", body: callback({ conversationId: "conv_wr_php_0001" }) },
      { path: "/work-requests", body: callback({ conversationId: "conv_wr_php_0001", summary: "Something else" }) },
      { path: "/work-requests", body: { kind: "quote", summary: "Quote", payload: {}, idempotencyKey: "wr_key_" + "0002abcd" } },
      { path: "/work-requests", body: callback({ idempotencyKey: "wr_key_" + "0003abcd" }), before: () => { ccp.state.workRequestFault = "drop"; } },
      { path: "/work-requests", body: callback({ idempotencyKey: "wr_key_" + "0004abcd" }), before: () => { ccp.state.workRequestFault = "unknown"; } },
      { path: "/work-requests/list", body: { idempotencyKey: "wr_key_" + "0003abcd" } },
      { path: "/work-requests/list", body: { conversationId: "conv_wr_php_0001", limit: 10 } },
      { path: "/work-requests/list", body: {} },
      { path: "/work-requests", body: callback({ kind: "repair", idempotencyKey: "wr_key_" + "0010abcd" }) },
      { path: "/work-requests", body: callback({ conversationId: "conv_not_mine_01", idempotencyKey: "wr_key_" + "0005abcd" }) },
      { path: "/work-requests", body: callback({ idempotencyKey: "wr_key_" + "0006abcd", payload: { contact_method: "fax", contact_value: "1", purpose: "x", consent: true } }) },
      { path: "/work-requests", body: callback({ idempotencyKey: "wr_key_" + "0007abcd" }), before: () => { ccp.state.failNext.set("work-requests/create", { status: 429, code: "rate_limited", retryAfter: 120 }); } },
      { path: "/work-requests", body: callback({ idempotencyKey: "wr_key_" + "0008abcd" }), before: () => { ccp.state.failNext.set("work-requests/create", { status: 503, code: "ingress_unavailable", retryAfter: 30 }); } },
      { path: "/work-requests", body: callback({ idempotencyKey: "wr_key_" + "0009abcd" }), before: () => { ccp.state.failNext.set("work-requests/create", { status: 401, code: "ingress_session_expired" }); } },
      { path: "/work-requests/list", body: {}, before: () => { ccp.state.failNext.set("work-requests/list", { status: 502, code: "upstream_failed" }); } },
      // Refused before CCP is called.
      { path: "/work-requests", body: callback({ idempotencyKey: "short" }) },
      { path: "/work-requests", body: callback({ summary: "é".repeat(501) }) },
      { path: "/work-requests", body: callback({ summary: "my code MEM-ABCDEFGHIJKLMNOP" }) },
      { path: "/work-requests", body: callback({ payload: [] }) },
      { path: "/work-requests", body: callback({ payload: { note: "x".repeat(17 * 1024) } }) },
      { path: "/work-requests", body: callback({ extra: 1 }) },
      { path: "/work-requests", body: callback({ conversationId: null }) },
      { path: "/work-requests", body: callback({ agent: "../x" }) },
      { path: "/work-requests", body: [1] },
      { path: "/work-requests/list", body: { limit: 0 } },
      { path: "/work-requests/list", body: { limit: 1.5 } },
      { path: "/work-requests/list", body: { other: 1 } },
    ];
    /** One host's run: its answers and the upstream calls each step made (config reads aside). */
    const run = async (call: (path: string, init?: RequestInit) => Promise<Answer>) => {
      const session = (await call("/session", { method: "POST", body: "{}" })).body;
      const auth = { authorization: `Bearer ${session.token}` };
      await call("/chat", { method: "POST", headers: auth, body: JSON.stringify({ message: "hi", conversationId: "conv_wr_php_0001", agent: "shop" }) });
      const out: Array<{ answer: unknown; upstream: unknown }> = [];
      for (const step of steps) {
        step.before?.();
        const from = ccp.seen.length;
        const answer = await call(step.path, { method: "POST", headers: auth, body: JSON.stringify(step.body) });
        expect(answer.text).not.toMatch(/staff_0193|VIP|leaked-contact|postgres|912 345/);
        const upstream = ccp.seen.slice(from).filter((r) => r.route !== "config" && r.route !== "session")
          .map((r) => ({ route: r.route, features: r.headers["x-dewee-webchat-features"], session: typeof r.headers["x-dewee-webchat-session"] === "string", body: r.body }));
        out.push({ answer: normal({ status: answer.status, retryAfter: answer.retryAfter, body: answer.body }), upstream });
      }
      return out;
    };
    const tsRun = await run(tsCall);
    const phpRun = await run(phpCall);
    for (let i = 0; i < steps.length; i++) expect(phpRun[i], `step ${i}: ${JSON.stringify(steps[i].body).slice(0, 80)}`).toEqual(tsRun[i]);
    // A spot check of what the TS run itself answered, so parity is not parity of two wrong answers.
    expect(tsRun.map((s) => (s.answer as { status: number }).status)).toEqual([201, 200, 409, 201, 503, 503, 200, 200, 200, 403, 404, 400, 429, 503, 201, 502, 400, 413, 400, 400, 413, 400, 400, 400, 400, 400, 400, 400]);
    expect(tsRun[3].upstream).toEqual([{ route: "work-requests/create", features: "work-requests", session: true, body: { kind: "quote", summary: "Quote", payload: {}, idempotency_key: "wr_key_0002abcd" } }]);
  }, 30_000);
});
