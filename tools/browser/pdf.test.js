import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bounded,
  BrowserPdfError,
  browserEndpoint,
  parseArgs,
  renderPdf,
  safeFailure,
  TARGETS,
  validPdf,
  verifiedDenyControl,
} from "./pdf.js";
import { consentAction, preservedPrint, PRINT_CSS } from "./page-contract.js";

test("CLI accepts only explicit fixed target, mode and PDF output", () => {
  assert.deepEqual(
    parseArgs([
      "--mode",
      "local",
      "--target",
      "tiobe",
      "--output",
      "artifacts/example.pdf",
    ]),
    { mode: "local", target: "tiobe", output: "artifacts/example.pdf" },
  );
  assert.equal(parseArgs(["--help"]), null);
  for (const args of [
    [],
    ["--mode", "local"],
    [
      "--mode",
      "remote",
      "--target",
      "https://example.com",
      "--output",
      "x.pdf",
    ],
    ["--mode", "remote", "--target", "tiobe", "--output", "x.html"],
    [
      "--mode",
      "local",
      "--mode",
      "remote",
      "--target",
      "tiobe",
      "--output",
      "x.pdf",
    ],
    [
      "--mode",
      "local",
      "--target",
      "tiobe",
      "--output",
      "x.pdf",
      "--apikey",
      "dummy",
    ],
  ]) {
    assert.throws(() => parseArgs(args), BrowserPdfError);
  }
});

test("remote endpoint uses fixed verified parameters without target credentials", () => {
  const endpoint = new URL(browserEndpoint("dummy-key-not-a-real-credential"));
  assert.equal(endpoint.origin, "wss://browser.zenrows.com");
  assert.equal(endpoint.searchParams.get("proxy_country"), "us");
  assert.equal(endpoint.searchParams.get("session_ttl"), "1m");
  assert.equal(
    endpoint.searchParams.get("apikey"),
    "dummy-key-not-a-real-credential",
  );
  assert.equal(endpoint.searchParams.size, 3);
  assert.throws(() => browserEndpoint(" dummy "), BrowserPdfError);
  assert.throws(() => browserEndpoint(""), BrowserPdfError);
});

test("safe failure never returns native message, stack or authenticated URL", () => {
  const native = new Error("wss://browser.zenrows.com?apikey=dummy-secret");
  assert.deepEqual(safeFailure(native, "connect"), {
    code: "operation_failed",
    stage: "connect",
  });
  native.name = "TimeoutError";
  assert.deepEqual(safeFailure(native, "navigation"), {
    code: "operation_timeout",
    stage: "navigation",
  });
  assert.deepEqual(
    safeFailure(new BrowserPdfError("consent_changed", "consent"), "pdf"),
    { code: "consent_changed", stage: "consent" },
  );
  assert.deepEqual(
    safeFailure(new BrowserPdfError("dummy-secret", "consent"), "pdf"),
    { code: "operation_failed", stage: "pdf" },
  );
});

test("consent never changes an existing optional-cookie response or treats unknowns as denial", () => {
  const state = {
    known: true,
    responded: false,
    denied: false,
    dialogs: 1,
    dialogVisible: true,
  };
  assert.equal(consentAction(state), "deny");
  assert.equal(consentAction({ ...state, known: false }), "stop");
  assert.equal(consentAction({ ...state, responded: true }), "stop");
  assert.equal(
    consentAction({
      ...state,
      denied: true,
      responded: true,
      dialogVisible: false,
    }),
    "ready",
  );
  assert.equal(
    consentAction({ ...state, denied: true, responded: true }),
    "stop",
  );
  assert.equal(consentAction({ ...state, dialogs: 2 }), "stop");
  assert.equal(
    consentAction({ ...state, dialogs: 0, dialogVisible: false }),
    "stop",
  );
});

test("print contract rejects content changes, hidden source, incomplete graphics and missing ranks", () => {
  const state = {
    sourceValid: true,
    rankingValid: true,
    names: Array.from({ length: 20 }, (_, index) => `Language ${index + 1}`),
    fingerprints: ["a", "b", "c", "d"],
    printActive: true,
    contentVisible: true,
    chromeHidden: true,
    imagesReady: true,
    decorationHidden: true,
    layoutReady: true,
    graphicFingerprints: ["image", "chart"],
    graphicVisibility: [true, true],
  };
  assert.equal(preservedPrint(state, { ...state }), true);
  for (const update of [
    { fingerprints: ["a", "b", "c", "changed"] },
    { names: [...state.names.slice(0, 19), "changed"] },
    { sourceValid: false },
    { rankingValid: false },
    { printActive: false },
    { contentVisible: false },
    { chromeHidden: false },
    { imagesReady: false },
    { decorationHidden: false },
    { layoutReady: false },
    { graphicFingerprints: ["image", "changed"] },
    { graphicVisibility: [true, false] },
  ]) {
    assert.equal(preservedPrint(state, { ...state, ...update }), false);
  }
  assert.equal(PRINT_CSS.includes("CybotCookiebotDialog"), false);
  assert.equal(PRINT_CSS.includes("display: none"), true);
});

test("PDF sanity rejects non-PDF and oversized data without certifying readability", () => {
  assert.equal(validPdf(Buffer.from("%PDF-1.7\ndummy")), true);
  assert.equal(validPdf(Buffer.from("not a PDF")), false);
  assert.equal(validPdf(Buffer.alloc(10_485_761)), false);
});

test("deadline wrapper completes success and rejects a stalled operation", async () => {
  assert.equal(await bounded(() => Promise.resolve(4), 1_000, "readiness"), 4);
  await assert.rejects(
    bounded(() => new Promise(() => {}), 5, "pdf"),
    (error) =>
      error instanceof BrowserPdfError &&
      error.code === "deadline" &&
      error.stage === "pdf",
  );
  let started = false;
  await assert.rejects(
    bounded(
      async () => {
        started = true;
      },
      0,
      "pdf",
    ),
    BrowserPdfError,
  );
  assert.equal(started, false);
});

