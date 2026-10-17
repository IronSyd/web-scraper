import test from "node:test";
import assert from "node:assert/strict";
import { parseAmazon, parseTiobe, amazonProductUrl } from "../parsers.js";
import { AppError } from "../errors.js";
import { createCollectionService, validateCacheData } from "../cache.js";
import { createApp, validateQuery } from "../app.js";
import { createHtmlClients, validateTiobeUrl } from "../transport.js";
import {
  amazonHtml,
  card,
  tiobeHtml,
  languageRecords,
  bookRecord,
  memoryRepository,
} from "./fixtures.js";
import { fakeCollectors, memoryRuns, runningRun } from "./run-fixtures.js";

test("TIOBE twenty ranked rows resolve public icon URLs", () => {
  const rows = parseTiobe(tiobeHtml());
  assert.equal(rows.length, 20);
  assert.deepEqual(rows[19], {
    ranking: 20,
    pLang: "Language 20",
    imagePath: "https://www.tiobe.com/images/20.png",
  });
});
for (const [name, transform] of [
  ["missing row", (html) => html.replace("<td>20</td>", "<td></td>")],
  ["wrong rank", (html) => html.replace("<td>20</td>", "<td>21</td>")],
  ["duplicate language", (html) => html.replace("Language 20", "Language 1")],
  [
    "foreign image",
    (html) => html.replace("/images/1.png", "https://evil.example/image.png"),
  ],
  ["missing required image", (html) => html.replace('src="/images/1.png"', "")],
])
  test(`TIOBE rejects ${name}`, () =>
    assert.throws(() => parseTiobe(transform(tiobeHtml())), {
      code: "UPSTREAM_INVALID_PAGE",
    }));

