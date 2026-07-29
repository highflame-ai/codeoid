/**
 * Identity helpers — provenance labelling lives in `@highflame/codeoid-core` (shared
 * with the TUI and mobile); only the Tailwind colour mapping is web-local.
 */
import type { IdentityType } from "../protocol/types";

export {
  identityLabel,
  sessionAgentLabel,
  shortSub,
  truncateWimseUri,
} from "@highflame/codeoid-core";

/** Tailwind classes for the role pill — match the TUI palette intent. */
export function roleColorClass(role: string): string {
  switch (role) {
    case "user":
      return "text-role-user";
    case "assistant":
      return "text-role-assistant";
    case "tool_call":
    case "tool_result":
      return "text-role-tool";
    case "thinking":
      return "text-role-thinking";
    case "system":
      return "text-danger";
    case "info":
    default:
      return "text-fg-faint";
  }
}

/** Tailwind classes for an identity type — applied to the identity name. */
export function identityColorClass(type: IdentityType | null | undefined): string {
  switch (type) {
    case "human":
      return "text-role-user";
    case "agent":
      return "text-role-assistant";
    case "subagent":
      return "text-role-tool";
    case "system":
      return "text-fg-faint";
    default:
      return "text-fg-muted";
  }
}
