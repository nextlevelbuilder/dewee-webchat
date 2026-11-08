// Shadow-DOM scoped styles. Theme via CSS custom properties on the host element:
// --dw-accent, --dw-accent-contrast, --dw-bg, --dw-surface, --dw-fg, --dw-muted,
// --dw-border, --dw-radius, --dw-font, --dw-mono, --dw-width, --dw-height, --dw-z.
export const styles = /* css */ `
:host {
  --dw-accent: #5446e8;
  --dw-accent-contrast: #fff;
  --dw-bg: #ffffff;
  --dw-surface: #f5f4fb;
  --dw-fg: #1b1f4b;
  --dw-muted: #6b6f8f;
  --dw-border: #e4e2f1;
  --dw-radius: 18px;
  --dw-font: "Be Vietnam Pro", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --dw-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --dw-width: 400px;
  --dw-height: 640px;
  --dw-z: 2147483000;
  --dw-shadow: 0 24px 64px -16px rgba(27, 31, 75, .28), 0 4px 16px -4px rgba(27, 31, 75, .12);
  all: initial;
  font-family: var(--dw-font);
  color: var(--dw-fg);
}
:host([data-theme="dark"]) {
  --dw-bg: #14152b;
  --dw-surface: #1e2040;
  --dw-fg: #ecebfa;
  --dw-muted: #a2a4c6;
  --dw-border: #2d2f55;
  --dw-shadow: 0 24px 64px -12px rgba(0, 0, 0, .6);
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
[hidden] { display: none !important; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

/* ---------- launcher ---------- */
.launcher {
  position: fixed; bottom: 20px; right: 20px; z-index: var(--dw-z);
  width: 58px; height: 58px; border-radius: 50%;
  background: var(--dw-accent); color: var(--dw-accent-contrast);
  display: grid; place-items: center;
  box-shadow: 0 10px 30px -6px color-mix(in srgb, var(--dw-accent) 60%, transparent);
  transition: transform .2s cubic-bezier(.3,1.4,.6,1), box-shadow .2s;
}
.launcher:hover { transform: translateY(-2px) scale(1.04); }
.launcher:focus-visible { outline: 3px solid color-mix(in srgb, var(--dw-accent) 45%, transparent); outline-offset: 3px; }
.launcher svg { width: 26px; height: 26px; transition: transform .25s, opacity .2s; }
.launcher img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
:host([data-position="bottom-left"]) .launcher { right: auto; left: 20px; }
.launcher .badge {
  position: absolute; top: -2px; right: -2px; width: 14px; height: 14px; border-radius: 50%;
  background: #ff5a7a; border: 2px solid var(--dw-bg); display: none;
}
:host([data-unread]) .launcher .badge { display: block; }

/* ---------- panel ---------- */
.panel {
  position: fixed; bottom: 92px; right: 20px; z-index: var(--dw-z);
  width: min(var(--dw-width), calc(100vw - 32px));
  height: min(var(--dw-height), calc(100dvh - 120px));
  background: var(--dw-bg); color: var(--dw-fg);
  border: 1px solid var(--dw-border); border-radius: var(--dw-radius);
  box-shadow: var(--dw-shadow);
  display: flex; flex-direction: column; overflow: hidden;
  transform-origin: bottom right;
  transition: opacity .18s ease, transform .22s cubic-bezier(.2,.9,.3,1.1), visibility .2s;
}
:host([data-position="bottom-left"]) .panel { right: auto; left: 20px; transform-origin: bottom left; }
:host(:not([data-open])) .panel { opacity: 0; transform: translateY(12px) scale(.96); visibility: hidden; pointer-events: none; }
:host([data-mode="inline"]) .panel {
  position: relative; inset: auto; width: 100%; height: 100%; min-height: 420px;
  opacity: 1; transform: none; visibility: visible; pointer-events: auto; box-shadow: none;
}
:host([data-mode="inline"]) { display: block; height: var(--dw-height); }
:host([data-mode="inline"]) .launcher, :host([data-mode="inline"]) .close { display: none; }
@media (max-width: 520px) {
  :host(:not([data-mode="inline"])) .panel { inset: 0; width: 100vw; height: 100dvh; border-radius: 0; border: 0; }
  :host([data-open]:not([data-mode="inline"])) .launcher { display: none; }
  :host(:not([data-mode="inline"])) .head { padding-top: max(14px, env(safe-area-inset-top)); }
  :host(:not([data-mode="inline"])) .composer { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
}

/* ---------- header ---------- */
.head {
  display: flex; align-items: center; gap: 12px; padding: 14px 14px 14px 16px;
  border-bottom: 1px solid var(--dw-border);
  background: linear-gradient(180deg, color-mix(in srgb, var(--dw-accent) 7%, var(--dw-bg)), var(--dw-bg));
}
.avatar {
  flex: none; width: 38px; height: 38px; border-radius: 12px;
  background: var(--dw-accent); color: var(--dw-accent-contrast);
  display: grid; place-items: center; font-weight: 700; font-size: 16px; overflow: hidden;
}
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.who { flex: 1; min-width: 0; }
.title { font-weight: 650; font-size: 15px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subtitle { font-size: 12px; color: var(--dw-muted); display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: #22c58b; box-shadow: 0 0 0 3px color-mix(in srgb, #22c58b 22%, transparent); }
.agent-select {
  font: inherit; font-size: 12px; color: var(--dw-muted); background: transparent; border: 0;
  padding: 0 14px 0 0; margin: 0; max-width: 170px; cursor: pointer; appearance: none; field-sizing: content; text-overflow: ellipsis;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: right 4px top 55%, right 0 top 55%; background-size: 4px 4px; background-repeat: no-repeat;
}
.agent-select:focus-visible { outline: 2px solid var(--dw-accent); border-radius: 4px; }
.icon-btn {
  width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; color: var(--dw-muted);
  transition: background .15s, color .15s;
}
.icon-btn:hover { background: var(--dw-surface); color: var(--dw-fg); }
.icon-btn:focus-visible { outline: 2px solid var(--dw-accent); }
.icon-btn svg { width: 18px; height: 18px; }

/* ---------- log ---------- */
.log { flex: 1; overflow-y: auto; padding: 18px 16px 8px; scroll-behavior: smooth; overscroll-behavior: contain; }
.log::-webkit-scrollbar { width: 8px; }
.log::-webkit-scrollbar-thumb { background: var(--dw-border); border-radius: 8px; }
.welcome { text-align: left; padding: 6px 2px 10px; animation: rise .35s ease both; }
.welcome h2 { margin: 0 0 6px; font-size: 20px; line-height: 1.3; font-weight: 700; letter-spacing: -.01em; }
.welcome p { margin: 0; color: var(--dw-muted); font-size: 14px; line-height: 1.55; }
.suggestions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.chip {
  font-size: 13px; line-height: 1.3; padding: 8px 12px; border-radius: 999px;
  border: 1px solid var(--dw-border); background: var(--dw-bg); text-align: left;
  transition: border-color .15s, background .15s, transform .15s;
}
.chip:hover { border-color: var(--dw-accent); background: color-mix(in srgb, var(--dw-accent) 6%, var(--dw-bg)); transform: translateY(-1px); }

.msg { display: flex; margin: 0 0 16px; animation: rise .25s ease both; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 86%; font-size: 14.5px; line-height: 1.6; overflow-wrap: anywhere; }
.msg.user .bubble {
  background: var(--dw-accent); color: var(--dw-accent-contrast);
  padding: 9px 14px; border-radius: 18px 18px 6px 18px; white-space: pre-wrap;
}
.msg.assistant .bubble { max-width: 100%; width: 100%; }
.msg.error .bubble {
  color: #c2334f; background: color-mix(in srgb, #ff5a7a 9%, var(--dw-bg));
  border: 1px solid color-mix(in srgb, #ff5a7a 30%, transparent); padding: 9px 12px; border-radius: 12px; font-size: 13.5px;
}
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* markdown */
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p, .md ul, .md ol, .md blockquote, .md pre, .md .table { margin: 0 0 10px; }
.md ul, .md ol { padding-left: 22px; }
.md li { margin: 3px 0; }
.md h3, .md h4, .md h5, .md h6 { margin: 14px 0 6px; font-size: 15px; line-height: 1.35; }
.md a { color: var(--dw-accent); text-decoration: underline; text-underline-offset: 2px; }
.md .md-image { display: block; max-width: 100%; max-height: 320px; min-height: 48px; width: auto; height: auto; object-fit: contain; border-radius: 8px; }
.md code { font-family: var(--dw-mono); font-size: .86em; background: var(--dw-surface); padding: 1.5px 5px; border-radius: 5px; }
.md pre { background: #12132a; color: #e6e6f5; padding: 12px 14px; border-radius: 12px; overflow-x: auto; font-size: 12.5px; line-height: 1.55; }
.md pre code { background: none; padding: 0; color: inherit; font-size: inherit; }
.md blockquote { border-left: 3px solid var(--dw-accent); padding: 2px 0 2px 12px; color: var(--dw-muted); }
.md hr { border: 0; border-top: 1px solid var(--dw-border); margin: 14px 0; }
.md .table { overflow-x: auto; border: 1px solid var(--dw-border); border-radius: 10px; }
.md table { border-collapse: collapse; width: 100%; font-size: 13px; }
.md th, .md td { padding: 7px 10px; border-bottom: 1px solid var(--dw-border); text-align: left; vertical-align: top; overflow-wrap: break-word; min-width: 4.5em; }
.md th { background: var(--dw-surface); font-weight: 600; }
.md tr:last-child td { border-bottom: 0; }
.cursor::after { content: ""; display: inline-block; width: 7px; height: 15px; margin-left: 2px; vertical-align: -2px; background: var(--dw-accent); border-radius: 2px; animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* reasoning + tools */
.trace { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
details.thinking, details.tool {
  border: 1px solid var(--dw-border); border-radius: 12px; background: var(--dw-surface); overflow: hidden;
}
details > summary {
  list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; font-size: 12.5px; color: var(--dw-muted); user-select: none;
}
details > summary::-webkit-details-marker { display: none; }
details > summary:hover { color: var(--dw-fg); }
details > summary .chev { margin-left: auto; transition: transform .2s; width: 14px; height: 14px; flex: none; }
details[open] > summary .chev { transform: rotate(180deg); }
details > summary svg.ic { width: 14px; height: 14px; flex: none; }
.thinking-body {
  padding: 2px 12px 10px; font-size: 12.5px; line-height: 1.55; color: var(--dw-muted);
  white-space: pre-wrap; max-height: 220px; overflow-y: auto;
}
.tool-name { font-family: var(--dw-mono); font-size: 12px; color: var(--dw-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-state { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--dw-bg); border: 1px solid var(--dw-border); flex: none; }
.tool[data-status="done"] .tool-state { color: #13a06f; border-color: color-mix(in srgb, #13a06f 35%, transparent); }
.tool[data-status="error"] .tool-state { color: #c2334f; border-color: color-mix(in srgb, #c2334f 35%, transparent); }
.tool-body { padding: 0 10px 10px; display: grid; gap: 6px; }
.tool-body .label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--dw-muted); }
.tool-body pre {
  margin: 0; font-family: var(--dw-mono); font-size: 11.5px; line-height: 1.5; background: var(--dw-bg);
  border: 1px solid var(--dw-border); border-radius: 8px; padding: 8px; max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
}
.spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--dw-accent) 25%, transparent); border-top-color: var(--dw-accent); animation: spin .7s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.typing { display: inline-flex; gap: 4px; padding: 10px 2px; }
.typing i { width: 7px; height: 7px; border-radius: 50%; background: var(--dw-muted); opacity: .4; animation: bounce 1.2s infinite; }
.typing i:nth-child(2) { animation-delay: .15s; } .typing i:nth-child(3) { animation-delay: .3s; }
@keyframes bounce { 0%, 60%, 100% { transform: none; opacity: .35; } 30% { transform: translateY(-4px); opacity: 1; } }

/* page actions */
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.md[hidden] + .actions { margin-top: 0; }
.action {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 9px 4px 8px; border-radius: 999px;
  border: 1px solid var(--dw-border); background: var(--dw-surface); font-size: 12px; color: var(--dw-muted);
}
.action svg.ic { width: 13px; height: 13px; flex: none; color: var(--dw-accent); }
.action-name { font-family: var(--dw-mono); font-size: 11.5px; color: var(--dw-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.action-state { font-size: 11px; flex: none; }
.action[data-status="done"] .action-state { color: #13a06f; }
.action[data-status="awaiting-confirmation"] { border-color: color-mix(in srgb, #d98a00 45%, transparent); }
.action[data-status="awaiting-confirmation"] .action-state { color: #b06f00; }
.action[data-status="denied"] .action-state, .action[data-status="error"] .action-state { color: #c2334f; }
.notice { margin: -6px 0 16px; font-size: 12px; color: var(--dw-muted); text-align: center; }
.msg.user.refused { flex-direction: column; align-items: flex-end; }
.refusal { margin-top: 6px; max-width: 86%; font-size: 12.5px; line-height: 1.45; color: #c2334f; text-align: right; }
.cooldown { margin: 0 2px 8px; font-size: 12px; color: var(--dw-muted); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.confirm-backdrop {
  position: absolute; inset: 0; z-index: 2; display: flex; align-items: flex-end; justify-content: center; padding: 12px;
  background: color-mix(in srgb, var(--dw-fg) 28%, transparent); animation: rise .18s ease both;
}
.confirm {
  width: 100%; max-height: 100%; overflow: auto; background: var(--dw-bg); color: var(--dw-fg);
  border: 1px solid var(--dw-border); border-radius: 16px; padding: 16px; box-shadow: var(--dw-shadow);
}
.confirm h3 { margin: 0 0 10px; font-size: 15px; font-weight: 650; }
.confirm-action { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.confirm-action code { font-family: var(--dw-mono); font-size: 12.5px; background: var(--dw-surface); padding: 2px 6px; border-radius: 6px; }
.sens { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dw-border); color: var(--dw-muted); }
.sens[data-level="destructive"] { color: #c2334f; border-color: color-mix(in srgb, #c2334f 40%, transparent); }
.confirm-text { margin: 8px 0 0; font-size: 13.5px; line-height: 1.5; color: var(--dw-muted); }
.confirm-warn { margin: 8px 0 0; font-size: 13px; font-weight: 600; color: #c2334f; }
.confirm-args {
  margin: 10px 0 0; font-family: var(--dw-mono); font-size: 11.5px; line-height: 1.5; background: var(--dw-surface);
  border: 1px solid var(--dw-border); border-radius: 8px; padding: 8px; max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
}
.confirm-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.btn { font: inherit; font-size: 13.5px; font-weight: 600; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--dw-border); background: var(--dw-bg); color: var(--dw-fg); min-height: 38px; }
.btn.allow { background: var(--dw-accent); border-color: var(--dw-accent); color: var(--dw-accent-contrast); }
.btn.allow.danger { background: #c2334f; border-color: #c2334f; color: #fff; }
.btn:focus-visible { outline: 3px solid color-mix(in srgb, var(--dw-accent) 45%, transparent); outline-offset: 2px; }

/* ---------- composer ---------- */
.composer { padding: 10px 12px 12px; border-top: 1px solid var(--dw-border); background: var(--dw-bg); }
.page-context { font-size: 12px; margin-bottom: 8px; }
.page-context label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.page-preview { max-height: 96px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 6px; margin: 6px 0; border: 1px solid var(--dw-border); border-radius: 6px; font: inherit; }
.box {
  display: flex; align-items: flex-end; gap: 8px; border: 1px solid var(--dw-border); border-radius: 14px;
  padding: 6px 6px 6px 12px; background: var(--dw-bg); transition: border-color .15s, box-shadow .15s;
}
.box:focus-within { border-color: var(--dw-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dw-accent) 16%, transparent); }
textarea {
  flex: 1; resize: none; border: 0; outline: 0; background: transparent; color: var(--dw-fg);
  font: inherit; font-size: 16px; line-height: 1.45; max-height: 140px; padding: 5px 0; min-height: 34px;
}
textarea::placeholder { color: var(--dw-muted); }
.send {
  width: 36px; height: 36px; border-radius: 10px; flex: none; display: grid; place-items: center;
  background: var(--dw-accent); color: var(--dw-accent-contrast); transition: opacity .15s, transform .15s;
}
.send:disabled { opacity: .35; cursor: default; }
.send:not(:disabled):hover { transform: translateY(-1px); }
.send svg { width: 17px; height: 17px; }
.foot { display: flex; justify-content: space-between; align-items: center; margin-top: 7px; font-size: 11px; color: var(--dw-muted); }
.foot a { color: inherit; text-decoration: none; font-weight: 600; }
.foot a:hover { color: var(--dw-accent); }
.challenge:empty { display: none; }
.challenge { display: flex; justify-content: center; padding: 8px 0; }
/* iOS zooms into any focused field under 16px; keep touch-device fields at 16px. */
@media (pointer: coarse) {
  .agent-select { font-size: 16px; max-width: 200px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
