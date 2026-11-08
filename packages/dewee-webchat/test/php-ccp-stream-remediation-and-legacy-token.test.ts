// php/dewee-webchat.php pieces that need no server: SSE framing across chunk boundaries and at the
// end of the stream, the remediation whitelist, and the legacy visitor token as it verifies today.
// Runs when a PHP 8.1+ binary is available (PHP_BIN or `php` on PATH); skipped otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { signVisitorToken } from "../src/server";
import { signReuseHint } from "../src/server/security";
import { forgeToken } from "./helpers/forge-token";

const PHP = process.env.PHP_BIN || "php";
const hasPhp = spawnSync(PHP, ["-v"]).status === 0;
const phpFile = resolve(__dirname, "../../../php/dewee-webchat.php");
const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";

/** Runs a PHP snippet with the backend loaded; stdin is JSON, stdout is parsed as JSON. */
function php(code: string, input: unknown = null): any {
  const dir = mkdtempSync(join(tmpdir(), "dewee-php-unit-"));
  const file = join(dir, "case.php");
  writeFileSync(file, `<?php\nrequire ${JSON.stringify(phpFile)};\n$in = json_decode(stream_get_contents(STDIN), true);\n${code}\n`);
  return JSON.parse(execFileSync(PHP, [file], { input: JSON.stringify(input), stdio: ["pipe", "pipe", "pipe"] }).toString());
}

/** A stream wrapper that hands out the given chunks one read at a time, then ends. */
const CHUNKED_STREAM = `
final class ChunkedStream {
  public static array $chunks = [];
  public $context;
  private array $left = [];
  public function stream_open($path, $mode, $options, &$opened): bool { $this->left = self::$chunks; return true; }
  public function stream_read($count): string|false { return $this->left === [] ? '' : array_shift($this->left); }
  public function stream_eof(): bool { return $this->left === []; }
  public function stream_set_option($option, $arg1, $arg2): bool { return true; }
  public function stream_stat(): array|false { return []; }
}
stream_wrapper_register('chunked', 'ChunkedStream');
function frames(array $chunks): array {
  ChunkedStream::$chunks = $chunks;
  $fp = fopen('chunked://x', 'r');
  $out = [];
  foreach (DeweeCcpClient::sseFrames($fp, fn () => true) as $f) { $out[] = $f; }
  return $out;
}
`;

describe.skipIf(!hasPhp)("PHP ccp: SSE framing", () => {
  it("joins CRLF split across chunks, accepts CR endings, and delivers a last frame without a blank line", () => {
    const cases = [
      ['data: {"a":\r', '\ndata: 1}\r\n\r\n'],
      ['data: {"a":1}\r\n\r', "\n", 'data: {"b":2}\r\n\r\n'],
      ['data: {"type":"delta","text":"x"}\n\n', 'data: {"type":"done","content":"x"}'],
      ['data: {"type":"done"}\r'],
      [": ping\r\r", 'data: {"b":2}\r\r', "data: not json\r\r"],
    ];
    const out = php(`${CHUNKED_STREAM}\necho json_encode(array_map('frames', $in));`, cases);
    expect(out).toEqual([[{ a: 1 }], [{ a: 1 }, { b: 2 }], [{ type: "delta", text: "x" }, { type: "done", content: "x" }], [{ type: "done" }], [{ b: 2 }]]);
  });
});

