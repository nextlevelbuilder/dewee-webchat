// Approval step of `payments.create`: the server's own amount, signed, for the host's confirmation UI.
// Nothing is created here.
import type { APIRoute } from "astro";
import { currentUser, errorResponse, jsonResponse } from "../../../lib/demo-login";
import { ORDER_ID_RE, orderFor, quoteFor } from "../../../lib/orders";

export const prerender = false;

export const GET: APIRoute = ({ request, url }) => {
  const user = currentUser(request);
  if (!user) return errorResponse(401, "unauthorized", "Sign in first");
  const id = url.searchParams.get("orderId") ?? "";
  const order = ORDER_ID_RE.test(id) ? orderFor(user, id) : null;
  if (!order) return errorResponse(404, "not_found", "Order not found");
  if (order.status !== "awaiting_payment") return errorResponse(409, "already_paid", "Order does not need a payment");
  return jsonResponse(quoteFor(user, order));
};
