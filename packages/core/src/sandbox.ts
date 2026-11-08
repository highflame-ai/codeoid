/**
 * How every frontend says whether a session's commands are sandboxed (#448):
 * the session header's badge, a one-line summary (CLI `ls`, Telegram), and
 * the approval card's line. Pure, plain strings; colours are each
 * frontend's.
 */

import type { SessionInfo, SessionSandboxInfo, ToolWaitingConfirmationState } from "@highflame/codeoid-protocol";

export type SandboxTone = "on" | "warn" | "off" | "neutral";

export interface SandboxBadge {
  /** Short: "sandboxed", "not sandboxed", "sandbox off", "no shell". */
  text: string;
  tone: SandboxTone;
  /** The longer explanation (a tooltip, a detail line). */
  title: string;
}

/** Why Docker access is a warning, wherever it is shown (a tooltip, a card). */
export const DOCKER_ACCESS_WHY = "Docker access can reach the whole machine (a container can mount /)";

/** What a session working in its home is told (the chip and its tooltip). */
export const HOME_WORKSPACE_LINE = "sandboxed: workspace is your home — only credentials are protected";

/**
 * What the sandbox reads and writes besides the workspace, in words (a
 * tooltip, a card): "reads ~/Workspace (read-only); also writes ~/Workspace/b".
 * Null when there is nothing beyond the workspace.
 */
export function sandboxDirsText(info: Pick<SessionSandboxInfo, "projectRoots" | "addedDirs" | "pendingDirs"> | undefined): string | null {
  if (!info) return null;
  const parts: string[] = [];
  if (info.projectRoots?.length) parts.push(`reads ${info.projectRoots.join(", ")} (read-only)`);
  if (info.addedDirs?.length) parts.push(`also writes ${info.addedDirs.join(", ")}`);
  const add = info.pendingDirs?.add ?? [];
  const remove = info.pendingDirs?.remove ?? [];
  if (add.length > 0 || remove.length > 0) {
    parts.push(`from the next turn: ${[...add.map((d) => `+${d}`), ...remove.map((d) => `−${d}`)].join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** The session header's badge. Null on a daemon without sandboxing. */
export function sandboxBadge(info: SessionSandboxInfo | undefined): SandboxBadge | null {
  if (!info) return null;
  switch (info.state) {
    case "on": {
      const net = info.networkRequested ? `network ${info.network} (asked: ${info.networkRequested})` : `network ${info.network}`;
      const dirs = sandboxDirsText(info);
      const limits = `${dirs ? `\nIt ${dirs}.` : ""}${info.limits?.length ? `\n${info.limits.map((l) => `• ${l}`).join("\n")}` : ""}`;
      if (info.homeWorkspace && !info.dockerSocket) {
        return {
          text: HOME_WORKSPACE_LINE,
          tone: "warn",
          title: `Sandboxed, but the workspace is your home: commands can read and change all of it but the credentials the sandbox hides. ${info.via ?? info.providerName ?? info.provider ?? "on"}, ${net}.${limits}`,
        };
      }
      if (info.dockerSocket) {
        return {
          text: info.enforced ? "sandboxed, Docker access" : "sandboxed partly, Docker access",
          tone: "warn",
          title: `Sandboxed, with Docker access: ${DOCKER_ACCESS_WHY}. ${info.via ?? info.providerName ?? info.provider ?? "on"}, ${net}.${limits}`,
        };
      }
      return {
        text: info.enforced ? "sandboxed" : "sandboxed, partly",
        tone: info.enforced ? "on" : "warn",
        title: `Sandboxed: ${info.via ?? info.providerName ?? info.provider ?? "on"}, ${net}.${limits}`,
      };
    }
    case "off":
      return { text: "sandbox off", tone: "off", title: `Not sandboxed: ${info.reason ?? "turned off"}. Commands run with your full rights.` };
    case "unavailable":
      return {
        text: "not sandboxed",
        tone: "warn",
        title: `Not sandboxed: ${info.reason ?? "the sandbox can't run here"}. Interactive work runs and every approval says so; autonomous sessions, routines and loops don't start.`,
      };
    default:
      return { text: "no shell", tone: "neutral", title: info.reason ?? "This backend runs no commands." };
  }
}

/** One line for a list (`codeoid ls`, Telegram): "sandbox: bubblewrap, network off". */
export function sandboxSummary(info: SessionSandboxInfo | undefined): string | null {
  if (!info) return null;
  switch (info.state) {
    case "on": {
      const net = info.networkRequested ? `network ${info.network} (asked ${info.networkRequested})` : `network ${info.network}`;
      const hosts = info.network === "allowlist" && info.allowedHosts?.length ? ` [${info.allowedHosts.join(", ")}]` : "";
      const dirs = sandboxDirsText(info);
      return `sandbox: ${info.providerName ?? info.provider}, ${net}${hosts}${info.dockerSocket ? ", Docker access (can reach the whole machine)" : ""}${info.homeWorkspace ? ", workspace is your home (only credentials are protected)" : ""}${dirs ? `; ${dirs}` : ""}${info.enforced ? "" : " — not everything asked is enforced"}`;
    }
    case "off":
      return "sandbox: off";
    case "unavailable":
      return `not sandboxed: ${info.reason ?? "the sandbox can't run here"}`;
    default:
      return "sandbox: not needed (runs no commands)";
  }
}

/**
 * One line for a list (`codeoid ls`) on a session's mode, when there's
 * something to say: autonomous (the sandbox is its boundary; what budget is
 * left), or guarded because the autonomous budget ran out. Null otherwise.
 */
export function modeSummary(s: Pick<SessionInfo, "mode" | "turnsRemaining" | "autonomousBudgetSpent" | "budgetExhausted">): string | null {
  if (s.budgetExhausted) return "mode: guarded — autonomous budget spent, this attempt ended";
  if (s.autonomousBudgetSpent) return "mode: guarded — autonomous budget spent: writes and commands will ask; raise the budget or switch back";
  if (s.mode !== "autonomous") return null;
  return s.turnsRemaining === undefined ? "mode: autonomous" : `mode: autonomous, ${s.turnsRemaining} tool call${s.turnsRemaining === 1 ? "" : "s"} left`;
}

/** The approval card's sandbox line, or null when the daemon said nothing of it. A sandbox with Docker access is a warning. */
export function approvalSandboxLine(state: Pick<ToolWaitingConfirmationState, "sandboxed" | "sandboxNote" | "sandboxDocker">): string | null {
  if (state.sandboxed === undefined && !state.sandboxNote) return null;
  if (state.sandboxDocker) {
    const note = state.sandboxNote ?? "sandboxed, Docker access";
    return `⚠️ ${note}${note.includes("Docker access") ? "" : " (the sandbox has Docker access)"}`;
  }
  if (state.sandboxed) return `🛡 ${state.sandboxNote ?? "sandboxed"}`;
  return `⚠️ ${state.sandboxNote ?? "not sandboxed"}`;
}

/** Whether the approval card's sandbox line is a warning (not sandboxed, or a sandbox with Docker access). */
export function approvalSandboxWarns(state: Pick<ToolWaitingConfirmationState, "sandboxed" | "sandboxDocker">): boolean {
  return !state.sandboxed || state.sandboxDocker === true;
}
