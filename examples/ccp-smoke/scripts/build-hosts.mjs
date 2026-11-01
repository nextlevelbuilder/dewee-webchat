// Builds both host examples for the smoke run with canary values in every secret variable, then fails
// if a canary reached a file the browser can download: the build must read secrets at run time only.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CANARY = {
  DEWEE_CCP_CHAT_URL: "https://build-canary.invalid/api/public/webchat/v1/wci_buildcanaryaaaaaaaaaaaaaaaa",
  DEWEE_WEBCHAT_INTEGRATION_ID: "wci_buildcanaryaaaaaaaaaaaaaaaa",
  DEWEE_WEBCHAT_INTEGRATION_SECRET: "dwc_BUILD_CANARY_integration_secret_0001",
  DEWEE_WEBCHAT_SECRET: "BUILD_CANARY_visitor_secret_00000000000001",
  DEWEE_IDENTITY_ASSERTION_SECRET: "BUILD_CANARY_assertion_secret_000000000001",
  DEMO_LOGIN_SECRET: "BUILD_CANARY_demo_login_secret_00000000001",
};
// Everything a browser can receive: static assets, and for Next.js also the prerendered pages.
const HOSTS = [
  { name: "astro-node", client: ["dist/client"] },
  { name: "nextjs", client: [".next/static", ".next/server/app"], only: /\.(html|rsc|body|js|css|json)$/ },
];

function build(name) {
  const env = { ...process.env, ...CANARY, NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1" };
  for (const k of Object.keys(env)) if (/^(DEWEE_GATEWAY_|GOCLAW_GATEWAY_)/.test(k)) delete env[k];
  const run = () => spawnSync("pnpm", ["-C", join(EXAMPLES, name), "build"], { env, stdio: "inherit", shell: process.platform === "win32" });
  let r = run();
  // `next build` can stop once on a transient check; a second failure is real.
  if (r.status !== 0) {
    console.warn(`[build-hosts] ${name}: build failed, retrying once`);
    r = run();
  }
  if (r.status !== 0) throw new Error(`${name}: build failed (exit ${r.status})`);
}

const filesUnder = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });

let leaks = 0;
for (const host of HOSTS) {
  build(host.name);
  const files = host.client.flatMap((dir) => filesUnder(join(EXAMPLES, host.name, dir)));
  for (const file of files.filter((f) => !host.only || host.only.test(f))) {
    const text = readFileSync(file, "latin1");
    for (const [name, value] of Object.entries(CANARY)) {
      if (text.includes(value)) {
        console.error(`[build-hosts] ${name} was inlined into ${file}`);
        leaks++;
      }
    }
  }
}
if (leaks) process.exit(1);
console.log("[build-hosts] both hosts built; no secret reached the client bundles");
