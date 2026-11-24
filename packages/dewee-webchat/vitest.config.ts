import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The examples import the package by name. Tests that load example code resolve it to the sources,
// so they run before (and without) a build.
export default defineConfig({
  resolve: {
    alias: [{ find: /^dewee-webchat$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) }],
  },
});
