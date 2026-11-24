# dewee-webchat

Put your [Dewee](https://dewee.sh) agent on any website. A dependency-free chat widget that streams the
agent's answers (and, when you allow it, its **reasoning** and **tool calls**), plus a small backend
handler that keeps your integration secret off the browser.

**Playground:** [webchat.dewee.sh](https://webchat.dewee.sh) · **CDN:** [webchat-cdn.dewee.sh](https://webchat-cdn.dewee.sh) ·
**Source & examples:** [github.com/nextlevelbuilder/dewee-webchat](https://github.com/nextlevelbuilder/dewee-webchat)

```
browser <dewee-chat>  ──HTTPS + SSE──▶  your backend /api/dewee/*  ──HTTPS + SSE──▶  Dewee CCP (Website chat)
   (visitor token only)                   (holds the integration secret)            (agents, sign-in, limits)
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

Create a **Website chat** integration in CCP (the Dewee control plane): choose its agents, allowed
sites, sign-in mode, limits and whether reasoning and tool activity are shown. Its page prints the
first three values below.

| Variable | |
|---|---|
| `DEWEE_CCP_CHAT_URL` | The ingress URL, `https://<ccp>/api/public/webchat/v1/wci_…`. https only (plain http to `localhost` for development). |
| `DEWEE_WEBCHAT_INTEGRATION_ID` | `wci_…`; must match the end of `DEWEE_CCP_CHAT_URL` |
| `DEWEE_WEBCHAT_INTEGRATION_SECRET` | `dwc_…`. **Server only.** Sent only to the `DEWEE_CCP_CHAT_URL` origin, never across a redirect. |
| `DEWEE_WEBCHAT_SECRET` | At least 32 random UTF-8 bytes to sign visitor sessions (`openssl rand -base64 32`) |
| `DEWEE_ALLOWED_ORIGINS` | Extra origins for cross-origin embedding (same origin always works) |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Optional Cloudflare Turnstile check for new visitors (with `ccp`, a returning visitor's hourly refresh is not challenged) |
| `DEWEE_WEBCHAT_TRANSPORT` | Optional: `ccp` or `legacy-gateway`. Without it, the variables that are set decide (gateway variables alone select `legacy-gateway`, with a deprecation warning); set it to pin the transport explicitly. |
| `DEWEE_WEBCHAT_HUMAN_HANDOFF` | Optional, `ccp` only: `true` lets visitors ask for a person (see [Talking to a person](#talking-to-a-person)). Any other value leaves it off. |
| `DEWEE_WEBCHAT_WORK_REQUESTS` | Optional, `ccp` only: `true` lets visitors send business requests such as a callback (see [Business requests / callback](#business-requests--callback)). Any other value leaves it off. |

The same values as options: `createDeweeHandler({ transport: "ccp", ccp: { chatUrl, integrationId, integrationSecret }, secret })`.
With `ccp`, the agents come from the integration: `/config` lists them, the widget's `agent` is
forwarded and CCP decides whether it is allowed. Errors from CCP reach the browser as the usual
`{ error: { code, message } }` with this package's own messages; CCP's text, URLs and secrets never do.

#### Legacy: direct Gateway (deprecated)

`transport: "legacy-gateway"` connects straight to a Dewee Gateway with a URL and token. It still
works and logs a deprecation warning once; see
[docs/migrating-to-ccp-transport.md](https://github.com/nextlevelbuilder/dewee-webchat/blob/main/docs/migrating-to-ccp-transport.md).

| Variable | |
|---|---|
| `DEWEE_GATEWAY_URL` | Gateway runtime origin, e.g. `https://gateway.example.com` |
| `DEWEE_GATEWAY_TOKEN` | Operator API key (`operator.read,operator.write`) or gateway token. **Server only.** |
| `DEWEE_TENANT_ID` | Optional tenant UUID |
| `DEWEE_AGENTS` | Allowlist, comma separated (`support,sales`) or `*` |
| `DEWEE_DEFAULT_AGENT` | Optional; defaults to the first allowed agent |
| `DEWEE_ALLOW_CLIENT_CREDENTIALS`, `DEWEE_CLIENT_CREDENTIAL_HOSTS` | "Bring your own gateway" (playgrounds only) |

The two sets cannot be mixed: with CCP and gateway variables both set, or `transport` naming one and
the other's variables set, the handler refuses to start rather than send a credential to an origin
you did not pick. `agents`, `defaultAgent` and `allowClientCredentials` are refused with `ccp`.

Both transports need a stable `secret` shared by every backend instance. For local development only,
the legacy transport can opt in to a generated process-local secret with `allowEphemeralSecret: true`.
Sessions and identity bindings then stop working after a restart or when a request reaches another
instance. CCP always requires a configured secret of at least 32 bytes.

## 2. Add the widget

### Optional current-page context

Page context is off by default. Set `page-context="metadata"` or `page-context="content"` on the
widget (or `pageContext` in framework configuration) to offer it. The visitor previews the page
and explicitly chooses whether to share it for each message. Only a supported Gateway/CCP version
receives the attachment; ordinary chat continues when support is absent. For content, the default
source is `main`, `article` or `[role=main]`; `contextSelector` and `excludeSelectors` narrow it.
Form controls, editable areas and hidden content are excluded. Configure a client-side
`contextProvider` for host-filtered data when needed; the host is responsible for excluding private
data from its provider. In Astro, set that function with `element.configure()` in a client script,
not as a serialized component prop. The preview contains the data to be sent: review it before
sharing. See the [HTTP contract](https://github.com/nextlevelbuilder/dewee-webchat/blob/main/docs/http-contract.md#page-context-attachment).

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
| `imageOrigins` | `[]` | Additional trusted HTTPS origins for Markdown images |
| `mode` | `floating` | `floating` (bubble + panel) or `inline` (fills its container) |
| `position` | `bottom-right` | or `bottom-left` |
| `theme` | `light` | `light`, `dark`, `auto` |
| `accentColor` | `#5446e8` | Any CSS color |
| `locale` | page language | `en`, `vi` |
| `showReasoning` | `true` | Stream the model's thinking (with `ccp`, only when the integration shows it) |
| `showToolCalls` | `true` | Show tool calls with arguments and results (with `ccp`: names only, when the integration shows them) |
| `allowAgentSwitch` | `true` | Agent picker when the backend allows several |
| `persist` | `true` | Keep the conversation across page loads |
| `open`, `hideBranding`, `width`, `height`, `zIndex` | | |
| `actions`, `confirm`, `getPageContext` | | [Page actions](#agent-page-actions) (JS/props only) |
| `maxActionRounds` | `5` | Automatic action turns per visitor message |
| `actionTimeoutMs` | `30000` | Per-handler timeout |
| `domActions` | `false` | [Built-in DOM actions](#built-in-dom-actions): snapshot, scroll, click, fill |
| `domActionsRoot` | `document.body` | Selector or element the built-in DOM actions are limited to |
| `headers` | | Extra request headers, object or `() => object \| Promise<object>` called before every request (JS/props only) |
| `fetch` | `globalThis.fetch` | Custom fetch for every widget request (JS/props only) |

Methods: `open()`, `close()`, `toggle()`, `send(text)`, `stop()`, `newConversation()`, `configure(partial)`,
`registerActions(actions)`, `unregisterAction(name)`, and for [signed-in users](#signed-in-users)
`renewSession()` and `startLink()`. For [install checks](#lifecycle-and-diagnostics): `diagnostics()`,
`checkConnection()`, `retry()`.
Events: `dewee:ready`, `dewee:status`, `dewee:open`, `dewee:close`, `dewee:send`, `dewee:reply`, `dewee:error`, `dewee:action`, `dewee:link`.
CSS variables: `--dw-accent`, `--dw-font`, `--dw-radius`, `--dw-width`, `--dw-height`, `--dw-z`.

### Lifecycle and diagnostics

A widget on the page is not yet a channel that answers. The widget tracks three steps separately:

| Step | `ok` means | Typical failure codes |
|---|---|---|
| `config` | The backend's `/config` answered: the embed points at a working backend | `ORIGIN_NOT_ALLOWED`, `http_404`, `http_503`, `network_error` |
| `session` | A visitor session was opened | `LOGIN_REQUIRED`, `turnstile_failed`, `http_401` |
| `reply` | The agent answered the last message | `AGENT_UNAVAILABLE`, `upstream_unavailable`, `empty_reply`, `reply_failed` |

Each step is `idle` (not checked yet), `pending`, `ok` or `failed` (with a `code`).

- `reply` describes the visitor's own last message. A rate limit or a policy refusal (`RATE_LIMITED`,
  `POLICY_DENIED`, `CHALLENGE_REQUIRED`) stopped the message before the agent, so it leaves `reply` as
  it was; automatic page-action follow-ups do not change it either.
- A `code` is a short word list such as `ORIGIN_NOT_ALLOWED`. Anything longer than 40 characters, or
  not made of underscore-separated words of at most 16 characters, is replaced by `http_<status>`, so a
  backend that puts something else in `code` cannot leak it through a snapshot.
- Changing `endpoint`, `gatewayUrl` or `gatewayToken` starts over: the steps go back to `idle`, and
  `dewee:ready` fires for the new backend only. `renewSession()` resets `session` and `reply`.
- While the config is unavailable `send()` sends nothing, keeps the visitor's text and shows a notice.

```ts
chat.addEventListener("dewee:status", (e) => console.log(e.detail));
// { embedded: true, config: { state: "ok" }, session: { state: "idle" }, reply: { state: "idle" }, version: "0.5.0" }

chat.diagnostics();            // the same snapshot, any time
await chat.checkConnection();  // loads the config and opens a session, without sending a message
await chat.send("ping");       // then `reply` shows whether the agent answered
```

- `dewee:ready` fires once per load attempt, **including a failed one**, so embeds that wait for it
  never hang. Its detail is `{ ok, agent, config, error? }`: check `ok` before treating the chat as
  usable (`config` is `null` and `error.code` is set when it is `false`).
- `dewee:status` fires whenever a step changes. The snapshot holds states and short codes only: no
  token, key, URL, server message or conversation text, so it is safe to log or to send to a checker.
- When the config cannot be loaded, the header says the chat is unavailable instead of "Online", the
  panel shows a **Try again** button (`retry()`), and nothing is sent until the config loads. The host
  element carries `data-connection="connecting" | "ready" | "unavailable"` for your own styling.
- React: `onStatus`. Vue: `@status`.

### Install check

The control plane's **Check on my website** opens your page with `?dewee_check=<nonce>`. The widget
reads the nonce once, removes the parameter from the address bar (path, other parameters and hash
stay), boots even when closed, and sends the nonce with its `/session` request. Only when the backend
confirms it (`check: true`, which CCP decides for your integration and origin) does it send one fixed
test message ("Install check: please reply to confirm this chat works.", localized), in a conversation
of its own that is never stored, so the check sees a real reply while your visitor's conversation stays
untouched. The panel opens without taking the focus.

- Nothing is sent without that confirmation, and no Turnstile challenge is rendered for the check.
- At most once per page load and once per tab for a nonce (a hash, never the nonce, is kept in
  `sessionStorage`): not after a reload, `renewSession()` or for a second widget.
- A refused check session is reported as `failed`, and the widget opens a normal session so chat works.
- `diagnostics()` adds `check: "accepted" | "ignored" | "failed"`; `dewee:send` (and the backend's
  `onChat`) mark the test turn with `check: true`. The nonce never appears in a snapshot, an event,
  storage, page context or a page-action result.
- A malformed value is ignored, as is any nonce for a widget configured with `gatewayUrl` and
  `gatewayToken`. Visitors without the parameter see no change; the eager boot is the cost of a page
  load that carries it.
- A site that requires sign-in records the check under the signed-in visitor; for a visitor who is not
  signed in, the identity refusal is the reason the control plane shows.

Needs widget **and** backend **0.5.0-beta.7** or later (the TypeScript handler and the PHP backend
alike). The nonce is not a secret and grants nothing; the backend forwards it to CCP only over transport
`ccp`. See the [HTTP contract](../../docs/http-contract.md#install-check).

## Markdown images

Replies may include `![Product](https://cdn.example.com/photo.jpg)` or a same-origin relative image
URL. Images are disabled until HTTPS directory prefixes are approved in the backend. Configure the backend
with `imageSources: ["https://cdn.example.com/products/", "https://qr.example.com/images/"]` (or the comma-separated
`DEWEE_IMAGE_SOURCES` environment variable). Include a safe image directory on your site's HTTPS origin for relative images.
For external origins, also configure the widget:

```html
<dewee-chat image-origins='["https://cdn.example.com", "https://qr.example.com"]'></dewee-chat>
```

The script-tag equivalent is `data-image-origins`; vanilla JS uses
`chat.configure({ imageOrigins: ["https://cdn.example.com"] })`, and React, Vue and Astro accept the
`imageOrigins` prop. Unapproved or broken images fall back to alt text. The widget loads images from
`{endpoint}/image` using a short-lived encrypted ticket issued to the visitor session; the backend makes the request without cookies or Gateway credentials, rejects
redirects, and accepts PNG, JPEG, GIF and WebP only after validating the content type and file
signature. Node and PHP pin a checked public DNS address; Cloudflare Workers use the platform's
network boundary. Workers conservatively refuse sources sharing the endpoint's last two hostname
labels (including sibling subdomains), to avoid bypassing Cloudflare's own-zone protections. For
same-origin static files in the Worker's own Assets binding, a host can explicitly opt in:

```ts
createDeweeHandler({
  // ... other handler options
  imageSources: ["https://chat.example.com/public-chat-images/"],
  cloudflarePublicImageAssets: { binding: env.ASSETS, prefixes: ["/public-chat-images/"] },
});
```

Only exact same-origin paths in both lists use the binding. This reads the Assets collection directly,
**bypassing Worker middleware, Cloudflare Access, and cookie-based authorization**. Every file under
the configured prefixes must be public to any valid chat visitor; keep private files elsewhere,
inspect the build output, and exclude sensitive files using `.assetsignore`. The URL query is not
passed to the binding.

For a sibling hostname in the same zone, a host can instead configure a service binding to a Worker
that serves public images from the listed directories:

```ts
createDeweeHandler({
  // ... other handler options
  imageSources: ["https://images.example.com/products/"],
  cloudflarePublicImageServices: [
    { id: "catalog-v1", binding: env.PUBLIC_IMAGES, prefixes: ["https://images.example.com/products/"] },
  ],
});
```

Both lists must allow the source. Each service needs a unique ID and non-overlapping prefixes; change
the ID whenever you repoint the binding so existing short-lived tickets cannot reach the new service.
The service ID is visible in the image ticket, but the source URL remains encrypted. The binding
calls the configured Worker directly, bypassing the
source hostname's Cloudflare security rules. Every configured prefix must be public to all chat
visitors; do not bind private services or paths. The Worker receives a GET with the approved path on
`https://public-images.invalid`, without the original query, cookies or authorization headers. It
must serve that path without relying on its hostname or a signed query string. A missing or invalid
response fails closed and never falls back to a network request.

Files are limited to 2 MiB and 4096
pixels per edge, and responses are not cached. Animated GIF/PNG/WebP are refused. Raw HTML,
SVG, unsafe schemes, credentials in URLs and unapproved origins are rejected.

The proxy URL contains an encrypted, short-lived ticket, not the source URL or the visitor session.
Avoid secrets in image URLs: the ticket request contains the source URL in its body.

## Custom headers and fetch

Behind a same-origin BFF that wants a CSRF header, cookies or tracing:

```tsx
<DeweeChat
  endpoint="/dashboard/api/v1/dewee"
  headers={() => ({ "x-csrf-token": readCsrfToken() })} // evaluated before every request
  fetch={(input, init) => fetch(input, { ...init, credentials: "include" })}
/>
```

Vanilla: `chat.configure({ headers, fetch })` or the `chat.headers` / `chat.fetch` properties. `headers` applies to
every request to `endpoint` (config, session, history, link, chat). It cannot override `content-type`,
`authorization` (which carries the anonymous or signed-in session token), `x-dewee-gateway-url` or
`x-dewee-gateway-token` (case-insensitive; such keys are dropped). Header names are sent lower-cased. For a
cross-origin `endpoint`, configure the backend's `allowedOrigins` and `allowedHeaders: ["x-csrf-token"]`.
The built-in TS and PHP handlers accept header names containing letters, digits and hyphens. A custom `fetch` receives every request as sent, including the session bearer token of a
signed-in user, so only the trusted host page should supply it.

Anonymous visitor sessions are reused until less than 10% of the token lifetime remains (at most 24 h, at least
30 s, and no more than half the lifetime), so backends with short session TTLs do not mint a new session on every request. With `transport: "ccp"`,
`/session` reports the end of the CCP edge session sealed in the token as `expiresAt` (and `expiresIn`), so the
widget asks `/session` again before it lapses, about once an hour, although the token itself lives 30 days. That
refresh keeps the visitor id and re-seals a refreshed edge session, so a host that keeps no memory between
requests (serverless, PHP) never refreshes or opens one while answering a chat. Signed-in sessions are used from
memory and refreshed `min(60 s, lifetime / 2)` before they expire (see [signed-in users](#signed-in-users) for the
tab's reuse hint).

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
- Each call shows a status chip (pending, awaiting confirmation, running, done, denied, error, not
  confirmed). Stop cancels running handlers (`ctx.signal`).
- **A handler that resolves has succeeded**, whatever it returns. To report a business failure, throw
  an `ActionError` with a machine-readable code; the agent gets `status: "error"` and the code:

  ```ts
  import { ActionError } from "dewee-webchat";

  handler: async ({ id }, { signal }) => {
    const res = await fetch(`/api/orders/${id}`, { signal });
    if (res.status === 404) throw new ActionError("not_found", "Order not found"); // not: return { error: "not_found" }
    if (!res.ok) throw new ActionError(`http_${res.status}`);
    return res.json();
  }
  ```

- **A write whose result you cannot confirm is `unknown`, not a failure.** When the answer to a POST is
  lost, ask your server whether it happened before reporting anything; only if that fails too, throw
  `new ActionError("payment_outcome_unknown", "…", { outcome: "unknown" })`. The agent is told the
  outcome is unconfirmed and that it must not run the action again. A `mutate`/`destructive` handler
  that times out or is stopped while running is reported as `unknown` for the same reason; after a
  Stop that leaves such a result, the widget still sends the results to the agent once (and runs no
  further actions), so the conversation and a later reload both show it as unconfirmed. See
  [`examples/astro-node`](https://github.com/nextlevelbuilder/dewee-webchat/blob/main/examples/astro-node/src/lib/page-actions.ts).
- `getPageContext()` returns a small snapshot (≤ 4 KB as JSON) sent with every message. Redact it yourself.
- `dewee:action` fires with `{ phase: "start" | "result", id, name, sensitivity, args, status, result, error, code, agent, conversationId }`;
  `status` is `ok`, `denied`, `error` or `unknown`.
- The manifest is sent only when it changes (hash acknowledged per conversation).
- The wire format is in [docs/http-contract.md](https://github.com/nextlevelbuilder/dewee-webchat/blob/main/docs/http-contract.md#page-actions).

**Security.** Agent output is untrusted. Treat every action as an API the visitor could call with
arbitrary arguments: register only what the visitor may already do, keep the server as the authority
(auth, CSRF, permissions), constrain args with `enum`/`pattern`/`additionalProperties: false`, and use
an allowlist for navigation (never `location.href = args.url`). The widget never evaluates agent output
or inserts it as HTML, caps calls per answer and automatic turns per message, and never runs a
`mutate`/`destructive` handler without approval. Page context and results are labelled as data for the
agent, but prompt injection through page content is still possible — do not put secrets in either.

### Built-in DOM actions

Without writing handlers, a page can let the agent scroll, click and type on it. They are off by
default:

```html
<script src="https://webchat-cdn.dewee.sh/v/latest/dewee-webchat.js"
  data-endpoint="/api/dewee" data-dom-actions="true" data-dom-actions-root="#app" defer></script>
```

```tsx
<DeweeChat endpoint="/api/dewee" domActions domActionsRoot="#app" />
```

| Action | Sensitivity | What it does |
|---|---|---|
| `page.snapshot` | `read` | Lists visible links, buttons and form fields as `e3 textbox "Email" value="…"`, with a `generation` |
| `page.scroll` | `read` | Scrolls one screen up/down, to the top/bottom, or an element (`ref`) into view |
| `page.click` | `mutate` | Clicks an element by `ref` + `generation` |
| `page.fill` | `mutate` | Sets the value of a text field, textarea, select or editable area, then fires `input` and `change` |

- `page.click` and `page.fill` always ask the visitor first; the dialog (or your `confirm` hook, as
  `args.target`) names the element, e.g. `button "Delete run"`.
- Refs come only from the latest snapshot. A ref from an older snapshot, or an element that is gone,
  hidden or now sensitive, is refused, and the agent is told to take a new snapshot.
- Never listed or touched: password, payment card and one-time-code fields (by `type`, `autocomplete`
  and name), hidden elements, the widget itself, and anything inside `[data-dewee-ignore]`. Put
  `data-dewee-ignore` on whatever else the agent must not reach.
- `page.fill` uses the native value setter, so React and Vue controlled inputs see the change. Events are
  synthetic (`isTrusted` is false): pages that require trusted events, file pickers and popups opened by a
  click will not react.
- Your own actions keep working; registering an action with a built-in name (say `page.click`)
  replaces the built-in one.
- The built-ins operate the DOM, not your app's permissions: the agent can do whatever the visitor's
  clicks can, after approval. Narrow it with `domActionsRoot` and `data-dewee-ignore`, and keep the server
  as the authority.

## Talking to a person

Off by default. With `transport: "ccp"`, `createDeweeHandler({ …, humanHandoff: true })` (or
`DEWEE_WEBCHAT_HUMAN_HANDOFF=true`) tells CCP this host can show a human takeover. When the
integration allows it too, the widget shows **Talk to a person** / **Gặp nhân viên hỗ trợ** under
the conversation. The widget then follows what the server says:

- **Waiting for staff**: the request was recorded; messages the visitor sends are kept for the staff
  (no agent reply, no error) and the widget checks history for the staff's answer.
- **Staff joined**: the staff member's messages are labelled "Support staff" / "Nhân viên hỗ trợ";
  their name, id and email are never sent to the browser.
- **Nobody on duty**: the agent keeps answering and the widget says so.
- When staff hand the conversation back, the agent answers again and the widget stops checking.

| Host | Supports |
|---|---|
| TypeScript handler, `ccp` | Yes, with `humanHandoff: true` |
| PHP backend, `ccp` | Yes, with `$options['humanHandoff'] = true` or `DEWEE_WEBCHAT_HUMAN_HANDOFF=true` |
| Either backend, `legacy-gateway` | No: the option is refused at startup |
| Older versions of either backend | No: no button, no feature header, no polling |

Turn the option on only with widget **0.5.0-beta.7** or later on every page that embeds it (a pinned
older widget does not understand the `202` answer to a held message). The `/config` flag reflects the
integration's default agent.

Routes and payloads: [HTTP contract](../../docs/http-contract.md#talking-to-a-person-human-takeover).

## Business requests / callback

This feature is off by default. It needs widget and backend **0.5.0-beta.7** or later, transport
`ccp`, and a control plane with work requests enabled for the integration.

**Turning it on.** Use `createDeweeHandler({ …, workRequests: true })`, or set
`DEWEE_WEBCHAT_WORK_REQUESTS=true`. When the integration offers a `callback` kind, the widget then
shows **Request a callback** / **Nhờ gọi lại** in the composer.

**The form.** The visitor chooses phone, Zalo or email, enters the contact and what it is about, and
ticks a consent that names the request. Skipping the form leaves the chat as it was: the form is
never required.

**What the visitor sees:**

- **Sending**: the request is on its way.
- **Unconfirmed**: the outcome is unknown. The widget checks by the request's key, then offers
  **Check again** and **Send again**. Both reuse the same key, so the request is never stored twice.
- **Failed**: the request was refused. The key is kept until the visitor changes the form.
- **Recorded**: the widget shows the server's receipt: the code, the state (a dot and a word), when
  the business will reply (in the visitor's local time), the public note, and a contact hint such as
  `***678`.

**Receipts.** Each request is its own receipt. They are read again on load, when the widget is
opened or focused, and after a send. They are separate from the conversation and from **Talk to a
person**, so a takeover ending or staff going off duty never changes them. `generic` kinds appear as
receipts too.

**Privacy.** The contact value is never logged, stored in the browser, or put in an event. The
`dewee:work-request` event carries `{code, state}` only. The idempotency key lives in
`sessionStorage`, without contact data.

| Host | Supports |
|---|---|
| TypeScript handler, `ccp` | Yes, with `workRequests: true` |
| PHP backend, `ccp` | Yes, with `$options['workRequests'] = true` or `DEWEE_WEBCHAT_WORK_REQUESTS=true` |
| Either backend, `legacy-gateway` | No: the option is refused at startup |
| Older versions of either backend | No: no entry, no feature header, no request |

Routes and payloads: [HTTP contract](../../docs/http-contract.md#business-requests--callback).

## Signed-in users

When your site knows who the visitor is, the agent can know it too, with private tools that act for
that user only. You pass one server-side callback. You do not mint tokens, store per-visitor
credentials or put anything secret in the page: the handler exchanges your user for a Dewee identity
session, and Dewee derives the user from it.

With `transport: "ccp"` the same `identity` option works through CCP: the handler signs the partner
assertion with `@dewee/identity` and CCP exchanges it for the identity session (`identity/exchange`),
so the website needs no gateway key. `identity.agent` is optional there (the integration default is
used), `allowInsecureHttp` does not apply, a user switch under `rebindEachRequest` revokes the
previous user's session at CCP, and logout revokes it through [`handler.revoke`](#signed-in-users).
The integration's sign-in mode must allow signed-in users.

### Hosted credential requests

Credential requests are off by default and require CCP transport, signed-in identity, and Gateway/CCP
support enabled for the agent. To opt in, add `credentialRequests: { formOrigin: "https://app.example.com" }`
to the server handler options, using the exact HTTPS origin of your Dewee-hosted form. Use the ASCII
punycode form for an internationalized domain. The form is
opened only after the visitor chooses it; a workspace approval administrator must authenticate there.
The widget never collects the credential value. Anonymous sessions, direct Gateway transport, and
an untrusted form origin cannot use this flow. See the [HTTP contract](../../docs/http-contract.md#hosted-credential-requests).

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
| `agent` | The agent sessions are bound to. Default: `defaultAgent`, else the first of `agents` (with `ccp`: the integration default). |
| `required` | Default `false`. When `true`, visitors who are not signed in get no session at all. |
| `rebindEachRequest` | Default `false`. Check the signed-in user again on every `/chat`, `/history` and `/link`. |
| `sessionTtlSeconds` | 60 to 43200. Default: the gateway default (3600). |
| `allowInsecureHttp` | Legacy gateway only: allow plain http to a gateway that is not loopback (private networks only). |

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
- With CCP, a host that keeps no memory between requests reuses it too. `/session` also returns a
  `reuseHint`: the same sealed session in a token that is no bearer (`/chat`, `/history` and `/link`
  refuse it). The widget keeps only that hint in the tab's `sessionStorage`, never the bearer token,
  and sends it back as `reuseHint`. The handler reuses its identity and edge sessions only when it was
  issued by this backend for the user `authenticate` returns now and the same agent, with more than 2
  minutes left. It is never extended past its own expiry; anything else is exchanged anew, and it
  never makes a signed-out visitor signed in. The legacy gateway and PHP send no hint, and the widget
  then stores nothing.
- The hint lives in one tab, so on a host that keeps no memory between requests each new tab of a
  signed-in user costs one identity exchange, and CCP allows 10 exchanges per visitor per 10 minutes.
  Sites where users open many tabs should run the handler where its in-memory session cache survives
  between requests (a long-lived process or reused instance), which serves every tab of the user.
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
  another user's cookie is then useless. With CCP, another user also revokes the previous user's
  session at CCP. That is the old user's one shared session, so it ends on their other devices too;
  their widget gets a `401` there and exchanges a new one at `/session`. A request with no user
  (signed out, or sent without the cookie) is only refused, because the session may still be in use
  on the user's other devices.
- Logout: call `revoke(subject, request, hint?)` on the handler from your logout route. It forgets
  the identity sessions the handler holds for that user and, with CCP, revokes them at CCP
  (`identity/revoke`), so the user's tokens stop working on every device. On a host without shared
  memory, have the logout page send the widget's hint (`chat.reuseHint()`) along: the session in it
  is revoked when it belongs to that subject. Pass the logout request so CCP sees the visitor's
  origin (an integration with an origin allowlist needs it; without a request, the origin the
  session was issued for is used). Without a shared store, sessions held only by other instances end when they expire. The
  legacy gateway has no revoke call, so there it only forgets them.

  ```ts
  // `handler` from the example above; the logout page posts { hint: chat.reuseHint() }
  export async function logout(req: Request) {
    const user = await getUserFromSessionCookie(req.headers.get("cookie"));
    const { hint } = await req.clone().json().catch(() => ({}));
    if (user) await handler.revoke(user.id, req, typeof hint === "string" ? hint : undefined); // the subject authenticate returns
    // …then clear your own session cookie
  }
  ```
- For multiple handler instances, supply `identity.sessionStore` implementing the exported
  `IdentitySessionStore` interface. Share the same protected store and visitor secret across those
  instances. The default is a bounded, per-handler in-memory store. Store records contain bearer
  credentials: encrypt them at rest, restrict access and never log values. The interface requires
  atomic revision checks and updates across instances, unique non-reused revisions even after
  eviction, conditional token deletion, and expiry by `deadline`; a simple non-atomic KV get/set is
  insufficient. Keys use scoped HMAC digests, not raw host user IDs. Store failures refuse session
  issuance; logout remains best effort, logs store failure and still attempts the supplied hint.
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
- Legacy gateway only: `DEWEE_GATEWAY_TOKEN` must be a tenant API key without an owner: the gateway refuses an identity
  session next to a key bound to a user (`IDENTITY_CONFLICT`).
- `identity` cannot be combined with `allowClientCredentials` (the handler refuses to start). Sessions
  are bound to one agent, so `/config` turns the agent picker off.
- Gateway identity errors (`IDENTITY_REQUIRED`, `IDENTITY_LINK_REQUIRED`, `LINK_EXPIRED`, `LINK_REVOKED`,
  `PERMISSION_DENIED`, `SOURCE_UNAVAILABLE`, `IDENTITY_CONFLICT`) reach the widget as
  `{ error: { code, remediation } }`. The widget shows its own localized message and, on `LINK_EXPIRED`
  or `LINK_REVOKED`, asks `/session` again.
- The widget uses a signed-in session from memory, so each page load asks your backend who the
  visitor is. When `/session` returns a `reuseHint` (CCP only), it keeps that hint, and nothing
  else, in `sessionStorage` (never `localStorage`), and drops it when `/session` answers anonymously
  or `401`, or a signed-in request is refused. It refreshes the session `min(60 s, lifetime/2)` before it ends, counting the lifetime
  (`expiresIn`) from when it received it. Call `chat.renewSession()` after a sign-in or sign-out
  without a page load.
- Rate limits (default, in memory): 120 `authenticate` calls per IP per minute (checked before
  `authenticate` runs), 30 signed-in `/session` calls per user per 10 minutes, 5 link starts per user per
  10 minutes. A visitor who is not signed in and still has a valid anonymous token gets it back as is;
  only minting a new one counts against the 10 per IP per 10 minutes. With CCP, refreshing a
  returning visitor's token counts per visitor instead, so visitors behind one address do not use up
  the budget of new ones. CCP's own per-IP budget still applies to edge session creates: a visitor
  back after more than a day (past CCP's refresh window) gets a new edge session, which counts there. A custom `rateLimit` receives the
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

The PHP backend also supports signed-in users and a server-side logout hook; see the
[PHP identity setup](../../php/README.md#signed-in-users). Its stateless reuse uses the CCP reuse hint.

## Security model

- The integration secret (or, legacy, the gateway token) never leaves your server. Browsers get an
  HMAC-signed visitor id; the CCP edge session travels inside it encrypted (AES-256-GCM).
- The integration secret is sent only to the `DEWEE_CCP_CHAT_URL` origin: redirects are refused, not
  followed, and the URL must be https (plain http only to `localhost`).
- Each visitor gets its own visitor identity at Dewee (legacy: its own gateway user `webchat-<id>` and
  session keys), so history is private to them. A [signed-in user](#signed-in-users) is the user Dewee
  derives from their identity session.
- With `ccp`, reasoning and tool activity are hidden unless the integration shows them, and tool
  arguments and results never reach the browser.
- Only allowed agents are reachable (the integration's, legacy: `agents`); origin allowlist, rate limits (20 messages/min per visitor, 10
  new sessions/10 min per IP by default — pass `rateLimit` for a shared store), 4000-char messages,
  optional Turnstile.
- The default rate limiter is in memory and applies per handler instance, not across replicas or
  serverless invocations. For a shared backend limit, provide an atomic shared-store `rateLimit`
  implementation; do not rely on the default as a cluster-wide limit.
- The Dewee gateway enforces the shared admission limits on every message. A refusal reaches the widget
  as a typed SSE error (`POLICY_DENIED`, or `RATE_LIMITED` with `retryAfterMs`) with a fixed message, never
  the gateway's own text. The widget shows a localized error and disables sending until `retryAfterMs`
  has passed, announced to screen readers. With `ccp`, CCP's refusals of a message reach the widget the
  same way. The backend's in-memory limiter is defense in depth; the
  gateway owns the shared limit. See [admission errors](../../docs/http-contract.md#admission-errors).
- The client IP for per-IP limits comes from `cf-connecting-ip`, `x-real-ip` or the first
  `x-forwarded-for` entry. These headers are only trustworthy behind a proxy that overwrites them
  (as before signed-in users existed); elsewhere a client can choose its own IP, both for this
  backend's limits and for the address CCP is told (`X-Dewee-Visitor-IP`, sent only when it is a
  well-formed IP address).
- "Bring your own gateway" (`allowClientCredentials`) is off by default; when on, internal hosts are refused.

The wire format is documented in [docs/http-contract.md](https://github.com/nextlevelbuilder/dewee-webchat/blob/main/docs/http-contract.md).

## License

MIT © NextLevelBuilder
