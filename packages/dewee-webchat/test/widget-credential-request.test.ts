// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";

const id = "0b7e4c1e-2f6a-4d1b-9c3e-5a8f7d6e4b21";
const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const card = () => ({id,schema_version:"webchat-credential-request.v1",status:"pending",title:"Connect provider",purpose:"Allow access",target:{type:"provider",mode:"create"},fields:[{key:"api_key",label:"API key",kind:"secret",required:true}],expires_at:new Date(Date.now()+3600000).toISOString(),agent_key:"support",completion:"hosted",resumable:false});
beforeAll(() => defineDeweeChat());
afterEach(() => {document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();});

function backend() {
  let statusCalls = 0;
  const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{"content-type":"application/json"}});
  const calls:Array<{path:string,body:any}>=[];
  vi.stubGlobal("fetch",vi.fn(async (url:string,init?:RequestInit)=>{
    const path=new URL(url,"https://site.test").pathname; const body=init?.body ? JSON.parse(String(init.body)):null; calls.push({path,body});
    if(path.endsWith("/config")) return json({identity:true,credentialFormOrigin:"https://app.example",agents:[{id:"support"}],defaultAgent:"support",maxMessageLength:4000});
    if(path.endsWith("/session")) return json({visitorId:"visitor1",token:"visitor-token",verified:true,expiresAt:Date.now()+3600000});
    if(path.endsWith("/history")) return json({messages:[],credentialRequests:[card()]});
    if(path.endsWith("/credential-request-handoff")) return json({credential_request_id:id,url:`https://app.example/credential-requests/open?token=${secret}`,expires_at:new Date(Date.now()+600000).toISOString()});
    if(path.endsWith("/credential-request")) { statusCalls++; return json({credentialRequest:{...card(),status:statusCalls===1?"applying":"resolved",resumable:statusCalls>1}}); }
    if(path.endsWith("/credential-request-cancel")) return json({credentialRequest:{...card(),status:"cancelled"}});
    if(path.endsWith("/chat")) return new Response(`data: ${JSON.stringify({type:"credential_request",credentialRequest:card()})}\n\ndata: ${JSON.stringify({type:"done",content:"Done"})}\n\n`,{headers:{"content-type":"text/event-stream"}});
    throw new Error(`unexpected ${path}`);
  }));
  return calls;
}
async function mount(mode:string) {const el=document.createElement("dewee-chat") as DeweeChatElement; el.setAttribute("mode",mode);el.setAttribute("persist","false");const ready=new Promise<void>(resolve=>el.addEventListener("dewee:ready",()=>resolve(),{once:true}));document.body.append(el);if(mode==="floating") el.open();await ready;await el.send("hello");return el;}

describe.each(["inline","floating"])("credential card in %s mode", mode=>{
  it("shows only metadata, pins handoff to a popup, polls applying until resolved, and cleans up", async()=>{
    const calls=backend(); const el=await mount(mode);
    expect(el.shadowRoot!.querySelector(".credential-request")?.textContent).toContain("API key (required)");
    const popupDoc=document.implementation.createHTMLDocument("handoff");
    const popup={closed:false,opener:window,document:popupDoc,location:{replace:vi.fn()},close:vi.fn()};
    vi.spyOn(window,"open").mockReturnValue(popup as unknown as Window);
    vi.useFakeTimers();
    const button=el.shadowRoot!.querySelector<HTMLButtonElement>(".credential-actions button")!; button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.opener).toBeNull(); expect(popup.location.replace).toHaveBeenCalledWith(`https://app.example/credential-requests/open?token=${secret}`);
    expect(el.shadowRoot!.textContent).not.toContain(secret); expect(document.body.innerHTML).not.toContain(secret);
    expect(JSON.stringify({...localStorage,...sessionStorage})).not.toContain(secret);
    await vi.advanceTimersByTimeAsync(4000); expect(el.shadowRoot!.textContent).toContain("Processing");
    await vi.advanceTimersByTimeAsync(4000); expect(el.shadowRoot!.textContent).toContain("Completed");
    expect(el.shadowRoot!.textContent).toContain("Continue conversation");
    expect(calls.filter(x=>x.path.endsWith("/credential-request"))).toHaveLength(2);
    el.newConversation(); expect(popup.close).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

it("restores a card from history without persisting its metadata", async () => {
  backend(); localStorage.setItem("dewee-webchat:conv:/api/dewee::support", "conversation_01");
  const el=document.createElement("dewee-chat") as DeweeChatElement; el.setAttribute("mode","inline");
  const ready=new Promise<void>(resolve=>el.addEventListener("dewee:ready",()=>resolve(),{once:true})); document.body.append(el); await ready;
  expect(el.shadowRoot!.querySelector(".credential-request")?.textContent).toContain("Connect provider");
  expect(JSON.stringify({...localStorage,...sessionStorage})).not.toContain("Connect provider");
});

it("aborts a pending handoff and closes its popup when the conversation changes", async () => {
  backend(); const original=globalThis.fetch; let finish!: (r:Response)=>void; let requestSignal:AbortSignal|undefined;
  vi.stubGlobal("fetch",vi.fn((url:string,init?:RequestInit) => {
    if (String(url).endsWith("/credential-request-handoff")) { requestSignal=init?.signal ?? undefined; return new Promise<Response>(resolve=>{finish=resolve;}); }
    return original(url,init);
  }));
  const el=await mount("inline");
  const popup={closed:false,opener:window,document:document.implementation.createHTMLDocument("handoff"),location:{replace:vi.fn()},close:vi.fn()};
  vi.spyOn(window,"open").mockReturnValue(popup as unknown as Window);
  el.shadowRoot!.querySelector<HTMLButtonElement>(".credential-actions button")!.click();
  await vi.waitFor(()=>expect(requestSignal).toBeDefined()); el.newConversation();
  expect(requestSignal!.aborted).toBe(true); expect(popup.close).toHaveBeenCalledOnce();
  finish(Response.json({credential_request_id:id,url:`https://app.example/credential-requests/open?token=${secret}`,expires_at:new Date(Date.now()+600000).toISOString()}));
  await new Promise(resolve=>setTimeout(resolve,0)); expect(popup.location.replace).not.toHaveBeenCalled();
});

it("does not mint a handoff when the popup is blocked and can cancel the request", async () => {
  const calls=backend(); const el=await mount("inline");
  vi.spyOn(window,"open").mockReturnValue(null);
  el.shadowRoot!.querySelector<HTMLButtonElement>(".credential-actions button")!.click();
  expect(calls.filter(x=>x.path.endsWith("/credential-request-handoff"))).toHaveLength(0);
  const buttons=el.shadowRoot!.querySelectorAll<HTMLButtonElement>(".credential-actions button"); buttons[1].click();
  await vi.waitFor(()=>expect(el.shadowRoot!.textContent).toContain("Cancelled"));
  expect(calls.filter(x=>x.path.endsWith("/credential-request-cancel"))).toHaveLength(1);
});
