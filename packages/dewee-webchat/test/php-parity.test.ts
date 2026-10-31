// Checks that php/dewee-webchat.php builds the same page-action block as the TypeScript handler.
// Runs when a PHP 8.1+ binary is available (PHP_BIN or `php` on PATH); skipped otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { admissionErrorEvent } from "../src/server/admission-errors";
import { ActionInputError, buildPageBlock, hashManifest, normalizeManifest, serializePageContext, stripPageBlock } from "../src/actions/page-block";

const PHP = process.env.PHP_BIN || "php";
const hasPhp = spawnSync(PHP, ["-v"]).status === 0;
const phpFile = resolve(__dirname, "../../../php/dewee-webchat.php");
const VISITOR_SECRET = "test-secret-for-temp-file-isolation-000000";

const script = `<?php
require ${JSON.stringify(phpFile)};
$cases = json_decode(stream_get_contents(STDIN), false);
$out = [];
foreach ($cases as $c) {
  try {
    $m = $c->actions !== null ? DeweeWebchat::normalizeManifest($c->actions) : null;
    $ctx = DeweeWebchat::serializePageContext($c->pageContext ?? null);
    $h = $m ? DeweeWebchat::hashManifest($m) : null;
    $block = DeweeWebchat::buildPageBlock($m, $h, ($c->ack ?? null) !== $h, $ctx);
    $out[] = ['block' => $block, 'hash' => $h, 'stripped' => DeweeWebchat::stripPageBlock($block . 'hello')];
  } catch (DeweeActionInputError $e) {
    $out[] = ['error' => $e->errorCode, 'status' => $e->status];
  }
}
echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
`;

interface Case { actions: unknown; pageContext?: unknown; ack?: string }

async function tsSide(c: Case) {
  try {
    const m = c.actions != null ? normalizeManifest(c.actions) : undefined;
    const ctx = serializePageContext(c.pageContext);
    const h = m?.length ? await hashManifest(m) : null;
    const block = buildPageBlock({ manifest: m, hash: h ?? undefined, includeManifest: c.ack !== (h ?? undefined), pageContext: ctx });
    return { block, hash: h, stripped: stripPageBlock(block + "hello") };
  } catch (e) {
    if (e instanceof ActionInputError) return { error: e.code, status: e.status };
    throw e;
  }
}

const nav = { name: "navigate", description: "Go to a dashboard route — “Tổng quan”", sensitivity: "navigate", parameters: { type: "object", properties: { route: { type: "string", enum: ["/", "/runs"] } }, required: ["route"] } };
const del = { name: "runs.delete", description: "Delete a run", sensitivity: "destructive", parameters: { type: "object", properties: {} } };

describe.skipIf(!hasPhp)("PHP backend parity (page actions)", () => {
  it("builds identical blocks, hashes and errors", async () => {
    const cases: Case[] = [
      { actions: [nav, del], pageContext: { route: "/runs", filter: { status: "failed" } } },
      { actions: [nav, del], pageContext: { route: "/" }, ack: "will-be-replaced" },
      { actions: [nav] },
      { actions: null, pageContext: { only: "context" } },
      { actions: [] },
      { actions: [{ ...nav, name: "Bad Name" }] },
      { actions: [nav, nav] },
      { actions: [{ ...nav, sensitivity: "admin" }] },
      { actions: [nav], pageContext: { big: "x".repeat(5000) } },
    ];
    // case 2: ack equals the real hash, so the manifest is not repeated
    cases[1].ack = (await tsSide({ actions: [nav, del] })).hash!;
    const dir = mkdtempSync(join(tmpdir(), "dewee-php-"));
    writeFileSync(join(dir, "parity.php"), script);
    const php = JSON.parse(execFileSync(PHP, [join(dir, "parity.php")], { input: JSON.stringify(cases) }).toString());
    const ts = await Promise.all(cases.map(tsSide));
    expect(php).toEqual(ts);
    expect(ts[1].block).toContain("Page actions unchanged");
    expect(ts[2].stripped).toBe("hello");
  });
});

const admissionScript = `<?php
require ${JSON.stringify(phpFile)};
$cases = json_decode(stream_get_contents(STDIN), false);
$out = [];
foreach ($cases as $c) {
  $out[] = DeweeWebchat::gatewayErrorEvent(new DeweeGatewayError('gateway text', $c->code, $c->retryAfterMs ?? null));
}
echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
`;

