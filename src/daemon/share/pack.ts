/**
 * Pack a session into a `ShareBundle` — a single JSON object that's
 * round-trippable through clipboard / gist / S3 / git.
 *
 * Inputs come from the caller (Session reference + Store + Transcript)
 * — pack is pure with respect to fs except for an optional
 * `pinnedFiles` snapshot.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Store } from "../store.js";
import type { TranscriptStore } from "../transcript.js";
import type { Episode, MemoryEngine } from "../memory/index.js";
import type {
  AuthContext,
  SessionMessage,
  TurnUsage,
} from "../../protocol/types.js";

import { resolveSafe } from "../fs.js";
import { resolveWorkdirAlias } from "./git-alias.js";
import {
  SHARE_FORMAT_VERSION,
  type ShareBundle,
  type ShareEpisode,
  type ShareFileSnapshot,
  type ShareIdentity,
  type ShareSessionMeta,
} from "./manifest.js";
import {
  encodePath,
  encodePathArray,
  rewriteTextPaths,
} from "./path-rewrite.js";

export interface PackInput {
  /** Public session metadata; reuses SessionInfo shape but only what we need. */
  session: {
    id: string;
    name: string;
    workdir: string;
    createdAt: string;
    model?: string;
    fallbackModel?: string;
    mode?: string;
    rotation?: { count: number };
    pinnedFiles?: string[];
  };
  /** Auth identity that requested the export — surfaced in the manifest. */
  exporter: AuthContext;
  /** Per-call options. */
  includeMemory: boolean;
  includePinnedFiles: boolean;
  /** Override the auto-resolved alias (otherwise git remote / dir name). */
  aliasOverride?: string;
  /** Per-pinned-file size cap in bytes (default 1 MiB). */
  pinnedFileMaxBytes?: number;
}

export interface PackDependencies {
  transcript: TranscriptStore;
  store: Store;
  memory: MemoryEngine | null;
  /** Workspace id resolver (for memory episode lookups). */
  workspaceIdFor: (workdir: string) => string;
  /**
   * The daemon's secret scrubbing (docs/secrets-and-memory-design.md §2.6):
   * a transcript or episode written before it, and a pinned file, go into a
   * bundle scrubbed. Absent: packed as stored.
   */
  scrub?: <T>(value: T) => T;
}

export async function packSession(
  input: PackInput,
  deps: PackDependencies,
): Promise<ShareBundle> {
  const aliasInfo = await resolveWorkdirAlias(input.session.workdir, input.aliasOverride);
  const alias = aliasInfo.alias;
  const workdir = input.session.workdir;

  // ---------- Transcript ----------
  const rawEntries = await deps.transcript.loadTranscript(input.session.id);
  const transcript: SessionMessage[] = [];
  for (const entry of rawEntries) {
    const msg = entry.message as unknown as SessionMessage;
    if (!msg || typeof msg !== "object") continue;
    if (!("messageId" in msg) || !msg.messageId) continue;
    transcript.push(rewriteMessage(deps.scrub ? deps.scrub(msg) : msg, workdir, alias));
  }

  // ---------- Memory episodes (per-session slice) ----------
  const episodes: ShareEpisode[] = [];
  if (input.includeMemory && deps.memory) {
    const epRows: Episode[] = deps.memory.store.listEpisodesForSession(input.session.id);
    for (const ep of epRows) {
      episodes.push({
        id: ep.id,
        kind: ep.kind,
        ...(ep.toolName ? { toolName: ep.toolName } : {}),
        summary: rewriteTextPaths(deps.scrub ? deps.scrub(ep.summary) : ep.summary, workdir, alias),
        content: rewriteTextPaths(deps.scrub ? deps.scrub(ep.content) : ep.content, workdir, alias),
        filePaths: encodePathArray(ep.filePaths, workdir, alias),
        tokenEstimate: ep.tokenEstimate,
        createdAt: ep.createdAt,
        createdBy: ep.createdBy,
      });
    }
  }

  // ---------- Per-turn usage ----------
  const turns: TurnUsage[] = deps.memory
    ? deps.memory.store.listTurnsForSession(input.session.id, 10_000)
    : [];

  // ---------- Pinned files (optional) ----------
  let pinnedFiles: Record<string, ShareFileSnapshot> | undefined;
  if (input.includePinnedFiles && (input.session.pinnedFiles?.length ?? 0) > 0) {
    pinnedFiles = {};
    const cap = input.pinnedFileMaxBytes ?? 1 * 1024 * 1024;
    for (const p of input.session.pinnedFiles ?? []) {
      // SECURITY (GHSA-38vh vector 1): bound the captured path to the session
      // workdir with the SAME containment turn-time pins get via
      // attachments.resolveOne. Without this, `session.pin` stores any path
      // unvalidated and export embeds arbitrary host files (e.g.
      // ~/.codeoid/config.json — the root ZeroID key) into a shareable bundle.
      // resolveSafe canonicalises the workdir, realpaths the pin, and refuses
      // anything that escapes the workdir or lands in a protected dir; on
      // escape/missing it throws and we skip the pin entirely.
      let abs: string;
      try {
        ({ absolute: abs } = await resolveSafe(workdir, p));
      } catch {
        continue;
      }
      const captured = await capturePinnedFile(abs, cap);
      // Text only: a binary file's base64 isn't text a secret could be found in, and changing it would break it.
      const snap = captured && deps.scrub && captured.encoding === "utf-8" ? { ...captured, content: deps.scrub(captured.content) } : captured;
      if (snap) {
        const key = encodePath(abs, workdir, alias);
        pinnedFiles[key] = snap;
      }
    }
  }

  const manifest = {
    exportedAt: new Date().toISOString(),
    exporterIdentity: identityFromAuth(input.exporter),
    session: sessionMeta(input.session),
    workdir: {
      alias,
      originalAbsolute: input.session.workdir,
      aliasSource: aliasInfo.source,
    },
    counts: {
      messages: transcript.length,
      episodes: episodes.length,
      turns: turns.length,
      pinnedFiles: pinnedFiles ? Object.keys(pinnedFiles).length : 0,
    },
    pathPolicy: {
      aliasRelative: true as const,
      externalPrefix: "<external>/" as const,
    },
  };

  return {
    kind: "codeoid.session",
    version: SHARE_FORMAT_VERSION,
    manifest,
    transcript,
    episodes,
    turns,
    ...(pinnedFiles ? { pinnedFiles } : {}),
  };
}

