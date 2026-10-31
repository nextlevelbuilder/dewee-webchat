import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseChannel } from "./release-channel.mjs";

test("numbered beta uses beta npm tag and GitHub prerelease", () => {
  assert.deepEqual(releaseChannel("0.4.1-beta.1", "v0.4.1-beta.1"), { version: "0.4.1-beta.1", npmTag: "beta", prerelease: true });
});
test("clean stable explicitly uses latest", () => {
  assert.deepEqual(releaseChannel("1.2.3", "v1.2.3"), { version: "1.2.3", npmTag: "latest", prerelease: false });
});
test("unsupported prereleases and invalid semver cannot publish", () => {
  for (const version of ["0.4.1-rc.1", "0.4.1-beta", "0.4.1-beta.01", "00.4.1", "0.4.1+build", "0.4.1-beta.1+build", "0.4.1-beta.1\n", "0.4.1;echo unsafe", "", null]) {
    assert.throws(() => releaseChannel(version, `v${version}`), /Unsupported/);
  }
});
test("tag must exactly match package version", () => {
  for (const tag of ["v0.4.1", "0.4.1-beta.1", "refs/tags/v0.4.1-beta.1", "v0.4.1-beta.2"]) {
    assert.throws(() => releaseChannel("0.4.1-beta.1", tag), /does not match/);
  }
});
