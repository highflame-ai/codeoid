/**
 * The `workstreams` config block (docs/workstreams-design.md §4).
 *
 * A workstream is a named line of work: a set of folders plus the servers,
 * credentials, accounts and models its sessions get. The shape is zod; the
 * rules across items (unique ids, `extends` resolving and acyclic, `default`
 * real) are `workstreamsProblems`, run as a refinement so a bad block fails the
 * config load loudly, like every other malformed setting. Rules that need the
 * rest of the config (server and credential names) are checked where both are
 * known (W1).
 *
 * Imports zod, the pure matcher and the env denylist alone: `src/config.ts`
 * imports this, so anything heavier here would be pulled into every CLI start.
 */

import { z } from "zod";
import { extraEnvViolations } from "../providers/env.js";
import { normalizePathRule } from "./match.js";

/** Ids a config may not use: they name a home the daemon assigns itself. */
export const RESERVED_WORKSTREAM_IDS = ["conductor"] as const;

const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const workstreamIdSchema = z
  .string()
  .regex(ID, "a workstream id is lowercase letters, digits and dashes (1–64), not starting or ending with a dash")
  .refine((id) => !(RESERVED_WORKSTREAM_IDS as readonly string[]).includes(id), {
    message: `reserved workstream id (${RESERVED_WORKSTREAM_IDS.join(", ")})`,
  });

/** A path rule: a glob over absolute paths, `~` expanded. Matches the folder
 *  it names and everything below it. */
const pathRuleSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => p.startsWith("/") || p === "~" || p.startsWith("~/"), {
    message: "a path rule is absolute or starts with ~/",
  })
  .refine((p) => !/(^|\/)\.\.(\/|$)/.test(p), { message: "a path rule may not contain .." });

/** A remote rule: a glob over a normalised git remote, `host/owner/repo`. */
const remoteRuleSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((r) => !r.includes("://") && !r.includes("@") && !r.startsWith("/"), {
    message: "a remote rule is host/owner/repo (a glob), without a scheme or user, e.g. github.com/acme/*",
  });

/** A server a workstream selects: by name, or by name with a credential slot
 *  (§6.5 case 2, applied in W1). `+name` in an extending workstream reads the
 *  same as `name`; the prefix is accepted so a list reads as an addition. */
const serverRefSchema = z.union([
  z.string().min(1).max(128),
  z
    .object({
      server: z.string().min(1).max(128),
      credential: z.string().min(1).max(64).optional(),
    })
    .strict(),
]);

/** An env value is always a reference to a named credential, never inline (§4). */
const envRefSchema = z.object({ secret: z.string().min(1).max(64) }).strict();

/**
 * A name a workstream may set: one an agent's backend would accept from any
 * daemon caller (providers/env.ts) — never a credential, account, proxy or
 * code-loading variable codeoid owns (ANTHROPIC_*, PATH, LD_*, …). Refused at
 * load, so a session never fails to start over it.
 */
function envNameProblem(name: string): string | undefined {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) return "an env var name is upper-case letters, digits and underscores";
  if (extraEnvViolations({ [name]: "x" }).length > 0) {
    return "codeoid owns this variable for the backend (credentials, accounts, proxies, what runs): a workstream can't set it";
  }
  return undefined;
}

