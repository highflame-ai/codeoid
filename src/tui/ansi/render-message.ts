/**
 * Pure ANSI renderer for `SessionMessage`. Turns one message into a
 * multi-line ANSI string ready to write to the terminal's scrollback.
 *
 * This is the string-producing analogue of `components/MessageRow.tsx`.
 * We keep the two in lockstep: every visual feature MessageRow renders
 * for live messages, this renders for finalized messages. The visual
 * languages must match so the user can't tell whether a message is
 * "still in the live region" or "already committed to scrollback" —
 * because transitioning between those states must be invisible.
 *
 * Architecture:
 *   - Pure: no side effects, no process.stdout writes, no state.
 *   - Deterministic: given the same input, returns the same bytes.
 *     This is what makes golden-file testing possible.
 *   - Wrap-aware: callers pass `cols`; long lines get soft-wrapped here
 *     rather than relying on the terminal's own wrap (which breaks OSC8
 *     hyperlinks and can confuse screen readers).
 *   - Color-respects: every style goes through `sgr()` which honors
 *     `NO_COLOR` and non-TTY automatically.
 */

import type {
	CollaborationCost,
	MessageIdentity,
	SessionInfo,
	SessionMessage,
	ToolInfo,
	ToolState,
} from "../../protocol/types.js";
import { formatCollaborationCost } from "@codeoid/core";
import { renderMarkdown, type Segment } from "../markdown.js";
import { computeDiff, truncateToolOutput } from "../diff.js";
import { fileUri, maybeLink } from "../osc8.js";
import {
	blue,
	bold,
	cyan,
	dim,
	gray,
	green,
	italic,
	magenta,
	red,
	resetAll,
	sgr,
	underline,
	wrapLine,
	yellow,
	type SgrKey,
} from "./codes.js";

export interface RenderOpts {
	/** Terminal columns — used for soft-wrap and horizontal rule widths. */
	cols: number;
}

/** Default indent for message bodies ("Claude\n  <content>"). */
const BODY_INDENT = "  ";

/**
 * Render a finalized `SessionMessage` as an ANSI string.
 *
 * The returned string ends with a single trailing newline — the writer
 * glues messages together without inserting separators. The renderer
 * itself manages vertical spacing (leading blank line before a header)
 * so the visual rhythm stays consistent whether we write one message or
 * 50 in a batch.
 */
export function renderMessage(msg: SessionMessage, opts: RenderOpts): string {
	switch (msg.role) {
		case "user":
			return renderUser(msg, opts);
		case "assistant":
			return renderAssistant(msg, opts);
		case "thinking":
			return renderThinking(msg, opts);
		case "tool_call":
			return renderToolCall(msg, opts);
		case "tool_result":
			return renderToolResult(msg);
		case "system":
			return renderSystem(msg);
		case "info":
			return renderInfo(msg);
		default:
			return "";
	}
}

/**
 * Header-only emit for a streaming message. Called by the writer on the
 * first delta of a stream — we want users to see "Claude" / "thinking"
 * before any body tokens arrive so the attribution is unambiguous.
 *
 * Returns the bytes the writer should hand to `console.log` (NO trailing
 * newline — `console.log` adds one). Returns "" for roles that don't
 * use a header (e.g. tool_call, which renders atomically).
 */
export function renderStreamHeader(
	role: SessionMessage["role"],
	identity: MessageIdentity | undefined,
): string {
	const subagentPrefix =
		identity?.type === "subagent"
			? green(bold(`[${identity.name ?? "subagent"}] `))
			: "";
	switch (role) {
		case "assistant":
			// Leading blank line keeps visual rhythm consistent with atomic
			// `renderMessage` output, which also starts with one.
			return `\n${subagentPrefix}${magenta(bold("Claude"))}`;
		case "thinking":
			return `\n${subagentPrefix}${gray(bold("thinking"))}`;
		case "user":
			return `\n${subagentPrefix}${cyan(bold("You"))}`;
		default:
			return "";
	}
}

/** Banner emitted when the user focuses a different session. */
export function renderSessionBanner(
	info: Pick<SessionInfo, "name" | "workdir">,
): string {
	const left = cyan(bold(`▾ ${info.name}`));
	const mid = dim("  @  ");
	const right = dim(info.workdir);
	// Leading newline so the banner is visually offset from prior content,
	// plus a trailing reset so no style bleeds into subsequent writes.
	return `\n${left}${mid}${right}${resetAll()}\n`;
}

