# dewee-webchat — PHP backend

`dewee-webchat.php` is a single-file backend for the chat widget (PHP >= 8.1, `ext-openssl`, no
Composer). It implements the [HTTP contract](../docs/http-contract.md) and behaves like the Node
handler in `dewee-webchat/server` for anonymous and signed-in visitors. The integration secret stays on your server.

## Signed-in users

Configure `identity` in the PHP options and authenticate using your site's server-side session. The
callback must return the stable subject of the currently signed-in user, or `null` when signed out;
throw when the login service cannot be checked. Keep both secrets in server-only configuration.

```php
$options = DeweeWebchat::optionsFromEnv();
$options['identity'] = [
    'appId' => getenv('DEWEE_IDENTITY_APP_ID'),
    'issuer' => 'https://shop.example',
    'assertionSecret' => getenv('DEWEE_IDENTITY_ASSERTION_SECRET'),
    'authenticate' => static function () {
        return isset($_SESSION['user_id']) ? ['subject' => (string) $_SESSION['user_id']] : null;
    },
    'rebindEachRequest' => true,
];
DeweeWebchat::handle($options);
```

Start and protect the host session before invoking the handler. Alternatively configure
`privateKeyJwk` and `algorithm` (`RS256`, `ES256`, or `EdDSA`; EdDSA requires `ext-sodium`)
instead of `assertionSecret`. CCP defaults to the integration's agent; direct Gateway mode needs an
allowed agent. `required` refuses anonymous sessions and `sessionTtlSeconds` controls the session
lifetime (60–43200 seconds). PHP is stateless between requests: CCP reuse relies on the signed,
subject-bound reuse hint, not a server-side shared session store.

On logout, before removing the host session, call `DeweeWebchat::revoke($subject, $token, $options)`
with the authenticated subject and the widget's `reuseHint()` or visitor token. With CCP this makes a
best-effort revocation of the matching identity session; the direct Gateway transport has no revoke
endpoint and its session expires normally. The hook does not replace the host's logout or CSRF checks.

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
| `DEWEE_IMAGE_SOURCES` | Comma-separated trusted HTTPS directory prefixes for the image proxy; disabled when unset |
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
'integrationSecret' => …]`, `gatewayUrl`, `token`, `agents`, `allowedOrigins`, `allowedHeaders` (additional CORS header names), `rateLimit` =
`false` or `callable(string $key, string $bucket): bool`, `onChat`, `timeoutMs`, …). Rate limits
default to 20 messages/min per visitor+IP and 10 sessions/10 min per IP, kept in files in the
private temp directory described above. If it cannot be verified, PHP refuses limited requests with
`503 rate_limit_unavailable` and records a warning. On Windows the built-in private-directory check
is unavailable: provide a shared `rateLimit` callback for these routes. The callback must return a
boolean and use an atomic shared store; exceptions or invalid return values also refuse the request.
Explicit `rateLimit => false` disables this protection. The limits are defense in depth: the Dewee gateway owns the shared message limit, and its
`POLICY_DENIED` / `RATE_LIMITED` refusals (and, with transport `ccp`, CCP's refusals of a message) are answered as typed errors exactly like the TypeScript handler
([admission errors](../docs/http-contract.md#admission-errors)). Set `DEWEE_WEBCHAT_SECRET` for either transport;
without a secret of at least 32 bytes, the backend refuses startup with `500 not_configured`. It does
not generate or persist a fallback secret.

The image proxy also needs the private temporary directory for its shared concurrency limit. If it
cannot verify private storage (including on Windows hosts where POSIX ownership checks are unavailable),
it returns `503 image_unavailable` instead of fetching. See [issue #33](https://github.com/nextlevelbuilder/dewee-webchat/issues/33).

## Streaming (SSE) behind a web server

Each chat turn holds one PHP worker for the length of the reply (up to `timeoutMs`, default 180 s).

- **Nginx + PHP-FPM:** the response sends `X-Accel-Buffering: no`; also set `fastcgi_read_timeout 300s;`
  and keep `gzip` off for `text/event-stream`.
- **Apache:** use PHP-FPM with `flushpackets=on` (`ProxyPassMatch … flushpackets=on`), or mod_php.
  Exclude the endpoint from `mod_deflate` (`SetEnvIf Request_URI "^/api/dewee" no-gzip`).
- **php.ini:** `output_buffering` and `zlib.output_compression` are turned off at runtime; if your
  host forbids that, disable them for the endpoint.
- **PHP built-in server:** single-threaded, fine for local testing (`examples/php`).
