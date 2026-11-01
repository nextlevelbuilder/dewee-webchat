// Astro Node SSR (examples/astro-node, standalone server) over transport "ccp": the shared browser
// contract, then what a TOSE-style host adds on top: its login mapped through `identity.authenticate`,
// logout and rebinding, two instances behind one load balancer, and the payment page action that
// needs the user's approval and the backend's own checks.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tosePageActions } from "../../astro-node/src/lib/page-actions";
import { browser, nextIp, sseEvents, type Browser } from "../src/browser";
import { EXAMPLES, startHost, type Host } from "../src/hosts";
import { STAGING, startTarget, type Target } from "../src/target";
import { ccpContract } from "./ccp-contract";

const DEMO_LOGIN_SECRET = `smoke-login-${randomBytes(24).toString("base64url")}`;

let target: Target;
let host: Host;
let second: Host;
const outputs: Browser[] = [];

function hostEnv(extra: Record<string, string> = {}): Record<string, string> {
  const id = target.identity;
  return {
    ...target.env,
    ...(id ? { DEWEE_IDENTITY_APP_ID: id.appId, DEWEE_IDENTITY_ISSUER: id.issuer, DEWEE_IDENTITY_ASSERTION_SECRET: id.assertionSecret } : {}),
    DEMO_LOGIN_SECRET,
    ...extra,
  };
}

beforeAll(async () => {
  target = await startTarget();
  target.secrets.push(DEMO_LOGIN_SECRET);
  // The integration lets signed-in customers in next to anonymous visitors (CCP config).
  if (target.fake) target.fake.state.config = { ...target.fake.state.config, mode: "signed_in_optional", identity_enabled: true };
  const started = await Promise.allSettled([startHost("astro-node", hostEnv()), startHost("astro-node", hostEnv())]);
  const failed = started.find((r) => r.status === "rejected");
  if (failed) {
    // Stop the instance that did start, so it does not outlive the run.
    await Promise.all(started.map((r) => (r.status === "fulfilled" ? r.value.stop() : undefined)));
    throw failed.reason;
  }
  [host, second] = started.map((r) => (r as PromiseFulfilledResult<Host>).value);
});

afterAll(async () => {
  await Promise.all([host?.stop(), second?.stop()]);
  await target?.close();
});

const open = (h: Host = host, origin?: string) => {
  const b = browser(h.origin, { origin: origin ?? target.visitorOrigin });
  outputs.push(b);
  return b;
};

/** Signs a demo user in through the host's own login route and returns the cookie a browser would keep. */
async function login(b: Browser, userId: string): Promise<string> {
  const res = await b.request("/api/auth/login", { body: { userId } });
  expect(res.status, res.text).toBe(200);
  const cookie = /tose_demo_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "")?.[0];
  expect(cookie).toBeDefined();
  return cookie!;
}

const chat = (b: Browser, token: string, cookie?: string, body: Record<string, unknown> = {}) =>
  b.request("/api/dewee/chat", { token, cookie, body: { message: "hi", conversationId: "conv_astro_0001", ...body } });

describe("Astro Node SSR: CCP browser contract", () => {
  ccpContract(() => ({ host, target, outputs, clientDir: join(EXAMPLES, "astro-node/dist/client") }));
});

