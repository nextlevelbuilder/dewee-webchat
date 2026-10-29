// Assembles the static CDN tree served at webchat-cdn.dewee.sh:
//   /v/<version>/dewee-webchat.js   one folder per published version (served as /dewee-webchat@<version>/…)
//   /v/latest/dewee-webchat.js      stable build (preserved for beta; served as /dewee-webchat@latest/… and /dewee-webchat.js)
// src/cdn-worker.js maps the public URLs and sets cache headers.
// Retain live CDN bytes; new historical versions come from npm via jsDelivr.
import { collectCdnAssets } from "./cdn-assets.mjs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "../packages/dewee-webchat");
const out = join(root, "public");
const { name, version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const bundle = join(pkgDir, "dist/dewee-webchat.js");
const file = "dewee-webchat.js";

const { assets, versions, unavailable } = await collectCdnAssets({ name, version, bundle: readFileSync(bundle) });
for (const value of unavailable) console.warn(`Not an available CDN version: ${value} (existing CDN/npm bundle 404; verified metadata-only placeholder)`);
// Retrieval/validation is complete. No partial history can become deployable.
rmSync(out, { recursive: true, force: true });
const put = (rel, data) => {
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  writeFileSync(join(out, rel), data);
};
for (const [relativePath, bytes] of assets) put(relativePath, bytes);
put("404.html", '<!doctype html><title>Not found</title><p>Not found. See <a href="/">the index</a>.</p>\n');

const sorted = [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
put(
  "index.html",
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dewee-webchat CDN</title><style>body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 16px;color:#1b1f4b}code,pre{background:#f1f0fb;border-radius:8px}code{padding:2px 6px}pre{padding:14px;overflow:auto}a{color:#5446e8}</style></head>
<body><h1>dewee-webchat CDN</h1><p>Drop-in script for the <a href="https://webchat.dewee.sh">Dewee web chat widget</a>.</p>
<pre>&lt;script src="https://webchat-cdn.dewee.sh/${name}@latest/${file}"
  data-endpoint="/api/dewee" defer&gt;&lt;/script&gt;</pre>
<p>Versions: ${sorted.map((v) => `<a href="/${name}@${v}/${file}"><code>${v}</code></a>`).join(" ")} · <a href="/${name}@latest/${file}"><code>latest</code></a></p>
<p>Source: <a href="https://github.com/nextlevelbuilder/dewee-webchat">github.com/nextlevelbuilder/dewee-webchat</a></p></body></html>\n`,
);
console.log(`CDN tree ready: ${sorted.join(", ")} (+latest)`);
