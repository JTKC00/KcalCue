"use client";

import { useEffect, useId, useRef } from "react";

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export function ConfirmDialog({
  request,
  onResolve,
}: {
  request: ConfirmRequest | null;
  onResolve: (accepted: boolean) => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onResolve(false);
        return;
      }
      if (event.key === "Tab") {
        const cancel = cancelRef.current;
        const confirm = confirmRef.current;
        if (!cancel || !confirm) return;
        if (event.shiftKey && document.activeElement === cancel) {
          event.preventDefault();
          confirm.focus();
        } else if (!event.shiftKey && document.activeElement === confirm) {
          event.preventDefault();
          cancel.focus();
        }
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Node && dialogRef.current && !dialogRef.current.contains(target)) {
        cancelRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [request, onResolve]);

  if (!request) return null;

  return (
    <div
      className="confirm-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onResolve(false);
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <h2 id={titleId} className="confirm-dialog-title">
          {request.title}
        </h2>
        <p id={messageId} className="confirm-dialog-message">
          {request.message}
        </p>
        <div className="confirm-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="button button-secondary"
            onClick={() => onResolve(false)}
          >
            {request.cancelLabel ?? "取消"}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={request.destructive ? "button button-primary" : "button button-secondary"}
            onClick={() => onResolve(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
