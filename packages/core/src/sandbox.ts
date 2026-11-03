/**
 * How every frontend says whether a session's commands are sandboxed (#448):
 * the session header's badge, a one-line summary (CLI `ls`, Telegram), and
 * the approval card's line. Pure, plain strings; colours are each
 * frontend's.
 */

import type { SessionSandboxInfo, ToolWaitingConfirmationState } from "@highflame/codeoid-protocol";

export type SandboxTone = "on" | "warn" | "off" | "neutral";

export interface SandboxBadge {
  /** Short: "sandboxed", "not sandboxed", "sandbox off", "no shell". */
  text: string;
  tone: SandboxTone;
  /** The longer explanation (a tooltip, a detail line). */
  title: string;
}

/** The session header's badge. Null on a daemon without sandboxing. */
export function sandboxBadge(info: SessionSandboxInfo | undefined): SandboxBadge | null {
  if (!info) return null;
  switch (info.state) {
    case "on": {
      const net = info.networkRequested ? `network ${info.network} (asked: ${info.networkRequested})` : `network ${info.network}`;
      const limits = info.limits?.length ? `\n${info.limits.map((l) => `• ${l}`).join("\n")}` : "";
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
      return `sandbox: ${info.providerName ?? info.provider}, ${net}${hosts}${info.enforced ? "" : " — not everything asked is enforced"}`;
    }
    case "off":
      return "sandbox: off";
    case "unavailable":
      return `not sandboxed: ${info.reason ?? "the sandbox can't run here"}`;
    default:
      return "sandbox: not needed (runs no commands)";
  }
}

/** The approval card's sandbox line, or null when the daemon said nothing of it. */
export function approvalSandboxLine(state: Pick<ToolWaitingConfirmationState, "sandboxed" | "sandboxNote">): string | null {
  if (state.sandboxed === undefined && !state.sandboxNote) return null;
  if (state.sandboxed) return `🛡 ${state.sandboxNote ?? "sandboxed"}`;
  return `⚠️ ${state.sandboxNote ?? "not sandboxed"}`;
}
