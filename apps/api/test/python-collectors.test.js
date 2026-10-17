import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createPythonCollectors } from "../python-collectors.js";
import { AppError } from "../errors.js";

const KEY = "DUMMY_LOCAL_COLLECTOR_KEY";
const root = process.cwd();
const jobInputs = { query: "software developer", location: "New York, NY" };
const travel = {
  destination: "New York",
  checkin: "2026-11-16",
  checkout: "2026-11-17",
  adults: 2,
  rooms: 1,
};
const job = {
  jobId: "12345678abcdef00",
  title: "Engineer",
  company: "Example",
  location: "New York",
  url: "https://www.indeed.com/viewjob?jk=12345678abcdef00",
};
const hotel = {
  name: "Example Hotel",
  url: "https://www.booking.com/hotel/us/example.html?checkin=2026-11-16&checkout=2026-11-17&group_adults=2&no_rooms=1",
  price: "$247",
  currency: "USD",
  rating: "7.1",
  reviewCount: 2223,
  location: "Manhattan",
};

const overrides = [
  "DEBUG",
  "PWDEBUG",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "PYTHONINSPECT",
  "PYTHONVERBOSE",
  "WSP_PYTHON_EXE",
];
let savedEnvironment;
beforeEach(() => {
  savedEnvironment = new Map(
    overrides.map((name) => [name, process.env[name]]),
  );
  for (const name of overrides) delete process.env[name];
});
afterEach(() => {
  for (const [name, value] of savedEnvironment)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 12345;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
  }
  close(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function envelope(
  source = "indeed",
  records = source === "indeed" ? [job] : [hotel],
) {
  return {
    ok: true,
    target: source,
    mode: "managed",
    status: 200,
    count: records.length,
    records,
  };
}

function harness({
  output,
  exitCode = 0,
  kill,
  onSpawn,
  options = {},
  stderr,
} = {}) {
  const child = new FakeProcess();
  const calls = [];
  const kills = [];
  const collectors = createPythonCollectors({
    apiKey: KEY,
    ...options,
    spawnImpl: (file, args, spawnOptions) => {
      calls.push({ file, args, options: spawnOptions });
      queueMicrotask(() => {
        if (onSpawn) onSpawn(child);
        else if (output !== undefined) {
          if (stderr) child.stderr.write(stderr);
          child.stdout.write(
            typeof output === "string" ? output : JSON.stringify(output),
          );
          child.close(exitCode);
        }
      });
      return child;
    },
    killTree: async (pid, process) => {
      assert.equal(process, child);
      kills.push(pid);
      if (kill) await kill(child);
      else child.close(null, "SIGKILL");
    },
  });
  return { child, calls, kills, collectors };
}

function errorCode(code) {
  return (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(KEY));
    assert.ok(!error.message.includes("SECRET_NATIVE_DIAGNOSTIC"));
    return true;
  };
}

test("Indeed uses one fixed managed Python invocation and an environment-only key", async () => {
  const fixture = harness({ output: envelope() });
  const result = await fixture.collectors.indeed(
    { query: " software developer ", location: " New York, NY " },
    new AbortController().signal,
  );
  assert.deepEqual(result, [job]);
  assert.equal(fixture.calls.length, 1);
  const call = fixture.calls[0];
  assert.equal(call.file, resolve(root, ".venv/Scripts/python.exe"));
  assert.deepEqual(call.args, [
    resolve(root, "collectors/python/collect.py"),
    "indeed",
    "--mode",
    "managed",
    "--query",
    "software developer",
    "--location",
    "New York, NY",
  ]);
  assert.equal(call.options.cwd, root);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.stdio, "pipe");
  assert.equal(call.options.env.ZENROWS_API_KEY, KEY);
  assert.equal(
    call.options.env.PLAYWRIGHT_BROWSERS_PATH,
    resolve(root, ".cache/ms-playwright"),
  );
  assert.ok(!call.args.join(" ").includes(KEY));
  assert.equal(fixture.child.stdin.writableEnded, true);
  assert.equal(fixture.kills.length, 0);
});

test("Booking passes all validated travel fields without defaults or a shell", async () => {
  const fixture = harness({ output: { ...envelope("booking"), status: 202 } });
  assert.deepEqual(
    await fixture.collectors.booking(travel, new AbortController().signal),
    [hotel],
  );
  assert.deepEqual(fixture.calls[0].args.slice(1), [
    "booking",
    "--mode",
    "managed",
    "--destination",
    "New York",
    "--checkin",
    "2026-11-16",
    "--checkout",
    "2026-11-17",
    "--adults",
    "2",
    "--rooms",
    "1",
  ]);
});

