/**
 * MessageRow — pure presentation of a single session message. Used both in
 * Static (for committed/historical messages) and in the live region (for
 * the currently-streaming message).
 *
 * Deliberately no wrapping decorations (no vertical rail, no border). Each
 * row is: role header line + indented content. This avoids the "rail only
 * renders on the first line" rendering bug that Ink can't solve cleanly
 * when content wraps, and it dodges frame-clear artifacts when streamed
 * content shrinks mid-render.
 */

import React from "react";
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { SessionMessage, ToolInfo, ToolRisk } from "../../protocol/types.js";
import { renderMarkdown, type Segment } from "../markdown.js";
import { computeDiff, truncateToolOutput } from "../diff.js";
import { fileUri, maybeLink } from "../osc8.js";
import { formatToolRisk, isBackgroundWake, parseBackgroundWake } from "@highflame/codeoid-core";

export interface MessageRowProps {
  msg: SessionMessage;
  /** When true, show a streaming indicator on the header line. */
  live?: boolean;
}

export function MessageRow({ msg, live }: MessageRowProps) {
  // The daemon's background wake is a user-role turn, but not the owner
  // speaking: show it as a compact list of finished tasks, not a wall of text.
  if (isBackgroundWake(msg)) return <BackgroundWakeRow content={msg.content} />;
  switch (msg.role) {
    case "user":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>
            You
            {msg.identity.name && msg.identity.name !== "codeoid-test" && (
              <Text color="cyan" dimColor>
                {` · ${msg.identity.name}`}
              </Text>
            )}
          </Text>
          <Box paddingLeft={2}>
            <Text>{msg.content}</Text>
          </Box>
          <AttachmentSummary metadata={msg.metadata} />
        </Box>
      );
    case "assistant":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="magenta" bold>
              Claude
            </Text>
            {live && (
              <Text dimColor>
                {" "}
                <LiveSpinner /> streaming
              </Text>
            )}
          </Box>
          {msg.content ? (
            <Box paddingLeft={2} flexDirection="column">
              <MarkdownBlock content={msg.content} />
            </Box>
          ) : null}
        </Box>
      );
    case "thinking":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="gray" bold>
              thinking
            </Text>
            {live && (
              <Text dimColor>
                {" "}
                <LiveSpinner />
              </Text>
            )}
          </Box>
          <Box paddingLeft={2}>
            <Text dimColor italic>
              {msg.content || "…"}
            </Text>
          </Box>
        </Box>
      );
    case "tool_call":
      return (
        <ToolRow tool={msg.tool} live={live} identity={msg.identity} />
      );
    case "tool_result":
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <Text color="green">→ result</Text>
          <Text dimColor>{truncateToolOutput(msg.content)}</Text>
        </Box>
      );
    case "system":
      return (
        <Box>
          <Text color="red">⚠ {msg.content}</Text>
        </Box>
      );
    case "info":
      return (
        <Box>
          <Text dimColor>{msg.content}</Text>
        </Box>
      );
  }
  return null;
}

// ── Attachments summary ────────────────────────────────────────────────────

