import mongoose from "mongoose";
import { validateCacheData } from "./cache.js";
import { AppError } from "./errors.js";

/** @param {string} uri */
export async function connectMongoCache(uri) {
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== "mongodb:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      parsed.pathname.length < 2
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
      key: { type: String, required: true, unique: true },
      data: { type: mongoose.Schema.Types.Mixed, required: true },
    },
    { timestamps: true, strict: "throw" },
  );
  const model = connection.model("CollectionBatch", schema);
  try {
    await model.init();
  } catch (error) {
    await connection.close();
    throw error;
  }
  /** @type {import('./types.js').CacheRepository} */
  const repository = {
    async get(key) {
      const entry = await model.findOne({ key }).maxTimeMS(5000).lean().exec();
      return entry ? validateCacheData(key, entry.data) : null;
    },
    async set(key, data) {
      await model
        .updateOne(
          { key },
          { $setOnInsert: { data: validateCacheData(key, data) } },
          { upsert: true, runValidators: true, maxTimeMS: 5000 },
        )
        .exec();
    },
  };
  return { repository, close: () => connection.close() };
}
