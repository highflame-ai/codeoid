/**
 * Persistent layout state — sidebar widths + collapse flags. Pure UX,
 * stored in localStorage so reloads keep the user's preferred chrome.
 *
 * No daemon dependency: this is the only file outside drafts/auth that
 * persists client-side, intentionally.
 */

import { batch, createEffect, createSignal } from "solid-js";

import { DEFAULT_HOME, isHome, type Home } from "../lib/home";

const STORAGE_KEY = "codeoid.layout.v1";

interface LayoutState {
  leftSidebarPx: number;
  leftSidebarCollapsed: boolean;
  rightPanePx: number;
  /** Session header collapse — when true, only a 1-line summary shows. */
  headerCollapsed: boolean;
  /**
   * Which top-level home the user last chose (§3.A). A navigation preference,
   * not a mode — see lib/home.ts. Persisted so the toggle is remembered rather
   * than re-decided on every reload.
   */
  home: Home;
}

const DEFAULTS: LayoutState = {
  leftSidebarPx: 280,
  leftSidebarCollapsed: false,
  rightPanePx: 576, // 36rem-ish
  headerCollapsed: false,
  home: DEFAULT_HOME,
};

const LIMITS = {
  leftMinPx: 200,
  leftMaxPx: 600,
  leftCollapsedPx: 56,
  rightMinPx: 280,
  rightMaxPx: 1200,
};

function load(): LayoutState {
  if (typeof localStorage === "undefined") return DEFAULTS;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return {
      leftSidebarPx:
        typeof parsed.leftSidebarPx === "number"
          ? clamp(parsed.leftSidebarPx, LIMITS.leftMinPx, LIMITS.leftMaxPx)
          : DEFAULTS.leftSidebarPx,
      leftSidebarCollapsed:
        typeof parsed.leftSidebarCollapsed === "boolean"
          ? parsed.leftSidebarCollapsed
          : DEFAULTS.leftSidebarCollapsed,
      rightPanePx:
        typeof parsed.rightPanePx === "number"
          ? clamp(parsed.rightPanePx, LIMITS.rightMinPx, LIMITS.rightMaxPx)
          : DEFAULTS.rightPanePx,
      headerCollapsed:
        typeof parsed.headerCollapsed === "boolean"
          ? parsed.headerCollapsed
          : DEFAULTS.headerCollapsed,
      // Validated rather than cast: a stored value from a future build (or a
      // hand-edited one) must fall back, not select a home that does not exist.
      home: isHome(parsed.home) ? parsed.home : DEFAULTS.home,
    };
  } catch {
    return DEFAULTS;
  }
}

const initial = load();

const [leftSidebarPx, setLeftSidebarPx] = createSignal(initial.leftSidebarPx);
const [leftSidebarCollapsed, setLeftSidebarCollapsed] = createSignal(
  initial.leftSidebarCollapsed,
);
const [rightPanePx, setRightPanePx] = createSignal(initial.rightPanePx);
const [headerCollapsed, setHeaderCollapsedSig] = createSignal(
  initial.headerCollapsed,
);
const [home, setHomeSig] = createSignal<Home>(initial.home);

/** Effective width for the left sidebar accounting for collapse. */
export function leftSidebarEffectivePx(): number {
  return leftSidebarCollapsed() ? LIMITS.leftCollapsedPx : leftSidebarPx();
}

export const sidebarWidth = leftSidebarPx;
export const isLeftCollapsed = leftSidebarCollapsed;
export const rightWidth = rightPanePx;
export const isHeaderCollapsed = headerCollapsed;

/** The user's chosen top-level home (§3.A). */
export const activeHome = home;

export function setHome(next: Home): void {
  setHomeSig(next);
}

// ── Mobile / narrow-viewport (Telegram Mini App) ──────────────────────────

// Reactive viewport-width breakpoint. Below 768px the 3-pane grid is too
// cramped, so Shell switches to a single-column layout with the session list
// and file viewer as overlays.
const mobileMq =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 768px)")
    : null;
const [mobile, setMobile] = createSignal(mobileMq?.matches ?? false);
mobileMq?.addEventListener("change", (e) => setMobile(e.matches));
/** True when the viewport is narrow (phone / Mini App). */
export const isMobile = mobile;

// Off-canvas session-list drawer (mobile only).
const [navOpen, setNavOpen] = createSignal(false);
export const isNavOpen = navOpen;
export function toggleNav(): void {
  setNavOpen((v) => !v);
}
export function closeNav(): void {
  setNavOpen(false);
}

export function toggleHeaderCollapsed(): void {
  setHeaderCollapsedSig((v) => !v);
}

export function setLeftWidth(px: number): void {
  setLeftSidebarPx(clamp(px, LIMITS.leftMinPx, LIMITS.leftMaxPx));
}

export function setRightWidth(px: number): void {
  setRightPanePx(clamp(px, LIMITS.rightMinPx, LIMITS.rightMaxPx));
}

export function toggleLeftCollapsed(): void {
  setLeftSidebarCollapsed((v) => !v);
}

export function setLeftCollapsed(v: boolean): void {
  setLeftSidebarCollapsed(v);
}

// Persist on every change — debounced. Resize drag handlers used to
// pump `setLeftWidth` on every pointermove (60 calls/sec on a typical
// trackpad), which fired this effect 60×/sec, which JSON-stringified
// + wrote localStorage 60×/sec. localStorage writes are synchronous,
// so the resize cursor felt sluggish on slower machines and the
// browser logged "Forced reflow" warnings. Coalesce via a 150 ms
// trailing debounce; drag commits land cleanly when the user releases,
// no per-pointer-event writes.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
createEffect(() => {
  // Read inside the effect so we still track every signal — debounce
  // affects only the write side.
  const snapshot: LayoutState = {
    leftSidebarPx: leftSidebarPx(),
    leftSidebarCollapsed: leftSidebarCollapsed(),
    rightPanePx: rightPanePx(),
    headerCollapsed: headerCollapsed(),
    home: home(),
  };
  if (typeof localStorage === "undefined") return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Quota / private mode — drop silently.
    }
  }, 150);
});

// Best-effort flush before unload so the user doesn't lose the last
// drag position if they close the tab within the debounce window.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (persistTimer === null) return;
    clearTimeout(persistTimer);
    persistTimer = null;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          leftSidebarPx: leftSidebarPx(),
          leftSidebarCollapsed: leftSidebarCollapsed(),
          rightPanePx: rightPanePx(),
          headerCollapsed: headerCollapsed(),
        }),
      );
    } catch {
      /* unload-time best effort */
    }
  });
}

export const LIMITS_RO = LIMITS;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function _resetLayoutForTest(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  batch(() => {
    setLeftSidebarPx(DEFAULTS.leftSidebarPx);
    setLeftSidebarCollapsed(DEFAULTS.leftSidebarCollapsed);
    setRightPanePx(DEFAULTS.rightPanePx);
    setHeaderCollapsedSig(DEFAULTS.headerCollapsed);
  });
}
