import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDeweeHandler } from "../src/server";
import { deweeIdentitySdk } from "../src/server/identity";
import { CcpError } from "../src/server/ccp-client";
import { browserErrorFor } from "../src/server/ccp-transport";
import { APP_ID, ASSERTION_SECRET, INTEGRATION_ID, INTEGRATION_SECRET, ISSUER, startFakeCcp, type FakeCcp } from "./helpers/fake-ccp-ingress";

const base = "https://shop.example/api/dewee";
const id = "0b7e4c1e-2f6a-4d1b-9c3e-5a8f7d6e4b21";
const card = { id, schema_version: "webchat-credential-request.v1", status: "pending", title: "Connect", purpose: "Provide key", target: {type:"provider",mode:"create"}, fields: [{key:"api_key",label:"Key",kind:"secret",required:true}], expires_at: new Date(Date.now()+3600000).toISOString(), agent_key:"shop", completion:"hosted", resumable:false };
let ccp: FakeCcp;
let calls: Array<{ route: string; headers: Headers; body: any }>;
let malicious = false;
let agentDisabled = false;
beforeAll(async () => { ccp = await startFakeCcp(); });
afterAll(async () => { await ccp.close(); });
beforeEach(() => { ccp.reset(); ccp.state.config = {...ccp.state.config, mode:"signed_in_optional", identity_enabled:true, credential_requests:true}; calls=[]; malicious=false; agentDisabled=false; });
function handler(enabled=true, identityAgent?:string, formOrigin="https://app.example") {
  const customFetch: typeof fetch = async (input, init) => {
    const url=String(input); const route=url.split("/").pop()!;
    if (route.startsWith("credential-request")) {
      const body=JSON.parse(String(init?.body)); calls.push({route,headers:new Headers(init?.headers),body});
      if (agentDisabled) return Response.json({error:{code:"credential_requests_unavailable",message:"private"}},{status:403});
      if (route === "credential-request-handoff") return Response.json({credential_request_id:id,url: malicious ? "https://evil.example/credential-requests/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" : "https://app.example/credential-requests/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",expires_at:card.expires_at});
      return Response.json({credential_request:{...card, value:"must-not-leak"}});
    }
    return fetch(input,init);
  };
  return createDeweeHandler({ccp:{chatUrl:ccp.url,integrationId:INTEGRATION_ID,integrationSecret:INTEGRATION_SECRET,fetch:customFetch},secret:"visitor-secret-NEVER-IN-BROWSER-00000000001",rateLimit:false,
    identity:{sdk:deweeIdentitySdk,authenticate: async req => req.headers.get("cookie") === "uid=alice" ? {subject:"alice"}:null, appId:APP_ID,issuer:ISSUER,assertionSecret:ASSERTION_SECRET,...(identityAgent ? {agent:identityAgent}: {})},
    ...(enabled ? {credentialRequests:{formOrigin}} : {})});
}
async function session(h:ReturnType<typeof handler>, signed=true) {
  const r=await h(new Request(base+"/session",{method:"POST",headers:signed?{cookie:"uid=alice"}:{},body:"{}"})); return (await r.json()).token as string;
}
function request(token:string, route:string, extraHeaders:Record<string,string>={}, body:unknown={agent:"shop",conversationId:"conversation_01",credentialRequestId:id}) {
  return new Request(base+"/"+route,{method:"POST",headers:{authorization:`Bearer ${token}`,origin:"https://shop.example",cookie:"uid=alice",...extraHeaders},body:JSON.stringify(body)});
}

