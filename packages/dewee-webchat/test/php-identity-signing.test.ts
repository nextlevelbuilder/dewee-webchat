import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const php = process.env.PHP_BIN || "php";
const available = spawnSync(php, ["-v"]).status === 0;
const source = resolve(__dirname, "../../../php/dewee-webchat.php");
const appId = "f2316b6b-822f-4d18-a572-a03d70fabd2b";
const issuer = "https://partner.example";
const invoke = (signer: unknown, subject = "user-123") => {
  const code = `require ${JSON.stringify(source)}; $in = json_decode(stream_get_contents(STDIN), true); $m = new ReflectionMethod(DeweeWebchat::class, 'createSessionAssertion'); echo $m->invoke(null, $in['signer'], $in['subject']);`;
  return execFileSync(php, ["-r", code], { input: JSON.stringify({ signer, subject }), stdio: ["pipe", "pipe", "pipe"] }).toString();
};

describe.skipIf(!available)("PHP identity assertion signing", () => {
  it("signs HMAC assertions using the issued UTF-8 secret", () => {
    const secret = "fixture-assertion-secret-at-least-32-bytes";
    const token = invoke({ appId, issuer, assertionSecret: secret });
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "HS256", typ: "dewee-session+jwt" });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({ iss: issuer, aud: `dewee:${appId}`, sub: "user-123" });
    expect(claims.exp - claims.iat).toBeGreaterThan(0);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
    expect(claims.jti).toBeTruthy();
    expect(createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")).toBe(signature);
    expect(invoke({ appId, issuer, assertionSecret: secret })).not.toBe(token);
    expect(() => invoke({ appId, issuer, assertionSecret: secret }, "person@example.com")).toThrow();
    expect(() => invoke({ appId, issuer, assertionSecret: "short" })).toThrow();
    expect(() => invoke({ appId, issuer, assertionSecret: secret, privateKeyJwk: {} })).toThrow();
    expect(() => invoke({ appId, issuer, assertionSecret: secret, privateKeyJwk: null })).toThrow();
    const uppercase = invoke({ appId: appId.toUpperCase(), issuer, assertionSecret: secret });
    expect(JSON.parse(Buffer.from(uppercase.split(".")[1], "base64url").toString()).aud).toBe(`dewee:${appId}`);
  });

  it.each(["ff", "fe"])("rejects invalid UTF-8 subject bytes %s", (hex) => {
    const signer = JSON.stringify({ appId, issuer, assertionSecret: "fixture-assertion-secret-at-least-32-bytes" });
    const code = `require ${JSON.stringify(source)}; $m = new ReflectionMethod(DeweeWebchat::class, 'createSessionAssertion'); $m->invoke(null, json_decode(${JSON.stringify(signer)}, true), hex2bin('${hex}'));`;
    expect(spawnSync(php, ["-r", code]).status).not.toBe(0);
  });

  it("rejects unusable keys and mismatched algorithms", () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = { ...pair.privateKey.export({ format: "jwk" }), kid: "test-key", alg: "ES256" };
    expect(() => invoke({ appId, issuer, privateKeyJwk: { ...jwk, d: "bad!" }, algorithm: "ES256" })).toThrow();
    expect(() => invoke({ appId, issuer, privateKeyJwk: jwk, algorithm: "RS256" })).toThrow();
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" });
    expect(() => invoke({ appId, issuer, privateKeyJwk: { ...jwk, x: other.x, y: other.y }, algorithm: "ES256" })).toThrow();
  });

  it.each(["RS256", "ES256"] as const)("produces a valid %s JWS from a private JWK", (alg) => {
    const pair = alg === "RS256" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = { ...pair.privateKey.export({ format: "jwk" }), kid: "test-key", alg };
    const [header, payload, signature] = invoke({ appId, issuer, privateKeyJwk: jwk, algorithm: alg }).split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({ alg, typ: "dewee-session+jwt", kid: "test-key" });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), { key: pair.publicKey, ...(alg === "ES256" ? { dsaEncoding: "ieee-p1363" as const } : {}) }, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it.skipIf(!available || spawnSync(php, ["-r", "exit(function_exists('sodium_crypto_sign_seed_keypair') ? 0 : 1);" ]).status !== 0)("produces a valid Ed25519 JWS", () => {
    const pair = generateKeyPairSync("ed25519");
    const jwk = { ...pair.privateKey.export({ format: "jwk" }), kid: "test-key", alg: "EdDSA" };
    const [header, payload, signature] = invoke({ appId, issuer, privateKeyJwk: jwk, algorithm: "EdDSA" }).split(".");
    expect(verify(null, Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });
});
