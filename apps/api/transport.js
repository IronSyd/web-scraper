import { AppError } from "./errors.js";

function assertSafeRuntimeConfiguration() {
  if (
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0" ||
    ["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS"].some((name) =>
      process.env[name]?.trim(),
    )
  ) {
    throw new AppError(
      503,
      "CONFIGURATION_REQUIRED",
      "Use verified TLS and disable process request-debug overrides before collection.",
    );
  }
}

/** @param {number} status @param {string|null} code */
function upstreamError(status, code = null) {
  // A documented provider code is more precise than a generic HTTP status.
  if (code === "CTX0002") status = 504;
  else if (
    code === "RESP009" ||
    /^AUTH(?:004|005|006|008|010|011|012|014)$/u.test(code ?? "")
  )
    status = 503;
  else if (/^AUTH00[123]$/u.test(code ?? "")) status = 401;
  else if (code === "RESP006") status = 403;
  if (status === 401)
    return new AppError(
      502,
      "PROVIDER_AUTHENTICATION",
      "The scraping provider rejected authentication.",
    );
  if (status === 402 || status === 429 || status === 503)
    return new AppError(
      503,
      "PROVIDER_UNAVAILABLE",
      "The scraping provider allowance or capacity is unavailable.",
    );
  if (status === 504)
    return new AppError(
      504,
      "UPSTREAM_TIMEOUT",
      "The upstream request exceeded its deadline.",
    );
  if (status === 403)
    return new AppError(
      502,
      "UPSTREAM_BLOCKED",
      "The upstream site returned a challenge or denial.",
    );
  return new AppError(502, "UPSTREAM_FAILURE", "The upstream request failed.");
}

/** @param {Response} response @param {number} maxBytes */
async function readBounded(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(
      502,
      "UPSTREAM_TOO_LARGE",
      "The upstream response exceeded the size limit.",
    );
  }
  if (!response.body)
    throw new AppError(
      502,
      "UPSTREAM_INVALID_RESPONSE",
      "The upstream response body is missing.",
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes)
        throw new AppError(
          502,
          "UPSTREAM_TOO_LARGE",
          "The upstream response exceeded the size limit.",
        );
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** @param {string} value */
export function validateTiobeUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["www.tiobe.com", "tiobe.com"].includes(url.hostname) ||
      url.pathname !== "/tiobe-index/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error();
    return url.href;
  } catch {
    throw new AppError(
      503,
      "CONFIGURATION_REQUIRED",
      "TIOBE_URL must identify the supported public index page.",
    );
  }
}

/**
 * @param {{apiKey?:string,fetchImpl?:typeof fetch,timeoutMs?:number,maxBytes?:number}} options
 */
export function createHtmlClients({
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 190000,
  maxBytes = 5_000_000,
} = {}) {
  /** @param {string|URL} url @param {AbortSignal} [cancel] */
  async function request(url, cancel) {
    assertSafeRuntimeConfiguration();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = cancel ? AbortSignal.any([deadline, cancel]) : deadline;
    try {
      const response = await fetchImpl(url, {
        signal,
        redirect: "error",
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain,application/json",
        },
      });
      const text = await readBounded(response, maxBytes);
      const mime = response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      if (mime === "application/json") {
        /** @type {unknown} */
        let decoded;
        try {
          decoded = JSON.parse(text);
        } catch {
          throw new AppError(
            502,
            "UPSTREAM_INVALID_RESPONSE",
            "The upstream JSON response is malformed.",
          );
        }
        const object =
          decoded && typeof decoded === "object"
            ? /** @type {Record<string,unknown>} */ (decoded)
            : null;
        const code =
          object && typeof object["code"] === "string" ? object["code"] : null;
        if (!response.ok || code) throw upstreamError(response.status, code);
        if (object && typeof object["html"] === "string") return object["html"];
        throw new AppError(
          502,
          "UPSTREAM_INVALID_RESPONSE",
          "The upstream JSON response contains no HTML.",
        );
      }
      if (!response.ok) throw upstreamError(response.status);
      if (
        !["text/html", "application/xhtml+xml", "text/plain"].includes(
          mime ?? "",
        )
      )
        throw new AppError(
          502,
          "UPSTREAM_INVALID_RESPONSE",
          "The upstream response has an unsupported media type.",
        );
      return text;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (cancel?.aborted)
        throw new AppError(503, "RUN_CANCELLED", "Collection was cancelled.");
      if (signal.aborted) throw upstreamError(504);
      throw new AppError(
        502,
        "UPSTREAM_NETWORK",
        "The upstream connection failed.",
      );
    }
  }
  return {
    /** @param {string} tiobeUrl @param {AbortSignal} [signal] */
    publicTiobe: (tiobeUrl, signal) =>
      request(validateTiobeUrl(tiobeUrl), signal),
    /** @param {string} query @param {AbortSignal} [signal] */
    amazon: (query, signal) => {
      if (!apiKey?.trim())
        throw new AppError(
          503,
          "CONFIGURATION_REQUIRED",
          "The scraping provider key is not configured.",
        );
      const target = new URL("https://www.amazon.com/s");
      target.searchParams.set("k", query);
      target.searchParams.set("i", "stripbooks");
      const endpoint = new URL("https://api.zenrows.com/v1/");
      for (const [key, value] of Object.entries({
        apikey: apiKey,
        url: target.href,
        js_render: "true",
        premium_proxy: "true",
        proxy_country: "us",
        original_status: "true",
      }))
        endpoint.searchParams.set(key, value);
      return request(endpoint, signal);
    },
  };
}
