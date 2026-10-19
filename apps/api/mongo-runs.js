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
/** @param {unknown} value */
function archiveTimestamp(value) {
  if (value === undefined || value === null) return null;
  const stamp = timestamp(value);
  if (stamp === null) throw databaseUnavailable();
  return stamp;
}
/** @param {Record<string,unknown>} entry @param {'id'|'key'} identity */
function deletedEntry(entry, identity) {
  if (!Object.hasOwn(entry, "deletedAt")) return false;
  if (
    timestamp(entry["deletedAt"]) === null ||
    Object.keys(entry).some(
      (key) => !["_id", identity, "deletedAt"].includes(key),
    ) ||
    typeof entry[identity] !== "string"
  )
    throw databaseUnavailable();
  return true;
}
/** @param {unknown} value */
function mutationDate(value) {
  if (value === null) return null;
  if (typeof value !== "string" || timestamp(new Date(value)) !== value)
    throw databaseUnavailable();
  return new Date(value);
}
/** @param {Record<string,unknown>} entry */
function storedRun(entry) {
  if (deletedEntry(entry, "id")) throw databaseUnavailable();
  const value = entry["value"];
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw databaseUnavailable();
  const run = validateRun({
    ...value,
    archivedAt: archiveTimestamp(entry["archivedAt"]),
  });
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
  if (deletedEntry(entry, "key")) throw databaseUnavailable();
  const key = entry["key"];
  if (typeof key !== "string") throw databaseUnavailable();
  const source =
    key === "tiobe" ? "tiobe" : key.startsWith("amazon:") ? "amazon" : null;
  if (source === null) throw databaseUnavailable();
  const stamp = timestamp(entry["createdAt"]);
  const states = entry["management"];
  let archivedAt = null;
  if (states !== undefined) {
    if (!Array.isArray(states) || states.length > 1)
      throw databaseUnavailable();
    const state = states[0];
    if (state !== undefined) {
      if (
        !state ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        Object.keys(state).length !== 2 ||
        state["_id"] !== key ||
        !Object.hasOwn(state, "archivedAt")
      )
        throw databaseUnavailable();
      archivedAt = archiveTimestamp(state["archivedAt"]);
    }
  }
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
    archivedAt,
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
      archivedAt: { type: Date, default: null },
    },
    { strict: "throw", collection: "collectionruns", minimize: false },
  );
  schema.index({ createdAt: -1, id: -1 });
  schema.index({ source: 1, createdAt: -1, id: -1 });
  const model = connection.model("CollectionRun", schema);
  const owners = connection.collection("collectionruntimeowners"),
    legacy = connection.collection("collectionbatches");
  const legacyStates =
    /** @type {import('mongoose').Collection<{_id:string,archivedAt:Date|null}>} */ (
      connection.collection("collectionlegacyrunstates")
    );
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
  /** @param {'id'|'key'} identity @returns {import('mongoose').PipelineStage.Match} */
  function liveDocuments(identity) {
    // Corrupt tombstones remain visible to the validating mapper and fail closed.
    return {
      $match: {
        $or: [
          { deletedAt: { $exists: false } },
          {
            $expr: {
              $not: [
                {
                  $and: [
                    { $eq: [{ $type: "$deletedAt" }, "date"] },
                    {
                      $setEquals: [
                        {
                          $map: {
                            input: { $objectToArray: "$$ROOT" },
                            as: "field",
                            in: "$$field.k",
                          },
                        },
                        ["_id", identity, "deletedAt"],
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
  }
  /** @returns {import('mongoose').PipelineStage[]} */
  function legacyManagement() {
    return [
      {
        $lookup: {
          from: "collectionlegacyrunstates",
          localField: "key",
          foreignField: "_id",
          as: "management",
        },
      },
      {
        $addFields: {
          managementValid: {
            $cond: [
              { $eq: [{ $size: "$management" }, 0] },
              true,
              {
                $cond: [
                  { $eq: [{ $size: "$management" }, 1] },
                  {
                    $and: [
                      {
                        $setEquals: [
                          {
                            $map: {
                              input: {
                                $objectToArray: {
                                  $arrayElemAt: ["$management", 0],
                                },
                              },
                              as: "field",
                              in: "$$field.k",
                            },
                          },
                          ["_id", "archivedAt"],
                        ],
                      },
                      {
                        $in: [
                          {
                            $type: {
                              $arrayElemAt: ["$management.archivedAt", 0],
                            },
                          },
                          ["null", "date"],
                        ],
                      },
                    ],
                  },
                  false,
                ],
              },
            ],
          },
          archivedAt: { $arrayElemAt: ["$management.archivedAt", 0] },
        },
      },
    ];
  }
  /** @param {'active'|'archived'} visibility @param {boolean} [legacyCollection] @returns {import('mongoose').PipelineStage.Match} */
  function visibleDocuments(visibility, legacyCollection = false) {
    return {
      $match: {
        $expr: {
          $or: [
            ...(legacyCollection ? [{ $eq: ["$managementValid", false] }] : []),
            {
              $not: [
                {
                  $in: [{ $type: "$archivedAt" }, ["missing", "null", "date"]],
                },
              ],
            },
            visibility === "archived"
              ? { $eq: [{ $type: "$archivedAt" }, "date"] }
              : { $in: [{ $type: "$archivedAt" }, ["missing", "null"]] },
          ],
        },
      },
    };
  }
  /** @param {string} key */
  async function getLegacy(key) {
    const entry = await legacy.findOne({ key }, { maxTimeMS: 5000 });
    if (!entry || deletedEntry(entry, "key")) return null;
    const state = await legacyStates.findOne({ _id: key }, { maxTimeMS: 5000 });
    return legacyRun({ ...entry, management: state ? [state] : [] });
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
        liveDocuments("key"),
        ...legacyManagement(),
        visibleDocuments(options.visibility ?? "active", true),
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
        liveDocuments("id"),
        visibleDocuments(options.visibility ?? "active"),
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
        return getLegacy(legacyKey(id));
      }
      const entry = await model.findOne({ id }).maxTimeMS(5000).lean().exec();
      return entry && !deletedEntry(entry, "id") ? storedRun(entry) : null;
    },
    async isDeleted(id) {
      const entry = id.startsWith("legacy-")
        ? await legacy.findOne({ key: legacyKey(id) }, { maxTimeMS: 5000 })
        : await model.findOne({ id }).maxTimeMS(5000).lean().exec();
      return entry
        ? deletedEntry(entry, id.startsWith("legacy-") ? "key" : "id")
        : false;
    },
    async archive(id, archivedAt) {
      const stamp = mutationDate(archivedAt);
      const current = await repository.get(id);
      if (!current)
        return (await repository.isDeleted(id)) ? "deleted" : "missing";
      if (current.status === "running") return "running";
      if (id.startsWith("legacy-")) {
        const key = legacyKey(id);
        // Only this side record changes: the original cache bytes stay intact.
        const state = await legacyStates.findOne(
          { _id: key },
          { maxTimeMS: 5000 },
        );
        if (
          state &&
          (Object.keys(state).length !== 2 ||
            !Object.hasOwn(state, "archivedAt"))
        )
          throw databaseUnavailable();
        if (state) archiveTimestamp(state["archivedAt"]);
        const existing = state ? archiveTimestamp(state["archivedAt"]) : null;
        if (archivedAt === null || existing === null) {
          try {
            await legacyStates.updateOne(
              { _id: key, ...(stamp === null ? {} : { archivedAt: null }) },
              { $set: { archivedAt: stamp } },
              { upsert: true, maxTimeMS: 5000 },
            );
          } catch (error) {
            // Another first archive may have won the unique-key upsert race.
            if (!(
              stamp !== null &&
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === 11000
            ))
              throw error;
          }
        }
      } else {
        await model
          .updateOne(
            {
              id,
              "value.status": { $in: ["succeeded", "failed"] },
              ...(stamp === null ? {} : { archivedAt: null }),
            },
            { $set: { archivedAt: stamp } },
            { runValidators: true, maxTimeMS: 5000 },
          )
          .exec();
      }
      const updated = await repository.get(id);
      return (
        updated ?? ((await repository.isDeleted(id)) ? "deleted" : "missing")
      );
    },
    async remove(id, deletedAt) {
      const stamp = mutationDate(deletedAt);
      if (!stamp) throw databaseUnavailable();
      const current = await repository.get(id);
      if (!current)
        return (await repository.isDeleted(id)) ? "deleted" : "missing";
      if (current.status === "running") return "running";
      if (id.startsWith("legacy-")) {
        const key = legacyKey(id);
        await legacy.findOneAndReplace(
          { key, deletedAt: null },
          { key, deletedAt: stamp },
          { returnDocument: "after", maxTimeMS: 5000 },
        );
      } else {
        // The retained unique identity is the permanent replay admission barrier.
        await model.collection.findOneAndReplace(
          { id, "value.status": { $in: ["succeeded", "failed"] } },
          { id, deletedAt: stamp },
          { returnDocument: "after", maxTimeMS: 5000 },
        );
      }
      if (await repository.isDeleted(id)) return "deleted";
      const remaining = await repository.get(id);
      return remaining?.status === "running" ? "running" : "missing";
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
        .aggregate([
          { $match: filter },
          liveDocuments("id"),
          visibleDocuments("active"),
          { $sort: { createdAt: -1, id: -1 } },
          { $limit: 1 },
        ])
        .option({ maxTimeMS: 5000 })
        .exec();
      const current = entry[0] ? storedRun(entry[0]) : null;
      const key =
        source === "tiobe"
          ? "tiobe"
          : source === "amazon" && inputs
            ? `amazon:${inputs["query"]}`
            : null;
      const candidates =
        key || (source === "amazon" && !inputs)
          ? await legacy
              .aggregate(
                [
                  { $match: key ? { key } : { key: /^amazon:/u } },
                  liveDocuments("key"),
                  ...legacyManagement(),
                  visibleDocuments("active", true),
                  { $sort: { createdAt: -1, key: -1 } },
                  { $limit: 1 },
                ],
                { maxTimeMS: 5000 },
              )
              .toArray()
          : [];
      const older = candidates[0] ? legacyRun(candidates[0]) : null;
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
