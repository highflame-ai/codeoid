/**
 * A workstream as the settings editor edits it: plain strings, one rule or
 * server per line — and back to the config item `workstream.upsert` takes.
 * Pure. The daemon validates the result whole (one rule, one message); this
 * only shapes text into the item and keeps every field it doesn't edit.
 */

export interface WorkstreamForm {
  id: string;
  name: string;
  color: string;
  claim: "exclusive" | "suggest";
  allowOverride: boolean;
  share: "open" | "ask" | "closed";
  abstract: boolean;
  extends: string;
  /** One path glob per line. */
  paths: string;
  /** One remote rule per line. */
  remotes: string;
  /** One per line: `server`, or `server = credential`. */
  servers: string;
  /** One per line: `NAME = credential`. */
  env: string;
  gitName: string;
  gitEmail: string;
}

export const EMPTY_FORM: WorkstreamForm = {
  id: "",
  name: "",
  color: "",
  claim: "suggest",
  allowOverride: true,
  share: "ask",
  abstract: false,
  extends: "",
  paths: "",
  remotes: "",
  servers: "",
  env: "",
  gitName: "",
  gitEmail: "",
};

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const arr = (v: unknown) => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The configured item (WorkstreamSummary.config) as the editor shows it. */
export function toForm(config: Record<string, unknown>): WorkstreamForm {
  const match = obj(config.match);
  const git = obj(config.git);
  return {
    id: str(config.id),
    name: str(config.name),
    color: str(config.color),
    claim: config.claim === "exclusive" ? "exclusive" : "suggest",
    allowOverride: config.allowOverride !== false,
    share: config.share === "open" || config.share === "closed" ? config.share : "ask",
    abstract: config.abstract === true,
    extends: arr(config.extends).map(String).join(", "),
    paths: arr(match.paths).map(String).join("\n"),
    remotes: arr(match.remotes).map(String).join("\n"),
    servers: arr(config.mcpServers)
      .map((s) => (typeof s === "string" ? s : `${str(obj(s).server)}${obj(s).credential ? ` = ${str(obj(s).credential)}` : ""}`))
      .join("\n"),
    env: Object.entries(obj(config.env))
      .map(([k, v]) => `${k} = ${str(obj(v).secret)}`)
      .join("\n"),
    gitName: str(git.name),
    gitEmail: str(git.email),
  };
}

/**
 * What's wrong with the editor's text before it goes to the daemon (which
 * judges the rest): an env line without `NAME = credential`, a name twice, a
 * server line with more than one `=`. Undefined when fine.
 */
export function formProblem(form: WorkstreamForm): string | undefined {
  const seen = new Set<string>();
  for (const l of lines(form.env)) {
    const parts = l.split("=").map((s) => s.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) return `Env "${l}": write it as NAME = credential`;
    if (seen.has(parts[0])) return `Env ${parts[0]} is set twice`;
    seen.add(parts[0]);
  }
  for (const l of lines(form.servers)) {
    const parts = l.split("=").map((s) => s.trim());
    if (parts.length > 2 || !parts[0] || (parts.length === 2 && !parts[1])) return `Server "${l}": write it as server, or server = credential`;
  }
  return undefined;
}

/**
 * The item to save: the edited fields over `base` (the item as configured),
 * so fields the editor doesn't show (exclude, accounts, defaults, skillDirs)
 * are kept as they were. Empty optional fields are left out.
 */
export function fromForm(form: WorkstreamForm, base: Record<string, unknown> = {}): Record<string, unknown> {
  const item: Record<string, unknown> = { ...base, id: form.id.trim() };
  const set = (k: string, v: unknown, keep: boolean) => {
    if (keep) item[k] = v;
    else delete item[k];
  };
  set("name", form.name.trim(), form.name.trim().length > 0);
  set("color", form.color.trim(), form.color.trim().length > 0);
  item.claim = form.claim;
  item.allowOverride = form.allowOverride;
  item.share = form.share;
  item.abstract = form.abstract;
  item.extends = form.extends
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  item.match = form.abstract ? { paths: [], remotes: [] } : { paths: lines(form.paths), remotes: lines(form.remotes) };
  item.mcpServers = lines(form.servers).map((l) => {
    const [server, credential] = l.split("=").map((s) => s.trim());
    return credential ? { server, credential } : server;
  });
  item.env = Object.fromEntries(
    lines(form.env).map((l) => {
      const [name, secret] = l.split("=").map((s) => s.trim());
      return [name, { secret: secret ?? "" }];
    }),
  );
  const git = { ...(form.gitName.trim() ? { name: form.gitName.trim() } : {}), ...(form.gitEmail.trim() ? { email: form.gitEmail.trim() } : {}) };
  set("git", git, Object.keys(git).length > 0);
  return item;
}
