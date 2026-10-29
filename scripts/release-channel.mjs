import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Only clean stable releases and numbered beta releases are supported. */
export function releaseChannel(version, ref) {
  const numeric = "(?:0|[1-9][0-9]*)";
  const match = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(-beta\\.${numeric})?$`).exec(version);
  if (typeof version !== "string" || !match || match[0] !== version) throw new Error("Unsupported release version");
  if (ref !== `v${version}`) throw new Error("Tag does not match package version");
  const prerelease = Boolean(match[1]);
  return { version, npmTag: prerelease ? "beta" : "latest", prerelease };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [packagePath, ref] = process.argv.slice(2);
    if (!packagePath || !ref) throw new Error("Usage: release-channel.mjs <package.json> <tag>");
    const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
    const release = releaseChannel(version, ref);
    const output = `version=${release.version}\nnpm_tag=${release.npmTag}\nprerelease=${release.prerelease}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

