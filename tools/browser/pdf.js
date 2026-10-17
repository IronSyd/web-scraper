import { createHash } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  consentAction,
  consentSnapshot,
  preservedPrint,
  printSnapshot,
  PRINT_CSS,
  sannysoftReady,
  tiobeReady,
} from "./page-contract.js";

/** @typedef {'local'|'remote'} Mode */
/** @typedef {'tiobe'|'sannysoft'} Target */
/** @typedef {'preflight'|'connect'|'navigation'|'readiness'|'consent'|'print'|'pdf'|'write'|'cleanup'} Stage */
/** @typedef {{mode: Mode, target: Target, output: string, apiKey?: string}} Options */

export const TARGETS = Object.freeze({
  tiobe: "https://www.tiobe.com/tiobe-index/",
  sannysoft: "https://bot.sannysoft.com/",
});
export const LIMITS = Object.freeze({
  workMs: 55_000,
  connectMs: 15_000,
  navigationMs: 30_000,
  closeMs: 5_000,
  pdfMaxBytes: 10_485_760,
});
export const TIOBE_PDF_OPTIONS = Object.freeze({
  format: /** @type {const} */ ("A3"),
  landscape: true,
  printBackground: true,
  margin: Object.freeze({
    top: "10mm",
    right: "10mm",
    bottom: "10mm",
    left: "10mm",
  }),
});
const SAFE_CODES = new Set([
  "invalid_arguments",
  "configuration_missing",
  "deadline",
  "target_changed",
  "unsafe_debug_configuration",
  "unsafe_tls_configuration",
  "invalid_output",
  "output_exists",
  "unexpected_contexts",
  "unexpected_pages",
  "target_http_failure",
  "consent_unknown",
  "consent_control_unknown",
  "consent_changed",
  "print_source_unknown",
  "print_source_changed",
  "readiness_changed",
  "invalid_pdf",
  "output_write_failed",
  "cleanup_unconfirmed",
  "operation_timeout",
  "operation_failed",
]);
const STAGES = new Set([
  "preflight",
  "connect",
  "navigation",
  "readiness",
  "consent",
  "print",
  "pdf",
  "write",
  "cleanup",
]);

export class BrowserPdfError extends Error {
  /** @param {string} code @param {Stage} stage */
  constructor(code, stage) {
    super("PDF operation failed.");
    this.name = "BrowserPdfError";
    this.code = code;
    this.stage = stage;
  }
}

/** @param {unknown} error @param {Stage} stage */
export function safeFailure(error, stage) {
  if (
    error instanceof BrowserPdfError &&
    SAFE_CODES.has(error.code) &&
    STAGES.has(error.stage)
  )
    return { code: error.code, stage: error.stage };
  return {
    code:
      error instanceof Error && error.name === "TimeoutError"
        ? "operation_timeout"
        : "operation_failed",
    stage,
  };
}

/** @param {string} apiKey */
export function browserEndpoint(apiKey) {
  if (
    !apiKey ||
    apiKey !== apiKey.trim() ||
    /\s/u.test(apiKey) ||
    [...apiKey].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new BrowserPdfError("configuration_missing", "preflight");
  const endpoint = new URL("wss://browser.zenrows.com");
  endpoint.search = new URLSearchParams({
    apikey: apiKey,
    proxy_country: "us",
    session_ttl: "1m",
  }).toString();
  return endpoint.href;
}

/** @template T @param {() => Promise<T>} operation @param {number} timeoutMs @param {Stage} stage @returns {Promise<T>} */
export async function bounded(operation, timeoutMs, stage) {
  if (timeoutMs <= 0) throw new BrowserPdfError("deadline", stage);
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new BrowserPdfError("deadline", stage)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Buffer} buffer */
export function validPdf(buffer) {
  return (
    buffer.length > 5 &&
    buffer.length <= LIMITS.pdfMaxBytes &&
    buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  );
}

/** @param {import('playwright').Locator} control @param {number} timeoutMs */
export function verifiedDenyControl(control, timeoutMs) {
  return bounded(
    async () =>
      (await control.count()) === 1 &&
      (await control.isVisible()) &&
      (await control.isEnabled()) &&
      (await control.evaluate(
        (node) => node.id === "CybotCookiebotDialogBodyButtonDecline",
      )),
    timeoutMs,
    "consent",
  );
}

/** @param {import('playwright').Page} page @param {Target} target */
function assertTarget(page, target) {
  if (page.url() !== TARGETS[target])
    throw new BrowserPdfError("target_changed", "readiness");
}

/** @param {string[]} args @returns {Options|null} */
export function parseArgs(args) {
  if (args.length === 1 && args[0] === "--help") return null;
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !["--mode", "--target", "--output"].includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith("--")
    )
      throw new BrowserPdfError("invalid_arguments", "preflight");
    values.set(key, value);
  }
  const mode = values.get("--mode");
  const target = values.get("--target");
  const output = values.get("--output");
  if (
    (mode !== "local" && mode !== "remote") ||
    (target !== "tiobe" && target !== "sannysoft") ||
    !output ||
    extname(output).toLowerCase() !== ".pdf"
  )
    throw new BrowserPdfError("invalid_arguments", "preflight");
  return { mode, target, output };
}

