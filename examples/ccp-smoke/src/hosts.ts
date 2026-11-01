// Starts a built example as a real server process on a free loopback port and stops it again,
// checking that the port is closed afterwards so no server outlives the run.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export type HostKind = "astro-node" | "nextjs";

export interface Host {
  kind: HostKind;
  /** http://127.0.0.1:<port> */
  origin: string;
  /** stdout and stderr so far (server-side logs). */
  logs(): string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

const portOpen = (port: number) =>
  new Promise<boolean>((ok) => {
    const sock = connect(port, "127.0.0.1");
    sock.once("connect", () => (sock.destroy(), ok(true)));
    sock.once("error", () => ok(false));
  });

/** Only what a host needs from this machine; no DEWEE_/GOCLAW_ variable of the developer's shell leaks in. */
function baseEnv(): Record<string, string> {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ComSpec", "PATHEXT"];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

function command(kind: HostKind, port: number): { cwd: string; args: string[]; entry: string } {
  if (kind === "astro-node") {
    const cwd = join(EXAMPLES, "astro-node");
    return { cwd, entry: join(cwd, "dist/server/entry.mjs"), args: [join(cwd, "dist/server/entry.mjs")] };
  }
  const cwd = join(EXAMPLES, "nextjs");
  const bin = join(cwd, "node_modules/next/dist/bin/next");
  return { cwd, entry: join(cwd, ".next/BUILD_ID"), args: [bin, "start", "-p", String(port), "-H", "127.0.0.1"] };
}

export async function startHost(kind: HostKind, env: Record<string, string>): Promise<Host> {
  const port = await freePort();
  const { cwd, args, entry } = command(kind, port);
  if (!existsSync(entry)) throw new Error(`${kind} is not built: run \`pnpm -C examples/ccp-smoke build:hosts\` first`);
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd,
    env: { ...baseEnv(), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", HOST: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const origin = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 60_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`${kind} exited during startup:\n${out}`);
    try {
      await fetch(`${origin}/api/dewee/config`);
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(`${kind} did not start within 60 s:\n${out}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return {
    kind,
    origin,
    logs: () => out,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => {
          // Ignored SIGTERM (or a child of its own on Windows): end the whole tree.
          if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
          else child.kill("SIGKILL");
        }, 5_000);
        await exited;
        clearTimeout(timer);
      }
      for (let i = 0; i < 20 && (await portOpen(port)); i++) await new Promise((r) => setTimeout(r, 100));
      if (await portOpen(port)) throw new Error(`${kind}: port ${port} is still open after stop`);
    },
  };
}
