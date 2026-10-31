import assert from "node:assert/strict";
import { test } from "node:test";
import { collectCdnAssets } from "./cdn-assets.mjs";

const origin = "https://webchat-cdn.dewee.sh";
const npm = "https://cdn.jsdelivr.net/npm/dewee-webchat@";
const current = "0.4.1-beta.1";
const bundle = Buffer.from("current tagged bundle");
const path = (version) => `v/${version}/dewee-webchat.js`;
function fixture() {
  const responses = new Map([
    ["https://registry.npmjs.org/dewee-webchat", { versions: { "0.1.0": {}, "0.3.0": {}, [current]: {} }, "dist-tags": { latest: "0.3.0" } }],
    [`${origin}/`, '<a href="/dewee-webchat@0.1.0/dewee-webchat.js">old</a>'],
    [`${origin}/dewee-webchat@0.1.0/dewee-webchat.js`, Buffer.from("original live historical bytes")],
    [`${origin}/dewee-webchat@latest/dewee-webchat.js`, Buffer.from("original stable alias bytes")],
    [`${npm}0.3.0/dist/dewee-webchat.js`, Buffer.from("newly included historical bundle")],
    [`${npm}${current}/dist/dewee-webchat.js`, bundle],
  ]);
  const fetcher = async (url) => {
    const value = responses.get(url);
    if (value instanceof Error) throw value;
    if (value === undefined) return new Response("missing", { status: 404 });
    if (Buffer.isBuffer(value)) return new Response(value, { headers: { "content-type": "text/javascript" } });
    return new Response(typeof value === "string" ? value : JSON.stringify(value));
  };
  return { responses, run: () => collectCdnAssets({ name: "dewee-webchat", version: current, bundle, fetcher }) };
}
test("beta preserves exact deployed/latest bytes while adding published history", async () => {
  const f = fixture(); const result = await f.run();
  assert.deepEqual(result.assets.get(path("latest")), f.responses.get(`${origin}/dewee-webchat@latest/dewee-webchat.js`));
  assert.deepEqual(result.assets.get(path("0.1.0")), f.responses.get(`${origin}/dewee-webchat@0.1.0/dewee-webchat.js`));
  assert.deepEqual(result.assets.get(path(current)), bundle);
  assert.ok(result.assets.has(path("0.3.0")));
});
test("missing registry, live history, newly included history or latest fails closed", async () => {
  for (const url of ["https://registry.npmjs.org/dewee-webchat", `${origin}/dewee-webchat@0.1.0/dewee-webchat.js`, `${npm}0.3.0/dist/dewee-webchat.js`, `${origin}/dewee-webchat@latest/dewee-webchat.js`]) {
    const f = fixture(); f.responses.delete(url);
    await assert.rejects(f.run(), /unavailable/);
  }
});
test("refuses a different local bundle or immutable version replacement", async () => {
  const f = fixture(); f.responses.set(`${npm}${current}/dist/dewee-webchat.js`, Buffer.from("other published bytes"));
  await assert.rejects(f.run(), /differs/);
  const g = fixture(); g.responses.set(`${origin}/`, g.responses.get(`${origin}/`) + `<a href="/dewee-webchat@${current}/dewee-webchat.js">current</a>`);
  g.responses.set(`${origin}/dewee-webchat@${current}/dewee-webchat.js`, Buffer.from("immutable existing bytes"));
  await assert.rejects(g.run(), /immutable/);
});
test("only verified unavailable metadata-only staging placeholder is omitted, including redeploys", async () => {
  for (const listed of [true, false]) {
    const f = fixture(); f.responses.get("https://registry.npmjs.org/dewee-webchat").versions["0.0.0-stage"] = {};
    if (listed) f.responses.set(`${origin}/`, f.responses.get(`${origin}/`) + '<a href="/dewee-webchat@0.0.0-stage/dewee-webchat.js">stage</a>');
    const inventory = "https://data.jsdelivr.com/v1/package/npm/dewee-webchat@0.0.0-stage/flat";
    f.responses.set(inventory, { files: [{ name: "/package.json" }, { name: "/README.md" }] });
    const result = await f.run(); assert.deepEqual(result.unavailable, ["0.0.0-stage"]);
    assert.ok(!result.versions.includes("0.0.0-stage"));
    f.responses.set(inventory, { files: [{ name: "/dist/dewee-webchat.js" }] });
    await assert.rejects(f.run(), /inventory changed/);
  }
});
test("a live staging asset is preserved regardless of historical placeholder assumptions", async () => {
  const f = fixture(); f.responses.set(`${origin}/`, f.responses.get(`${origin}/`) + '<a href="/dewee-webchat@0.0.0-stage/dewee-webchat.js">stage</a>');
  const bytes = Buffer.from("real stage bytes"); f.responses.set(`${origin}/dewee-webchat@0.0.0-stage/dewee-webchat.js`, bytes);
  assert.deepEqual((await f.run()).assets.get(path("0.0.0-stage")), bytes);
});

test("preserves a served historical bundle even when the old index omitted it", async () => {
  const f = fixture(); const bytes = Buffer.from("unlisted immutable live bytes");
  f.responses.set(`${origin}/dewee-webchat@0.3.0/dewee-webchat.js`, bytes);
  assert.deepEqual((await f.run()).assets.get(path("0.3.0")), bytes);
});