/**
 * One allowlisted navigation and PDF, with unconditional bounded cleanup.
 * The returned artifact is structurally checked, not certified visually readable.
 * @param {Options} options
 * @param {import('playwright').BrowserType} [engine] Test seam; the CLI always uses Chromium.
 */
export async function renderPdf(options, engine = chromium) {
  const started = performance.now();
  /** @type {Stage} */
  let stage = "preflight";
  /** @type {import('playwright').Browser|null} */
  let browser = null;
  /** @type {BrowserPdfError|null} */
  let failure = null;
  let cleanupAcknowledged = false;
  let receipt = null;
  /** @param {number} maximum */
  const remaining = (maximum) => {
    const time = Math.min(
      maximum,
      LIMITS.workMs - (performance.now() - started),
    );
    if (time <= 0) throw new BrowserPdfError("deadline", stage);
    return time;
  };
  try {
    if (
      !Object.hasOwn(TARGETS, options.target) ||
      !["local", "remote"].includes(options.mode) ||
      extname(options.output).toLowerCase() !== ".pdf"
    )
      throw new BrowserPdfError("invalid_arguments", stage);
    if (
      [
        "DEBUG",
        "PWDEBUG",
        "NODE_DEBUG",
        "NODE_DEBUG_NATIVE",
        "NODE_OPTIONS",
      ].some((name) => process.env[name])
    )
      throw new BrowserPdfError("unsafe_debug_configuration", stage);
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
      throw new BrowserPdfError("unsafe_tls_configuration", stage);
    const output = resolve(options.output);
    const parent = await lstat(dirname(output));
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new BrowserPdfError("invalid_output", stage);
    try {
      await lstat(output);
      throw new BrowserPdfError("output_exists", stage);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    const endpoint =
      options.mode === "remote" ? browserEndpoint(options.apiKey ?? "") : null;
    stage = "connect";
    const connectMs = remaining(LIMITS.connectMs);
    browser = endpoint
      ? await engine.connectOverCDP(endpoint, { timeout: connectMs })
      : await engine.launch({ headless: true, timeout: connectMs });
    const contexts = browser.contexts();
    const connectedBrowser = browser;
    const context =
      options.mode === "local" && contexts.length === 0
        ? await bounded(
            () => connectedBrowser.newContext(),
            remaining(5_000),
            stage,
          )
        : contexts.length === 1
          ? contexts[0]
          : null;
    if (!context) throw new BrowserPdfError("unexpected_contexts", stage);
    const pages = context.pages();
    if (pages.length > 1) throw new BrowserPdfError("unexpected_pages", stage);
    const page =
      pages[0] ??
      (await bounded(() => context.newPage(), remaining(5_000), stage));
    page.setDefaultTimeout(10_000);
    stage = "navigation";
    const response = await page.goto(TARGETS[options.target], {
      waitUntil: "domcontentloaded",
      timeout: remaining(LIMITS.navigationMs),
    });
    assertTarget(page, options.target);
    if (response?.status() !== 200)
      throw new BrowserPdfError("target_http_failure", stage);
    stage = "readiness";
    await page.waitForFunction(
      options.target === "tiobe" ? tiobeReady : sannysoftReady,
      undefined,
      { timeout: remaining(10_000) },
    );
    assertTarget(page, options.target);
    /** @type {Awaited<ReturnType<typeof printSnapshot>>|null} */
    let printState = null;
    if (options.target === "tiobe") {
      stage = "consent";
      await page.waitForFunction(
        () => {
          const bot =
            /** @type {Window & {Cookiebot?: import('./page-contract.js').CookiebotState}} */ (
              globalThis.window
            ).Cookiebot;
          return Boolean(
            bot &&
            [
              bot.hasResponse,
              bot.declined,
              bot.consent?.necessary,
              bot.consent?.preferences,
              bot.consent?.statistics,
              bot.consent?.marketing,
            ].every((value) => typeof value === "boolean"),
          );
        },
        undefined,
        { timeout: remaining(10_000) },
      );
      const action = consentAction(
        await bounded(
          () => page.evaluate(consentSnapshot),
          remaining(5_000),
          stage,
        ),
      );
      if (action === "stop")
        throw new BrowserPdfError("consent_unknown", stage);
      if (action === "deny") {
        const control = page
          .locator("#CybotCookiebotDialog")
          .getByRole("button", { name: "Deny", exact: true });
        if (!(await verifiedDenyControl(control, remaining(5_000))))
          throw new BrowserPdfError("consent_control_unknown", stage);
        assertTarget(page, options.target);
        if (
          consentAction(
            await bounded(
              () => page.evaluate(consentSnapshot),
              remaining(5_000),
              stage,
            ),
          ) !== "deny"
        )
          throw new BrowserPdfError("consent_changed", stage);
        assertTarget(page, options.target);
        await control.click({ timeout: remaining(5_000) });
      }
      await page.waitForFunction(
        () => {
          const bot =
            /** @type {Window & {Cookiebot?: import('./page-contract.js').CookiebotState}} */ (
              globalThis.window
            ).Cookiebot;
          const dialog = globalThis.document.querySelector(
            "#CybotCookiebotDialog",
          );
          const hidden =
            !dialog ||
            globalThis.getComputedStyle(dialog).display === "none" ||
            globalThis.getComputedStyle(dialog).visibility === "hidden" ||
            dialog.getBoundingClientRect().width <= 0 ||
            dialog.getBoundingClientRect().height <= 0;
          return (
            bot?.hasResponse === true &&
            bot.declined === true &&
            bot.consent?.necessary === true &&
            bot.consent?.preferences === false &&
            bot.consent?.statistics === false &&
            bot.consent?.marketing === false &&
            hidden
          );
        },
        undefined,
        { timeout: remaining(5_000) },
      );
      assertTarget(page, options.target);
      stage = "print";
      await bounded(
        () => page.emulateMedia({ media: "print" }),
        remaining(5_000),
        stage,
      );
      printState = await bounded(
        () => page.evaluate(printSnapshot),
        remaining(5_000),
        stage,
      );
      if (!printState.sourceValid || !printState.rankingValid)
        throw new BrowserPdfError("print_source_unknown", stage);
      assertTarget(page, options.target);
      await bounded(
        () => page.addStyleTag({ content: PRINT_CSS }),
        remaining(5_000),
        stage,
      );
      const after = await bounded(
        () => page.evaluate(printSnapshot),
        remaining(5_000),
        stage,
      );
      if (!preservedPrint(printState, after))
        throw new BrowserPdfError("print_source_changed", stage);
      printState = after;
      if (
        consentAction(
          await bounded(
            () => page.evaluate(consentSnapshot),
            remaining(5_000),
            stage,
          ),
        ) !== "ready"
      )
        throw new BrowserPdfError("consent_changed", stage);
    } else {
      stage = "print";
      await bounded(
        () => page.emulateMedia({ media: "print" }),
        remaining(5_000),
        stage,
      );
      if (
        !(await bounded(
          () => page.evaluate(sannysoftReady),
          remaining(5_000),
          stage,
        ))
      )
        throw new BrowserPdfError("readiness_changed", stage);
    }
    assertTarget(page, options.target);
    stage = "pdf";
    if (
      printState &&
      !preservedPrint(
        printState,
        await bounded(
          () => page.evaluate(printSnapshot),
          remaining(5_000),
          stage,
        ),
      )
    )
      throw new BrowserPdfError("print_source_changed", stage);
    if (
      printState &&
      consentAction(
        await bounded(
          () => page.evaluate(consentSnapshot),
          remaining(5_000),
          stage,
        ),
      ) !== "ready"
    )
      throw new BrowserPdfError("consent_changed", stage);
    assertTarget(page, options.target);
    const buffer = await bounded(
      () =>
        page.pdf(
          options.target === "tiobe"
            ? TIOBE_PDF_OPTIONS
            : { format: "A3", landscape: true, printBackground: true },
        ),
      remaining(10_000),
      stage,
    );
    assertTarget(page, options.target);
    if (!validPdf(buffer)) throw new BrowserPdfError("invalid_pdf", stage);
    stage = "write";
    remaining(1);
    const handle = await open(output, "wx", 0o600);
    try {
      await handle.writeFile(buffer);
    } catch {
      await handle.close();
      await unlink(output);
      throw new BrowserPdfError("output_write_failed", stage);
    }
    await handle.close();
    receipt = {
      mode: options.mode,
      target: options.target,
      bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      languageNames: printState?.names ?? [],
      readable: "not_verified",
    };
  } catch (error) {
    const safe = safeFailure(error, stage);
    failure = new BrowserPdfError(safe.code, safe.stage);
  } finally {
    if (browser) {
      try {
        const closingBrowser = browser;
        await bounded(() => closingBrowser.close(), LIMITS.closeMs, "cleanup");
        cleanupAcknowledged = true;
      } catch {
        failure = new BrowserPdfError("cleanup_unconfirmed", "cleanup");
      }
    }
  }
  if (failure) throw failure;
  if (!receipt) throw new BrowserPdfError("operation_failed", stage);
  return {
    ...receipt,
    cleanupAcknowledged,
    providerTermination:
      options.mode === "remote"
        ? "not_independently_verified"
        : "not_applicable",
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options)
      console.log(
        "Usage: node tools/browser/pdf.js --mode local|remote --target tiobe|sannysoft --output path.pdf",
      );
    else
      console.log(
        JSON.stringify(
          await renderPdf({
            ...options,
            apiKey:
              options.mode === "remote"
                ? process.env.ZENROWS_API_KEY
                : undefined,
          }),
        ),
      );
  } catch (error) {
    console.error(JSON.stringify({ error: safeFailure(error, "preflight") }));
    process.exitCode = 1;
  }
}
