import { createHmac } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyVisitorToken } from "../src/server";
import { deriveVisitorId, subjectDigest } from "../src/server/security";

const php = process.env.PHP_BIN || "php";
const available = spawnSync(php, ["-v"]).status === 0;
const source = resolve(__dirname, "../../../php/dewee-webchat.php");
const secret = "fixture-visitor-secret-at-least-32-bytes";
const assertionSecret = "fixture-assertion-secret-at-least-32-bytes";
const appId = "f2316b6b-822f-4d18-a572-a03d70fabd2b";

describe.skipIf(!available)("PHP signed-in Gateway sessions", () => {
  let gateway: Server, ws: WebSocketServer, phpServer: ChildProcess, base = "", optionsPath = "";
  let options: any;
  let applied = true;
  let wsFailure: { code: string; message: string; remediation: { action: string; audience: string } } | undefined;
  let failure: { route: string; code: string; remediation?: { action: string; audience: string } } | undefined;
  const connects: any[] = [];
  beforeAll(async () => {
    gateway = createServer((req, res) => {
      if (failure && req.url === failure.route) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: failure.code, message: "private error", remediation: failure.remediation } })); return;
      }
      if (req.url === "/v1/identity/sessions/exchange") {
        const assertion = String(req.headers.authorization ?? "").replace(/^Dewee-Assertion /, "");
        const [h, p, sig] = assertion.split(".");
        if (!h || !p || createHmac("sha256", assertionSecret).update(`${h}.${p}`).digest("base64url") !== sig) { res.writeHead(401).end(); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ session_token: "identity-test", principal_id: "principal-test", expires_at: new Date(Date.now() + 3600000).toISOString() }));
      } else if (req.url === "/v1/identity/links" && req.headers["x-dewee-identity-session"] === "identity-test") {
        res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ proof_code: "123456", expires_at: new Date(Date.now() + 600000).toISOString(), deep_links: [{ channel_type: "telegram", channel_instance_id: "one", name: "Bot" }] }));
      } else res.writeHead(404).end();
    });
    ws = new WebSocketServer({ server: gateway });
    ws.on("connection", (socket) => socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.method === "connect") connects.push(frame.params);
      if (frame.method === "connect" && wsFailure) { socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: wsFailure })); return; }
      const payload = frame.method === "connect" ? (applied ? { user_id: "tuc:principal-test" } : {}) : frame.method === "chat.history" ? { messages: [] } : { content: "hello" };
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    }));
    await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), "webchat-identity-gw-"));
    options = { gatewayUrl, token: "gateway-fixture", secret, agents: ["support"], rateLimit: false, identity: { appId, issuer: "https://partner.example", assertionSecret, rebindEachRequest: true } };
    optionsPath = join(dir, "options.json");
    writeFileSync(optionsPath, JSON.stringify(options));
    writeFileSync(join(dir, "router.php"), `<?php\nrequire ${JSON.stringify(source)};\n$o=json_decode(file_get_contents(__DIR__.'/options.json'),true);\n$o['identity']['authenticate']=static fn()=>isset($_COOKIE['uid']) ? ['subject'=>$_COOKIE['uid']] : null;\nDeweeWebchat::handle($o);\n`);
    const port = await new Promise<number>((done) => { const s = createTcpServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });
    base = `http://127.0.0.1:${port}/api/dewee`;
    phpServer = spawn(php, ["-S", `127.0.0.1:${port}`, join(dir, "router.php")], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) { try { await fetch(`${base}/config`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    throw new Error("PHP server did not start");
  }, 30000);
  afterAll(async () => { phpServer?.kill("SIGTERM"); ws?.close(); gateway?.closeAllConnections(); await new Promise<void>((done) => gateway?.close(() => done()) ?? done()); });

  it("uses identity_session rather than user_id and fails closed if Gateway ignores it", async () => {
    const s = await (await fetch(`${base}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" })).json();
    const claims = await verifyVisitorToken(secret, s.token);
    expect(claims).toMatchObject({ ids: "identity-test", ida: "support", v: await deriveVisitorId(secret, "principal:principal-test"), sub: await subjectDigest(secret, "user-a") });
    expect(claims!.exp).toBeGreaterThan(Date.now());
    expect(claims!.exp).toBeLessThanOrEqual(Date.now() + 3600000);
    const headers = { cookie: "uid=user-a", authorization: `Bearer ${s.token}` };
    applied = false;
    const refused = await fetch(`${base}/chat`, { method: "POST", headers, body: JSON.stringify({ message: "hi", agent: "support", conversationId: "conversation_123" }) });
    expect(refused.status).toBe(503);
    expect(connects.at(-1)).toMatchObject({ identity_session: "identity-test" });
    expect(connects.at(-1)).not.toHaveProperty("user_id");
    applied = true;
    const history = await fetch(`${base}/history?agent=support&conversationId=conversation_123`, { headers });
    expect(history.status).toBe(200);
    const link = await fetch(`${base}/link`, { method: "POST", headers, body: "{}" });
    expect(await link.json()).toMatchObject({ proofCode: "123456", deepLinks: [{ channelType: "telegram" }] });
  });

  it("refuses an existing token when its bound agent is removed", async () => {
    const issued = await (await fetch(`${base}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" })).json();
    const headers = { cookie: "uid=user-a", authorization: `Bearer ${issued.token}` };
    writeFileSync(optionsPath, JSON.stringify({ ...options, agents: ["replacement"] }));
    try {
      expect((await fetch(`${base}/chat`, { method: "POST", headers, body: JSON.stringify({ message: "hi", conversationId: "conversation_123" }) })).status).toBe(403);
      expect((await fetch(`${base}/history?conversationId=conversation_123`, { headers })).status).toBe(403);
    } finally { writeFileSync(optionsPath, JSON.stringify(options)); }
  });

  it("maps direct exchange and link errors without leaking Gateway details", async () => {
    try {
      for (const [code, status, expected] of [["RESOURCE_EXHAUSTED", 429, "rate_limited"], ["INVALID_ARGUMENT", 500, "identity_misconfigured"], ["SERVER_ONLY", 500, "identity_misconfigured"], ["NOT_FOUND", 500, "identity_misconfigured"]] as const) {
        failure = { route: "/v1/identity/sessions/exchange", code };
        const response = await fetch(`${base}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" });
        expect(response.status).toBe(status);
        const body = await response.json();
        expect(body.error.code).toBe(expected);
        expect(JSON.stringify(body)).not.toContain("private error");
      }
      failure = { route: "/v1/identity/sessions/exchange", code: "PERMISSION_DENIED", remediation: { action: "contact_admin", audience: "operator" } };
      expect((await fetch(`${base}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" })).status).toBe(500);
      failure = undefined;
      const issued = await (await fetch(`${base}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" })).json();
      for (const [code, status, expected] of [["RESOURCE_EXHAUSTED", 429, "rate_limited"], ["INVALID_ARGUMENT", 500, "identity_misconfigured"], ["SERVER_ONLY", 500, "identity_misconfigured"]] as const) {
        failure = { route: "/v1/identity/links", code };
        const response = await fetch(`${base}/link`, { method: "POST", headers: { cookie: "uid=user-a", authorization: `Bearer ${issued.token}` }, body: "{}" });
        expect(response.status).toBe(status);
        expect((await response.json()).error.code).toBe(expected);
      }
      failure = { route: "/v1/identity/links", code: "IDENTITY_LINK_REQUIRED", remediation: { action: "ask_user_to_dm", audience: "end_user" } };
      const response = await fetch(`${base}/link`, { method: "POST", headers: { cookie: "uid=user-a", authorization: `Bearer ${issued.token}` }, body: "{}" });
      expect((await response.json()).error.remediation).toEqual({ action: "ask_user_to_dm", audience: "end_user" });
    } finally { failure = undefined; }
  });

  it("preserves validated remediation from a Gateway WebSocket refusal", async () => {
    const issued = await (await fetch(`${base}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" })).json();
    wsFailure = { code: "IDENTITY_LINK_REQUIRED", message: "private gateway detail", remediation: { action: "ask_user_to_dm", audience: "end_user" } };
    try {
      const response = await fetch(`${base}/history?conversationId=conversation_123`, { headers: { cookie: "uid=user-a", authorization: `Bearer ${issued.token}` } });
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.remediation).toEqual({ action: "ask_user_to_dm", audience: "end_user" });
      expect(JSON.stringify(body)).not.toContain("private gateway detail");
    } finally { wsFailure = undefined; }
  });
});
