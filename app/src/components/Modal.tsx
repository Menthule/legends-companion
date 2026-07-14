// Shared modal scaffold: scrim + dialog card with Escape dismissal, a Tab
// focus trap, and aria-modal built in. Replaces the hand-rolled copies that
// had drifted (two of five modals had no keyboard dismissal at all).

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Every dismissal path (Escape, scrim click) funnels through `onClose` —
 * callers with unsaved work pass their dirty-check guard AS `onClose` (see
 * QuickTriggerModal's maybeClose) so nothing can bypass it.
 *
 * The Escape listener rides the bubble phase so inner popups (e.g. the
 * trigger editor's suggestion combo) can stopPropagation to dismiss only
 * themselves; the Tab trap uses capture so focus can never tab out to the
 * background page.
 */
export default function Modal({
  label,
  onClose,
  className,
  scrimClassName,
  children,
}: {
  /** Accessible dialog name (aria-label). */
  label: string;
  onClose: () => void;
  /** Extra classes on the `.modal` card (e.g. "modal-wide"). */
  className?: string;
  /** Extra classes on the `.modal-scrim`. */
  scrimClassName?: string;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCloseRef.current();
    };
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const focusables = [
        ...card.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !card.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !card.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onEscape);
    window.addEventListener("keydown", onTab, true);
    return () => {
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("keydown", onTab, true);
    };
  }, []);

  return (
    <div
      className={`modal-scrim${scrimClassName ? ` ${scrimClassName}` : ""}`}
      onMouseDown={(e) => {
        // mousedown (not click) so releasing a text selection over the scrim
        // can't dismiss the dialog.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={cardRef}
      >
        {children}
      </div>
    </div>
  );
}
