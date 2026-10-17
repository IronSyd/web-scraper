import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../app.js";
import { closeLocalRuntime } from "../server.js";
import { AppError } from "../errors.js";
import { createRunService } from "../run-service.js";
import {
  cleanRecords,
  decodeCursor,
  encodeCursor,
  legacyId,
  legacyKey,
  normalizeInputs,
  requestId,
  safeRunError,
  validateRun,
} from "../run-contract.js";
import { createHtmlClients } from "../transport.js";
import { bookRecord, languageRecords } from "./fixtures.js";
import {
  fakeCollectors,
  hotelRecord,
  jobRecord,
  memoryRuns,
  runId,
  runningRun,
  sourceInputs,
} from "./run-fixtures.js";

for (const source of ["amazon", "booking", "indeed", "tiobe"])
  test(`${source} persists a distinct validated immutable snapshot per explicit request`, async () => {
    const repository = memoryRuns(),
      collectors = fakeCollectors();
    const service = createRunService({
      repository,
      collectors,
      collectionEnabled: true,
    });
    const first = await service.submit({
      source,
      inputs: sourceInputs[source],
      requestId: runId(1),
    });
    assert.equal(first.status, 202);
    assert.equal(first.run.status, "running");
    await service.idle();
    const saved = await service.get(runId(1));
    assert.equal(saved.status, "succeeded");
    assert.ok(saved.data.length);
    assert.ok(saved.collectedAt);
    assert.equal(saved.resultCount, saved.data.length);
    const second = await service.submit({
      source,
      inputs: sourceInputs[source],
      requestId: runId(2),
    });
    assert.equal(second.status, 202);
    await service.idle();
    assert.deepEqual(await service.get(runId(1)), saved);
    assert.equal(repository.entries.size, 2);
    const history = await service.list({ limit: 20, cursor: null, source });
    assert.equal(history.runs.length, 2);
    assert.ok(history.runs.every((run) => !Object.hasOwn(run, "data")));
  });

