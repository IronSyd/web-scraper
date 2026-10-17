import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { connectMongoCache } from "../../apps/api/mongo-cache.js";
import { createCollectionService } from "../../apps/api/cache.js";
import { languageRecords } from "../../apps/api/test/fixtures.js";

// Fixed disposable local test database; never reads .env or the user's application database.
const uri = "mongodb://127.0.0.1:27017/web_scraper_integration";

test("Mongo persists one atomic batch and concurrent misses become warm reads", async () => {
  const inspection = await mongoose
    .createConnection(uri, { serverSelectionTimeoutMS: 5000 })
    .asPromise();
  let runtime;
  let owned = false;
  const owner = randomUUID();
  try {
    assert.ok(inspection.db);
    const databases = await inspection
      .getClient()
      .db("admin")
      .admin()
      .listDatabases({
        nameOnly: true,
        filter: { name: "web_scraper_integration" },
      });
    assert.equal(
      databases.databases.length,
      0,
      "Refuse an existing integration namespace.",
    );
    await inspection.db.createCollection("_wsp_integration_owner");
    await inspection.db
      .collection("_wsp_integration_owner")
      .insertOne({ _id: owner });
    owned = true;
    runtime = await connectMongoCache(uri);
    const service = createCollectionService(runtime.repository);
    let collectionCalls = 0;
    const collect = async () => {
      collectionCalls++;
      return languageRecords();
    };
    const cold = await Promise.all(
      Array.from({ length: 5 }, () => service.get("tiobe", collect)),
    );
    assert.equal(collectionCalls, 1);
    assert.ok(
      cold.every(
        (result) => result.source === "collection" && result.data.length === 20,
      ),
    );
    const warm = await createCollectionService(runtime.repository).get(
      "tiobe",
      collect,
    );
    assert.equal(warm.source, "cache");
    assert.equal(collectionCalls, 1);
    assert.equal(
      await inspection.db.collection("collectionbatches").countDocuments(),
      1,
    );
    assert.deepEqual(Object.keys(warm.data[0]).sort(), [
      "imagePath",
      "pLang",
      "ranking",
    ]);
    const stored = await inspection.db
      .collection("collectionbatches")
      .findOne({ key: "tiobe" });
    assert.equal(stored.data.length, 20);
    const indexes = await inspection.db
      .collection("collectionbatches")
      .indexes();
    assert.ok(indexes.some((index) => index.key.key === 1 && index.unique));
  } finally {
    try {
      if (runtime) await runtime.close();
      if (owned && inspection.db) {
        const marker = await inspection.db
          .collection("_wsp_integration_owner")
          .findOne({ _id: owner });
        const collections = await inspection.db
          .listCollections({}, { nameOnly: true })
          .toArray();
        assert.ok(
          marker,
          "Integration ownership must remain verified before cleanup.",
        );
        assert.ok(
          collections.every((entry) =>
            ["collectionbatches", "_wsp_integration_owner"].includes(
              entry.name,
            ),
          ),
        );
        await inspection.db.dropDatabase();
      }
    } finally {
      await inspection.close();
    }
  }
});
