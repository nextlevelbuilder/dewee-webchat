// Resolve every byte before touching the deploy tree. Existing CDN assets are
// immutable evidence; registry availability must never silently drop history.
export async function collectCdnAssets({ name, version, bundle, fetcher = fetch, cdnOrigin = "https://webchat-cdn.dewee.sh" }) {
  const number = "(?:0|[1-9][0-9]*)";
  const current = new RegExp(`^${number}\\.${number}\\.${number}(?:-beta\\.${number})?$`);
  if (name !== "dewee-webchat" || !current.test(version) || version.trim() !== version) throw new Error("Unsupported CDN package version");
  const file = "dewee-webchat.js";
  const historicalVersion = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
  async function get(url) {
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) { const error = new Error(`Required CDN input unavailable: ${url} (HTTP ${response.status})`); error.status = response.status; throw error; }
    return response;
  }
  async function javascript(url) {
    const response = await get(url);
    if (!/^(?:application|text)\/(?:javascript|x-javascript)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error(`Invalid JavaScript response: ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error(`Empty JavaScript response: ${url}`);
    return bytes;
  }
  const metadata = await (await get(`https://registry.npmjs.org/${name}`)).json();
  if (!metadata.versions || typeof metadata.versions !== "object" || Array.isArray(metadata.versions)) throw new Error("Invalid npm version inventory");
  const index = await (await get(`${cdnOrigin}/`)).text();
  const deployed = new Set();
  for (const match of index.matchAll(/href=["']\/dewee-webchat@([^/"']+)\/dewee-webchat\.js["']/g)) {
    if (match[1] === "latest") continue;
    if (!historicalVersion.test(match[1])) throw new Error("Invalid deployed CDN version inventory");
    deployed.add(match[1]);
  }
  if (!deployed.size) throw new Error("Missing deployed CDN version inventory");
  const versions = new Set([...deployed, ...Object.keys(metadata.versions), version]);
  for (const value of versions) if (!historicalVersion.test(value)) throw new Error("Invalid npm version inventory");
  if (!metadata.versions[version]) throw new Error("Current CDN version is not published on npm");
  const published = await javascript(`https://cdn.jsdelivr.net/npm/${name}@${version}/dist/${file}`);
  if (!published.equals(bundle)) throw new Error("Local bundle differs from the published immutable version");
  const assets = new Map();
  const unavailable = [];
  for (const value of versions) {
    let bytes;
    try {
      try {
        bytes = await javascript(`${cdnOrigin}/${name}@${value}/${file}`);
      } catch (liveError) {
        if (liveError.status !== 404 || deployed.has(value)) throw liveError;
        bytes = value === version ? bundle : await javascript(`https://cdn.jsdelivr.net/npm/${name}@${value}/dist/${file}`);
      }
    } catch (error) {
      // The original staging package contained only README/package metadata.
      // Its old index link was already a 404, not an asset to preserve.
      if (value !== "0.0.0-stage" || error.status !== 404) throw error;
      try {
        bytes = await javascript(`https://cdn.jsdelivr.net/npm/${name}@${value}/dist/${file}`);
      } catch (npmError) {
        if (npmError.status !== 404) throw npmError;
        const inventory = await (await get(`https://data.jsdelivr.com/v1/package/npm/${name}@${value}/flat`)).json();
        const paths = inventory.files?.map((entry) => entry.name).sort();
        if (JSON.stringify(paths) !== JSON.stringify(["/README.md", "/package.json"])) throw new Error("Staging package inventory changed; refusing to omit it");
        unavailable.push(value);
        versions.delete(value);
        continue;
      }
    }
    if (value === version && !bytes.equals(bundle)) throw new Error("Refusing to replace an existing immutable CDN version");
    assets.set(`v/${value}/${file}`, bytes);
  }
  const latest = version.includes("-")
    ? await javascript(`${cdnOrigin}/${name}@latest/${file}`)
    : bundle;
  // A stable deployment is only permitted to advance to npm's canonical latest.
  if (!version.includes("-") && metadata["dist-tags"]?.latest !== version) throw new Error("Stable CDN build is not npm latest");
  assets.set(`v/latest/${file}`, latest);
  return { assets, versions: [...versions], deployed: [...deployed].filter((value) => !unavailable.includes(value)), unavailable };
}
