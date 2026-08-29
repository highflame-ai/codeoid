/**
 * Single transcript row. Role-aware styling, identity surfacing, optional
 * tool card, optional approval bar. Markdown for assistant messages
 * (P3 stub uses solid-markdown with shiki coming in P7).
 */

import { Component, Index, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import remarkGfm from "remark-gfm";

import { formatClock, formatDuration } from "../../lib/format";
import {
  identityColorClass,
  identityLabel,
  shortSub,
} from "../../lib/identity";
import { safeImageUri, safeLinkUri } from "../../lib/sanitize-url";
import {
  createFrameThrottled,
  splitStreamingBlocks,
} from "../../lib/streaming-markdown";
import { REASONING_UNAVAILABLE } from "../../protocol/types";
import type {
  MessageRole,
  SessionMessage,
  ToolState,
} from "../../protocol/types";
import { EditDiff, WriteFile, isEditInput, isWriteInput } from "./EditDiff";
import PartsView, { hasRichParts } from "./PartsView";

const ROLE_LABEL: Record<MessageRole, string> = {
  user: "you",
  assistant: "assistant",
  thinking: "reasoning",
  tool_call: "tool",
  tool_result: "tool output",
  system: "system",
  info: "info",
};

const ROLE_BORDER: Record<MessageRole, string> = {
  user: "border-l-role-user",
  assistant: "border-l-role-assistant",
  thinking: "border-l-role-thinking",
  tool_call: "border-l-role-tool",
  tool_result: "border-l-role-tool/60",
  system: "border-l-danger",
  info: "border-l-fg-faint",
};

const MessageRow: Component<{ msg: SessionMessage; streaming?: boolean }> = (props) => {
  const m = () => props.msg;
  const skip = () => isPlaceholder(m()) && !props.streaming;
  return (
    <Show when={!skip()}>
      <article
        data-message-id={m().messageId}
        class={`group rounded border-l-2 ${ROLE_BORDER[m().role]} bg-bg-elev/30 px-3 py-2 transition hover:bg-bg-elev/60`}
      >
        <Header msg={m()} />
        <Body msg={m()} streaming={props.streaming} />
      </article>
    </Show>
  );
};

const Header: Component<{ msg: SessionMessage }> = (props) => (
  <header class="mb-1 flex items-center gap-2 text-[11px]">
    <span
      class={`font-semibold uppercase tracking-wider ${roleColor(props.msg.role)}`}
    >
      {ROLE_LABEL[props.msg.role]}
    </span>
    <span
      class={`truncate font-mono text-fg-muted ${identityColorClass(props.msg.identity.type)}`}
      title={props.msg.identity.sub}
    >
      {identityLabel(props.msg.identity)}
    </span>
    <span class="ml-auto font-mono text-fg-faint">
      {formatClock(props.msg.timestamp)}
    </span>
  </header>
);

const Body: Component<{ msg: SessionMessage; streaming?: boolean }> = (props) => {
  const m = () => props.msg;
  return (
    <Switch fallback={<Plain text={m().content} />}>
      <Match when={m().role === "tool_call" && m().tool}>
        <ToolBlock msg={m()} />
      </Match>
      <Match when={m().role === "tool_result"}>
        <ToolResult msg={m()} />
      </Match>
      {/* Rich provider content (custom_message parts). Ordered after the
          tool arms (tool chrome wins) and before the role arms: a message
          whose parts carry more than the mirrored text block renders the
          parts; plain messages keep the streaming-optimized legacy paths. */}
      <Match when={hasRichParts(m().parts)}>
        <PartsView parts={m().parts!} sessionId={m().sessionId} messageId={m().messageId} />
      </Match>
      <Match when={m().role === "thinking"}>
        <ThinkingBlock text={m().content} streaming={props.streaming} />
      </Match>
      <Match when={m().role === "assistant"}>
        <MarkdownBlock text={m().content} streaming={props.streaming} />
      </Match>
      <Match when={m().role === "info"}>
        <InfoBlock msg={m()} />
      </Match>
      <Match when={m().role === "user" || m().role === "system"}>
        <Plain text={m().content} />
      </Match>
    </Switch>
  );
};

const Plain: Component<{ text: string }> = (props) => (
  <div class="whitespace-pre-wrap break-words text-sm text-fg">
    {props.text}
  </div>
);

const MarkdownBlock: Component<{ text: string; streaming?: boolean }> = (props) => {
  // #87: streaming markdown used to hand the WHOLE accumulated string to
  // SolidMarkdown on every delta — a full unified() re-parse plus a DOM
  // subtree rebuild per chunk, O(L²) over the stream. While streaming:
  //   1. coalesce delta-rate updates to one per animation frame, and
  //   2. render completed blocks once (<Index> keys by position — the list
  //      is append-only and positions never change value, so a completed
  //      block never re-parses, even when two blocks have identical text)
  //      and re-parse only the live tail, reconciling its DOM instead of
  //      rebuilding it.
  // When streaming ends the message renders as ONE document again, so the
  // final output is byte-identical to the non-streaming path.
  const throttled = createFrameThrottled(
    () => props.text,
    () => props.streaming === true,
  );
  const segments = createMemo(() =>
    props.streaming
      ? splitStreamingBlocks(throttled())
      : { blocks: [], tail: "", tailOpenFence: false },
  );
  return (
    <div class="md-prose">
      <Show when={props.streaming} fallback={<Md text={props.text} />}>
        <Index each={segments().blocks}>{(block) => <Md text={block()} />}</Index>
        {/* An open code fence mid-stream is the common coding-agent payload; a
            large one re-parsed as markdown every frame is O(L²). Render it as a
            plain <pre> while streaming — it becomes a styled/highlighted code
            block the instant the fence closes (or the message finalizes). */}
        <Show when={segments().tailOpenFence} fallback={<Md text={segments().tail} reconcile />}>
          <StreamingCodeTail text={segments().tail} />
        </Show>
      </Show>
      <Show when={props.streaming}>
        <span class="md-streaming-caret" aria-label="streaming" />
      </Show>
    </div>
  );
};

/** An in-progress fenced code block during streaming — rendered as plain text
 * (no markdown parse) so a large block doesn't re-parse every frame. Strips the
 * opening ```lang line so only the code shows. */
const StreamingCodeTail: Component<{ text: string }> = (props) => {
  const code = () => {
    const nl = props.text.indexOf("\n");
    return nl >= 0 ? props.text.slice(nl + 1) : "";
  };
  return (
    <pre class="overflow-x-auto whitespace-pre rounded bg-bg-elev/60 px-3 py-2 text-[13px] leading-relaxed">
      <code>{code()}</code>
    </pre>
  );
};

/** One markdown document — the shared SolidMarkdown configuration. */
const Md: Component<{ text: string; reconcile?: boolean }> = (props) => (
  <SolidMarkdown
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    remarkPlugins={[remarkGfm as any]}
    // Untrusted model output: allowlist link schemes (blocks javascript:/data:)
    // and drop remote image src (zero-click exfil). See lib/sanitize-url.
    transformLinkUri={safeLinkUri}
    transformImageUri={safeImageUri}
    renderingStrategy={props.reconcile ? "reconcile" : "memo"}
    children={props.text}
  />
);

/** Count lines without `split("\n")` — the split allocated an array of the
 * whole reasoning text's lines on every delta just to read `.length`. */
function countLines(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

const ThinkingBlock: Component<{ text: string; streaming?: boolean }> = (props) => {
  // Same remedy MarkdownBlock uses for #87: while the reasoning is streaming
  // (and the <details> is forced open), coalesce delta-rate updates to one
  // per animation frame instead of recomputing/re-rendering per chunk. When
  // streaming ends the throttle passes through, so the final render is
  // byte-identical to the non-streaming path.
  const throttled = createFrameThrottled(
    () => props.text,
    () => props.streaming === true,
  );
  /**
   * Whether there is real reasoning behind this block.
   *
   * Backends differ and both branches are normal: qwen-code and OSS models over
   * an OpenAI-compatible gateway stream plaintext reasoning, while Claude
   * returns readable text only under `thinking.display: "summarized"`. When
   * there is nothing, an expander is actively misleading — it advertises
   * content, counts "1 lines", and opens onto a placeholder. Render a flat
   * marker instead, so the thinking→answer rhythm still reads without
   * promising something that can't be shown.
   */
  const hasReasoning = createMemo(() => {
    const t = throttled().trim();
    return t.length > 0 && t !== REASONING_UNAVAILABLE;
  });
  const lineCount = createMemo(() => countLines(throttled()));
  return (
    <Show
      when={hasReasoning()}
      fallback={
        <div class="text-[12px] italic text-fg-faint" aria-label="reasoning unavailable">
          {REASONING_UNAVAILABLE}
        </div>
      }
    >
      <details class="text-[12px] italic text-role-thinking" open={props.streaming}>
        <summary class="cursor-pointer select-none text-fg-faint hover:text-fg-muted">
          reasoning ({lineCount()} {lineCount() === 1 ? "line" : "lines"})
          <Show when={props.streaming}>
            <span class="md-streaming-caret ml-1" aria-label="streaming" />
          </Show>
        </summary>
        <div class="mt-1 whitespace-pre-wrap pl-3">{throttled()}</div>
      </details>
    </Show>
  );
};

const ToolBlock: Component<{ msg: SessionMessage }> = (props) => {
  const t = () => props.msg.tool!;
  // Edit / Write get a dedicated diff renderer that survives across
  // phase transitions (waiting_confirmation → executing → completed).
  // The proposed change is the same artifact in every phase; what
  // changes is the surrounding chrome (approval pill before, "applied"
  // badge after). Keeping the diff as the body makes the message
  // legible without scrolling the user up to find the original input.
  const editInput = () => {
    const t0 = t();
    const fromState =
      t0.state.phase === "waiting_confirmation" ? t0.state.input : undefined;
    const candidate = t0.input ?? fromState;
    return isEditInput(candidate) ? candidate : null;
  };
  const writeInput = () => {
    const t0 = t();
    const fromState =
      t0.state.phase === "waiting_confirmation" ? t0.state.input : undefined;
    const candidate = t0.input ?? fromState;
    return isWriteInput(candidate) ? candidate : null;
  };
  return (
    <div class="space-y-1">
      <div class="flex items-center gap-2 font-mono text-xs">
        <span class="font-semibold text-role-tool">{t().name}</span>
        <PhaseBadge state={t().state} />
        <span class="ml-auto text-fg-faint">{shortSub(t().toolId)}</span>
      </div>
      <Show when={editInput()} fallback={
        <Show when={writeInput()} fallback={
          <ToolStateBody
            state={t().state}
            description={props.msg.content}
            toolName={t().name}
          />
        }>
          {(w) => <WriteFile input={w()} />}
        </Show>
      }>
        {(e) => <EditDiff input={e()} />}
      </Show>
      <Show
        when={
          (editInput() || writeInput()) &&
          t().state.phase === "completed" &&
          (t().state as { success: boolean }).success === false
        }
      >
        <div class="rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">
          edit failed —{" "}
          {(t().state as { output?: string }).output ?? "no error message"}
        </div>
      </Show>
    </div>
  );
};

/**
 * Waiting-confirmation body. For `ExitPlanMode` we make the plan
 * content the *primary* surface (markdown-rendered) — that's what the
 * user actually needs to read before approving. For every other tool
 * we show the description and a collapsible JSON view of the full
 * `input` so the user can audit exactly what the tool will do.
 */
const WaitingConfirmationBody: Component<{
  state: Extract<ToolState, { phase: "waiting_confirmation" }>;
  toolName: string;
}> = (props) => {
  const isPlanMode = () =>
    props.toolName === "ExitPlanMode" || props.toolName === "exit_plan_mode";
  const plan = () => {
    const input = props.state.input;
    if (input && typeof input === "object" && "plan" in input) {
      const p = (input as { plan: unknown }).plan;
      return typeof p === "string" ? p : null;
    }
    return null;
  };
  return (
    <Switch>
      <Match when={isPlanMode() && plan()}>
        <div class="rounded border border-accent/30 bg-accent/[0.04] p-3">
          <div class="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-accent">
            <span>📋</span>
            <span class="font-semibold">Proposed plan</span>
          </div>
          <MarkdownBlock text={plan()!} />
        </div>
      </Match>
      <Match when={!isPlanMode()}>
        <div class="space-y-1.5">
          <div class="rounded bg-bg-active/50 px-2 py-1.5 text-sm text-fg">
            {props.state.description}
          </div>
          <LazyJsonDetails value={props.state.input} />
        </div>
      </Match>
    </Switch>
  );
};

/**
 * Defer the `JSON.stringify` of a tool input until the `<details>` is
 * actually opened. The previous render shape ran a 10-100 KB stringify
 * (Write payloads, Bash outputs piped through input) on every parent
 * re-render even when the disclosure was closed — the disclosure is
 * mostly closed during normal use, so that's pure waste.
 */
const LazyJsonDetails: Component<{ value: unknown }> = (props) => {
  const [opened, setOpened] = createSignal(false);
  const json = createMemo(() => (opened() ? JSON.stringify(props.value, null, 2) : ""));
  return (
    <details
      class="text-[11px]"
      onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary class="cursor-pointer text-fg-faint hover:text-fg-muted">
        full input
      </summary>
      <Show when={opened()}>
        <pre class="mt-1 whitespace-pre-wrap break-words rounded border border-border bg-bg-active/40 p-2 font-mono text-[11px] text-fg-muted">
          {json()}
        </pre>
      </Show>
    </details>
  );
};

const PhaseBadge: Component<{ state: ToolState }> = (props) => {
  const phase = props.state.phase;
  const cls =
    phase === "completed"
      ? "border-success/40 text-success"
      : phase === "executing" || phase === "streaming"
        ? "border-warn/40 text-warn animate-pulse"
        : phase === "waiting_confirmation"
          ? "border-accent/40 text-accent"
          : phase === "cancelled"
            ? "border-danger/40 text-danger"
            : "border-border text-fg-faint";
  return (
    <span
      class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}
    >
      {phase.replace("_", " ")}
    </span>
  );
};

const ToolStateBody: Component<{
  state: ToolState;
  description: string;
  toolName: string;
}> = (props) => (
  <Switch fallback={<Plain text={props.description} />}>
    <Match when={props.state.phase === "waiting_confirmation"}>
      <WaitingConfirmationBody
        state={props.state as Extract<ToolState, { phase: "waiting_confirmation" }>}
        toolName={props.toolName}
      />
    </Match>
    <Match when={props.state.phase === "executing"}>
      <Show when={(props.state as { progress?: string }).progress}>
        <div class="text-xs text-fg-muted">
          {(props.state as { progress?: string }).progress}
        </div>
      </Show>
      <Show when={(props.state as { elapsedMs?: number }).elapsedMs}>
        <div class="text-[11px] font-mono text-fg-faint">
          {formatDuration((props.state as { elapsedMs: number }).elapsedMs)}
        </div>
      </Show>
    </Match>
    <Match when={props.state.phase === "completed"}>
      <Show when={(props.state as { output?: string }).output}>
        <CollapsibleOutput text={(props.state as { output: string }).output} />
      </Show>
    </Match>
    <Match when={props.state.phase === "cancelled"}>
      <div class="text-xs text-danger">
        cancelled — {(props.state as { reason: string }).reason}
        <Show when={(props.state as { message?: string }).message}>
          : {(props.state as { message?: string }).message}
        </Show>
      </div>
    </Match>
  </Switch>
);

const ToolResult: Component<{ msg: SessionMessage }> = (props) => (
  <div class="border-l-2 border-l-role-tool/40">
    <CollapsibleOutput text={props.msg.content} variant="result" />
  </div>
);

/**
 * Tool output renderer that collapses long output by default. Mirrors the
 * Claude Code VSCode extension's "show first N lines" behaviour so user/
 * assistant turns stay readable when the agent runs `find` over the repo
 * or dumps a 200-line cargo build. Click the footer to expand inline; the
 * full text is always copy-able regardless of state.
 */
const COLLAPSED_LINE_COUNT = 8;
const COLLAPSED_CHAR_BUDGET = 600;

const CollapsibleOutput: Component<{
  text: string;
  variant?: "tool" | "result";
}> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const text = () => props.text ?? "";
  const lines = createMemo(() => text().split("\n"));
  const totalLines = () => lines().length;
  const overLineLimit = () => totalLines() > COLLAPSED_LINE_COUNT;
  const overCharLimit = () => text().length > COLLAPSED_CHAR_BUDGET;
  const truncatable = () => overLineLimit() || overCharLimit();
  const collapsed = createMemo(() => {
    if (overLineLimit()) {
      return lines().slice(0, COLLAPSED_LINE_COUNT).join("\n");
    }
    if (overCharLimit()) {
      return text().slice(0, COLLAPSED_CHAR_BUDGET);
    }
    return text();
  });
  const hidden = () => totalLines() - COLLAPSED_LINE_COUNT;
  const bgClass = () => (props.variant === "result" ? "bg-bg-active/30" : "bg-bg-active/40");
  return (
    <div class={`overflow-hidden rounded ${bgClass()}`}>
      <pre
        class={`whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[12px] text-fg ${
          truncatable() && !expanded() ? "max-h-[14rem] overflow-hidden" : ""
        }`}
      >
        {expanded() || !truncatable() ? text() : collapsed()}
      </pre>
      <Show when={truncatable()}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded())}
          class="flex w-full items-center justify-between border-t border-border/40 bg-bg-active/20 px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-fg-muted transition hover:bg-bg-active/40 hover:text-fg"
        >
          <span>
            {expanded()
              ? "▴ collapse"
              : overLineLimit()
                ? `▾ show ${hidden()} more line${hidden() === 1 ? "" : "s"}`
                : `▾ show full output (${text().length} chars)`}
          </span>
          <span class="text-fg-faint">
            {totalLines()} line{totalLines() === 1 ? "" : "s"} · {text().length}b
          </span>
        </button>
      </Show>
    </div>
  );
};