test("Amazon preserves membership conditions, author spans and labeled ratings", () => {
  const [book] = parseAmazon(amazonHtml(card()), "query");
  assert.deepEqual(book.authors, ["Alice Example", "Bob Example"]);
  assert.equal(
    book.price,
    "Kindle — $0.00 — Free with Kindle Unlimited membership — Or $3.99 to buy",
  );
  assert.equal(book.reviews, "1,234 ratings");
  assert.equal(book.url, "https://www.amazon.com/dp/B000000001");
});
test("Amazon same-ASIN duplicates prefer first organic without merging offers", () => {
  const rows = parseAmazon(
    amazonHtml(
      card({ sponsored: true, title: "Sponsored" }),
      card({ title: "Organic", price: "" }),
      card({ title: "Later" }),
    ),
    "query",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Organic");
  assert.equal(rows[0].price, null);
});
test("Amazon keeps absent authors and optional data absent", () => {
  const [book] = parseAmazon(
    amazonHtml(
      card({ byline: "", price: "" })
        .replace(/<span class="a-icon-alt">.*?<\/span>/u, "")
        .replace(/<a href="[^"]*#customerReviews".*?<\/a>/u, "")
        .replace(/<img.*?>/u, ""),
    ),
    "query",
  );
  assert.deepEqual(book.authors, []);
  assert.deepEqual(
    [book.price, book.rating, book.reviews, book.image],
    [null, null, null, null],
  );
});
test("Amazon sponsored wrapper must resolve the same ASIN", () => {
  assert.equal(
    amazonProductUrl(
      "/sspa/click?url=%2Fdp%2FB000000001%3Fref%3Dtest",
      "B000000001",
      "https://www.amazon.com/s",
    ),
    "https://www.amazon.com/dp/B000000001",
  );
  assert.throws(() =>
    amazonProductUrl(
      "/sspa/click?url=%2Fdp%2FB000000002",
      "B000000001",
      "https://www.amazon.com/s",
    ),
  );
});
for (const href of [
  "javascript:alert(1)",
  "https://evil.example/dp/B000000001",
  "https://user:pass@www.amazon.com/dp/B000000001",
  "/dp/B000000002",
]) {
  test(`Amazon rejects unsafe or mismatched product URL ${href.split(":")[0]}`, () =>
    assert.throws(() => parseAmazon(amazonHtml(card({ href })), "query")));
}
test("Unknown zero-result page fails closed", () =>
  assert.throws(() => parseAmazon(amazonHtml(), "query"), {
    code: "UPSTREAM_INVALID_PAGE",
  }));
test("HTTP-200 CAPTCHA structure is classified as blocking", () =>
  assert.throws(
    () =>
      parseAmazon(
        "<html><head><title>Robot Check</title></head><body></body></html>",
        "query",
      ),
    { code: "UPSTREAM_BLOCKED" },
  ));
test("Plain text is not accepted as target HTML", () =>
  assert.throws(() => parseTiobe("Hello"), { code: "UPSTREAM_INVALID_PAGE" }));

test("Cache miss then warm hit preserves public DTO and source", async () => {
  const repo = memoryRepository();
  const service = createCollectionService(repo);
  let calls = 0;
  const collect = async () => {
    calls++;
    return [{ ...bookRecord(), _id: "internal" }];
  };
  assert.deepEqual(await service.get("amazon:query", collect), {
    source: "collection",
    data: [bookRecord()],
  });
  assert.deepEqual(await service.get("amazon:query", collect), {
    source: "cache",
    data: [bookRecord()],
  });
  assert.equal(calls, 1);
});
test("Concurrent same-key misses coalesce one collection and one write", async () => {
  const repo = memoryRepository();
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let writes = 0;
  const service = createCollectionService({
    get: repo.get,
    set: async (key, data) => {
      writes++;
      await repo.set(key, data);
    },
  });
  const collect = async () => {
    calls++;
    await wait;
    return [bookRecord()];
  };
  const requests = Array.from({ length: 8 }, () =>
    service.get("amazon:query", collect),
  );
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all(requests);
  assert.equal(calls, 1);
  assert.equal(writes, 1);
  assert.ok(results.every((result) => result.source === "collection"));
});
test("Shared collection failure is not cached and later request can retry", async () => {
  const repo = memoryRepository();
  const service = createCollectionService(repo);
  let calls = 0;
  const collect = async () => {
    calls++;
    throw new AppError(502, "UPSTREAM_BLOCKED", "Blocked.");
  };
  const results = await Promise.allSettled([
    service.get("amazon:query", collect),
    service.get("amazon:query", collect),
  ]);
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(repo.entries.size, 0);
  await assert.rejects(service.get("amazon:query", collect));
  assert.equal(calls, 2);
});
test("Distinct keys collect independently", async () => {
  const service = createCollectionService(memoryRepository());
  const results = await Promise.all(
    ["One", "Two"].map((query) =>
      service.get(`amazon:${query}`, async () => [bookRecord(query)]),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.data[0].searchTerm),
    ["One", "Two"],
  );
});
test("Ambiguous save is reported; next request reads committed cache before recollecting", async () => {
  const repo = memoryRepository();
  let calls = 0;
  const service = createCollectionService({
    get: repo.get,
    set: async (key, data) => {
      await repo.set(key, data);
      throw new Error("Lost acknowledgement");
    },
  });
  const collect = async () => {
    calls++;
    return [bookRecord()];
  };
  await assert.rejects(service.get("amazon:query", collect), {
    code: "DATABASE_UNAVAILABLE",
  });
  assert.equal((await service.get("amazon:query", collect)).source, "cache");
  assert.equal(calls, 1);
});
test("Read failure blocks collection rather than bypassing cache", async () => {
  let calls = 0;
  const service = createCollectionService({
    get: async () => {
      throw new Error("Database secret");
    },
    set: async () => {},
  });
  await assert.rejects(
    service.get("amazon:query", async () => {
      calls++;
      return [];
    }),
    { code: "DATABASE_UNAVAILABLE" },
  );
  assert.equal(calls, 0);
});
test("Legitimate empty injected collection is returned without caching", async () => {
  const repo = memoryRepository();
  const service = createCollectionService(repo);
  assert.deepEqual(await service.get("amazon:query", async () => []), {
    source: "collection",
    data: [],
  });
  assert.equal(repo.entries.size, 0);
});
test("Invalid cached DTO and external image URLs are rejected", () => {
  assert.throws(() =>
    validateCacheData("amazon:query", [
      { ...bookRecord(), image: "javascript:bad" },
    ]),
  );
  assert.throws(() =>
    validateCacheData(
      "tiobe",
      languageRecords().map((row) => ({ ...row, pLang: "Duplicate" })),
    ),
  );
  assert.throws(() =>
    validateCacheData("amazon:query", [{ ...bookRecord(), price: "  " }]),
  );
});
for (const input of [
  undefined,
  ["one", "two"],
  { nested: "query" },
  "",
  "  ",
  "x".repeat(201),
]) {
  test("Query rejects absent, compound or out-of-bound values", () =>
    assert.throws(() => validateQuery(input), { status: 400 }));
}
test("Query trimming preserves case for exact cache identity", () =>
  assert.equal(validateQuery("  JavaScript  "), "JavaScript"));

test("Managed transport uses one GET with exact ZenRows request configuration", async () => {
  let calls = 0;
  const clients = createHtmlClients({
    apiKey: "FAKE_TEST_SECRET",
    fetchImpl: async (input, options) => {
      calls++;
      const endpoint = new URL(String(input));
      assert.equal(endpoint.origin, "https://api.zenrows.com");
      assert.equal(options.method, undefined);
      assert.equal(options.redirect, "error");
      assert.equal(endpoint.searchParams.get("apikey"), "FAKE_TEST_SECRET");
      assert.equal(endpoint.searchParams.get("js_render"), "true");
      const target = new URL(endpoint.searchParams.get("url"));
      assert.equal(target.searchParams.get("k"), "C++ & Java");
      return new Response(amazonHtml(card()), {
        headers: { "content-type": "text/plain" },
      });
    },
  });
  assert.match(await clients.amazon("C++ & Java"), /Synthetic Book/u);
  assert.equal(calls, 1);
});
for (const [status, expected] of [
  [401, 502],
  [402, 503],
  [403, 502],
  [429, 503],
  [503, 503],
  [504, 504],
]) {
  test(`Transport classifies HTTP ${status} without retry`, async () => {
    let calls = 0;
    const clients = createHtmlClients({
      apiKey: "FAKE_TEST_SECRET",
      fetchImpl: async () => {
        calls++;
        return new Response("error", {
          status,
          headers: { "content-type": "text/plain" },
        });
      },
    });
    await assert.rejects(clients.amazon("query"), { status: expected });
    assert.equal(calls, 1);
  });
}
for (const body of ["{bad", "{}", '{"xhr":[]}']) {
  test("Transport rejects malformed or missing-HTML JSON", async () => {
    const clients = createHtmlClients({
      fetchImpl: async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    });
    await assert.rejects(
      clients.publicTiobe("https://www.tiobe.com/tiobe-index/"),
      { code: "UPSTREAM_INVALID_RESPONSE" },
    );
  });
}
for (const [status, code, expectedStatus, expectedCode] of [
  [503, "CTX0002", 504, "UPSTREAM_TIMEOUT"],
  [502, "RESP009", 503, "PROVIDER_UNAVAILABLE"],
]) {
  test(`Provider code ${code} takes precedence over HTTP ${status}`, async () => {
    const clients = createHtmlClients({
      fetchImpl: async () =>
        new Response(JSON.stringify({ code }), {
          status,
          headers: { "content-type": "application/json" },
        }),
    });
    await assert.rejects(
      clients.publicTiobe("https://www.tiobe.com/tiobe-index/"),
      { status: expectedStatus, code: expectedCode },
    );
  });
}
test("Transport handles explicit JSON HTML and code-based errors", async () => {
  const clients = createHtmlClients({
    fetchImpl: async () =>
      new Response(JSON.stringify({ html: tiobeHtml() }), {
        headers: { "content-type": "application/json" },
      }),
  });
  assert.match(
    await clients.publicTiobe("https://www.tiobe.com/tiobe-index/"),
    /top20/u,
  );
  const errorClients = createHtmlClients({
    fetchImpl: async () =>
      new Response('{"code":"AUTH004"}', {
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(
    errorClients.publicTiobe("https://www.tiobe.com/tiobe-index/"),
    { status: 503 },
  );
});
test("Transport caps actual streamed bytes and rejects wrong media type", async () => {
  const tooLarge = createHtmlClients({
    maxBytes: 10,
    fetchImpl: async () =>
      new Response("x".repeat(11), {
        headers: { "content-type": "text/plain" },
      }),
  });
  await assert.rejects(
    tooLarge.publicTiobe("https://www.tiobe.com/tiobe-index/"),
    { code: "UPSTREAM_TOO_LARGE" },
  );
  const wrongMime = createHtmlClients({
    fetchImpl: async () =>
      new Response("bytes", { headers: { "content-type": "image/png" } }),
  });
  await assert.rejects(
    wrongMime.publicTiobe("https://www.tiobe.com/tiobe-index/"),
    { code: "UPSTREAM_INVALID_RESPONSE" },
  );
});
test("Transport cancels a declared oversized response before reading", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const clients = createHtmlClients({
    maxBytes: 10,
    fetchImpl: async () =>
      new Response(body, {
        headers: { "content-type": "text/plain", "content-length": "11" },
      }),
  });
  await assert.rejects(
    clients.publicTiobe("https://www.tiobe.com/tiobe-index/"),
    { code: "UPSTREAM_TOO_LARGE" },
  );
  assert.equal(cancelled, true);
});
test("Transport rejects absent key without a request and sanitizes network errors", async () => {
  let calls = 0;
  const clients = createHtmlClients({
    fetchImpl: async () => {
      calls++;
      throw new Error("FAKE_TEST_SECRET");
    },
  });
  await assert.rejects(async () => clients.amazon("query"), {
    code: "CONFIGURATION_REQUIRED",
  });
  assert.equal(calls, 0);
  await assert.rejects(
    clients.publicTiobe("https://www.tiobe.com/tiobe-index/"),
    (error) =>
      error.code === "UPSTREAM_NETWORK" &&
      !error.message.includes("FAKE_TEST_SECRET"),
  );
});
test("Transport deadline aborts without retry", async () => {
  const clients = createHtmlClients({
    timeoutMs: 10,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Fallback timeout")),
          1000,
        );
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("FAKE_TEST_SECRET"));
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(
    clients.publicTiobe("https://www.tiobe.com/tiobe-index/"),
    { status: 504 },
  );
});
test("Public target URL is fixed and validated before network access", () => {
  for (const url of [
    "http://www.tiobe.com/tiobe-index/",
    "https://evil.example/tiobe-index/",
    "https://www.tiobe.com/other/",
    "https://www.tiobe.com/tiobe-index/?x=1",
  ])
    assert.throws(() => validateTiobeUrl(url));
});

const runtimeFlagNames = [
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "DEBUG",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_OPTIONS",
];
async function withRuntimeFlags(overrides, check) {
  const saved = Object.fromEntries(
    runtimeFlagNames.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of runtimeFlagNames) delete process.env[name];
    for (const [name, value] of Object.entries(overrides))
      process.env[name] = value;
    await check();
  } finally {
    for (const name of runtimeFlagNames) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}
for (const [name, value] of [
  ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
  ["DEBUG", "*"],
  ["NODE_DEBUG", "http,https,net"],
  ["NODE_DEBUG_NATIVE", "HTTP"],
  ["NODE_OPTIONS", "--trace-tls"],
]) {
  test(`Unsafe runtime configuration ${name} stops before credential transport`, async () => {
    await withRuntimeFlags({ [name]: value }, async () => {
      let calls = 0;
      const clients = createHtmlClients({
        apiKey: "FAKE_TEST_SECRET",
        fetchImpl: async () => {
          calls++;
          return new Response("unused");
        },
      });
      await assert.rejects(
        clients.amazon("query"),
        (error) =>
          error.status === 503 &&
          error.code === "CONFIGURATION_REQUIRED" &&
          !error.message.includes("FAKE_TEST_SECRET") &&
          !error.message.includes("https://"),
      );
      assert.equal(calls, 0);
    });
  });
}
test("Verified TLS with no debug overrides allows normal credential transport", async () => {
  await withRuntimeFlags({ NODE_TLS_REJECT_UNAUTHORIZED: "1" }, async () => {
    let calls = 0;
    const clients = createHtmlClients({
      apiKey: "FAKE_TEST_SECRET",
      fetchImpl: async () => {
        calls++;
        return new Response(amazonHtml(card()), {
          headers: { "content-type": "text/plain" },
        });
      },
    });
    await clients.amazon("query");
    assert.equal(calls, 1);
  });
});

async function withApi(dependencies, check) {
  const server = createApp(dependencies).listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();
  try {
    await check(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
test("Compatibility HTTP GETs read saved data without collection and reject compound queries", async () => {
  let calls = 0;
  const stamp = "2026-10-16T12:00:01.000Z";
  const saved = {
    ...runningRun(),
    inputs: { query: "JavaScript" },
    status: "succeeded",
    completedAt: stamp,
    collectedAt: stamp,
    savedAt: stamp,
    resultCount: 1,
    data: [bookRecord("JavaScript")],
  };
  await withApi(
    {
      repository: memoryRuns([saved]),
      collectors: {
        tiobe: async () => {
          calls++;
          return languageRecords();
        },
        amazon: async () => {
          calls++;
          return [bookRecord("JavaScript")];
        },
      },
    },
    async (base) => {
      const first = await fetch(`${base}/api/books/amazon?q=%20JavaScript%20`);
      assert.equal(first.status, 200);
      assert.equal((await first.json()).source, "cache");
      assert.equal(
        (await (await fetch(`${base}/api/books/amazon?q=JavaScript`)).json())
          .source,
        "cache",
      );
      assert.equal(calls, 0);
      for (const suffix of ["", "?q=a&q=b", "?q[nested]=a"])
        assert.equal(
          (await fetch(`${base}/api/books/amazon${suffix}`)).status,
          400,
        );
      assert.equal((await fetch(`${base}/api/tiobe`)).status, 404);
      assert.equal((await fetch(`${base}/missing`)).status, 404);
    },
  );
});
test("HTTP errors have stable envelopes without raw upstream details", async () => {
  await withApi(
    {
      repository: {
        ...memoryRuns(),
        latest: async () => {
          throw new Error("FAKE_TEST_SECRET");
        },
      },
      collectors: fakeCollectors(),
    },
    async (base) => {
      const failure = await fetch(`${base}/api/tiobe`);
      assert.equal(failure.status, 503);
      assert.equal((await failure.text()).includes("FAKE_TEST_SECRET"), false);
      const timeout = await fetch(`${base}/api/books/amazon?q=query`);
      assert.equal(timeout.status, 503);
      assert.deepEqual(await timeout.json(), {
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "The local database is unavailable.",
        },
      });
    },
  );
});
