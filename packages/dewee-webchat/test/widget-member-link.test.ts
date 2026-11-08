// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";

beforeAll(() => defineDeweeChat());
afterEach(() => { document.body.innerHTML = ""; localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it("proves membership through a separate form without retaining the code in chat or storage", async () => {
  const code = "MEM-ABCDEFGHIJKLMNOP";
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site.test").pathname; calls.push(path);
    const json = (value: unknown) => Response.json(value);
    if (path.endsWith("/config")) return json({ identity: true, memberLinkProof: true, agents: [{id:"support"}], defaultAgent:"support", allowAgentSwitch:false, allowClientCredentials:false, maxMessageLength:4000, version:"test" });
    if (path.endsWith("/session")) return json({visitorId:"v1",token:"sealed-visitor",verified:true,expiresAt:Date.now()+60000});
    if (path.endsWith("/history")) return json({messages:[]});
    if (path.endsWith("/member-link-proof")) { expect(JSON.parse(String(init?.body))).toEqual({code}); return json({state:"proved"}); }
    throw new Error("unexpected route");
  }));
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  for (const [name, value] of Object.entries({endpoint:"/api/dewee",mode:"inline",persist:"false"})) el.setAttribute(name,value);
  document.body.append(el);
  const button = el.shadowRoot!.querySelector<HTMLButtonElement>(".member-link")!;
  await vi.waitFor(() => expect(button.hidden).toBe(false));
  const sent: unknown[] = [];
  el.addEventListener("dewee:send", (event) => sent.push((event as CustomEvent).detail));
  await el.send(`my code is ${code}`);
  expect(sent).toHaveLength(0);
  expect(el.shadowRoot!.textContent).not.toContain(code);
  button.click();
  await vi.waitFor(() => expect(el.shadowRoot!.querySelector(".member-link-dialog form")).not.toBeNull());
  const dialog = el.shadowRoot!.querySelector<HTMLFormElement>(".member-link-dialog form")!;
  const input = dialog.querySelector<HTMLInputElement>("input")!;
  input.value = code;
  dialog.dispatchEvent(new Event("submit", {bubbles:true,cancelable:true}));
  expect(input.value).toBe("");
  await vi.waitFor(() => expect(el.shadowRoot!.querySelector(".member-link-dialog")).toBeNull());
  expect(calls.filter((path) => path.endsWith("/member-link-proof"))).toHaveLength(1);
  expect(calls.filter((path) => path.endsWith("/chat"))).toHaveLength(0);
  for (const value of [el.shadowRoot!.innerHTML, JSON.stringify(localStorage), JSON.stringify(sessionStorage)]) expect(value).not.toContain(code);
});

it("asks anonymous visitors to sign in before showing the form, then allows it after session renewal", async () => {
  let signedIn = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(url, "https://site.test").pathname;
    if (path.endsWith("/config")) return Response.json({ identity:true, memberLinkProof:true, agents:[{id:"support"}], defaultAgent:"support", allowAgentSwitch:false, allowClientCredentials:false, maxMessageLength:4000, version:"test" });
    if (path.endsWith("/session")) return Response.json({visitorId:signedIn ? "member" : "visitor",token:"sealed-visitor",verified:signedIn,expiresAt:Date.now()+60000});
    if (path.endsWith("/history")) return Response.json({messages:[]});
    throw new Error("unexpected route");
  }));
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  for (const [name, value] of Object.entries({endpoint:"/api/dewee",mode:"inline",persist:"false"})) el.setAttribute(name,value);
  document.body.append(el);
  const button = el.shadowRoot!.querySelector<HTMLButtonElement>(".member-link")!;
  await vi.waitFor(() => expect(button.hidden).toBe(false));
  button.click();
  await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain("Sign in to this website"));
  expect(el.shadowRoot!.querySelector(".member-link-dialog")).toBeNull();
  signedIn = true;
  await el.renewSession();
  button.click();
  await vi.waitFor(() => expect(el.shadowRoot!.querySelector(".member-link-dialog form")).not.toBeNull());
});
