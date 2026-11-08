import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const php = process.env.PHP_BIN || "php";
const available = spawnSync(php, ["-v"]).status === 0;
const source = resolve(__dirname, "../../../php/dewee-webchat.php");

describe.skipIf(!available)("PHP limiter storage failure", () => {
  function request(mode: string) {
    const root = mkdtempSync(join(tmpdir(), "dewee-limiter-"));
    const script = join(root, "request.php");
    writeFileSync(script, `<?php
require ${JSON.stringify(source)};
$_SERVER['REQUEST_METHOD'] = 'POST'; $_SERVER['PATH_INFO'] = '/session';
$opts = ['transport' => 'legacy-gateway', 'gatewayUrl' => 'https://gateway.example', 'token' => 'unused', 'agents' => ['support'], 'secret' => str_repeat('s', 40)];
if ($argv[1] === 'disabled') $opts['rateLimit'] = false;
if ($argv[1] === 'deny') $opts['rateLimit'] = fn () => false;
if ($argv[1] === 'throw') $opts['rateLimit'] = fn () => throw new Exception('secret');
if ($argv[1] === 'invalid') $opts['rateLimit'] = fn () => 'yes';
http_response_code(200); ob_start(); DeweeWebchat::handle($opts); $body = ob_get_clean();
echo json_encode(['status' => http_response_code(), 'body' => json_decode($body, true)]);
`);
    try {
      return JSON.parse(execFileSync(php, ["-d", `sys_temp_dir=${join(root, "missing")}`, script, mode], { stdio: ["ignore", "pipe", "pipe"] }).toString());
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  it("refuses when private storage is unavailable", () => {
    expect(request("default")).toMatchObject({ status: 503, body: { error: { code: "rate_limit_unavailable" } } });
  });
  it("distinguishes an explicit disable, a limit and a failed custom limiter", () => {
    expect(request("disabled")).toMatchObject({ status: 200, body: { visitorId: expect.any(String) } });
    expect(request("deny")).toMatchObject({ status: 429, body: { error: { code: "rate_limited" } } });
    for (const mode of ["throw", "invalid"]) {
      const result = request(mode);
      expect(result).toMatchObject({ status: 503, body: { error: { code: "rate_limit_unavailable" } } });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });
  it.skipIf(process.platform === "win32")("serializes concurrent processes and refuses a corrupt counter", async () => {
    const root = mkdtempSync(join(tmpdir(), "dewee-limiter-concurrent-"));
    const script = join(root, "request.php");
    writeFileSync(script, `<?php
require ${JSON.stringify(source)};
$_SERVER['REQUEST_METHOD'] = 'POST'; $_SERVER['PATH_INFO'] = '/session';
http_response_code(200); ob_start();
DeweeWebchat::handle(['transport' => 'legacy-gateway', 'gatewayUrl' => 'https://gateway.example', 'token' => 'unused', 'agents' => ['support'], 'secret' => str_repeat('s', 40)]);
$body = ob_get_clean(); echo json_encode(['status' => http_response_code(), 'body' => json_decode($body, true)]);
`);
    const run = async () => JSON.parse((await promisify(execFile)(php, ["-d", `sys_temp_dir=${root}`, script])).stdout);
    try {
      const results = await Promise.all(Array.from({ length: 20 }, run));
      expect(results.filter((r) => r.status === 200)).toHaveLength(10);
      expect(results.filter((r) => r.status === 429)).toHaveLength(10);
      const dir = join(root, readdirSync(root).find((name) => /^dewee-webchat-\d+$/.test(name))!);
      const counter = join(dir, readdirSync(dir).find((name) => name.startsWith("rl-"))!);
      writeFileSync(counter, "{partial");
      expect(await run()).toMatchObject({ status: 503, body: { error: { code: "rate_limit_unavailable" } } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
