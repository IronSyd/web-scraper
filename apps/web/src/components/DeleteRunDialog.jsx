import { useEffect, useRef } from "react";
import { formatTime } from "../format.js";
import { runLabel } from "../run-label.js";

/** @param {{run:import('../api.js').RunSummary,pending:boolean,error:string,onCancel:()=>void,onConfirm:()=>void}} props */
export default function DeleteRunDialog({
  run,
  pending,
  error,
  onCancel,
  onConfirm,
}) {
  const dialog = useRef(/** @type {HTMLDialogElement|null} */ (null));
  const cancel = useRef(/** @type {HTMLButtonElement|null} */ (null));
  const confirm = useRef(/** @type {HTMLButtonElement|null} */ (null));
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    cancel.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (error && !pending) cancel.current?.focus({ preventScroll: true });
    if (pending) dialog.current?.focus({ preventScroll: true });
  }, [error, pending]);
  return (
    <dialog
      ref={dialog}
      className="history-delete-dialog"
      tabIndex={-1}
      aria-labelledby="delete-run-heading"
      aria-describedby="delete-run-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        if (pending) {
          event.preventDefault();
          return;
        }
        const first = cancel.current;
        const last = confirm.current;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === dialog.current)
        ) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <h2 id="delete-run-heading">Delete saved run?</h2>
      <p className="delete-run-identity">{runLabel(run)}</p>
      <p className="text-body-secondary">Saved: {formatTime(run.savedAt)}.</p>
      <p id="delete-run-description">
        Permanently remove this saved request and its {run.resultCount}{" "}
        {run.resultCount === 1 ? "record" : "records"}. Its saved URL will no
        longer open the results. This cannot be undone.
      </p>
      {error && (
        <p className="alert alert-danger" role="alert">
          {error}
        </p>
      )}
      <div className="delete-run-actions" aria-busy={pending}>
        <button
          ref={cancel}
          type="button"
          className="btn btn-outline-primary"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          ref={confirm}
          type="button"
          className="btn btn-danger"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "Deleting…" : "Delete permanently"}
        </button>
      </div>
      <p className="visually-hidden" role="status">
        {pending ? "Deleting this saved run. Please wait." : ""}
      </p>
    </dialog>
  );
}