test("Durable running acceptance precedes collector dispatch; replay coalesces and mismatched reuse fails", async () => {
  const repository = memoryRuns();
  let release,
    calls = 0;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const service = createRunService({
    repository,
    collectionEnabled: true,
    collectors: {
      amazon: async () => {
        calls++;
        assert.equal(repository.entries.get(runId()).status, "running");
        await barrier;
        return [bookRecord()];
      },
    },
  });
  const body = {
    source: "amazon",
    inputs: { query: " query " },
    requestId: runId(),
  };
  const accepted = await Promise.all(
    Array.from({ length: 8 }, () => service.submit(body)),
  );
  assert.ok(accepted.every((result) => result.status === 202));
  assert.equal(calls, 1);
  await assert.rejects(
    service.submit({ ...body, inputs: { query: "other" } }),
    { code: "REQUEST_ID_CONFLICT" },
  );
  await assert.rejects(service.submit({ ...body, requestId: runId(2) }), {
    code: "COLLECTION_BUSY",
  });
  release();
  await service.idle();
  assert.equal((await service.submit(body)).status, 200);
  assert.equal(calls, 1);
});
test("Pre-save failure stops collection and blocks fresh retries after ambiguous persistence", async () => {
  let calls = 0;
  const service = createRunService({
    repository: {
      ...memoryRuns(),
      insert: async () => {
        throw new Error("SECRET");
      },
    },
    collectors: {
      amazon: async () => {
        calls++;
        return [bookRecord()];
      },
    },
    collectionEnabled: true,
  });
  await assert.rejects(
    service.submit({
      source: "amazon",
      inputs: sourceInputs.amazon,
      requestId: runId(),
    }),
    { code: "DATABASE_UNAVAILABLE" },
  );
  await assert.rejects(
    service.submit({
      source: "amazon",
      inputs: sourceInputs.amazon,
      requestId: runId(2),
    }),
    { code: "COLLECTION_UNAVAILABLE" },
  );
  assert.equal(calls, 0);
});
test("Failed and invalid fresh collections retain previous success with safe errors", async () => {
  const repository = memoryRuns();
  let calls = 0;
  const service = createRunService({
    repository,
    collectors: {
      amazon: async () => {
        if (calls++)
          throw new AppError(
            502,
            "UPSTREAM_BLOCKED",
            "SECRET URL https://secret.invalid",
          );
        return [bookRecord()];
      },
    },
    collectionEnabled: true,
  });
  const body = {
    source: "amazon",
    inputs: sourceInputs.amazon,
    requestId: runId(),
  };
  await service.submit(body);
  await service.idle();
  const prior = await service.get(runId());
  await service.submit({ ...body, requestId: runId(2) });
  await service.idle();
  const failed = await service.get(runId(2));
  assert.equal(failed.status, "failed");
  assert.equal(failed.data, null);
  assert.equal(failed.error.code, "UPSTREAM_BLOCKED");
  assert.doesNotMatch(JSON.stringify(failed), /SECRET|secret.invalid/u);
  assert.deepEqual(await service.latest("amazon"), prior);
});
test("Disabled collection permits reads and existing-token replay, but never starts new work", async () => {
  let calls = 0;
  const repository = memoryRuns(),
    enabled = createRunService({
      repository,
      collectionEnabled: true,
      collectors: {
        amazon: async () => {
          calls++;
          return [bookRecord()];
        },
      },
    });
  const body = {
    source: "amazon",
    inputs: sourceInputs.amazon,
    requestId: runId(),
  };
  await enabled.submit(body);
  await enabled.idle();
  const disabled = createRunService({
    repository,
    collectors: {
      amazon: async () => {
        calls++;
        return [bookRecord()];
      },
    },
  });
  assert.equal((await disabled.submit(body)).status, 200);
  await assert.rejects(disabled.submit({ ...body, requestId: runId(2) }), {
    code: "COLLECTION_DISABLED",
  });
  assert.equal((await disabled.latest("amazon")).id, runId());
  assert.equal(calls, 1);
});
test("Shutdown aborts accepted collection and persists cancellation without retry", async () => {
  const service = createRunService({
    repository: memoryRuns(),
    collectionEnabled: true,
    collectors: {
      amazon: async (_inputs, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("SECRET")), {
            once: true,
          }),
        ),
    },
  });
  await service.submit({
    source: "amazon",
    inputs: sourceInputs.amazon,
    requestId: runId(),
  });
  await service.close();
  const run = await service.get(runId());
  assert.equal(run.status, "failed");
  assert.equal(run.error.code, "RUN_CANCELLED");
  await assert.rejects(
    service.submit({
      source: "amazon",
      inputs: sourceInputs.amazon,
      requestId: runId(2),
    }),
    { code: "COLLECTION_UNAVAILABLE" },
  );
});
test("Unconfirmed cleanup and failed terminal persistence block further collection", async () => {
  for (const mode of ["cleanup", "persistence"]) {
    const repository = memoryRuns();
    if (mode === "persistence")
      repository.finish = async () => {
        throw new Error("SECRET");
      };
    const service = createRunService({
      repository,
      collectionEnabled: true,
      collectors: {
        amazon: async () => {
          if (mode === "cleanup")
            throw new AppError(502, "COLLECTOR_CLEANUP_FAILED", "SECRET");
          return [bookRecord()];
        },
      },
    });
    await service.submit({
      source: "amazon",
      inputs: sourceInputs.amazon,
      requestId: runId(),
    });
    await service.idle();
    await assert.rejects(
      service.submit({
        source: "amazon",
        inputs: sourceInputs.amazon,
        requestId: runId(2),
      }),
      { code: "COLLECTION_UNAVAILABLE" },
    );
  }
});

