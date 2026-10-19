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
    // Management changes envelopes/side metadata, never saved snapshot values.
    const archiveAt = "2026-10-20T12:00:00.000Z",
      laterArchiveAt = "2026-10-21T12:00:00.000Z",
      deletedAt = "2026-10-22T12:00:00.000Z";
    const runs = inspection.db.collection("collectionruns"),
      states = inspection.db.collection("collectionlegacyrunstates");
    const immutableValue = JSON.stringify(
      (await runs.findOne({ id: runId(1) })).value,
    );
    const legacyBeforeArchive = JSON.stringify(
      await legacy.find({}).sort({ key: 1 }).toArray(),
    );
    for (const id of [runId(1), runId(2), prior.id]) {
      assert.equal(
        (await runtime.repository.archive(id, archiveAt)).archivedAt,
        archiveAt,
      );
      assert.equal(
        (await runtime.repository.archive(id, laterArchiveAt)).archivedAt,
        archiveAt,
        "Repeated archive retains its original timestamp.",
      );
    }
    assert.equal(
      JSON.stringify((await runs.findOne({ id: runId(1) })).value),
      immutableValue,
    );
    assert.equal(
      JSON.stringify(await legacy.find({}).sort({ key: 1 }).toArray()),
      legacyBeforeArchive,
    );
    const archivedIds = [];
    let archiveCursor = null;
    do {
      const page = await runtime.repository.list({
        source: "amazon",
        visibility: "archived",
        limit: 1,
        cursor: archiveCursor,
      });
      archivedIds.push(...page.runs.map((run) => run.id));
      archiveCursor = decodeCursor(page.nextCursor ?? undefined);
    } while (archiveCursor);
    assert.deepEqual(
      new Set(archivedIds),
      new Set([runId(1), runId(2), prior.id]),
    );
    const activeIds = (
      await runtime.repository.list({
        source: "amazon",
        limit: 20,
        cursor: null,
      })
    ).runs.map((run) => run.id);
    assert.ok(activeIds.every((id) => !archivedIds.includes(id)));
    assert.equal(
      await runtime.repository.latest("amazon", sourceInputs.amazon),
      null,
    );
    assert.notEqual(
      (await runtime.repository.latest("amazon")).id,
      prior.id,
      "Legacy selection advances past the newest archived candidate before limiting.",
    );
    for (const id of [runId(1), runId(2), prior.id]) {
      assert.equal(
        (await runtime.repository.archive(id, null)).archivedAt,
        null,
      );
      assert.equal(
        (await runtime.repository.archive(id, null)).archivedAt,
        null,
      );
    }
    assert.equal(
      (await runtime.repository.latest("amazon", sourceInputs.amazon)).id,
      runId(2),
    );
    assert.equal(
      JSON.stringify(await legacy.find({}).sort({ key: 1 }).toArray()),
      legacyBeforeArchive,
    );
    assert.deepEqual((await runtime.repository.get(prior.id)).data, prior.data);

    // Both a current run and a virtual legacy identity retire atomically.
    assert.deepEqual(
      await Promise.all(
        Array.from({ length: 4 }, () =>
          runtime.repository.remove(runId(2), deletedAt),
        ),
      ),
      ["deleted", "deleted", "deleted", "deleted"],
    );
    const retired = await runs.findOne({ id: runId(2) });
    assert.deepEqual(Object.keys(retired).sort(), ["_id", "deletedAt", "id"]);
    assert.equal(retired.deletedAt.toISOString(), deletedAt);
    assert.equal(await runtime.repository.get(runId(2)), null);
    assert.equal(await runtime.repository.isDeleted(runId(2)), true);
    assert.equal(await runtime.repository.archive(runId(2), null), "deleted");
    assert.equal(await runtime.repository.insert(runningRun(runId(2))), false);
    assert.equal(
      (await runtime.repository.latest("amazon", sourceInputs.amazon)).id,
      runId(1),
    );
    const tiobeLegacyId = legacyId("tiobe");
    await runtime.repository.archive(tiobeLegacyId, archiveAt);
    assert.equal(
      await runtime.repository.remove(tiobeLegacyId, deletedAt),
      "deleted",
    );
    assert.equal(
      await runtime.repository.remove(tiobeLegacyId, deletedAt),
      "deleted",
    );
    assert.equal(
      await runtime.repository.archive(tiobeLegacyId, null),
      "deleted",
    );
    const retiredLegacy = await legacy.findOne({ key: "tiobe" });
    assert.deepEqual(Object.keys(retiredLegacy).sort(), [
      "_id",
      "deletedAt",
      "key",
    ]);
    assert.equal(retiredLegacy.deletedAt.toISOString(), deletedAt);
    assert.equal(await runtime.repository.get(tiobeLegacyId), null);
    assert.equal(await runtime.repository.isDeleted(tiobeLegacyId), true);
    assert.equal((await runtime.repository.latest("tiobe")).id, runId(6));
    assert.equal(
      await runtime.repository.archive(runId(99), archiveAt),
      "missing",
    );
    assert.equal(
      await runtime.repository.remove(runId(99), deletedAt),
      "missing",
    );

    // A collector can finish while management is requested, but its running row
    // must not disappear or be archived before the terminal atomic write.
    let releaseCollector,
      managedCalls = 0;
    const barrier = new Promise((resolve) => {
      releaseCollector = resolve;
    });
    const managed = createRunService({
      repository: runtime.repository,
      collectionEnabled: true,
      collectors: {
        amazon: async () => {
          managedCalls++;
          await barrier;
          return [bookRecord()];
        },
      },
    });
    const managedBody = {
      source: "amazon",
      inputs: sourceInputs.amazon,
      requestId: runId(30),
    };
    await managed.submit(managedBody);
    assert.equal(
      await runtime.repository.archive(runId(30), archiveAt),
      "running",
    );
    assert.equal(
      await runtime.repository.remove(runId(30), deletedAt),
      "running",
    );
    assert.equal((await runtime.repository.get(runId(30))).status, "running");
    releaseCollector();
    await managed.idle();
    const terminal = await runtime.repository.get(runId(30));
    const concurrent = await Promise.all([
      runtime.repository.archive(runId(30), archiveAt),
      runtime.repository.remove(runId(30), deletedAt),
    ]);
    assert.equal(concurrent[1], "deleted");
    assert.equal(await runtime.repository.get(runId(30)), null);
    assert.equal(
      await runtime.repository.finish(terminal),
      null,
      "A later terminal finish cannot resurrect a retired identity.",
    );
    await assert.rejects(managed.submit(managedBody), { code: "RUN_DELETED" });
    assert.equal(managedCalls, 1);
    await managed.close();

    // Malformed management/deletion metadata is a storage error, not absence.
    await runs.updateOne({ id: runId(1) }, { $set: { archivedAt: "invalid" } });
    await assert.rejects(runtime.repository.get(runId(1)), {
      code: "DATABASE_UNAVAILABLE",
    });
    await assert.rejects(runtime.repository.list({ limit: 50, cursor: null }), {
      code: "DATABASE_UNAVAILABLE",
    });
    await runs.updateOne({ id: runId(1) }, { $set: { archivedAt: null } });
    await states.updateOne(
      { _id: "amazon:query" },
      { $set: { archivedAt: new Date(archiveAt), unexpected: true } },
    );
    await assert.rejects(runtime.repository.get(prior.id), {
      code: "DATABASE_UNAVAILABLE",
    });
    await assert.rejects(runtime.repository.list({ limit: 50, cursor: null }), {
      code: "DATABASE_UNAVAILABLE",
    });
    await states.updateOne(
      { _id: "amazon:query" },
      { $set: { archivedAt: null }, $unset: { unexpected: "" } },
    );
    await runs.updateOne({ id: runId(2) }, { $set: { deletedAt: "invalid" } });
    await assert.rejects(runtime.repository.get(runId(2)), {
      code: "DATABASE_UNAVAILABLE",
    });
    await assert.rejects(runtime.repository.isDeleted(runId(2)), {
      code: "DATABASE_UNAVAILABLE",
    });
    await runs.updateOne(
      { id: runId(2) },
      { $set: { deletedAt: new Date(deletedAt) } },
    );
    await legacy.updateOne(
      { key: "tiobe" },
      { $set: { data: languageRecords() } },
    );
    await assert.rejects(runtime.repository.get(tiobeLegacyId), {
      code: "DATABASE_UNAVAILABLE",
    });
    await legacy.updateOne({ key: "tiobe" }, { $unset: { data: "" } });

    // Archive state and permanent replay barriers survive connection reopening.
    await runtime.repository.archive(runId(1), archiveAt);
    await runtime.repository.archive(prior.id, archiveAt);
    await runtime.close();
    runtime = await connectMongoRuns(uri);
    assert.equal(
      (await runtime.repository.get(runId(1))).archivedAt,
      archiveAt,
    );
    assert.equal(
      (await runtime.repository.get(prior.id)).archivedAt,
      archiveAt,
    );
    assert.equal(await runtime.repository.isDeleted(runId(2)), true);
    assert.equal(await runtime.repository.isDeleted(tiobeLegacyId), true);
    let replayCalls = 0;
    const reopened = createRunService({
      repository: runtime.repository,
      collectionEnabled: true,
      collectors: {
        amazon: async () => {
          replayCalls++;
          return [bookRecord()];
        },
      },
    });
    await assert.rejects(
      reopened.submit({ ...managedBody, requestId: runId(2) }),
      { code: "RUN_DELETED" },
    );
    assert.equal(replayCalls, 0);
    await reopened.close();
    await runtime.repository.archive(runId(1), null);
    await runtime.repository.archive(prior.id, null);
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
          "collectionlegacyrunstates",
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
