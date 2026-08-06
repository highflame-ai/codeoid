/**
 * Pure renderers for the `codeoid pack …` CLI output — kept out of TerminalClient
 * so the formatting (the bulk of the surface) is unit-testable without a live
 * daemon/WebSocket. Each returns the lines to print; the client just sends the
 * verb and pipes the result through here to stdout.
 */

import type { AvailablePackWire, PackListResultMsg } from "../protocol/types.js";

/** Render the installed / available / registries snapshot as console lines. */
export function formatPackList(res: PackListResultMsg): string[] {
  const out: string[] = [];
  out.push("", "  Registries:");
  if (res.registries.length === 0) {
    out.push("    (none — add one: codeoid pack registry add <git-url>)");
  }
  for (const r of res.registries) {
    const status = r.cached ? `cached · ${r.packCount ?? 0} packs` : "not cached";
    out.push(`    ${r.name.padEnd(20)} ${status}   ${r.url}`);
  }

  out.push("", "  Installed:");
  if (res.installed.length === 0) out.push("    (none)");
  for (const p of res.installed) {
    const flags = [p.selected ? "selected" : "", p.trusted ? "trusted" : "untrusted", p.active ? "active" : "inactive", p.error ? "ERROR" : ""]
      .filter(Boolean)
      .join(" · ");
    out.push(`    ${p.id.padEnd(20)} v${p.version.padEnd(8)} ${flags}`);
  }

  const notInstalled = res.available.filter((a: AvailablePackWire) => !a.installed);
  out.push("", "  Available:");
  if (notInstalled.length === 0) out.push("    (none new)");
  for (const a of notInstalled) out.push(`    ${a.id.padEnd(20)} v${a.version.padEnd(8)} from ${a.registry}`);
  out.push("");
  return out;
}

/** Render one pack's detail (installed → full; available → install hint). Returns
 *  `null` when the id matches neither, so the caller can print a not-found error.
 *  `opts.resolve` adds the pre-flight model-binding view (docs/role-model-binding.md
 *  §4): each role's effective model under the daemon's config, plus any
 *  phase-level pins listed separately so a stale pin stays visible. */
export function formatPackShow(
  res: PackListResultMsg,
  id: string,
  opts: { resolve?: boolean } = {},
): string[] | null {
  const p = res.installed.find((x) => x.id === id);
  if (p) {
    const out: string[] = ["", `  ${p.name}  v${p.version}${p.selected ? "  (selected)" : ""}`];
    if (p.description) out.push(`  ${p.description}`);
    out.push(`  source: ${p.registry ?? "local"} · trust: ${p.trusted ? "trusted" : "untrusted"} · ${p.active ? "active" : "inactive"}`);
    if (p.error) {
      out.push(`  ⚠ ${p.error}`, "");
      return out;
    }
    out.push("", "  phases:");
    for (const ph of p.phases) {
      out.push(`    → ${ph.id}${ph.role ? ` [${ph.role}]` : ""}${ph.gate ? ` (gate: ${ph.gate})` : ""}`);
    }
    if (p.gates.length) out.push("", `  gates: ${p.gates.map((g) => `${g.id}:${g.kind}`).join(", ")}`);
    if (p.roles.length) out.push(`  roles: ${p.roles.join(", ")}`);
    if (opts.resolve) {
      out.push("", "  effective model bindings (this daemon's config, no CLI overrides):");
      const resolved = p.resolvedRoles ?? [];
      if (resolved.length === 0) out.push("    (no roles declared)");
      for (const r of resolved) {
        const tier = r.tier ? `tier=${r.tier}` : "no tier";
        const target = r.provider ? [r.provider, r.model].filter(Boolean).join(":") : "provider default";
        out.push(`    ${r.name.padEnd(16)} ${tier.padEnd(20)} → ${target}  (${r.resolvedFrom})`);
      }
      const pins = p.phasePins ?? [];
      if (pins.length > 0) {
        // Pins outrank the tier map at run time (§3 rung 3) — surfacing them
        // here is what makes a stale concrete pin visible and removable.
        out.push("", "  phase-level pins (outrank the tier map — check for staleness):");
        for (const pin of pins) {
          out.push(`    ${pin.phase}: ${[pin.provider, pin.model].filter(Boolean).join(":")}`);
        }
      }
    }
    out.push("");
    return out;
  }
  const a = res.available.find((x) => x.id === id);
  if (a) {
    const out: string[] = ["", `  ${a.name}  v${a.version}  (available in ${a.registry}, not installed)`];
    if (a.description) out.push(`  ${a.description}`);
    out.push("", `  install with: codeoid pack install ${a.id}`, "");
    return out;
  }
  return null;
}
