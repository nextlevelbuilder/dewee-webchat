import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyVisitorToken } from "../src/server";
import { verifyReuseHint } from "../src/server/security";
import { APP_ID, ASSERTION_SECRET, INTEGRATION_ID, INTEGRATION_SECRET, ISSUER, startFakeCcp, type FakeCcp } from "./helpers/fake-ccp-ingress";
import { forgeToken } from "./helpers/forge-token";

const php = process.env.PHP_BIN || "php";
const available = spawnSync(php, ["-v"]).status === 0;
const source = resolve(__dirname, "../../../php/dewee-webchat.php");
const secret = "fixture-visitor-secret-at-least-32-bytes";

describe.skipIf(!available)("PHP signed-in CCP sessions", () => {
  let ccp: FakeCcp, server: ChildProcess, base: string, temp: string;
  beforeAll(async () => {
    ccp = await startFakeCcp();
    const dir = mkdtempSync(join(tmpdir(), "webchat-identity-"));
    temp = join(dir, "tmp"); mkdirSync(temp);
    const options = { ccp: { chatUrl: ccp.url, integrationId: INTEGRATION_ID, integrationSecret: INTEGRATION_SECRET }, secret, rateLimit: false, allowedOrigins: '*', identity: { appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET, rebindEachRequest: true } };
    writeFileSync(join(dir, "options.json"), JSON.stringify(options));
    writeFileSync(join(dir, "router.php"), `<?php\nrequire ${JSON.stringify(source)};\n$o=json_decode(file_get_contents(__DIR__.'/options.json'),true);\nif (in_array(($_SERVER['HTTP_X_TEST_FEATURE'] ?? ''), ['on','support'], true)) $o['credentialRequests']=['formOrigin'=>'https://app.example'];\nif (($_SERVER['HTTP_X_TEST_FEATURE'] ?? '') === 'support') $o['identity']['agent']='support';\nif (($_SERVER['HTTP_X_TEST_FEATURE'] ?? '') === 'unicode') $o['credentialRequests']=['formOrigin'=>'https://bücher.example'];\nif (($_SERVER['HTTP_X_TEST_FEATURE'] ?? '') === 'punycode') $o['credentialRequests']=['formOrigin'=>'https://xn--bcher-kva.example'];\n$o['identity']['authenticate']=static function(){ $u=$_COOKIE['uid'] ?? null; if ($u === 'boom') throw new RuntimeException('private login error'); return $u ? ['subject'=>$u] : null; };\nif (str_ends_with($_SERVER['REQUEST_URI'], '/logout')) { $body=json_decode(file_get_contents('php://input'),true); DeweeWebchat::revoke($_COOKIE['uid'] ?? '', $body['token'] ?? '', $o); echo '{}'; return; }\nDeweeWebchat::handle($o);\n`);
    const port = await new Promise<number>((done) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });
    base = `http://127.0.0.1:${port}/api/dewee`;
    server = spawn(php, ["-d", `sys_temp_dir=${temp}`, "-S", `127.0.0.1:${port}`, join(dir, "router.php")], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try { await fetch(`${base}/config`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error("PHP server did not start");
  }, 30000);
  afterAll(async () => { server?.kill("SIGTERM"); await ccp?.close(); });
  beforeEach(() => { ccp.reset(); ccp.state.config = { ...ccp.state.config, mode: "signed_in_optional", identity_enabled: true }; for (const name of readdirSync(temp).filter(x => /^dewee-webchat-\d+$/.test(x))) for (const file of readdirSync(join(temp,name)).filter(x=>x.startsWith("ccp-config-"))) rmSync(join(temp,name,file),{force:true}); });
  const session = (uid?: string) => fetch(`${base}/session`, { method: "POST", headers: uid ? { cookie: `uid=${uid}` } : {}, body: "{}" });

  it("exchanges a signed-in host user and keeps other users isolated", async () => {
    const config = await (await fetch(`${base}/config`)).json();
    expect(config.identity).toBe(true);
    expect(config.allowAgentSwitch).toBe(false);
    const a = await (await session("user-a")).json();
    const b = await (await session("user-b")).json();
    expect(a.verified).toBe(true);
    expect(b.verified).toBe(true);
    const ca = await verifyVisitorToken(secret, a.token);
    const cb = await verifyVisitorToken(secret, b.token);
    expect(ca?.ids).toBeTruthy();
    expect(ca?.ids).not.toBe(cb?.ids);
    expect(ca?.v).not.toBe(cb?.v);
    expect(ccp.routes("identity/exchange")).toHaveLength(2);
    expect(JSON.stringify(a)).not.toContain(ca!.ids!);
  });

  it("requires an ASCII credential form origin and accepts punycode", async () => {
    expect((await fetch(`${base}/config`, {headers:{"x-test-feature":"unicode"}})).status).toBe(500);
    expect((await fetch(`${base}/config`, {headers:{"x-test-feature":"punycode"}})).status).toBe(200);
  });

  it("fails closed when the host login check throws", async () => {
    const response = await session("boom");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private login error");
    expect(ccp.routes("identity/exchange")).toHaveLength(0);
  });

  it.each([
    ["IDENTITY_REQUIRED", 401], ["LINK_EXPIRED", 401], ["LINK_REVOKED", 401],
    ["IDENTITY_LINK_REQUIRED", 403], ["PERMISSION_DENIED", 403], ["IDENTITY_CONFLICT", 409], ["SOURCE_UNAVAILABLE", 503],
  ] as const)("forwards %s without exposing upstream details", async (code, status) => {
    ccp.state.failNext.set("identity/exchange", { status, code, message: "private upstream detail" });
    const response = await session("user-a");
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe(code);
    expect(text).not.toContain("private upstream detail");
    expect(text).not.toContain(ASSERTION_SECRET);
  });

  it("binds chat and history to the verified user and agent", async () => {
    const issued = await (await session("user-a")).json();
    const claims = await verifyVisitorToken(secret, issued.token);
    const send = (cookie: string, token = issued.token, agent = "shop") => fetch(`${base}/chat`, { method: "POST", headers: { cookie: `uid=${cookie}`, authorization: `Bearer ${token}` }, body: JSON.stringify({ message: "hello", conversationId: "conv_php_ident_1", agent }) });
    expect((await send("user-a", forgeToken(issued.token))).status).toBe(401);
    expect((await send("user-a", issued.token, "other")).status).toBe(403);
    const response = await send("user-a");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"type":"done"');
    expect(ccp.routes("chat").at(-1)?.body.identity_session).toBe(claims?.ids);
    const history = await fetch(`${base}/history?agent=shop&conversationId=conv_php_ident_1`, { headers: { cookie: "uid=user-a", authorization: `Bearer ${issued.token}` } });
    expect(history.status).toBe(200);
    expect(ccp.routes("history").at(-1)?.body.identity_session).toBe(claims?.ids);
    expect((await send("user-b")).status).toBe(401);
    expect(ccp.routes("identity/revoke")).toHaveLength(1);
  });

  it("mirrors the hosted credential request contract without exposing values", async () => {
    ccp.state.config = { ...ccp.state.config, credential_requests: true };
    const id = "0b7e4c1e-2f6a-4d1b-9c3e-5a8f7d6e4b21";
    const card = { id, schema_version: "webchat-credential-request.v1", status: "pending", title: "Connect", purpose: "Provide key", target: { type: "provider", mode: "create" }, fields: [{ key: "api_key", label: "Key", kind: "secret", required: true, value: "never-forward" }], expires_at: new Date(Date.now()+3600000).toISOString(), agent_key: "shop", completion: "hosted", resumable: false };
    ccp.state.credentialCard = card;
    const issued = await (await session("user-a")).json();
    const headers = { cookie: "uid=user-a", origin: "https://shop.example", authorization: `Bearer ${issued.token}`, "x-test-feature": "on" };
    const chat = await fetch(`${base}/chat`, { method: "POST", headers, body: JSON.stringify({ message: "hello", conversationId: "conv_php_cred_1", agent: "shop" }) });
    expect(chat.headers.get("cache-control")).toContain("no-store");
    const text = await chat.text(); expect(text).toContain('"type":"credential_request"'); expect(text).not.toContain("never-forward");
    const history = await fetch(`${base}/history?agent=shop&conversationId=conv_php_cred_1`, { headers });
    const stored = await history.json(); expect(stored.credentialRequests[0].id).toBe(id); expect(JSON.stringify(stored)).not.toContain("never-forward");
    const body = JSON.stringify({ agent: "shop", conversationId: "conv_php_cred_1", credentialRequestId: id });
    const status = await fetch(`${base}/credential-request`, { method: "POST", headers, body });
    expect(status.status).toBe(200); expect((await status.json()).credentialRequest.id).toBe(id);
    const foreign = await fetch(`${base}/credential-request`, { method: "POST", headers, body: JSON.stringify({ agent: "shop", conversationId: "foreign_conv_1", credentialRequestId: id }) });
    expect(foreign.status).toBe(404); expect((await foreign.json()).error.code).toBe("credential_request_not_found");
    const handoff = await fetch(`${base}/credential-request-handoff`, { method: "POST", headers, body });
    expect(handoff.status).toBe(200); expect(handoff.headers.get("cache-control")).toBe("no-store"); expect((await handoff.json()).url).toBe("https://app.example/credential-requests/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const resume = await fetch(`${base}/chat`, { method: "POST", headers, body: JSON.stringify({ agent: "shop", conversationId: "conv_php_cred_1", message: "", credentialRequestId: id }) });
    expect(resume.status).toBe(200); await resume.text(); expect(ccp.routes("chat").at(-1)?.body).toMatchObject({ message: "", credential_request_id: id });
    expect((await fetch(`${base}/chat`, { method: "POST", headers, body: JSON.stringify({ agent: "shop", conversationId: "conv_php_cred_1", message: "do not accept", credentialRequestId: id }) })).status).toBe(400);
    ccp.state.credentialHandoffUrl = "https://evil.example/credential-requests/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect((await fetch(`${base}/credential-request-handoff`, { method: "POST", headers, body })).status).toBe(502);
    expect((await fetch(`${base}/credential-request`, { method: "POST", headers: { ...headers, cookie: "uid=user-b" }, body })).status).toBe(401);
  });

  it("requires the current identity for member proof and keeps the code out of chat", async () => {
    ccp.state.config = { ...ccp.state.config, member_link_proof: true };
    const issued = await (await session("user-a")).json();
    const headers = { cookie:"uid=user-a", origin:"https://shop.example", authorization:`Bearer ${issued.token}`, "x-test-feature":"on" };
    const config = await (await fetch(`${base}/config`, {headers})).json();
    expect(config.memberLinkProof).toBe(true);
    const code = "MEM-ABCDEFGHIJKLMNOP";
    const proof = await fetch(`${base}/member-link-proof`, {method:"POST",headers,body:JSON.stringify({code})});
    expect(proof.status).toBe(200); expect(await proof.json()).toEqual({state:"proved"});
    expect(ccp.routes("identity/member-link-proof").at(-1)?.body).toMatchObject({agent:"shop",code});
    expect((await fetch(`${base}/member-link-proof`, {method:"POST",headers:{...headers,cookie:"uid=user-b"},body:JSON.stringify({code})})).status).toBe(401);
    const chat = await fetch(`${base}/chat`, {method:"POST",headers,body:JSON.stringify({agent:"shop",conversationId:"conversation_01",message:`my code ${code}`})});
    expect(chat.status).toBe(400); expect(await chat.text()).not.toContain(code); expect(ccp.routes("chat")).toHaveLength(0);
    const page = await fetch(`${base}/chat`, {method:"POST",headers,body:JSON.stringify({agent:"shop",conversationId:"conversation_01",message:"help",page_context:{version:1,url:"https://shop.example",content:{format:"text",text:code}}})});
    expect(page.status).toBe(400); expect(ccp.routes("chat")).toHaveLength(0);
  });

  it.each([false, true])("defers selected-agent credential policy to the runtime when default capability is %s", async (defaultEnabled) => {
    ccp.state.config = { ...ccp.state.config, credential_requests: defaultEnabled };
    const id = "0b7e4c1e-2f6a-4d1b-9c3e-5a8f7d6e4b21";
    ccp.state.credentialCard = { id, schema_version:"webchat-credential-request.v1", status:"pending", title:"Connect", purpose:"Key", target:{type:"provider",mode:"create"}, fields:[], expires_at:new Date(Date.now()+3600000).toISOString(), agent_key:"support", completion:"hosted", resumable:false };
    const issued = await (await fetch(`${base}/session`, { method:"POST", headers:{cookie:"uid=user-a", "x-test-feature":"support"}, body:"{}" })).json();
    const headers = {cookie:"uid=user-a", origin:"https://shop.example", authorization:`Bearer ${issued.token}`, "x-test-feature":"support"};
    const chat = await fetch(`${base}/chat`, {method:"POST",headers,body:JSON.stringify({agent:"support",conversationId:"conv_php_agent_1",message:"hi"})});
    expect(await chat.text()).toContain('"type":"credential_request"');
    if (defaultEnabled) ccp.state.failNext.set("credential-request", {status:403,code:"credential_requests_unavailable"});
    const status = await fetch(`${base}/credential-request`, {method:"POST",headers,body:JSON.stringify({agent:"support",conversationId:"conv_php_agent_1",credentialRequestId:id})});
    expect(status.status).toBe(defaultEnabled ? 403 : 200);
  });

  it("starts account linking only for the authenticated session", async () => {
    const issued = await (await session("user-a")).json();
    const response = await fetch(`${base}/link`, { method: "POST", headers: { cookie: "uid=user-a", authorization: `Bearer ${issued.token}` }, body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ proofCode: "482913", deepLinks: [{ channelType: "telegram" }] });
    expect(ccp.routes("link")[0].body.identity_session).toBe((await verifyVisitorToken(secret, issued.token))?.ids);
    expect((await fetch(`${base}/link`, { method: "POST", headers: { authorization: `Bearer ${issued.token}` }, body: "{}" })).status).toBe(401);
  });

  it("mints job access only for the current user and a canonical origin", async () => {
    const issued = await (await session("user-a")).json();
    const claims = await verifyVisitorToken(secret, issued.token);
    const request = (cookie: string, origin: string, body: unknown = {}) => fetch(`${base}/job-access`, {
      method: "POST", headers: { cookie: `uid=${cookie}`, origin, authorization: `Bearer ${issued.token}` }, body: JSON.stringify(body),
    });
    for (const origin of ["http://shop.example", "https://shop.example/", "https://shop.example:443", "https://user@shop.example"]) {
      expect((await request("user-a", origin)).status).toBe(403);
    }
    expect((await request("user-a", "https://shop.example", { agent: "other" })).status).toBe(400);
    expect(ccp.routes("job-access")).toHaveLength(0);
    const response = await request("user-a", "https://shop.example");
    expect(response.status).toBe(200);
    const launch = await response.json();
    expect(launch.bootstrap_url).toBe("https://access.example/identity/job-access/launch");
    expect(launch.launch_token).toBe("one_time_ticket_0123456789");
    expect(ccp.routes("job-access")[0].body).toEqual({ identity_session: claims?.ids, agent: "shop" });
    expect(JSON.stringify(launch)).not.toContain(claims!.ids!);
    expect((await request("user-b", "https://shop.example")).status).toBe(401);
  });

  it("refreshes an expired ingress session when exchanging identity", async () => {
    ccp.state.failNext.set("identity/exchange", { status: 401, code: "ingress_session_expired" });
    const response = await session("user-a");
    expect(response.status).toBe(200);
    expect(ccp.routes("identity/exchange")).toHaveLength(2);
    const claims = await verifyVisitorToken(secret, (await response.json()).token);
    expect(claims?.es).toBeTruthy();
  });

  it("revokes only a logout token belonging to the authenticated subject", async () => {
    const issued = await (await session("user-a")).json();
    const logout = (user: string, token: string) => fetch(`${base}/logout`, { method: "POST", headers: { cookie: `uid=${user}` }, body: JSON.stringify({ token }) });
    await logout("user-b", issued.reuseHint);
    await logout("user-a", `${issued.reuseHint}tampered`);
    expect(ccp.routes("identity/revoke")).toHaveLength(0);
    await logout("user-a", issued.reuseHint);
    expect(ccp.routes("identity/revoke")).toHaveLength(1);
    const chat = await fetch(`${base}/chat`, { method: "POST", headers: { cookie: "uid=user-a", authorization: `Bearer ${issued.token}` }, body: JSON.stringify({ message: "hi", agent: "shop", conversationId: "conv_php_ident_1" }) });
    expect(chat.status).toBe(401);
  });

  it.each(["operator", "integrator"])("reports %s exchange remediation as server misconfiguration", async (audience) => {
    ccp.state.failNext.set("identity/exchange", { status: 403, code: "PERMISSION_DENIED", remediation: { action: "contact_admin", audience } });
    const response = await session("user-a");
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("identity_misconfigured");
  });

  it("reuses a same-user CCP hint but never treats it as a bearer token", async () => {
    const first = await (await session("user-a")).json();
    expect(await verifyVisitorToken(secret, first.reuseHint)).toBeNull();
    expect((await verifyReuseHint(secret, first.reuseHint))?.ids).toBeTruthy();
    const again = await fetch(`${base}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: JSON.stringify({ reuseHint: first.reuseHint }) });
    const second = await again.json();
    expect((await verifyVisitorToken(secret, second.token))?.ids).toBe((await verifyVisitorToken(secret, first.token))?.ids);
    expect(ccp.routes("identity/exchange")).toHaveLength(1);
    const switched = await fetch(`${base}/session`, { method: "POST", headers: { cookie: "uid=user-b" }, body: JSON.stringify({ reuseHint: first.reuseHint }) });
    expect((await verifyVisitorToken(secret, (await switched.json()).token))?.ids).not.toBe((await verifyVisitorToken(secret, first.token))?.ids);
  });
});
