// Logout: revoke the user's Dewee identity session at CCP, then clear the host's own cookie. The page
// sends the widget's reuse hint along, so the exact session is revoked even when another instance
// issued it (see the multi-instance notes in the README).
import type { APIRoute } from "astro";
import { dewee } from "../../../lib/dewee";
import { clearedLoginCookie, currentUser, errorResponse, jsonResponse, sameOriginJson } from "../../../lib/demo-login";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!sameOriginJson(request)) return errorResponse(403, "forbidden_origin", "Same-origin JSON only");
  // The cookie is cleared even when the user directory is down: signing out must always work.
  let user: string | null = null;
  try {
    user = currentUser(request);
  } catch {}
  const body = await request.clone().json().catch(() => null);
  const hint = typeof body?.hint === "string" ? body.hint : undefined;
  if (user) await dewee().revoke(user, request, hint);
  return jsonResponse({ ok: true, revoked: Boolean(user) }, 200, { "set-cookie": clearedLoginCookie(request) });
};
