import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { displayError, fetchLatest, isSource, sourceNames } from "../api.js";
import CollectionForm from "../components/CollectionForm.jsx";
import RunResults, { RunMetadata } from "../components/RunResults.jsx";
import { ErrorState, LoadingState } from "../components/ResultState.jsx";

/** @param {{source:import('../api.js').Source}} props */
function SourceView({ source }) {
  const [run, setRun] = useState(
    /** @type {import('../api.js').Run|null} */ (null),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetchLatest(source, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setRun(value);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(displayError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [source]);
  return (
    <section aria-labelledby="source-heading">
      <div className="page-heading">
        <h1 id="source-heading">{sourceNames[source]}</h1>
        <p className="page-intro">
          {source === "tiobe"
            ? "The top 20 programming languages in a saved index."
            : source === "amazon"
              ? "Collect book results by title, author or keyword."
              : source === "indeed"
                ? "Collect job results for a keyword and location."
                : "Collect hotel results for a destination and stay."}
        </p>
      </div>
      {!loading && !error && (
        <CollectionForm source={source} previous={run} onPending={setPending} />
      )}
      <section
        className="results-section"
        aria-labelledby="saved-results-heading"
        aria-busy={loading || pending}
      >
        <div className="section-heading">
          <h2 id="saved-results-heading">
            {pending ? "Previous saved results" : "Latest saved results"}
          </h2>
          <Link to={`/history?source=${source}`}>
            View {sourceNames[source]} history
          </Link>
        </div>
        {loading && <LoadingState message="Loading saved results…" />}
        {error && <ErrorState message={error} />}
        {run && (
          <>
            <RunMetadata run={run} />
            <RunResults run={run} />
          </>
        )}
        {!loading && !error && !run && (
          <div className="empty-state surface-panel">
            <p className="fw-semibold">No saved results for this source yet.</p>
            <p>Collect fresh data when collection is enabled.</p>
          </div>
        )}
      </section>
    </section>
  );
}
export default function Source() {
  const { source } = useParams();
  return isSource(source) ? (
    <SourceView key={source} source={source} />
  ) : (
    <section className="page-heading">
      <h1>Source not found</h1>
      <p className="page-intro">Choose one of the four available collectors.</p>
      <Link to="/">Return to Overview</Link>
    </section>
  );
}
