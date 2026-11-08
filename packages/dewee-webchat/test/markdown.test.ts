// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "../src/widget/markdown";

const html = (md: string) => {
  const div = document.createElement("div");
  div.appendChild(renderMarkdown(document, md));
  return div.innerHTML;
};
const imageProxy = async (source: string) => `https://api.example/chat/image?source=${encodeURIComponent(source)}`;
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("renderMarkdown", () => {
  it("renders approved images and refuses unapproved sources", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.appendChild(renderMarkdown(document, "![Product](https://shop.example/photo.jpg) ![Other](https://other.example/photo.jpg)", { imageOrigins: ["https://shop.example"], imageProxy }));
    await Promise.resolve();
    const image = div.querySelector("img")!;
    expect(div.querySelectorAll("img")).toHaveLength(1);
    expect(image.src).toBe("https://api.example/chat/image?source=https%3A%2F%2Fshop.example%2Fphoto.jpg");
    expect(image.alt).toBe("Product");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("decoding")).toBe("async");
    expect(image.referrerPolicy).toBe("no-referrer");
    expect(div.textContent).toContain("Other");
  });

  it("does not fetch unsafe image URLs or parse images in code", () => {
    const values = ["javascript:alert(1)", "data:image/png;base64,AAAA", "blob:https://shop.example/a", "//shop.example/a.png", "https://shop.example@evil.example/a.png", "https://shop.example/%0aevil.png", "https://shop.example/%zz", "https://shop.example/vector.svg"];
    for (const value of values) {
      const div = document.createElement("div");
      div.appendChild(renderMarkdown(document, `![photo](${value})`, { imageOrigins: ["https://shop.example"], imageProxy }));
      expect(div.querySelector("img"), value).toBeNull();
    }
    const code = document.createElement("div");
    code.appendChild(renderMarkdown(document, '`![x](https://shop.example/a.png)`\n\n```\n![x](https://shop.example/a.png)\n```', { imageOrigins: ["https://shop.example"], imageProxy }));
    expect(code.querySelector("img")).toBeNull();
    expect(code.textContent).toContain("![x]");
  });

  it("replaces an unavailable image with its accessible alt text", async () => {
    const div = document.createElement("div");
    div.appendChild(renderMarkdown(document, "![QR code](https://shop.example/qr.png)", { imageOrigins: ["https://shop.example"], imageProxy }));
    div.querySelector("img")!.dispatchEvent(new Event("error"));
    await Promise.resolve();
    div.querySelector("img")!.dispatchEvent(new Event("error"));
    expect(div.querySelector("img")).toBeNull();
    expect(div.textContent).toBe("QR code");
  });

  it("does not treat a cross-origin base URL as the page's origin", () => {
    const base = document.createElement("base");
    base.href = "https://other.example/";
    document.head.appendChild(base);
    try {
      const div = document.createElement("div");
      div.appendChild(renderMarkdown(document, "![photo](relative.png)"));
      expect(div.querySelector("img")).toBeNull();
    } finally { base.remove(); }
  });

  it("keeps escaped and nested image syntax literal", () => {
    const div = document.createElement("div");
    div.appendChild(renderMarkdown(document, '\\![x](https://shop.example/a.png) ![a [b]](https://shop.example/a.png)', { imageOrigins: ["https://shop.example"] }));
    expect(div.querySelector("img")).toBeNull();
    expect(div.textContent).toContain("![x](https://shop.example/a.png)");
  });
  it("renders common blocks", () => {
    const out = html("# Title\n\nHello **bold** and `code`.\n\n- a\n- b\n\n1. one\n2. two\n\n```js\nconst x = 1;\n```");
    expect(out).toContain("<h3>Title</h3>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(out).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(out).toContain('<pre><code data-lang="js">const x = 1;</code></pre>');
  });

  it("renders tables", () => {
    const out = html("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("<th>a</th>");
    expect(out).toContain("<td>2</td>");
  });

  it("never injects HTML or unsafe links", () => {
    const out = html('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://dewee.sh)');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="https://dewee.sh"');
  });

  it("autolinks bare urls", () => {
    expect(html("see https://dewee.sh/docs.")).toContain('href="https://dewee.sh/docs"');
  });
});
