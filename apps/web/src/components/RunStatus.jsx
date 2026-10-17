/** @param {{status:'running'|'succeeded'|'failed'}} props */
export default function RunStatus({ status }) {
  return (
    <span className={`run-status run-status--${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {status === "succeeded"
        ? "Succeeded"
        : status === "running"
          ? "Running"
          : "Failed"}
    </span>
  );
}
