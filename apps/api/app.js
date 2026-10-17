import express from "express";
import { AppError, publicError } from "./errors.js";
import { createRunService } from "./run-service.js";
import { decodeCursor, normalizeInputs, sourceName } from "./run-contract.js";

/** @param {unknown} value */
export function validateQuery(value) {
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
      "INVALID_QUERY",
      "Provide one search query containing 1–200 characters.",
    );
  return value.trim();
}

/** @param {{repository:import('./types.js').RunRepository,collectors:import('./types.js').RunCollectors,collectionEnabled?:boolean}} dependencies */
export function createApp({
  repository,
  collectors,
  collectionEnabled = false,
}) {
  const app = express();
  const runs = createRunService({ repository, collectors, collectionEnabled });
  app.locals["runs"] = runs;
  app.disable("x-powered-by");
  app.set("query parser", "extended");
  app.use((req, _res, next) => {
    const loopback = (/** @type {string} */ hostname) =>
      ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
    try {
      const host = req.get("host");
      const address = host ? new URL(`http://${host}`) : null;
      if (
        !address ||
        !loopback(address.hostname) ||
        address.username ||
        address.password ||
        address.pathname !== "/" ||
        address.search ||
        address.hash
      )
        throw new Error();
      const origin = req.get("origin");
      if (origin) {
        const parsed = new URL(origin);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          !loopback(parsed.hostname) ||
          parsed.username ||
          parsed.password ||
          parsed.pathname !== "/" ||
          parsed.search ||
          parsed.hash
        )
          throw new Error();
      }
      next();
    } catch {
      next(
        new AppError(
          403,
          "LOCAL_ACCESS_ONLY",
          "This API accepts requests from this PC only.",
        ),
      );
    }
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  app.get("/api/health", (_req, res) =>
    res.json({ status: "ok", collectionEnabled, activeRun: runs.activeRun }),
  );
  app.post("/api/runs", async (req, res) => {
    if (!req.is("application/json"))
      throw new AppError(
        415,
        "JSON_REQUIRED",
        "Send collection inputs as application/json.",
      );
    const result = await runs.submit(req.body);
    res.status(result.status).json({ run: result.run });
  });
  app.get("/api/runs", async (req, res) => {
    if (
      Object.keys(req.query).some(
        (key) => !["source", "limit", "cursor"].includes(key),
      )
    )
      throw new AppError(
        400,
        "INVALID_INPUT",
        "Provide supported history filters only.",
      );
    const source =
      req.query["source"] === undefined
        ? undefined
        : sourceName(req.query["source"]);
    const rawLimit = req.query["limit"],
      limit =
        rawLimit === undefined
          ? 20
          : typeof rawLimit === "string" && /^[1-9]\d?$/u.test(rawLimit)
            ? Number(rawLimit)
            : NaN;
    if (!Number.isInteger(limit) || limit > 50)
      throw new AppError(
        400,
        "INVALID_LIMIT",
        "History limit must be an integer from 1 to 50.",
      );
    res.json(
      await runs.list({
        source,
        limit,
        cursor: decodeCursor(req.query["cursor"]),
      }),
    );
  });
  app.get("/api/runs/latest", async (req, res) => {
    if (Object.keys(req.query).length !== 1)
      throw new AppError(400, "INVALID_INPUT", "Provide one source filter.");
    res.json({ run: await runs.latest(sourceName(req.query["source"])) });
  });
  app.get("/api/runs/:id", async (req, res) => {
    const run = await runs.get(req.params["id"] ?? "");
    if (run === null)
      throw new AppError(
        404,
        "RUN_NOT_FOUND",
        "This saved run does not exist.",
      );
    res.json({ run });
  });
  app.get("/api/tiobe", async (_req, res) => {
    const run = await runs.latest("tiobe", {});
    if (!run)
      throw new AppError(
        404,
        "RESULTS_NOT_SAVED",
        "No saved results exist for these inputs.",
      );
    res.json({ source: "cache", data: run.data });
  });
  app.get("/api/books/amazon", async (req, res) => {
    const query = validateQuery(req.query["q"]);
    const run = await runs.latest(
      "amazon",
      normalizeInputs("amazon", { query }),
    );
    if (!run)
      throw new AppError(
        404,
        "RESULTS_NOT_SAVED",
        "No saved results exist for these inputs.",
      );
    res.json({ source: "cache", data: run.data });
  });
  app.use((_req, res) =>
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "This API route does not exist." },
    }),
  );
  /** @type {import('express').ErrorRequestHandler} */
  const handleError = (error, _req, res, _next) => {
    if (res.headersSent) {
      _next(error);
      return;
    }
    const result =
      error &&
      typeof error === "object" &&
      "type" in error &&
      error.type === "entity.too.large"
        ? publicError(
            new AppError(
              413,
              "INPUT_TOO_LARGE",
              "The request body exceeds the size limit.",
            ),
          )
        : error instanceof SyntaxError
          ? publicError(
              new AppError(
                400,
                "INVALID_JSON",
                "Provide one valid JSON object.",
              ),
            )
          : publicError(error);
    res.status(result.status).json(result.body);
  };
  app.use(handleError);
  return app;
}
