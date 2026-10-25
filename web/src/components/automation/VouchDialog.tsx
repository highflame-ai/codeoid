/**
 * "Vouch for current head" (docs/loops.md "Vouching for a branch's head"):
 * you say a watched branch's head, as it is now, is code you'd run yourself —
 * so it and everything beneath it are trusted, and later trusted merges'
 * chains can end at it.
 *
 * It always sends `trustHead: { branch: fullSha }`: a compare-and-set. If any
 * named head moved, the daemon vouches for nothing and names the head's full
 * id now (the refusal's `detail`); the dialog shows that, pins to the new
 * commit, and asks again — so a commit pushed after you looked is never
 * vouched for unseen. There is no unpinned vouch here, and no prefix: either
 * could take a commit nobody looked at. This is the web's one vouch path
 * (narrowing the trust list offers to open it afterwards).
 */

import { Component, Index, Show, createEffect, createSignal, on } from "solid-js";

import { githubCommitUrl, relativeWhen } from "../../lib/automation";
import { SHA_RE, buildTrustHead, parseMovedHead, type KnownHead, type MovedHead } from "../../lib/watches";
import type { LoopWatchTrustHead, LoopWatchWire } from "../../protocol/types";
import { ConfirmDialog, inputClass } from "./common";

export interface VouchDialogProps {
  open: boolean;
  watch: Pick<LoopWatchWire, "repo" | "branches" | "trust" | "ghLogin">;
  /** The newest head the watch's history names per branch (lib/watches `knownHeads`). */
  known: Record<string, KnownHead>;
  now: number;
  /** Rejects with the daemon's words (and its `detail`, when the head moved). */
  onVouch: (trustHead: LoopWatchTrustHead) => Promise<void>;
  onClose: () => void;
}

interface BranchPick {
  branch: string;
  on: boolean;
  sha: string;
}

export const VouchDialog: Component<VouchDialogProps> = (props) => {
  const [picks, setPicks] = createSignal<BranchPick[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [moved, setMoved] = createSignal<MovedHead | null>(null);

  // Fresh each time it opens, pinned to what the watch last saw.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setError(null);
        setMoved(null);
        setPicks(props.watch.branches.map((b) => ({ branch: b, on: true, sha: props.known[b]?.sha ?? "" })));
      },
    ),
  );

  const setPick = (i: number, patch: Partial<BranchPick>) => setPicks((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const chosen = () => picks().filter((p) => p.on);
  const ready = () => chosen().length > 0 && chosen().every((p) => SHA_RE.test(p.sha.trim()));
  const trusted = () => ["you" + (props.watch.ghLogin ? ` (@${props.watch.ghLogin})` : ""), ...props.watch.trust].join(", ");

  const confirm = async () => {
    const built = buildTrustHead(picks());
    if ("error" in built) return setError(built.error);
    setBusy(true);
    setError(null);
    try {
      await props.onVouch(built.trustHead);
      props.onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = parseMovedHead(e);
      if (m) {
        // Nothing was vouched for. Show the new head and pin to it; vouching
        // for it is a new decision, made by pressing again.
        setMoved(m);
        setPicks((ps) => ps.map((p) => (p.branch === m.branch ? { ...p, sha: m.now } : p)));
        setError(null);
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={props.open}
      title={moved() ? `${moved()!.branch} moved: nothing was vouched for` : "Vouch for the current head"}
      confirmLabel={moved() ? "Vouch for the new head" : chosen().length > 1 ? `Vouch for ${chosen().length} branches` : "Vouch for it"}
      busy={busy()}
      error={error()}
      canConfirm={ready()}
      onCancel={() => props.onClose()}
      onConfirm={() => void confirm()}
    >
      <Show when={moved()}>
        {(m) => (
          <div class="rounded border border-warn/50 bg-warn/10 px-3 py-2 text-[12px] text-fg" data-testid="vouch-moved">
            <span class="font-mono">{m().branch}</span>'s head is <span class="font-mono">{m().now}</span> now, not{" "}
            <span class="font-mono">{m().pinned}</span>. Look at the new head before you vouch for it.
            <Show when={githubCommitUrl(props.watch.repo, m().now)}>
              {(url) => (
                <>
                  {" "}
                  <a class="text-accent underline-offset-2 hover:underline" href={url()} target="_blank" rel="noopener noreferrer">
                    view on GitHub
                  </a>
                </>
              )}
            </Show>
          </div>
        )}
      </Show>
      <p>
        You vouch that each branch's head, as it is now, is code you would run yourself.{" "}
        <strong class="text-fg">It and every commit beneath it become trusted</strong>, including commits you didn't review, and later merges by
        trusted logins ({trusted()}) carry that trust forward.
      </p>
      <p class="text-[12px]">It's recorded in the watch's history and the audit log. Changing the trust list to drop anyone forgets it.</p>

      <div class="flex flex-col gap-1.5" role="group" aria-label="Branches to vouch for">
        <Index each={picks()}>
          {(p, i) => {
            const known = () => props.known[p().branch];
            const url = () => (SHA_RE.test(p().sha.trim()) ? githubCommitUrl(props.watch.repo, p().sha.trim()) : null);
            return (
              <div class="rounded border border-border bg-bg/30 px-2.5 py-1.5" data-testid="vouch-branch">
                <label class="flex items-center gap-2 text-[12px] text-fg">
                  <input
                    type="checkbox"
                    checked={p().on}
                    disabled={busy()}
                    onChange={(e) => setPick(i, { on: e.currentTarget.checked })}
                    aria-label={`Vouch for ${p().branch}`}
                  />
                  <span class="font-mono">{p().branch}</span>
                </label>
                <Show when={p().on}>
                  <div class="mt-1 flex flex-wrap items-center gap-1.5">
                    <input
                      type="text"
                      autocomplete="off"
                      spellcheck={false}
                      value={p().sha}
                      onInput={(e) => setPick(i, { sha: e.currentTarget.value })}
                      class={`${inputClass} min-w-0 flex-1`}
                      disabled={busy()}
                      aria-label={`${p().branch} head commit`}
                      aria-invalid={p().sha && !SHA_RE.test(p().sha.trim()) ? "true" : undefined}
                      placeholder="the full id of the head commit you looked at"
                    />
                    <Show when={url()}>
                      {(u) => (
                        <a class="text-[11px] text-accent underline-offset-2 hover:underline" href={u()} target="_blank" rel="noopener noreferrer">
                          view
                        </a>
                      )}
                    </Show>
                  </div>
                  <p class="mt-0.5 text-[10px] text-fg-faint">
                    <Show
                      when={moved()?.branch !== p().branch}
                      fallback={"The head the daemon read just now. If it moves again before you confirm, nothing is vouched for and you'll see the new one."}
                    >
                    <Show
                      when={known()}
                      fallback={"The watch hasn't recorded this branch's head yet; paste the commit's full id from GitHub."}
                    >
                      {(k) => (
                        <>
                          From the watch's history: {k().source}, {relativeWhen(k().at, props.now)}. The head may have moved since; if it did,
                          nothing is vouched for and you'll see the new one.
                        </>
                      )}
                    </Show>
                    </Show>
                  </p>
                </Show>
              </div>
            );
          }}
        </Index>
      </div>

      <p class="text-[11px] text-fg-muted">
        Only while each head is still the commit above: if one moved, nothing is vouched for and you see the new one.
      </p>
    </ConfirmDialog>
  );
};

export default VouchDialog;
