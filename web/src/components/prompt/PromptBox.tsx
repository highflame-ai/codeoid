/**
 * Multi-line prompt with persistent drafts. Enter sends; Shift+Enter
 * inserts a newline; Ctrl+Enter also sends (common alt). Slash commands
 * starting with `/` are intercepted client-side: `/new`, `/rename`,
 * `/destroy`, `/rotate`, `/interrupt`, `/mode`, `/model`. Everything else
 * goes to the daemon as a `session.send`.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { ensureCommands, isProviderCommand } from "../../state/commands";
import { newRequestId, request, send } from "../../state/connection";
import {
  clearDraft,
  getDraft,
  setDraft,
} from "../../state/prompt-drafts";
import {
  focusedSession,
  focusedSessionId,
  focusSession,
  mergeSession,
  removeSession,
} from "../../state/sessions";
import { openCapabilitiesDrawer } from "../CapabilitiesDrawer";
import { openHelpModal } from "../HelpModal";
import { openPackBrowser } from "../PackBrowser";
import { openPipelineRunner } from "../PipelineRunner";
import { openSettings } from "../SettingsDrawer";
import { openModelPicker } from "../SessionControls";
import { openIdentityDrawer } from "../IdentityDrawer";
import { openExportModal } from "../SessionExportModal";
import { openImportModal } from "../SessionImportModal";
import { dispatchSlash, parseSlash } from "./slash";

interface PendingAttachment {
  /** Local key for solid `For` reactivity (random — files can repeat). */
  key: string;
  /** Filename only — full path isn't available from the browser drag API. */
  path: string;
  size: number;
  mimeType: string;
  /** UTF-8 contents for text files; populated lazily after drop. */
  content?: string;
  /** Base64 contents for binary files; populated lazily after drop. */
  data?: string;
  /** True until the file has been read into memory. */
  loading: boolean;
  /** Read error, if the file wouldn't load. */
  error?: string;
}

const MAX_ATTACH_BYTES = 1024 * 1024; // 1 MiB per file
const TEXT_MIME_PATTERN = /^(text\/|application\/(json|xml|x-yaml|x-toml|javascript|typescript))/i;

function isProbablyText(file: File): boolean {
  if (TEXT_MIME_PATTERN.test(file.type)) return true;
  if (!file.type) {
    // Browser doesn't recognise the type — guess by extension.
    return /\.(md|txt|json|yaml|yml|toml|js|jsx|ts|tsx|rs|go|py|rb|java|c|h|cc|cpp|hpp|cs|sh|bash|zsh|html|css|scss|sql|graphql|gql|ini|conf|xml|csv|log|env|cfg|lock)$/i.test(
      file.name,
    );
  }
  return false;
}

