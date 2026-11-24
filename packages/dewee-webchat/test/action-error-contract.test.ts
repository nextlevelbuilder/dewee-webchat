// @vitest-environment happy-dom
// The error contract of page actions, exercised through the real runner: a resolved handler is a
// success, a thrown ActionError is a coded failure, and a write whose result is not known is
// "unknown" rather than either. The astro-node example handlers are run against mocked HTTP answers.
import { describe, expect, it, vi } from "vitest";
import { ActionError, ActionRegistry, runActionCall, type ActionCallStatus, type PageAction } from "../src/actions/action-runner";
import { formatActionResults, parseActionResults, type ActionResult } from "../src/actions/directives";
import { buildPageBlock } from "../src/actions/page-block";
import { tosePageActions, type CreatedPayment, type PaymentQuote } from "../../../examples/astro-node/src/lib/page-actions";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (status: number, code: string) => json({ error: { code, message: `${code} message` } }, status);

const QUOTE: PaymentQuote = { quote: "body.sig", orderId: "ord_1001a", amount: 250_000, currency: "VND", expiresAt: Date.now() + 60_000 };
const PAYMENT: CreatedPayment = { paymentId: "pay_1", orderId: "ord_1001a", amount: 250_000, currency: "VND", checkoutUrl: "https://pay.example.test/checkout/pay_1" };

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Runs one call the way the widget does, recording every status the chip went through. */
async function run(actions: PageAction[], name: string, args: Record<string, unknown>, o: { confirm?: Parameters<typeof runActionCall>[1]["confirm"]; signal?: AbortSignal; timeoutMs?: number } = {}) {
  const registry = new ActionRegistry();
  registry.register(actions);
  const statuses: ActionCallStatus[] = [];
  const result = await runActionCall(
    { ok: true, id: "c1", name, args },
    { registry, confirm: o.confirm ?? (() => true), conversationId: "conv", agent: "agent", signal: o.signal ?? new AbortController().signal, timeoutMs: o.timeoutMs, onStatus: (s) => statuses.push(s) },
  );
  return { result, statuses };
}

function shop(routes: { order?: Route; quote?: Route; create?: Route; reconcile?: Route }, o: { approve?: boolean; shown?: boolean | (() => never) } = {}) {
  const calls: string[] = [];
  const shownPayments: CreatedPayment[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.startsWith("/api/orders/")) return routes.order!(url, init);
    if (url.startsWith("/api/payments/quote")) return (routes.quote ?? (() => json(QUOTE)))(url, init);
    if (url === "/api/payments" && method === "POST") return routes.create!(url, init);
    if (url.startsWith("/api/payments?")) return routes.reconcile!(url, init);
    throw new Error(`unexpected request ${method} ${url}`);
  });
  const { actions, confirm } = tosePageActions({
    fetch: fetchMock as unknown as typeof fetch,
    approvePayment: async () => o.approve ?? true,
    showCheckout: (p) => {
      shownPayments.push(p);
      if (typeof o.shown === "function") return o.shown();
      return o.shown ?? true;
    },
  });
  return { actions, confirm, calls, shownPayments };
}

