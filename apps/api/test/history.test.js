import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { createRunService } from "../run-service.js";
import { decodeCursor, legacyId, validateRun } from "../run-contract.js";
import { bookRecord, languageRecords } from "./fixtures.js";
import { memoryRuns, runId, runningRun, sourceInputs } from "./run-fixtures.js";

function success(number = 1) {
  const stamp = `2026-10-19T12:00:${String(number).padStart(2, "0")}.000Z`;
  return validateRun({
    ...runningRun(runId(number)),
    createdAt: stamp,
    startedAt: stamp,
    savedAt: stamp,
    completedAt: stamp,
    collectedAt: stamp,
    status: "succeeded",
    data: [bookRecord()],
    resultCount: 1,
  });
}

test("Archive and restore retain snapshot bytes, filter latest/history and preserve pagination", async () => {
  const prior = success(1),
    latest = success(2),
    last = success(3);
  const repository = memoryRuns([prior, latest, last]);
  const service = createRunService({ repository, collectors: {} });
  const archived = await service.archive(last.id, { archived: true });
  assert.ok(archived.archivedAt);
  assert.deepEqual(archived.data, last.data);
  assert.equal(archived.savedAt, last.savedAt);
  assert.deepEqual(
    await service.archive(last.id, { archived: true }),
    archived,
  );
  assert.deepEqual(await service.get(last.id), archived);
  assert.equal((await service.latest("amazon")).id, latest.id);
  const page = await service.list({ source: "amazon", limit: 1, cursor: null });
  assert.equal(page.runs[0].id, latest.id);
  assert.ok(page.nextCursor);
  const older = await service.list({
    source: "amazon",
    limit: 1,
    cursor: decodeCursor(page.nextCursor),
  });
  assert.equal(older.runs[0].id, prior.id);
  assert.equal(older.nextCursor, null);
  const hidden = await service.list({
    source: "amazon",
    visibility: "archived",
    limit: 20,
    cursor: null,
  });
  assert.deepEqual(
    hidden.runs.map((run) => run.id),
    [last.id],
  );
  assert.equal(Object.hasOwn(hidden.runs[0], "data"), false);
  const restored = await service.archive(last.id, { archived: false });
  assert.equal(restored.archivedAt, null);
  assert.deepEqual(restored, last);
  assert.deepEqual(await service.archive(last.id, { archived: false }), last);
  assert.equal((await service.latest("amazon")).id, last.id);
});

test("Permanent deletion rejects replay even when collection is enabled or admission races", async () => {
  let calls = 0;
  const saved = success();
  const repository = memoryRuns([saved]);
  const service = createRunService({
    repository,
    collectors: {
      amazon: async () => {
        calls++;
        return [bookRecord()];
      },
    },
    collectionEnabled: true,
  });
  await service.remove(saved.id, { confirm: true });
  assert.equal(repository.entries.has(saved.id), false);
  assert.equal(repository.retired.has(saved.id), true);
  await service.remove(saved.id, { confirm: true });
  await assert.rejects(service.get(saved.id), {
    status: 410,
    code: "RUN_DELETED",
  });
  await assert.rejects(service.archive(saved.id, { archived: false }), {
    status: 410,
  });
  const body = {
    source: "amazon",
    inputs: sourceInputs.amazon,
    requestId: saved.id,
  };
  await assert.rejects(service.submit(body), { status: 410 });
  assert.equal(await service.latest("amazon"), null);
  assert.deepEqual((await service.list({ limit: 20, cursor: null })).runs, []);
  assert.equal(calls, 0);

  // Simulate deletion after the initial lookup and before insert's unique-ID check.
  const racing = memoryRuns();
  const racingService = createRunService({
    repository: {
      ...racing,
      insert: async () => {
        racing.retired.add(saved.id);
        return false;
      },
    },
    collectionEnabled: true,
    collectors: {
      amazon: async () => {
        calls++;
        return [bookRecord()];
      },
    },
  });
  await assert.rejects(racingService.submit(body), {
    status: 410,
    code: "RUN_DELETED",
  });
  assert.equal(calls, 0);
});

test("Running attempts, malformed input, and storage failures are safe management failures", async () => {
  const run = runningRun(),
    repository = memoryRuns([run]);
  const service = createRunService({ repository, collectors: {} });
  for (const body of [{ archived: true }, { archived: false }])
    await assert.rejects(service.archive(run.id, body), {
      status: 409,
      code: "RUN_RUNNING",
    });
  await assert.rejects(service.remove(run.id, { confirm: true }), {
    status: 409,
  });
  assert.deepEqual(await service.get(run.id), run);
  for (const body of [
    undefined,
    {},
    { archived: "true" },
    { archived: true, extra: true },
  ])
    await assert.rejects(service.archive(run.id, body), { status: 400 });
  for (const body of [
    undefined,
    {},
    { confirm: false },
    { confirm: "true" },
    { confirm: true, extra: true },
  ])
    await assert.rejects(service.remove(run.id, body), { status: 400 });
  for (const method of ["archive", "remove"])
    await assert.rejects(
      service[method](
        "bad",
        method === "archive" ? { archived: true } : { confirm: true },
      ),
      { status: 400 },
    );
  await assert.rejects(service.remove(runId(99), { confirm: true }), {
    status: 404,
  });
  await assert.rejects(service.archive(runId(99), { archived: true }), {
    status: 404,
  });
  for (const method of ["archive", "remove"]) {
    const failing = createRunService({
      repository: {
        ...repository,
        [method]: async () => {
          throw new Error("SECRET");
        },
      },
      collectors: {},
    });
    await assert.rejects(
      failing[method](
        run.id,
        method === "archive" ? { archived: true } : { confirm: true },
      ),
      (error) =>
        error.code === "DATABASE_UNAVAILABLE" &&
        !error.message.includes("SECRET"),
    );
  }
});

