import { spawn, execFile } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";
import { cleanRecords, normalizeInputs } from "./run-contract.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = resolve(ROOT, "collectors/python/collect.py");
const MAX_STDOUT = 20_000_000;
const MAX_STDERR = 65_536;
const CLEANUP_MS = 5000;

/**
 * @typedef {import('node:child_process').ChildProcessWithoutNullStreams} CollectorProcess
 * @typedef {(file:string,args:string[],options:import('node:child_process').SpawnOptionsWithoutStdio)=>CollectorProcess} SpawnCollector
 * @typedef {(pid:number,child:CollectorProcess)=>Promise<void>} KillTree
 * @typedef {'indeed'|'booking'} PythonSource
 */

const cancelled = () =>
  new AppError(
    503,
    "RUN_CANCELLED",
    "The collection was cancelled during shutdown.",
  );
const invalidOutput = () =>
  new AppError(
    502,
    "COLLECTOR_INVALID_RESPONSE",
    "The collector returned an invalid result.",
  );
const cleanupFailed = () =>
  new AppError(
    502,
    "COLLECTOR_CLEANUP_FAILED",
    "Collection stopped, but local process cleanup could not be confirmed.",
  );
const configurationRequired = () =>
  new AppError(
    503,
    "CONFIGURATION_REQUIRED",
    "The local collector configuration is unavailable.",
  );

/** Never forward the Python message, diagnostics or exception to a client.
 * @param {unknown} code
 */
function collectorFailure(code) {
  if (code === "invalid_input")
    return new AppError(
      400,
      "INVALID_INPUT",
      "The collection inputs are invalid.",
    );
  if (code === "missing_configuration" || code === "unsafe_environment")
    return configurationRequired();
  if (code === "provider_access" || code === "provider_capacity")
    return new AppError(
      503,
      "PROVIDER_UNAVAILABLE",
      "The scraping provider allowance or capacity is unavailable.",
    );
  if (code === "timeout" || code === "provider_timeout")
    return new AppError(
      504,
      "UPSTREAM_TIMEOUT",
      "The collection exceeded its deadline.",
    );
  if (code === "blocked")
    return new AppError(
      502,
      "UPSTREAM_BLOCKED",
      "The upstream site returned a challenge or denial.",
    );
  if (code === "response_too_large")
    return new AppError(
      502,
      "UPSTREAM_TOO_LARGE",
      "The collector response exceeded the size limit.",
    );
  if (code === "cleanup_failed") return cleanupFailed();
  if (
    [
      "schema_drift",
      "invalid_result",
      "input_mismatch",
      "unexpected_url",
      "unrecognized_page",
    ].includes(/** @type {string} */ (code))
  )
    return new AppError(
      502,
      "UPSTREAM_INVALID_PAGE",
      "The upstream page did not contain valid expected results.",
    );
  if (
    [
      "upstream_http",
      "transport_failure",
      "browser_state",
      "browser_navigation",
      "browser_failure",
      "worker_failure",
      "internal_error",
    ].includes(/** @type {string} */ (code))
  )
    return new AppError(
      502,
      "COLLECTOR_FAILURE",
      "The collector could not complete the request.",
    );
  return invalidOutput();
}

/** @param {Promise<void>} operation @param {number} milliseconds */
function bounded(operation, milliseconds) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(cleanupFailed()), milliseconds);
    operation.then(
      () => {
        clearTimeout(timer);
        resolvePromise(undefined);
      },
      () => {
        clearTimeout(timer);
        reject(cleanupFailed());
      },
    );
  });
}

/** Kill only the child tree allocated by this invocation; never invoke a shell.
 * @type {KillTree}
 */
async function killOwnedTree(pid, child) {
  if (process.platform === "win32") {
    const systemRoot = process.env["SystemRoot"] ?? process.env["SYSTEMROOT"];
    if (!systemRoot || !isAbsolute(systemRoot)) throw cleanupFailed();
    await new Promise((resolvePromise, reject) => {
      execFile(
        resolve(systemRoot, "System32/taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 2500, maxBuffer: 1024 },
        (error) =>
          error ? reject(cleanupFailed()) : resolvePromise(undefined),
      );
    });
    return;
  }
  // POSIX children use their own process group so the Python worker is included.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    if (child.exitCode === null && child.signalCode === null)
      throw cleanupFailed();
  }
}

