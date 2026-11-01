// Next.js App Router (examples/nextjs, `next start`) over transport "ccp": the shared browser contract.
import { join } from "node:path";
import { afterAll, beforeAll, describe } from "vitest";
import type { Browser } from "../src/browser";
import { EXAMPLES, startHost, type Host } from "../src/hosts";
import { startTarget, type Target } from "../src/target";
import { ccpContract } from "./ccp-contract";

let target: Target;
let host: Host;
const outputs: Browser[] = [];

beforeAll(async () => {
  target = await startTarget();
  host = await startHost("nextjs", target.env);
});

afterAll(async () => {
  await host?.stop();
  await target?.close();
});

describe("Next.js App Router: CCP browser contract", () => {
  ccpContract(() => ({ host, target, outputs, clientDir: join(EXAMPLES, "nextjs/.next/static") }));
});
