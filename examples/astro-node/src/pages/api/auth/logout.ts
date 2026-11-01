// Logout: revoke the user's Dewee identity session at CCP, then clear the host's own cookie. The page
// sends the widget's reuse hint along, so the exact session is revoked even when another instance
// issued it (see the multi-instance notes in the README).
import type { APIRoute } from "astro";
import { dewee } from "../../../lib/dewee";
import { clearedLoginCookie, currentUser, errorResponse, jsonResponse, sameOriginJson } from "../../../lib/demo-login";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!sameOriginJson(request)) return errorResponse(403, "forbidden_origin", "Same-origin JSON only");
  const user = currentUser(request);
  const { hint } = await request.clone().json().catch(() => ({}));
  if (user) await dewee().revoke(user, request, typeof hint === "string" ? hint : undefined);
  const secure = new URL(request.url).protocol === "https:";
  return jsonResponse({ ok: true }, 200, { "set-cookie": clearedLoginCookie(secure) });
};