/** Optionally write the bundle to a file under `~/.codeoid/exports/`. */
export async function writeBundleToFile(
  bundle: ShareBundle,
): Promise<{ path: string; sizeBytes: number }> {
  const exportsDir = path.join(os.homedir(), ".codeoid", "exports");
  await fs.mkdir(exportsDir, { recursive: true });
  const slug = (bundle.manifest.session.name || bundle.manifest.session.id)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "session";
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .replace(/[T-]/g, "");
  const filename = `codeoid-${slug}-${stamp}.json`;
  const filePath = path.join(exportsDir, filename);
  const json = JSON.stringify(bundle);
  await fs.writeFile(filePath, json, "utf-8");
  return { path: filePath, sizeBytes: Buffer.byteLength(json, "utf-8") };
}

// ---------- helpers ----------

function rewriteMessage(
  msg: SessionMessage,
  workdir: string,
  alias: string,
): SessionMessage {
  const out: SessionMessage = {
    ...msg,
    content: rewriteTextPaths(msg.content, workdir, alias),
  };
  if (msg.tool) {
    const tool = msg.tool;
    out.tool = {
      ...tool,
      state: deepRewriteStrings(tool.state, (s) =>
        rewriteTextPaths(s, workdir, alias),
      ) as typeof tool.state,
    };
  }
  if (msg.parts) {
    out.parts = msg.parts.map((p) => {
      if (p.kind === "code") {
        return {
          ...p,
          ...(p.filePath ? { filePath: encodePath(p.filePath, workdir, alias) } : {}),
        };
      }
      if (p.kind === "file_ref" || p.kind === "diff") {
        return {
          ...p,
          path: encodePath(p.path, workdir, alias),
          ...(p.kind === "diff" && (p as { originalPath?: string }).originalPath
            ? {
                originalPath: encodePath(
                  (p as { originalPath: string }).originalPath,
                  workdir,
                  alias,
                ),
              }
            : {}),
        };
      }
      return p;
    });
  }
  return out;
}

function identityFromAuth(auth: AuthContext): ShareIdentity {
  return {
    sub: auth.sub,
    ...(auth.name ? { name: auth.name } : {}),
    type: auth.delegationDepth === 0 ? "human" : "agent",
  };
}

function sessionMeta(s: PackInput["session"]): ShareSessionMeta {
  return {
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    ...(s.model ? { model: s.model } : {}),
    ...(s.fallbackModel ? { fallbackModel: s.fallbackModel } : {}),
    ...(s.mode ? { mode: s.mode } : {}),
    ...(s.rotation ? { rotationCount: s.rotation.count } : {}),
  };
}

async function capturePinnedFile(
  absolute: string,
  cap: number,
): Promise<ShareFileSnapshot | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absolute);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const length = Math.min(stat.size, cap);
  const handle = await fs.open(absolute, "r");
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, 0);
    const isBinary = looksBinary(buf);
    return {
      originalPath: absolute,
      content: isBinary ? buf.toString("base64") : buf.toString("utf-8"),
      encoding: isBinary ? "base64" : "utf-8",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Walk an arbitrary JSON-shaped value and apply `f` to every string.
 * Used for tool state where partial inputs / progress / outputs / etc.
 * can carry path-y text we need to rewrite.
 */
function deepRewriteStrings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === "string") return f(value);
  if (Array.isArray(value)) return value.map((v) => deepRewriteStrings(v, f));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepRewriteStrings(v, f);
    }
    return out;
  }
  return value;
}

function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.length, 4096));
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true;
  }
  return false;
}
