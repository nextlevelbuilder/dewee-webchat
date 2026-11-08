// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { capturePageContext, safePageUrl } from "../src/widget/page-context";

afterEach(() => { document.body.innerHTML = ""; document.head.innerHTML = ""; });

describe("page context extraction", () => {
  it("strips credentials and fragments while redacting secret query values", () => {
    const url = new URL(safePageUrl("https://user:pass@example.com/item?token=secret&accessToken=secret2&countryCode=VN&orderState=open#private")!);
    expect(url.username).toBe(""); expect(url.password).toBe(""); expect(url.hash).toBe("");
    expect(url.searchParams.get("token")).toBe("[REDACTED]");
    expect(url.searchParams.get("accessToken")).toBe("[REDACTED]");
    expect(url.searchParams.get("countryCode")).toBe("VN");
    expect(url.searchParams.get("orderState")).toBe("open");
    const sensitive = new URL(safePageUrl("https://example.com/?privateKey=a&passwd=b&credentialBlob=c&authorization=d&cookie=e&sortKey=asc")!);
    for (const key of ["privateKey", "passwd", "credentialBlob", "authorization", "cookie"]) expect(sensitive.searchParams.get(key)).toBe("[REDACTED]");
    expect(sensitive.searchParams.get("sortKey")).toBe("asc");
    const session = new URL(safePageUrl("https://example.com/?PHPSESSID=a&JSESSIONID=b&SAMLResponse=c&ticket=d")!);
    for (const key of ["PHPSESSID", "JSESSIONID", "SAMLResponse", "ticket"]) expect(session.searchParams.get(key)).toBe("[REDACTED]");
    expect(safePageUrl("file:///etc/passwd")).toBeUndefined();
  });
  it("collects a bounded main region without hidden, editable or excluded data", () => {
    document.title = "A page";
    document.body.innerHTML = `<main><h1>Visible title</h1><p>Useful text</p><form><input value="private"><p>Form secret</p></form><div style="display:none">Hidden secret</div><div style="opacity:0">Opacity secret</div><div style="content-visibility:hidden">Skipped secret</div><details><summary>Visible summary</summary><p>Details secret</p></details><dialog>Dialog secret</dialog><div contenteditable>Draft</div><div class="private">Private section</div><script>secret()</script></main>`;
    const context = capturePageContext(document, { mode: "content", excludeSelectors: [".private"] });
    expect(context?.content?.text).toContain("Useful text");
    expect(context?.content?.text).not.toMatch(/secret|Draft|Private section/);
  });
  it("never falls back to the body and metadata mode never includes content", () => {
    document.body.innerHTML = "<p>Private body</p>";
    expect(capturePageContext(document, { mode: "content" })?.content).toBeUndefined();
    document.body.innerHTML = "<main>Page text</main>";
    expect(capturePageContext(document, { mode: "metadata" })?.content).toBeUndefined();
  });
  it("limits content and rejects malformed exclusion selectors", () => {
    document.body.innerHTML = `<main><p>${"a".repeat(13000)}</p></main>`;
    const result = capturePageContext(document, { mode: "content" });
    expect(result?.content?.text.length).toBe(12000);
    expect(result?.content?.truncated).toBe(true);
    expect(() => capturePageContext(document, { mode: "content", excludeSelectors: ["["] })).toThrow();
  });
  it("keeps a valid 12,000-character multibyte page within the wire limit", () => {
    document.body.innerHTML = `<main><p>${"😀".repeat(12000)}</p></main>`;
    const result = capturePageContext(document, { mode: "content" })!;
    expect(Array.from(result.content!.text)).toHaveLength(12000);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(65536);
  });
});
