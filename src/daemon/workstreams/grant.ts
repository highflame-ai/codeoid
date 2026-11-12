/**
 * What a session's home workstream lets it reach over MCP, under isolation
 * (docs/workstreams-design.md §6.1, G1).
 *
 * A grant exists only while `workstreams.isolateGlobalServers` is on. With
 * none, every session keeps today's servers. With one:
 *  - a built-in server (memory, fleet, blackboard, …) always reaches it;
 *  - any other server reaches it only if the home selects it by name;
 *  - the folder's own servers (Claude's per-folder entries, an approved
 *    `.mcp.json`) only when the folder is the home's — not for a session
 *    homed there by override;
 *  - no home, a reserved one (the conductor's) or an orphaned one: built-ins
 *    only.
 */

/** A selected server's named credential, by reference. */
export interface GrantCredential {
  id: string;
  /** Absent = `Authorization: Bearer`. */
  header?: string;
}

export interface McpGrant {
  /** The home, for messages. */
  workstream?: string;
  /** Servers the home selects, by name. */
  servers: ReadonlyMap<string, { credential?: GrantCredential; oauthSlot?: string }>;
  /** The folder's own servers apply. */
  workdirServers: boolean;
}

/**
 * Why a server is not (or no longer) reachable under `grant`; undefined = it
 * is. The same rule the session's view lists by (session-view.ts applyGrant).
 */
export function grantRefusal(grant: McpGrant | undefined, spec: { name: string; builtin: boolean; origin?: string; transport: { credential?: { id: string } } | { kind: string } }): string | undefined {
  if (!grant || spec.builtin) return undefined;
  const name = spec.name;
  if (spec.origin === "claude-local" || spec.origin === "claude-repo") {
    return grant.workdirServers ? undefined : `MCP server "${name}" is this folder's own, and the folder isn't workstream "${grant.workstream ?? "none"}"'s`;
  }
  const sel = grant.servers.get(name);
  const cred = "credential" in spec.transport ? spec.transport.credential : undefined;
  const same = sel?.oauthSlot ? cred?.id === sel.oauthSlot : (sel?.credential?.id === cred?.id && (sel?.credential?.header ?? "") === (cred && "header" in cred ? (cred.header ?? "") : ""));
  if (sel && same) return undefined;
  if (sel) return `MCP server "${name}" is now called with another credential in workstream "${grant.workstream}" — it applies from the next turn`;
  return grant.workstream
    ? `MCP server "${name}" is not in workstream "${grant.workstream}"`
    : `MCP server "${name}" is not available to a session with no workstream`;
}