test("Input punctuation stays a single argv value and never becomes executable code", async () => {
  const query = "C++ & Python; $(touch marker) `echo marker`";
  const fixture = harness({ output: envelope() });
  await fixture.collectors.indeed(
    { query, location: "New York" },
    new AbortController().signal,
  );
  assert.equal(fixture.calls[0].args[5], query);
  assert.equal(fixture.calls[0].options.shell, false);
});

for (const inputs of [
  { query: "", location: "NY" },
  { query: "x", location: " " },
  { query: "bad\nquery", location: "NY" },
  { query: "x", location: "NY", url: "https://evil.example" },
])
  test(`Invalid Indeed inputs fail before spawning: ${JSON.stringify(inputs)}`, async () => {
    const fixture = harness();
    await assert.rejects(
      fixture.collectors.indeed(inputs, new AbortController().signal),
      (error) => error instanceof AppError && error.status === 400,
    );
    assert.equal(fixture.calls.length, 0);
  });

for (const inputs of [
  { ...travel, checkin: "2026-02-30" },
  { ...travel, checkout: travel.checkin },
  { ...travel, adults: 1.5 },
  { ...travel, rooms: 0 },
  { ...travel, destination: " " },
])
  test(`Invalid Booking inputs fail before spawning: ${JSON.stringify(inputs)}`, async () => {
    const fixture = harness();
    await assert.rejects(
      fixture.collectors.booking(inputs, new AbortController().signal),
      (error) => error instanceof AppError && error.status === 400,
    );
    assert.equal(fixture.calls.length, 0);
  });

test("Missing credentials, unsafe executable and missing signal refuse allocation", async () => {
  for (const options of [
    { apiKey: " " },
    { apiKey: "bad\nkey" },
    { pythonExecutable: "python.exe" },
  ]) {
    const fixture = harness({ options });
    await assert.rejects(
      fixture.collectors.indeed(jobInputs, new AbortController().signal),
      errorCode("CONFIGURATION_REQUIRED"),
    );
    assert.equal(fixture.calls.length, 0);
  }
  const fixture = harness();
  await assert.rejects(
    fixture.collectors.indeed(jobInputs, undefined),
    errorCode("CONFIGURATION_REQUIRED"),
  );
  assert.equal(fixture.calls.length, 0);
});

test("Server-only executable override remains a fixed executable with separate argv", async () => {
  const executable = resolve(root, "test runtime/python.exe");
  process.env.WSP_PYTHON_EXE = executable;
  const fixture = harness({ output: envelope() });
  await fixture.collectors.indeed(jobInputs, new AbortController().signal);
  assert.equal(fixture.calls[0].file, executable);
  assert.equal(fixture.calls[0].options.shell, false);
});

for (const name of overrides.filter((name) => name !== "WSP_PYTHON_EXE"))
  test(`Unsafe runtime ${name} refuses allocation`, async () => {
    process.env[name] =
      name === "NODE_TLS_REJECT_UNAUTHORIZED"
        ? "0"
        : "SECRET_NATIVE_DIAGNOSTIC";
    const fixture = harness();
    await assert.rejects(
      fixture.collectors.indeed(jobInputs, new AbortController().signal),
      errorCode("CONFIGURATION_REQUIRED"),
    );
    assert.equal(fixture.calls.length, 0);
  });

test("Only OS essentials and explicit collector settings enter the child environment", async () => {
  const fixture = harness({ output: envelope() });
  await fixture.collectors.indeed(jobInputs, new AbortController().signal);
  const environment = fixture.calls[0].options.env;
  assert.equal(environment.MONGO_URI, undefined);
  assert.equal(environment.WSP_COLLECTION_ENABLED, undefined);
  assert.equal(environment.PYTHONHOME, undefined);
  assert.equal(environment.PYTHONPATH, undefined);
  assert.equal(environment.PYTHONNOUSERSITE, "1");
});

test("Optional Booking values stay null and no currency or price is invented", async () => {
  const sparse = {
    ...hotel,
    price: null,
    currency: null,
    rating: null,
    reviewCount: null,
    location: null,
  };
  const fixture = harness({ output: envelope("booking", [sparse]) });
  assert.deepEqual(
    await fixture.collectors.booking(travel, new AbortController().signal),
    [sparse],
  );
});

