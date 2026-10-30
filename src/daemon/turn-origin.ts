/**
 * Whose a turn is (#430): a person acting for themselves (`user`), the agent
 * on its own (`agent`), or someone acting for another (`delegated`). After a
 * routine run ends, only the user's turns may run in its session.
 */
import type { AuthContext } from "../protocol/types.js";

export type TurnOrigin = "user" | "agent" | "delegated";

/**
 * A system sender (a wake, the budget) is the agent's own turn. A delegated
 * token (a routine's prompt, a teammate's share) or automation (MCP control)
 * acts for someone. Only a person's own token at depth 0 is the user.
 */
export function turnOrigin(sender: AuthContext): TurnOrigin {
  if (sender.sub === "system" || sender.sub.startsWith("system:")) return "agent";
  if (sender.delegationDepth > 0 || sender.automation === true) return "delegated";
  return "user";
}