describe("runner error contract", () => {
  const action = (handler: PageAction["handler"], sensitivity: PageAction["sensitivity"] = "read"): PageAction[] => [{ name: "a", description: "", sensitivity, handler }];

  it("keeps a resolved { error } object a success, as third-party handlers rely on", async () => {
    const { result, statuses } = await run(action(() => ({ error: "field_level_note", rows: 0 })), "a", {});
    expect(result).toEqual({ id: "c1", name: "a", status: "ok", result: { error: "field_level_note", rows: 0 } });
    expect(statuses.at(-1)).toBe("done");
  });

  it("reports a thrown ActionError as a coded failure", async () => {
    const { result, statuses } = await run(action(() => { throw new ActionError("not_found", "Order not found"); }), "a", {});
    expect(result).toEqual({ id: "c1", name: "a", status: "error", error: "Order not found", code: "not_found" });
    expect(statuses.at(-1)).toBe("error");
  });

  it("reports an ActionError with an unknown outcome as unknown, never as ok or error", async () => {
    const { result, statuses } = await run(action(() => { throw new ActionError("payment_outcome_unknown", "Not confirmed", { outcome: "unknown" }); }, "mutate"), "a", {});
    expect(result).toEqual({ id: "c1", name: "a", status: "unknown", error: "Not confirmed", code: "payment_outcome_unknown" });
    expect(statuses.at(-1)).toBe("unknown");
  });

  it("recognises an ActionError thrown by another copy of the package", async () => {
    const foreign = Object.assign(new Error("Gone"), { name: "ActionError", code: "gone", outcome: "failed" });
    const { result } = await run(action(() => { throw foreign; }), "a", {});
    expect(result).toMatchObject({ status: "error", code: "gone", error: "Gone" });
  });

  it("keeps a plain thrown error an uncoded failure and replaces an unsafe code", async () => {
    expect((await run(action(() => { throw new Error("boom"); }), "a", {})).result).toEqual({ id: "c1", name: "a", status: "error", error: "boom" });
    expect(new ActionError("<script>", "x").code).toBe("action_failed");
    expect(new ActionError("amount_changed").message).toBe("amount_changed");
  });

  it("marks a write that timed out while running as unknown, and a read as failed", async () => {
    const never = () => new Promise(() => {});
    const write = await run(action(never, "mutate"), "a", {}, { timeoutMs: 5 });
    expect(write.result).toMatchObject({ status: "unknown", error: "Timed out while running; the outcome is not confirmed" });
    const read = await run(action(never, "read"), "a", {}, { timeoutMs: 5 });
    expect(read.result).toEqual({ id: "c1", name: "a", status: "error", error: "Timed out" });
  });

  it("marks a write the visitor stopped while it was running as unknown", async () => {
    const ctrl = new AbortController();
    const pending = run(action(() => new Promise(() => {}), "destructive"), "a", {}, { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    expect((await pending).result).toMatchObject({ status: "unknown", error: "Cancelled while running; the outcome is not confirmed" });
  });

  it("keeps a write the visitor declined as denied: nothing ran", async () => {
    const handler = vi.fn();
    const { result } = await run(action(handler, "mutate"), "a", {}, { confirm: () => false });
    expect(result.status).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("result wire format", () => {
  const results: ActionResult[] = [
    { id: "c1", name: "payments.create", status: "unknown", error: "Not confirmed", code: "payment_outcome_unknown" },
    { id: "c2", name: "orders.status", status: "error", error: "Order not found", code: "not_found" },
  ];

  it("round-trips unknown results and codes through the agent message and back from history", () => {
    expect(parseActionResults(formatActionResults(results))).toEqual(results);
  });

  it("keeps the status and code when an oversized result is shrunk", () => {
    const big: ActionResult = { id: "c1", name: "a", status: "unknown", code: "lost", result: { blob: "x".repeat(5000) } };
    const [restored] = parseActionResults(formatActionResults([big], 200));
    expect(restored).toMatchObject({ id: "c1", status: "unknown", code: "lost" });
  });

  it("tells the agent how to read an unknown result", () => {
    const block = buildPageBlock({ manifest: [{ name: "a", description: "", sensitivity: "read", parameters: { type: "object", properties: {} } }], hash: "h" });
    expect(block).toContain('Only status "ok" is a success.');
    expect(block).toContain('Status "unknown" means the outcome could not be confirmed: do not call that action again');
  });
});

describe("astro-node example: orders.status", () => {
  it("returns the order on success", async () => {
    const s = shop({ order: () => json({ id: "ord_1001a", status: "awaiting_payment", total: 250_000, currency: "VND" }) });
    const { result } = await run(s.actions, "orders.status", { orderId: "ord_1001a" });
    expect(result).toEqual({ id: "c1", name: "orders.status", status: "ok", result: { orderId: "ord_1001a", status: "awaiting_payment", total: 250_000, currency: "VND" } });
  });

  it("reports a missing order as an error with the server's code, not as a success", async () => {
    const s = shop({ order: () => refused(404, "not_found") });
    const { result, statuses } = await run(s.actions, "orders.status", { orderId: "ord_9999z" });
    expect(result).toEqual({ id: "c1", name: "orders.status", status: "error", error: "not_found message", code: "not_found" });
    expect(statuses).not.toContain("done");
  });

  it("falls back to the HTTP status when the server sends no code", async () => {
    const s = shop({ order: () => new Response("upstream down", { status: 502 }) });
    expect((await run(s.actions, "orders.status", { orderId: "ord_1001a" })).result).toMatchObject({ status: "error", code: "http_502" });
  });
});

describe("astro-node example: payments.create", () => {
  const pay = (s: ReturnType<typeof shop>) => run(s.actions, "payments.create", { orderId: "ord_1001a" }, { confirm: s.confirm });

  it("creates the payment and reports the checkout as shown only when the host showed it", async () => {
    const s = shop({ create: () => json(PAYMENT, 201) });
    const { result } = await pay(s);
    expect(result).toEqual({ id: "c1", name: "payments.create", status: "ok", result: { paymentId: "pay_1", status: "checkout_shown_to_customer" } });
    expect(s.shownPayments).toEqual([PAYMENT]);
  });

  it("does not claim the checkout was shown when the host could not show it", async () => {
    for (const shown of [false, () => { throw new Error("no container"); }] as const) {
      const s = shop({ create: () => json(PAYMENT, 201) }, { shown });
      expect((await pay(s)).result).toMatchObject({ status: "ok", result: { paymentId: "pay_1", status: "payment_created_checkout_not_shown" } });
    }
  });

  it("reports a price that changed after the customer agreed as an error and shows no checkout", async () => {
    const s = shop({ create: () => refused(409, "amount_changed") });
    const { result, statuses } = await pay(s);
    expect(result).toEqual({ id: "c1", name: "payments.create", status: "error", error: "amount_changed message", code: "amount_changed" });
    expect(statuses).not.toContain("done");
    expect(s.shownPayments).toEqual([]);
  });

  it("is denied, and sends nothing, when the customer declines", async () => {
    const s = shop({}, { approve: false });
    const { result } = await pay(s);
    expect(result.status).toBe("denied");
    expect(s.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("after a lost answer, finds the payment the server did create instead of creating another", async () => {
    const s = shop({ create: () => { throw new TypeError("Failed to fetch"); }, reconcile: () => json(PAYMENT) });
    const { result } = await pay(s);
    expect(result).toMatchObject({ status: "ok", result: { paymentId: "pay_1", status: "checkout_shown_to_customer" } });
    expect(s.calls.filter((c) => c === "POST /api/payments")).toHaveLength(1);
    expect(s.calls.at(-1)).toBe("GET /api/payments?orderId=ord_1001a");
  });

  it("after a lost answer, reports a plain failure when the server confirms nothing was created", async () => {
    const s = shop({ create: () => { throw new TypeError("Failed to fetch"); }, reconcile: () => refused(404, "not_found") });
    expect((await pay(s)).result).toMatchObject({ status: "error", code: "network_error" });
    expect(s.shownPayments).toEqual([]);
  });

  it("after a lost answer that cannot be reconciled, reports unknown and never success", async () => {
    for (const reconcile of [() => { throw new TypeError("Failed to fetch"); }, () => new Response("bad gateway", { status: 502 }), () => json({ ...PAYMENT, orderId: "ord_2002a" })]) {
      const s = shop({ create: () => { throw new TypeError("Failed to fetch"); }, reconcile });
      const { result, statuses } = await pay(s);
      expect(result).toMatchObject({ status: "unknown", code: "payment_outcome_unknown" });
      expect(statuses.at(-1)).toBe("unknown");
      expect(s.shownPayments).toEqual([]);
    }
  });

  it("reports unknown when the server accepted the request but the answer is unreadable", async () => {
    const s = shop({ create: () => new Response("<html>", { status: 201 }) });
    expect((await pay(s)).result).toMatchObject({ status: "unknown", code: "payment_outcome_unknown" });
  });
});
