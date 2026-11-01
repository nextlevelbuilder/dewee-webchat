// Creates a payment from a quote the user approved. Authoritative: login, CSRF, ownership, order
// state and the current amount are all checked again here; anything else in the body is ignored.
import type { APIRoute } from "astro";
import { currentUser, errorResponse, jsonResponse, sameOriginJson } from "../../../lib/demo-login";
import { createPayment } from "../../../lib/orders";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!sameOriginJson(request)) return errorResponse(403, "forbidden_origin", "Same-origin JSON only");
  const user = currentUser(request);
  if (!user) return errorResponse(401, "unauthorized", "Sign in first");
  const body = await request.json().catch(() => null);
  const result = createPayment(user, body?.quote);
  if ("code" in result) return errorResponse(result.status, result.code, result.message);
  return jsonResponse(result, 201);
};
