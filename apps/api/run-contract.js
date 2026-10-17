import { AppError, databaseUnavailable, invalidPage } from "./errors.js";
import { validateCacheData } from "./cache.js";

/** @param {unknown} value @returns {value is Record<string,unknown>} */
export const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sources = new Set(["amazon", "booking", "indeed", "tiobe"]);
/** @param {unknown} value @returns {import('./types.js').Source} */
export function sourceName(value) {
  if (typeof value !== "string" || !sources.has(value))
    throw new AppError(
      400,
      "INVALID_SOURCE",
      "Choose a supported collection source.",
    );
  return /** @type {import('./types.js').Source} */ (value);
}
/** @param {Record<string,unknown>} value @param {string[]} keys */
function exactKeys(value, keys) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Provide exactly the required source inputs.",
    );
}
/** @param {unknown} value */
function inputText(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 200 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Text inputs must contain 1–200 printable characters.",
    );
  return value.trim();
}
/** @param {unknown} value */
function isoDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    value.startsWith("0000-")
  )
    throw new AppError(400, "INVALID_INPUT", "Provide valid ISO travel dates.");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new AppError(400, "INVALID_INPUT", "Provide valid ISO travel dates.");
  return value;
}
/** @param {unknown} source @param {unknown} value @returns {import('./types.js').RunInputs} */
export function normalizeInputs(source, value) {
  const name = sourceName(source);
  if (!isObject(value))
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Source inputs must be an object.",
    );
  if (name === "tiobe") {
    exactKeys(value, []);
    return {};
  }
  if (name === "amazon") {
    exactKeys(value, ["query"]);
    return { query: inputText(value["query"]) };
  }
  if (name === "indeed") {
    exactKeys(value, ["query", "location"]);
    return {
      query: inputText(value["query"]),
      location: inputText(value["location"]),
    };
  }
  exactKeys(value, ["destination", "checkin", "checkout", "adults", "rooms"]);
  const checkin = isoDate(value["checkin"]),
    checkout = isoDate(value["checkout"]);
  const adults = value["adults"],
    rooms = value["rooms"];
  if (
    checkout <= checkin ||
    typeof adults !== "number" ||
    !Number.isSafeInteger(adults) ||
    adults < 1 ||
    typeof rooms !== "number" ||
    !Number.isSafeInteger(rooms) ||
    rooms < 1
  )
    throw new AppError(
      400,
      "INVALID_INPUT",
      "Checkout must follow check-in; adults and rooms must be positive integers.",
    );
  return {
    destination: inputText(value["destination"]),
    checkin,
    checkout,
    adults,
    rooms,
  };
}
/** @param {unknown} value */
function text(value) {
  if (
    typeof value !== "string" ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  )
    throw invalidPage();
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (!cleaned || cleaned.length > 2000) throw invalidPage();
  return cleaned;
}
/** @param {unknown} value */
const optionalText = (value) => (value === null ? null : text(value));
/** @param {unknown} raw @param {string} host */
function resultUrl(raw, host) {
  try {
    if (typeof raw !== "string") throw new Error();
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== host ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      throw new Error();
    return url;
  } catch {
    throw invalidPage();
  }
}
/** @param {unknown} source @param {import('./types.js').RunInputs} inputs @param {unknown} value @returns {import('./types.js').RunData} */
export function cleanRecords(source, inputs, value) {
  const name = sourceName(source),
    normalized = normalizeInputs(name, inputs);
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 100 ||
    Buffer.byteLength(JSON.stringify(value)) > 5_000_000
  )
    throw invalidPage();
  if (name === "amazon" || name === "tiobe") {
    if (name === "tiobe") {
      const data = /** @type {import('./types.js').Language[]} */ (
        validateCacheData("tiobe", value)
      ).map((row) => ({ ...row, pLang: text(row.pLang) }));
      if (new Set(data.map((row) => row.pLang)).size !== 20)
        throw invalidPage();
      return data;
    }
    /** @type {Map<string,import('./types.js').Book>} */ const selected =
      new Map();
    for (const raw of value) {
      const row = /** @type {import('./types.js').Book[]} */ (
        validateCacheData(`amazon:${normalized["query"]}`, [raw])
      )[0];
      if (!row || row.authors.length > 100) throw invalidPage();
      if (!selected.has(row.url))
        selected.set(row.url, {
          ...row,
          title: text(row.title),
          authors: [...new Set(row.authors.map(text))],
          price: optionalText(row.price),
          rating: optionalText(row.rating),
          reviews: optionalText(row.reviews),
        });
    }
    return [...selected.values()];
  }
  if (name === "indeed") {
    const selected = new Map();
    for (const row of value) {
      if (
        !isObject(row) ||
        typeof row["jobId"] !== "string" ||
        !/^[a-zA-Z0-9]{8,64}$/u.test(row["jobId"])
      )
        throw invalidPage();
      const id = row["jobId"],
        url = resultUrl(row["url"], "www.indeed.com");
      if (
        url.pathname !== "/viewjob" ||
        url.searchParams.size !== 1 ||
        url.searchParams.getAll("jk").length !== 1 ||
        url.searchParams.get("jk") !== id
      )
        throw invalidPage();
      selected.set(id, {
        jobId: id,
        title: text(row["title"]),
        company: text(row["company"]),
        location: text(row["location"]),
        url: `https://www.indeed.com/viewjob?jk=${id}`,
      });
    }
    return [...selected.values()];
  }
  const selected = new Map();
  for (const row of value) {
    if (!isObject(row)) throw invalidPage();
    const url = resultUrl(row["url"], "www.booking.com");
    if (!/^\/hotel\/[a-z]{2}\/[^/]+\.html$/u.test(url.pathname))
      throw invalidPage();
    const expected = {
      checkin: String(normalized["checkin"]),
      checkout: String(normalized["checkout"]),
      group_adults: String(normalized["adults"]),
      no_rooms: String(normalized["rooms"]),
    };
    if (
      url.searchParams.size !== 4 ||
      Object.entries(expected).some(
        ([key, val]) =>
          url.searchParams.getAll(key).length !== 1 ||
          url.searchParams.get(key) !== val,
      )
    )
      throw invalidPage();
    url.search = new URLSearchParams(expected).toString();
    const currency = optionalText(row["currency"]),
      reviewCount = row["reviewCount"];
    if (
      (currency !== null && !/^[A-Z]{3}$/u.test(currency)) ||
      (reviewCount !== null &&
        (typeof reviewCount !== "number" ||
          !Number.isSafeInteger(reviewCount) ||
          reviewCount < 0))
    )
      throw invalidPage();
    selected.set(url.pathname, {
      name: text(row["name"]),
      url: url.href,
      price: optionalText(row["price"]),
      currency,
      rating: optionalText(row["rating"]),
      reviewCount,
      location: optionalText(row["location"]),
    });
  }
  return [...selected.values()];
}
/** @param {unknown} value */
export function requestId(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    throw new AppError(
      400,
      "INVALID_REQUEST_ID",
      "Provide a UUID request identifier.",
    );
  return value.toLowerCase();
}
/** @param {string} key */
export const legacyId = (key) =>
  `legacy-${Buffer.from(key).toString("base64url")}`;
