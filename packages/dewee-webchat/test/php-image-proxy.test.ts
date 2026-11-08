import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueImageTicket, verifyImageTicket } from "../src/server/image-proxy";

const php = process.env.PHP_BIN || "php";
const available = spawnSync(php, ["-v"]).status === 0;
const source = resolve(__dirname, "../../../php/dewee-webchat.php");

describe.skipIf(!available)("PHP image proxy", () => {
  let server: ChildProcess, base: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "webchat-images-"));
    const options = { gatewayUrl: "https://gateway.example", token: "fixture", secret: "fixture-secret-at-least-32-bytes-long", agents: ["support"], rateLimit: false, imageSources: ["https://localhost/images/", "https://127.0.0.1/images/", "https://cdn.example/images/"] };
    writeFileSync(join(dir, "options.json"), JSON.stringify(options));
    writeFileSync(join(dir, "router.php"), `<?php\nrequire ${JSON.stringify(source)};\nDeweeWebchat::handle(json_decode(file_get_contents(__DIR__.'/options.json'), true));`);
    const port = await new Promise<number>((done) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });
    base = `http://127.0.0.1:${port}/api/dewee`;
    server = spawn(php, ["-S", `127.0.0.1:${port}`, join(dir, "router.php")], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) { try { await fetch(`${base}/config`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    throw new Error("PHP server did not start");
  }, 30000);
  afterAll(() => server?.kill("SIGTERM"));

  it("refuses private and unapproved origins before any network request", async () => {
    const session = await (await fetch(`${base}/session`, { method: "POST", body: "{}" })).json();
    for (const src of ["https://localhost/images/a", "https://127.0.0.1/images/a", "https://evil.example/a", "https://user@cdn.example/images/a", "file:///etc/passwd", "https://cdn.example/images/a#fragment"]) {
      const response = await fetch(`${base}/image-ticket`, { method: "POST", headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify({ url: src }) });
      expect(response.status, src).toBe(403);
    }
    expect((await fetch(`${base}/image?ticket=invalid`)).status).toBe(401);
  });

  it("distinguishes public and reserved IPv4 and IPv6 addresses", () => {
    const expression = `require ${JSON.stringify(source)}; $f=new ReflectionMethod(DeweeWebchat::class,'publicImageAddress'); foreach (['8.8.8.8','127.0.0.1','100.64.1.2','192.0.2.1','2606:4700:4700::1111','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1'] as $ip) echo $f->invoke(null,$ip) ? '1' : '0';`;
    const result = spawnSync(php, ["-r", expression], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("100010000");
  });

  it("seals tickets interoperably with the TypeScript backend without exposing source URLs", async () => {
    const secret = "fixture-secret-at-least-32-bytes-long";
    const namespace = "https://gateway.example\n";
    const sourceUrl = "https://cdn.example/images/qr.png?secret=checkout";
    const session = await (await fetch(`${base}/session`, { method: "POST", body: "{}" })).json();
    const response = await fetch(`${base}/image-ticket`, { method: "POST", headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify({ url: sourceUrl }) });
    expect(response.status).toBe(200);
    const { ticket } = await response.json();
    expect(ticket).not.toContain("cdn.example");
    expect(await verifyImageTicket(secret, namespace, ticket)).toEqual({ visitor: session.visitorId, source: sourceUrl });
    expect(await verifyImageTicket(secret, `${namespace}wrong`, ticket)).toBeNull();
    const nodeTicket = await issueImageTicket(secret, namespace, session.visitorId, sourceUrl);
    const redeemed = await fetch(`${base}/image?ticket=${encodeURIComponent(nodeTicket)}`);
    expect(redeemed.status).not.toBe(401);
    expect(await redeemed.text()).not.toContain(sourceUrl);
  });

  it("rejects pixel bombs and animated PNG data", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6P1cAAAAASUVORK5CYII=";
    const animation = resolve(__dirname, "fixtures/images/animated.png");
    const expression = `require ${JSON.stringify(source)}; $f=new ReflectionMethod(DeweeWebchat::class,'safeRasterDimensions'); $b=base64_decode('${png}'); echo $f->invoke(null,$b,'image/png')?'1':'0'; $bomb=substr_replace($b,pack('N',100000),16,4); echo $f->invoke(null,$bomb,'image/png')?'1':'0'; echo $f->invoke(null,file_get_contents(${JSON.stringify(animation)}),'image/png')?'1':'0';`;
    const result = spawnSync(php, ["-r", expression], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("100");
  });

  it("accepts static container payloads containing marker bytes and rejects animated files", () => {
    const fixtures = ["static-noisy.gif", "animated.gif", "static-marker.png", "animated.png", "static.jpg", "static.webp", "animated.webp", "static-alpha.webp"].map((name) => resolve(__dirname, "fixtures/images", name));
    const expression = `require ${JSON.stringify(source)}; $f=new ReflectionMethod(DeweeWebchat::class,'safeRasterDimensions'); foreach (${JSON.stringify(fixtures)} as $i=>$p) echo $f->invoke(null,file_get_contents($p),$i<2?'image/gif':($i<4?'image/png':($i===4?'image/jpeg':'image/webp')))?'1':'0';`;
    // PHP syntax for an array differs from JSON only in its literal delimiters, which are shared here.
    const result = spawnSync(php, ["-r", expression], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("10101101");
  });
});