describe.skipIf(!hasPhp)("PHP ccp: remediation from CCP", () => {
  it("keeps only the contract's actions and audiences, in JSON errors and stream errors", () => {
    const bad = [{ action: "open https://evil.example", audience: "end_user" }, { action: "reauthenticate", audience: "everyone" }, { action: "x".repeat(5000), audience: "end_user" }, { action: 1, audience: "end_user" }, "reauthenticate", null];
    const out = php(
      `$known = array_map(fn ($r) => DeweeWebchat::knownRemediation($r), $in['bad']);
$ok = DeweeWebchat::knownRemediation(['action' => 'send_connect_link', 'audience' => 'integrator', 'extra' => 'x']);
$e1 = DeweeCcpClient::errorFrom(401, json_encode(['error' => ['code' => 'LINK_REVOKED', 'message' => 'm', 'remediation' => ['action' => '<b>x</b>', 'audience' => 'end_user']]]));
$e2 = DeweeCcpClient::errorFrom(401, json_encode(['error' => ['code' => 'LINK_REVOKED', 'message' => 'm', 'remediation' => ['action' => 'reauthenticate', 'audience' => 'end_user']]]));
echo json_encode([
  'bad' => $known, 'ok' => $ok, 'e1' => $e1->remediation, 'e2' => $e2->remediation,
  's1' => DeweeWebchat::ccpStreamError('LINK_REVOKED', ['action' => 'phish', 'audience' => 'end_user']),
  's2' => DeweeWebchat::ccpStreamError('LINK_REVOKED', ['action' => 'reauthenticate', 'audience' => 'end_user']),
]);`,
      { bad },
    );
    expect(out.bad).toEqual(bad.map(() => null));
    expect(out.ok).toEqual({ action: "send_connect_link", audience: "integrator" });
    expect(out.e1).toBeNull();
    expect(out.e2).toEqual({ action: "reauthenticate", audience: "end_user" });
    expect(out.s1).toEqual({ type: "error", code: "LINK_REVOKED", message: "Your access was revoked." });
    expect(out.s2).toEqual({ type: "error", code: "LINK_REVOKED", message: "Your access was revoked.", remediation: { action: "reauthenticate", audience: "end_user" } });
  });
});

describe.skipIf(!hasPhp)("PHP legacy visitor token", () => {
  it("verifies a legacy {v, exp} token exactly as before and refuses tampered, expired or signed-in ones", async () => {
    const exp = Date.now() + 60_000;
    const legacy = await signVisitorToken(VISITOR_SECRET, { v: "visitor_legacy_01", exp });
    const withEdge = await signVisitorToken(VISITOR_SECRET, { v: "visitor_legacy_02", exp, es: "dws1.edge.token", ese: 1234 });
    const signedIn = await signVisitorToken(VISITOR_SECRET, { v: "visitor_legacy_03", exp, ids: "idsess_1", ida: "shop", sub: "digest" });
    const expired = await signVisitorToken(VISITOR_SECRET, { v: "visitor_legacy_04", exp: Date.now() - 1000 });
    const hint = await signReuseHint(VISITOR_SECRET, { v: "visitor_legacy_06", exp, ids: "idsess_2", ida: "shop", sub: "digest" });
    const out = php(
      `$s = $in['secret'];
echo json_encode([
  'legacy' => DeweeWebchat::verifyVisitorToken($s, $in['legacy']),
  'phpMinted' => DeweeWebchat::verifyVisitorToken($s, DeweeWebchat::signVisitorToken($s, ['v' => 'visitor_legacy_05', 'exp' => $in['exp']])),
  'withEdge' => DeweeWebchat::verifyVisitorToken($s, $in['withEdge']),
  'signedIn' => DeweeWebchat::verifyVisitorToken($s, $in['signedIn']),
  'expired' => DeweeWebchat::verifyVisitorToken($s, $in['expired']),
  'hint' => DeweeWebchat::verifyVisitorToken($s, $in['hint']),
  'tampered' => DeweeWebchat::verifyVisitorToken($s, $in['tampered']),
  'otherSecret' => DeweeWebchat::verifyVisitorToken(str_repeat('o', 40), $in['legacy']),
]);`,
      { secret: VISITOR_SECRET, legacy, withEdge, signedIn, expired, hint, exp, tampered: forgeToken(legacy) },
    );
    // Exactly the two claims, nothing added.
    expect(out.legacy).toEqual({ v: "visitor_legacy_01", exp });
    expect(out.phpMinted).toEqual({ v: "visitor_legacy_05", exp });
    expect(out.withEdge).toEqual({ v: "visitor_legacy_02", exp, es: "dws1.edge.token", ese: 1234 });
    // The PHP backend has no signed-in mode: such a token is refused rather than read as an anonymous visitor.
    expect(out.signedIn).toBeNull();
    expect(out.expired).toBeNull();
    // A Node backend's reuse hint is never a visitor token.
    expect(out.hint).toBeNull();
    expect(out.tampered).toBeNull();
    expect(out.otherSecret).toBeNull();
  });
});
