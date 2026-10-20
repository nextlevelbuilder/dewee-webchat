// Visitor tokens (HMAC-SHA256 via WebCrypto) and a small in-memory rate limiter.

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set(secret, k);
  }
  return k;
}

export interface VisitorClaims {
  /** Visitor id (random, 22 chars; derived from the principal for a signed-in user). */
  v: string;
  /** Expiry, epoch ms. */
  exp: number;
  /**
   * Signed-in users only: the Dewee identity session token. In the signed token it is encrypted
   * (AES-256-GCM), so the browser only ever holds an opaque value; these claims carry it decrypted.
   */
  ids?: string;
  /** Signed-in users only: the agent the identity session is bound to. */
  ida?: string;
  /**
   * Signed-in users only: a keyed digest of the host's subject (see {@link subjectDigest}). Sealed
   * together with `ids`, so the browser never sees the subject or its digest.
   */
  sub?: string;
}

/** Longest identity session token the gateway issues (matches the `@dewee/identity` limit). */
const MAX_IDENTITY_SESSION_LENGTH = 512;
/**
 * Longest sealed plaintext, `{"t":"<session>","h":"<digest>"}` in UTF-8: the 15 bytes of JSON syntax,
 * the session at worst 6 bytes per character (a `\u00XX` escape; a non-ASCII character is at most 3
 * UTF-8 bytes per UTF-16 unit), and the 43-character base64url HMAC-SHA-256 digest.
 */
const MAX_SEALED_PLAINTEXT = '{"t":"","h":""}'.length + 6 * MAX_IDENTITY_SESSION_LENGTH + 43;
/** Longest sealed form: 12-byte IV + plaintext + 16-byte tag, base64url. */
const MAX_SEALED_LENGTH = Math.ceil(((12 + MAX_SEALED_PLAINTEXT + 16) * 4) / 3);
const AGENT_CLAIM_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const sealKeyCache = new Map<string, Promise<CryptoKey>>();
/** AES-256-GCM key for identity sessions, derived from the visitor secret with its own HKDF label. */
function sealKey(secret: string): Promise<CryptoKey> {
  let k = sealKeyCache.get(secret);
  if (!k) {
    k = crypto.subtle
      .importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: enc.encode("dewee-webchat"), info: enc.encode("dewee-webchat:identity-session:aes-256-gcm:v1") },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    sealKeyCache.set(secret, k);
  }
  return k;
}

/** The ciphertext is bound to the visitor and agent it was issued for. */
const sealAad = (v: string, agent: string) => enc.encode(`dewee-webchat:ids:${v}:${agent}`);

/** What is sealed: the session token and, optionally, the subject digest. */
interface SealedIdentity { t: string; h?: string }

async function sealIdentitySession(secret: string, v: string, agent: string, sealed: SealedIdentity): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: sealAad(v, agent) }, await sealKey(secret), enc.encode(JSON.stringify(sealed))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

async function openIdentitySession(secret: string, v: string, agent: string, sealed: string): Promise<SealedIdentity | null> {
  const raw = fromB64url(sealed);
  if (raw.length <= 12 + 16) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: sealAad(v, agent) }, await sealKey(secret), raw.slice(12));
    const parsed = JSON.parse(new TextDecoder().decode(pt)) as SealedIdentity;
    if (typeof parsed?.t !== "string" || parsed.t === "" || parsed.t.length > MAX_IDENTITY_SESSION_LENGTH) return null;
    if (parsed.h !== undefined && typeof parsed.h !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Keyed digest of a host subject, for binding a token to the user it was issued for without storing the subject. */
export async function subjectDigest(secret: string, subject: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`dewee-webchat:subject:${subject}`)));
  return b64url(mac);
}

