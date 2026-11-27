/**
 * Pure helpers behind the directory picker (components/files/DirectoryPicker).
 *
 * The picker's one input is both a filter and a path bar: plain text filters
 * the folder on screen, while text starting with `/` or `~` is a path — its
 * directory part is browsed live and the last segment filters that listing,
 * so typing `/usr/lo` shows `/usr` narrowed to `lo…`, like shell completion.
 */

import type { FsEntry } from "../protocol/types";

export interface PickerQuery {
  /** Directory to show: null means "stay on the current one". */
  dir: string | null;
  /** Text the listing is narrowed by. */
  needle: string;
}

/** True when the query is a path (absolute or home-relative), not a filter. */
export function isPathQuery(q: string): boolean {
  return q.startsWith("/") || q === "~" || q.startsWith("~/");
}

export function parseQuery(q: string): PickerQuery {
  if (!isPathQuery(q)) return { dir: null, needle: q.trim() };
  if (q === "~") return { dir: "~", needle: "" };
  const cut = q.lastIndexOf("/");
  // "/foo" → dir "/", "~/foo" → dir "~/", "/a/b/" → dir "/a/b/".
  return { dir: q.slice(0, cut + 1), needle: q.slice(cut + 1) };
}

/** Same directory, ignoring a trailing slash (but "/" stays "/"). */
export function sameDir(a: string, b: string): boolean {
  const trim = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  return trim(a) === trim(b);
}

/**
 * Entries matching `needle`: names starting with it first, then names that
 * merely contain it; each group keeps the daemon's alphabetical order.
 * Case-insensitive unless the needle has an upper-case letter (smart case).
 */
export function filterEntries(entries: readonly FsEntry[], needle: string): FsEntry[] {
  if (!needle) return [...entries];
  const sensitive = needle !== needle.toLowerCase();
  const n = sensitive ? needle : needle.toLowerCase();
  const prefix: FsEntry[] = [];
  const inner: FsEntry[] = [];
  for (const e of entries) {
    const name = sensitive ? e.name : e.name.toLowerCase();
    if (name.startsWith(n)) prefix.push(e);
    else if (name.includes(n)) inner.push(e);
  }
  return [...prefix, ...inner];
}

/** Where `needle` sits in `name`, for highlighting; null when it doesn't. */
export function matchRange(name: string, needle: string): [number, number] | null {
  if (!needle) return null;
  const sensitive = needle !== needle.toLowerCase();
  const at = (sensitive ? name : name.toLowerCase()).indexOf(sensitive ? needle : needle.toLowerCase());
  return at < 0 ? null : [at, at + needle.length];
}

export interface Crumb {
  label: string;
  path: string;
}

/**
 * Breadcrumb from the browse root down to `path`. Inside home the trail
 * starts at `~`; elsewhere at the root itself.
 */
export function breadcrumbs(path: string, root: string, home: string | null): Crumb[] {
  if (!path) return [];
  const base = home && (path === home || path.startsWith(`${home}/`)) ? home : root;
  const baseLabel = base === home ? "~" : base;
  const out: Crumb[] = [{ label: baseLabel, path: base }];
  if (path === base) return out;
  const tail = path.slice(base.endsWith("/") ? base.length : base.length + 1);
  let acc = base;
  for (const part of tail.split("/").filter(Boolean)) {
    acc = acc.endsWith("/") ? `${acc}${part}` : `${acc}/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

/** `/home/me/x` → `~/x` given the daemon's home; anything else verbatim. */
export function tildify(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * A path and its ancestors, nearest first: `/a/b` → `/a/b`, `/a`, `/`.
 * The picker walks these when the folder it was asked to open is gone.
 */
export function selfAndAncestors(path: string): string[] {
  const out: string[] = [];
  let p = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  for (;;) {
    out.push(p);
    if (p === "/" || p === "~" || !p.includes("/")) return out;
    const cut = p.lastIndexOf("/");
    p = cut === 0 ? "/" : p.slice(0, cut);
  }
}
