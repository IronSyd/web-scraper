import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { AppError } from "../errors.js";
import { createRunService } from "../run-service.js";
import {
  fakeCollectors,
  memoryRuns,
  runId,
  sourceInputs,
} from "./run-fixtures.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withApi(options, check) {
  const app = createApp(options);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await check(`http://127.0.0.1:${server.address().port}`, app.locals.runs);
  } finally {
    await app.locals.runs.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const source of ["amazon", "booking", "indeed", "tiobe"])
  test(`Health exposes only the actual held ${source} run and returns idle after its saved finish`, async () => {
    const held = deferred();
    const savedRepository = memoryRuns();
    let repositoryCalls = 0;
    const repository = Object.fromEntries(
      ["get", "insert", "finish", "list", "latest"].map((name) => [
        name,
        async (...args) => {
          repositoryCalls++;
          return savedRepository[name](...args);
        },
      ]),
    );
    let collectionCalls = 0;
    await withApi(
      {
        repository,
        collectionEnabled: true,
        collectors: {
          [source]: async () => {
            collectionCalls++;
            await held.promise;
            return fakeCollectors()[source]();
          },
        },
      },
      async (base, runs) => {
        assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), {
          status: "ok",
          collectionEnabled: true,
          activeRun: null,
        });
        assert.equal(repositoryCalls, 0);
        assert.equal(collectionCalls, 0);
        await runs.submit({
          source,
          inputs: sourceInputs[source],
          requestId: runId(),
        });
        const callsAfterAdmission = repositoryCalls;
        try {
          for (let read = 0; read < 3; read++) {
            assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), {
              status: "ok",
              collectionEnabled: true,
              activeRun: { id: runId(), source },
            });
          }
          assert.equal(collectionCalls, 1);
          assert.equal(repositoryCalls, callsAfterAdmission);
          const publicActivity = runs.activeRun;
          publicActivity.id = runId(99);
          publicActivity.source = "private diagnostic";
          assert.deepEqual(runs.activeRun, { id: runId(), source });
        } finally {
          held.resolve();
        }
        await runs.idle();
        assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), {
          status: "ok",
          collectionEnabled: true,
          activeRun: null,
        });
        assert.equal(savedRepository.entries.get(runId()).status, "succeeded");
        assert.equal(collectionCalls, 1);
      },
    );
  });

test("Paused health reads do not touch unavailable storage or invoke any collector", async () => {
  let repositoryCalls = 0;
  let collectionCalls = 0;
  const unavailable = async () => {
    repositoryCalls++;
    throw new Error("PRIVATE_STORAGE_DIAGNOSTIC");
  };
  await withApi(
    {
      repository: {
        get: unavailable,
        insert: unavailable,
        finish: unavailable,
        list: unavailable,
        latest: unavailable,
      },
      collectors: {
        indeed: async () => {
          collectionCalls++;
          throw new Error("PRIVATE_COLLECTOR_DIAGNOSTIC");
        },
      },
    },
    async (base) => {
      for (let read = 0; read < 3; read++)
        assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), {
          status: "ok",
          collectionEnabled: false,
          activeRun: null,
        });
      assert.equal(repositoryCalls, 0);
      assert.equal(collectionCalls, 0);
    },
  );
});

test("Activity remains set through the terminal persistence attempt", async () => {
  const saving = deferred();
  const reachedSave = deferred();
  const repository = memoryRuns();
  const finish = repository.finish;
  repository.finish = async (run) => {
    reachedSave.resolve();
    await saving.promise;
    return finish(run);
  };
  const service = createRunService({
    repository,
    collectors: fakeCollectors(),
    collectionEnabled: true,
  });
  await service.submit({
    source: "indeed",
    inputs: sourceInputs.indeed,
    requestId: runId(),
  });
  try {
    await reachedSave.promise;
    assert.deepEqual(service.activeRun, { id: runId(), source: "indeed" });
    assert.equal(repository.entries.get(runId()).status, "running");
  } finally {
    saving.resolve();
    await service.close();
  }
  assert.equal(service.activeRun, null);
});

for (const outcome of ["failure", "cancellation", "persistence failure"])
  test(`Activity clears after ${outcome} without reporting a saved outcome`, async () => {
    const held = deferred();
    const repository = memoryRuns();
    if (outcome === "persistence failure")
      repository.finish = async () => {
        throw new Error("PRIVATE_STORAGE_DIAGNOSTIC");
      };
    const service = createRunService({
      repository,
      collectionEnabled: true,
      collectors: {
        indeed: async (_inputs, signal) => {
          if (outcome === "cancellation") {
            await new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new Error("PRIVATE_ABORT_DIAGNOSTIC")),
                { once: true },
              );
            });
          } else await held.promise;
          if (outcome === "failure")
            throw new AppError(502, "UPSTREAM_BLOCKED", "PRIVATE_DIAGNOSTIC");
          return fakeCollectors().indeed();
        },
      },
    });
    await service.submit({
      source: "indeed",
      inputs: sourceInputs.indeed,
      requestId: runId(),
    });
    assert.deepEqual(service.activeRun, { id: runId(), source: "indeed" });
    if (outcome === "cancellation") await service.close();
    else {
      held.resolve();
      await service.idle();
    }
    assert.equal(service.activeRun, null);
    const saved = await service.get(runId());
    assert.equal(
      saved.status,
      outcome === "persistence failure" ? "running" : "failed",
    );
    if (outcome !== "persistence failure")
      assert.equal(
        saved.error.code,
        outcome === "cancellation" ? "RUN_CANCELLED" : "UPSTREAM_BLOCKED",
      );
    assert.doesNotMatch(JSON.stringify(service.activeRun), /PRIVATE/u);
    await service.close();
  });