describe.skipIf(!hasPhp)("PHP backend parity (admission errors)", () => {
  it("maps POLICY_DENIED, RATE_LIMITED and CHALLENGE_REQUIRED like the TypeScript handler", () => {
    const cases = [
      { code: "POLICY_DENIED", retryAfterMs: 5000 },
      { code: "RATE_LIMITED", retryAfterMs: 1234.2 },
      { code: "RATE_LIMITED", retryAfterMs: "2500" },
      { code: "RATE_LIMITED" },
      { code: "RATE_LIMITED", retryAfterMs: -1 },
      { code: "RATE_LIMITED", retryAfterMs: 1e9 },
      { code: "RATE_LIMITED", retryAfterMs: "soon" },
      { code: "RATE_LIMITED", retryAfterMs: "0x10" },
      { code: "RATE_LIMITED", retryAfterMs: " 1.5e3 " },
      { code: "CHALLENGE_REQUIRED", retryAfterMs: 10 },
    ] as const;
    const dir = mkdtempSync(join(tmpdir(), "dewee-php-"));
    writeFileSync(join(dir, "admission.php"), admissionScript);
    const php = JSON.parse(execFileSync(PHP, [join(dir, "admission.php")], { input: JSON.stringify(cases) }).toString());
    expect(php).toEqual(cases.map((c) => admissionErrorEvent(c.code, "retryAfterMs" in c ? c.retryAfterMs : undefined)));
    // anything else keeps the gateway's code and message
    const other = JSON.parse(execFileSync(PHP, [join(dir, "admission.php")], { input: JSON.stringify([{ code: "run_failed" }]) }).toString());
    expect(other).toEqual([{ type: "error", message: "gateway text", code: "run_failed" }]);
  });
});

describe.skipIf(!hasPhp)("PHP backend startup temp-file security", () => {
  it("requires a strong explicit secret and keeps the legacy warning marker in a private directory", () => {
    const root = mkdtempSync(join(tmpdir(), "dewee-php-temp-security-"));
    const sharedTemp = join(root, "shared-temp");
    mkdirSync(sharedTemp);
    const entry = join(root, "startup.php");
    writeFileSync(entry, `<?php
require ${JSON.stringify(phpFile)};
$options = json_decode(stream_get_contents(STDIN), true);
$_SERVER['REQUEST_METHOD'] = 'OPTIONS';
ob_start();
DeweeWebchat::handle($options);
$body = ob_get_clean();
echo json_encode(['status' => http_response_code(), 'body' => json_decode($body, true)]);
`);
    const run = (options: unknown) => JSON.parse(execFileSync(PHP, ["-d", `sys_temp_dir=${sharedTemp}`, entry], {
      input: JSON.stringify(options),
      stdio: ["pipe", "pipe", "pipe"],
    }).toString()) as { status: number; body: unknown };

    expect(run({ gatewayUrl: "https://gw.example", token: "gateway-token" })).toEqual({
      status: 500,
      body: { error: { message: "Chat is not configured on this server", code: "not_configured" } },
    });
    expect(readdirSync(sharedTemp)).toEqual([]);
    expect(run({ gatewayUrl: "https://gw.example", token: "gateway-token", secret: "short" })).toEqual({
      status: 500,
      body: { error: { message: "Chat is not configured on this server", code: "not_configured" } },
    });
    expect(readdirSync(sharedTemp)).toEqual([]);

    expect(run({ gatewayUrl: "https://gw.example", token: "gateway-token", secret: VISITOR_SECRET }).status).toBe(204);
    const names = readdirSync(sharedTemp);
    expect(names).not.toContain("dewee-webchat-secret");
    expect(names).not.toContain("dewee-webchat-legacy-gateway-warned");

    if (process.platform !== "win32") {
      const privateDirName = names.find((name) => /^dewee-webchat-\d+$/.test(name));
      expect(privateDirName).toBeDefined();
      const privateDir = join(sharedTemp, privateDirName!);
      expect(statSync(privateDir).mode & 0o777).toBe(0o700);
      const marker = join(privateDir, "legacy-gateway-warned");
      expect(readdirSync(privateDir)).toContain("legacy-gateway-warned");
      expect(statSync(marker).mode & 0o777).toBe(0o600);
    }
  });
});