describe.skipIf(STAGING && !process.env.DEWEE_IDENTITY_APP_ID)("Astro Node SSR: signed-in customers", () => {
  it("maps the host login to a verified Dewee identity", async () => {
    const b = open();
    const anonymous = (await b.request("/api/dewee/session", { body: {} })).json();
    expect(anonymous.verified).toBeFalsy();
    const cookie = await login(b, "u_1001");
    const res = await b.request("/api/dewee/session", { cookie, body: {} });
    expect(res.status, res.text).toBe(200);
    const s = res.json();
    expect(s.verified).toBe(true);
    expect(typeof s.reuseHint).toBe("string");
    const reply = sseEvents((await chat(b, s.token, cookie)).text);
    expect(reply.at(-1)!.type).toBe("done");
    if (target.fake) {
      expect(target.fake.routes("identity/exchange").length).toBeGreaterThan(0);
      expect(reply.find((e) => e.type === "delta")).toMatchObject({ text: "hello member" });
      // CCP receives an assertion about the user id, never the host's cookie.
      const exchange = JSON.stringify(target.fake.routes("identity/exchange").at(-1));
      expect(exchange).not.toContain("tose_demo_session");
    }
  });

  it("refuses a token replayed under another user's cookie and revokes it; signed out is refused only", async () => {
    const b = open();
    const lan = await login(b, "u_1001");
    const s = (await b.request("/api/dewee/session", { cookie: lan, body: {} })).json();
    const revokes = target.fake?.routes("identity/revoke").length ?? 0;

    const signedOut = await chat(b, s.token);
    expect(signedOut.status).toBe(401);
    expect(signedOut.json().error.code).toBe("IDENTITY_REQUIRED");
    if (target.fake) expect(target.fake.routes("identity/revoke")).toHaveLength(revokes);

    const minh = await login(open(), "u_2002");
    const switched = await chat(b, s.token, minh);
    expect(switched.status).toBe(401);
    expect(switched.json().error.code).toBe("IDENTITY_REQUIRED");
    if (target.fake) expect(target.fake.routes("identity/revoke")).toHaveLength(revokes + 1);
  });

  it("logout revokes the exact session at CCP; signing in again gets a new one", async () => {
    const b = open();
    const cookie = await login(b, "u_1001");
    const s = (await b.request("/api/dewee/session", { cookie, body: {} })).json();
    expect((await chat(b, s.token, cookie)).status).toBe(200);

    const out = await b.request("/api/auth/logout", { cookie, body: { hint: s.reuseHint } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/tose_demo_session=;.*Max-Age=0/);
    if (target.fake) expect(target.fake.routes("identity/revoke").length).toBeGreaterThan(0);

    // The old widget token is dead even for the same user.
    const replay = await chat(b, s.token, cookie);
    expect(replay.status).toBe(401);
    expect(replay.json().error.code).toBe("LINK_REVOKED");

    const again = await login(b, "u_1001");
    const fresh = (await b.request("/api/dewee/session", { cookie: again, body: {} })).json();
    expect(fresh.verified).toBe(true);
    expect(sseEvents((await chat(b, fresh.token, again)).text).at(-1)!.type).toBe("done");
  });

  it("refuses with 503 instead of answering as anonymous when the user directory is down", async () => {
    const down = await startHost("astro-node", hostEnv({ DEMO_USER_DIRECTORY: "down" }));
    try {
      const b = browser(down.origin, { origin: target.visitorOrigin });
      outputs.push(b);
      const res = await b.request("/api/dewee/session", { cookie: await login(open(), "u_1001"), body: {} });
      expect(res.status).toBe(503);
      expect(res.json().error.code).toBe("SOURCE_UNAVAILABLE");

      // Signing out still works during the outage: the cookie is cleared.
      const out = await b.request("/api/auth/logout", { cookie: await login(open(), "u_1001"), body: null });
      expect(out.status).toBe(200);
      expect(out.headers.get("set-cookie")).toMatch(/tose_demo_session=;.*Max-Age=0/);
    } finally {
      await down.stop();
    }
  });
});

describe.skipIf(STAGING && !process.env.DEWEE_IDENTITY_APP_ID)("Astro Node SSR: two instances (see #15)", () => {
  it("a token from one instance works on the other: visitor tokens are sealed, not stored", async () => {
    const a = open(host);
    const cookie = await login(a, "u_2002");
    const s = (await a.request("/api/dewee/session", { cookie, body: {} })).json();
    const onB = await chat(open(second), s.token, cookie);
    expect(onB.status).toBe(200);
    expect(sseEvents(onB.text).at(-1)!.type).toBe("done");
  });

  it("logout on one instance revokes the hinted session; a session only the other instance holds lives on", async () => {
    const a = open(host);
    const b = open(second);
    const cookie = await login(a, "u_2002");
    const s = (await a.request("/api/dewee/session", { cookie, body: {} })).json();
    expect((await chat(b, s.token, cookie)).status).toBe(200);
    // Another tab load-balanced to B, without the first tab's hint: B exchanges its own identity
    // session and keeps it in its per-process memory (the in-memory store of #15).
    const exchanges = target.fake?.routes("identity/exchange").length ?? 0;
    const fromB = (await b.request("/api/dewee/session", { cookie, body: {} })).json();
    if (target.fake) expect(target.fake.routes("identity/exchange")).toHaveLength(exchanges + 1);

    expect((await a.request("/api/auth/logout", { cookie, body: { hint: s.reuseHint } })).status).toBe(200);
    const replay = await chat(b, s.token, cookie);
    expect(replay.status).toBe(401);
    expect(replay.json().error.code).toBe("LINK_REVOKED");

    // The trade-off: A could not see B's session, so it stays valid at CCP until it expires. Without the
    // login cookie the handler still refuses it locally (rebindEachRequest).
    expect((await chat(b, fromB.token)).json().error.code).toBe("IDENTITY_REQUIRED");
    const stillAlive = await chat(b, fromB.token, cookie);
    expect(stillAlive.status).toBe(200);
    expect(sseEvents(stillAlive.text).at(-1)!.type).toBe("done");
  });

  it("rate limits count per instance unless the host supplies a shared limiter", async () => {
    const ip = nextIp();
    const a = open(host);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await a.request("/api/dewee/session", { body: {}, ip })).status);
    expect(statuses[10]).toBe(429);
    expect((await open(second).request("/api/dewee/session", { body: {}, ip })).status).toBe(200);
  });
});

