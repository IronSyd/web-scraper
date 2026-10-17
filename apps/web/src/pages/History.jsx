import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  displayError,
  fetchHistory,
  isSource,
  sourceNames,
  sources,
} from "../api.js";
import { ErrorState, LoadingState } from "../components/ResultState.jsx";
import RunList from "../components/RunList.jsx";

function HistoryView() {
  const [params, setParams] = useSearchParams();
  const sourceParam = params.get("source") ?? "";
  const source = isSource(sourceParam) ? sourceParam : "";
  const cursor = params.get("cursor");
  const [result, setResult] = useState(
    /** @type {{runs:import('../api.js').RunSummary[],nextCursor:string|null}|null} */ (
      null
    ),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetchHistory(source, cursor, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setResult(value);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(displayError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [source, cursor]);
  return (
    <section aria-labelledby="history-heading">
      <div className="page-heading">
        <h1 id="history-heading">Collection history</h1>
        <p className="page-intro">
          Open previous saved runs. Browsing history does not collect new data.
        </p>
      </div>
      <div className="history-toolbar">
        <label className="form-label fw-semibold" htmlFor="history-source">
          Source
        </label>
        <select
          id="history-source"
          className="form-select history-filter"
          value={source}
          onChange={(event) => {
            setParams(event.target.value ? { source: event.target.value } : {});
          }}
        >
          <option value="">All sources</option>
          {sources.map((value) => (
            <option value={value} key={value}>
              {sourceNames[value]}
            </option>
          ))}
        </select>
      </div>
      <div aria-busy={loading}>
        {loading && <LoadingState message="Loading saved history…" />}
        {error && <ErrorState title="Could not load history" message={error} />}
        {!loading && !error && result?.runs.length === 0 && (
          <div className="empty-state">
            <p className="fw-semibold">
              {cursor
                ? "No older saved runs on this page."
                : source
                  ? `No saved runs for ${sourceNames[source]} yet.`
                  : "No saved runs yet."}
            </p>
            <p>Choose a source to collect data when collection is enabled.</p>
          </div>
        )}
        {!loading && !error && result && result.runs.length > 0 && (
          <RunList runs={result.runs} />
        )}
      </div>
      {result?.nextCursor && (
        <button
          className="btn btn-outline-primary mt-4"
          type="button"
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
          onClick={() => {
            const next = new URLSearchParams(params);
            next.delete("cursor");
            setParams(next);
          }}
        >
          Newest runs
        </button>
      )}
    </section>
  );
}

export default function History() {
  const [params] = useSearchParams();
  return <HistoryView key={params.toString()} />;
}
