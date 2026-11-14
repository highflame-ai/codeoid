/**
 * Files whose contents are credentials (`.env`, `~/.ssh/id_ed25519`,
 * `~/.aws/credentials`, an agent's own login), after atuin's (less `*.pem`:
 * most are public certificates, and a private key in one is found by its
 * armour when it is read out, detect.ts),
 * `atuin-common/src/secrets/files.rs` (MIT). What reads one out, or writes
 * one, isn't stored (verdict.ts): such a file holds nothing else, in
 * whatever format, so scrubbing by shape would miss whatever it can't name.
 */

import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

/** Names that say a file holds credentials, wherever it is (`*` within the name). */
const NAMES = [
  ".env", ".env.*", "*.env", ".envrc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk",
  "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.tfstate", "*.tfstate.backup", "*.tfvars",
  ".netrc", "_netrc", ".pgpass", ".git-credentials", ".npmrc", ".pypirc", ".htpasswd", ".vault-token",
];

/** Of those, templates and public halves. */
const NOT_NAMES = ["*.example", "*.sample", "*.template", "*.dist", "*.pub"];

/** Where tools keep their logins, under the home (`**` any depth below). */
const HOME_PATHS = [
  ".aws/credentials", ".aws/sso/cache/**", ".aws/cli/cache/**",
  ".config/gcloud/application_default_credentials.json", ".config/gcloud/credentials.db", ".config/gcloud/access_tokens.db",
  ".config/gcloud/legacy_credentials/**", ".azure/msal_token_cache.*", ".kube/config", ".docker/config.json",
  ".config/gh/hosts.yml", ".config/glab-cli/config.yml", ".config/hub", ".terraform.d/credentials.tfrc.json",
  ".cargo/credentials", ".cargo/credentials.toml", ".gem/credentials", ".gnupg/private-keys-v1.d/**", ".password-store/**",
  ".claude/.credentials.json", ".codex/auth.json", ".local/share/opencode/auth.json", ".pi/agent/auth.json",
  ".gemini/oauth_creds.json", ".qwen/oauth_creds.json",
];

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const NAME_RES = NAMES.map(globToRegExp);
const NOT_NAME_RES = NOT_NAMES.map(globToRegExp);

/** Whether `path` (relative ones from `cwd`) is a file that holds credentials. `extra`: the user's own globs, by name or by path. */
export function isCredentialFile(path: string, cwd: string, extra: readonly string[] = []): boolean {
  const home = process.env.HOME ?? homedir();
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  const abs = normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
  const name = basename(abs);
  if (NAME_RES.some((r) => r.test(name)) && !NOT_NAME_RES.some((r) => r.test(name))) return true;
  for (const p of HOME_PATHS) if (globToRegExp(join(home, p)).test(abs)) return true;
  for (const g of extra) {
    const pattern = g.startsWith("~/") ? join(home, g.slice(2)) : g;
    if ((pattern.includes("/") ? globToRegExp(pattern).test(abs) : globToRegExp(pattern).test(name))) return true;
  }
  return false;
}
