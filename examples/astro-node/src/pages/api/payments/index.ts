// Creates a payment from a quote the user approved. Authoritative: login, CSRF, ownership, order
// state and the current amount are all checked again here; anything else in the body is ignored.
import type { APIRoute } from "astro";
import { currentUser, errorResponse, jsonResponse, sameOriginJson } from "../../../lib/demo-login";
import { ORDER_ID_RE, createPayment, paymentFor } from "../../../lib/orders";

export const prerender = false;

/**
 * Reconciliation read for a client whose POST answer was lost: the signed-in user's own payment for
 * an order, or 404 when none was created. Another user's order is "not found" too.
 */
export const GET: APIRoute = ({ request, url }) => {
  const user = currentUser(request);
  if (!user) return errorResponse(401, "unauthorized", "Sign in first");
  const orderId = url.searchParams.get("orderId") ?? "";
  const payment = ORDER_ID_RE.test(orderId) ? paymentFor(user, orderId) : null;
  if (!payment) return errorResponse(404, "not_found", "No payment for this order");
  return jsonResponse(payment);
};

export const POST: APIRoute = async ({ request }) => {
  if (!sameOriginJson(request)) return errorResponse(403, "forbidden_origin", "Same-origin JSON only");
  const user = currentUser(request);
  if (!user) return errorResponse(401, "unauthorized", "Sign in first");
  const body = await request.json().catch(() => null);
  const result = createPayment(user, body?.quote);
  if ("code" in result) return errorResponse(result.status, result.code, result.message);
  return jsonResponse(result, 201);
};
