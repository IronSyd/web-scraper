import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { displayError, fetchLatest, fetchRun, sourceNames } from "../api.js";
import RunResults, { RunMetadata } from "../components/RunResults.jsx";
import { ErrorState, LoadingState } from "../components/ResultState.jsx";

function RunView() {
  const { id = "" } = useParams();
  const [run, setRun] = useState(
    /** @type {import('../api.js').Run|null} */ (null),
  );
  const [previous, setPrevious] = useState(
    /** @type {import('../api.js').Run|null} */ (null),
  );
  const [previousLoading, setPreviousLoading] = useState(true);
  const [previousError, setPreviousError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const previousController = new AbortController();
    let previousPending = false;
    let timer = /** @type {ReturnType<typeof setTimeout>|undefined} */ (
      undefined
    );
    /** @param {import('../api.js').Source} source */
    async function loadPrevious(source) {
      if (previousPending || previousController.signal.aborted) return;
      previousPending = true;
      try {
        const saved = await fetchLatest(source, previousController.signal);
        if (!previousController.signal.aborted) {
          setPrevious(saved);
          setPreviousError("");
        }
      } catch (failure) {
        if (!previousController.signal.aborted)
          setPreviousError(displayError(failure));
      } finally {
        previousPending = false;
        if (!previousController.signal.aborted) setPreviousLoading(false);
      }
    }
    async function load() {
      try {
        const current = await fetchRun(id, controller.signal);
        if (controller.signal.aborted) return;
        setRun(current);
        setError("");
        setLoading(false);
        if (current.status !== "succeeded") {
          // Previous results must not delay or stop the current run's status reads.
          void loadPrevious(current.source);
        } else {
          previousController.abort();
          setPrevious(null);
          setPreviousError("");
          setPreviousLoading(false);
        }
        if (!controller.signal.aborted && current.status === "running")
          timer = setTimeout(load, 1500);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(displayError(failure));
          setLoading(false);
          setPreviousLoading(false);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      previousController.abort();
      clearTimeout(timer);
    };
  }, [id]);
  return (
    <section aria-labelledby="run-heading">
      <div className="page-heading">
        <h1 id="run-heading">
          Saved run{run ? ` · ${sourceNames[run.source]}` : ""}
        </h1>
        <p className="page-intro">
          This URL reopens the saved request without collecting again.
        </p>
      </div>
      {loading && <LoadingState message="Loading saved run…" />}
      {error && <ErrorState message={error} />}
      <div aria-busy={run?.status === "running"}>
        {run && (
          <>
            <RunMetadata run={run} />
            {run.status === "running" && (
              <p className="alert alert-info" role="status">
                Collection is running. This page checks saved status only; no
                new collection is requested.
              </p>
            )}
            {run.status === "failed" && (
              <ErrorState
                title="Collection did not finish"
                message={
                  run.error?.code === "RUN_INTERRUPTED"
                    ? "Collection was interrupted. Previous successful results are retained. Review the inputs before collecting again."
                    : "This collection did not finish successfully. Previous successful results are retained. Check the local API before collecting again."
                }
              />
            )}
            <section
              className="results-section"
              aria-labelledby="run-results-heading"
            >
              <div className="section-heading">
                <h2 id="run-results-heading">
                  {run.status === "succeeded"
                    ? "Saved results"
                    : "Previous successful results"}
                </h2>
              </div>
              <RunResults run={run} />
              {previous && run.status !== "succeeded" && (
                <>
                  <RunMetadata run={previous} />
                  <RunResults run={previous} />
                </>
              )}
              {previousLoading && run.status !== "succeeded" && (
                <p role="status">Loading previous successful results…</p>
              )}
              {previousError && run.status !== "succeeded" && (
                <ErrorState
                  title="Could not load previous successful results"
                  message={previousError}
                />
              )}
              {!previous &&
                !previousLoading &&
                !previousError &&
                !error &&
                run.status !== "succeeded" && (
                  <div className="empty-state surface-panel">
                    <p>
                      No previous successful results are available for this
                      source.
                    </p>
                  </div>
                )}
            </section>
            <p className="page-actions">
              <Link to={`/sources/${run.source}`}>
                Open {sourceNames[run.source]} collection
              </Link>
            </p>
          </>
        )}
      </div>
      <Link to="/history">View all history</Link>
    </section>
  );
}

export default function Run() {
  const { id } = useParams();
  return <RunView key={id} />;
}