test("Qualified Booking stay-price text and explicit currency survive cleaning", async () => {
  const qualified = {
    ...hotel,
    price: " $247 total — excludes local taxes ",
    location: " Midtown   Manhattan ",
  };
  const fixture = harness({ output: envelope("booking", [qualified]) });
  const result = await fixture.collectors.booking(
    travel,
    new AbortController().signal,
  );
  assert.equal(result[0].price, "$247 total — excludes local taxes");
  assert.equal(result[0].location, "Midtown Manhattan");
});

test("Split stdout chunks and discarded private stderr do not affect a valid result", async () => {
  const fixture = harness({
    onSpawn: (child) => {
      const output = JSON.stringify(envelope());
      child.stderr.write(`SECRET_NATIVE_DIAGNOSTIC ${KEY}`);
      child.stdout.write(output.slice(0, 20));
      child.stdout.write(output.slice(20) + "\n");
      child.close();
    },
  });
  assert.deepEqual(
    await fixture.collectors.indeed(jobInputs, new AbortController().signal),
    [job],
  );
});

test("Duplicate Indeed identities retain the last complete source record", async () => {
  const replacement = { ...job, title: "Senior Engineer" };
  const fixture = harness({ output: envelope("indeed", [job, replacement]) });
  assert.deepEqual(
    await fixture.collectors.indeed(jobInputs, new AbortController().signal),
    [replacement],
  );
});

test("Duplicate Booking properties retain the last complete stay offer without merging", async () => {
  const replacement = {
    ...hotel,
    price: "$265",
    currency: null,
    location: null,
  };
  const fixture = harness({
    output: envelope("booking", [hotel, replacement]),
  });
  assert.deepEqual(
    await fixture.collectors.booking(travel, new AbortController().signal),
    [replacement],
  );
});

test("JSON-escaped credentials are rejected after decoding as well as literal credentials", async () => {
  const output = JSON.stringify(
    envelope("indeed", [{ ...job, company: KEY }]),
  ).replace(KEY, "\\u0044" + KEY.slice(1));
  assert.ok(!output.includes(KEY));
  const fixture = harness({ output });
  await assert.rejects(
    fixture.collectors.indeed(jobInputs, new AbortController().signal),
    errorCode("COLLECTOR_INVALID_RESPONSE"),
  );
});

for (const [label, output, exitCode] of [
  ["malformed JSON", "not JSON", 0],
  ["two envelopes", JSON.stringify(envelope()) + JSON.stringify(envelope()), 0],
  ["wrong target", { ...envelope(), target: "booking" }, 0],
  ["wrong mode", { ...envelope(), mode: "standard" }, 0],
  ["wrong count", { ...envelope(), count: 2 }, 0],
  ["missing count", { ...envelope(), count: undefined }, 0],
  ["fractional count", { ...envelope(), count: 1.5 }, 0],
  ["success with error exit", envelope(), 1],
  ["unknown success key", { ...envelope(), diagnostics: "private" }, 0],
  ["empty data", envelope("indeed", []), 0],
  ["unrecognized status", { ...envelope(), status: 202 }, 0],
  ["nonobject envelope", [envelope()], 0],
  ["error with success exit", { ok: false, error: { code: "blocked" } }, 0],
  [
    "unknown error code",
    { ok: false, error: { code: "SECRET_NATIVE_DIAGNOSTIC" } },
    1,
  ],
])
  test(`Invalid collector output fails safely: ${label}`, async () => {
    const fixture = harness({ output, exitCode });
    await assert.rejects(
      fixture.collectors.indeed(jobInputs, new AbortController().signal),
      errorCode("COLLECTOR_INVALID_RESPONSE"),
    );
    assert.equal(fixture.calls.length, 1);
  });

for (const records of [
  [{ ...job, url: "https://evil.example/viewjob?jk=12345678abcdef00" }],
  [{ ...job, url: "https://www.indeed.com/viewjob?jk=otheridentity" }],
  [{ ...job, company: "" }],
  [{ ...job, jobId: "short" }],
])
  test("Unsafe or incomplete Indeed records cannot cross the adapter", async () => {
    const fixture = harness({ output: envelope("indeed", records) });
    await assert.rejects(
      fixture.collectors.indeed(jobInputs, new AbortController().signal),
      errorCode("COLLECTOR_INVALID_RESPONSE"),
    );
  });

