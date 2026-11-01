# Astro (Node SSR) + dewee-webchat over CCP

A TOSE-style shop on Astro with `@astrojs/node` (standalone): a login, the customer's orders, and the
chat widget over `transport: "ccp"`. It shows the parts a host adds on top of the SDK:

- Signed-in customers: the host login is mapped through `identity.authenticate`
  ([`src/lib/dewee.ts`](src/lib/dewee.ts)), with `rebindEachRequest` and a logout that revokes the
  user's Dewee session ([`src/pages/api/auth/logout.ts`](src/pages/api/auth/logout.ts)).
- Page actions ([`src/lib/page-actions.ts`](src/lib/page-actions.ts)): `orders.status` reads one of
  the customer's orders; `payments.create` needs the customer's approval of a server-signed quote,
  and the backend checks everything again before creating a payment
  ([`src/lib/orders.ts`](src/lib/orders.ts)). The checkout link is rendered by the page, not by the
  model.

The login, orders and payments are an in-memory demo. Replace `currentUser(request)` with your real
session lookup and the order/payment functions with calls to your backend.

The smoke tests in [`examples/ccp-smoke`](../ccp-smoke) run this example against a fake CCP in CI; what
they cover, the staging run, and who does what (SDK, host, backend) are in
[`docs/ccp-host-smoke.md`](../../docs/ccp-host-smoke.md).

## Run

```bash
pnpm install
pnpm build                       # at the repository root: packages/dewee-webchat/dist
cp examples/astro-node/.env.example examples/astro-node/.env   # fill it in, never commit it
pnpm -C examples/astro-node build
node --env-file=examples/astro-node/.env examples/astro-node/dist/server/entry.mjs
```

Settings are read from `process.env` when the server runs, never at build time. `pnpm dev` runs the
dev server on port 4322 with the variables from your shell.

## Several instances, proxies

- Every instance needs the same `DEWEE_WEBCHAT_SECRET` and `DEMO_LOGIN_SECRET`; visitor tokens and the
  login cookie then work on any instance.
- The identity session cache and the default rate limiter are per process. Logout revokes the session
  the widget's hint names and those the instance holds; a session another instance exchanged lives
  until it expires. A shared store is
  [#15](https://github.com/nextlevelbuilder/dewee-webchat/issues/15).
- Behind a reverse proxy, put the public origin in `DEWEE_ALLOWED_ORIGINS` and `SITE_ORIGIN`: the
  server sees its internal address, and same-origin calls would otherwise be refused with `403`.