test("Shutdown preserves cleanup uncertainty rather than masking it as cancellation", async () => {
  const service = createRunService({
    repository: memoryRuns(),
    collectionEnabled: true,
    collectors: {
      amazon: async (_inputs, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () =>
              reject(new AppError(502, "COLLECTOR_CLEANUP_FAILED", "SECRET")),
            { once: true },
          ),
        ),
    },
  });
  await service.submit({
    source: "amazon",
    inputs: sourceInputs.amazon,
    requestId: runId(),
  });
  await assert.rejects(service.close(), { code: "COLLECTOR_CLEANUP_FAILED" });
  assert.equal(
    (await service.get(runId())).error.code,
    "COLLECTOR_CLEANUP_FAILED",
  );
});
test("Runtime shutdown rejection stops HTTP while retaining conservative storage ownership", async () => {
  const server = http
    .createServer((_req, res) => res.end("ok"))
    .listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  let closedDatabase = false;
  const failure = new Error("Bounded collector shutdown failed");
  await assert.rejects(
    closeLocalRuntime(
      server,
      async () => {
        throw failure;
      },
      async () => {
        closedDatabase = true;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(server.listening, false);
  assert.equal(closedDatabase, false);
});
test("Shutdown during durable admission does not start the collector", async () => {
  const repository = memoryRuns();
  let release,
    calls = 0;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const service = createRunService({
    repository: {
      ...repository,
      insert: async (run) => {
        await wait;
        return repository.insert(run);
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
  const pending = service.submit({
    source: "amazon",
    inputs: sourceInputs.amazon,
    requestId: runId(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    service.submit({
      source: "amazon",
      inputs: sourceInputs.amazon,
      requestId: runId(2),
    }),
    { code: "COLLECTION_BUSY" },
  );
  const stopping = service.close();
  release();
  await pending;
  await stopping;
  assert.equal(calls, 0);
  assert.equal((await service.get(runId())).error.code, "RUN_CANCELLED");
});
test("Source inputs preserve case/punctuation, reject extras, control characters and impossible dates", () => {
  assert.deepEqual(normalizeInputs("amazon", { query: "  C++ & Java  " }), {
    query: "C++ & Java",
  });
  assert.deepEqual(
    normalizeInputs("booking", {
      ...sourceInputs.booking,
      checkin: "2024-02-29",
      checkout: "2024-03-01",
    }),
    { ...sourceInputs.booking, checkin: "2024-02-29", checkout: "2024-03-01" },
  );
  for (const [source, inputs] of [
    ["other", {}],
    ["tiobe", { url: "x" }],
    ["amazon", { query: "a", key: "secret" }],
    ["amazon", { query: "a\nb" }],
    ["indeed", { query: "a" }],
    ["booking", { ...sourceInputs.booking, checkin: "2026-02-30" }],
    ["booking", { ...sourceInputs.booking, adults: 1.5 }],
    ["booking", { ...sourceInputs.booking, checkout: "2026-12-20" }],
  ])
    assert.throws(() => normalizeInputs(source, inputs), { status: 400 });
  assert.throws(() => requestId("not-uuid"), { status: 400 });
  assert.throws(
    () =>
      normalizeInputs("booking", {
        ...sourceInputs.booking,
        checkin: "0000-01-01",
        checkout: "0000-01-02",
      }),
    { status: 400 },
  );
});
test("Cleaning normalizes visible fields, deduplicates by source identity, and strips internal fields", () => {
  const book = {
    ...bookRecord(),
    title: "  Example \n Book  ",
    authors: [" Alice ", "Alice"],
    raw: "SECRET",
  };
  const amazon = cleanRecords("amazon", sourceInputs.amazon, [
    book,
    { ...book, title: "Later" },
  ]);
  assert.equal(amazon.length, 1);
  assert.equal(amazon[0].title, "Example Book");
  assert.deepEqual(amazon[0].authors, ["Alice"]);
  assert.equal(Object.hasOwn(amazon[0], "raw"), false);
  const jobs = cleanRecords("indeed", sourceInputs.indeed, [
    jobRecord(),
    { ...jobRecord(), title: "Later" },
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "Later");
  const hotels = cleanRecords("booking", sourceInputs.booking, [
    hotelRecord(),
    { ...hotelRecord(), price: null },
  ]);
  assert.equal(hotels.length, 1);
  assert.equal(hotels[0].price, null);
});
test("Record validation rejects empty/challenge-like results, unsafe URLs, context mismatches and oversized fields", () => {
  for (const [source, records] of [
    ["amazon", []],
    ["tiobe", languageRecords().slice(1)],
    ["amazon", [{ ...bookRecord(), title: "x".repeat(2001) }]],
    [
      "amazon",
      [{ ...bookRecord(), authors: Array.from({ length: 101 }, () => "Name") }],
    ],
    [
      "indeed",
      [{ ...jobRecord(), url: "https://evil.invalid/viewjob?jk=ab123456" }],
    ],
    [
      "indeed",
      [
        {
          ...jobRecord(),
          url: "https://www.indeed.com/viewjob?jk=ab123456&extra=x",
        },
      ],
    ],
    [
      "booking",
      [
        {
          ...hotelRecord(),
          url: hotelRecord().url.replace("group_adults=2", "group_adults=3"),
        },
      ],
    ],
    ["booking", [{ ...hotelRecord(), reviewCount: -1 }]],
    ["booking", [{ ...hotelRecord(), currency: "pounds" }]],
  ])
    assert.throws(() => cleanRecords(source, sourceInputs[source], records), {
      code: "UPSTREAM_INVALID_PAGE",
    });
});
test("Legacy identifiers and keyset cursors require canonical safe values", () => {
  const id = legacyId("amazon:C++ & Java");
  assert.equal(legacyKey(id), "amazon:C++ & Java");
  const cursor = { time: 1234, tie: "legacy:amazon:C++ & Java" };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  for (const value of [
    "not-base64!",
    encodeCursor({ time: Infinity, tie: runId() }),
    Buffer.from('{"time":1,"tie":"bad"}').toString("base64url"),
  ])
    assert.throws(() => decodeCursor(value), { status: 400 });
  assert.throws(() => legacyKey(`${id}=`), { status: 400 });
  assert.throws(() => legacyKey(legacyId("booking:bad")), { status: 400 });
});
test("Stored DTO validation rejects inconsistent statuses, forged legacy metadata and unsafe data", () => {
  const running = runningRun();
  assert.deepEqual(validateRun(running), running);
  for (const value of [
    { ...running, data: [] },
    { ...running, createdAt: null },
    { ...running, status: "succeeded", data: [] },
    { ...running, provenance: "legacy-cache", id: legacyId("tiobe") },
  ])
    assert.throws(() => validateRun(value), { code: "DATABASE_UNAVAILABLE" });
  assert.equal(safeRunError(new Error("SECRET")).code, "INTERNAL_ERROR");
});

async function withApi(options, check) {
  const app = createApp(options),
    server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await check(`http://127.0.0.1:${server.address().port}`, app.locals.runs);
  } finally {
    await app.locals.runs.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
test("Fresh HTTP POST accepts once and all saved-data GETs/reloads remain collection-free", async () => {
  let calls = 0;
  await withApi(
    {
      repository: memoryRuns(),
      collectionEnabled: true,
      collectors: {
        amazon: async () => {
          calls++;
          return [bookRecord()];
        },
      },
    },
    async (base, runs) => {
      assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), {
        status: "ok",
        collectionEnabled: true,
        activeRun: null,
      });
      const body = {
        source: "amazon",
        inputs: sourceInputs.amazon,
        requestId: runId(),
      };
      const post = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(post.status, 202);
      assert.equal((await post.json()).run.id, runId());
      await runs.idle();
      for (const path of [
        `/api/runs/${runId()}`,
        `/api/runs/latest?source=amazon`,
        `/api/runs?source=amazon&limit=1`,
        `/api/books/amazon?q=query`,
        `/api/runs/${runId()}`,
      ])
        assert.equal((await fetch(`${base}${path}`)).status, 200);
      assert.equal(calls, 1);
      const replay = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(replay.status, 200);
      assert.equal(calls, 1);
    },
  );
});
test("HTTP rejects nonlocal origins/hosts, wrong media, oversized/malformed bodies and invalid filters before collection", async () => {
  let calls = 0;
  await withApi(
    {
      repository: memoryRuns(),
      collectionEnabled: true,
      collectors: {
        amazon: async () => {
          calls++;
          return [bookRecord()];
        },
      },
    },
    async (base) => {
      for (const headers of [
        { Origin: "https://evil.invalid" },
        { Origin: "null" },
      ])
        assert.equal(
          (await fetch(`${base}/api/health`, { headers })).status,
          403,
          JSON.stringify(headers),
        );
      const rebound = await new Promise((resolve, reject) => {
        const request = http.get(
          `${base}/api/health`,
          { headers: { Host: "rebinding.invalid" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.once("error", reject);
      });
      assert.equal(rebound, 403);
      assert.equal(
        (await fetch(`${base}/api/runs`, { method: "POST", body: "x" })).status,
        415,
      );
      assert.equal(
        (
          await fetch(`${base}/api/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{bad",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${base}/api/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ large: "x".repeat(17000) }),
          })
        ).status,
        413,
      );
      for (const suffix of [
        "?source=bad",
        "?limit=51",
        "?limit=1&limit=2",
        "?cursor=bad",
        "?unknown=x",
      ])
        assert.equal((await fetch(`${base}/api/runs${suffix}`)).status, 400);
      assert.equal(
        (await fetch(`${base}/api/runs/latest?source=amazon`)).status,
        200,
      );
      assert.equal((await fetch(`${base}/api/runs/${runId(99)}`)).status, 404);
      assert.equal((await fetch(`${base}/api/runs/no-id`)).status, 400);
      assert.equal(calls, 0);
    },
  );
});
test("Node transport observes external cancellation without retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const clients = createHtmlClients({
    apiKey: "FAKE",
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        calls++;
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("SECRET")),
          { once: true },
        );
      }),
  });
  const pending = clients.amazon("query", controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: "RUN_CANCELLED" });
  assert.equal(calls, 1);
});
