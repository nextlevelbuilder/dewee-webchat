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
  let pageContextSupported = false;
  let lastChat: any;
  let pageContextRefusal = false;
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
      if (frame.method === "chat.send") lastChat = frame.params;
      if (frame.method === "chat.send" && pageContextRefusal) { socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { code: "INVALID_REQUEST", message: "private page content", details: { reason: "page_context_invalid" } } })); return; }
      if (frame.method === "connect" && wsFailure) { socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: wsFailure })); return; }
      if (frame.method === "chat.send" && frame.params.message === "credential-test") {
        const ev = (type:string, payload:unknown) => socket.send(JSON.stringify({type:"event",event:"agent",payload:{type,sessionKey:frame.params.sessionKey,payload}}));
        ev("tool.call",{id:"safe",name:"search",arguments:{q:"visible"}}); ev("tool.result",{id:"safe",result:"public-result"});
        ev("tool.call",{id:"s1",name:"request_credentials",arguments:{value:"credential-argument-secret"}});
        ev("tool.call",{id:"s1",name:"search",arguments:{value:"reused-call-secret"}}); ev("tool.result",{id:"s1",result:"credential-result-secret"});
        ev("tool.result",{id:"unknown",result:"unmatched-result-secret"});
      }
      if (frame.method === "chat.history" && String(frame.params.sessionKey).includes("conv_cred")) {
        socket.send(JSON.stringify({type:"res",id:frame.id,ok:true,payload:{messages:[{role:"assistant",content:"",tool_calls:[{id:"s1",name:"request_credentials",arguments:{value:"credential-argument-secret"}},{id:"s1",name:"search",arguments:{value:"reused-call-secret"}},{name:"request_credentials"},{name:"search"},{id:"safe",name:"search",arguments:{q:"visible"}}]},{role:"tool",tool_call_id:"s1",content:"credential-result-secret"},{role:"tool",content:"missing-id-secret"},{role:"tool",tool_call_id:"safe",content:"public-result"}]}})); return;
      }
      const payload = frame.method === "connect" ? (applied ? { user_id: "tuc:principal-test", ...(pageContextSupported ? { page_context_versions: [1] } : {}) } : {}) : frame.method === "chat.history" ? { messages: [] } : { content: "hello" };
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

  it("keeps credential tool payloads out of legacy streams and history", async () => {
    const issued=await (await fetch(`${base}/session`,{method:"POST",headers:{cookie:"uid=user-a"},body:"{}"})).json();
    const headers={cookie:"uid=user-a",authorization:`Bearer ${issued.token}`};
    const response=await fetch(`${base}/chat`,{method:"POST",headers,body:JSON.stringify({message:"credential-test",agent:"support",conversationId:"conv_cred"})});
    const stream=await response.text();
    for (const secret of ["credential-argument-secret","reused-call-secret","credential-result-secret","unmatched-result-secret"]) expect(stream).not.toContain(secret);
    expect(stream).toContain("public-result");
    const history=await (await fetch(`${base}/history?agent=support&conversationId=conv_cred`,{headers})).text();
    expect(history).not.toContain("secret"); expect(history).toContain("public-result");
  });

  it("negotiates page context and binds it to the verified Gateway session", async () => {
    const issued = await (await fetch(`${base}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" })).json();
    const headers = { cookie: "uid=user-a", authorization: `Bearer ${issued.token}` };
    const page = { version: 1, url: "https://site.test/page", content: { format: "text", text: "A page", truncated: false } };
    const send = () => fetch(`${base}/chat`, { method: "POST", headers, body: JSON.stringify({ message: "hi", conversationId: "conversation_123", page_context: page }) });
    try {
      pageContextSupported = false;
      expect((await (await send()).json()).error.code).toBe("page_context_unsupported");
      pageContextSupported = true;
      expect((await (await fetch(`${base}/config?pageContext=1`)).json()).pageContextVersions).toEqual([1]);
      const response = await send(); await response.text();
      expect(response.status).toBe(200);
      expect(lastChat.pageContext).toEqual(page);
      expect(connects.at(-1)).toMatchObject({ identity_session: "identity-test" });
      expect(connects.at(-1)).not.toHaveProperty("user_id");
      pageContextRefusal = true;
      const refusal = await (await send()).text();
      expect(refusal).toContain('"code":"page_context_invalid"');
      expect(refusal).not.toContain("private page content");
    } finally { pageContextSupported = false; pageContextRefusal = false; }
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