for (const record of [
  {
    ...hotel,
    url: hotel.url.replace("checkout=2026-11-17", "checkout=2026-11-18"),
  },
  { ...hotel, url: "https://evil.example/hotel/us/example.html" },
  { ...hotel, reviewCount: -1 },
  { ...hotel, reviewCount: 1.5 },
  { ...hotel, name: "" },
])
  test("Unsafe, mismatched or incomplete Booking records cannot cross the adapter", async () => {
    const fixture = harness({ output: envelope("booking", [record]) });
    await assert.rejects(
      fixture.collectors.booking(travel, new AbortController().signal),
      errorCode("COLLECTOR_INVALID_RESPONSE"),
    );
  });

test("A configured key anywhere in parsed stdout is rejected before exposing records", async () => {
  for (const output of [
    envelope("indeed", [{ ...job, company: KEY }]),
    { ok: false, error: { code: "blocked", message: `private ${KEY}` } },
    { ...envelope(), [KEY]: "hidden" },
  ]) {
    const fixture = harness({ output, exitCode: output.ok ? 0 : 1 });
    await assert.rejects(
      fixture.collectors.indeed(jobInputs, new AbortController().signal),
      errorCode("COLLECTOR_INVALID_RESPONSE"),
    );
  }
});

for (const [code, expected] of [
  ["invalid_input", "INVALID_INPUT"],
  ["missing_configuration", "CONFIGURATION_REQUIRED"],
  ["unsafe_environment", "CONFIGURATION_REQUIRED"],
  ["provider_access", "PROVIDER_UNAVAILABLE"],
  ["provider_capacity", "PROVIDER_UNAVAILABLE"],
  ["timeout", "UPSTREAM_TIMEOUT"],
  ["provider_timeout", "UPSTREAM_TIMEOUT"],
  ["blocked", "UPSTREAM_BLOCKED"],
  ["response_too_large", "UPSTREAM_TOO_LARGE"],
  ["cleanup_failed", "COLLECTOR_CLEANUP_FAILED"],
  ["schema_drift", "UPSTREAM_INVALID_PAGE"],
  ["invalid_result", "UPSTREAM_INVALID_PAGE"],
  ["input_mismatch", "UPSTREAM_INVALID_PAGE"],
  ["unexpected_url", "UPSTREAM_INVALID_PAGE"],
  ["unrecognized_page", "UPSTREAM_INVALID_PAGE"],
  ["transport_failure", "COLLECTOR_FAILURE"],
  ["worker_failure", "COLLECTOR_FAILURE"],
  ["browser_failure", "COLLECTOR_FAILURE"],
  ["browser_state", "COLLECTOR_FAILURE"],
  ["browser_navigation", "COLLECTOR_FAILURE"],
  ["upstream_http", "COLLECTOR_FAILURE"],
  ["internal_error", "COLLECTOR_FAILURE"],
])
  test(`Known Python failure ${code} maps to a fixed public code`, async () => {
    const fixture = harness({
      output: {
        ok: false,
        error: { code, message: "SECRET_NATIVE_DIAGNOSTIC", status: 500 },
      },
      exitCode: 1,
    });
    await assert.rejects(
      fixture.collectors.indeed(jobInputs, new AbortController().signal),
      errorCode(expected),
    );
    assert.equal(fixture.calls.length, 1);
  });

test("Native spawn exceptions do not escape or trigger retries", async () => {
  let calls = 0;
  const collectors = createPythonCollectors({
    apiKey: KEY,
    spawnImpl: () => {
      calls++;
      throw new Error("SECRET_NATIVE_DIAGNOSTIC");
    },
  });
  await assert.rejects(
    collectors.indeed(jobInputs, new AbortController().signal),
    errorCode("CONFIGURATION_REQUIRED"),
  );
  assert.equal(calls, 1);
});

test("Missing executable OS errors remain safe without trying to kill an absent process", async () => {
  const fixture = harness({
    onSpawn: (child) => {
      child.pid = undefined;
      child.emit(
        "error",
        Object.assign(new Error("SECRET_NATIVE_DIAGNOSTIC"), {
          code: "ENOENT",
        }),
      );
      child.close(null);
    },
  });
  await assert.rejects(
    fixture.collectors.indeed(jobInputs, new AbortController().signal),
    errorCode("CONFIGURATION_REQUIRED"),
  );
  assert.equal(fixture.kills.length, 0);
});

test("Pre-aborted work allocates no process", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = harness();
  await assert.rejects(
    fixture.collectors.indeed(jobInputs, controller.signal),
    errorCode("RUN_CANCELLED"),
  );
  assert.equal(fixture.calls.length, 0);
});

