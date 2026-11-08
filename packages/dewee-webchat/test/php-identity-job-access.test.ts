import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const php = process.env.PHP_BIN || "php";
const openssl = process.env.OPENSSL_BIN || (process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl");
const available = spawnSync(php, ["-v"]).status === 0 && spawnSync(openssl, ["version"]).status === 0;
const source = resolve(__dirname, "../../../php/dewee-webchat.php");
const assertionSecret = "fixture-assertion-secret-at-least-32-bytes";

describe.skipIf(!available)("PHP direct Gateway job access", () => {
  let gateway: Server, server: ChildProcess, base: string, gatewayOrigin: string;
  let responseMode = "valid";
  const received: Array<{ authorization?: string; identity?: string; body: unknown }> = [];
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "webchat-job-access-"));
    const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
    const generated = spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", cert]);
    if (generated.status !== 0) throw new Error("Could not generate test certificate");
    gateway = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
      let body = ""; for await (const part of req) body += part;
      if (req.url === "/v1/identity/sessions/exchange") {
        const assertion = String(req.headers.authorization ?? "").replace(/^Dewee-Assertion /, "");
        const [h, p, signature] = assertion.split(".");
        if (!h || !p || createHmac("sha256", assertionSecret).update(`${h}.${p}`).digest("base64url") !== signature) { res.writeHead(401).end(); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ session_token: "identity-test", principal_id: "principal-test", expires_at: new Date(Date.now() + 3600000).toISOString() })); return;
      }
      if (req.url !== "/v1/identity/job-access/launch") { res.writeHead(404).end(); return; }
      received.push({ authorization: req.headers.authorization, identity: req.headers["x-dewee-identity-session"] as string | undefined, body: JSON.parse(body) });
      if (responseMode === "redirect") { res.writeHead(302, { location: "https://attacker.example/" }).end(); return; }
      const bootstrap = responseMode === "other" ? "https://attacker.example" : gatewayOrigin;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ bootstrap_url: `${bootstrap}/identity/job-access/launch`, launch_token: "one_time_ticket_0123456789", expires_at: new Date(Date.now() + 45000).toISOString(), private: "do-not-leak" }));
    });
    await new Promise<void>((done) => gateway.listen(0, done));
    const port = (gateway.address() as { port: number }).port;
    gatewayOrigin = `https://localhost:${port}`;
    const options = { gatewayUrl: `https://LOCALHOST:${port}`, token: "operator-private", secret: "fixture-visitor-secret-at-least-32-bytes", agents: ["support"], rateLimit: false, allowedOrigins: "*", identity: { appId: "f2316b6b-822f-4d18-a572-a03d70fabd2b", issuer: "https://partner.example", assertionSecret } };
    writeFileSync(join(dir, "options.json"), JSON.stringify(options));
    writeFileSync(join(dir, "router.php"), `<?php\nrequire ${JSON.stringify(source)};\n$o=json_decode(file_get_contents(__DIR__.'/options.json'),true);\n$o['identity']['authenticate']=static fn()=>isset($_COOKIE['uid']) ? ['subject'=>$_COOKIE['uid']] : null;\nDeweeWebchat::handle($o);`);
    const localPort = await new Promise<number>((done) => { const s = createTcpServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });
    base = `http://127.0.0.1:${localPort}/api/dewee`;
    server = spawn(php, ["-d", `openssl.cafile=${cert}`, "-S", `127.0.0.1:${localPort}`, join(dir, "router.php")], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) { try { await fetch(`${base}/config`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    throw new Error("PHP server did not start");
  }, 30000);
  afterAll(async () => { server?.kill("SIGTERM"); gateway?.closeAllConnections(); await new Promise<void>((done) => gateway?.close(() => done()) ?? done()); });

  it("pins bootstrap to the canonical Gateway origin and sends no operator token", async () => {
    const issued = await (await fetch(`${base}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" })).json();
    const request = () => fetch(`${base}/job-access`, { method: "POST", headers: { cookie: "uid=user-a", origin: "https://shop.example", authorization: `Bearer ${issued.token}` }, body: "{}" });
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bootstrap_url: `${gatewayOrigin}/identity/job-access/launch`, launch_token: "one_time_ticket_0123456789", expires_at: expect.any(String) });
    expect(received[0]).toEqual({ identity: "identity-test", authorization: undefined, body: { launch_origin: "https://shop.example" } });
    for (const mode of ["other", "redirect"]) {
      responseMode = mode;
      const refused = await request();
      expect(refused.status).toBe(502);
      expect(await refused.text()).not.toContain("identity-test");
    }
  });
});
