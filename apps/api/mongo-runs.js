import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { AppError, databaseUnavailable } from "./errors.js";
import {
  legacyId,
  legacyKey,
  normalizeInputs,
  order,
  encodeCursor,
  safeRunError,
  sourceName,
  summary,
  validateRun,
} from "./run-contract.js";

/** @param {unknown} value */
const timestamp = (value) =>
  value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : null;
/** @param {Record<string,unknown>} entry */
function storedRun(entry) {
  const run = validateRun(entry["value"]);
  if (
    entry["id"] !== run.id ||
    entry["source"] !== run.source ||
    timestamp(entry["createdAt"]) !== run.createdAt
  )
    throw databaseUnavailable();
  return run;
}
/** @param {Record<string,unknown>} entry @returns {import('./types.js').Run} */
function legacyRun(entry) {
  const key = entry["key"];
  if (typeof key !== "string") throw databaseUnavailable();
  const source =
    key === "tiobe" ? "tiobe" : key.startsWith("amazon:") ? "amazon" : null;
  if (source === null) throw databaseUnavailable();
  const stamp = timestamp(entry["createdAt"]);
  return validateRun({
    id: legacyId(key),
    source,
    inputs: normalizeInputs(
      source,
      source === "tiobe" ? {} : { query: key.slice(7) },
    ),
    status: "succeeded",
    provenance: "legacy-cache",
    createdAt: stamp,
    startedAt: null,
    completedAt: null,
    collectedAt: null,
    savedAt: stamp,
    resultCount: Array.isArray(entry["data"]) ? entry["data"].length : -1,
    data: entry["data"],
    error: null,
  });
}
/** @param {number} pid */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    )
      return false;
    return true;
  }
}
/** @param {string} uri @param {{pid?:number,isAlive?:(pid:number)=>boolean,nonce?:string}} [options] */
export async function connectMongoRuns(
  uri,
  { pid = process.pid, isAlive = processAlive, nonce = randomUUID() } = {},
) {
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== "mongodb:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      parsed.pathname.length < 2 ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error();
  } catch {
    throw new AppError(
      503,
      "CONFIGURATION_REQUIRED",
      "MONGO_URI must identify a database on this PC.",
    );
  }
  const connection = await mongoose
    .createConnection(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 5000,
      bufferCommands: false,
    })
    .asPromise();
  const schema = new mongoose.Schema(
    {
      id: { type: String, required: true, unique: true },
      source: { type: String, required: true },
      createdAt: { type: Date, required: true },
      value: { type: mongoose.Schema.Types.Mixed, required: true },
    },
    { strict: "throw", collection: "collectionruns", minimize: false },
  );
  schema.index({ createdAt: -1, id: -1 });
  schema.index({ source: 1, createdAt: -1, id: -1 });
  const model = connection.model("CollectionRun", schema);
  const owners = connection.collection("collectionruntimeowners"),
    legacy = connection.collection("collectionbatches");
  let owned = false,
    closed = false;
  try {
    await model.init();
    await owners.createIndex({ key: 1 }, { unique: true });
    const prior = await owners.findOne({ key: "web-scraper" });
    if (prior) {
      if (
        !Number.isSafeInteger(prior["pid"]) ||
        prior["pid"] < 1 ||
        typeof prior["nonce"] !== "string" ||
        isAlive(prior["pid"])
      )
        throw new AppError(
          503,
          "API_ALREADY_RUNNING",
          "Another API owns collection storage. Stop it before starting this instance.",
        );
      const replaced = await owners.updateOne(
        { key: "web-scraper", nonce: prior["nonce"] },
        { $set: { pid, nonce } },
      );
      if (replaced.modifiedCount !== 1)
        throw new AppError(
          503,
          "API_ALREADY_RUNNING",
          "Collection storage is owned by another API instance.",
        );
    } else {
      try {
        await owners.insertOne({ key: "web-scraper", pid, nonce });
      } catch {
        throw new AppError(
          503,
          "API_ALREADY_RUNNING",
          "Collection storage is owned by another API instance.",
        );
      }
    }
    owned = true;
    const completedAt = new Date().toISOString();
    await model
      .updateMany(
        { "value.status": "running" },
        {
          $set: {
            "value.status": "failed",
            "value.completedAt": completedAt,
            "value.savedAt": completedAt,
            "value.error": safeRunError(
              new AppError(500, "RUN_INTERRUPTED", ""),
            ),
          },
        },
        { maxTimeMS: 5000 },
      )
      .exec();
  } catch (error) {
    if (owned)
      await owners.deleteOne({ key: "web-scraper", nonce }).catch(() => {});
    await connection.close();
    throw error;
  }
  /** @param {import('./types.js').HistoryOptions} options @param {boolean} legacyCollection */
  async function historyPart(options, legacyCollection) {
    /** @type {import('mongoose').PipelineStage[]} */ const pipeline = [];
    if (legacyCollection) {
      const match =
        options.source === "amazon"
          ? { key: /^amazon:/u }
          : options.source === "tiobe"
            ? { key: "tiobe" }
            : options.source
              ? { key: { $in: [] } }
              : { $or: [{ key: "tiobe" }, { key: /^amazon:/u }] };
      pipeline.push(
        { $match: match },
        {
          $addFields: {
            sortTime: {
              $cond: [
                { $eq: [{ $type: "$createdAt" }, "date"] },
                { $toLong: "$createdAt" },
                0,
              ],
            },
            sortTie: { $concat: ["legacy:", "$key"] },
          },
        },
      );
    } else
      pipeline.push(
        { $match: options.source ? { source: options.source } : {} },
        { $addFields: { sortTime: { $toLong: "$createdAt" }, sortTie: "$id" } },
      );
    if (options.cursor)
      pipeline.push({
        $match: {
          $or: [
            { sortTime: { $lt: options.cursor.time } },
            {
              sortTime: options.cursor.time,
              sortTie: { $lt: options.cursor.tie },
            },
          ],
        },
      });
    pipeline.push(
      { $sort: { sortTime: -1, sortTie: -1 } },
      { $limit: options.limit + 1 },
    );
    const entries = legacyCollection
      ? await legacy.aggregate(pipeline, { maxTimeMS: 5000 }).toArray()
      : await model.aggregate(pipeline).option({ maxTimeMS: 5000 }).exec();
    return entries.map((entry) =>
      legacyCollection ? legacyRun(entry) : storedRun(entry),
    );
  }
  /** @type {import('./types.js').RunRepository} */
  const repository = {
    async get(id) {
      if (id.startsWith("legacy-")) {
        const entry = await legacy.findOne(
          { key: legacyKey(id) },
          { maxTimeMS: 5000 },
        );
        return entry ? legacyRun(entry) : null;
      }
      const entry = await model.findOne({ id }).maxTimeMS(5000).lean().exec();
      return entry ? storedRun(entry) : null;
    },
    async insert(value) {
      const run = validateRun(value);
      if (run.status !== "running" || run.provenance !== "collection")
        throw databaseUnavailable();
      try {
        await model.create({
          id: run.id,
          source: run.source,
          createdAt: new Date(/** @type {string} */ (run.createdAt)),
          value: run,
        });
        return true;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 11000
        )
          return false;
        throw error;
      }
    },
    async finish(value) {
      const run = validateRun(value);
      if (run.status === "running" || run.provenance !== "collection")
        throw databaseUnavailable();
      const entry = await model
        .findOneAndUpdate(
          {
            id: run.id,
            source: run.source,
            createdAt: new Date(/** @type {string} */ (run.createdAt)),
            "value.status": "running",
            "value.inputs": run.inputs,
            "value.startedAt": run.startedAt,
          },
          { $set: { value: run } },
          { returnDocument: "after", runValidators: true, maxTimeMS: 5000 },
        )
        .lean()
        .exec();
      if (entry) return storedRun(entry);
      return repository.get(run.id);
    },
    async list(options) {
      const parts = await Promise.all([
        historyPart(options, false),
        historyPart(options, true),
      ]);
      const all = parts.flat().sort((a, b) => {
        const x = order(a),
          y = order(b);
        return (
          y.time - x.time ||
          Buffer.compare(Buffer.from(y.tie), Buffer.from(x.tie))
        );
      });
      const selected = all.slice(0, options.limit),
        last = selected.at(-1);
      return {
        runs: selected.map(summary),
        nextCursor:
          all.length > options.limit && last ? encodeCursor(order(last)) : null,
      };
    },
    async latest(source, inputs) {
      sourceName(source);
      /** @type {Record<string,unknown>} */ const filter = {
        source,
        "value.status": "succeeded",
      };
      if (inputs) filter["value.inputs"] = normalizeInputs(source, inputs);
      const entry = await model
        .findOne(filter)
        .sort({ createdAt: -1, id: -1 })
        .maxTimeMS(5000)
        .lean()
        .exec();
      const current = entry ? storedRun(entry) : null;
      const key =
        source === "tiobe"
          ? "tiobe"
          : source === "amazon" && inputs
            ? `amazon:${inputs["query"]}`
            : null;
      const legacyEntry = key
        ? await legacy.findOne({ key }, { maxTimeMS: 5000 })
        : source === "amazon" && !inputs
          ? await legacy.findOne(
              { key: /^amazon:/u },
              { sort: { createdAt: -1, key: -1 }, maxTimeMS: 5000 },
            )
          : null;
      const older = legacyEntry ? legacyRun(legacyEntry) : null;
      return current && older
        ? order(current).time >= order(older).time
          ? current
          : older
        : (current ?? older);
    },
  };
  return {
    repository,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await owners.deleteOne({ key: "web-scraper", nonce });
      } finally {
        await connection.close();
      }
    },
  };
}
