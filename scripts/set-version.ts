#!/usr/bin/env bun
/**
 * set-version — bumps every publishable package in the workspace to one version.
 *
 * The counterpart to `check-versions`: this is the only sanctioned way to bump,
 * so the lockstep invariant is produced mechanically rather than remembered.
 * It rewrites, in one pass:
 *
 *   • `version` in the CLI, protocol, and core manifests;
 *   • the CLI's `^` dependency ranges on the two workspace packages;
 *   • core's `^` peer range on protocol.
 *
 * Usage:
 *   bun run version:set 0.5.0
 *
 * Then: refresh the lockfiles (`bun install && cd web && bun install`), move the
 * CHANGELOG `## [Unreleased]` notes under `## [0.5.0]`, and open the PR. The tag
 * comes after the merge — see RELEASING.md.
 */

const version = process.argv[2]?.replace(/^v/, "");

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: bun run version:set <x.y.z>");
  process.exit(1);
}

const ROOT = new URL("..", import.meta.url).pathname;
const PROTOCOL = "@highflame/codeoid-protocol";
const CORE = "@highflame/codeoid-core";

/**
 * Rewrites the manifest as TEXT, not as a parsed-and-redumped object: a JSON
 * round-trip would reformat the whole file (key order survives, but array and
 * unicode formatting do not) and bury a two-line version bump in noise.
 */
async function patch(rel: string, edits: Array<[RegExp, string]>): Promise<void> {
  const path = `${ROOT}${rel}/package.json`;
  let text = await Bun.file(path).text();
  for (const [pattern, replacement] of edits) {
    if (!pattern.test(text)) {
      console.error(`${rel}/package.json: no match for ${pattern} — manifest shape changed?`);
      process.exit(1);
    }
    text = text.replace(pattern, replacement);
  }
  await Bun.write(path, text);
  console.log(`  ${rel}/package.json → ${version}`);
}

const versionField = (): [RegExp, string] => [/("version":\s*")[^"]+(")/, `$1${version}$2`];
const range = (dep: string): [RegExp, string] => [
  new RegExp(`("${dep.replace("/", "\\/")}":\\s*")\\^[^"]+(")`),
  `$1^${version}$2`,
];

console.log(`setting workspace version to ${version}`);
await patch(".", [versionField(), range(PROTOCOL), range(CORE)]);
await patch("packages/protocol", [versionField()]);
await patch("packages/core", [versionField(), range(PROTOCOL)]);

console.log("\nnext: bun install && (cd web && bun install), then update CHANGELOG.md");
