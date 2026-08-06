/**
 * Help modal — lists every slash command + syntax. Opened by `/help`
 * (and could be wired to a keyboard shortcut later).
 *
 * Static content: the command set lives in prompt/slash.ts as a fixed
 * client-side verb list, so there's nothing to fetch from the daemon —
 * this just documents what parseSlash() accepts. Keep the two in sync.
 */

import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";

import { modelCatalog } from "../state/models";

/** Baked in by vite `define` at build time; "dev" under compiles that don't
 *  substitute it (plain vitest, tsc). */
const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== "undefined" ? __BUILD_COMMIT__ : "dev";

const [openSignal, setOpenSignal] = createSignal(false);

/** Open the help modal programmatically (wired to the `/help` slash command). */
export function openHelpModal(): void {
  setOpenSignal(true);
}

export function closeHelpModal(): void {
  setOpenSignal(false);
}

interface CommandDoc {
  usage: string;
  desc: string;
}

const COMMANDS: readonly CommandDoc[] = [
  { usage: "/new <name> [workdir]", desc: "Create a session (workdir defaults to .)" },
  { usage: "/rename <name>", desc: "Rename the focused session" },
  { usage: "/destroy", desc: "Destroy the focused session" },
  { usage: "/interrupt", desc: "Interrupt the current turn" },
  { usage: "/rotate", desc: "Rotate context — fresh backing session, memory preserved" },
  { usage: "/mode <g|i|x>", desc: "Switch mode: guarded · interactive · autonomous" },
  { usage: "/model <id|alias> [fallback]", desc: "Switch model: opus / sonnet / haiku, or a full claude-* id" },
  { usage: "/agents", desc: "Show subagents available to this session" },
  { usage: "/skills", desc: "Show skills available to this session" },
  { usage: "/mcp", desc: "Show MCP servers + their commands" },
  { usage: "/hooks", desc: "Show configured hooks" },
  { usage: "/who", desc: "Show the connected ZeroID identity" },
  { usage: "/settings", desc: "Open the settings drawer" },
  { usage: "/packs", desc: "Browse, install, trust & select SDLC packs" },
  { usage: "/pipeline [goal]", desc: "Run a governed SDLC pipeline from an installed pack" },
  { usage: "/fork", desc: "Branch the session — optionally continue on another backend" },
  { usage: "/export", desc: "Export / share the focused session" },
  { usage: "/import", desc: "Import (fork) a session from a share" },
  { usage: "/clear", desc: "Clear the prompt box" },
  { usage: "/help", desc: "Show this list" },
];

const HelpModal: Component = () => {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openSignal()) {
        e.preventDefault();
        setOpenSignal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={openSignal()}>
      <div
        class="fixed inset-0 z-40 flex items-start justify-center bg-bg/70 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpenSignal(false);
        }}
      >
        <div class="mt-[12vh] w-full max-w-xl rounded-lg border border-border bg-bg-elev shadow-2xl">
          <div class="flex items-center justify-between border-b border-border px-4 py-2.5">
            {/* Build stamp (vite define): a served dist that predates the
                source is otherwise invisible — hover here to see what the
                daemon is actually serving. */}
            <span class="text-sm font-semibold text-fg" title={`ui build ${BUILD_COMMIT}`}>
              Slash commands
            </span>
            <button
              type="button"
              class="text-fg-faint hover:text-fg"
              onClick={() => setOpenSignal(false)}
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
          <div class="max-h-[60vh] overflow-y-auto px-2 py-2">
            <For each={COMMANDS}>
              {(c) => (
                <div class="flex items-baseline gap-3 rounded px-2 py-1.5 hover:bg-bg">
                  <code class="min-w-[14rem] shrink-0 font-mono text-xs text-accent">
                    {c.usage}
                  </code>
                  <span class="text-xs text-fg-muted">{c.desc}</span>
                </div>
              )}
            </For>
          </div>
          <div class="border-t border-border px-4 py-2">
            <div class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Models (for /model)
            </div>
            <Show
              when={modelCatalog().length > 0}
              fallback={
                <div class="text-xs text-fg-faint">Loading models…</div>
              }
            >
              <div class="flex flex-col gap-y-1 text-xs text-fg-muted">
                <For each={modelCatalog()}>
                  {(m) => (
                    <span>
                      <code class="font-mono text-accent">{m.value}</code>
                      {" — "}
                      {m.displayName}
                      {m.description ? ` · ${m.description}` : ""}
                      {m.isDefault ? " (default)" : ""}
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <div class="mt-1 text-[11px] text-fg-faint">
              …or any full <code class="font-mono">claude-*</code> id. Enter sends · Shift+Enter newline · Esc closes
              {" · "}
              <span title="git commit this UI bundle was built from">build {BUILD_COMMIT}</span>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default HelpModal;
