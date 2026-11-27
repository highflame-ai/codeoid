/**
 * Boot wiring for the SDLC pipeline. Builds a PipelineManager from config,
 * returning `undefined` when the feature is opted out (`enabled: false` — it's on
 * by default) so the daemon stays dark. Kept a pure factory so the
 * enable/disable + share-the-daemon-DB behavior is unit-testable without standing
 * up a full SessionManager.
 */

import type { Database } from "bun:sqlite";
import type { EvidenceService } from "../evidence/service";
import { PipelineManager } from "./manager";
import { loadPack } from "./pack";
import type { PhaseRunner } from "./runner";
import { PipelineStore } from "./store";

/** A pack to load + install at boot. `trusted` (default false) lets the pack's
 *  `command` gates execute on this host. */
export interface PackConfigEntry {
  dir: string;
  trusted?: boolean;
}

/** The minimal structural slice of CodeoidConfig this factory needs — kept
 *  narrow so the pipeline package doesn't depend on the full config type. */
export interface PipelineWiringConfig {
  dbPath: string;
  pipeline?: { enabled: boolean; packs?: PackConfigEntry[] };
}

export interface PipelineWiringOptions {
  /** Backend seam for prompt/slash skills. Omit for noop/fn-only pipelines. */
  runner?: PhaseRunner;
  /** Share this DB handle (the daemon Store's) instead of opening a second
   *  connection to `config.dbPath`. */
  db?: Database;
  /** Records the evidence of every check a gate executes. */
  evidence?: EvidenceService;
}

/**
 * Construct a PipelineManager when the pipeline is enabled. Returns `undefined`
 * when disabled — the daemon then holds no pipeline manager at all. Shares the
 * daemon's DB handle when `opts.db` is given (else opens `config.dbPath`).
 */
export function createPipelineManagerFromConfig(
  config: PipelineWiringConfig | undefined,
  opts: PipelineWiringOptions = {},
): PipelineManager | undefined {
  if (!config?.pipeline?.enabled) return undefined;
  const store = opts.db ? new PipelineStore(opts.db) : new PipelineStore(config.dbPath);
  const manager = new PipelineManager(store, { runner: opts.runner, evidence: opts.evidence });
  // Install configured packs. Fail SOFT per pack: a malformed / missing pack
  // logs and is skipped rather than taking down the daemon boot.
  for (const p of config.pipeline.packs ?? []) {
    try {
      const pack = loadPack(p.dir, { trusted: p.trusted ?? false });
      manager.installPack(pack);
    } catch (e) {
      console.error(`[pipeline] failed to load pack "${p.dir}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return manager;
}