const InfoBlock: Component<{ msg: SessionMessage }> = (props) => {
  const event = (props.msg.metadata?.["event"] as string | undefined) ?? "";
  const isIdentity = event === "identity.registered";
  return (
    <div
      class={`rounded border px-2 py-1.5 text-[12px] ${
        isIdentity
          ? "border-role-tool/40 bg-role-tool/5 text-role-tool"
          : "border-border bg-bg-active/30 text-fg-muted"
      }`}
    >
      <Show when={isIdentity}>
        <div class="mb-0.5 font-semibold uppercase tracking-wider">
          identity registered
        </div>
      </Show>
      <div class="font-mono text-[11px]">{props.msg.content}</div>
    </div>
  );
};

function roleColor(role: MessageRole): string {
  switch (role) {
    case "user":
      return "text-role-user";
    case "assistant":
      return "text-role-assistant";
    case "thinking":
      return "text-role-thinking";
    case "tool_call":
    case "tool_result":
      return "text-role-tool";
    case "system":
      return "text-danger";
    case "info":
    default:
      return "text-fg-faint";
  }
}

function isPlaceholder(m: SessionMessage): boolean {
  // Empty assistant placeholders mid-stream — daemon publishes these
  // before any deltas arrive. Worker row will indicate "thinking" instead.
  return (
    !m.content && (!m.parts || m.parts.length === 0) && !m.tool
  );
}

export default MessageRow;
