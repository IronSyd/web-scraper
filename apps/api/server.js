import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { connectMongoRuns } from "./mongo-runs.js";
import { createHtmlClients, validateTiobeUrl } from "./transport.js";
import { parseAmazon, parseTiobe } from "./parsers.js";
import { createPythonCollectors } from "./python-collectors.js";

/** @param {import('node:http').Server} server @param {()=>Promise<void>} stopCollections @param {()=>Promise<void>} closeDatabase */
export async function closeLocalRuntime(
  server,
  stopCollections,
  closeDatabase,
) {
  const stopped = new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve(undefined))),
  );
  server.closeIdleConnections();
  let failed = false;
  /** @type {unknown} */ let failure;
  try {
    await stopCollections();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    server.closeAllConnections();
    try {
      await stopped;
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  // Retain the live owner/connection on unconfirmed cleanup; a new API must not overlap it.
  if (failed) throw failure;
  await closeDatabase();
}

/** @param {NodeJS.ProcessEnv} environment */
export async function startServer(environment = process.env) {
  const uri =
    environment["MONGO_URI"] ?? "mongodb://127.0.0.1:27017/web_scraper";
  const tiobeUrl = validateTiobeUrl(
    environment["TIOBE_URL"] ?? "https://www.tiobe.com/tiobe-index/",
  );
  const port = Number(environment["PORT"] ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid local API port.");
  const clients = createHtmlClients({ apiKey: environment["ZENROWS_API_KEY"] });
  const python = createPythonCollectors({
    apiKey: environment["ZENROWS_API_KEY"],
    pythonExecutable: environment["WSP_PYTHON_EXE"],
  });
  const database = await connectMongoRuns(uri);
  const app = createApp({
    repository: database.repository,
    collectionEnabled: environment["WSP_COLLECTION_ENABLED"] === "true",
    collectors: {
      ...python,
      tiobe: async (_inputs, signal) =>
        parseTiobe(await clients.publicTiobe(tiobeUrl, signal), tiobeUrl),
      amazon: async (inputs, signal) =>
        parseAmazon(
          await clients.amazon(String(inputs["query"]), signal),
          String(inputs["query"]),
        ),
    },
  });
  const server = app.listen(port, "127.0.0.1");
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    await database.close();
    throw error;
  }
  let closed = false;
  return {
    server,
    async close() {
      if (closed) return;
      closed = true;
      await closeLocalRuntime(
        server,
        () => app.locals["runs"].close(),
        () => database.close(),
      );
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startServer()
    .then((runtime) => {
      console.log("Web Scraper API listening on the configured loopback port.");
      const stop = () => {
        runtime.close().catch(() => {
          process.exitCode = 1;
        });
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch(() => {
      console.error(
        "Web Scraper API startup failed. Check local database and configuration.",
      );
      process.exitCode = 1;
    });
}
