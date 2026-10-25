/**
 * The worker's one loop tool: `loop_report` — how an attempt says it is done
 * (§5). A structured report, never parsed prose; a report requests
 * verification and decides nothing.
 *
 * The server is bound to one worker session. Which attempt a report belongs to
 * is resolved when the tool is called, so a session that outlives an attempt
 * reports into whichever attempt is current, and a stale one is refused.
 */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { LOOP_LIMITS, type WorkerOutcome } from "./types.js";

export const LOOP_MCP_SERVER_NAME = "codeoid_loop";
export const LOOP_REPORT_TOOL = "loop_report";
/** The tool's full name as the Claude SDK exposes it. */
export const LOOP_REPORT_TOOL_FQ = `mcp__${LOOP_MCP_SERVER_NAME}__${LOOP_REPORT_TOOL}`;

export interface LoopReportInput {
  outcome: WorkerOutcome;
  summary: string;
  detail?: string;
}

/** Records a report for the session's current attempt. Returns the text the
 *  worker sees: an acknowledgement, or why the report was not taken. */
export type LoopReportSink = (sessionId: string, report: LoopReportInput) => string;

const DESCRIPTION = [
  "Report how this attempt ended. Call it exactly once, as your last action.",
  "- ready_for_verification: you believe the objective is met. The daemon then runs the run's checks itself; your report is not the verdict.",
  "- cannot_satisfy: the objective conflicts with a check or a constraint. Put the specific conflict and your evidence in `detail`. This is an acceptable outcome; editing a check to make it pass is not.",
  "- needs_input: only the user can decide something. Put the question in `detail`.",
].join("\n");

export function buildLoopMcpServer(sessionId: string, sink: LoopReportSink): McpSdkServerConfigWithInstance {
  const report = tool(
    LOOP_REPORT_TOOL,
    DESCRIPTION,
    {
      outcome: z.enum(["ready_for_verification", "cannot_satisfy", "needs_input"]),
      summary: z.string().min(1).max(LOOP_LIMITS.REPORT_SUMMARY_MAX).describe("What you did or concluded, briefly."),
      detail: z
        .string()
        .max(LOOP_LIMITS.REPORT_DETAIL_MAX)
        .optional()
        .describe("cannot_satisfy: the conflict and its evidence. needs_input: the question."),
    },
    async (args) => ({
      content: [{ type: "text" as const, text: sink(sessionId, args as LoopReportInput) }],
    }),
  );
  return createSdkMcpServer({ name: LOOP_MCP_SERVER_NAME, version: "0.1.0", tools: [report] });
}
