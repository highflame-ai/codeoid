/**
 * The home a sandbox shows by default (#448, policy.ts). Its own module, with
 * no imports, so the config schema (config.ts) can default to it.
 */

/**
 * The home allowlist by default: where toolchains and the programs they
 * installed live, and git's settings. Each holds no credential of its own
 * (registry tokens live in `~/.npmrc`, `~/.cargo/credentials.toml`,
 * `~/.pypirc`, `~/.bunfig.toml`, git's in `~/.git-credentials` and
 * `~/.config/git/credentials`: none of them listed). A token written into
 * `~/.gitconfig` itself (a URL with one, an `extraHeader`) would show.
 * A global npmrc inside an nvm install is hidden again (policy.ts `homeCredentialFilesIn`).
 */
export const DEFAULT_HOME_READABLE: readonly string[] = [
  "~/.bun",
  "~/.cargo/bin",
  "~/.cargo/registry",
  "~/.cargo/git",
  "~/.rustup",
  "~/.nvm",
  "~/.npm",
  "~/.local/bin",
  "~/.local/share/pnpm",
  "~/.pyenv",
  "~/go/pkg",
  "~/go/bin",
  "~/.gitconfig",
  "~/.config/git/config",
  "~/.config/git/ignore",
  "~/.config/git/attributes",
];
