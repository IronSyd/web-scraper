import { AppError, databaseUnavailable } from "./errors.js";
import {
  cleanRecords,
  isObject,
  legacyKey,
  normalizeInputs,
  requestId,
  safeRunError,
  sourceName,
  validateRun,
} from "./run-contract.js";

/** @param {{repository:import('./types.js').RunRepository,collectors:import('./types.js').RunCollectors,collectionEnabled?:boolean,now?:()=>Date}} options */
export function createRunService({
  repository,
  collectors,
  collectionEnabled = false,
  now = () => new Date(),
}) {
  /** @type {{id:string,source:import('./types.js').Source,controller:AbortController,promise:Promise<void>}|null} */ let active =
    null;
  let stopping = false,
    blocked = false;
  let cleanupUncertain = false;
  /** @type {Map<string,{signature:string,promise:Promise<{run:import('./types.js').Run,status:number}>}>} */ const pending =
    new Map();
  /** @type {string|null} */ let reservation = null;
  /** @template T @param {()=>Promise<T>} operation @returns {Promise<T>} */
  async function database(operation) {
    try {
      return await operation();
    } catch {
      throw databaseUnavailable();
    }
  }
  /** @param {string} id */
  function validateId(id) {
    if (id.startsWith("legacy-")) legacyKey(id);
    else requestId(id);
  }
  const deletedRun = () =>
    new AppError(
      410,
      "RUN_DELETED",
      "This saved run was permanently deleted. Choose another run from History.",
    );
  /** @param {string} id */
  async function rejectDeleted(id) {
    if (await database(() => repository.isDeleted(id))) throw deletedRun();
  }
  /** @param {'missing'|'running'|'deleted'} outcome */
  function managementError(outcome) {
    if (outcome === "deleted") return deletedRun();
    return outcome === "running"
      ? new AppError(
          409,
          "RUN_RUNNING",
          "Wait for this collection to finish before managing its saved run.",
        )
      : new AppError(404, "RUN_NOT_FOUND", "This saved run does not exist.");
  }
  /** @param {import('./types.js').Run} run @param {AbortSignal} signal */
  async function execute(run, signal) {
    let terminal;
    try {
      if (signal.aborted)
        throw new AppError(503, "RUN_CANCELLED", "Collection was cancelled.");
      const collect = collectors[run.source];
      if (!collect)
        throw new AppError(
          503,
          "CONFIGURATION_REQUIRED",
          "Collection configuration is unavailable.",
        );
      const data = cleanRecords(
        run.source,
        run.inputs,
        await collect(run.inputs, signal),
      );
      if (signal.aborted)
        throw new AppError(503, "RUN_CANCELLED", "Collection was cancelled.");
      const completedAt = now().toISOString();
      terminal = {
        ...run,
        status: /** @type {const} */ ("succeeded"),
        completedAt,
        collectedAt: completedAt,
        savedAt: completedAt,
        resultCount: data.length,
        data,
      };
    } catch (error) {
      const completedAt = now().toISOString();
      const failure =
        signal.aborted &&
        !(
          error instanceof AppError && error.code === "COLLECTOR_CLEANUP_FAILED"
        )
          ? safeRunError(new AppError(503, "RUN_CANCELLED", ""))
          : safeRunError(error);
      if (failure.code === "COLLECTOR_CLEANUP_FAILED") {
        blocked = true;
        cleanupUncertain = true;
      }
      terminal = {
        ...run,
        status: /** @type {const} */ ("failed"),
        completedAt,
        savedAt: completedAt,
        error: failure,
      };
    }
    try {
      const saved = await repository.finish(validateRun(terminal));
      if (saved === null || validateRun(saved).status === "running")
        blocked = true;
    } catch {
      blocked = true;
    }
  }
  return {
    collectionEnabled,
    /** @returns {{id:string,source:import('./types.js').Source}|null} */
    get activeRun() {
      return active === null ? null : { id: active.id, source: active.source };
    },
    /** @param {unknown} body @returns {Promise<{run:import('./types.js').Run,status:number}>} */
    async submit(body) {
      if (
        !isObject(body) ||
        Object.keys(body).length !== 3 ||
        !["source", "inputs", "requestId"].every((key) =>
          Object.hasOwn(body, key),
        )
      )
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Provide source, inputs and requestId only.",
        );
      const source = sourceName(body["source"]),
        inputs = normalizeInputs(source, body["inputs"]),
        id = requestId(body["requestId"]);
      const signature = JSON.stringify({ source, inputs });
      const same = pending.get(id);
      if (same) {
        if (same.signature !== signature)
          throw new AppError(
            409,
            "REQUEST_ID_CONFLICT",
            "This request identifier belongs to different source inputs.",
          );
        return same.promise;
      }
      const operation = async () => {
        const stored = await database(() => repository.get(id));
        if (stored !== null) {
          const existing = validateRun(stored);
          if (
            existing.source !== source ||
            JSON.stringify(existing.inputs) !== JSON.stringify(inputs)
          )
            throw new AppError(
              409,
              "REQUEST_ID_CONFLICT",
              "This request identifier belongs to different source inputs.",
            );
          return {
            run: existing,
            status: existing.status === "running" ? 202 : 200,
          };
        }
        await rejectDeleted(id);
        if (!collectionEnabled)
          throw new AppError(
            503,
            "COLLECTION_DISABLED",
            "Fresh collection is disabled. Saved results remain available.",
          );
        if (stopping || blocked)
          throw new AppError(
            503,
            "COLLECTION_UNAVAILABLE",
            "Collection is unavailable. Check the local API before collecting again.",
          );
        if (active !== null || reservation !== null)
          throw new AppError(
            409,
            "COLLECTION_BUSY",
            "Another collection is running. Wait for it to finish.",
          );
        const stamp = now().toISOString();
        /** @type {import('./types.js').Run} */
        const run = {
          id,
          source,
          inputs,
          status: "running",
          provenance: "collection",
          createdAt: stamp,
          startedAt: stamp,
          completedAt: null,
          collectedAt: null,
          savedAt: stamp,
          archivedAt: null,
          resultCount: 0,
          data: null,
          error: null,
        };
        let inserted;
        reservation = id;
        try {
          inserted = await repository.insert(run);
        } catch {
          blocked = true;
          throw databaseUnavailable();
        } finally {
          if (reservation === id) reservation = null;
        }
        if (!inserted) {
          const existing = await database(() => repository.get(id));
          if (existing === null) {
            await rejectDeleted(id);
            throw databaseUnavailable();
          }
          const replay = validateRun(existing);
          if (
            replay.source !== source ||
            JSON.stringify(replay.inputs) !== JSON.stringify(inputs)
          )
            throw new AppError(
              409,
              "REQUEST_ID_CONFLICT",
              "This request identifier belongs to different source inputs.",
            );
          return {
            run: replay,
            status: replay.status === "running" ? 202 : 200,
          };
        }
        const controller = new AbortController();
        if (stopping) controller.abort();
        const promise = Promise.resolve()
          .then(() => execute(run, controller.signal))
          .finally(() => {
            if (active?.id === id) active = null;
          });
        active = { id, source, controller, promise };
        return { run, status: 202 };
      };
      const result = operation();
      pending.set(id, { signature, promise: result });
      const clear = () => {
        if (pending.get(id)?.promise === result) pending.delete(id);
      };
      result.then(clear, clear);
      return result;
    },
    /** @param {string} id */
    async get(id) {
      validateId(id);
      const run = await database(() => repository.get(id));
      if (run === null) await rejectDeleted(id);
      return run === null ? null : validateRun(run);
    },
    /** @param {string} id @param {unknown} body */
    async archive(id, body) {
      validateId(id);
      if (
        !isObject(body) ||
        Object.keys(body).length !== 1 ||
        typeof body["archived"] !== "boolean"
      )
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Provide archived as a boolean only.",
        );
      const result = await database(() =>
        repository.archive(id, body["archived"] ? now().toISOString() : null),
      );
      if (typeof result === "string") throw managementError(result);
      return validateRun(result);
    },
    /** @param {string} id @param {unknown} body */
    async remove(id, body) {
      validateId(id);
      if (
        !isObject(body) ||
        Object.keys(body).length !== 1 ||
        body["confirm"] !== true
      )
        throw new AppError(
          400,
          "CONFIRMATION_REQUIRED",
          "Confirm permanent deletion explicitly.",
        );
      const result = await database(() =>
        repository.remove(id, now().toISOString()),
      );
      if (result !== "deleted") throw managementError(result);
    },
    /** @param {import('./types.js').HistoryOptions} options */
    async list(options) {
      return /** @type {import('./types.js').RunHistory} */ (
        await database(() => repository.list(options))
      );
    },
    /** @param {import('./types.js').Source} source @param {import('./types.js').RunInputs} [inputs] */
    async latest(source, inputs) {
      const run = await database(() => repository.latest(source, inputs));
      return run === null ? null : validateRun(run);
    },
    async idle() {
      await Promise.allSettled(
        [...pending.values()].map((item) => item.promise),
      );
      if (active) await active.promise;
    },
    async close() {
      stopping = true;
      active?.controller.abort();
      let timer;
      try {
        await Promise.race([
          (async () => {
            await Promise.allSettled(
              [...pending.values()].map((item) => item.promise),
            );
            if (active) {
              active.controller.abort();
              await active.promise;
            }
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Collector shutdown exceeded its cleanup deadline.",
                  ),
                ),
              11000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (cleanupUncertain)
        throw new AppError(
          503,
          "COLLECTOR_CLEANUP_FAILED",
          "Collector cleanup could not be confirmed.",
        );
    },
  };
}