describe("CCP credential handoff", () => {
  it("submits member proof only for the current signed-in user without sending it to chat", async () => {
    ccp.state.config = {...ccp.state.config, member_link_proof: true};
    const h = handler(); const token = await session(h); const code = "MEM-ABCDEFGHIJKLMNOP";
    const config = await (await h(new Request(`${base}/config`))).json();
    expect(config.memberLinkProof).toBe(true);
    const ok = await h(request(token, "member-link-proof", {}, { code }));
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({state:"proved"});
    expect(ccp.routes("identity/member-link-proof").at(-1)?.body).toMatchObject({agent:"shop", code});
    expect((await h(request(token, "member-link-proof", {cookie:"uid=bob"}, {code}))).status).toBeGreaterThanOrEqual(400);
    expect((await h(request(token, "member-link-proof", {}, {code:"bad"}))).status).toBe(400);
    const blocked = await h(request(token, "chat", {}, {agent:"shop",conversationId:"conversation_01",message:`my code ${code}`}));
    expect(blocked.status).toBe(400); expect(await blocked.text()).not.toContain(code); expect(ccp.routes("chat")).toHaveLength(0);
    const page = await h(request(token, "chat", {}, {agent:"shop",conversationId:"conversation_01",message:"help",page_context:{version:1,url:"https://shop.example",content:{format:"text",text:code}}}));
    expect(page.status).toBe(400); expect(ccp.routes("chat")).toHaveLength(0);
  });
  it("requires an ASCII HTTPS origin, allowing explicit punycode", () => {
    expect(()=>handler(true,undefined,"https://bücher.example")).toThrow(/ASCII HTTPS origin/);
    expect(()=>handler(true,undefined,"https://%61pp.example")).toThrow(/ASCII HTTPS origin/);
    expect(()=>handler(true,undefined,"https://xn--bcher-kva.example")).not.toThrow();
  });
  it.each([["credential_requests_unavailable",403],["credential_request_not_found",404],["credential_request_not_ready",409],["credential_request_resumed",409]] as const)("preserves safe refusal %s", (code,status) => {
    expect(browserErrorFor(new CcpError(status,code,"private upstream text"),"credential-request")).toEqual({status,code,message:expect.not.stringContaining("private upstream text")});
  });
  it("requires explicit opt-in, verified login, matching user and allowed origin", async () => {
    const off=handler(false); const signed=await session(off); expect((await off(request(signed,"credential-request"))).status).toBe(404);
    const h=handler(); const anonymous=await session(h,false); expect((await h(request(anonymous,"credential-request"))).status).toBe(401);
    const token=await session(h); expect((await h(request(token,"credential-request",{cookie:"uid=bob"}))).status).toBeGreaterThanOrEqual(400);
    expect((await h(request(token,"credential-request",{origin:"https://evil.example"}))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it("forwards verified identity only to CCP, filters the card, pins the destination and uses no-store", async () => {
    const h=handler(); const token=await session(h);
    const status=await h(request(token,"credential-request")); const data=await status.json();
    expect(status.status).toBe(200); expect(status.headers.get("cache-control")).toBe("no-store");
    expect(data.credentialRequest).toEqual(card); expect(JSON.stringify(data)).not.toContain("must-not-leak");
    expect(calls[0].headers.get("x-dewee-webchat-features")).toBe("credential-requests"); expect(calls[0].body.identity_session).toMatch(/^idsess_/);
    const handoff=await h(request(token,"credential-request-handoff")); expect(handoff.status).toBe(200);
    expect((await handoff.json()).url).toBe("https://app.example/credential-requests/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    malicious=true; const bad=await h(request(token,"credential-request-handoff")); expect(bad.status).toBe(502); expect(await bad.text()).not.toContain("evil.example");
    expect((await h(request(token,"credential-request",{}, {agent:"support",conversationId:"conversation_01",credentialRequestId:id}))).status).toBe(403);
  });
  it("forwards authorized metadata in SSE and history and resumes with no chat text", async () => {
    const h=handler(); const token=await session(h);
    ccp.state.credentialCard = { ...card, fields: [{ ...card.fields[0], value: "never-forward" }] };
    const headers = { authorization:`Bearer ${token}`, origin:"https://shop.example", cookie:"uid=alice" };
    const chat = await h(new Request(`${base}/chat`, { method:"POST", headers, body:JSON.stringify({ agent:"shop", conversationId:"conversation_01", message:"hello" }) }));
    expect(chat.headers.get("cache-control")).toContain("no-store");
    const stream = await chat.text(); expect(stream).toContain('"type":"credential_request"'); expect(stream).not.toContain("never-forward");
    const history = await h(new Request(`${base}/history?agent=shop&conversationId=conversation_01`, { headers }));
    expect((await history.json()).credentialRequests[0].id).toBe(id);
    const resume = await h(request(token,"chat",{}, {agent:"shop",conversationId:"conversation_01",message:"",credentialRequestId:id}));
    expect(resume.status).toBe(200); await resume.text();
    expect(ccp.routes("chat").at(-1)?.body).toMatchObject({message:"",conversation_id:"conversation_01",credential_request_id:id});
    expect(ccp.routes("chat").at(-1)?.headers["x-dewee-webchat-features"]).toBe("credential-requests");
    const before=ccp.routes("chat").length;
    expect((await h(request(token,"chat",{}, {agent:"shop",conversationId:"conversation_01",message:"secret",credentialRequestId:id}))).status).toBe(400);
    expect(ccp.routes("chat")).toHaveLength(before);
  });
  it("lets the runtime authorize the selected agent even when default-agent capability differs", async () => {
    ccp.state.config = {...ccp.state.config,credential_requests:false};
    const h=handler(true,"support"); const token=await session(h);
    ccp.state.credentialCard = {...card,agent_key:"support"};
    const headers = { authorization:`Bearer ${token}`, origin:"https://shop.example", cookie:"uid=alice" };
    const chat=await h(new Request(`${base}/chat`,{method:"POST",headers,body:JSON.stringify({agent:"support",conversationId:"conversation_01",message:"hello"})}));
    expect(await chat.text()).toContain('"type":"credential_request"');
    ccp.state.config = {...ccp.state.config,credential_requests:true}; agentDisabled=true;
    const other=handler(true,"support"); const otherToken=await session(other);
    const denied=await other(request(otherToken,"credential-request",{}, {agent:"support",conversationId:"conversation_01",credentialRequestId:id}));
    expect(denied.status).toBe(403); expect((await denied.json()).error.code).toBe("credential_requests_unavailable");
  });
});