// ── Role renderers ──────────────────────────────────────────────────────────

function renderUser(msg: SessionMessage, opts: RenderOpts): string {
	const header = cyan(bold("You"));
	const identitySuffix =
		msg.identity.name && msg.identity.name !== "codeoid-test"
			? dim(cyan(` · ${msg.identity.name}`))
			: "";
	const body = indentBlock(wrap(msg.content, opts.cols - BODY_INDENT.length));
	const attachments = renderAttachments(msg.metadata);
	return join([
		"", // leading blank line
		`${header}${identitySuffix}`,
		body,
		attachments,
	]);
}

function renderAssistant(msg: SessionMessage, opts: RenderOpts): string {
	const header = magenta(bold("Claude"));
	const body = msg.content
		? indentBlock(
				renderMarkdownAnsi(msg.content, opts.cols - BODY_INDENT.length),
			)
		: "";
	return join(["", header, body]);
}

function renderThinking(msg: SessionMessage, opts: RenderOpts): string {
	const header = gray(bold("thinking"));
	const content = msg.content || "…";
	const body = indentBlock(
		wrap(content, opts.cols - BODY_INDENT.length)
			.split("\n")
			.map((ln) => dim(italic(ln)))
			.join("\n"),
	);
	return join(["", header, body]);
}

function renderToolCall(msg: SessionMessage, opts: RenderOpts): string {
	const tool = msg.tool;
	if (!tool) return "";
	return renderToolRow(tool, msg.identity, opts);
}

function renderToolResult(msg: SessionMessage): string {
	const header = `${BODY_INDENT}${green("→ result")}`;
	const truncated = truncateToolOutput(msg.content);
	const body = truncated
		.split("\n")
		.map((ln) => `${BODY_INDENT}${dim(ln)}`)
		.join("\n");
	return join([header, body]);
}

function renderSystem(msg: SessionMessage): string {
	return `${red(`⚠ ${msg.content}`)}\n`;
}

function renderInfo(msg: SessionMessage): string {
	return `${dim(msg.content)}\n`;
}

// ── Tool row ────────────────────────────────────────────────────────────────

/**
 * Tool call row — mirrors `MessageRow.tsx`'s ToolRow component for finalized
 * tool calls. Shape:
 *
 *   [subagent?] <icon> <ToolName> <file | summary>
 *       <description?>     (waiting_confirmation)
 *       <diff | write-view | truncated-output>  (if applicable)
 */
function renderToolRow(
	tool: ToolInfo,
	identity: MessageIdentity | undefined,
	opts: RenderOpts,
): string {
	const phase = tool.state.phase;
	const phaseIcon = iconForPhase(phase);
	const phaseColor = colorForPhase(phase);

	const input =
		"input" in tool.state
			? (tool.state.input as Record<string, unknown>)
			: undefined;
	const filePath =
		typeof input?.file_path === "string"
			? (input.file_path as string)
			: null;
	const isEdit = tool.name === "Edit" && input;
	const isWrite = tool.name === "Write" && input;
	const output =
		"output" in tool.state
			? (tool.state as { output?: string }).output
			: undefined;

	const subagentPrefix =
		identity?.type === "subagent"
			? green(bold(`[${identity.name ?? "subagent"}] `))
			: "";

	const iconPart = sgr(`${phaseIcon} `, phaseColor);
	const nameBold = bold(tool.name);

	let headerTrailing = "";
	if (filePath) {
		headerTrailing = ` ${cyan(maybeLink(fileUri(filePath), filePath))}`;
	} else if (input) {
		headerTrailing = ` ${dim(summarizeInput(input))}`;
	}

	const headerLine = `${subagentPrefix}${iconPart}${nameBold}${headerTrailing}`;

	const lines: string[] = ["", headerLine];

	if (phase === "waiting_confirmation" && "description" in tool.state) {
		const description = (tool.state as { description: string }).description;
		lines.push(dim(red(description)));
		// A send-class fleet dispatch carries the goal's running spend. Same
		// shared formatter as the web bar and Telegram, so the owner reads the
		// same number in the same words wherever they approve from.
		const cost = (tool.state as { collaborationCost?: CollaborationCost })
			.collaborationCost;
		if (cost) lines.push(dim(`  \u25c7 ${formatCollaborationCost(cost)}`));
	}

	if (isEdit) {
		const oldStr = input!.old_string;
		const newStr = input!.new_string;
		if (typeof oldStr === "string" && typeof newStr === "string") {
			lines.push(renderDiff(oldStr, newStr, opts.cols));
		}
	} else if (isWrite) {
		const content = input!.content;
		if (typeof content === "string") {
			lines.push(renderWriteView(content, opts.cols));
		}
	} else if (phase === "completed" && output) {
		lines.push(
			truncateToolOutput(output)
				.split("\n")
				.map((ln) => `${BODY_INDENT}${dim(ln)}`)
				.join("\n"),
		);
	}

	return join(lines);
}

