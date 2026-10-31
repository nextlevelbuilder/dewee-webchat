# dewee-webchat — PHP backend

`dewee-webchat.php` is a single-file backend for the chat widget (PHP >= 8.1, `ext-openssl`, no
Composer). It implements the [HTTP contract](../docs/http-contract.md) and behaves like the Node
handler in `dewee-webchat/server` for anonymous visitors. The integration secret stays on your server.

**No signed-in users.** The PHP backend has no identity mode (it cannot sign partner assertions):
every visitor is anonymous, with either transport. A visitor token that carries an identity session
(issued by a Node backend with the same secret) is refused, never downgraded. For signed-in users,
use the Node/Workers handler.

## Install

Copy `dewee-webchat.php` into your project and create an endpoint, for example `api/dewee.php`:

```php
<?php
require __DIR__ . '/../lib/dewee-webchat.php';
DeweeWebchat::loadEnvFile(__DIR__ . '/../.env'); // optional; real env vars win
DeweeWebchat::handle();                          // or DeweeWebchat::handle([...options])
```

Point the widget at it: `<script src="https://webchat-cdn.dewee.sh/dewee-webchat@latest/dewee-webchat.js" data-endpoint="/api/dewee.php" defer></script>`.
Routes use the last path segment, so `/api/dewee.php/chat` (PATH_INFO) and a rewrite such as
`/api/dewee/chat → api/dewee.php` both work.

## Configuration

Same variables as `optionsFromEnv()` in the Node package. Create a **Website chat** integration in
CCP and copy its values (agents, allowed sites and limits are set there):

| Variable | Meaning |
|---|---|
| `DEWEE_CCP_CHAT_URL` | Ingress URL, `https://<ccp>/api/public/webchat/v1/wci_…` (https; plain http to `localhost` only) |
| `DEWEE_WEBCHAT_INTEGRATION_ID` | `wci_…`, must match the end of the URL |
| `DEWEE_WEBCHAT_INTEGRATION_SECRET` | `dwc_…`. Server only; sent to that origin only, redirects are refused |
| `DEWEE_WEBCHAT_SECRET` | HMAC secret for visitor tokens (at least 32 random bytes; required with either transport) |
| `DEWEE_WEBCHAT_TRANSPORT` | Optional `ccp` or `legacy-gateway`; otherwise the variables set decide |
| `DEWEE_ALLOWED_ORIGINS` (csv or `*`) | Optional |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Require Cloudflare Turnstile for new sessions |

Deprecated `legacy-gateway` transport (direct Gateway URL and token, see
[docs/migrating-to-ccp-transport.md](../docs/migrating-to-ccp-transport.md)):

| Variable | Meaning |
|---|---|
| `DEWEE_GATEWAY_URL` / `GOCLAW_GATEWAY_URL` | Gateway origin, e.g. `https://gateway.example.com` |
| `DEWEE_GATEWAY_TOKEN` / `GOCLAW_GATEWAY_TOKEN` | Gateway token or scoped operator API key |
| `DEWEE_AGENTS` | Comma-separated allowlist (first = default), or `*` |
| `DEWEE_DEFAULT_AGENT`, `DEWEE_TENANT_ID` | Optional |
| `DEWEE_ALLOW_CLIENT_CREDENTIALS=true`, `DEWEE_CLIENT_CREDENTIAL_HOSTS` | Bring-your-own gateway (playgrounds only) |

CCP and gateway variables together are refused: the endpoint answers `500 not_configured` and logs
why (`error_log`), so a credential is never sent to an origin you did not choose. When private temp
storage is available, the legacy transport's deprecation warning is logged at most once a day. Its
throttle marker is stored in the private temp directory described below, never in a shared global temp file.

With CCP, the integration config is cached for 60 s in a directory private to the PHP user,
`sys_get_temp_dir()/dewee-webchat-<uid>` (created `0700`). If that directory is a link, belongs to
another user or is open to others (another account on a shared host could have created it), nothing
is cached and `error_log` says why; a cached file is only read when it is this user's and not
writable by others. The legacy warning marker uses that same private directory. The CCP edge session
lives in the visitor token (encrypted, same format as the Node handler), because PHP keeps no memory
between requests. `/session` reports the edge session's
end as `expiresAt` (and `expiresIn`), so the widget asks for a new token before it lapses; that
refresh keeps the visitor and re-seals a refreshed edge session, and chat requests do not refresh or
open one. A returning visitor's `/session` is rate limited per visitor, a new visitor's per IP, and
with Turnstile only new visitors are challenged. CCP is told the visitor IP (`X-Dewee-Visitor-IP`)
only when it is a well-formed address; like the per-IP limits it comes from `X-Forwarded-For`, so
trust it only behind a proxy that overwrites that header. A turn that times out, or whose visitor disconnects (seen at the next
write, at most 15 s later), is aborted at CCP.

Array options use the TS names (`transport`, `ccp` = `['chatUrl' => …, 'integrationId' => …,
'integrationSecret' => …]`, `gatewayUrl`, `token`, `agents`, `allowedOrigins`, `rateLimit` =
`false` or `callable(string $key, string $bucket): bool`, `onChat`, `timeoutMs`, …). Rate limits
default to 20 messages/min per visitor+IP and 10 sessions/10 min per IP, kept in files in the
private temp directory described above (when it is unavailable, requests are not limited and `error_log` says
why). They are defense in depth: the Dewee gateway owns the shared message limit, and its
`POLICY_DENIED` / `RATE_LIMITED` refusals (and, with transport `ccp`, CCP's refusals of a message) are answered as typed errors exactly like the TypeScript handler
([admission errors](../docs/http-contract.md#admission-errors)). Set `DEWEE_WEBCHAT_SECRET` for either transport;
without a secret of at least 32 bytes, the backend refuses startup with `500 not_configured`. It does
not generate or persist a fallback secret.

## Streaming (SSE) behind a web server

Each chat turn holds one PHP worker for the length of the reply (up to `timeoutMs`, default 180 s).

- **Nginx + PHP-FPM:** the response sends `X-Accel-Buffering: no`; also set `fastcgi_read_timeout 300s;`
  and keep `gzip` off for `text/event-stream`.
- **Apache:** use PHP-FPM with `flushpackets=on` (`ProxyPassMatch … flushpackets=on`), or mod_php.
  Exclude the endpoint from `mod_deflate` (`SetEnvIf Request_URI "^/api/dewee" no-gzip`).
- **php.ini:** `output_buffering` and `zlib.output_compression` are turned off at runtime; if your
  host forbids that, disable them for the endpoint.
- **PHP built-in server:** single-threaded, fine for local testing (`examples/php`).
