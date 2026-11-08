// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";

beforeAll(() => defineDeweeChat());
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals(); });

describe.each(["inline", "floating"])("page context in %s mode", (mode) => {
  it("requires consent per message and invalidates a changed page", async () => {
    document.body.innerHTML = "<main><h1>Article</h1><p>First version</p><form><input value='password'></form></main>";
    const sent: any[] = [];
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "https://site.test").pathname;
      if (path.endsWith("/config")) return json({ agents: [{ id: "support" }], defaultAgent: "support", maxMessageLength: 4000, pageContextVersions: [1] });
      if (path.endsWith("/session")) return json({ visitorId: "visitor", token: "test", expiresAt: Date.now() + 86400000 });
      if (path.endsWith("/chat")) sent.push(JSON.parse(String(init?.body)));
      return new Response(`data: ${JSON.stringify({ type: "done", content: "ok" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }));
    const el = document.createElement("dewee-chat") as DeweeChatElement;
    el.setAttribute("mode", mode); el.setAttribute("page-context", "content");
    document.body.appendChild(el); if (mode === "floating") el.open();
    await vi.waitFor(() => expect(el.shadowRoot!.querySelector<HTMLElement>(".page-context")!.hidden).toBe(false));
    await el.send("normal");
    expect(sent[0].page_context).toBeUndefined();
    const choice = el.shadowRoot!.querySelector<HTMLInputElement>(".page-choice")!;
    choice.checked = true; choice.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(el.shadowRoot!.querySelector(".page-preview")!.textContent).toContain("First version"));
    document.querySelector("main p")!.textContent = "Changed version";
    await el.send("needs review");
    expect(sent).toHaveLength(1);
    expect(choice.checked).toBe(false);
    choice.checked = true; choice.dispatchEvent(new Event("change"));
    await vi.waitFor(() => { expect(choice.disabled).toBe(false); expect(el.shadowRoot!.querySelector(".page-preview")!.textContent).toContain("Changed version"); });
    await el.send("share");
    expect(sent[1].page_context.content.text).toContain("Changed version");
    expect(JSON.stringify(sent[1].page_context)).not.toContain("password");
    expect(choice.checked).toBe(false);
    await el.send("next");
    expect(sent[2].page_context).toBeUndefined();
  });
  it("does not send context after consent is withdrawn during an async refresh", async () => {
    document.body.innerHTML = "<main>Article</main>";
    const sent: any[] = [];
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "https://site.test").pathname;
      if (path.endsWith("/config")) return json({ agents: [{ id: "support" }], defaultAgent: "support", maxMessageLength: 4000, pageContextVersions: [1] });
      if (path.endsWith("/session")) return json({ visitorId: "visitor", token: "test", expiresAt: Date.now() + 86400000 });
      if (path.endsWith("/chat")) sent.push(JSON.parse(String(init?.body)));
      return new Response('data: {"type":"done","content":"ok"}\n\n', { headers: { "content-type": "text/event-stream" } });
    }));
    let resolveSecond!: (value: any) => void;
    const provider = vi.fn().mockResolvedValueOnce({ content: { format: "text", text: "preview" } }).mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const el = document.createElement("dewee-chat") as DeweeChatElement;
    el.setAttribute("mode", mode); el.configure({ pageContext: "content", contextProvider: provider });
    document.body.appendChild(el); if (mode === "floating") el.open();
    await vi.waitFor(() => expect(el.shadowRoot!.querySelector<HTMLElement>(".page-context")!.hidden).toBe(false));
    const choice = el.shadowRoot!.querySelector<HTMLInputElement>(".page-choice")!;
    choice.checked = true; choice.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(el.shadowRoot!.querySelector(".page-preview")!.textContent).toContain("preview"));
    const pending = el.send("share");
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
    choice.checked = false; choice.dispatchEvent(new Event("change"));
    resolveSecond({ content: { format: "text", text: "preview" } });
    await pending;
    expect(sent).toHaveLength(0);
    await el.send("normal");
    expect(sent[0].page_context).toBeUndefined();
  });
});