describe("Astro Node SSR: TOSE-style backend routes the page actions call", () => {
  it("orders: only the signed-in owner reads an order", async () => {
    const b = open();
    expect((await b.request("/api/orders/ord_1001b")).status).toBe(401);
    const lan = await login(b, "u_1001");
    const own = await b.request("/api/orders/ord_1001b", { cookie: lan });
    expect(own.status).toBe(200);
    expect(own.json()).toMatchObject({ id: "ord_1001b", status: "shipped" });
    expect((await b.request("/api/orders/ord_2002a", { cookie: lan })).status).toBe(404);
  });

  it("payments: created only from an approved, server-signed quote, re-validated by the backend", async () => {
    const b = open();
    const lan = await login(b, "u_1001");
    const minh = await login(open(), "u_2002");

    const noQuote = await b.request("/api/payments", { cookie: lan, body: { orderId: "ord_1001a", amount: 1 } });
    expect(noQuote.status).toBe(400);
    expect(noQuote.json().error.code).toBe("approval_required");

    const quote = (await b.request("/api/payments/quote?orderId=ord_1001a", { cookie: lan })).json();
    expect(quote).toMatchObject({ orderId: "ord_1001a", amount: 250000, currency: "VND" });

    const tampered = await b.request("/api/payments", { cookie: lan, body: { quote: `${quote.quote.slice(0, -2)}xx` } });
    expect(tampered.status).toBe(400);
    expect(tampered.json().error.code).toBe("invalid_quote");

    const theirs = (await b.request("/api/payments/quote?orderId=ord_2002a", { cookie: minh })).json();
    const stolen = await b.request("/api/payments", { cookie: lan, body: { quote: theirs.quote } });
    expect(stolen.status).toBe(403);

    const crossSite = await b.request("/api/payments", { cookie: lan, origin: "https://evil.example", body: { quote: quote.quote } });
    expect(crossSite.status).toBe(403);

    const created = await b.request("/api/payments", { cookie: lan, body: { quote: quote.quote, amount: 1 } });
    expect(created.status, created.text).toBe(201);
    const payment = created.json();
    expect(payment).toMatchObject({ orderId: "ord_1001a", amount: 250000, currency: "VND" });
    expect(payment.checkoutUrl.startsWith("https://pay.example.test/checkout/")).toBe(true);

    const replay = await b.request("/api/payments", { cookie: lan, body: { quote: quote.quote } });
    expect(replay.status).toBe(409);
    expect(replay.json().error.code).toBe("quote_used");
  });

  it("chat carries the page-action manifest to CCP; a malformed manifest is refused locally", async () => {
    const b = open();
    const { token } = (await b.request("/api/dewee/session", { body: {} })).json();
    const { actions } = tosePageActions({ fetch, approvePayment: async () => false, showCheckout: () => {} });
    const manifest = actions.map(({ handler: _handler, ...entry }) => entry);
    const res = await chat(b, token, undefined, { actions: manifest, pageContext: { url: `${target.visitorOrigin}/orders`, title: "Orders" } });
    expect(res.status).toBe(200);
    if (target.fake) {
      const sent: string = target.fake.routes("chat").at(-1)!.body.message;
      expect(sent).toContain("orders.status");
      expect(sent).toContain("payments.create");
      expect(sent.endsWith("hi")).toBe(true);
    }
    const bad = await chat(b, token, undefined, { actions: [{ name: "bad name!", sensitivity: "read" }] });
    expect(bad.status).toBe(400);
    expect(bad.json().error.code).toBe("invalid_actions");
  });
});
