/**
 * Named credentials (docs/workstreams-design.md G2).
 *
 * `credentials[]` in config.json declares a credential: its id and what kind
 * of secret it is. Never the value — values live behind a SecretStore
 * (store.ts), so the config stays safe to show, diff and send to a satellite.
 *
 * Imports zod alone (config.ts imports this).
 */

import { z } from "zod";

const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const credentialIdSchema = z
  .string()
  .regex(ID, "a credential id is lowercase letters, digits and dashes (1–64), not starting or ending with a dash");

export const credentialDeclSchema = z.discriminatedUnion("kind", [
  /** A bearer token sent as `Authorization: Bearer …` to an MCP server. */
  z.object({ kind: z.literal("bearer"), id: credentialIdSchema, description: z.string().max(256).optional() }).strict(),
  /** A value sent in a named header to an MCP server (e.g. X-Api-Key). */
  z
    .object({
      kind: z.literal("header"),
      id: credentialIdSchema,
      header: z.string().regex(/^[A-Za-z0-9-]{1,128}$/, "a header name"),
      description: z.string().max(256).optional(),
    })
    .strict(),
  /** A value a workstream puts in its sessions' environment (GH_TOKEN, …). */
  z.object({ kind: z.literal("env"), id: credentialIdSchema, description: z.string().max(256).optional() }).strict(),
  /** A separate OAuth sign-in to one server, a slot beside its default one (§6.5 case 2). */
  z
    .object({ kind: z.literal("oauth"), id: credentialIdSchema, server: z.string().min(1).max(128), description: z.string().max(256).optional() })
    .strict(),
]);

export const credentialsSchema = z.array(credentialDeclSchema).max(512).default([]);

/** Where secret values are kept. Pluggable by deployment (G2). */
export const secretStoreSchema = z
  .discriminatedUnion("kind", [
    /** `CODEOID_CRED_<ID>` in the daemon's environment / `~/.codeoid/.env` (default; writable). */
    z.object({ kind: z.literal("env-file") }).strict(),
    /**
     * One file per credential in a directory, named by id — a mounted
     * Kubernetes Secret, a Vault agent's sink, a password manager's export.
     * Read-only: codeoid never writes there.
     */
    z.object({ kind: z.literal("dir"), path: z.string().min(1).max(4096) }).strict(),
  ])
  .default({ kind: "env-file" });

export type CredentialDecl = z.infer<typeof credentialDeclSchema>;
export type SecretStoreConfig = z.infer<typeof secretStoreSchema>;

/**
 * What every credential reference in the config must agree with: declared
 * once, and of a kind that fits where it is used. A workstream env var takes
 * an `env` credential; a server slot takes `bearer`, `header` or `oauth`, and
 * an `oauth` one only for the server it was declared for.
 */
export function credentialProblems(cfg: {
  credentials: readonly CredentialDecl[];
  workstreams: { items: ReadonlyArray<{ id: string; env: Record<string, { secret: string }>; mcpServers: ReadonlyArray<string | { server: string; credential?: string }> }> };
}): Array<{ message: string; path: (string | number)[] }> {
  const problems: Array<{ message: string; path: (string | number)[] }> = [];
  const byId = new Map<string, CredentialDecl>();
  cfg.credentials.forEach((c, i) => {
    if (byId.has(c.id)) problems.push({ message: `duplicate credential id "${c.id}"`, path: ["credentials", i, "id"] });
    else byId.set(c.id, c);
  });
  cfg.workstreams.items.forEach((w, i) => {
    for (const [name, ref] of Object.entries(w.env)) {
      const c = byId.get(ref.secret);
      if (!c) problems.push({ message: `workstream "${w.id}" env ${name} names undeclared credential "${ref.secret}"`, path: ["workstreams", "items", i, "env", name] });
      else if (c.kind !== "env") problems.push({ message: `workstream "${w.id}" env ${name}: credential "${c.id}" is a ${c.kind} credential, not env`, path: ["workstreams", "items", i, "env", name] });
    }
    w.mcpServers.forEach((ref, j) => {
      if (typeof ref === "string" || !ref.credential) return;
      const server = ref.server.startsWith("+") ? ref.server.slice(1) : ref.server;
      const c = byId.get(ref.credential);
      const at = ["workstreams", "items", i, "mcpServers", j];
      if (!c) problems.push({ message: `workstream "${w.id}" server ${server} names undeclared credential "${ref.credential}"`, path: at });
      else if (c.kind === "env") problems.push({ message: `workstream "${w.id}" server ${server}: credential "${c.id}" is an env credential`, path: at });
      else if (c.kind === "oauth" && c.server !== server) problems.push({ message: `workstream "${w.id}" server ${server}: oauth credential "${c.id}" is for server "${c.server}"`, path: at });
    });
  });
  return problems;
}
