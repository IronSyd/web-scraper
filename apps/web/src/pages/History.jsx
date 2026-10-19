import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  archiveRun,
  deleteRun,
  displayError,
  fetchHistory,
  isSource,
  sourceNames,
  sources,
} from "../api.js";
import DeleteRunDialog from "../components/DeleteRunDialog.jsx";
import { ErrorState, LoadingState } from "../components/ResultState.jsx";
import RunList from "../components/RunList.jsx";
import { runLabel } from "../run-label.js";

export default function History() {
  const [params, setParams] = useSearchParams();
  const sourceParam = params.get("source") ?? "";
  const source = isSource(sourceParam) ? sourceParam : "";
  const visibility =
    params.get("visibility") === "archived" ? "archived" : "active";
  const cursor = params.get("cursor");
  const [actionError, setActionError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [revision, setRevision] = useState(0);
  const requestKey = JSON.stringify([source, cursor, visibility, revision]);
  const [history, setHistory] = useState(
    /** @type {{key:string,result:{runs:import('../api.js').RunSummary[],nextCursor:string|null}|null,error:string}|null} */ (
      null
    ),
  );
  const loading = history?.key !== requestKey;
  const result = history?.key === requestKey ? history.result : null;
  const error = history?.key === requestKey ? history.error : "";
  const [pending, setPending] = useState(
    /** @type {{id:string,action:'archive'|'restore'|'delete'}|null} */ (null),
  );
  const [deleteTarget, setDeleteTarget] = useState(
    /** @type {import('../api.js').RunSummary|null} */ (null),
  );
  const [deleteError, setDeleteError] = useState("");
  const heading = useRef(/** @type {HTMLHeadingElement|null} */ (null));
  const activeMutation = useRef(/** @type {AbortController|null} */ (null));
  const focusAfterRefresh = useRef(false);
  useEffect(() => () => activeMutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    fetchHistory(source, cursor, controller.signal, visibility)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (focusAfterRefresh.current && cursor && value.runs.length === 0) {
          setParams(
            (current) => {
              const next = new URLSearchParams(current);
              next.delete("cursor");
              return next;
            },
            { replace: true },
          );
          return;
        }
        setHistory({ key: requestKey, result: value, error: "" });
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setHistory({
            key: requestKey,
            result: null,
            error: displayError(failure),
          });
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        if (focusAfterRefresh.current) {
          heading.current?.focus({ preventScroll: true });
          focusAfterRefresh.current = false;
        }
      });
    return () => controller.abort();
  }, [source, cursor, visibility, requestKey, setParams]);

  /** @param {'source'|'visibility'} field @param {string} value */
  function changeFilter(field, value) {
    setActionError("");
    setAnnouncement("");
    const next = new URLSearchParams(params);
    next.delete("cursor");
    if (value && !(field === "visibility" && value === "active"))
      next.set(field, value);
    else next.delete(field);
    setParams(next);
  }

  /** @param {import('../api.js').RunSummary} run @param {'archive'|'restore'|'delete'} action @param {HTMLButtonElement|null} [trigger] */
  async function manageRun(run, action, trigger = null) {
    if (activeMutation.current || run.status === "running") return;
    const controller = new AbortController();
    activeMutation.current = controller;
    setPending({ id: run.id, action });
    setActionError("");
    setDeleteError("");
    setAnnouncement("");
    let succeeded = false;
    try {
      if (action === "delete") await deleteRun(run.id, controller.signal);
      else await archiveRun(run.id, action === "archive", controller.signal);
      if (controller.signal.aborted) return;
      succeeded = true;
      setDeleteTarget(null);
      setAnnouncement(
        `${runLabel(run)} ${action === "delete" ? "permanently deleted" : action === "archive" ? "archived" : "restored"}.`,
      );
      focusAfterRefresh.current = true;
      setRevision((value) => value + 1);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (action === "delete") setDeleteError(displayError(failure));
      else setActionError(displayError(failure));
    } finally {
      if (!controller.signal.aborted) {
        activeMutation.current = null;
        setPending(null);
        if (!succeeded && trigger)
          requestAnimationFrame(() => {
            if (trigger.isConnected) trigger.focus({ preventScroll: true });
          });
      }
    }
  }

  return (
    <section aria-labelledby="history-heading">
      <div className="page-heading">
        <h1 id="history-heading" ref={heading} tabIndex={-1}>
          Collection history
        </h1>
        <p className="page-intro">
          Open previous saved runs, archive them for later or permanently delete
          them. Browsing history does not collect new data.
        </p>
      </div>
      <div className="history-toolbar">
        <div className="history-filter-group">
          <label className="form-label" htmlFor="history-source">
            Source
          </label>
          <select
            id="history-source"
            className="form-select history-filter"
            value={source}
            disabled={pending !== null}
            onChange={(event) => changeFilter("source", event.target.value)}
          >
            <option value="">All sources</option>
            {sources.map((value) => (
              <option value={value} key={value}>
                {sourceNames[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="history-filter-group">
          <label className="form-label" htmlFor="history-visibility">
            Visibility
          </label>
          <select
            id="history-visibility"
            className="form-select history-filter"
            value={visibility}
            disabled={pending !== null}
            onChange={(event) => changeFilter("visibility", event.target.value)}
          >
            <option value="active">Active runs</option>
            <option value="archived">Archived runs</option>
          </select>
        </div>
      </div>
      {visibility === "archived" && (
        <p className="history-help">
          Archived runs keep their results and saved URLs. Restore a run to make
          it available in active history and latest results.
        </p>
      )}
      <p className="history-announcement" role="status" aria-atomic="true">
        {announcement}
      </p>
      {actionError && (
        <p className="alert alert-danger" role="alert">
          {actionError}
        </p>
      )}
      <div aria-busy={loading || pending !== null}>
        {loading && <LoadingState message="Loading saved history…" />}
        {error && <ErrorState title="Could not load history" message={error} />}
        {!loading && !error && result?.runs.length === 0 && (
          <div className="empty-state">
            <p className="fw-semibold">
              {cursor
                ? "No older saved runs on this page."
                : visibility === "archived"
                  ? source
                    ? `No archived runs for ${sourceNames[source]}.`
                    : "No archived runs."
                  : source
                    ? `No saved runs for ${sourceNames[source]} yet.`
                    : "No saved runs yet."}
            </p>
            <p>
              {visibility === "archived"
                ? "Archive a finished run from active history to keep it here."
                : "Choose a source to collect data when collection is enabled."}
            </p>
          </div>
        )}
        {!loading && !error && result && result.runs.length > 0 && (
          <RunList
            runs={result.runs}
            renderActions={(run) => (
              <>
                <button
                  type="button"
                  className="btn btn-outline-primary btn-sm"
                  disabled={pending !== null || run.status === "running"}
                  aria-label={`${run.archivedAt ? "Restore" : "Archive"} ${runLabel(run)}`}
                  aria-describedby={
                    run.status === "running"
                      ? `running-actions-${run.id}`
                      : undefined
                  }
                  onClick={(event) =>
                    void manageRun(
                      run,
                      run.archivedAt ? "restore" : "archive",
                      event.currentTarget,
                    )
                  }
                >
                  {pending?.id === run.id && pending.action !== "delete"
                    ? pending.action === "archive"
                      ? "Archiving…"
                      : "Restoring…"
                    : run.archivedAt
                      ? "Restore"
                      : "Archive"}
                </button>
                <button
                  type="button"
                  className="btn btn-outline-danger btn-sm"
                  disabled={pending !== null || run.status === "running"}
                  aria-label={`Delete ${runLabel(run)}`}
                  aria-describedby={
                    run.status === "running"
                      ? `running-actions-${run.id}`
                      : undefined
                  }
                  onClick={() => {
                    setDeleteError("");
                    setDeleteTarget(run);
                  }}
                >
                  Delete
                </button>
                {run.status === "running" && (
                  <span
                    id={`running-actions-${run.id}`}
                    className="history-action-help"
                  >
                    Available after collection finishes.
                  </span>
                )}
              </>
            )}
          />
        )}
      </div>
      {!loading && !error && result?.nextCursor && (
        <button
          className="btn btn-outline-primary mt-4"
          type="button"
          disabled={pending !== null}
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set("cursor", result.nextCursor ?? "");
            setParams(next);
          }}
        >
          Older runs
        </button>
      )}
      {cursor && (
        <button
          className="btn btn-link mt-4"
          type="button"
          disabled={pending !== null}
          onClick={() => {
            const next = new URLSearchParams(params);
            next.delete("cursor");
            setParams(next);
          }}
        >
          Newest runs
        </button>
      )}
      {deleteTarget && (
        <DeleteRunDialog
          run={deleteTarget}
          pending={pending?.action === "delete"}
          error={deleteError}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void manageRun(deleteTarget, "delete")}
        />
      )}
    </section>
  );
}
