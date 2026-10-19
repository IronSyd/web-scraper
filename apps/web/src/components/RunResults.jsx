import { Link, useParams } from "react-router-dom";
import { sourceNames } from "../api.js";
import { formatTime } from "../format.js";

/** @param {{run:import('../api.js').RunSummary}} props */
export function RunMetadata({ run }) {
  const { id: currentRunId } = useParams();
  return (
    <div className="run-context surface-panel">
      <p className="run-meta-heading">
        <strong>{sourceNames[run.source]}</strong> ·{" "}
        <span>
          {run.status === "succeeded"
            ? "Saved successfully"
            : run.status === "running"
              ? "Collection running"
              : "Collection failed"}
        </span>{" "}
        · {run.resultCount} {run.resultCount === 1 ? "record" : "records"}
        {run.status === "succeeded" ? " in this snapshot" : " saved"}
      </p>
      <p className="run-timestamps small text-body-secondary">
        {run.provenance === "legacy-cache"
          ? "Existing local cache. Original collection time unavailable."
          : `Started: ${formatTime(run.startedAt)}. Collected: ${formatTime(run.collectedAt)}.`}{" "}
        Saved: {formatTime(run.savedAt)}.
      </p>
      <dl className="run-inputs small mb-2">
        {Object.entries(run.inputs).map(([key, value]) => (
          <div key={key}>
            <dt>
              {{
                query:
                  run.source === "indeed"
                    ? "Job title or keyword"
                    : "Title or keyword",
                location: "Location",
                destination: "Destination",
                checkin: "Check-in",
                checkout: "Check-out",
                adults: "Adults",
                rooms: "Rooms",
              }[key] ?? key}
            </dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
      </dl>
      {run.archivedAt && (
        <p className="archive-notice">
          Archived on {formatTime(run.archivedAt)}. This run is hidden from
          active history and latest results.{" "}
          <Link to="/history?visibility=archived">View archived history</Link>
        </p>
      )}
      {run.id !== currentRunId && (
        <Link to={`/runs/${encodeURIComponent(run.id)}`} className="small">
          Open saved run
        </Link>
      )}
    </div>
  );
}

/** @param {{url:string,source:string,title:string}} props */
function SourceLink({ url, source, title }) {
  return (
    <a
      className="btn btn-outline-primary btn-sm"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`View ${title} on ${source} (opens in a new tab)`}
    >
      View on {source}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

/** @param {{run:import('../api.js').Run}} props */
export default function RunResults({ run }) {
  if (run.status !== "succeeded" || !run.data) return null;
  if (run.source === "tiobe") {
    const languages = /** @type {import('../api.js').Language[]} */ (run.data);
    return (
      <div className="table-responsive">
        <table className="table table-hover align-middle ranking-table">
          <caption className="visually-hidden">
            Top 20 programming languages in rank order
          </caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Icon</th>
              <th scope="col">Programming language</th>
            </tr>
          </thead>
          <tbody>
            {[...languages]
              .sort((a, b) => a.ranking - b.ranking)
              .map((language) => (
                <tr key={language.pLang}>
                  <th scope="row">{language.ranking}</th>
                  <td>
                    <img
                      className="language-icon"
                      src={language.imagePath}
                      width="40"
                      height="40"
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(event) => {
                        event.currentTarget.hidden = true;
                      }}
                    />
                  </td>
                  <td>{language.pLang}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (run.source === "amazon") {
    const books = /** @type {import('../api.js').Book[]} */ (run.data);
    return (
      <div className="row g-4 results-grid">
        {books.map((book) => (
          <div key={book.url} className="col-12 col-sm-6 col-xl-4 col-xxl-3">
            <article className="card h-100 book-card">
              <div className="book-image d-flex align-items-center justify-content-center p-3">
                {book.image ? (
                  <img
                    src={book.image}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(event) => {
                      event.currentTarget.hidden = true;
                    }}
                  />
                ) : (
                  <span className="text-body-secondary small">
                    Cover unavailable
                  </span>
                )}
              </div>
              <div className="card-body d-flex flex-column">
                <h3 className="h6 card-title">{book.title}</h3>
                <p className="text-body-secondary small">
                  {book.authors.length
                    ? `By ${book.authors.join(", ")}`
                    : "Author not listed"}
                </p>
                <div className="mt-auto">
                  <p className="fw-semibold book-price">
                    {book.price ?? "Price unavailable"}
                  </p>
                  <p className="small text-body-secondary mb-1">
                    {book.rating ?? "Rating unavailable"}
                  </p>
                  <p className="small text-body-secondary">
                    {book.reviews ?? "Ratings count unavailable"}
                  </p>
                  <SourceLink
                    url={book.url}
                    source="Amazon"
                    title={book.title}
                  />
                </div>
              </div>
            </article>
          </div>
        ))}
      </div>
    );
  }
  if (run.source === "indeed") {
    const jobs = /** @type {import('../api.js').Job[]} */ (run.data);
    return (
      <div className="row g-3 results-grid">
        {jobs.map((job) => (
          <div key={job.jobId} className="col-12 col-xl-6">
            <article className="card h-100 result-card">
              <div className="card-body d-flex flex-column align-items-start">
                <h3 className="h5">{job.title}</h3>
                <p className="fw-semibold mb-1">{job.company}</p>
                <p className="text-body-secondary">{job.location}</p>
                <div className="mt-auto">
                  <SourceLink url={job.url} source="Indeed" title={job.title} />
                </div>
              </div>
            </article>
          </div>
        ))}
      </div>
    );
  }
  const hotels = /** @type {import('../api.js').Hotel[]} */ (run.data);
  return (
    <div className="row g-3 results-grid">
      {hotels.map((hotel) => (
        <div key={hotel.url} className="col-12 col-xl-6">
          <article className="card h-100 result-card">
            <div className="card-body d-flex flex-column align-items-start">
              <h3 className="h5">{hotel.name}</h3>
              <p className="text-body-secondary">
                {hotel.location ?? "Location unavailable"}
              </p>
              <p className="fw-semibold">
                {hotel.price ?? "Price unavailable"}
                {hotel.currency ? ` (${hotel.currency})` : ""}
              </p>
              <p className="small mb-1">
                Rating: {hotel.rating ?? "Unavailable"}
              </p>
              <p className="small">
                {hotel.reviewCount === null
                  ? "Review count unavailable"
                  : `${hotel.reviewCount} reviews`}
              </p>
              <div className="mt-auto">
                <SourceLink
                  url={hotel.url}
                  source="Booking.com"
                  title={hotel.name}
                />
              </div>
            </div>
          </article>
        </div>
      ))}
    </div>
  );
}
