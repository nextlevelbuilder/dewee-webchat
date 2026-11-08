/** A transient, untrusted attachment for one chat turn. Never stored in browser history. */
export interface PageContextAttachment {
  version: 1;
  url: string;
  title?: string;
  description?: string;
  captured_at?: string;
  selection?: string;
  content?: { format: "text" | "markdown"; text: string; truncated: boolean };
}

export interface PageContextOptions {
  mode: "metadata" | "content";
  selector?: string;
  excludeSelectors?: string[];
}

const BLOCKED = "script,style,noscript,template,svg,canvas,iframe,form,input,textarea,select,option,button,[contenteditable]:not([contenteditable='false']),[hidden],[aria-hidden='true'],[inert],dewee-chat";
const MAX_CONTENT = 12000;

/** Retain useful routing parameters but redact common credential-bearing query values. */
export function safePageUrl(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.username = ""; url.password = ""; url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const words = key.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2").replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/(\p{L})(\p{N})/gu, "$1 $2").replace(/(\p{N})(\p{L})/gu, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const joined = words.join("");
      const qualifiers = ["api", "access", "auth", "oauth", "secret", "private", "client", "session", "signing", "verification", "reset", "recovery", "activation", "confirmation", "invite", "license", "encryption"];
      const secret = words.some((word, index) => ["token", "secret", "password", "passwd", "pwd", "auth", "authorization", "cookie", "apikey", "session", "sid", "sig", "signature", "otp", "jwt", "credential", "credentials", "nonce", "bearer", "ticket"].includes(word) || (["code", "key", "state"].includes(word) && (words.length === 1 || (index > 0 && qualifiers.includes(words[index - 1]))))) || /token|secret|passw|apikey|credential|sessid|session|authorization|samlresponse/.test(joined);
      if (secret) url.searchParams.set(key, "[REDACTED]");
    }
    return new TextEncoder().encode(url.href).length <= 2048 ? url.href : undefined;
  } catch { return undefined; }
}

function clip(text: string, length: number): string {
  return Array.from(text).slice(0, length).join("");
}

function limitBytes(context: PageContextAttachment): PageContextAttachment {
  if (context.content && new TextEncoder().encode(JSON.stringify(context)).length > 65536) {
    const points = Array.from(context.content.text);
    let low = 0, high = points.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      context.content.text = points.slice(0, mid).join("");
      context.content.truncated = true;
      if (new TextEncoder().encode(JSON.stringify(context)).length <= 65536) low = mid;
      else high = mid - 1;
    }
    context.content.text = points.slice(0, low).join("");
    context.content.truncated = true;
  }
  return context;
}

/** A host provider is trusted to choose data; the visitor still previews and consents. */
export function providedPageContext(raw: unknown, base: PageContextAttachment, mode: PageContextOptions["mode"]): PageContextAttachment {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Invalid page context");
  const value = raw as Record<string, unknown>;
  const result: PageContextAttachment = { version: 1, url: base.url, captured_at: base.captured_at };
  for (const [key, max] of [["title", 300], ["description", 1000]] as const) {
    if (typeof value[key] === "string") result[key] = clip(value[key].replace(/\s+/g, " ").trim(), max);
  }
  if (mode === "content") {
    if (typeof value.selection === "string") result.selection = clip(value.selection, 2000);
    if (value.content && typeof value.content === "object" && !Array.isArray(value.content)) {
      const content = value.content as Record<string, unknown>;
      if (typeof content.text !== "string" || (content.format !== "text" && content.format !== "markdown")) throw new TypeError("Invalid page content");
      const text = clip(content.text, MAX_CONTENT);
      result.content = { format: content.format, text, truncated: content.truncated === true || Array.from(content.text).length > MAX_CONTENT };
    }
  }
  return limitBytes(result);
}

/** Reject excluded or hidden ancestors, including the selected root itself. */
function visible(el: Element | null, excludes: string[]): boolean {
  for (let node = el; node; node = node.parentElement) {
    if (node.matches(BLOCKED) || excludes.some((selector) => node!.matches(selector))) return false;
    if (node instanceof HTMLDialogElement && !node.open) return false;
    if (node instanceof HTMLDetailsElement && !node.open) {
      const summary = [...node.children].find((child) => child.tagName === "SUMMARY");
      if (!summary || !el || (summary !== el && !summary.contains(el))) return false;
    }
    if (node.hasAttribute("popover")) {
      try { if (!node.matches(":popover-open")) return false; } catch { return false; }
    }
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0" || style.contentVisibility === "hidden") return false;
  }
  if (el && typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  return true;
}

/** Capture only a designated main region; never fall back to the whole body. */
export function capturePageContext(doc: Document, options: PageContextOptions): PageContextAttachment | undefined {
  const url = safePageUrl(doc.location.href);
  if (!url) return undefined;
  // Invalid selectors are configuration errors: fail rather than widen collection.
  const excludes = options.excludeSelectors ?? [];
  for (const selector of excludes) doc.documentElement.matches(selector);
  const root = doc.querySelector(options.selector || "main, article, [role='main']");
  const context: PageContextAttachment = { version: 1, url, captured_at: new Date().toISOString() };
  const title = clip(doc.title.replace(/\s+/g, " ").trim(), 300);
  const description = clip((doc.querySelector('meta[name="description" i]')?.getAttribute("content") ?? "").replace(/\s+/g, " ").trim(), 1000);
  if (title) context.title = title;
  if (description) context.description = description;
  if (options.mode !== "content" || !root || !visible(root, excludes)) return context;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chunks: string[] = [];
  let size = 0;
  let visited = 0;
  let truncated = false;
  while (walker.nextNode()) {
    if (++visited > 5000) { truncated = true; break; }
    const node = walker.currentNode;
    if (!visible(node.parentElement, excludes)) continue;
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const remaining = MAX_CONTENT - size;
    const part = clip(text, remaining);
    chunks.push(part);
    size += Array.from(part).length + 1;
    if (Array.from(text).length > remaining || size >= MAX_CONTENT) { truncated = true; break; }
  }
  const text = clip(chunks.join("\n"), MAX_CONTENT);
  if (text) context.content = { format: "text", text, truncated };
  const selection = doc.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const element = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor as Element : ancestor.parentElement;
    if (element && root.contains(element) && visible(element, excludes)) {
      const nodes = root.querySelectorAll("*");
      if (nodes.length <= 5000 && ![...nodes].some((el) => range.intersectsNode(el) && !visible(el, excludes))) {
        const selected = clip(selection.toString().trim(), 2000);
        if (selected) context.selection = selected;
      }
    }
  }
  return limitBytes(context);
}
