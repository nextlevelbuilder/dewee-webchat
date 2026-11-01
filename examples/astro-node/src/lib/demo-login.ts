// Stand-in for the host's own login (tose-app's session cookie). It is stateless, an HMAC-signed
// cookie, so every instance of a horizontally scaled host reads it the same way. Replace it with your
// real session lookup; the rest of the example only calls `currentUser(request)`.
import { createHmac, timingSafeEqual } from "node:crypto";

export const LOGIN_COOKIE = "tose_demo_session";

/** The demo user directory: stable opaque ids (never emails), as `identity.authenticate` needs them. */
export const DEMO_USERS: Record<string, string> = { u_1001: "Lan", u_2002: "Minh" };

/** Keyed with DEMO_LOGIN_SECRET; `label` keeps cookie and quote signatures apart. */
export function hostKey(label: string): Buffer {
  const secret = process.env.DEMO_LOGIN_SECRET;
  if (!secret || secret.length < 32) throw new Error("DEMO_LOGIN_SECRET must be at least 32 characters");
  return createHmac("sha256", secret).update(label).digest();
}

export const mac = (label: string, value: string) => createHmac("sha256", hostKey(label)).update(value).digest("base64url");

export function macEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const LOGIN_TTL_S = 8 * 60 * 60;

/** Secure cookies when the public origin is https, which behind a TLS proxy only SITE_ORIGIN knows. */
const isSecure = (req: Request) => (process.env.SITE_ORIGIN || req.url).startsWith("https:");

/** `userId.expiry.signature`: the expiry is signed, so a copied cookie stops working with the session. */
export function loginCookie(userId: string, req: Request): string {
  const value = `${userId}.${Math.floor(Date.now() / 1000) + LOGIN_TTL_S}`;
  return `${LOGIN_COOKIE}=${value}.${mac("login", value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_TTL_S}${isSecure(req) ? "; Secure" : ""}`;
}

export function clearedLoginCookie(req: Request): string {
  return `${LOGIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? "; Secure" : ""}`;
}

/**
 * The signed-in user of a request, or null. Throws when the user directory cannot be read: the
 * handler then answers `503 SOURCE_UNAVAILABLE` instead of treating the visitor as signed out.
 * `DEMO_USER_DIRECTORY=down` simulates that outage (smoke tests and staging checks).
 */
export function currentUser(req: Request): string | null {
  const raw = new RegExp(`(?:^|;\\s*)${LOGIN_COOKIE}=([^;]*)`).exec(req.headers.get("cookie") ?? "")?.[1];
  if (!raw) return null;
  if (process.env.DEMO_USER_DIRECTORY === "down") throw new Error("user directory unavailable");
  const dot = raw.lastIndexOf(".");
  const value = raw.slice(0, dot);
  if (dot < 1 || !macEqual(raw.slice(dot + 1), mac("login", value))) return null;
  const [userId, exp] = value.split(".");
  if (!(Number(exp) * 1000 > Date.now())) return null;
  return Object.hasOwn(DEMO_USERS, userId) ? userId : null;
}

/**
 * Host routes that change state accept only same-origin JSON requests (CSRF). Behind a reverse proxy
 * `request.url` does not carry the public origin, so SITE_ORIGIN names it.
 */
export function sameOriginJson(req: Request): boolean {
  const origin = req.headers.get("origin");
  const own = process.env.SITE_ORIGIN || new URL(req.url).origin;
  return origin === own && (req.headers.get("content-type") ?? "").startsWith("application/json");
}

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export const errorResponse = (status: number, code: string, message: string) => jsonResponse({ error: { code, message } }, status);
