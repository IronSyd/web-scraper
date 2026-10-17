import { Link } from "react-router-dom";
import { sourceNames } from "../api.js";
import { formatTime } from "../format.js";
import RunStatus from "./RunStatus.jsx";
import SourceIcon from "./SourceIcon.jsx";

/** @param {{run:import('../api.js').RunSummary}} props */
function RunContext({ run }) {
  if (run.source === "booking")
    return (
      <span className="activity-context">
        {run.inputs.checkin} to {run.inputs.checkout} · {run.inputs.adults}{" "}
        {run.inputs.adults === 1 ? "adult" : "adults"} · {run.inputs.rooms}{" "}
        {run.inputs.rooms === 1 ? "room" : "rooms"}
      </span>
    );
  if (run.source === "indeed")
    return <span className="activity-context">{run.inputs.location}</span>;
  if (run.source === "tiobe")
    return (
      <span className="activity-context">Programming-language rankings</span>
    );
  return <span className="activity-context">Book search</span>;
}

/** @param {{runs:import('../api.js').RunSummary[]}} props */
export default function RunList({ runs }) {
  return (
    <ol className="activity-list history-list">
      {runs.map((run) => {
        const timestamp =
          run.savedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt;
        const timeLabel = run.savedAt
          ? "Saved"
          : run.completedAt
            ? "Completed"
            : run.startedAt
              ? "Started"
              : "Created";
        return (
          <li className="activity-row" key={run.id}>
            <span className="activity-kind">
              <SourceIcon name={run.source} size={20} />
            </span>
            <div className="activity-summary">
              <Link
                className="activity-source"
                to={`/runs/${encodeURIComponent(run.id)}`}
              >
                {sourceNames[run.source]}
                {run.inputs.query
                  ? ` · ${run.inputs.query}`
                  : run.inputs.destination
                    ? ` · ${run.inputs.destination}`
                    : ""}
              </Link>
              <RunContext run={run} />
              {run.provenance === "legacy-cache" && (
                <span className="activity-context">
                  Existing cache; original collection time unavailable
                </span>
              )}
            </div>
            <div className="activity-outcome">
              <RunStatus status={run.status} />
              <span className="activity-count">
                {run.resultCount} {run.resultCount === 1 ? "record" : "records"}
                {run.status === "succeeded" ? " in snapshot" : " saved"}
              </span>
            </div>
            <div className="activity-time">
              <span>{timestamp ? timeLabel : "Saved time"}</span>
              {timestamp ? (
                <time dateTime={timestamp}>{formatTime(timestamp)}</time>
              ) : (
                <span>Unavailable</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