function iconForPhase(phase: ToolState["phase"]): string {
	switch (phase) {
		case "executing":
			return "⋯";
		case "completed":
			return "✓";
		case "waiting_confirmation":
			return "?";
		case "cancelled":
			return "✗";
		default:
			return "•";
	}
}

function colorForPhase(phase: ToolState["phase"]): SgrKey {
	switch (phase) {
		case "executing":
			return "yellow";
		case "completed":
			return "green";
		case "waiting_confirmation":
			return "red";
		case "cancelled":
			return "gray";
		default:
			return "white";
	}
}

function summarizeInput(input: Record<string, unknown>): string {
	for (const key of ["pattern", "command", "glob", "query", "text"]) {
		const v = input[key];
		if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 57)}…` : v;
	}
	return Object.keys(input).slice(0, 3).join(", ");
}

function renderDiff(oldStr: string, newStr: string, cols: number): string {
	const rows = computeDiff(oldStr, newStr);
	if (rows.length === 0) return "";
	const out: string[] = [];
	const contentCols = Math.max(10, cols - BODY_INDENT.length - 2);
	for (const r of rows) {
		const prefix =
			r.kind === "added" ? "+ " : r.kind === "removed" ? "- " : "  ";
		const lineText = r.text;
		const wrapped = wrapLine(lineText, contentCols);
		for (const ln of wrapped) {
			const body = `${prefix}${ln}`;
			const styled =
				r.kind === "added"
					? green(body)
					: r.kind === "removed"
						? red(body)
						: dim(body);
			out.push(`${BODY_INDENT}${styled}`);
		}
	}
	return out.join("\n");
}

function renderWriteView(content: string, cols: number): string {
	const lines = content.split("\n");
	const shown = lines.length > 40 ? lines.slice(0, 40) : lines;
	const trailing =
		lines.length > 40 ? ` (+ ${lines.length - 40} more lines)` : "";
	const contentCols = Math.max(10, cols - BODY_INDENT.length - 2);
	const out: string[] = [];
	for (const ln of shown) {
		const wrapped = wrapLine(ln, contentCols);
		for (const w of wrapped) {
			out.push(`${BODY_INDENT}${green(`+ ${w}`)}`);
		}
	}
	if (trailing) {
		out.push(`${BODY_INDENT}${dim(trailing)}`);
	}
	return out.join("\n");
}

// ── Attachments ─────────────────────────────────────────────────────────────

function renderAttachments(
	metadata: Record<string, unknown> | undefined,
): string {
	if (!metadata || !Array.isArray(metadata.attachments)) return "";
	const rows = metadata.attachments as Array<{
		path: string;
		pinned?: boolean;
		bytes?: number;
		error?: string;
		binary?: boolean;
		mimeType?: string;
	}>;
	if (rows.length === 0) return "";
	const header = `${BODY_INDENT}${dim(
		`attached: ${rows.length} file${rows.length === 1 ? "" : "s"}`,
	)}`;
	const rowLines = rows.map((r) => {
		const isImage = r.binary && r.mimeType?.startsWith("image/");
		const icon = r.pinned ? "📌 " : isImage ? "🖼 " : r.binary ? "📎 " : "• ";
		const path = maybeLink(fileUri(r.path), r.path);
		const mime = r.binary && r.mimeType ? ` (${r.mimeType})` : "";
		const err = r.error ? `${red(` — ${r.error}`)}` : "";
		return `${BODY_INDENT}   ${dim(icon + path + mime)}${err}`;
	});
	return [header, ...rowLines].join("\n");
}

// ── Markdown ────────────────────────────────────────────────────────────────

/**
 * Render markdown content as an ANSI string. Mirrors `MessageRow.tsx`'s
 * `MarkdownBlock` + `renderSegments` — same palette, same prefixes — so
 * live streams and finalized messages look identical.
 */
function renderMarkdownAnsi(md: string, cols: number): string {
	const blocks = renderMarkdown(md);
	const out: string[] = [];
	for (const segments of blocks) {
		// Block-level segments (headings, rules, code blocks, quotes) are
		// single-entry arrays with a specific style. Multi-segment arrays are
		// inline runs — render them joined.
		if (segments.length === 1) {
			const seg = segments[0]!;
			const line = blockLineForSingleton(seg, cols);
			if (line !== null) {
				out.push(line);
				continue;
			}
		}
		// Inline run — combine segments into a single styled line.
		out.push(renderInlineRun(segments, cols));
	}
	return out.join("\n");
}

function blockLineForSingleton(seg: Segment, cols: number): string | null {
	switch (seg.style) {
		case "heading1":
			return cyan(bold(`# ${seg.text}`));
		case "heading2":
			return cyan(bold(`## ${seg.text}`));
		case "heading3":
			return cyan(`### ${seg.text}`);
		case "code-block": {
			const prefix = "│ ";
			const wrapped = wrapLine(seg.text, Math.max(10, cols - prefix.length));
			return wrapped.map((ln) => dim(yellow(`${prefix}${ln}`))).join("\n");
		}
		case "rule":
			return dim("─".repeat(Math.min(40, Math.max(0, cols))));
		case "quote":
			return dim(blue(`▌ ${seg.text}`));
		default:
			return null;
	}
}

