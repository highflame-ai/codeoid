#!/usr/bin/env bun
/**
 * check-versions — asserts the workspace's npm versions move in lockstep.
 *
 * Every publishable package in this repo ships at the SAME version, cut from one
 * `vX.Y.Z` tag. That is the whole contract the release pipeline rests on: one
 * tag → three publishes, no per-package "is this version new?" bookkeeping and
 * no drift to reconcile by hand.
 *
 * What it enforces:
 *   • all publishable packages declare the same `version`;
 *   • the CLI's dependency ranges on the workspace packages are `^<version>`,
 *     so a published tarball resolves the siblings it was actually built
 *     against;
 *   • `@highflame/codeoid-core`'s peer range on `@highflame/codeoid-protocol`
 *     tracks the same version.
 *
 * Optionally also checks the versions against an expected one — the release
 * workflow passes the tag so a mistyped tag fails before anything is published.
 *
 * Usage:
 *   bun run check:versions            # internal coherence only
 *   bun run check:versions 0.4.0      # ...and must equal 0.4.0
 *
 * NOTE: the wire protocol version is a SEPARATE, independently-moving number
 * (`PROTOCOL_VERSION` in packages/protocol/src/types.ts). npm versions being in
 * lockstep says nothing about wire compatibility, and bumping one must never be
 * taken as a reason to bump the other.
 */

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const ROOT = new URL("..", import.meta.url).pathname;

const read = async (rel: string): Promise<Manifest> =>
  (await Bun.file(`${ROOT}${rel}/package.json`).json()) as Manifest;

const root = await read(".");
const protocol = await read("packages/protocol");
const core = await read("packages/core");
const memory = await read("packages/memory");

const errors: string[] = [];
const expected = process.argv[2]?.replace(/^v/, "");
const version = root.version;

for (const pkg of [protocol, core, memory]) {
  if (pkg.version !== version) {
    errors.push(`${pkg.name}@${pkg.version} is not in lockstep with ${root.name}@${version}`);
  }
}

if (expected && version !== expected) {
  errors.push(`${root.name}@${version} does not match the expected version ${expected}`);
}

const wantRange = `^${version}`;
for (const dep of [protocol.name, core.name, memory.name]) {
  const got = root.dependencies?.[dep];
  if (got !== wantRange) {
    errors.push(`${root.name} depends on ${dep}@${got ?? "<missing>"} — expected ${wantRange}`);
  }
}

const peer = core.peerDependencies?.[protocol.name];
if (peer !== wantRange) {
  errors.push(`${core.name} peer-depends on ${protocol.name}@${peer ?? "<missing>"} — expected ${wantRange}`);
}

// memory ships the wire types it stores (TurnUsage, SessionMessage), so it takes
// a hard dependency on protocol rather than a peer range.
const memProto = memory.dependencies?.[protocol.name];
if (memProto !== wantRange) {
  errors.push(`${memory.name} depends on ${protocol.name}@${memProto ?? "<missing>"} — expected ${wantRange}`);
}

if (errors.length > 0) {
  console.error("version lockstep violated:");
  for (const e of errors) console.error(`  • ${e}`);
  console.error("\nFix with: bun run version:set <x.y.z>");
  process.exit(1);
}

console.log(`versions coherent @ ${version} (${[root.name, protocol.name, core.name, memory.name].join(", ")})`);
