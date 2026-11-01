// Staging smoke: checks the environment first (names only, never values), then runs the same suites
// against the real CCP integration. Nothing is started when a variable is missing or malformed.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, DEWEE_SMOKE_TARGET: "staging" };
const shell = process.platform === "win32";

const check = spawnSync("pnpm", ["exec", "vitest", "run", "test/staging-env.test.ts"], { cwd: root, env, stdio: "inherit", shell });
if (check.status !== 0) {
  console.error("[staging] environment check failed: fix the variables named above (see docs/ccp-host-smoke.md)");
  process.exit(check.status ?? 1);
}
const run = spawnSync("pnpm", ["exec", "vitest", "run", ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit", shell });
process.exit(run.status ?? 1);