async function withApi(repository, check) {
  let calls = 0;
  const app = createApp({
    repository,
    collectionEnabled: false,
    collectors: {
      amazon: async () => {
        calls++;
        return [bookRecord()];
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await check(base);
    assert.equal(calls, 0);
  } finally {
    await app.locals.runs.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Management HTTP endpoints work while paused and saved GETs never collect", async () => {
  const saved = success();
  const legacy = validateRun({
    ...saved,
    id: legacyId("tiobe"),
    source: "tiobe",
    inputs: {},
    provenance: "legacy-cache",
    startedAt: null,
    completedAt: null,
    collectedAt: null,
    resultCount: 20,
    data: languageRecords(),
  });
  await withApi(memoryRuns([saved, legacy]), async (base) => {
    const send = (id, method, body, suffix = "") =>
      fetch(`${base}/api/runs/${id}${suffix}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await fetch(`${base}/api/books/amazon?q=query`)).status, 200);
    const response = await send(saved.id, "PATCH", { archived: true });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).run.archivedAt);
    assert.equal((await fetch(`${base}/api/books/amazon?q=query`)).status, 404);
    assert.equal(
      (await (await fetch(`${base}/api/runs/latest?source=amazon`)).json()).run,
      null,
    );
    assert.equal(
      (await (await fetch(`${base}/api/runs/${saved.id}`)).json()).run.id,
      saved.id,
    );
    const archived = await (
      await fetch(`${base}/api/runs?visibility=archived`)
    ).json();
    assert.deepEqual(
      archived.runs.map((run) => run.id),
      [saved.id],
    );
    assert.equal(
      (await send(saved.id, "PATCH", { archived: false })).status,
      200,
    );
    assert.equal((await fetch(`${base}/api/books/amazon?q=query`)).status, 200);
    assert.equal(
      (await send(legacy.id, "PATCH", { archived: true })).status,
      200,
    );
    assert.equal((await fetch(`${base}/api/tiobe`)).status, 404);
    assert.equal(
      (await send(legacy.id, "PATCH", { archived: false })).status,
      200,
    );
    assert.equal((await fetch(`${base}/api/tiobe`)).status, 200);
    for (const id of [saved.id, legacy.id]) {
      for (let index = 0; index < 2; index++) {
        const deleted = await send(id, "DELETE", { confirm: true });
        assert.equal(deleted.status, 200);
        assert.deepEqual(await deleted.json(), { id, deleted: true });
      }
      assert.equal((await fetch(`${base}/api/runs/${id}`)).status, 410);
      assert.equal((await send(id, "PATCH", { archived: false })).status, 410);
    }
    assert.equal((await fetch(`${base}/api/runs?visibility=all`)).status, 400);
    assert.equal(
      (await fetch(`${base}/api/runs?visibility=active&visibility=archived`))
        .status,
      400,
    );
    for (const [method, body, suffix, expected] of [
      ["PATCH", { archived: true, extra: true }, "", 400],
      ["PATCH", { archived: true }, "?extra=1", 400],
      ["DELETE", { confirm: false }, "", 400],
      ["DELETE", { confirm: true }, "?extra=1", 400],
    ])
      assert.equal(
        (await send(saved.id, method, body, suffix)).status,
        expected,
      );
    assert.equal(
      (
        await fetch(`${base}/api/runs/${saved.id}`, {
          method: "DELETE",
          body: "confirm=true",
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await fetch(`${base}/api/runs/${saved.id}`, {
          method: "PATCH",
          headers: {
            Origin: "https://evil.invalid",
            "Content-Type": "application/json",
          },
          body: '{"archived":true}',
        })
      ).status,
      403,
    );
  });
});

test("Archive metadata validation accepts old envelopes but rejects invalid dates and archived running state", () => {
  const saved = success();
  const old = { ...saved };
  delete old.archivedAt;
  assert.equal(validateRun(old).archivedAt, null);
  for (const archivedAt of [true, 1, "bad", "2026-10-19"])
    assert.throws(() => validateRun({ ...saved, archivedAt }), {
      code: "DATABASE_UNAVAILABLE",
    });
  assert.throws(
    () =>
      validateRun({ ...runningRun(), archivedAt: "2026-10-19T12:00:00.000Z" }),
    { code: "DATABASE_UNAVAILABLE" },
  );
});