/** @param {string} key */
function childEnvironment(key) {
  if (
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0" ||
    [
      "DEBUG",
      "PWDEBUG",
      "NODE_DEBUG",
      "NODE_DEBUG_NATIVE",
      "NODE_OPTIONS",
      "PYTHONINSPECT",
      "PYTHONVERBOSE",
    ].some((name) => process.env[name]?.trim())
  )
    throw configurationRequired();
  // Preserve OS/runtime essentials only; do not forward database settings,
  // inherited Python import overrides or unrelated application credentials.
  const allowed = new Set([
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "LANG",
    "LC_ALL",
  ]);
  /** @type {NodeJS.ProcessEnv} */
  const environment = {};
  for (const [name, value] of Object.entries(process.env))
    if (allowed.has(name.toUpperCase()) && value !== undefined)
      environment[name] = value;
  return {
    ...environment,
    ZENROWS_API_KEY: key,
    PLAYWRIGHT_BROWSERS_PATH: resolve(ROOT, ".cache/ms-playwright"),
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
  };
}

/** @param {unknown} value @param {string} key */
function containsSecret(value, key) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string" && current.includes(key)) return true;
    if (current && typeof current === "object")
      for (const [name, nested] of Object.entries(current)) {
        if (name.includes(key)) return true;
        pending.push(nested);
      }
  }
  return false;
}

/** @param {unknown} value @returns {Record<string,unknown>|null} */
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string,unknown>} */ (value)
    : null;
}

/** @param {Record<string,unknown>} value @param {string[]} keys */
function exactKeys(value, keys) {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((name) => keys.includes(name))
  );
}

/** @param {string} value */
function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

/** @param {string} output @param {number|null} exitCode @param {PythonSource} source
 * @param {import('./types.js').RunInputs} inputs @param {string} key
 * @returns {import('./types.js').RunData}
 */
function parseResult(output, exitCode, source, inputs, key) {
  /** @type {unknown} */
  let decoded;
  try {
    decoded = JSON.parse(output);
  } catch {
    throw invalidOutput();
  }
  if (containsSecret(decoded, key)) throw invalidOutput();
  const result = object(decoded);
  if (!result) throw invalidOutput();
  if (result["ok"] === false) {
    if (exitCode !== 1 || !exactKeys(result, ["ok", "error"]))
      throw invalidOutput();
    const error = object(result["error"]);
    if (!error || typeof error["code"] !== "string") throw invalidOutput();
    throw collectorFailure(error["code"]);
  }
  if (
    exitCode !== 0 ||
    result["ok"] !== true ||
    !exactKeys(result, [
      "ok",
      "target",
      "mode",
      "status",
      "count",
      "records",
    ]) ||
    result["target"] !== source ||
    result["mode"] !== "managed" ||
    (result["status"] !== 200 &&
      !(source === "booking" && result["status"] === 202)) ||
    !Array.isArray(result["records"]) ||
    !Number.isSafeInteger(result["count"]) ||
    result["count"] !== result["records"].length ||
    result["records"].length === 0
  )
    throw invalidOutput();
  try {
    return cleanRecords(source, inputs, result["records"]);
  } catch {
    throw invalidOutput();
  }
}

/**
 * @param {{apiKey?:string,pythonExecutable?:string,spawnImpl?:SpawnCollector,killTree?:KillTree}} options
 */
