// Page actions the agent may call on the TOSE-style page. Browser code: every call goes through the
// host's own API routes with the visitor's cookie, so the server stays the authority.
//
// - `orders.status` (read): a benign lookup of the visitor's own order.
// - `payments.create` (mutate): never runs without the host's own approval step. The confirm hook asks
//   the server for a signed quote, shows the server's amount to the user, and only a "yes" lets the
//   handler send that quote back; the server validates it again before creating anything.
//
// Error contract: a handler that resolves has succeeded. A refused request throws `ActionError(code)`,
// so the agent gets `status: "error"` with the server's code instead of a "successful" `{ error }`.
// A write whose answer was lost is reconciled with the server first; only when that is impossible too
// does the handler report `outcome: "unknown"`, which tells the agent not to try again.
import { ActionError, type ActionConfirmHook, type PageAction } from "dewee-webchat";

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
  /**
   * The host renders the checkout link (or its own QR component) from the server's answer.
   * Resolve true only when the customer can actually see it. Seeing the link is not opening it,
   * and neither is paying: the agent is told `checkout_link_shown`, nothing more.
   */
  showCheckout(payment: CreatedPayment): boolean | Promise<boolean>;
}

const orderIdSchema = { type: "string", pattern: "^ord_[a-z0-9]{4,32}$" } as const;

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => null);
}

/** The server's own error code, or the HTTP status when it sent none. */
function refusal(res: Response, body: any): ActionError {
  const code = typeof body?.error?.code === "string" ? body.error.code : `http_${res.status}`;
  return new ActionError(code, typeof body?.error?.message === "string" ? body.error.message : undefined);
}

const isPayment = (v: any): v is CreatedPayment =>
  !!v && typeof v.paymentId === "string" && typeof v.orderId === "string" && typeof v.checkoutUrl === "string";

export function tosePageActions(deps: TosePageActionDeps): { actions: PageAction[]; confirm: ActionConfirmHook } {
  /** Quotes the user approved, by action call id: the handler can only use the one for its own call. */
  const approved = new Map<string, PaymentQuote>();

  /**
   * After a POST whose answer was lost or unusable: asks the server whether the payment exists.
   * Resolves the payment, `null` only when this API itself says there is none (a 404 from a proxy
   * proves nothing), and throws when it cannot tell. A payment that does not match the approved
   * quote was made elsewhere (another tab), so it is not this call's success either.
   */
  async function reconcilePayment(quote: PaymentQuote, signal: AbortSignal): Promise<CreatedPayment | null> {
    const res = await deps.fetch(`/api/payments?orderId=${encodeURIComponent(quote.orderId)}`, { credentials: "same-origin", signal });
    const body = await readJson(res);
    if (res.status === 404 && body?.error?.code === "not_found") return null;
    if (!res.ok || !isPayment(body) || body.orderId !== quote.orderId) throw new Error("reconcile failed");
    if (body.amount !== quote.amount || body.currency !== quote.currency) throw new Error("payment does not match the quote");
    return body;
  }

  /** The write may or may not have happened: report what the server says, or that nobody knows. */
  async function settleLostAnswer(quote: PaymentQuote, signal: AbortSignal) {
    let found: CreatedPayment | null;
    try {
      found = await reconcilePayment(quote, signal);
    } catch (e) {
      if (signal.aborted) throw e; // stopped or timed out: the SDK reports a write as unconfirmed
      throw new ActionError("payment_outcome_unknown", "The payment request was sent but its result could not be confirmed. Check the order before trying again.", { outcome: "unknown" });
    }
    if (!found) throw new ActionError("payment_not_created", "The payment request did not go through; no payment was created.");
    return finish(found);
  }

  const actions: PageAction[] = [
    {
      name: "orders.status",
      description: "Look up the status and total of one of the signed-in customer's orders by order id (ord_…).",
      sensitivity: "read",
      parameters: { type: "object", properties: { orderId: orderIdSchema }, required: ["orderId"], additionalProperties: false },
      handler: async ({ orderId }: { orderId: string }, { signal }) => {
        const res = await deps.fetch(`/api/orders/${encodeURIComponent(orderId)}`, { credentials: "same-origin", signal });
        const body = await readJson(res);
        if (!res.ok) throw refusal(res, body);
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
        if (!quote || quote.orderId !== orderId) throw new ActionError("approval_required", "Payment was not approved");

        let res: Response;
        try {
          res = await deps.fetch("/api/payments", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ quote: quote.quote }),
            signal,
          });
        } catch (sendError) {
          // Stopped or timed out: the SDK reports that itself (as unconfirmed, for a write).
          if (signal.aborted) throw sendError;
          // The request may have reached the server. Ask before telling the agent anything.
          return settleLostAnswer(quote, signal);
        }
        // A gateway error or timeout says nothing about the write behind it: the backend may have
        // committed before the proxy gave up. Only this API's own 4xx is a definite refusal.
        if (res.status >= 500 || res.status === 408) return settleLostAnswer(quote, signal);
        const body = await readJson(res);
        if (!res.ok) throw refusal(res, body);
        if (!isPayment(body)) return settleLostAnswer(quote, signal);
        return finish(body);
      },
    },
  ];

  /** The checkout URL stays with the host UI; the agent only learns whether the customer can see it. */
  async function finish(payment: CreatedPayment) {
    let shown = false;
    try {
      shown = (await deps.showCheckout(payment)) === true;
    } catch {
      shown = false;
    }
    // "Shown" is not "paid": proof of payment comes from the payment system, never from this page.
    return { paymentId: payment.paymentId, status: shown ? "checkout_link_shown" : "payment_created_checkout_not_shown" };
  }

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
