# Releasing codeoid

Three packages ship from this repo, all under the `@highflame` npm scope:

| Package                        | Directory           | Who consumes it                                  |
| ------------------------------ | ------------------- | ------------------------------------------------ |
| `@highflame/codeoid`           | repo root           | end users — installs the `codeoid` CLI + daemon   |
| `@highflame/codeoid-protocol`  | `packages/protocol` | the daemon, the web UI, the mobile app            |
| `@highflame/codeoid-core`      | `packages/core`     | the daemon, the web UI, the mobile app            |

## The one rule: lockstep versions

**All three packages always ship at the same version, cut from one `vX.Y.Z` tag.**

That is the entire contract the pipeline rests on. One tag produces three
publishes in dependency order, with no per-package "is this version new?"
bookkeeping and no drift to reconcile by hand. `bun run check:versions` enforces
it — in CI on every PR, in `bun run smoke`, and again in the release workflow
against the tag itself — so a partial bump fails long before it reaches npm.

Bump with the script, never by hand; it rewrites all three `version` fields plus
the internal `^` dependency and peer ranges in one pass:

```bash
bun run version:set 0.5.0
bun install && (cd web && bun install)   # refresh both lockfiles
```

> **The wire protocol version is a separate number.** `PROTOCOL_VERSION` in
> [`packages/protocol/src/types.ts`](packages/protocol/src/types.ts) moves only on
> wire-breaking changes, and stays in lockstep with the `codeoid-protocol` crate
> in [codeoid-ui](https://github.com/highflame-ai/codeoid-ui). npm versions being
> in lockstep says nothing about wire compatibility, and bumping one is never a
> reason to bump the other — the handshake negotiates.

## Cutting a release

1. `bun run version:set X.Y.Z`, then refresh both lockfiles.
2. Move the `## [Unreleased]` notes into a new `## [X.Y.Z]` section in
   [`CHANGELOG.md`](CHANGELOG.md).
3. Open a PR, get CI green, merge to `main`.
4. Tag from `main` and push (tags are not branch-protected):

   ```bash
   git checkout main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

[`.github/workflows/release.yml`](.github/workflows/release.yml) then builds the
web UI, runs the test suite, verifies the three versions match the tag, publishes
protocol → core → CLI with
[provenance](https://docs.npmjs.com/generating-provenance-statements), and opens a
GitHub Release. Install with:

```bash
bun install -g @highflame/codeoid   # or: bunx @highflame/codeoid
```

The binary is still called `codeoid`.

## One-time setup — npm Trusted Publishing (OIDC)

There are **no npm tokens** in this repo. Publishing authenticates with the
GitHub Actions OIDC id-token against a Trusted Publisher configured on each
package at npmjs.com, and provenance is generated from that same identity.

npm can only attach a Trusted Publisher to a package that **already exists**, so
each new package name needs exactly one manual bootstrap publish first. This is a
per-package-name chore, not a per-release one.

**Prerequisite:** publish rights on the `@highflame` npm org (an org member with
at least write access to the packages, or an org admin who can create them).

```bash
npm login                       # must be the @highflame org member

bun install
cd web && bun install --frozen-lockfile && bun run build && cd ..
bun run check:versions

# Dependency order. No --provenance: that requires a CI OIDC token and will
# fail locally. No --access public: publishConfig.access covers it.
cd packages/protocol && npm publish && cd ../..
cd packages/core     && npm publish && cd ../..
npm publish                     # @highflame/codeoid — runs prepublishOnly (web build)
```

Then, for **each** of the three packages, at
`npmjs.com/package/<name>/access` → **Trusted Publisher** → *GitHub Actions*:

| Field             | Value           |
| ----------------- | --------------- |
| Organization      | `highflame-ai`  |
| Repository        | `codeoid`       |
| Workflow filename | `release.yml`   |
| Environment       | *(leave empty)* |

After that, every subsequent release goes through the tag → workflow path above
and nothing needs a token again.

The bootstrap publish above and the tag can happen in either order: the
workflow's publishes go through
[`scripts/publish-if-new.sh`](scripts/publish-if-new.sh), which skips any
name@version already on the registry. So the `v0.4.0` tag that follows a manual
bootstrap does not leave a red pipeline behind, and a release job that dies
part-way through (network, flaky test, cancelled run) can simply be re-run
instead of tripping over the packages that already landed. A registry error that
is *not* a 404 fails the step rather than being read as "not published yet".

## Notes

- **codeoid runs under [Bun](https://bun.sh).** The published CLI ships `src/`
  plus the prebuilt `web/dist`, and points `bin` at `src/cli.ts` (Bun executes
  TypeScript directly — no bundling step, and the web UI path resolves inside the
  package).
- **`web/` is its own install root** with its own lockfile, so the workspace
  packages come in as `file:` copies rather than workspace links. Bun *copies*
  them at install time, so after editing `packages/protocol` or `packages/core`
  you must re-run `bun install` in `web/` to refresh the copy. The `overrides`
  entry in [`web/package.json`](web/package.json) pins the transitive
  `@highflame/codeoid-protocol` peer to the in-repo copy too — without it, a
  fresh `bun install` in `web/` would try to satisfy that peer from the registry
  and the web build would silently depend on what is published rather than on the
  working tree.
- **Predecessor packages.** codeoid was previously published from a personal
  account as `codeoid`, `@codeoid/protocol`, and `@codeoid/core`. npm has no way
  to move a package between scopes, so those names were retired in favour of the
  `@highflame` ones and deprecated in place (existing installs keep resolving).
  The last version published under the old names was `0.3.4` / `0.2.0` / `0.2.0`.
