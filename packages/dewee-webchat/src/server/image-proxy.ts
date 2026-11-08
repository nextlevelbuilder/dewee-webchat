/** A bounded raster response. The caller must ensure fetch cannot reach private network addresses. */
const utf8 = new TextEncoder();
const encode = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (data: string) => Uint8Array.from(atob(data.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((data.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function readImageTicketBody(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(all);
}

async function ticketKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", utf8.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8.encode("dewee-webchat"), info: utf8.encode("dewee-webchat:image-ticket:aes-256-gcm:v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** The URL never contains the visitor bearer: this short-lived capability is bound to one source. */
export async function issueImageTicket(secret: string, namespace: string, visitor: string, source: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = utf8.encode(JSON.stringify({ v: visitor, u: source, exp: Date.now() + 60_000 }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(`dewee-image-v1:${namespace}`) }, await ticketKey(secret), payload));
  const result = new Uint8Array(iv.length + ciphertext.length);
  result.set(iv); result.set(ciphertext, iv.length);
  return encode(result);
}

export async function verifyImageTicket(secret: string, namespace: string, ticket: string): Promise<{ visitor: string; source: string } | null> {
  try {
    if (ticket.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(ticket)) return null;
    const raw = decode(ticket);
    if (raw.length <= 28) return null;
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: utf8.encode(`dewee-image-v1:${namespace}`) }, await ticketKey(secret), raw.slice(12));
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    return typeof data.v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(data.v) && typeof data.u === "string" && data.u.length <= 4096 && Number.isSafeInteger(data.exp) && data.exp > Date.now() && data.exp <= Date.now() + 60_000 ? { visitor: data.v, source: data.u } : null;
  } catch { return null; }
}

/** Reject ambiguous path encodings before comparing against explicitly configured directory prefixes. */
export function allowedImageSource(raw: string, prefixes: URL[], endpoint: URL, cloudflare: boolean, publicAssets: string[] = [], publicServices: URL[] = []): URL | null {
  try {
    if (!raw || raw.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(raw)) return null;
    const match = /^https:\/\/[^/?#]+([^?#]*)/i.exec(raw);
    if (!match || /%(?:2f|5c|25|2e|0[0-9a-f]|1[0-9a-f]|7f)/i.test(match[1])) return null;
    const source = new URL(raw);
    if (source.protocol !== "https:" || source.username || source.password || source.hash || source.port) return null;
    const parent = endpoint.pathname.replace(/\/+$/, "").replace(/\/(?:image|image-ticket)$/, "");
    if (parent && (source.pathname === parent || source.pathname.startsWith(`${parent}/`))) return null;
    if (!parent && /^\/(?:image|image-ticket)(?:\/|$)/.test(source.pathname)) return null;
    // Cloudflare can bypass public-facing security for any same-zone host. Without a zone API,
    // conservatively refuse the endpoint's last two hostname labels (including sibling subdomains).
    if (cloudflare) {
      const suffix = endpoint.hostname.split(".").slice(-2).join(".");
      const sameZone = source.hostname === suffix || source.hostname.endsWith(`.${suffix}`);
      const isPublicAsset = source.origin === endpoint.origin && publicAssets.some((prefix) => source.pathname.startsWith(prefix));
      const isPublicService = publicServices.some((prefix) => prefix.origin === source.origin && source.pathname.startsWith(prefix.pathname));
      if (sameZone && !isPublicAsset && !isPublicService) return null;
    }
    return prefixes.some((prefix) => prefix.origin === source.origin && source.pathname.startsWith(prefix.pathname)) ? source : null;
  } catch { return null; }
}

/** Limit decoded memory and reject animated formats; suspicious containers fail closed. */
export function safeRasterDimensions(bytes: Uint8Array, type: string): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  const u16 = (at: number, little = false) => little ? bytes[at] + bytes[at + 1] * 256 : bytes[at] * 256 + bytes[at + 1];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number, little = false) => view.getUint32(at, little);
  const sizeOK = (w: number, h: number) => w > 0 && h > 0 && w <= 4096 && h <= 4096 && w * h <= 16_000_000;
  let width = 0, height = 0;
  if (type === "image/png") {
    let pos = 8, header = false, data = false, end = false;
    while (pos + 12 <= bytes.length) {
      const length = u32(pos), name = ascii(pos + 4, pos + 8);
      if (length > bytes.length - pos - 12) return false;
      if (name === "IHDR") {
        if (header || pos !== 8 || length !== 13) return false;
        header = true; width = u32(pos + 8); height = u32(pos + 12);
      } else if (name === "acTL" || name === "fcTL" || name === "fdAT") return false;
      else if (name === "IDAT") data = true;
      else if (name === "IEND") { end = length === 0; break; }
      pos += length + 12;
    }
    if (!header || !data || !end) return false;
  } else if (type === "image/gif" && bytes.length >= 13) {
    width = u16(6, true); height = u16(8, true);
    let pos = 13 + (bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), frames = 0, end = false;
    const blocks = () => {
      while (pos < bytes.length) { const n = bytes[pos++]; if (n === 0) return true; if (n > bytes.length - pos) return false; pos += n; }
      return false;
    };
    while (pos < bytes.length) {
      const marker = bytes[pos++];
      if (marker === 0x3b) { end = true; break; }
      if (marker === 0x21) { if (pos >= bytes.length) return false; pos++; if (!blocks()) return false; continue; }
      if (marker !== 0x2c || pos + 9 > bytes.length || ++frames > 1) return false;
      const left = u16(pos, true), top = u16(pos + 2, true), w = u16(pos + 4, true), h = u16(pos + 6, true), flags = bytes[pos + 8];
      if (!sizeOK(w, h) || left + w > width || top + h > height) return false;
      pos += 9 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
      if (pos >= bytes.length) return false;
      pos++; // LZW minimum code size
      if (!blocks()) return false;
    }
    if (frames !== 1 || !end) return false;
  } else if (type === "image/jpeg") {
    let pos = 2, frames = 0, end = false;
    while (pos + 1 < bytes.length && bytes[pos] === 0xff) {
      while (bytes[pos] === 0xff) pos++;
      const marker = bytes[pos++];
      if (marker === 0xd9) { end = true; break; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (pos + 2 > bytes.length) return false;
      const length = u16(pos);
      if (length < 2 || pos + length > bytes.length) return false;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (++frames !== 1 || length < 7) return false;
        height = u16(pos + 3); width = u16(pos + 5);
      }
      pos += length;
      if (marker === 0xda) {
        while (pos + 1 < bytes.length) {
          if (bytes[pos] !== 0xff) { pos++; continue; }
          const next = bytes[pos + 1];
          if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { pos += 2; continue; }
          break;
        }
      }
    }
    if (frames !== 1 || !end) return false;
  } else if (type === "image/webp" && bytes.length >= 20) {
    const total = u32(4, true) + 8;
    if (total > bytes.length || total < 20) return false;
    let pos = 12, images = 0, canvasW = 0, canvasH = 0;
    while (pos + 8 <= total) {
      const chunk = ascii(pos, pos + 4), length = u32(pos + 4, true), start = pos + 8;
      if (length > total - start || start + length + (length & 1) > total || chunk === "ANIM" || chunk === "ANMF") return false;
      if (chunk === "VP8X") {
        if (length !== 10 || canvasW || (bytes[start] & 2)) return false;
        canvasW = 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16);
        canvasH = 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16);
      } else if (chunk === "VP8L" && length >= 5 && bytes[start] === 0x2f) {
        images++; width = 1 + bytes[start + 1] + ((bytes[start + 2] & 0x3f) << 8); height = 1 + (bytes[start + 2] >> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 15) << 10);
      } else if (chunk === "VP8 " && length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 1 && bytes[start + 5] === 0x2a) {
        images++; width = u16(start + 6, true) & 0x3fff; height = u16(start + 8, true) & 0x3fff;
      }
      pos = start + length + (length & 1);
    }
    if (pos !== total || images !== 1 || (canvasW && (canvasW !== width || canvasH !== height))) return false;
  }
  return sizeOK(width, height);
}

/** A bounded raster response. The caller must ensure fetch cannot reach private network addresses. */
export async function fetchRasterImage(url: string, fetcher: typeof fetch, redirect: "error" | "manual" = "error"): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(url, { method: "GET", redirect, credentials: "omit", signal: controller.signal, headers: { accept: "image/png,image/jpeg,image/gif,image/webp" } });
    if (!response.ok || !response.body) { await response.body?.cancel(); return null; }
    const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (!type || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type)) { await response.body.cancel(); return null; }
    const length = response.headers.get("content-length");
    const maxBytes = 2 * 1024 * 1024;
    if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body.cancel(); return null; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); return null; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
    const valid = type === "image/png" ? starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
      : type === "image/jpeg" ? starts(0xff, 0xd8, 0xff)
      : type === "image/gif" ? ["GIF87a", "GIF89a"].includes(ascii(0, 6))
      : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    if (!valid || !safeRasterDimensions(bytes, type)) return null;
    return new Response(bytes, { headers: { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "private, no-store", "content-security-policy": "default-src 'none'; sandbox" } });
  } catch { return null; }
  finally { clearTimeout(timer); }
}
