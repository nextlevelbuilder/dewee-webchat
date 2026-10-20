import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
// VERSION in protocol.ts is a string literal placeholder; replace it at build time.
const esbuildPlugins = [
  {
    name: "version",
    setup(build: any) {
      build.onLoad({ filter: /protocol\.ts$/ }, (args: any) => ({
        contents: readFileSync(args.path, "utf8").replace('"__DEWEE_WEBCHAT_VERSION__"', JSON.stringify(version)),
        loader: "ts",
      }));
    },
  },
];

export default defineConfig([
  {
    entry: { index: "src/index.ts", server: "src/server/index.ts", "server-identity": "src/server/identity.ts", react: "src/react.ts", vue: "src/vue.ts" },
    format: ["esm"],
    dts: true,
    target: "es2022",
    external: ["react", "vue", "@dewee/identity"],
    esbuildPlugins,
  },
  {
    entry: { "dewee-webchat": "src/cdn.ts" },
    format: ["iife"],
    minify: true,
    target: "es2020",
    outExtension: () => ({ js: ".js" }),
    esbuildPlugins,
  },
]);
