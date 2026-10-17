import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectMongoRuns } from "../../apps/api/mongo-runs.js";
import { createRunService } from "../../apps/api/run-service.js";
import { decodeCursor, legacyId } from "../../apps/api/run-contract.js";
import { bookRecord, languageRecords } from "../../apps/api/test/fixtures.js";
import {
  fakeCollectors,
  runId,
  runningRun,
  sourceInputs,
} from "../../apps/api/test/run-fixtures.js";

// No env file, real app database, provider, target or collector process is accessed.
const name = "web_scraper_runs_integration";
const uri = `mongodb://127.0.0.1:27017/${name}`;
test("Durable history survives reopen, preserves legacy bytes and enforces ownership/recovery", async () => {
  const inspection = await mongoose
    .createConnection(uri, { serverSelectionTimeoutMS: 5000 })
    .asPromise();
  const nonce = randomUUID();
  let runtime,
    ownerCreated = false;
  try {
    assert.ok(inspection.db);
    assert.equal(inspection.db.databaseName, name);
    const names = await inspection.db.admin().listDatabases({ nameOnly: true });
    assert.equal(
      names.databases.some((entry) => entry.name === name),
      false,
      "Refuse to touch an existing test namespace.",
    );
    await inspection.db.collection("_wsp_test_owner").insertOne({ nonce });
    ownerCreated = true;
    const legacy = inspection.db.collection("collectionbatches");
    await legacy.insertMany([
      {
        key: "amazon:query",
        data: [bookRecord()],
        createdAt: new Date("2026-10-15T12:00:00.000Z"),
        updatedAt: new Date("2026-10-15T12:00:00.000Z"),
      },
      { key: "tiobe", data: languageRecords() },
    ]);
    const before = JSON.stringify(
      await legacy.find({}).sort({ key: 1 }).toArray(),
    );
    runtime = await connectMongoRuns(uri);
    await assert.rejects(connectMongoRuns(uri), {
      code: "API_ALREADY_RUNNING",
    });
    const prior = await runtime.repository.get(legacyId("amazon:query"));
    assert.equal(prior.provenance, "legacy-cache");
    assert.equal(prior.collectedAt, null);
    assert.equal(prior.startedAt, null);
    assert.equal(prior.savedAt, "2026-10-15T12:00:00.000Z");
    const unknownTime = await runtime.repository.get(legacyId("tiobe"));
    assert.equal(unknownTime.createdAt, null);
    assert.equal(unknownTime.savedAt, null);
    let calls = 0;
    const service = createRunService({
      repository: runtime.repository,
      collectionEnabled: true,
      collectors: {
        ...fakeCollectors(),
        amazon: async () => {
          calls++;
          return [bookRecord()];
        },
      },
    });
    for (const number of [1, 2]) {
      await service.submit({
        source: "amazon",
        inputs: sourceInputs.amazon,
        requestId: runId(number),
      });
      await service.idle();
    }
    assert.equal(calls, 2);
    for (const [number, source] of [
      [4, "indeed"],
      [5, "booking"],
      [6, "tiobe"],
    ]) {
      await service.submit({
        source,
        inputs: sourceInputs[source],
        requestId: runId(number),
      });
      await service.idle();
      const result = await service.get(runId(number));
      assert.equal(result.status, "succeeded");
      assert.deepEqual(result.inputs, sourceInputs[source]);
    }
    const first = await service.get(runId(1));
    assert.equal(first.status, "succeeded");
    const forged = {
      ...first,
      data: [{ ...bookRecord(), title: "Replacement" }],
    };
    assert.deepEqual(
      await runtime.repository.finish(forged),
      first,
      "Terminal writes cannot replace a completed snapshot.",
    );
    const page1 = await runtime.repository.list({
      limit: 1,
      source: "amazon",
      cursor: null,
    });
    assert.equal(page1.runs.length, 1);
    assert.ok(page1.nextCursor);
    const page2 = await runtime.repository.list({
      limit: 1,
      source: "amazon",
      cursor: decodeCursor(page1.nextCursor),
    });
    assert.equal(page2.runs.length, 1);
    assert.notEqual(page1.runs[0].id, page2.runs[0].id);
    assert.ok(page2.nextCursor);
    const page3 = await runtime.repository.list({
      limit: 1,
      source: "amazon",
      cursor: decodeCursor(page2.nextCursor),
    });
    assert.equal(page3.runs[0].id, prior.id);
    assert.equal(page3.nextCursor, null);
    const filtered = await runtime.repository.list({
      limit: 20,
      source: "indeed",
      cursor: null,
    });
    assert.equal(filtered.runs.length, 1);
    assert.equal(filtered.runs[0].source, "indeed");
    assert.equal(filtered.nextCursor, null);
    assert.equal(
      (await runtime.repository.latest("amazon", sourceInputs.amazon)).id,
      runId(2),
    );
    await service.close();
    await runtime.close();
    runtime = null;
    runtime = await connectMongoRuns(uri);
    assert.deepEqual(await runtime.repository.get(runId(1)), first);
    for (const [number, source] of [
      [4, "indeed"],
      [5, "booking"],
      [6, "tiobe"],
    ]) {
      const result = await runtime.repository.get(runId(number));
      assert.deepEqual(result.inputs, sourceInputs[source]);
      assert.deepEqual(result.data, await fakeCollectors()[source]());
    }
    const indexes = await inspection.db.collection("collectionruns").indexes();
    assert.ok(indexes.some((index) => index.key.id === 1 && index.unique));
    await runtime.repository.insert(runningRun(runId(3)));
    await runtime.close();
    runtime = null;
    await inspection.db.collection("collectionruntimeowners").insertOne({
      key: "web-scraper",
      pid: 99999999,
      nonce: "dead-test-owner",
    });
    runtime = await connectMongoRuns(uri, { isAlive: () => false });
    const interrupted = await runtime.repository.get(runId(3));
    assert.equal(interrupted.status, "failed");
    assert.equal(interrupted.error.code, "RUN_INTERRUPTED");
    assert.equal(interrupted.data, null);
    assert.equal(
      JSON.stringify(await legacy.find({}).sort({ key: 1 }).toArray()),
      before,
      "Legacy documents remain byte-value identical.",
    );
    await legacy.insertMany(
      ["\uE000", "😀"].map((query) => ({
        key: `amazon:${query}`,
        data: [bookRecord(query)],
        createdAt: new Date("2026-10-14T12:00:00.000Z"),
      })),
    );
    const seen = [];
    let cursor = null;
    do {
      const page = await runtime.repository.list({
        source: "amazon",
        limit: 1,
        cursor,
      });
      seen.push(...page.runs.map((run) => run.id));
      cursor = decodeCursor(page.nextCursor ?? undefined);
    } while (cursor);
    assert.equal(new Set(seen).size, seen.length);
    assert.ok(
      seen.indexOf(legacyId("amazon:😀")) <
        seen.indexOf(legacyId("amazon:\uE000")),
      "History tie ordering matches Mongo's UTF-8 binary collation.",
    );
    for (const [field, changed, restored, lookup] of [
      ["id", runId(90), runId(1), runId(90)],
      ["source", "indeed", "amazon", runId(1)],
      [
        "createdAt",
        new Date("2027-01-01T00:00:00.000Z"),
        new Date(first.createdAt),
        runId(1),
      ],
    ]) {
      await inspection.db
        .collection("collectionruns")
        .updateOne({ id: runId(1) }, { $set: { [field]: changed } });
      await assert.rejects(runtime.repository.get(lookup), {
        code: "DATABASE_UNAVAILABLE",
      });
      await inspection.db
        .collection("collectionruns")
        .updateOne(
          { id: field === "id" ? changed : runId(1) },
          { $set: { [field]: restored } },
        );
    }
    await inspection.db
      .collection("collectionruns")
      .updateOne(
        { id: runId(1) },
        { $set: { "value.data.0.url": "https://evil.invalid/dp/B000000001" } },
      );
    await assert.rejects(runtime.repository.get(runId(1)), {
      code: "DATABASE_UNAVAILABLE",
    });
  } finally {
    try {
      if (runtime) await runtime.close();
      if (ownerCreated && inspection.db) {
        assert.equal(
          inspection.db.databaseName,
          "web_scraper_runs_integration",
        );
        assert.ok(
          await inspection.db.collection("_wsp_test_owner").findOne({ nonce }),
          "Cleanup requires this test's owner marker.",
        );
        const allowed = new Set([
          "_wsp_test_owner",
          "collectionruns",
          "collectionruntimeowners",
          "collectionbatches",
        ]);
        const collections = await inspection.db
          .listCollections({}, { nameOnly: true })
          .toArray();
        assert.ok(
          collections.every((entry) => allowed.has(entry.name)),
          "Unexpected collections prevent cleanup.",
        );
        await inspection.db.dropDatabase();
      }
    } finally {
      await inspection.close();
    }
  }
});
