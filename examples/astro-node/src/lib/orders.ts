// Stand-in for the TOSE backend: orders and payments are owned and validated here, on the server.
// The agent and the widget only ever pass an order id; amounts and checkout URLs come from this module.
// Payments live in this process's memory for the demo; a real backend keeps them in its database.
import { randomBytes } from "node:crypto";
import { mac, macEqual } from "./demo-login";

export interface Order {
  id: string;
  owner: string;
  status: "awaiting_payment" | "paid" | "shipped";
  total: number;
  currency: "VND";
}

export interface Payment {
  paymentId: string;
  orderId: string;
  amount: number;
  currency: "VND";
  /** Built here from the configured provider, never from model output. */
  checkoutUrl: string;
}

export const ORDER_ID_RE = /^ord_[a-z0-9]{4,32}$/;
const QUOTE_TTL_MS = 5 * 60_000;

const ORDERS: Order[] = [
  { id: "ord_1001a", owner: "u_1001", status: "awaiting_payment", total: 250_000, currency: "VND" },
  { id: "ord_1001b", owner: "u_1001", status: "shipped", total: 120_000, currency: "VND" },
  { id: "ord_2002a", owner: "u_2002", status: "awaiting_payment", total: 990_000, currency: "VND" },
];
const payments = new Map<string, Payment>();

/** The user's own order; another user's order is "not found", so ids cannot be probed. */
export function orderFor(user: string, id: string): Order | null {
  const order = ORDERS.find((o) => o.id === id && o.owner === user);
  if (!order) return null;
  return payments.has(order.id) ? { ...order, status: "paid" } : order;
}

export const ordersOf = (user: string) => ORDERS.filter((o) => o.owner === user).map((o) => orderFor(user, o.id)!);

function checkoutBase(): string {
  const raw = process.env.PAYMENT_CHECKOUT_URL || "https://pay.example.test/checkout";
  const u = new URL(raw);
  if (u.protocol !== "https:") throw new Error("PAYMENT_CHECKOUT_URL must use https");
  return u.href.replace(/\/$/, "");
}

/**
 * Step 1, shown to the user before anything is created: a signed quote of the server's own amount,
 * bound to the user and the order. The host's confirmation dialog displays it.
 */
export function quoteFor(user: string, order: Order): { quote: string; orderId: string; amount: number; currency: string; expiresAt: number } {
  const expiresAt = Date.now() + QUOTE_TTL_MS;
  const body = Buffer.from(JSON.stringify({ u: user, o: order.id, a: order.total, c: order.currency, exp: expiresAt })).toString("base64url");
  return { quote: `${body}.${mac("quote", body)}`, orderId: order.id, amount: order.total, currency: order.currency, expiresAt };
}

export type PaymentRefusal = { status: number; code: string; message: string };

/**
 * Step 2, after the user approved the quote in the host UI: re-validates everything (signature,
 * expiry, owner, order state, the current amount) and only then creates the payment.
 */
export function createPayment(user: string, quote: unknown): Payment | PaymentRefusal {
  if (typeof quote !== "string" || !quote.includes(".")) return { status: 400, code: "approval_required", message: "Payment needs a quote the user approved" };
  const [body, sig] = quote.split(".");
  if (!body || !sig || !macEqual(sig, mac("quote", body))) return { status: 400, code: "invalid_quote", message: "Quote is invalid" };
  const q = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u: string; o: string; a: number; c: string; exp: number };
  if (q.u !== user) return { status: 403, code: "forbidden", message: "Quote belongs to another user" };
  if (q.exp < Date.now()) return { status: 400, code: "quote_expired", message: "Quote expired, ask again" };
  const order = orderFor(user, q.o);
  if (!order) return { status: 404, code: "not_found", message: "Order not found" };
  if (order.status !== "awaiting_payment") return { status: 409, code: "already_paid", message: "Order does not need a payment" };
  if (order.total !== q.a || order.currency !== q.c) return { status: 409, code: "amount_changed", message: "Order amount changed, ask again" };
  const paymentId = `pay_${randomBytes(8).toString("hex")}`;
  const payment: Payment = { paymentId, orderId: order.id, amount: order.total, currency: order.currency, checkoutUrl: `${checkoutBase()}/${paymentId}` };
  payments.set(order.id, payment);
  return payment;
}
