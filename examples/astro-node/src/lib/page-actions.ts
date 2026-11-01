// Page actions the agent may call on the TOSE-style page. Browser code: every call goes through the
// host's own API routes with the visitor's cookie, so the server stays the authority.
//
// - `orders.status` (read): a benign lookup of the visitor's own order.
// - `payments.create` (mutate): never runs without the host's own approval step. The confirm hook asks
//   the server for a signed quote, shows the server's amount to the user, and only a "yes" lets the
//   handler send that quote back; the server validates it again before creating anything.
import type { ActionConfirmHook, PageAction } from "dewee-webchat";

export interface PaymentQuote {
  quote: string;
  orderId: string;
  amount: number;
  currency: string;
  expiresAt: number;
}

export interface CreatedPayment {
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
  checkoutUrl: string;
}

export interface TosePageActionDeps {
  fetch: typeof fetch;
  /** The host's own approval UI. Resolve true only on an explicit user "yes". */
  approvePayment(quote: PaymentQuote): Promise<boolean>;
  /** The host renders the checkout link (or its own QR component) from the server's answer. */
  showCheckout(payment: CreatedPayment): void;
}

const orderIdSchema = { type: "string", pattern: "^ord_[a-z0-9]{4,32}$" } as const;

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => null);
}

export function tosePageActions(deps: TosePageActionDeps): { actions: PageAction[]; confirm: ActionConfirmHook } {
  /** Quotes the user approved, by action call id: the handler can only use the one for its own call. */
  const approved = new Map<string, PaymentQuote>();

  const actions: PageAction[] = [
    {
      name: "orders.status",
      description: "Look up the status and total of one of the signed-in customer's orders by order id (ord_…).",
      sensitivity: "read",
      parameters: { type: "object", properties: { orderId: orderIdSchema }, required: ["orderId"], additionalProperties: false },
      handler: async ({ orderId }: { orderId: string }, { signal }) => {
        const res = await deps.fetch(`/api/orders/${encodeURIComponent(orderId)}`, { credentials: "same-origin", signal });
        const body = await readJson(res);
        if (!res.ok) return { error: body?.error?.code ?? `http_${res.status}` };
        return { orderId: body.id, status: body.status, total: body.total, currency: body.currency };
      },
    },
    {
      name: "payments.create",
      description: "Start a payment for one of the signed-in customer's unpaid orders. The customer confirms the amount first.",
      sensitivity: "mutate",
      // Only the order id: the amount is never an argument the agent can choose.
      parameters: { type: "object", properties: { orderId: orderIdSchema }, required: ["orderId"], additionalProperties: false },
      handler: async ({ orderId }: { orderId: string }, { callId, signal }) => {
        const quote = approved.get(callId);
        approved.delete(callId);
        if (!quote || quote.orderId !== orderId) throw new Error("Payment was not approved");
        const res = await deps.fetch("/api/payments", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ quote: quote.quote }),
          signal,
        });
        const body = await readJson(res);
        if (!res.ok) return { error: body?.error?.code ?? `http_${res.status}` };
        deps.showCheckout(body as CreatedPayment);
        // The checkout URL stays with the host UI; the agent only learns that checkout is ready.
        return { paymentId: body.paymentId, status: "checkout_shown_to_customer" };
      },
    },
  ];

  const confirm: ActionConfirmHook = async (action, args) => {
    if (action.name !== "payments.create") return false;
    const orderId = typeof args.orderId === "string" ? args.orderId : "";
    const res = await deps.fetch(`/api/payments/quote?orderId=${encodeURIComponent(orderId)}`, { credentials: "same-origin" });
    if (!res.ok) return false;
    const quote = (await readJson(res)) as PaymentQuote | null;
    if (!quote || quote.orderId !== orderId) return false;
    if (!(await deps.approvePayment(quote))) return false;
    approved.set(action.callId, quote);
    return true;
  };

  return { actions, confirm };
}
