// Demo sign-in: picks one of the demo users. A real host signs users in with its own login flow.
import type { APIRoute } from "astro";
import { DEMO_USERS, errorResponse, jsonResponse, loginCookie, sameOriginJson } from "../../../lib/demo-login";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!sameOriginJson(request)) return errorResponse(403, "forbidden_origin", "Same-origin JSON only");
  const body = await request.json().catch(() => null);
  const userId = typeof body?.userId === "string" ? body.userId : "";
  if (!Object.hasOwn(DEMO_USERS, userId)) return errorResponse(400, "unknown_user", "Unknown demo user");
  const secure = new URL(request.url).protocol === "https:";
  // The widget asks /api/dewee/session again (renewSession or a page load) and gets the new user.
  return jsonResponse({ user: userId }, 200, { "set-cookie": loginCookie(userId, secure) });
};
