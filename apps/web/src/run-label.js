import { sourceNames } from "./api.js";

/** @param {import('./api.js').RunSummary} run @returns {string} */
export function runLabel(run) {
  return [
    sourceNames[run.source],
    run.inputs.query ?? run.inputs.destination,
    run.inputs.location,
    run.source === "booking"
      ? `${run.inputs.checkin} to ${run.inputs.checkout}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