function renderInlineRun(segments: Segment[], cols: number): string {
	let head = "";
	let body = "";
	for (const seg of segments) {
		switch (seg.style) {
			case "list-bullet":
			case "list-number": {
				const indent = " ".repeat(seg.indent ?? 0);
				head = `${indent}${cyan(seg.prefix ?? "")}`;
				break;
			}
			case "bold":
				body += bold(seg.text);
				break;
			case "italic":
				body += italic(seg.text);
				break;
			case "code-inline":
				body += yellow(seg.text);
				break;
			case "link":
				body += underline(cyan(seg.text));
				break;
			default:
				body += seg.text;
		}
	}
	const full = `${head}${body}`;
	// Wrap long runs. For list continuation lines we indent by the head width
	// so wrapped text aligns under the first visible char of the item body.
	const available = Math.max(10, cols - 1);
	const wrapped = wrapLine(full, available);
	if (wrapped.length <= 1) return full;
	return wrapped.join("\n");
}

// ── Utilities ───────────────────────────────────────────────────────────────

/**
 * Indent every line of `text` with the standard body indent. Keeps blank
 * lines blank (don't pad them — it makes the diff output cleaner in tests).
 */
function indentBlock(text: string): string {
	if (!text) return "";
	return text
		.split("\n")
		.map((ln) => (ln.length ? BODY_INDENT + ln : ln))
		.join("\n");
}

/** Soft-wrap plain text for the body column. */
function wrap(text: string, cols: number): string {
	if (cols <= 0) return text;
	const out: string[] = [];
	for (const ln of text.split("\n")) {
		const wrapped = wrapLine(ln, cols);
		for (const w of wrapped) out.push(w);
	}
	return out.join("\n");
}

/**
 * Join parts with newlines, skipping empties. Always ends with a single
 * trailing newline so writers can concatenate messages without tracking
 * state. Filters out stray empty blocks while preserving explicit `""`
 * entries that callers include to force a leading blank line.
 */
function join(parts: Array<string | null | undefined>): string {
	const kept: string[] = [];
	for (const p of parts) {
		if (p === null || p === undefined) continue;
		// Drop ONLY "totally-nothing" tails; keep explicit "" (leading blank).
		kept.push(p);
	}
	// Trim trailing empties (no dangling blank lines at EOM).
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	return `${kept.join("\n")}\n`;
}
