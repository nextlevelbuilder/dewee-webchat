/** Bound the entire chat request before allocating and parsing its JSON. */
export async function readChatBody(request: Request): Promise<{ body: unknown } | { error: "too_large" | "invalid" }> {
  const limit = 128 * 1024;
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) return { error: "too_large" };
  if (!request.body) return { error: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return { error: "too_large" }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch { return { error: "invalid" }; }
  finally { reader.releaseLock(); }
}

/** Validate the ephemeral v1 attachment without logging or altering its contents. */
export function validPageContext(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const allowed = new Set(["version", "url", "title", "description", "captured_at", "selection", "content", "source", "trust_level"]);
  if (Object.keys(o).some((key) => !allowed.has(key)) || o.version !== 1 || typeof o.url !== "string") return false;
  if (new TextEncoder().encode(JSON.stringify(o)).length > 65536 || new TextEncoder().encode(o.url).length > 2048) return false;
  try {
    const url = new URL(o.url);
    if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname || url.username || url.password) return false;
  } catch { return false; }
  const limits: Record<string, number> = { title: 300, description: 1000, selection: 2000, captured_at: 64 };
  for (const [key, max] of Object.entries(limits)) {
    const item = o[key];
    if (item != null && (typeof item !== "string" || Array.from(item).length > max)) return false;
  }
  if (o.content != null) {
    if (typeof o.content !== "object" || Array.isArray(o.content)) return false;
    const c = o.content as Record<string, unknown>;
    if (Object.keys(c).some((key) => !["format", "text", "truncated"].includes(key))) return false;
    if (c.format != null && c.format !== "text" && c.format !== "markdown") return false;
    if (c.text != null && (typeof c.text !== "string" || Array.from(c.text).length > 12000)) return false;
    if (c.truncated != null && typeof c.truncated !== "boolean") return false;
  }
  return true;
}
