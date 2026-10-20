# dewee-webchat

Put your [Dewee](https://dewee.sh) agent on any website. A dependency-free chat widget that streams the
agent's **reasoning** and **tool calls**, plus a small backend handler that keeps your gateway token
off the browser.

**Playground:** [webchat.dewee.sh](https://webchat.dewee.sh) · **CDN:** [webchat-cdn.dewee.sh](https://webchat-cdn.dewee.sh) ·
**Source & examples:** [github.com/nextlevelbuilder/dewee-webchat](https://github.com/nextlevelbuilder/dewee-webchat)

```
browser <dewee-chat>  ──HTTPS + SSE──▶  your backend /api/dewee/*  ──WebSocket──▶  Dewee gateway
   (visitor token only)                   (holds the gateway token)                (agents, MCP, tools)
```

## 1. Add the backend

The handler is a standard `(Request) => Promise<Response>`, so it runs on Cloudflare Workers, Next.js,
Astro, Bun, Deno and Node (via `toNodeHandler`).

```ts
// Next.js: app/api/dewee/[...path]/route.ts
import { createDeweeHandler, optionsFromEnv } from "dewee-webchat/server";

export const dynamic = "force-dynamic";
const handler = createDeweeHandler(optionsFromEnv(process.env));
export { handler as GET, handler as POST, handler as OPTIONS };
```

```ts
// Express
import { createDeweeHandler, optionsFromEnv, toNodeHandler } from "dewee-webchat/server";
app.all("/api/dewee/*path", toNodeHandler(createDeweeHandler(optionsFromEnv(process.env))));
```

```ts
// Cloudflare Workers
let dewee;
export default {
  fetch(req, env) {
    if (new URL(req.url).pathname.startsWith("/api/dewee/")) return (dewee ??= createDeweeHandler(optionsFromEnv(env)))(req);
    return env.ASSETS.fetch(req);
  },
};
```

PHP? Use the single-file backend in [`php/`](https://github.com/nextlevelbuilder/dewee-webchat/tree/main/php).

### Environment

| Variable | |
|---|---|
| `DEWEE_GATEWAY_URL` | Gateway runtime origin, e.g. `https://gateway.example.com` |
| `DEWEE_GATEWAY_TOKEN` | Operator API key (`operator.read,operator.write`) or gateway token. **Server only.** |
| `DEWEE_WEBCHAT_SECRET` | 32+ random chars to sign visitor sessions (`openssl rand -base64 32`) |
| `DEWEE_AGENTS` | Allowlist, comma separated (`support,sales`) or `*` |
| `DEWEE_DEFAULT_AGENT` | Optional; defaults to the first allowed agent |
| `DEWEE_ALLOWED_ORIGINS` | Extra origins for cross-origin embedding (same origin always works) |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Optional Cloudflare Turnstile check for new visitors |

Create a scoped key with the Dewee CLI: `dewee api-keys create --name "website chat" --scopes operator.read,operator.write`.

## 2. Add the widget

**Script tag** (no build step):

```html
<script
  src="https://webchat-cdn.dewee.sh/dewee-webchat@0.1.1/dewee-webchat.js"
  data-endpoint="/api/dewee"
  data-title="Support"
  data-suggestions="What do you do?|Pricing?"
  defer
></script>
```

**React / Next.js**

```tsx
"use client";
import { DeweeChat } from "dewee-webchat/react";

<DeweeChat endpoint="/api/dewee" title="Support" suggestions={["Pricing?"]} showReasoning={false} onReply={(e) => console.log(e.detail)} />;
```

**Vue**

```vue
<script setup>
import { DeweeChat } from "dewee-webchat/vue";
</script>
<template><DeweeChat endpoint="/api/dewee" :show-tool-calls="false" @reply="onReply" /></template>
```

**Astro**

```astro
---
import DeweeChat from "dewee-webchat/astro";
---
<DeweeChat endpoint="/api/dewee" title="Support" />
```

**Anything else**: `import { mount } from "dewee-webchat"; mount({ endpoint: "/api/dewee" })`, or write
`<dewee-chat endpoint="/api/dewee"></dewee-chat>` after importing `dewee-webchat`.

## Options

Attributes use kebab-case (`show-reasoning="false"`), `data-*` on the script tag, camelCase as props.

| Option | Default | |
|---|---|---|
| `endpoint` | `/api/dewee` | Backend base URL |
| `agent` | backend default | Agent key |
| `title`, `subtitle`, `greeting`, `intro`, `placeholder` | | Texts |
| `suggestions` | | Quick replies (`a|b` or JSON array as attribute) |
| `avatar`, `launcherAvatar` | | Image URL; also use it on the launcher |
| `mode` | `floating` | `floating` (bubble + panel) or `inline` (fills its container) |
| `position` | `bottom-right` | or `bottom-left` |
| `theme` | `light` | `light`, `dark`, `auto` |
| `accentColor` | `#5446e8` | Any CSS color |
| `locale` | page language | `en`, `vi` |
| `showReasoning` | `true` | Stream the model's thinking |
| `showToolCalls` | `true` | Show tool calls with arguments and results |
| `allowAgentSwitch` | `true` | Agent picker when the backend allows several |
| `persist` | `true` | Keep the conversation across page loads |
| `open`, `hideBranding`, `width`, `height`, `zIndex` | | |
| `actions`, `confirm`, `getPageContext` | | [Page actions](#agent-page-actions) (JS/props only) |
| `maxActionRounds` | `5` | Automatic action turns per visitor message |
| `actionTimeoutMs` | `30000` | Per-handler timeout |

Methods: `open()`, `close()`, `toggle()`, `send(text)`, `stop()`, `newConversation()`, `configure(partial)`,
`registerActions(actions)`, `unregisterAction(name)`, and for [signed-in users](#signed-in-users)
`renewSession()` and `startLink()`.
Events: `dewee:ready`, `dewee:open`, `dewee:close`, `dewee:send`, `dewee:reply`, `dewee:error`, `dewee:action`, `dewee:link`.
CSS variables: `--dw-accent`, `--dw-font`, `--dw-radius`, `--dw-width`, `--dw-height`, `--dw-z`.

## Agent page actions

Let the agent operate the page the visitor is on: navigate, filter a table, cancel a job. The page
registers typed actions; the agent calls them from chat; the widget validates, asks for approval when
needed, runs the handler and sends the result back to the agent. No gateway changes are needed.

```tsx
import { DeweeChat, type PageAction } from "dewee-webchat/react";

const actions: PageAction[] = [
  {
    name: "navigate",
    description: "Open a dashboard page.",
    sensitivity: "navigate",
    parameters: { type: "object", properties: { route: { type: "string", enum: ["/", "/runs", "/settings"] } }, required: ["route"] },
    handler: ({ route }) => { router.push(route); return { route }; },
  },
  {
    name: "runs.cancel",
    description: "Cancel a running job by id.",
    sensitivity: "mutate", // asks the visitor before running
    parameters: { type: "object", properties: { id: { type: "string", pattern: "^run_[a-z0-9]+$" } }, required: ["id"], additionalProperties: false },
    handler: async ({ id }, { signal }) => (await fetch(`/api/runs/${id}/cancel`, { method: "POST", signal })).json(),
  },
];

<DeweeChat endpoint="/api/dewee" actions={actions} getPageContext={() => ({ route: location.pathname })} onAction={(e) => console.log(e.detail)} />;
```

Vanilla: `chat.registerActions(actions)`, `chat.unregisterAction("navigate")`, or
`chat.configure({ actions, confirm, getPageContext })`. Vue: `:actions`, `:confirm`, `:get-page-context`, `@action`.

```ts
interface PageAction<Args = any> {
  name: string;                    // ^[a-z][a-z0-9_.-]{0,63}$
  description: string;             // written for the agent, ≤ 1000 chars
  parameters?: JsonSchema;         // object schema; subset: type, properties, required, additionalProperties,
                                   // enum, const, min/maxLength, pattern, minimum/maximum, items, min/maxItems
  sensitivity: "read" | "navigate" | "mutate" | "destructive";
  handler(args: Args, ctx: { callId: string; conversationId: string; agent: string; signal: AbortSignal }): unknown | Promise<unknown>;
}
type ActionConfirmHook = (action: PageActionInfo & { callId: string }, args: Record<string, unknown>) => boolean | Promise<boolean>;
```

- `mutate` and `destructive` actions run only after approval: the built-in accessible dialog, or your
  `confirm(action, args)` hook — only a resolved `true` approves. A denial is reported to the agent as
  `status: "denied"`.
- Each call shows a status chip (pending, awaiting confirmation, running, done, denied, error). Stop
  cancels running handlers (`ctx.signal`).
- `getPageContext()` returns a small snapshot (≤ 4 KB as JSON) sent with every message. Redact it yourself.
- `dewee:action` fires with `{ phase: "start" | "result", id, name, sensitivity, args, status, result, error, agent, conversationId }`.
- The manifest is sent only when it changes (hash acknowledged per conversation).
- The wire format is in [docs/http-contract.md](https://github.com/nextlevelbuilder/dewee-webchat/blob/main/docs/http-contract.md#page-actions).

**Security.** Agent output is untrusted. Treat every action as an API the visitor could call with
arbitrary arguments: register only what the visitor may already do, keep the server as the authority
(auth, CSRF, permissions), constrain args with `enum`/`pattern`/`additionalProperties: false`, and use
an allowlist for navigation (never `location.href = args.url`). The widget never evaluates agent output
or inserts it as HTML, caps calls per answer and automatic turns per message, and never runs a
`mutate`/`destructive` handler without approval. Page context and results are labelled as data for the
agent, but prompt injection through page content is still possible — do not put secrets in either.

## Signed-in users

When your site knows who the visitor is, the agent can know it too, with private tools that act for
that user only. You pass one server-side callback. You do not mint tokens, store per-visitor
credentials or put anything secret in the page: the handler exchanges your user for a Dewee identity
session, and the gateway derives the user from it.

```ts
import { createDeweeHandler, optionsFromEnv } from "dewee-webchat/server";
import { deweeIdentitySdk } from "dewee-webchat/server/identity";

const handler = createDeweeHandler({
  ...optionsFromEnv(process.env),
  identity: {
    sdk: deweeIdentitySdk,
    // Your own login. Return null for a visitor who is not signed in.
    authenticate: async (req) => {
      const user = await getUserFromSessionCookie(req.headers.get("cookie"));
      return user ? { subject: user.id } : null; // your stable id, never an email address
    },
    rebindEachRequest: true, // recommended with a cookie login, see below
    appId: process.env.DEWEE_IDENTITY_APP_ID!,
    issuer: process.env.DEWEE_IDENTITY_ISSUER!,
    assertionSecret: process.env.DEWEE_IDENTITY_ASSERTION_SECRET!, // or privateKeyJwk for a jwks application
  },
});
```

Setup: create the application once with `dewee identity setup --name <site> --issuer <issuer>` (it
prints the application id and the assertion secret), and install the server SDK next to this package:
`npm install @dewee/identity`. It is an optional peer dependency used only by the
`dewee-webchat/server/identity` entry; `dewee-webchat/server` itself never imports it, so a site that
serves only anonymous visitors bundles fine (webpack, esbuild…) without it.
`@dewee/identity` is not on npm yet: until it is, build its tarball from the
[dewee repository](https://github.com/nextlevelbuilder/dewee/blob/dev/packages/dewee-identity/README.md)
(`pnpm --filter @dewee/identity pack`) and install that file.

| `identity` option | |
|---|---|
| `sdk` | Required. `deweeIdentitySdk` from `dewee-webchat/server/identity`. |
| `authenticate(req)` | Required. Resolves `{ subject }` for a signed-in user, `null` otherwise. Throwing means "could not check". |
| `appId`, `issuer` | Required. The Dewee application id and its issuer, exactly. |
| `assertionSecret` \| `privateKeyJwk` (+ `algorithm`) | Exactly one: `hmac` or `jwks` application. Server only. |
| `audience` | Optional check; must be `dewee:<appId>`. |
| `agent` | The agent sessions are bound to. Default: `defaultAgent`, else the first of `agents`. |
| `required` | Default `false`. When `true`, visitors who are not signed in get no session at all. |
| `rebindEachRequest` | Default `false`. Check the signed-in user again on every `/chat`, `/history` and `/link`. |
| `sessionTtlSeconds` | 60 to 43200. Default: the gateway default (3600). |
| `allowInsecureHttp` | Allow plain http to a gateway that is not loopback (private networks only). |

`AuthenticatedUser` has no scopes: the session exchange does not carry any. When a user's permissions
change, report it from your server with `lifecycle({ event: "scopes_changed", … })` from
`@dewee/identity`.

How it behaves:

- `POST /session` calls `authenticate`. For a user it returns a visitor token that carries a Dewee
  identity session, encrypted (AES-256-GCM, key derived from `secret`) so the browser only holds an
  opaque value. The gateway token, the assertion secret, the private key, the raw identity session and
  your subject never reach the browser.
- One identity session per user is kept in memory and reused until it nears expiry, so a page load
  does not cost an exchange; a session the gateway reports expired or revoked is dropped.
- `/chat` and `/history` connect to the gateway with that `identity_session` and no `user_id`, and only
  go on when the gateway confirms it derived a Dewee user (`tuc:…`); a gateway that ignored the session
  (identity switched off) gets `503 SOURCE_UNAVAILABLE` and nothing runs. The same user gets the same
  conversations on every device. The session's agent must still be in `agents` on every request.
- By default the visitor token is the credential: a token for user A keeps chatting as A even if a
  later request carries B's cookie, and an altered token is refused (401). With
  `rebindEachRequest: true`, `/chat`, `/history` and `/link` call `authenticate(req)` again and compare
  it with a keyed digest of the subject sealed in the token: another user or no user is
  `401 IDENTITY_REQUIRED` (the widget then asks `/session` again), and a throwing `authenticate` is
  `503 SOURCE_UNAVAILABLE`. Turn it on when your login is a cookie: a widget token replayed under
  another user's cookie is then useless.
- Fail closed. If `authenticate` returns `null`, the visitor chats anonymously, exactly as without
  `identity`, unless `required` is set, in which case no session is issued. If it throws, the answer
  is `503 SOURCE_UNAVAILABLE` and no session is issued. If the exchange for a signed-in user fails, no
  session is issued: a user is never silently downgraded. An exchange refusal meant for the operator
  (an application or agent set up wrong) is `500 identity_misconfigured`, with the reason in your logs.
- What the identity session allows, until it expires or is revoked: chatting with the bound agent and
  reading that chat's history as the user, starting web-first links, and listing and removing the
  user's own linked chat accounts (`/v1/identity/me/bindings`). That is why it never reaches the
  browser in the clear.
- `authenticate` sees the request the widget sends. A widget on another origin (`allowedOrigins`)
  sends no cookies of your site, so a cookie-based `authenticate` only works same-origin.
- `DEWEE_GATEWAY_TOKEN` must be a tenant API key without an owner: the gateway refuses an identity
  session next to a key bound to a user (`IDENTITY_CONFLICT`).
- `identity` cannot be combined with `allowClientCredentials` (the handler refuses to start). Sessions
  are bound to one agent, so `/config` turns the agent picker off.
- Gateway identity errors (`IDENTITY_REQUIRED`, `IDENTITY_LINK_REQUIRED`, `LINK_EXPIRED`, `LINK_REVOKED`,
  `PERMISSION_DENIED`, `SOURCE_UNAVAILABLE`, `IDENTITY_CONFLICT`) reach the widget as
  `{ error: { code, remediation } }`. The widget shows its own localized message and, on `LINK_EXPIRED`
  or `LINK_REVOKED`, asks `/session` again.
- The widget keeps a signed-in session in memory only, so each page load asks your backend who the
  visitor is. It refreshes the session `min(60 s, lifetime/2)` before it ends, counting the lifetime
  (`expiresIn`) from when it received it. Call `chat.renewSession()` after a sign-in or sign-out
  without a page load.
- Rate limits (default, in memory): 120 `authenticate` calls per IP per minute (checked before
  `authenticate` runs), 30 signed-in `/session` calls per user per 10 minutes, 5 link starts per user per
  10 minutes. A visitor who is not signed in and still has a valid anonymous token gets it back as is;
  only minting a new one counts against the 10 per IP per 10 minutes. A custom `rateLimit` receives the
  buckets `preauth`, `verified` and `link` besides `session` and `chat`.
- Keep `authenticate` cheap or cached (a signed-cookie check, not a database round trip per call): it
  runs on every `/session`, so on every page load, and with `rebindEachRequest` on every `/chat`,
  `/history` and `/link`, with only the generous per-IP cap in front of it.

**Linking a chat app.** A signed-in user can link their Telegram, Discord or other chat account
without typing any id: call `chat.startLink()`. The widget asks `POST {endpoint}/link`, which starts
a Dewee web-first link, and shows the proof code with "Continue on Telegram" for each chat account
the code can be sent to. The user sends the code in a direct message; Dewee checks both sides and
links on its own. `dewee:link` fires with `{ expiresAt, deepLinks }`. A link that is already in
progress answers `409 link_in_progress`, a reused idempotency key `409 idempotency_key_reused`, and a
gateway with linking switched off `503 linking_unavailable`; the widget shows its own text for each.

The PHP backend does not support signed-in users yet (it has no JWS signing); use the Node/Workers handler.

## Security model

- The gateway token never leaves your server. Browsers get an HMAC-signed visitor id.
- Each visitor gets its own gateway user (`webchat-<id>`) and session keys, so history is private to them.
  A [signed-in user](#signed-in-users) is the user the gateway derives from their Dewee identity session.
- Only allowlisted agents are reachable; origin allowlist, rate limits (20 messages/min per visitor, 10
  new sessions/10 min per IP by default — pass `rateLimit` for a shared store), 4000-char messages,
  optional Turnstile.
- The client IP for per-IP limits comes from `cf-connecting-ip`, `x-real-ip` or the first
  `x-forwarded-for` entry. These headers are only trustworthy behind a proxy that sets them (as
  before signed-in users existed); elsewhere a client can choose its own IP.
- "Bring your own gateway" (`allowClientCredentials`) is off by default; when on, internal hosts are refused.

The wire format is documented in [docs/http-contract.md](https://github.com/nextlevelbuilder/dewee-webchat/blob/main/docs/http-contract.md).

## License

MIT © NextLevelBuilder
