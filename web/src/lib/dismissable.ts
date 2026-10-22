import { createEffect, onCleanup } from "solid-js";

/** Dismiss a dropdown on Escape or a pointer-down outside its root — the menus
 * previously closed only on `onMouseLeave`, which a keyboard/touch user can't
 * trigger, so the menu stayed open over the content. An Esc that closes a menu
 * is marked handled (`defaultPrevented`) so it does nothing else. Call inside a
 * component. */
export function useDismissable(
  rootRef: () => HTMLElement | undefined,
  isOpen: () => boolean,
  close: () => void,
): void {
  createEffect(() => {
    if (!isOpen()) return;
    const onDown = (e: PointerEvent) => {
      const el = rootRef();
      if (el && !el.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Handled: this Esc closed the menu, so App's Esc-to-interrupt (on
      // window, after this document listener) must leave the turn alone.
      e.preventDefault();
      close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    });
  });
}