function AttachmentSummary({ metadata }: { metadata: Record<string, unknown> | undefined }) {
  if (!metadata || !Array.isArray(metadata.attachments)) return null;
  const rows = metadata.attachments as Array<{
    path: string;
    pinned?: boolean;
    bytes?: number;
    error?: string;
    binary?: boolean;
    mimeType?: string;
  }>;
  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={0}>
      <Text dimColor>
        attached: {rows.length} file{rows.length === 1 ? "" : "s"}
      </Text>
      {rows.map((r) => {
        const isImage = r.binary && r.mimeType?.startsWith("image/");
        const icon = r.pinned ? "📌 " : isImage ? "🖼 " : r.binary ? "📎 " : "• ";
        return (
          <Text key={r.path} dimColor>
            {`   ${icon}`}
            {maybeLink(fileUri(r.path), r.path)}
            {r.binary && r.mimeType ? (
              <Text dimColor>{` (${r.mimeType})`}</Text>
            ) : null}
            {r.error ? <Text color="red">{` — ${r.error}`}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

// ── Tool-call rendering ────────────────────────────────────────────────────

function ToolRow({
  tool,
  live,
  identity,
}: {
  tool: ToolInfo | undefined;
  live?: boolean;
  identity?: import("../../protocol/types.js").MessageIdentity;
}) {
  if (!tool) return null;
  const isSubagent = identity?.type === "subagent";
  const phase = tool.state.phase;
  const phaseIcon =
    phase === "executing"
      ? "⋯"
      : phase === "completed"
        ? "✓"
        : phase === "waiting_confirmation"
          ? "?"
          : phase === "cancelled"
            ? "✗"
            : "•";
  const phaseColor =
    phase === "executing"
      ? "yellow"
      : phase === "completed"
        ? "green"
        : phase === "waiting_confirmation"
          ? "red"
          : phase === "cancelled"
            ? "gray"
            : "white";

  const input =
    "input" in tool.state ? (tool.state.input as Record<string, unknown>) : undefined;
  const filePath =
    typeof input?.file_path === "string" ? (input.file_path as string) : null;
  const isEdit = tool.name === "Edit" && input;
  const isWrite = tool.name === "Write" && input;
  const output =
    "output" in tool.state ? (tool.state as { output?: string }).output : undefined;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {isSubagent && identity && (
          <Text color="green" bold>
            {`[${identity.name ?? "subagent"}] `}
          </Text>
        )}
        <Text color={phaseColor}>
          {phaseIcon}
          {" "}
        </Text>
        <Text bold>{tool.name}</Text>
        {filePath && (
          <>
            <Text>{" "}</Text>
            <Text color="cyan">{maybeLink(fileUri(filePath), filePath)}</Text>
          </>
        )}
        {!filePath && input && (
          <Text dimColor>{` ${summarizeInput(input)}`}</Text>
        )}
        {live && phase === "executing" && (
          <Text dimColor>
            {" "}
            <LiveSpinner />
          </Text>
        )}
      </Box>
      {phase === "waiting_confirmation" && "description" in tool.state && (
        <Text color="red" dimColor>
          {(tool.state as { description: string }).description}
        </Text>
      )}
      {phase === "waiting_confirmation" && formatToolRisk((tool.state as { risk?: ToolRisk }).risk) && (
        <Text color={(tool.state as { risk?: ToolRisk }).risk?.level === "medium" ? "yellow" : "red"} bold>
          ▲ {formatToolRisk((tool.state as { risk?: ToolRisk }).risk)}
        </Text>
      )}
      {isEdit &&
        typeof input!.old_string === "string" &&
        typeof input!.new_string === "string" && (
          <DiffView
            oldStr={input!.old_string as string}
            newStr={input!.new_string as string}
          />
        )}
      {isWrite && typeof input!.content === "string" && (
        <WriteView content={input!.content as string} />
      )}
      {phase === "completed" && output && !isEdit && !isWrite && (
        <Box paddingLeft={2}>
          <Text dimColor>{truncateToolOutput(output)}</Text>
        </Box>
      )}
    </Box>
  );
}

function summarizeInput(input: Record<string, unknown>): string {
  for (const key of ["pattern", "command", "glob", "query", "text"]) {
    const v = input[key];
    if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  }
  return Object.keys(input).slice(0, 3).join(", ");
}

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const rows = computeDiff(oldStr, newStr);
  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {rows.map((r, i) => {
        const color =
          r.kind === "added" ? "green" : r.kind === "removed" ? "red" : undefined;
        const prefix = r.kind === "added" ? "+ " : r.kind === "removed" ? "- " : "  ";
        return (
          <Text key={i} color={color} dimColor={r.kind === "context"}>
            {prefix}
            {r.text}
          </Text>
        );
      })}
    </Box>
  );
}

function WriteView({ content }: { content: string }) {
  const lines = content.split("\n");
  const shown = lines.length > 40 ? lines.slice(0, 40) : lines;
  const trailing = lines.length > 40 ? ` (+ ${lines.length - 40} more lines)` : "";
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {shown.map((ln, i) => (
        <Text key={i} color="green">
          {"+ "}
          {ln}
        </Text>
      ))}
      {trailing && <Text dimColor>{trailing}</Text>}
    </Box>
  );
}

// ── Live spinner ────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function LiveSpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      80,
    );
    return () => clearInterval(id);
  }, []);
  return <Text color="yellow">{SPINNER_FRAMES[frame]}</Text>;
}

// ── Markdown rendering ─────────────────────────────────────────────────────

function MarkdownBlock({ content }: { content: string }) {
  if (!content) return null;
  const blocks = renderMarkdown(content);
  return (
    <Box flexDirection="column">
      {blocks.map((segments, i) => (
        <Box key={i}>{renderSegments(segments)}</Box>
      ))}
    </Box>
  );
}

function renderSegments(segments: Segment[]): React.ReactNode {
  if (segments.length === 1) {
    const seg = segments[0]!;
    switch (seg.style) {
      case "heading1":
        return (
          <Text color="cyan" bold>
            {"# "}
            {seg.text}
          </Text>
        );
      case "heading2":
        return (
          <Text color="cyan" bold>
            {"## "}
            {seg.text}
          </Text>
        );
      case "heading3":
        return (
          <Text color="cyan">
            {"### "}
            {seg.text}
          </Text>
        );
      case "code-block":
        return (
          <Text color="yellow" dimColor>
            {"│ "}
            {seg.text}
          </Text>
        );
      case "rule":
        return <Text dimColor>{"─".repeat(40)}</Text>;
      case "quote":
        return (
          <Text color="blue" dimColor>
            {"▌ "}
            {seg.text}
          </Text>
        );
    }
  }

  return (
    <Text>
      {segments.map((seg, i) => {
        const key = `${i}-${seg.style}`;
        switch (seg.style) {
          case "bold":
            return (
              <Text key={key} bold>
                {seg.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={key} italic>
                {seg.text}
              </Text>
            );
          case "code-inline":
            return (
              <Text key={key} color="yellow">
                {seg.text}
              </Text>
            );
          case "link":
            return (
              <Text key={key} color="cyan" underline>
                {seg.text}
              </Text>
            );
          case "list-bullet":
          case "list-number":
            return (
              <Text key={key}>
                {" ".repeat(seg.indent ?? 0)}
                <Text color="cyan">{seg.prefix ?? ""}</Text>
                {seg.text}
              </Text>
            );
          default:
            return <Text key={key}>{seg.text}</Text>;
        }
      })}
    </Text>
  );
}

function BackgroundWakeRow({ content }: { content: string }) {
  const tasks = parseBackgroundWake(content);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray" bold>
        Background
        <Text dimColor>{` · ${tasks.length === 1 ? "1 task" : `${tasks.length} tasks`} finished`}</Text>
      </Text>
      {tasks.map((t) => (
        <Box key={t.taskId} paddingLeft={2}>
          <Text color={t.status === "completed" ? "gray" : "red"}>{t.status.padEnd(9)}</Text>
          <Text dimColor>{`${t.taskId}  `}</Text>
          <Text wrap="truncate-end">{t.headline}</Text>
        </Box>
      ))}
    </Box>
  );
}
