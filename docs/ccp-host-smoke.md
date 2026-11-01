# CCP host smoke tests (Astro Node, Next.js)

[`examples/ccp-smoke`](../examples/ccp-smoke) starts the **built** host examples as real Node servers
and drives them the way a browser would, over `transport: "ccp"`:

- [`examples/astro-node`](../examples/astro-node): Astro SSR on `@astrojs/node` (standalone), a
  TOSE-style shop with a login, orders, a payment page action and signed-in customers.
- [`examples/nextjs`](../examples/nextjs): Next.js App Router under `next start`.

CI runs them against the fake CCP ingress the package tests use
([`fake-ccp-ingress.ts`](../packages/dewee-webchat/test/helpers/fake-ccp-ingress.ts)). The same suites run
against a real staging integration when you give them credentials (see [Staging](#staging)).

## What is covered

Both hosts (the shared contract, [`test/ccp-contract.ts`](../examples/ccp-smoke/test/ccp-contract.ts)):

- `/api/dewee/config`, `/session` (refresh keeps the visitor), `/chat` as SSE, `/history`.
- `401` for expired, forged, altered and missing visitor tokens; `404` for unknown routes and methods.
- Origins: a foreign site is `403 forbidden_origin` without CORS headers, an allowed one gets CORS.
- Agents outside the integration are `403 agent_not_allowed`; malformed keys `400`.
- Limits: `413` for a long message, `429` for the 11th new session from one address.
- Fake only: CCP refusals become typed answers without CCP's own text (`503 unavailable`,
  `429 RATE_LIMITED`, `run_failed`, a revoked integration secret as `500 not_configured`), and an
  expired CCP edge session is refreshed through `/session`.
- Hygiene: no integration secret, visitor secret, assertion secret, raw edge session, ingress path,
  reasoning or tool output reaches anything a browser receives (responses, the page, its scripts, the
  built client files), nor the host's logs. No legacy Gateway URL or token appears on the path, and
  the fake sees only known CCP routes. `pnpm build:hosts` builds with canary values in every secret
  variable and fails if one is inlined into a client file.

Astro Node only ([`test/astro-node.smoke.test.ts`](../examples/ccp-smoke/test/astro-node.smoke.test.ts)):

- Signed-in customers, logout and rebinding, two instances, the user directory failing (`503`).
- The order and payment routes the page actions call, and the page-action manifest in `/chat`.
- [`test/page-actions.test.ts`](../examples/ccp-smoke/test/page-actions.test.ts): the browser half of
  the payment action (no approval, no payment request).

## Run it

```bash
pnpm install
pnpm build                              # packages/dewee-webchat/dist, used by both hosts
pnpm -C examples/ccp-smoke build:hosts  # builds both examples, checks the client bundles
pnpm -C examples/ccp-smoke test         # fake CCP; starts and stops every server itself
```

Each suite starts its hosts on free loopback ports and stops them afterwards, checking that the
port is closed, so no server outlives the run. Nothing listens on a fixed port.

## Staging

Credentials come from the environment only. Never put them in a file in the repository; `.env` files
are ignored by git, and the runner never prints a value.

| Variable | |
|---|---|
| `DEWEE_CCP_CHAT_URL` | `https://…/api/public/webchat/v1/wci_…` from the CCP "Website chat" page |
| `DEWEE_WEBCHAT_INTEGRATION_ID` | the `wci_…` id in that URL |
| `DEWEE_WEBCHAT_INTEGRATION_SECRET` | the private `dwc_…` secret (server-side only) |
| `DEWEE_SMOKE_VISITOR_ORIGIN` | an `https://` origin in the integration's allowed origins |
| `DEWEE_IDENTITY_APP_ID`, `DEWEE_IDENTITY_ISSUER`, `DEWEE_IDENTITY_ASSERTION_SECRET` | optional: the signed-in checks run only with these |

```bash
pnpm -C examples/ccp-smoke test:staging
```

1. **Environment check first.** [`run-staging.mjs`](../examples/ccp-smoke/scripts/run-staging.mjs)
   runs [`staging-env.test.ts`](../examples/ccp-smoke/test/staging-env.test.ts) before anything starts.
   It names each missing or malformed variable (wrong URL shape, an id that does not match the URL, a
   secret that is not `dwc_…`, a non-https origin) and refuses any `DEWEE_GATEWAY_*`/`GOCLAW_GATEWAY_*`
   variable. Hosts get a filtered environment, so nothing else from your shell reaches them.
2. **The suites** then run against staging: the contract checks above that need no fault injection,
   plus the Astro Node signed-in and payment checks. Each run uses its own random visitor secret.
3. **404 / 503 / 401 by hand**, because they change the integration itself. With a host running
   (`pnpm -C examples/astro-node start` with the same variables, plus `SITE_ORIGIN`):

   | Case | How | Expected from `POST /api/dewee/session` |
   |---|---|---|
   | Wrong integration | change the `wci_…` id in `DEWEE_CCP_CHAT_URL` and `DEWEE_WEBCHAT_INTEGRATION_ID` | `404 not_found` |
   | Integration paused | disable it in CCP | `503 unavailable` |
   | Secret rotated away | rotate the secret in CCP, keep the old one in the host | `500 not_configured` (CCP answered `401`) |
   | Visitor token | send an expired or altered `Authorization` to `/chat` | `401 unauthorized` |

   Re-enable the integration and put the current secret back afterwards.
4. **Teardown.** The suites stop every server they start and fail if a port stays open. Staging keeps
   the conversations and identity sessions the run created: identity sessions expire on their own and
   logout revokes the ones the run signed out; conversations are test data under the run's visitors.
   Rotate the integration secret if it was ever exposed outside the environment.

## Who does what

| Concern | `dewee-webchat` (SDK) | Host backend (BFF: Astro/Next route) | TOSE backend |
|---|---|---|---|
| Integration secret, visitor tokens | Holds the secret server-side, seals visitor tokens, refreshes CCP edge sessions | Supplies the variables at run time | — |
| Origins, rate limits | Checks `Origin` against the host's own origin and `DEWEE_ALLOWED_ORIGINS`; in-memory limits per process | Lists its public origin behind a proxy; supplies a shared `rateLimit` if it runs several instances | — |
| Who the user is | Calls `identity.authenticate(req)`, exchanges a signed assertion, rebinds per request | Maps its own login to a stable subject (never an email), revokes on logout | Owns accounts and the session cookie |
| Page actions | Sends the manifest (no handlers) to the agent, runs the handler in the browser after `confirm` | Declares the actions, its approval UI, renders results | — |
| Reading an order | — | Calls its API with the user's cookie | Checks login and ownership |
| Creating a payment | — | Shows the server's quote, sends it back only on "yes" | Signs quotes, re-checks login, CSRF, owner, state and amount; creates the payment |
| Payment QR / link | Renders Markdown as text (no HTML) | Renders the link or its own QR component from the backend's answer | Issues the checkout URL |

### Signed-in users

[`src/lib/dewee.ts`](../examples/astro-node/src/lib/dewee.ts) maps the host login to
`identity.authenticate`: the stable user id becomes the subject, the cookie never leaves the host.
`rebindEachRequest: true` because the login is a cookie: a widget token replayed under another user's
cookie is refused (`401 IDENTITY_REQUIRED`) and that user's session is revoked at CCP; a request with
no login is only refused. The logout route calls `handler.revoke(user, request, hint)` with the
widget's `chat.reuseHint()`, so the exact session is revoked even when another instance issued it.
A login check that throws gives `503 SOURCE_UNAVAILABLE`, never an anonymous answer.

### Several instances

Visitor tokens are sealed, not stored: a token from one instance works on any other with the same
`DEWEE_WEBCHAT_SECRET`. What stays per process today:

- The identity session cache. Logout on instance A revokes the session in the hint and those A
  holds; a session only instance B exchanged (another tab load-balanced there) stays valid at CCP
  until it expires. B still refuses it without the login cookie. The smoke test shows exactly this.
  A shared session store is [#15](https://github.com/nextlevelbuilder/dewee-webchat/issues/15), not
  solved here.
- The rate limiter: each instance counts on its own, so N instances allow N times the limit. Pass a
  shared `rateLimit` implementation (Redis, Durable Objects…) for a real limit.
- Each new tab of a signed-in user on a host without shared memory costs one identity exchange.

### Behind a proxy

The handler compares `Origin` with the origin of `request.url`. Neither `next start` nor the Astro
Node adapter derives that from `X-Forwarded-Host`/`-Proto` by default, so behind a reverse proxy or a
load balancer a same-origin browser call is refused with `403 forbidden_origin` unless the public
origin is in `DEWEE_ALLOWED_ORIGINS` (the smoke runs set it the same way). The Astro example's own
routes use `SITE_ORIGIN` for the same reason.

### Payments need the user and the backend

`payments.create` is a `mutate` action whose only argument is the order id. Its `confirm` hook asks
the backend for a signed quote and shows the server's amount; only an explicit "yes" lets the handler
send that quote back. The backend creates nothing without a quote and checks again: login, same-origin
JSON, owner, order still unpaid, amount unchanged, quote not expired or reused. The checkout URL goes
to the host UI, not back to the agent.

### QR codes and links

Until safe image rendering lands ([#9](https://github.com/nextlevelbuilder/dewee-webchat/issues/9)),
do not render payment QR codes from the model's output and never parse HTML the model returns. Let the
backend issue the checkout URL, and have the host render it as a link or with its own QR component
(the Astro example's `#checkout` section, which the widget's DOM actions ignore).

### Page awareness

The example sends a small `getPageContext()` (the current route) with each message. Fuller current-page
awareness is [#2](https://github.com/nextlevelbuilder/dewee-webchat/issues/2).
