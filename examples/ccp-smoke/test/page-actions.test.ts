// The Astro Node example's page actions, in the browser half: `payments.create` cannot reach the
// payment route without the host's approval step, and only with the quote approved for that call.
import { describe, expect, it, vi } from "vitest";
import { tosePageActions, type PaymentQuote } from "../../astro-node/src/lib/page-actions";

const QUOTE: PaymentQuote = { quote: "signed.quote", orderId: "ord_1001a", amount: 250000, currency: "VND", expiresAt: Date.now() + 60_000 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(approve: boolean) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("/api/payments/quote")) return json(QUOTE);
    if (String(url) === "/api/payments") return json({ paymentId: "pay_1", orderId: "ord_1001a", amount: 250000, currency: "VND", checkoutUrl: "https://pay.example.test/checkout/pay_1" }, 201);
    if (String(url).startsWith("/api/orders/")) return json({ id: "ord_1001a", status: "awaiting_payment", total: 250000, currency: "VND" });
    return json({ error: { code: "not_found" } }, 404);
  }) as unknown as typeof globalThis.fetch;
  const approvePayment = vi.fn(async () => approve);
  const showCheckout = vi.fn();
  const { actions, confirm } = tosePageActions({ fetch, approvePayment, showCheckout });
  const byName = (name: string) => actions.find((a) => a.name === name)!;
  const ctx = (callId: string) => ({ callId, signal: new AbortController().signal }) as never;
  return { calls, approvePayment, showCheckout, confirm, byName, ctx };
}

describe("TOSE-style page actions", () => {
  it("declares the payment as a mutation whose only argument is the order id", () => {
    const { byName } = setup(true);
    expect(byName("orders.status").sensitivity).toBe("read");
    const pay = byName("payments.create");
    expect(pay.sensitivity).toBe("mutate");
    expect(pay.parameters).toMatchObject({ required: ["orderId"], additionalProperties: false });
    expect(Object.keys((pay.parameters as { properties: object }).properties)).toEqual(["orderId"]);
  });

  it("confirm shows the server's quote and a denial means no payment request", async () => {
    const s = setup(false);
    const pay = s.byName("payments.create");
    expect(await s.confirm({ ...pay, callId: "c1" }, { orderId: "ord_1001a" })).toBe(false);
    expect(s.approvePayment).toHaveBeenCalledWith(QUOTE);
    await expect(pay.handler({ orderId: "ord_1001a" }, s.ctx("c1"))).rejects.toThrow(/not approved/);
    expect(s.calls.some((c) => c.url === "/api/payments")).toBe(false);
    expect(s.showCheckout).not.toHaveBeenCalled();
  });

  it("an approval sends the approved quote once, for that call and order only", async () => {
    const s = setup(true);
    const pay = s.byName("payments.create");
    expect(await s.confirm({ ...pay, callId: "c2" }, { orderId: "ord_1001a" })).toBe(true);
    await expect(pay.handler({ orderId: "ord_1001a" }, s.ctx("other-call"))).rejects.toThrow(/not approved/);
    const result = await pay.handler({ orderId: "ord_1001a" }, s.ctx("c2"));
    expect(result).toEqual({ paymentId: "pay_1", status: "checkout_shown_to_customer" });
    const post = s.calls.find((c) => c.url === "/api/payments")!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ quote: "signed.quote" });
    expect(s.showCheckout).toHaveBeenCalledWith(expect.objectContaining({ checkoutUrl: "https://pay.example.test/checkout/pay_1" }));
    // The checkout link goes to the host UI, not back to the model.
    expect(JSON.stringify(result)).not.toContain("https://");
    await expect(pay.handler({ orderId: "ord_1001a" }, s.ctx("c2"))).rejects.toThrow(/not approved/);
  });

  it("confirm refuses anything other than the payment; reads need no approval", async () => {
    const s = setup(true);
    const read = s.byName("orders.status");
    expect(await s.confirm({ ...read, callId: "c3" }, { orderId: "ord_1001a" })).toBe(false);
    expect(s.approvePayment).not.toHaveBeenCalled();
    expect(await read.handler({ orderId: "ord_1001a" }, s.ctx("c4"))).toEqual({ orderId: "ord_1001a", status: "awaiting_payment", total: 250000, currency: "VND" });
  });
});