test("Abort kills and reaps exactly its owned process tree without a retry", async () => {
  const controller = new AbortController();
  const fixture = harness();
  const operation = fixture.collectors.indeed(jobInputs, controller.signal);
  controller.abort();
  await assert.rejects(operation, errorCode("RUN_CANCELLED"));
  assert.deepEqual(fixture.kills, [12345]);
  assert.equal(fixture.calls.length, 1);
});

for (const [source, inputs, milliseconds] of [
  ["indeed", jobInputs, 205000],
  ["booking", travel, 65000],
])
  test(`${source} deadline kills the owned process at its specified outer bound`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = harness();
    const operation = fixture.collectors[source](
      inputs,
      new AbortController().signal,
    );
    context.mock.timers.tick(milliseconds - 1);
    assert.equal(fixture.kills.length, 0);
    context.mock.timers.tick(1);
    await assert.rejects(operation, errorCode("UPSTREAM_TIMEOUT"));
    assert.deepEqual(fixture.kills, [12345]);
    assert.equal(fixture.calls.length, 1);
  });

for (const [stream, bytes, code] of [
  ["stdout", 20_000_001, "UPSTREAM_TOO_LARGE"],
  ["stderr", 65_537, "COLLECTOR_DIAGNOSTICS_LIMIT"],
])
  test(`${stream} overflow stops the tree once and discards its contents`, async () => {
    const fixture = harness({
      onSpawn: (child) => child[stream].write(Buffer.alloc(bytes, 65)),
    });
    await assert.rejects(
      fixture.collectors.indeed(jobInputs, new AbortController().signal),
      errorCode(code),
    );
    assert.deepEqual(fixture.kills, [12345]);
    assert.equal(fixture.calls.length, 1);
  });

test("Cleanup rejection reports uncertainty instead of the original cancellation", async () => {
  const controller = new AbortController();
  const fixture = harness({
    kill: async () => {
      throw new Error("SECRET_NATIVE_DIAGNOSTIC");
    },
  });
  const operation = fixture.collectors.indeed(jobInputs, controller.signal);
  controller.abort();
  await assert.rejects(operation, errorCode("COLLECTOR_CLEANUP_FAILED"));
  assert.deepEqual(fixture.kills, [12345]);
});

for (const kill of [async () => new Promise(() => {}), async () => {}])
  test("A stalled kill or missing reap ends after five seconds with cleanup unconfirmed", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = harness({ kill });
    const controller = new AbortController();
    const operation = fixture.collectors.indeed(jobInputs, controller.signal);
    controller.abort();
    context.mock.timers.tick(5000);
    await assert.rejects(operation, errorCode("COLLECTOR_CLEANUP_FAILED"));
    assert.deepEqual(fixture.kills, [12345]);
  });

test("Native child errors after allocation trigger owned cleanup and stay redacted", async () => {
  const fixture = harness({
    onSpawn: (child) =>
      child.emit("error", new Error("SECRET_NATIVE_DIAGNOSTIC")),
  });
  await assert.rejects(
    fixture.collectors.indeed(jobInputs, new AbortController().signal),
    errorCode("COLLECTOR_FAILURE"),
  );
  assert.deepEqual(fixture.kills, [12345]);
});

for (const stream of ["stdin", "stdout", "stderr"])
  test(`${stream} pipe errors trigger safe cleanup instead of an unhandled exception`, async () => {
    const fixture = harness({
      onSpawn: (child) =>
        child[stream].emit("error", new Error("SECRET_NATIVE_DIAGNOSTIC")),
    });
    await assert.rejects(
      fixture.collectors.indeed(jobInputs, new AbortController().signal),
      errorCode("COLLECTOR_FAILURE"),
    );
    assert.deepEqual(fixture.kills, [12345]);
  });

test("Abort after a completed valid result cannot kill a later process", async () => {
  const controller = new AbortController();
  const fixture = harness({ output: envelope() });
  await fixture.collectors.indeed(jobInputs, controller.signal);
  controller.abort();
  assert.deepEqual(fixture.kills, []);
});

test("An abort racing with spawn is observed after listeners are installed", async () => {
  const controller = new AbortController();
  const child = new FakeProcess();
  const kills = [];
  const collectors = createPythonCollectors({
    apiKey: KEY,
    spawnImpl: () => {
      controller.abort();
      return child;
    },
    killTree: async (pid) => {
      kills.push(pid);
      child.close(null, "SIGKILL");
    },
  });
  await assert.rejects(
    collectors.indeed(jobInputs, controller.signal),
    errorCode("RUN_CANCELLED"),
  );
  assert.deepEqual(kills, [12345]);
});
