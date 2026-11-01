// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  output: "server",
  // A standalone Node server (`node dist/server/entry.mjs`), as tose-app/frontend runs Astro.
  // HOST and PORT come from the environment at start.
  adapter: node({ mode: "standalone" }),
  session: false,
});