/** Compares two strings in time that depends only on their lengths, not on where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function signVisitorToken(secret: string, claims: VisitorClaims): Promise<string> {
  let wire: Omit<VisitorClaims, "sub"> = claims;
  if (claims.ids !== undefined && claims.ida !== undefined) {
    const { sub, ...rest } = claims;
    wire = { ...rest, ids: await sealIdentitySession(secret, claims.v, claims.ida, sub ? { t: claims.ids, h: sub } : { t: claims.ids }) };
  }
  const body = b64url(enc.encode(JSON.stringify(wire)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifyVisitorToken(secret: string, token: string): Promise<VisitorClaims | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as VisitorClaims;
    if (typeof claims.v !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(claims.v)) return null;
    if (typeof claims.exp !== "number" || claims.exp < Date.now()) return null;
    // An identity claim is all or nothing: a session token always travels with the agent it is bound to.
    if (claims.ids !== undefined || claims.ida !== undefined) {
      if (typeof claims.ids !== "string" || claims.ids === "" || claims.ids.length > MAX_SEALED_LENGTH) return null;
      if (typeof claims.ida !== "string" || !AGENT_CLAIM_RE.test(claims.ida)) return null;
      if ((claims as { sub?: unknown }).sub !== undefined) return null; // the digest only ever travels sealed
      const opened = await openIdentitySession(secret, claims.v, claims.ida, claims.ids);
      if (!opened) return null;
      return opened.h ? { v: claims.v, exp: claims.exp, ids: opened.t, ida: claims.ida, sub: opened.h } : { v: claims.v, exp: claims.exp, ids: opened.t, ida: claims.ida };
    }
    return claims;
  } catch {
    return null;
  }
}

/**
 * Stable visitor id for a label (e.g. a Dewee principal id): HMAC(secret, label), 22 base64url chars.
 * A signed-in user keeps the same conversations on every device and page load without the id being guessable.
 */
export async function deriveVisitorId(secret: string, label: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`dewee-webchat:visitor:${label}`)));
  return b64url(mac.slice(0, 16));
}

export function randomId(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Rate-limit buckets: `session` (new visitor sessions, per IP), `chat` (messages, per visitor and IP),
 * and with signed-in users `preauth` (calls to the host's `authenticate`, per IP), `verified`
 * (signed-in `/session` calls, per user) and `link` (link starts, per user).
 */
export type RateLimitBucket = "session" | "chat" | "preauth" | "verified" | "link";

/** Default `preauth` limit: generous, it only caps how hard a client can drive `authenticate`. */
const DEFAULT_PREAUTH_LIMIT: [number, number] = [120, 60_000];

/** Returns true when the key may proceed. Implementations may be async (KV, DO, Redis…). */
export type RateLimiter = (key: string, bucket: RateLimitBucket) => boolean | Promise<boolean>;

/**
 * `[max, windowMs]` per bucket. `preauth` defaults to 120 per minute; `verified` and `link` fall back to
 * the `session` limit when not set.
 */
export interface MemoryRateLimits {
  chat: [number, number];
  session: [number, number];
  preauth?: [number, number];
  verified?: [number, number];
  link?: [number, number];
}

/**
 * Fixed-window in-memory limiter. Good enough for a single Node process; on serverless
 * runtimes each isolate keeps its own counters, so pass a shared limiter for hard limits.
 */
export function memoryRateLimiter(limits: MemoryRateLimits): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return (key, bucket) => {
    const [max, windowMs] = limits[bucket] ?? (bucket === "preauth" ? DEFAULT_PREAUTH_LIMIT : limits.session);
    const id = `${bucket}:${key}`;
    const now = Date.now();
    const w = windows.get(id);
    if (!w || now - w.start >= windowMs) {
      windows.set(id, { start: now, count: 1 });
      if (windows.size > 10000) {
        for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
      }
      return true;
    }
    w.count++;
    return w.count <= max;
  };
}

export async function verifyTurnstile(secret: string, response: string, ip?: string): Promise<boolean> {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", response);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data: any = await res.json().catch(() => ({}));
  return data.success === true;
}
