import { databaseUnavailable, invalidPage } from "./errors.js";
import { safeUrl } from "./parsers.js";

/** @param {unknown} value @returns {value is Record<string,unknown>} */
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value */
const nullableText = (value) =>
  value === null ||
  (typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 2000);

/** @param {string} key @param {unknown} value @returns {import('./types.js').CacheData} */
export function validateCacheData(key, value) {
  if (!Array.isArray(value) || value.length > 100) throw invalidPage();
  if (key === "tiobe") {
    if (
      value.length !== 20 ||
      value.some(
        (row, index) =>
          !object(row) ||
          row["ranking"] !== index + 1 ||
          typeof row["pLang"] !== "string" ||
          !row["pLang"].trim() ||
          typeof row["imagePath"] !== "string",
      )
    )
      throw invalidPage();
    if (new Set(value.map((row) => row["pLang"])).size !== 20)
      throw invalidPage();
    return value.map((row) => ({
      ranking: row["ranking"],
      pLang: row["pLang"],
      imagePath: safeUrl(
        row["imagePath"],
        "https://www.tiobe.com/tiobe-index/",
        ["www.tiobe.com", "tiobe.com"],
      ).href,
    }));
  }
  const query = key.slice("amazon:".length);
  if (
    !key.startsWith("amazon:") ||
    !query ||
    value.some(
      (row) =>
        !object(row) ||
        row["searchTerm"] !== query ||
        typeof row["title"] !== "string" ||
        !row["title"].trim() ||
        !Array.isArray(row["authors"]) ||
        row["authors"].some((author) => typeof author !== "string") ||
        typeof row["url"] !== "string" ||
        !/^https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}$/u.test(row["url"]) ||
        !nullableText(row["price"]) ||
        !nullableText(row["rating"]) ||
        !nullableText(row["reviews"]) ||
        !nullableText(row["image"]),
    )
  )
    throw invalidPage();
  if (new Set(value.map((row) => row["url"])).size !== value.length)
    throw invalidPage();
  return value.map((row) => ({
    searchTerm: row["searchTerm"],
    title: row["title"],
    authors: [...row["authors"]],
    url: row["url"],
    price: row["price"],
    rating: row["rating"],
    reviews: row["reviews"],
    image:
      row["image"] === null
        ? null
        : safeUrl(row["image"], "https://www.amazon.com/", [
            "m.media-amazon.com",
          ]).href,
  }));
}

/** @param {import('./types.js').CacheRepository} repository */
export function createCollectionService(repository) {
  /** @type {Map<string,Promise<import('./types.js').CollectionResponse>>} */
  const inFlight = new Map();
  return {
    /** @param {string} key @param {()=>Promise<import('./types.js').CacheData>} collect @returns {Promise<import('./types.js').CollectionResponse>} */
    async get(key, collect) {
      const existing = inFlight.get(key);
      if (existing) return existing;
      const operation = (async () => {
        /** @type {import('./types.js').CacheData|null} */
        let cached;
        try {
          cached = await repository.get(key);
        } catch {
          throw databaseUnavailable();
        }
        if (cached !== null) {
          try {
            return {
              source: /** @type {const} */ ("cache"),
              data: validateCacheData(key, cached),
            };
          } catch {
            throw databaseUnavailable();
          }
        }
        const data = validateCacheData(key, await collect());
        if (data.length) {
          try {
            await repository.set(key, data);
          } catch {
            throw databaseUnavailable();
          }
        }
        return { source: /** @type {const} */ ("collection"), data };
      })();
      inFlight.set(key, operation);
      try {
        return await operation;
      } finally {
        if (inFlight.get(key) === operation) inFlight.delete(key);
      }
    },
  };
}
