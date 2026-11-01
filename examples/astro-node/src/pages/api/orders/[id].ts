// The benign read the `orders.status` page action calls: the signed-in user's own order only.
import type { APIRoute } from "astro";
import { currentUser, errorResponse, jsonResponse } from "../../../lib/demo-login";
import { ORDER_ID_RE, orderFor } from "../../../lib/orders";

export const prerender = false;

export const GET: APIRoute = ({ request, params }) => {
  const user = currentUser(request);
  if (!user) return errorResponse(401, "unauthorized", "Sign in first");
  const order = ORDER_ID_RE.test(params.id ?? "") ? orderFor(user, params.id!) : null;
  if (!order) return errorResponse(404, "not_found", "Order not found");
  return jsonResponse({ id: order.id, status: order.status, total: order.total, currency: order.currency });
};
