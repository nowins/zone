import { useEffect, useRef } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import type { FormEvent, ReactNode } from "react";

/**
 * Shared dialog shell: dimmed overlay + rotated-in box with the standard
 * kicker/title chrome, an optional right-aligned actions row, Escape and
 * backdrop-cancel handling. Keeps the playlist-dialog-overlay/playlist-dialog
 * base classes so the motion.css swivel entrance and Presence exit keep
 * applying; callers pass extra classes for layout (metadata-dialog,
 * podcast-queue-dialog, ...). While busy, Escape and backdrop cancel are
 * blocked so a running action cannot be interrupted by accident.
 *
 * The smart-playlist editor is deliberately not built on this shell (it is an
 * editor surface, not a confirm/form dialog), and the now-playing save dialog
 * keeps its own light theme.
 */
export function Dialog({
  titleId,
  kicker,
  title,
  className,
  overlayClassName,
  onCancel,
  onSubmit,
  busy = false,
  actions,
  actionsClassName,
  children,
}: {
  titleId: string;
  kicker: string;
  title: ReactNode;
  className?: string;
  overlayClassName?: string;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  busy?: boolean;
  actions?: ReactNode;
  actionsClassName?: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  useModalFocus(dialogRef);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const dialogs=document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if(dialogs[dialogs.length-1]!==dialogRef.current)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onCancel]);

  const overlayClasses = ["playlist-dialog-overlay", overlayClassName].filter(Boolean).join(" ");
  const boxClasses = ["playlist-dialog", className].filter(Boolean).join(" ");

  return (
    <div
      className={overlayClasses}
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <form
        ref={dialogRef}
        tabIndex={-1}
        className={boxClasses}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="playlist-dialog-kicker">{kicker}</span>
        <h2 id={titleId}>{title}</h2>
        {children}
        {actions ? (
          <div className={["playlist-dialog-actions", actionsClassName].filter(Boolean).join(" ")}>
            {actions}
          </div>
        ) : null}
      </form>
    </div>
  );
}