export const workstreamItemSchema = z
  .object({
    id: workstreamIdSchema,
    name: z.string().min(1).max(128).optional(),
    color: z.string().min(1).max(32).optional(),
    /** A base: no folders, no sessions of its own, only something to extend (§6.5). */
    abstract: z.boolean().default(false),
    extends: z.array(workstreamIdSchema).max(16).default([]),
    match: z
      .object({
        paths: z.array(pathRuleSchema).max(256).default([]),
        remotes: z.array(remoteRuleSchema).max(256).default([]),
      })
      .strict()
      .default({ paths: [], remotes: [] }),
    /** `exclusive`: the folders run only with this workstream's identity unless
     *  overridden (§5.2). `suggest`: the folder only pre-selects it. */
    claim: z.enum(["exclusive", "suggest"]).default("suggest"),
    /** `false` makes an override of an exclusive claim unavailable (§5.2). */
    allowOverride: z.boolean().default(true),
    /** Whether other workstreams may reference this one (§7.1). */
    share: z.enum(["open", "ask", "closed"]).default("ask"),
    mcpServers: z.array(serverRefSchema).max(256).default([]),
    /** Names (from the lists above, after `extends`) taken away again. */
    exclude: z.array(z.string().min(1).max(128)).max(256).default([]),
    /** Default account per backend id. */
    accounts: z.record(z.string().min(1).max(64), z.string().min(1).max(64)).default({}),
    defaults: z
      .object({
        provider: z.string().min(1).max(64).optional(),
        model: z.string().min(1).max(256).optional(),
        effort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
      })
      .strict()
      .default({}),
    // Names checked in the refinement below: a record key's own refinement
    // reaches the user only as "Invalid key in record".
    env: z.record(z.string(), envRefSchema).default({}),
    git: z
      .object({
        name: z.string().min(1).max(256).optional(),
        email: z.string().min(3).max(256).optional(),
      })
      .strict()
      .optional(),
    skillDirs: z.array(pathRuleSchema).max(64).default([]),
  })
  .strict()
  .refine((w) => !w.abstract || (w.match.paths.length === 0 && w.match.remotes.length === 0), {
    message: "an abstract (base) workstream has no match rules",
    path: ["match"],
  })
  .superRefine((w, ctx) => {
    for (const name of Object.keys(w.env)) {
      const problem = envNameProblem(name);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name}: ${problem}`, path: ["env", name] });
    }
  });

export const workstreamsSchema = z
  .object({
    /**
     * Off (default): every session keeps today's servers, whatever its
     * workstream. On: a session gets only what its workstream selects
     * (§6.1). Enforcement arrives in W1; until then this is recorded only.
     */
    isolateGlobalServers: z.boolean().default(false),
    /** Home for a session nothing matches. Absent = such a session has none (§5.1). */
    default: workstreamIdSchema.optional(),
    items: z.array(workstreamItemSchema).max(128).default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    for (const problem of workstreamsProblems(cfg)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem.message, path: problem.path });
    }
  })
  .default({ isolateGlobalServers: false, items: [] });

/**
 * Rules across items, which zod's per-item shape can't see: ids unique,
 * `extends` naming existing workstreams without a cycle, `default` naming a
 * real (non-base) workstream, and no rule written identically in two
 * workstreams (a guaranteed tie). Ties between DIFFERENT rules that happen to
 * match the same folder can only be found against real folders; those are
 * reported at resolution, as ambiguous.
 */
export function workstreamsProblems(cfg: {
  default?: string;
  items: ReadonlyArray<{ id: string; abstract: boolean; extends: readonly string[]; match: { paths: readonly string[]; remotes: readonly string[] } }>;
}): Array<{ message: string; path: (string | number)[] }> {
  const problems: Array<{ message: string; path: (string | number)[] }> = [];
  const byId = new Map<string, number>();
  cfg.items.forEach((item, i) => {
    if (byId.has(item.id)) problems.push({ message: `duplicate workstream id "${item.id}"`, path: ["items", i, "id"] });
    else byId.set(item.id, i);
  });
  cfg.items.forEach((item, i) => {
    item.extends.forEach((base, j) => {
      if (base === item.id) problems.push({ message: `workstream "${item.id}" extends itself`, path: ["items", i, "extends", j] });
      else if (!byId.has(base)) problems.push({ message: `workstream "${item.id}" extends unknown workstream "${base}"`, path: ["items", i, "extends", j] });
    });
  });
  // Cycle: depth-first over `extends`, reporting each cycle once at the item that closes it.
  const state = new Map<string, "open" | "done">();
  const visit = (id: string, trail: string[]): void => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "open") {
      const at = byId.get(id) ?? 0;
      problems.push({ message: `workstream extends cycle: ${[...trail.slice(trail.indexOf(id)), id].join(" → ")}`, path: ["items", at, "extends"] });
      return;
    }
    state.set(id, "open");
    const item = cfg.items[byId.get(id) ?? -1];
    for (const base of item?.extends ?? []) if (byId.has(base) && base !== id) visit(base, [...trail, id]);
    state.set(id, "done");
  };
  for (const item of cfg.items) visit(item.id, []);
  if (cfg.default !== undefined) {
    const i = byId.get(cfg.default);
    if (i === undefined) problems.push({ message: `default workstream "${cfg.default}" is not defined`, path: ["default"] });
    else if (cfg.items[i].abstract) problems.push({ message: `default workstream "${cfg.default}" is a base (abstract) workstream`, path: ["default"] });
  }
  const seen = new Map<string, string>();
  cfg.items.forEach((item, i) => {
    for (const [kind, rules] of [
      ["path", item.match.paths],
      ["remote", item.match.remotes],
    ] as const) {
      rules.forEach((rule, j) => {
        // Compared as matched: `~/x`, `~/x/` and `~/x/**` are one rule; remotes are case-insensitive.
        const norm = kind === "path" ? normalizePathRule(rule) : rule.toLowerCase();
        const key = `${kind}\u0000${norm}`;
        const other = seen.get(key);
        if (other !== undefined && other !== item.id) {
          problems.push({ message: `${kind} rule "${rule}" is in both "${other}" and "${item.id}"`, path: ["items", i, "match", kind === "path" ? "paths" : "remotes", j] });
        } else seen.set(key, item.id);
      });
    }
  });
  return problems;
}

export type WorkstreamItemConfig = z.infer<typeof workstreamItemSchema>;
export type WorkstreamsConfig = z.infer<typeof workstreamsSchema>;
export type WorkstreamServerRef = z.infer<typeof serverRefSchema>;