/** @param {unknown} value */
export function legacyKey(value) {
  if (
    typeof value !== "string" ||
    value.length > 1200 ||
    !/^legacy-[A-Za-z0-9_-]+$/u.test(value)
  )
    throw new AppError(
      400,
      "INVALID_RUN_ID",
      "Provide a valid saved-run identifier.",
    );
  const key = Buffer.from(value.slice(7), "base64url").toString("utf8");
  if (
    legacyId(key) !== value ||
    (key !== "tiobe" && !key.startsWith("amazon:"))
  )
    throw new AppError(
      400,
      "INVALID_RUN_ID",
      "Provide a valid saved-run identifier.",
    );
  normalizeInputs(
    key === "tiobe" ? "tiobe" : "amazon",
    key === "tiobe" ? {} : { query: key.slice(7) },
  );
  return key;
}
/** @param {import('./types.js').Run} run */
export function summary(run) {
  return {
    id: run.id,
    source: run.source,
    inputs: run.inputs,
    status: run.status,
    provenance: run.provenance,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    collectedAt: run.collectedAt,
    savedAt: run.savedAt,
    resultCount: run.resultCount,
    error: run.error,
  };
}
/** @param {import('./types.js').Run} run */
export function order(run) {
  return {
    time: run.createdAt === null ? 0 : new Date(run.createdAt).getTime(),
    tie:
      run.provenance === "legacy-cache"
        ? `legacy:${legacyKey(run.id)}`
        : run.id,
  };
}
/** @param {import('./types.js').RunCursor} cursor */
export const encodeCursor = (cursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");
/** @param {unknown} value @returns {import('./types.js').RunCursor|null} */
export function decodeCursor(value) {
  if (value === undefined) return null;
  try {
    if (
      typeof value !== "string" ||
      value.length > 2000 ||
      !/^[A-Za-z0-9_-]+$/u.test(value)
    )
      throw new Error();
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !isObject(decoded) ||
      Object.keys(decoded).length !== 2 ||
      typeof decoded["time"] !== "number" ||
      !Number.isSafeInteger(decoded["time"]) ||
      Math.abs(decoded["time"]) > 8.64e15 ||
      typeof decoded["tie"] !== "string"
    )
      throw new Error();
    const tie = decoded["tie"];
    if (tie.startsWith("legacy:")) legacyKey(legacyId(tie.slice(7)));
    else requestId(tie);
    const cursor = { time: decoded["time"], tie };
    if (encodeCursor(cursor) !== value) throw new Error();
    return cursor;
  } catch {
    throw new AppError(
      400,
      "INVALID_CURSOR",
      "Provide a valid history cursor.",
    );
  }
}
const errorMessages = {
  RUN_INTERRUPTED:
    "Collection was interrupted by an API restart. Collect again explicitly when ready.",
  RUN_CANCELLED: "Collection was cancelled during API shutdown.",
  UPSTREAM_TIMEOUT: "The collection exceeded its deadline.",
  UPSTREAM_BLOCKED: "The source returned a challenge or denial.",
  UPSTREAM_INVALID_PAGE: "The source did not contain valid expected results.",
  UPSTREAM_INVALID_RESPONSE: "The source returned an invalid response.",
  UPSTREAM_TOO_LARGE: "The source response exceeded the size limit.",
  UPSTREAM_NETWORK: "The source connection failed.",
  UPSTREAM_FAILURE: "The source request failed.",
  PROVIDER_AUTHENTICATION: "The scraping provider rejected authentication.",
  PROVIDER_UNAVAILABLE:
    "The scraping provider allowance or capacity is unavailable.",
  CONFIGURATION_REQUIRED: "Collection configuration is unavailable.",
  COLLECTOR_CLEANUP_FAILED:
    "Collector cleanup could not be confirmed. Check the local API before collecting again.",
  COLLECTOR_FAILED: "The collector did not return usable results.",
  COLLECTOR_FAILURE: "The collector did not return usable results.",
  COLLECTOR_INVALID_RESPONSE: "The collector returned an invalid response.",
  COLLECTOR_DIAGNOSTICS_LIMIT:
    "The collector exceeded its diagnostic output limit.",
  DATABASE_UNAVAILABLE: "The local database is unavailable.",
  INTERNAL_ERROR: "The collection could not be completed.",
};
/** @param {unknown} error @returns {import('./types.js').RunError} */
export function safeRunError(error) {
  const code =
    error instanceof AppError && Object.hasOwn(errorMessages, error.code)
      ? /** @type {keyof typeof errorMessages} */ (error.code)
      : "INTERNAL_ERROR";
  return { code, message: errorMessages[code] };
}
/** @param {unknown} value @returns {import('./types.js').Run} */
export function validateRun(value) {
  try {
    if (!isObject(value)) throw new Error();
    const source = sourceName(value["source"]),
      inputs = normalizeInputs(source, value["inputs"]);
    const id = value["id"],
      provenance = value["provenance"],
      status = value["status"];
    if (
      typeof id !== "string" ||
      (provenance !== "collection" && provenance !== "legacy-cache") ||
      !["running", "succeeded", "failed"].includes(String(status))
    )
      throw new Error();
    if (provenance === "legacy-cache") {
      const key = legacyKey(id);
      if (
        status !== "succeeded" ||
        source !== (key === "tiobe" ? "tiobe" : "amazon") ||
        JSON.stringify(inputs) !==
          JSON.stringify(key === "tiobe" ? {} : { query: key.slice(7) })
      )
        throw new Error();
    } else if (requestId(id) !== id) throw new Error();
    /** @type {Record<string,string|null>} */ const dates = {};
    for (const field of [
      "createdAt",
      "startedAt",
      "completedAt",
      "collectedAt",
      "savedAt",
    ]) {
      const date = value[field];
      if (
        date !== null &&
        (typeof date !== "string" ||
          !Number.isFinite(new Date(date).getTime()) ||
          new Date(date).toISOString() !== date)
      )
        throw new Error();
      dates[field] = /** @type {string|null} */ (date);
    }
    if (
      provenance === "collection" &&
      (dates["createdAt"] === null ||
        dates["startedAt"] === null ||
        dates["savedAt"] === null)
    )
      throw new Error();
    if (
      provenance === "legacy-cache" &&
      (dates["startedAt"] !== null ||
        dates["completedAt"] !== null ||
        dates["collectedAt"] !== null ||
        dates["createdAt"] !== dates["savedAt"])
    )
      throw new Error();
    if (
      status === "running" &&
      (value["data"] !== null ||
        value["error"] !== null ||
        value["resultCount"] !== 0 ||
        dates["completedAt"] !== null ||
        dates["collectedAt"] !== null)
    )
      throw new Error();
    const data =
      status === "succeeded"
        ? cleanRecords(source, inputs, value["data"])
        : null;
    if (
      status === "succeeded" &&
      (value["error"] !== null ||
        value["resultCount"] !== data?.length ||
        (provenance === "collection" &&
          (dates["completedAt"] === null || dates["collectedAt"] === null)))
    )
      throw new Error();
    let error = null;
    if (status === "failed") {
      if (
        value["data"] !== null ||
        value["resultCount"] !== 0 ||
        dates["completedAt"] === null ||
        dates["collectedAt"] !== null ||
        !isObject(value["error"]) ||
        typeof value["error"]["code"] !== "string" ||
        !Object.hasOwn(errorMessages, value["error"]["code"])
      )
        throw new Error();
      error = safeRunError(new AppError(500, value["error"]["code"], ""));
    }
    return {
      id,
      source,
      inputs,
      status: /** @type {import('./types.js').Run['status']} */ (status),
      provenance,
      createdAt: dates["createdAt"] ?? null,
      startedAt: dates["startedAt"] ?? null,
      completedAt: dates["completedAt"] ?? null,
      collectedAt: dates["collectedAt"] ?? null,
      savedAt: dates["savedAt"] ?? null,
      resultCount: data?.length ?? 0,
      data,
      error,
    };
  } catch {
    throw databaseUnavailable();
  }
}
