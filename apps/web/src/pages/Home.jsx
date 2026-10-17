import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { displayError, fetchHistory, sourceNames, sources } from "../api.js";
import { ErrorState, LoadingState } from "../components/ResultState.jsx";
import RunList from "../components/RunList.jsx";
import SourceIcon from "../components/SourceIcon.jsx";

const descriptions = {
  amazon: "Find books by title, author or keyword.",
  booking: "Explore places to stay for a destination and dates.",
  indeed: "Find job listings by keyword and location.",
  tiobe: "Review the top 20 programming-language rankings.",
};

export default function Home() {
  const [runs, setRuns] = useState(
    /** @type {import('../api.js').RunSummary[]|null} */ (null),
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetchHistory("", null, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setRuns(result.runs.slice(0, 5));
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(displayError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="home-content">
      <div className="page-heading">
        <h1>Overview</h1>
        <p className="page-intro">
          Collect, clean and save web data. Pick a source or return to your
          saved work.
        </p>
      </div>

      <section aria-labelledby="collectors-heading">
        <div className="section-heading">
          <h2 id="collectors-heading">Collectors</h2>
          <p>Four sources, one place for your saved results.</p>
        </div>
        <ul className="collector-list">
          {sources.map((source) => (
            <li key={source}>
              <Link
                to={`/sources/${source}`}
                className="collector-entry"
                aria-label={`Open ${sourceNames[source]} collector`}
              >
                <span className="collector-icon">
                  <SourceIcon name={source} size={24} />
                </span>
                <span className="collector-copy">
                  <span className="collector-title">{sourceNames[source]}</span>
                  <span className="collector-description">
                    {descriptions[source]}
                  </span>
                </span>
                <span className="collector-link">
                  <SourceIcon name="arrow" size={20} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="recent-runs-heading" className="recent-runs">
        <div className="section-heading">
          <div>
            <h2 id="recent-runs-heading">Recent runs</h2>
            <p>Your five most recent saved requests.</p>
          </div>
          <Link to="/history">View all history</Link>
        </div>
        <div aria-busy={loading}>
          {loading && <LoadingState message="Loading recent runs…" />}
          {error && (
            <ErrorState title="Could not load recent runs" message={error} />
          )}
          {!loading && !error && runs?.length === 0 && (
            <div className="empty-state">
              <p className="fw-semibold">No saved runs yet.</p>
              <p>
                Choose a collector to begin when fresh collection is enabled.
              </p>
            </div>
          )}
          {!loading && !error && runs && runs.length > 0 && (
            <RunList runs={runs} />
          )}
        </div>
      </section>
    </div>
  );
}