test("stalled consent locator is bounded before any click", async () => {
  let evaluated = false;
  const stalled = {
    count: () => new Promise(() => {}),
    evaluate: async () => {
      evaluated = true;
    },
  };
  await assert.rejects(
    verifiedDenyControl(stalled, 5),
    (error) =>
      error instanceof BrowserPdfError &&
      error.code === "deadline" &&
      error.stage === "consent",
  );
  assert.equal(evaluated, false);
});

test("disabled TLS verification refuses remote allocation", async () => {
  const prior = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  let allocated = false;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    await assert.rejects(
      renderPdf(
        {
          mode: "remote",
          target: "tiobe",
          output: "unused.pdf",
          apiKey: "dummy",
        },
        {
          connectOverCDP: async () => {
            allocated = true;
          },
        },
      ),
      (error) =>
        error instanceof BrowserPdfError &&
        error.code === "unsafe_tls_configuration",
    );
    assert.equal(allocated, false);
  } finally {
    if (prior === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prior;
  }
});

test("navigation failure closes the browser once and never reaches PDF or output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wsp-pdf-contract-"));
  let closeCount = 0;
  const page = {
    setDefaultTimeout() {},
    goto: async () => ({ status: () => 403 }),
    url: () => TARGETS.tiobe,
  };
  const browser = {
    contexts: () => [{ pages: () => [page] }],
    close: async () => {
      closeCount += 1;
    },
  };
  const engine = { launch: async () => browser };
  try {
    await assert.rejects(
      renderPdf(
        {
          mode: "local",
          target: "tiobe",
          output: join(directory, "output.pdf"),
        },
        engine,
      ),
      (error) =>
        error instanceof BrowserPdfError &&
        error.code === "target_http_failure" &&
        error.stage === "navigation",
    );
    assert.equal(closeCount, 1);
  } finally {
    await rmdir(directory);
  }
});

test("remote missing configuration and existing output stop before allocating a browser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wsp-pdf-preflight-"));
  const output = join(directory, "output.pdf");
  let allocated = false;
  const engine = {
    launch: async () => {
      allocated = true;
    },
    connectOverCDP: async () => {
      allocated = true;
    },
  };
  try {
    await assert.rejects(
      renderPdf({ mode: "remote", target: "tiobe", output }, engine),
      (error) =>
        error instanceof BrowserPdfError &&
        error.code === "configuration_missing",
    );
    await writeFile(output, "reserved fixture, not a PDF");
    await assert.rejects(
      renderPdf({ mode: "local", target: "tiobe", output }, engine),
      (error) =>
        error instanceof BrowserPdfError && error.code === "output_exists",
    );
    assert.equal(allocated, false);
  } finally {
    await unlink(output);
    await rmdir(directory);
  }
});

test("failed cleanup is explicit and native diagnostics remain private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wsp-pdf-cleanup-"));
  const page = {
    setDefaultTimeout() {},
    goto: async () => {
      throw new Error("apikey=dummy-secret");
    },
  };
  const browser = {
    contexts: () => [{ pages: () => [page] }],
    close: async () => {
      throw new Error("wss://private.invalid?apikey=dummy-secret");
    },
  };
  try {
    await assert.rejects(
      renderPdf(
        {
          mode: "local",
          target: "tiobe",
          output: join(directory, "output.pdf"),
        },
        { launch: async () => browser },
      ),
      (error) => {
        assert.deepEqual(safeFailure(error, "preflight"), {
          code: "cleanup_unconfirmed",
          stage: "cleanup",
        });
        assert.equal(JSON.stringify(error).includes("dummy-secret"), false);
        return true;
      },
    );
  } finally {
    await rmdir(directory);
  }
});

test("a reopened consent dialog immediately before export prevents PDF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wsp-pdf-consent-race-"));
  let consentReads = 0;
  let pdfCalls = 0;
  let closed = 0;
  const printState = {
    sourceValid: true,
    rankingValid: true,
    names: Array.from({ length: 20 }, (_, i) => `Language ${i + 1}`),
    fingerprints: ["a", "b", "c", "d"],
    printActive: true,
    contentVisible: true,
    chromeHidden: true,
    imagesReady: true,
    decorationHidden: true,
    layoutReady: true,
    graphicFingerprints: ["image", "chart"],
    graphicVisibility: [true, true],
  };
  const page = {
    setDefaultTimeout() {},
    goto: async () => ({ status: () => 200 }),
    url: () => TARGETS.tiobe,
    waitForFunction: async () => {},
    emulateMedia: async () => {},
    addStyleTag: async () => {},
    evaluate: async (fn) => {
      if (fn.name === "printSnapshot") return printState;
      consentReads++;
      return {
        known: true,
        responded: true,
        denied: true,
        dialogs: 1,
        dialogVisible: consentReads >= 3,
      };
    },
    pdf: async () => {
      pdfCalls++;
      throw new Error("must not export");
    },
  };
  try {
    await assert.rejects(
      renderPdf(
        {
          mode: "local",
          target: "tiobe",
          output: join(directory, "unused.pdf"),
        },
        {
          launch: async () => ({
            contexts: () => [{ pages: () => [page] }],
            close: async () => {
              closed++;
            },
          }),
        },
      ),
      (error) =>
        error instanceof BrowserPdfError &&
        error.code === "consent_changed" &&
        error.stage === "pdf",
    );
    assert.equal(pdfCalls, 0);
    assert.equal(closed, 1);
  } finally {
    await rmdir(directory);
  }
});
