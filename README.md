# dewee-webchat

Embeddable chat for [Dewee](https://dewee.sh) agents. Drop one tag on any site and visitors talk to your
agent, with streamed answers, markdown, history and agent switching. Your integration secret stays on
your server.

**▶ Playground:** [webchat.dewee.sh](https://webchat.dewee.sh) · **npm:** [`dewee-webchat`](https://www.npmjs.com/package/dewee-webchat) ·
**CDN:** `https://webchat-cdn.dewee.sh/dewee-webchat@0.1.1/dewee-webchat.js`

```
browser <dewee-chat>  ──HTTPS + SSE──▶  your backend /api/dewee/*  ──HTTPS + SSE──▶  Dewee CCP (Website chat)
   (visitor token only)                   (holds the integration secret)            (agents, sign-in, limits)
```

## Quick start

```bash
npm i dewee-webchat
```

1. In CCP, create a **Website chat** integration: pick its agents, allowed sites and sign-in mode.
2. Mount the backend handler at `/api/dewee/*` (Workers, Next.js, Astro, Node, Bun, Deno, or the PHP file).
3. Set `DEWEE_CCP_CHAT_URL`, `DEWEE_WEBCHAT_INTEGRATION_ID`, `DEWEE_WEBCHAT_INTEGRATION_SECRET` (from the
   integration page) and `DEWEE_WEBCHAT_SECRET`. See [`.env.example`](.env.example).
4. Add the widget:

```html
<script src="https://webchat-cdn.dewee.sh/dewee-webchat@0.1.1/dewee-webchat.js" data-endpoint="/api/dewee" defer></script>
```

Full options, framework snippets and the security model: [packages/dewee-webchat/README.md](packages/dewee-webchat/README.md).

Connecting straight to a Dewee Gateway with a URL and token (`transport: "legacy-gateway"`) still
works but is deprecated. Moving over: [docs/migrating-to-ccp-transport.md](docs/migrating-to-ccp-transport.md).

## Signed-in users

If your site knows who the visitor is, pass one server-side callback (`identity.authenticate`) to the
handler. It exchanges your user for a short-lived Dewee identity session, and the agent then chats as
that verified user, with private tools scoped to them. You no longer mint visitor tokens, push
per-visitor credentials or build your own account linking: a signed-in user links Telegram or Discord
from the widget with a one-time code. Anonymous visitors work exactly as before. Setup and the
fail-closed rules: [Signed-in users](packages/dewee-webchat/README.md#signed-in-users). The PHP backend
serves anonymous visitors only.

## Live examples

All of them run on Cloudflare and share the same scoped demo key. The hosted demos still use the
deprecated `legacy-gateway` transport; each example's README shows the CCP configuration first.

| Stack | Live | Source |
|---|---|---|
| Plain HTML + Worker (playground) | [webchat.dewee.sh](https://webchat.dewee.sh) | [examples/cloudflare](examples/cloudflare) |
| Next.js (App Router, OpenNext) | [webchat-next.dewee.sh](https://webchat-next.dewee.sh) | [examples/nextjs](examples/nextjs) |
| Astro | [webchat-astro.dewee.sh](https://webchat-astro.dewee.sh) | [examples/astro](examples/astro) |
| React + Vite | [webchat-react.dewee.sh](https://webchat-react.dewee.sh) | [examples/react-vite](examples/react-vite) |
| Vue + Vite | [webchat-vue.dewee.sh](https://webchat-vue.dewee.sh) | [examples/vue-vite](examples/vue-vite) |
| Astro (Node SSR, CCP only: login, page actions, payments) | local | [examples/astro-node](examples/astro-node) |
| Node + Express | local | [examples/node-express](examples/node-express) |
| PHP (no Composer) | local | [examples/php](examples/php) · [php/](php) |

## Repository layout

| Path | |
|---|---|
| [`packages/dewee-webchat`](packages/dewee-webchat) | The npm package: web component, React/Vue/Astro wrappers, `dewee-webchat/server` handler |
| [`php/dewee-webchat.php`](php) | Single-file PHP backend with the same HTTP contract |
| [`cdn/`](cdn) | Worker that serves versioned bundles at `webchat-cdn.dewee.sh` |
| [`docs/http-contract.md`](docs/http-contract.md) | Wire format between the widget and any backend |
| [`docs/migrating-to-ccp-transport.md`](docs/migrating-to-ccp-transport.md) | Moving from a direct Gateway URL and token to a CCP Website chat integration |
| [`docs/ccp-host-smoke.md`](docs/ccp-host-smoke.md) | CCP smoke tests for the Astro Node and Next.js hosts, staging run, and who does what (SDK, host, backend) |
| [`examples/`](examples) | Runnable integrations; [`examples/ccp-smoke`](examples/ccp-smoke) runs the built hosts against a fake CCP |
| [`vendor/`](vendor) | Temporary: the packed `@dewee/identity` SDK used by the tests (see below) |

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build       # packages/dewee-webchat/dist
pnpm -C examples/ccp-smoke build:hosts && pnpm -C examples/ccp-smoke test   # host smoke over CCP
```

`@dewee/identity` (the Dewee identity server SDK) is not published to npm yet. Until it is, the tests use a
tarball packed from the dewee repository (`packages/dewee-identity`, `pnpm --filter @dewee/identity pack`) and
committed as `vendor/dewee-identity-<version>.tgz`; `packages/dewee-webchat` depends on it as a dev dependency
through `file:`. This is temporary: once the SDK is published, the dev dependency switches to the npm version and
`vendor/` is deleted. For users the SDK is an optional peer dependency, needed only with the `identity` option.

Run the playground locally: copy `examples/cloudflare/.dev.vars.example` to `.dev.vars`, fill it in, then
`pnpm -C examples/cloudflare dev`.

Release: bump `packages/dewee-webchat/package.json` (and `VERSION` in `php/dewee-webchat.php`), commit, then
push a matching tag (`git tag v0.1.2 && git push origin v0.1.2`). [`release.yml`](.github/workflows/release.yml)
publishes to npm through npm Trusted Publishing (OIDC, no token) and creates the GitHub release. Then run
`node cdn/scripts/build-cdn.mjs && pnpm -C examples/cloudflare exec wrangler deploy --config ../../cdn/wrangler.jsonc`
to add the version to the CDN.

## License

[MIT](LICENSE)
