// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";

const image = "![Product](https://shop.example/photo.jpg)";
class ViewportObserver {
  static observers: ViewportObserver[] = [];
  target?: Element;
  constructor(private callback: IntersectionObserverCallback) { ViewportObserver.observers.push(this); }
  observe(target: Element) { this.target = target; }
  disconnect() { this.target = undefined; }
  enter() { if (this.target) this.callback([{ isIntersecting: true, target: this.target } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
}
beforeAll(() => defineDeweeChat());
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals(); ViewportObserver.observers = []; });

describe.each(["inline", "floating"])("Markdown images in %s mode", (mode) => {
  it("does not load an image repeatedly while a reply streams", async () => {
    vi.stubGlobal("IntersectionObserver", ViewportObserver);
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    let tickets = 0;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url, "https://site.test").pathname;
      if (path.endsWith("/config")) return json({ agents: [{ id: "support" }], defaultAgent: "support", maxMessageLength: 4000 });
      if (path.endsWith("/session")) return json({ visitorId: "visitor", token: "test", expiresAt: Date.now() + 86400000 });
      if (path.endsWith("/image-ticket")) { tickets++; return json({ ticket: "image_ticket" }); }
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }));
    const el = document.createElement("dewee-chat") as DeweeChatElement;
    el.setAttribute("mode", mode);
    el.setAttribute("image-origins", '["https://shop.example"]');
    document.body.appendChild(el);
    if (mode === "floating") el.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const send = el.send("show product");
    const emit = (event: unknown) => writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    emit({ type: "delta", text: image });
    await vi.waitFor(() => expect(el.shadowRoot!.textContent).toContain("Product"));
    expect(el.shadowRoot!.querySelector(".md img")).toBeNull();
    emit({ type: "delta", text: " in stock" });
    emit({ type: "done", content: `${image} in stock` });
    writer.close();
    await send;
    expect(el.shadowRoot!.querySelectorAll(".md img")).toHaveLength(1);
    ViewportObserver.observers.at(-1)?.enter();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tickets).toBe(1);
  });

  it("requests only visible history images and keeps them when the theme changes", async () => {
    vi.stubGlobal("IntersectionObserver", ViewportObserver);
    let tickets = 0;
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url, "https://site.test").pathname;
      if (path.endsWith("/config")) return json({ agents: [{ id: "support" }], defaultAgent: "support", maxMessageLength: 4000 });
      if (path.endsWith("/session")) return json({ visitorId: "visitor", token: "test", expiresAt: Date.now() + 86400000 });
      if (path.endsWith("/image-ticket")) { tickets++; return json({ ticket: "image_ticket" }); }
      if (path.endsWith("/history")) return json({ messages: [{ role: "assistant", content: Array.from({ length: 25 }, (_, i) => `![Product ${i}](https://shop.example/${i}.png)`).join("\n\n") }] });
      return json({});
    }));
    localStorage.setItem("dewee-webchat:conv:/api/dewee::support", "conversation_123");
    const el = document.createElement("dewee-chat") as DeweeChatElement;
    el.setAttribute("mode", mode); el.setAttribute("image-origins", '["https://shop.example"]');
    document.body.appendChild(el); if (mode === "floating") el.open();
    await vi.waitFor(() => expect(el.shadowRoot!.querySelectorAll(".md img")).toHaveLength(25));
    expect(tickets).toBe(0);
    for (const observer of ViewportObserver.observers.slice(0, 3)) observer.enter();
    await vi.waitFor(() => expect(tickets).toBe(3));
    const first = el.shadowRoot!.querySelector(".md img");
    el.configure({ theme: "dark", title: "New title" });
    expect(el.shadowRoot!.querySelector(".md img")).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(tickets).toBe(3);
  });

  it("uses the same policy for streamed replies and reloaded history", async () => {
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url, "https://site.test").pathname;
      if (path.endsWith("/config")) return json({ agents: [{ id: "support" }], defaultAgent: "support", maxMessageLength: 4000 });
      if (path.endsWith("/session")) return json({ visitorId: "visitor", token: "test", expiresAt: Date.now() + 86400000 });
      if (path.endsWith("/image-ticket")) return json({ ticket: "image_ticket" });
      if (path.endsWith("/history")) return json({ messages: [{ role: "assistant", content: image }] });
      return new Response(`data: ${JSON.stringify({ type: "done", content: image })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }));
    const mount = async () => {
      const el = document.createElement("dewee-chat") as DeweeChatElement;
      el.setAttribute("endpoint", "/api/dewee");
      el.setAttribute("mode", mode);
      el.setAttribute("image-origins", '["https://shop.example"]');
      document.body.appendChild(el);
      if (mode === "floating") el.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return el;
    };
    const first = await mount();
    await first.send("show product");
    expect(first.shadowRoot!.querySelectorAll(".md img")).toHaveLength(1);
    first.remove();
    const second = await mount();
    await vi.waitFor(() => expect(second.shadowRoot!.querySelectorAll(".md img")).toHaveLength(1));
    expect(second.shadowRoot!.querySelector(".md img")?.getAttribute("alt")).toBe("Product");
  });
});