export function createPythonCollectors({
  apiKey,
  pythonExecutable = process.env["WSP_PYTHON_EXE"] ??
    resolve(ROOT, ".venv/Scripts/python.exe"),
  spawnImpl = spawn,
  killTree = killOwnedTree,
} = {}) {
  /** @param {PythonSource} source @param {import('./types.js').RunInputs} rawInputs
   * @param {AbortSignal} signal @returns {Promise<import('./types.js').RunData>}
   */
  async function collect(source, rawInputs, signal) {
    const inputs = normalizeInputs(source, rawInputs);
    if (
      !signal ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function"
    )
      throw configurationRequired();
    if (signal.aborted) throw cancelled();
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (
      !key ||
      hasControlCharacter(key) ||
      typeof pythonExecutable !== "string" ||
      !isAbsolute(pythonExecutable) ||
      hasControlCharacter(pythonExecutable)
    )
      throw configurationRequired();
    const environment = childEnvironment(key);
    const args = [SCRIPT, source, "--mode", "managed"];
    const flags =
      source === "indeed"
        ? ["query", "location"]
        : ["destination", "checkin", "checkout", "adults", "rooms"];
    for (const name of flags) args.push(`--${name}`, String(inputs[name]));
    /** @type {CollectorProcess} */
    let child;
    try {
      child = spawnImpl(pythonExecutable, args, {
        cwd: ROOT,
        env: environment,
        stdio: "pipe",
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch {
      throw configurationRequired();
    }

    return new Promise((resolvePromise, reject) => {
      /** @type {Buffer[]} */
      let chunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let closed = false;
      let settled = false;
      let stopping = false;
      /** @type {()=>void} */
      let acknowledgeClose;
      const closeAcknowledged = new Promise((resolveClose) => {
        acknowledgeClose = () => resolveClose(undefined);
      });

      /** @param {AppError|null} error @param {import('./types.js').RunData=} data */
      function finish(error, data) {
        if (settled) return;
        settled = true;
        chunks = [];
        clearTimeout(deadline);
        signal.removeEventListener("abort", onAbort);
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
        child.removeListener("error", onError);
        // A late OS error after an uncertain cleanup must remain private.
        child.on("error", () => {});
        for (const pipe of [child.stdin, child.stdout, child.stderr]) {
          pipe.removeListener("error", onPipeError);
          pipe.on("error", () => {});
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (error) reject(error);
        else if (data) resolvePromise(data);
        else reject(invalidOutput());
      }

      /** @param {AppError} error */
      function stop(error) {
        if (settled || stopping) return;
        stopping = true;
        chunks = [];
        clearTimeout(deadline);
        signal.removeEventListener("abort", onAbort);
        if (closed) {
          finish(error);
          return;
        }
        if (!Number.isSafeInteger(child.pid) || Number(child.pid) <= 0) {
          finish(cleanupFailed());
          return;
        }
        const cleanup = (async () => {
          await killTree(/** @type {number} */ (child.pid), child);
          await closeAcknowledged;
        })();
        bounded(cleanup, CLEANUP_MS).then(
          () => finish(error),
          () => finish(cleanupFailed()),
        );
      }

      function onAbort() {
        stop(cancelled());
      }
      /** @param {Buffer|string} chunk */
      function onStdout(chunk) {
        if (settled || stopping) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.byteLength;
        if (stdoutBytes > MAX_STDOUT) {
          stop(
            new AppError(
              502,
              "UPSTREAM_TOO_LARGE",
              "The collector response exceeded the size limit.",
            ),
          );
          return;
        }
        chunks.push(bytes);
      }
      /** @param {Buffer|string} chunk */
      function onStderr(chunk) {
        if (settled || stopping) return;
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_STDERR)
          stop(
            new AppError(
              502,
              "COLLECTOR_DIAGNOSTICS_LIMIT",
              "The collector diagnostic limit was exceeded.",
            ),
          );
      }
      /** @param {NodeJS.ErrnoException} error */
      function onError(error) {
        const failure = ["ENOENT", "EACCES", "ENOEXEC"].includes(
          error.code ?? "",
        )
          ? configurationRequired()
          : collectorFailure("worker_failure");
        if (child.pid === undefined) finish(failure);
        else stop(failure);
      }
      function onPipeError() {
        stop(collectorFailure("worker_failure"));
      }
      const deadline = setTimeout(
        () =>
          stop(
            new AppError(
              504,
              "UPSTREAM_TIMEOUT",
              "The collection exceeded its deadline.",
            ),
          ),
        source === "indeed" ? 205000 : 65000,
      );
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      for (const pipe of [child.stdin, child.stdout, child.stderr])
        pipe.on("error", onPipeError);
      child.once("close", (code) => {
        closed = true;
        acknowledgeClose();
        if (settled || stopping) return;
        try {
          const output = Buffer.concat(chunks, stdoutBytes).toString("utf8");
          finish(null, parseResult(output, code, source, inputs, key));
        } catch (error) {
          finish(error instanceof AppError ? error : invalidOutput());
        }
      });
      try {
        child.stdin.end();
      } catch {
        onPipeError();
      }
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  return {
    /** @param {import('./types.js').RunInputs} inputs @param {AbortSignal} signal */
    indeed: (inputs, signal) => collect("indeed", inputs, signal),
    /** @param {import('./types.js').RunInputs} inputs @param {AbortSignal} signal */
    booking: (inputs, signal) => collect("booking", inputs, signal),
  };
}
