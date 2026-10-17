import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createRun,
  displayError,
  fetchCollectionEnabled,
  sourceNames,
  validateInputs,
} from "../api.js";

/** @param {import('../api.js').Source} source @returns {import('../api.js').Inputs} */
function blankInputs(source) {
  if (source === "amazon") return { query: "" };
  if (source === "indeed") return { query: "", location: "" };
  if (source === "booking")
    return {
      destination: "",
      checkin: "",
      checkout: "",
      adults: "",
      rooms: "",
    };
  return {};
}

/** @param {unknown} value */
function validTravelDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

/** @param {unknown} value */
function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** @param {{source:import('../api.js').Source,previous:import('../api.js').Run|null, onPending:(pending:boolean)=>void}} props */
export default function CollectionForm({ source, previous, onPending }) {
  const [inputs, setInputs] = useState(
    () => previous?.inputs ?? blankInputs(source),
  );
  const [enabled, setEnabled] = useState(/** @type {boolean|null} */ (null));
  const [availabilityFailed, setAvailabilityFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [validation, setValidation] = useState("");
  const [invalidField, setInvalidField] = useState("");
  const [attemptId, setAttemptId] = useState("");
  const formRef = useRef(/** @type {HTMLFormElement|null} */ (null));
  const requestRef = useRef(/** @type {AbortController|null} */ (null));
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    fetchCollectionEnabled(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setEnabled(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAvailabilityFailed(true);
      });
    return () => {
      controller.abort();
      requestRef.current?.abort();
    };
  }, []);

  /** @param {import('react').FormEvent<HTMLFormElement>} event */
  async function submit(event) {
    event.preventDefault();
    if (pending || requestRef.current || !enabled) return;
    const normalized = Object.fromEntries(
      Object.entries(inputs).map(([key, value]) => [
        key,
        ["adults", "rooms"].includes(key)
          ? Number(value)
          : typeof value === "string"
            ? value.trim()
            : value,
      ]),
    );
    const invalid = validateInputs(source, normalized);
    if (invalid) {
      setValidation(invalid);
      const field = invalid.startsWith("Location")
        ? "location"
        : invalid.startsWith("Destination")
          ? "destination"
          : invalid.startsWith("Check-out")
            ? "checkout"
            : invalid.startsWith("Enter valid")
              ? validTravelDate(normalized.checkin)
                ? "checkout"
                : "checkin"
              : invalid.startsWith("Adults")
                ? positiveInteger(normalized.adults)
                  ? "rooms"
                  : "adults"
                : "query";
      setInvalidField(field);
      const invalidInput = formRef.current?.querySelector(
        `input[name="${field}"]`,
      );
      if (invalidInput instanceof HTMLInputElement) invalidInput.focus();
      return;
    }
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    requestRef.current = controller;
    setAttemptId(requestId);
    setValidation("");
    setError("");
    setPending(true);
    onPending(true);
    try {
      await createRun(source, normalized, requestId, controller.signal);
      if (!controller.signal.aborted) navigate(`/runs/${requestId}`);
    } catch (failure) {
      if (!controller.signal.aborted) setError(displayError(failure));
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) {
        setPending(false);
        onPending(false);
      }
    }
  }
  const fields =
    source === "amazon"
      ? [["query", "Title or keyword", "search"]]
      : source === "indeed"
        ? [
            ["query", "Job title or keyword", "search"],
            ["location", "Location", "text"],
          ]
        : source === "booking"
          ? [
              ["destination", "Destination", "text"],
              ["checkin", "Check-in", "date"],
              ["checkout", "Check-out", "date"],
              ["adults", "Adults", "number"],
              ["rooms", "Rooms", "number"],
            ]
          : [];
  return (
    <form
      ref={formRef}
      onSubmit={submit}
      noValidate
      className="collection-form surface-panel"
      aria-labelledby="collection-form-heading"
    >
      <div className="form-heading">
        <h2 id="collection-form-heading">New collection</h2>
        <p>
          {source === "tiobe"
            ? "Request a fresh snapshot of the current index."
            : "Set your inputs for a separate, fresh request."}
        </p>
      </div>
      <div className="row g-3">
        {fields.map(([key, label, type]) => (
          <div
            key={key}
            className={
              source === "booking" && key !== "destination"
                ? "col-6 col-md-3"
                : source === "indeed"
                  ? "col-12 col-md-6"
                  : "col-12"
            }
          >
            <label
              htmlFor={`collect-${key}`}
              className="form-label fw-semibold"
            >
              {label}
            </label>
            <input
              id={`collect-${key}`}
              name={key}
              className={`form-control${validation && invalidField === key ? " is-invalid" : ""}`}
              type={type}
              value={inputs[key] ?? ""}
              onChange={(event) => {
                setInputs({ ...inputs, [key]: event.target.value });
                setValidation("");
              }}
              required
              disabled={pending}
              {...(type === "number"
                ? { min: 1, step: 1 }
                : type === "date"
                  ? {}
                  : { maxLength: 200 })}
              aria-invalid={
                validation && invalidField === key ? true : undefined
              }
              aria-describedby={`collection-help${validation && invalidField === key ? " collection-error" : ""}`}
            />
          </div>
        ))}
      </div>
      {validation && (
        <p id="collection-error" className="text-danger mt-2" role="alert">
          {validation}
        </p>
      )}
      <p id="collection-help" className="form-text mt-3">
        {source === "tiobe"
          ? "Fresh collection requests the current TIOBE index."
          : `Fresh collection requests new data from ${sourceNames[source]} and uses provider allowance.`}{" "}
        Saved results can be reopened without collecting again.
      </p>
      <button
        className="btn btn-primary"
        type="submit"
        disabled={!enabled || pending}
        aria-describedby={`collection-help${enabled !== true ? " collection-availability" : ""}`}
      >
        {pending ? "Starting collection…" : "Collect fresh data"}
      </button>
      {enabled !== true && (
        <p
          id="collection-availability"
          className="small text-body-secondary mt-2 mb-0"
          role="status"
        >
          {availabilityFailed
            ? "Collection availability could not be verified. Check the local API. Saved results remain available below."
            : enabled === null
              ? "Checking collection availability…"
              : "Fresh collection is disabled. Saved results and history remain available."}
        </p>
      )}
      {pending && (
        <p className="mt-3 mb-0" role="status">
          Starting one collection. Previous saved results remain below.
        </p>
      )}
      {error && (
        <div className="alert alert-danger mt-3" role="alert">
          <p>{error}</p>
          <Link to={`/runs/${attemptId}`}>Check this request’s saved run</Link>
          <p className="small mb-0 mt-2">No automatic retry was made.</p>
        </div>
      )}
    </form>
  );
}
