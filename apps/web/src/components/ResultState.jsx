/** @param {{message: string,title?:string}} props */
export function ErrorState({ message, title = "Could not load results" }) {
  return (
    <div className="alert alert-danger" role="alert">
      <p className="h6 fw-bold">{title}</p>
      <p className="mb-0">{message}</p>
    </div>
  );
}

/** @param {{message: string}} props */
export function LoadingState({ message }) {
  return (
    <div className="loading-state" role="status">
      <p className="mb-3">{message}</p>
      <div className="loading-lines" aria-hidden="true">
        <span className="placeholder col-8 mb-3 d-block" />
        <span className="placeholder col-12 mb-3 d-block" />
        <span className="placeholder col-10 d-block" />
      </div>
    </div>
  );
}

/** @param {{source: 'collection'|'cache', target: string}} props */
export function Provenance({ source, target }) {
  return (
    <p className="text-body-secondary small mb-3">
      {source === "cache"
        ? "Loaded from local cache."
        : `Collected from ${target}.`}
      {source === "cache" ? " Cached data may be older than the source." : ""}
    </p>
  );
}
