import { encodeCursor, order, summary } from "../run-contract.js";
import { bookRecord, languageRecords } from "./fixtures.js";
export const runId = (number = 1) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
export const sourceInputs = {
  amazon: { query: "query" },
  indeed: { query: "Developer", location: "London" },
  booking: {
    destination: "London",
    checkin: "2026-12-20",
    checkout: "2026-12-22",
    adults: 2,
    rooms: 1,
  },
  tiobe: {},
};
export const jobRecord = () => ({
  jobId: "ab123456",
  title: "Developer",
  company: "Example",
  location: "London",
  url: "https://www.indeed.com/viewjob?jk=ab123456",
});
export const hotelRecord = () => ({
  name: "Example Hotel",
  url: "https://www.booking.com/hotel/gb/example.html?checkin=2026-12-20&checkout=2026-12-22&group_adults=2&no_rooms=1",
  price: "Total £200",
  currency: "GBP",
  rating: "8.5",
  reviewCount: 42,
  location: "London",
});
export const fakeCollectors = () => ({
  amazon: async () => [bookRecord()],
  tiobe: async () => languageRecords(),
  indeed: async () => [jobRecord()],
  booking: async () => [hotelRecord()],
});
export function runningRun(id = runId(), source = "amazon") {
  const stamp = "2026-10-16T12:00:00.000Z";
  return {
    id,
    source,
    inputs: sourceInputs[source],
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
}
export function memoryRuns(seed = []) {
  const entries = new Map(
    seed.map((run) => [run.id, structuredClone({ archivedAt: null, ...run })]),
  );
  const retired = new Set();
  return {
    entries,
    retired,
    async get(id) {
      return structuredClone(entries.get(id) ?? null);
    },
    async isDeleted(id) {
      return retired.has(id);
    },
    async archive(id, archivedAt) {
      if (retired.has(id)) return "deleted";
      const run = entries.get(id);
      if (!run) return "missing";
      if (run.status === "running") return "running";
      run.archivedAt =
        archivedAt === null ? null : (run.archivedAt ?? archivedAt);
      return structuredClone(run);
    },
    async remove(id) {
      if (retired.has(id)) return "deleted";
      const run = entries.get(id);
      if (!run) return "missing";
      if (run.status === "running") return "running";
      retired.add(id);
      entries.delete(id);
      return "deleted";
    },
    async insert(run) {
      if (entries.has(run.id) || retired.has(run.id)) return false;
      entries.set(run.id, structuredClone(run));
      return true;
    },
    async finish(run) {
      if (entries.get(run.id)?.status === "running")
        entries.set(run.id, structuredClone(run));
      return structuredClone(entries.get(run.id) ?? null);
    },
    async list({ source, visibility = "active", limit, cursor }) {
      const sorted = [...entries.values()]
        .filter((run) => !source || run.source === source)
        .filter((run) =>
          visibility === "archived" ? Boolean(run.archivedAt) : !run.archivedAt,
        )
        .filter((run) => {
          const item = order(run);
          return (
            !cursor ||
            item.time < cursor.time ||
            (item.time === cursor.time && item.tie < cursor.tie)
          );
        })
        .sort((a, b) => {
          const x = order(a),
            y = order(b);
          return y.time - x.time || y.tie.localeCompare(x.tie);
        });
      const selected = sorted.slice(0, limit),
        last = selected.at(-1);
      return {
        runs: selected.map(summary),
        nextCursor: sorted.length > limit ? encodeCursor(order(last)) : null,
      };
    },
    async latest(source, inputs) {
      return (
        [...entries.values()]
          .filter(
            (run) =>
              run.source === source &&
              run.status === "succeeded" &&
              !run.archivedAt &&
              (!inputs ||
                JSON.stringify(run.inputs) === JSON.stringify(inputs)),
          )
          .sort(
            (a, b) =>
              b.createdAt.localeCompare(a.createdAt) ||
              b.id.localeCompare(a.id),
          )[0] ?? null
      );
    },
  };
}