async function readAttachment(file: File): Promise<PendingAttachment> {
  const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`;
  const base: PendingAttachment = {
    key,
    path: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    loading: true,
  };
  if (file.size > MAX_ATTACH_BYTES) {
    return {
      ...base,
      loading: false,
      error: `too large (${file.size} B > ${MAX_ATTACH_BYTES} B cap)`,
    };
  }
  try {
    if (isProbablyText(file)) {
      const content = await file.text();
      return { ...base, content, loading: false };
    }
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return { ...base, data: btoa(binary), loading: false };
  } catch (err) {
    return {
      ...base,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

const PromptBox: Component = () => {
  let textareaRef: HTMLTextAreaElement | undefined;
  const [text, setText] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [transientPlaceholder, setTransientPlaceholder] = createSignal<string | null>(
    null,
  );
  const [attachments, setAttachments] = createSignal<PendingAttachment[]>([]);
  const [dragging, setDragging] = createSignal(false);
  const draftKey = () => focusedSessionId() ?? "__none__";

  async function ingestFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setError(null);
    const arr = Array.from(files);
    const reads = await Promise.all(arr.map(readAttachment));
    // Functional setter — concurrent drops both await Promise.all and
    // both call this. With a snapshot setter the second drop overwrites
    // the first because both read `attachments()` before either wrote.
    // Functional updates serialize against Solid's signal queue, so
    // each set sees the previous one's result.
    setAttachments((prev) => [...prev, ...reads]);
  }

  function removeAttachment(key: string): void {
    setAttachments((prev) => prev.filter((a) => a.key !== key));
  }

  function clearAttachments(): void {
    setAttachments([]);
  }

  // Hydrate from the persisted draft on session change.
  function hydrate() {
    setText(getDraft(draftKey()));
    autosize();
  }

  onMount(() => {
    hydrate();
    const onFocus = () => textareaRef?.focus();
    const onFocusWithHint = (e: Event) => {
      const detail = (e as CustomEvent<{ hint?: string }>).detail;
      if (detail?.hint) setTransientPlaceholder(detail.hint);
      requestAnimationFrame(() => textareaRef?.focus());
    };
    // A draft written from elsewhere (going back a turn puts the taken-back
    // prompt here) — re-read it when it's for the session on screen.
    const onDraftChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId === draftKey()) hydrate();
    };
    window.addEventListener("codeoid:focus-prompt", onFocus);
    window.addEventListener("codeoid:focus-prompt-with-hint", onFocusWithHint);
    window.addEventListener("codeoid:prompt-draft-changed", onDraftChanged);
    onCleanup(() => {
      window.removeEventListener("codeoid:focus-prompt", onFocus);
      window.removeEventListener("codeoid:focus-prompt-with-hint", onFocusWithHint);
      window.removeEventListener("codeoid:prompt-draft-changed", onDraftChanged);
    });
  });

  // Re-hydrate from localStorage when the focused session id changes.
  // Attachments (and the error line) are session-scoped ephemera with no
  // per-session store, unlike text drafts — clear them so a file dropped
  // on session A can never ride along into a send on session B.
  createEffect(
    on(focusedSessionId, () => {
      hydrate();
      setAttachments([]);
      setError(null);
    }),
  );

  // Prefetch the provider-command catalog for the focused session so the
  // slash parser can pass provider commands (pi extensions, prompt
  // templates, skills) through as prompt text instead of erroring.
  createEffect(() => {
    const id = focusedSessionId();
    if (id) ensureCommands(id);
  });

  function autosize(): void {
    const el = textareaRef;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }

  function handleInput(ev: InputEvent & { currentTarget: HTMLTextAreaElement }): void {
    setError(null);
    setText(ev.currentTarget.value);
    setDraft(draftKey(), ev.currentTarget.value);
    // Once the user starts typing, drop the transient hint placeholder.
    if (ev.currentTarget.value.length > 0) setTransientPlaceholder(null);
    autosize();
  }

  function submit(): void {
    const session = focusedSession();
    if (!session) {
      setError("no session focused");
      return;
    }
    const raw = text().trim();
    if (!raw && attachments().length === 0) return;
    // Block submit while any attachment is still being read; the user
    // dragged something in and we don't want to ship a half-loaded
    // payload.
    if (attachments().some((a) => a.loading)) {
      setError("attachments still loading…");
      return;
    }

    // Slash commands intercepted client-side. Provider commands (from the
    // session.commands catalog) pass through as null → sent as prompt text.
    const slash = parseSlash(raw, {
      isProviderCommand: (name) => isProviderCommand(session.id, name),
    });
    if (slash) {
      try {
        dispatchSlash(slash, {
          sessionId: session.id,
          send,
          request,
          report: setError,
          newRequestId,
          removeSession,
          showIdentity: openIdentityDrawer,
          showCapabilities: openCapabilitiesDrawer,
          showSettings: openSettings,
          showPacks: openPackBrowser,
          showPipeline: openPipelineRunner,
          showExport: openExportModal,
          showImport: openImportModal,
          onSessionForked: (forked) => {
            mergeSession(forked);
            focusSession(forked.id);
          },
          showHelp: openHelpModal,
          showModelPicker: openModelPicker,
        });
        clearDraft(draftKey());
        setText("");
        autosize();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    // Tell the transcript to use smooth-behavior on the next auto-scroll
    // so the just-submitted message animates into view rather than
    // snapping. One-shot — streaming deltas after this stay instant.
    window.dispatchEvent(new Event("codeoid:smooth-scroll"));
    const ready = attachments().filter((a) => !a.loading && !a.error);
    const payload = ready.map((a) => ({
      path: a.path,
      mimeType: a.mimeType,
      ...(a.content !== undefined ? { content: a.content } : {}),
      ...(a.data !== undefined ? { data: a.data } : {}),
    }));
    const key = draftKey();
    // Snapshot the dragged attachments so a rejected send can restore them
    // (they're cleared optimistically below and were previously lost on failure).
    const sentAttachments = attachments();
    // Use request() (not fire-and-forget send) so a rejected send — missing
    // scope, session gone — surfaces instead of vanishing silently. The daemon
    // acks immediately; a *post-ack* failure arrives separately as a visible
    // system message. On rejection we also restore the draft so the user's
    // text is never lost.
    request({
      type: "session.send",
      id: newRequestId(),
      sessionId: session.id,
      text: raw,
      // Idempotency key (`send.idempotency`): minted once per submit, so if
      // this send is retried after an ambiguous socket drop the daemon acks
      // the duplicate instead of running (and billing) a second turn.
      clientMsgId: crypto.randomUUID(),
      ...(payload.length > 0 ? { attachments: payload } : {}),
    }).catch((e) => {
      setError(`Message not delivered: ${e instanceof Error ? e.message : String(e)}`);
      // The draft store is keyed, so the text survives regardless; only
      // repopulate the LIVE editor if the user is still on that session —
      // restoring into whichever session is focused NOW would hand the
      // failed send's attachments to the wrong agent.
      setDraft(key, raw);
      if (draftKey() === key) {
        setText(raw);
        if (sentAttachments.length > 0) setAttachments(sentAttachments);
        autosize();
      }
    });
    clearDraft(key);
    setText("");
    setTransientPlaceholder(null);
    clearAttachments();
    autosize();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    // Never submit while an IME composition is active — for CJK input Enter
    // confirms the candidate, not "send". `keyCode === 229` covers browsers
    // that don't set `isComposing` on the confirming keydown.
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      submit();
      return;
    }
    if (ev.key === "Enter" && ev.ctrlKey) {
      ev.preventDefault();
      submit();
    }
  }

  return (
    <footer
      class="relative border-t border-border bg-bg-elev/60 px-4 py-3"
      onDragEnter={(e) => {
        if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only reset when leaving the footer itself, not just a child.
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(false);
        void ingestFiles(e.dataTransfer.files);
      }}
    >
      <div class="mx-auto max-w-3xl space-y-1">
        <Show when={attachments().length > 0}>
          <ul class="flex flex-wrap gap-1.5 px-1 pb-1">
            <For each={attachments()}>
              {(att) => (
                <li
                  class={`flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[11px] ${
                    att.error
                      ? "border-danger/40 bg-danger/10 text-danger"
                      : att.loading
                        ? "border-warn/40 bg-warn/10 text-warn"
                        : "border-border bg-bg-active/40 text-fg"
                  }`}
                  title={att.error ? `${att.path}: ${att.error}` : att.path}
                >
                  <span class="text-fg-faint">📎</span>
                  <span class="max-w-[20ch] truncate">{att.path}</span>
                  <span class="text-fg-faint">
                    {att.loading ? "…" : att.error ? "✕" : formatBytes(att.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.key)}
                    class="text-fg-faint transition hover:text-danger"
                    title="Remove"
                  >
                    ×
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <div class="flex items-end gap-2 rounded border border-border bg-bg px-3 py-2 focus-within:border-accent">
          <textarea
            ref={textareaRef}
            value={text()}
            onInput={handleInput}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={
              transientPlaceholder() ??
              (focusedSession()
                ? "Message Claude…  Enter sends · Shift+Enter for newline · drop files to attach · /help for commands"
                : "Select or create a session first.")
            }
            class="flex-1 resize-none bg-transparent font-mono text-sm leading-6 text-fg outline-none placeholder:text-fg-faint transition-[height] duration-150 ease-out"
            disabled={!focusedSession()}
          />
          <button
            type="button"
            onClick={submit}
            disabled={
              (!text().trim() && attachments().length === 0) || !focusedSession()
            }
            class="self-end rounded bg-accent px-3 py-1 text-xs font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            title="Send (Enter)"
          >
            send
          </button>
        </div>
        <Show when={error()}>
          <div class="px-1 text-[11px] text-danger">{error()}</div>
        </Show>
        <div class="px-1 text-[10px] text-fg-faint">
          /new · /rename · /interrupt · /rotate · /mode · /model · /packs ·
          /pipeline · /export · /import · /who · /agents · /skills · /mcp ·
          /hooks · /destroy
        </div>
      </div>
      <Show when={dragging() && focusedSession()}>
        <div
          class="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10 text-sm font-semibold text-accent"
        >
          drop to attach
        </div>
      </Show>
    </footer>
  );
};

export default PromptBox;
