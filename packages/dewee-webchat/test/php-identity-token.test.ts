import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { signVisitorToken, verifyVisitorToken } from "../src/server";

const php = process.env.PHP_BIN || "php";
const available = spawnSync(php, ["-v"]).status === 0;
const source = resolve(__dirname, "../../../php/dewee-webchat.php");
const secret = "fixture-visitor-secret-at-least-32-bytes";
const call = (code: string, data: unknown) => JSON.parse(execFileSync(php, ["-r", `require ${JSON.stringify(source)}; $in = json_decode(stream_get_contents(STDIN), true); ${code}`], { input: JSON.stringify(data), stdio: ["pipe", "pipe", "pipe"] }).toString());

describe.skipIf(!available)("PHP signed-in visitor token parity", () => {
  it("seals identity claims interoperably and rejects them when identity is disabled", async () => {
    const claims = { v: "visitor_12345", exp: Date.now() + 600000, ids: "identity-session", ida: "support", sub: "subject-digest" };
    const ts = await signVisitorToken(secret, claims);
    expect(call("echo json_encode(DeweeWebchat::verifyVisitorToken($in['secret'], $in['token']));", { secret, token: ts })).toBeNull();
    expect(call("echo json_encode(DeweeWebchat::verifyVisitorToken($in['secret'], $in['token'], true));", { secret, token: ts })).toEqual(claims);
    const fromPhp = call("echo json_encode(DeweeWebchat::signVisitorToken($in['secret'], $in['claims']));", { secret, claims });
    expect(await verifyVisitorToken(secret, fromPhp)).toEqual(claims);
    expect(await verifyVisitorToken(secret, fromPhp.slice(0, -2) + "aa")).toBeNull();
    expect(Buffer.from(fromPhp.split(".")[0], "base64url").toString()).not.toContain(claims.ids);
    expect(Buffer.from(fromPhp.split(".")[0], "base64url").toString()).not.toContain(claims.sub);
  });
});
