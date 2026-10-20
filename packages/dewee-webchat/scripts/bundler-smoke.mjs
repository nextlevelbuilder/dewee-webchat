// Bundler smoke test of the built package (run `pnpm build` first): a host that only serves anonymous
// visitors must be able to bundle `dewee-webchat/server` with webpack and esbuild without
// `@dewee/identity` installed. The SDK is made unresolvable for that bundle, so any reference to it,
// static or dynamic, fails the build. As a control, `dewee-webchat/server/identity` must bundle when
// the SDK is present.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import webpack from "webpack";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const dist = (f) => join(pkgDir, "dist", f).replace(/\\/g, "/");
const SDK = "@dewee/identity";
const work = mkdtempSync(join(tmpdir(), "dewee-webchat-bundlers-"));
const failures = [];

const anonymousEntry = join(work, "anonymous.mjs");
writeFileSync(
  anonymousEntry,
  `import { createDeweeHandler } from ${JSON.stringify(dist("server.js"))};\n` +
    `const h = createDeweeHandler({ gatewayUrl: "https://gw.example.com", token: "t", secret: "s".repeat(32), agents: ["support"] });\n` +
    `const res = await h(new Request("https://site.test/api/dewee/config", { method: "OPTIONS" }));\n` +
    `if (res.status !== 204) throw new Error("unexpected status " + res.status);\n` +
    `console.log("anonymous handler ok");\n`,
);
const identityEntry = join(work, "identity.mjs");
writeFileSync(identityEntry, `import { deweeIdentitySdk } from ${JSON.stringify(dist("server-identity.js"))};\nconsole.log(typeof deweeIdentitySdk.exchangeSession);\n`);

async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`FAIL ${name}\n${e?.message ?? e}`);
  }
}

/** esbuild plugin: the SDK is not installed. */
const sdkAbsent = {
  name: "sdk-absent",
  setup(build) {
    build.onResolve({ filter: /^@dewee\/identity(\/.*)?$/ }, () => ({ errors: [{ text: `${SDK} is not installed` }] }));
  },
};

await step("dist/server.js does not import the SDK", () => {
  const importOf = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']@dewee\/identity["']/;
  if (importOf.test(readFileSync(dist("server.js"), "utf8"))) throw new Error(`dist/server.js imports ${SDK}`);
});

await step("esbuild bundles the anonymous server without the SDK, and the bundle runs", async () => {
  const outfile = join(work, "esbuild-anonymous.mjs");
  await esbuild.build({ entryPoints: [anonymousEntry], bundle: true, platform: "node", format: "esm", outfile, plugins: [sdkAbsent], logLevel: "silent" });
  await import(pathToFileURL(outfile).href);
});

function runWebpack(entry, filename, alias) {
  return new Promise((resolve, reject) => {
    webpack(
      {
        mode: "production",
        target: "node",
        entry,
        experiments: { outputModule: true },
        output: { path: work, filename, module: true, chunkFormat: "module" },
        resolve: { alias },
        optimization: { minimize: false },
      },
      (err, stats) => {
        if (err) return reject(err);
        if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
        resolve();
      },
    );
  });
}

await step("webpack bundles the anonymous server without the SDK, and the bundle runs", async () => {
  // Aliasing the SDK to a missing file makes any reference to it a "Module not found" error.
  await runWebpack(anonymousEntry, "webpack-anonymous.mjs", { [SDK]: join(work, "not-installed", "missing.js") });
  await import(pathToFileURL(join(work, "webpack-anonymous.mjs")).href);
});

await step("control: esbuild bundles dewee-webchat/server/identity with the SDK installed", async () => {
  await esbuild.build({ entryPoints: [identityEntry], bundle: true, platform: "node", format: "esm", outfile: join(work, "esbuild-identity.mjs"), nodePaths: [join(pkgDir, "node_modules")], logLevel: "silent" });
});

await step("control: esbuild refuses dewee-webchat/server/identity without the SDK", async () => {
  let refused = false;
  try {
    await esbuild.build({ entryPoints: [identityEntry], bundle: true, platform: "node", format: "esm", write: false, plugins: [sdkAbsent], logLevel: "silent" });
  } catch (e) {
    refused = String(e?.message ?? e).includes(`${SDK} is not installed`);
    if (!refused) throw e;
  }
  if (!refused) throw new Error("the identity entry bundled without the SDK: the check would not catch a reference");
});

rmSync(work, { recursive: true, force: true });
if (failures.length) {
  console.error(`${failures.length} bundler check(s) failed`);
  process.exit(1);
}
console.log("all bundler checks passed");
