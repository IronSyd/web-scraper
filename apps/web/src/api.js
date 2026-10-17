/** @typedef {'amazon'|'booking'|'indeed'|'tiobe'} Source */
/** @typedef {{ranking: number, pLang: string, imagePath: string}} Language */
/** @typedef {{searchTerm: string, title: string, authors: string[], url: string, price: string|null, rating: string|null, reviews: string|null, image: string|null}} Book */
/** @typedef {{jobId: string, title: string, company: string, location: string, url: string}} Job */
/** @typedef {{name: string, url: string, price: string|null, currency: string|null, rating: string|null, reviewCount: number|null, location: string|null}} Hotel */
/** @typedef {Record<string, string|number>} Inputs */
/** @typedef {{id:string,source:Source,inputs:Inputs,status:'running'|'succeeded'|'failed',provenance:'collection'|'legacy-cache',createdAt:string|null,startedAt:string|null,completedAt:string|null,collectedAt:string|null,savedAt:string|null,resultCount:number,data:(Book|Language|Job|Hotel)[]|null,error:{code:string,message:string}|null}} Run */
/** @typedef {Omit<Run,'data'>} RunSummary */
/** @typedef {{id:string,source:Source}} ActiveRun */
/** @type {Set<(event:{run:Run,admitted:boolean})=>void>} */
const collectionListeners = new Set();
/** @param {(event:{run:Run,admitted:boolean})=>void} listener */
export function subscribeCollectionRuns(listener) {
  collectionListeners.add(listener);
  return () => {
    collectionListeners.delete(listener);
  };
}
/** @param {Run} run @param {boolean} admitted */
function publishCollectionRun(run, admitted) {
  for (const listener of collectionListeners) listener({ run, admitted });
}
export const sources = /** @type {const} */ ([
  "amazon",
  "booking",
  "indeed",
  "tiobe",
]);
export const sourceNames = {
  amazon: "Amazon",
  booking: "Booking.com",
  indeed: "Indeed",
  tiobe: "TIOBE Index",
};
/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is Source} */
export function isSource(value) {
  return sources.some((source) => source === value);
}
/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}
/** @param {unknown} value @returns {value is string|null} */
function optionalText(value) {
  return value === null || text(value);
}
/** @param {unknown} value @returns {value is string|null} */
function date(value) {
  return (
    value === null ||
    (typeof value === "string" &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value)
  );
}
/** @param {unknown} value @returns {URL|null} */
function safeUrl(value) {
  if (!text(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
      ? url
      : null;
  } catch {
    return null;
  }
}
/** @param {unknown} value @returns {value is Book} */
function isBook(value) {
  if (!isRecord(value)) return false;
  const url = safeUrl(value.url),
    image = value.image === null ? null : safeUrl(value.image);
  return (
    text(value.searchTerm) &&
    text(value.title) &&
    Array.isArray(value.authors) &&
    value.authors.every(text) &&
    url !== null &&
    url.hostname === "www.amazon.com" &&
    /^\/dp\/[A-Z0-9]{10}$/.test(url.pathname) &&
    !url.search &&
    !url.hash &&
    optionalText(value.price) &&
    optionalText(value.rating) &&
    optionalText(value.reviews) &&
    (value.image === null ||
      (image !== null && image.hostname === "m.media-amazon.com"))
  );
}
/** @param {unknown} value @returns {value is Language} */
function isLanguage(value) {
  if (!isRecord(value)) return false;
  const image = safeUrl(value.imagePath);
  return (
    typeof value.ranking === "number" &&
    Number.isInteger(value.ranking) &&
    value.ranking >= 1 &&
    value.ranking <= 20 &&
    text(value.pLang) &&
    image !== null &&
    ["www.tiobe.com", "tiobe.com"].includes(image.hostname)
  );
}
/** @param {unknown} value @returns {value is Job} */
function isJob(value) {
  if (!isRecord(value)) return false;
  const url = safeUrl(value.url);
  return (
    text(value.jobId) &&
    /^[A-Za-z0-9]{8,64}$/.test(value.jobId) &&
    text(value.title) &&
    text(value.company) &&
    text(value.location) &&
    url !== null &&
    url.hostname === "www.indeed.com" &&
    url.pathname === "/viewjob" &&
    url.search === "?jk=" + value.jobId &&
    !url.hash
  );
}
/** @param {unknown} value @returns {value is Hotel} */
function isHotel(value) {
  if (!isRecord(value)) return false;
  const url = safeUrl(value.url);
  return (
    text(value.name) &&
    url !== null &&
    url.hostname === "www.booking.com" &&
    /^\/hotel\/[a-z]{2}\/[^/]+\.html$/.test(url.pathname) &&
    !url.hash &&
    optionalText(value.price) &&
    (value.currency === null ||
      (typeof value.currency === "string" &&
        /^[A-Z]{3}$/.test(value.currency))) &&
    optionalText(value.rating) &&
    optionalText(value.location) &&
    (value.reviewCount === null ||
      (typeof value.reviewCount === "number" &&
        Number.isSafeInteger(value.reviewCount) &&
        value.reviewCount >= 0))
  );
}
/** @param {Source} source @param {Inputs} inputs @returns {string|null} */
export function validateInputs(source, inputs) {
  const fields =
    source === "amazon"
      ? ["query"]
      : source === "indeed"
        ? ["query", "location"]
        : source === "booking"
          ? ["destination"]
          : [];
  for (const field of fields) {
    const value = inputs[field];
    if (
      typeof value !== "string" ||
      value.trim().length < 1 ||
      value.trim().length > 200 ||
      Array.from(value).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return (
        (field === "query"
          ? "Title or keyword"
          : field === "location"
            ? "Location"
            : "Destination") + " must contain 1–200 printable characters."
      );
  }
  if (source === "booking") {
    for (const field of ["checkin", "checkout"]) {
      const value = inputs[field];
      if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
      )
        return "Enter valid check-in and check-out dates.";
    }
    if (String(inputs.checkout) <= String(inputs.checkin))
      return "Check-out must be later than check-in.";
    if (
      ![inputs.adults, inputs.rooms].every(
        (value) =>
          typeof value === "number" && Number.isSafeInteger(value) && value > 0,
      )
    )
      return "Adults and rooms must be positive whole numbers.";
  }
  return null;
}
/** @param {unknown} value @param {boolean} [summary] @returns {value is Run} */
function isRun(value, summary = false) {
  if (
    !isRecord(value) ||
    !text(value.id) ||
    !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|legacy-[A-Za-z0-9_-]+)$/i.test(
      value.id,
    ) ||
    !isSource(value.source) ||
    !isRecord(value.inputs)
  )
    return false;
  if (
    !Object.values(value.inputs).every(
      (entry) => typeof entry === "string" || typeof entry === "number",
    )
  )
    return false;
  const inputs = /** @type {Inputs} */ (value.inputs);
  const expected =
    value.source === "amazon"
      ? ["query"]
      : value.source === "indeed"
        ? ["location", "query"]
        : value.source === "booking"
          ? ["adults", "checkin", "checkout", "destination", "rooms"]
          : [];
  if (
    Object.keys(inputs).sort().join() !== expected.join() ||
    validateInputs(value.source, inputs)
  )
    return false;
  if (
    !["running", "succeeded", "failed"].includes(String(value.status)) ||
    !["collection", "legacy-cache"].includes(String(value.provenance)) ||
    ![
      value.createdAt,
      value.startedAt,
      value.completedAt,
      value.collectedAt,
      value.savedAt,
    ].every(date) ||
    typeof value.resultCount !== "number" ||
    !Number.isSafeInteger(value.resultCount) ||
    value.resultCount < 0
  )
    return false;
  if (value.status === "failed") {
    if (
      !isRecord(value.error) ||
      !text(value.error.code) ||
      !text(value.error.message)
    )
      return false;
  } else if (value.error !== null) return false;
  if (value.status !== "succeeded")
    return value.resultCount === 0 && (summary || value.data === null);
  if (value.resultCount < 1) return false;
  if (summary) return true;
  if (!Array.isArray(value.data) || value.data.length !== value.resultCount)
    return false;
  if (value.source === "amazon")
    return (
      value.data.every(isBook) &&
      value.data.every((book) => book.searchTerm === inputs.query) &&
      new Set(value.data.map((book) => book.url)).size === value.data.length
    );
  if (value.source === "indeed")
    return (
      value.data.every(isJob) &&
      new Set(value.data.map((job) => job.jobId)).size === value.data.length
    );
  if (value.source === "booking")
    return (
      value.data.every(isHotel) &&
      value.data.every((hotel) => {
        const url = new URL(hotel.url);
        const expected = {
          checkin: inputs.checkin,
          checkout: inputs.checkout,
          group_adults: inputs.adults,
          no_rooms: inputs.rooms,
        };
        return (
          url.searchParams.size === 4 &&
          Object.entries(expected).every(
            ([key, expectedValue]) =>
              url.searchParams.getAll(key).length === 1 &&
              url.searchParams.get(key) === String(expectedValue),
          )
        );
      }) &&
      new Set(value.data.map((hotel) => new URL(hotel.url).pathname)).size ===
        value.data.length
    );
  return (
    value.data.length === 20 &&
    value.data.every(isLanguage) &&
    new Set(value.data.map((language) => language.ranking)).size === 20 &&
    new Set(value.data.map((language) => language.pLang)).size === 20
  );
}
export class DataError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "DataError";
  }
}
/** @param {number} status @returns {string} */
function failureMessage(status) {
  if (status === 400)
    return "The request was not accepted. Check the inputs and try again.";
  if (status === 404)
    return "This saved run was not found. Open History to choose another run.";
  if (status === 409)
    return "Another collection is running, or this request has already been used. Check History before collecting again.";
  if (status === 503)
    return "Collection or saved storage is unavailable. Check the local API before trying again.";
  if (status === 504)
    return "Collection timed out. Check History for the saved outcome before collecting again.";
  return "The request could not finish. Check History and the local API before trying again.";
}
/** @param {string} path @param {AbortSignal} signal @param {unknown} [body] @returns {Promise<unknown>} */
async function request(path, signal, body) {
  let response;
  try {
    response = await fetch(path, {
      signal,
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new DataError(
      "Cannot reach the local API. Check History before collecting again.",
    );
  }
  if (!response.ok) throw new DataError(failureMessage(response.status));
  try {
    return await response.json();
  } catch {
    throw new DataError(
      "The API returned an unreadable response. Check the local API before trying again.",
    );
  }
}
/** @param {unknown} value @returns {Run} */
function readRun(value) {
  if (!isRecord(value) || !isRun(value.run))
    throw new DataError(
      "The API returned invalid saved data. Check the local API before trying again.",
    );
  return value.run;
}
/** @param {string} id @param {AbortSignal} signal @returns {Promise<Run>} */
export async function fetchRun(id, signal) {
  const run = readRun(
    await request("/api/runs/" + encodeURIComponent(id), signal),
  );
  if (run.id !== id)
    throw new DataError("The API returned a different saved run.");
  publishCollectionRun(run, false);
  return run;
}
/** @param {Source} source @param {AbortSignal} signal @returns {Promise<Run|null>} */
export async function fetchLatest(source, signal) {
  const value = await request(
    "/api/runs/latest?" + new URLSearchParams({ source }),
    signal,
  );
  if (isRecord(value) && value.run === null) return null;
  const run = readRun(value);
  if (run.source !== source || run.status !== "succeeded")
    throw new DataError("The API returned inconsistent saved data.");
  return run;
}
/** @param {Source} source @param {Inputs} inputs @param {string} requestId @param {AbortSignal} signal @returns {Promise<Run>} */
export async function createRun(source, inputs, requestId, signal) {
  const run = readRun(
    await request("/api/runs", signal, { source, inputs, requestId }),
  );
  if (
    run.id !== requestId ||
    run.source !== source ||
    Object.keys(inputs).some((key) => run.inputs[key] !== inputs[key])
  )
    throw new DataError(
      "The API returned a different collection request. Check History before collecting again.",
    );
  publishCollectionRun(run, true);
  return run;
}
/** @param {Source|''} source @param {string|null} cursor @param {AbortSignal} signal @returns {Promise<{runs:RunSummary[],nextCursor:string|null}>} */
export async function fetchHistory(source, cursor, signal) {
  const params = new URLSearchParams({ limit: "20" });
  if (source) params.set("source", source);
  if (cursor) params.set("cursor", cursor);
  const value = await request("/api/runs?" + params, signal);
  if (
    !isRecord(value) ||
    !Array.isArray(value.runs) ||
    !value.runs.every((run) => isRun(run, true)) ||
    !(value.nextCursor === null || text(value.nextCursor)) ||
    value.runs.some((run) => source && run.source !== source)
  )
    throw new DataError(
      "The API returned invalid run history. Check the local API before trying again.",
    );
  return { runs: value.runs, nextCursor: value.nextCursor };
}
/** @param {AbortSignal} signal @returns {Promise<boolean>} */
export async function fetchCollectionEnabled(signal) {
  const value = await request("/api/health", signal);
  if (
    !isRecord(value) ||
    value.status !== "ok" ||
    typeof value.collectionEnabled !== "boolean"
  )
    throw new DataError("Cannot verify collection availability.");
  return value.collectionEnabled;
}
/** @param {AbortSignal} signal @returns {Promise<{enabled:boolean,activeRun:ActiveRun|null}>} */
export async function fetchCollectionStatus(signal) {
  const value = await request("/api/health", signal);
  if (
    !isRecord(value) ||
    value.status !== "ok" ||
    typeof value.collectionEnabled !== "boolean"
  )
    throw new DataError("Cannot verify collection status.");
  const active = value.activeRun;
  if (
    active !== null &&
    (!isRecord(active) ||
      typeof active.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        active.id,
      ) ||
      !isSource(active.source) ||
      Object.keys(active).length !== 2)
  )
    throw new DataError("Cannot verify the active collection.");
  return {
    enabled: value.collectionEnabled,
    activeRun: /** @type {ActiveRun|null} */ (active),
  };
}
/** @param {unknown} error @returns {string} */
export function displayError(error) {
  return error instanceof DataError
    ? error.message
    : "The request could not finish. Check the local API before trying again.";
}
