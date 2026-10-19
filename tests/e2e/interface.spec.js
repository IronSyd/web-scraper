import { test, expect } from "@playwright/test";

// Synthetic records are confined to controlled offline tests.
const names = {
  amazon: "Amazon",
  booking: "Booking.com",
  indeed: "Indeed",
  tiobe: "TIOBE Index",
};
const inputs = {
  amazon: { query: "Python" },
  indeed: { query: "Developer", location: "London" },
  booking: {
    destination: "London",
    checkin: "2026-01-01",
    checkout: "2026-01-03",
    adults: 2,
    rooms: 1,
  },
  tiobe: {},
};
function records(source, query = "Python") {
  if (source === "amazon")
    return [
      {
        searchTerm: query,
        title: "Example Python Book",
        authors: ["Example Author"],
        url: "https://www.amazon.com/dp/B000000001",
        price: "$0.00 with Kindle Unlimited membership — Or $19.99 to buy",
        rating: null,
        reviews: null,
        image: null,
      },
    ];
  if (source === "indeed")
    return [
      {
        jobId: "0123456789abcdef",
        title: "Example Developer",
        company: "Example Company",
        location: "London",
        url: "https://www.indeed.com/viewjob?jk=0123456789abcdef",
      },
    ];
  if (source === "booking")
    return [
      {
        name: "Example Hotel",
        url: "https://www.booking.com/hotel/gb/example.html?checkin=2026-01-01&checkout=2026-01-03&group_adults=2&no_rooms=1",
        price: "£240 for 2 nights, taxes included",
        currency: "GBP",
        rating: null,
        reviewCount: 0,
        location: "London",
      },
    ];
  return Array.from({ length: 20 }, (_, index) => ({
    ranking: index + 1,
    pLang: "Language " + (index + 1),
    imagePath: "https://www.tiobe.com/icon.png",
  }));
}
function saved(source = "amazon", index = 1) {
  const stamp = new Date(Date.UTC(2026, 9, 16, 12, index)).toISOString();
  const data = records(source);
  return {
    id: "00000000-0000-4000-8000-" + String(index).padStart(12, "0"),
    source,
    inputs: inputs[source],
    status: "succeeded",
    provenance: "collection",
    createdAt: stamp,
    startedAt: stamp,
    completedAt: stamp,
    collectedAt: stamp,
    savedAt: stamp,
    archivedAt: null,
    resultCount: data.length,
    data,
    error: null,
  };
}
function running(source = "indeed", index = 8) {
  return {
    ...saved(source, index),
    status: "running",
    completedAt: null,
    collectedAt: null,
    resultCount: 0,
    data: null,
  };
}
function finish(run, status = "succeeded") {
  run.status = status;
  run.completedAt = "2026-10-16T13:01:00.000Z";
  run.savedAt = run.completedAt;
  if (status === "failed") {
    run.error = {
      code: "UPSTREAM_FAILURE",
      message: "private diagnostic do not display",
    };
  } else {
    run.collectedAt = run.completedAt;
    run.data = records(run.source, run.inputs.query);
    run.resultCount = run.data.length;
  }
}
async function fakeApi(page, initial = []) {
  const store = {
    runs: new Map(initial.map((run) => [run.id, structuredClone(run)])),
    posts: [],
    management: [],
    deleted: new Set(),
    gets: [],
    enabled: true,
    failNext: false,
    hold: false,
    pageSize: 20,
    corrupt: false,
    lostResponse: false,
    holdPost: false,
    releasePost: null,
    failHealth: false,
    failHistory: false,
    failLatest: false,
    holdHealth: false,
    holdHistory: false,
    releaseHealth: null,
    releaseHistory: null,
    activeId: null,
    healthOverride: null,
    failRun: false,
    malformedRun: false,
    terminalPost: false,
    failMutation: false,
    holdMutation: false,
    releaseMutation: null,
    raceRunning: false,
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" || url.port !== "5184")
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const method = route.request().method();
    const json = (value, status = 200) =>
      route.fulfill({ status, json: value });
    if (method === "GET") store.gets.push(url.pathname + url.search);
    if (url.pathname === "/api/health" && method === "GET") {
      // Capture before a held response, allowing a stale-idle race to be tested.
      const active = store.runs.get(store.activeId);
      const value = {
        status: "ok",
        collectionEnabled: store.enabled,
        activeRun: active ? { id: active.id, source: active.source } : null,
      };
      if (store.holdHealth)
        await new Promise((resolve) => {
          store.releaseHealth = resolve;
        });
      if (store.failHealth) return json({ error: "synthetic failure" }, 503);
      return json(store.healthOverride ?? value);
    }
    if (url.pathname === "/api/runs" && method === "POST") {
      const body = route.request().postDataJSON();
      store.posts.push(body);
      if (store.deleted.has(body.requestId))
        return json({ error: { code: "RUN_DELETED" } }, 410);
      const existing = store.runs.get(body.requestId);
      if (existing)
        return json(
          { run: existing },
          existing.status === "running" ? 202 : 200,
        );
      const stamp = "2026-10-16T13:00:00.000Z";
      const run = {
        ...saved(body.source),
        id: body.requestId,
        inputs: body.inputs,
        status: "running",
        createdAt: stamp,
        startedAt: stamp,
        completedAt: null,
        collectedAt: null,
        savedAt: stamp,
        resultCount: 0,
        data: null,
        error: null,
      };
      store.runs.set(run.id, run);
      store.activeId = run.id;
      if (store.terminalPost) {
        finish(run, store.failNext ? "failed" : "succeeded");
        store.failNext = false;
        store.activeId = null;
      }
      if (store.lostResponse) return route.abort();
      if (store.holdPost)
        await new Promise((resolve) => {
          store.releasePost = resolve;
        });
      return json({ run }, 202);
    }
    const ordered = () =>
      [...store.runs.values()].sort(
        (a, b) =>
          String(b.createdAt).localeCompare(String(a.createdAt)) ||
          b.id.localeCompare(a.id),
      );
    if (url.pathname === "/api/runs/latest" && method === "GET") {
      if (store.failLatest) return json({ error: "synthetic failure" }, 503);
      return json({
        run:
          ordered().find(
            (run) =>
              run.source === url.searchParams.get("source") &&
              run.status === "succeeded" &&
              !run.archivedAt,
          ) ?? null,
      });
    }
    if (url.pathname === "/api/runs" && method === "GET") {
      if (store.holdHistory)
        await new Promise((resolve) => {
          store.releaseHistory = resolve;
        });
      if (store.failHistory) return json({ error: "synthetic failure" }, 503);
      const archived = url.searchParams.get("visibility") === "archived";
      const filtered = ordered().filter(
        (run) =>
          Boolean(run.archivedAt) === archived &&
          (!url.searchParams.get("source") ||
            run.source === url.searchParams.get("source")),
      );
      const offset =
        url.searchParams.get("cursor") === "next-page" ? store.pageSize : 0;
      return json({
        runs: filtered.slice(offset, offset + store.pageSize).map((run) => {
          const summary = { ...run };
          delete summary.data;
          return summary;
        }),
        nextCursor:
          filtered.length > offset + store.pageSize ? "next-page" : null,
      });
    }
    if (
      url.pathname.startsWith("/api/runs/") &&
      ["PATCH", "DELETE"].includes(method)
    ) {
      const id = decodeURIComponent(url.pathname.slice("/api/runs/".length));
      const body = route.request().postDataJSON();
      store.management.push({ method, id, body });
      if (store.holdMutation)
        await new Promise((resolve) => {
          store.releaseMutation = resolve;
        });
      if (store.failMutation)
        return json({ error: { code: "DATABASE_UNAVAILABLE" } }, 503);
      if (store.deleted.has(id))
        return method === "DELETE"
          ? json({ id, deleted: true })
          : json({ error: { code: "RUN_DELETED" } }, 410);
      const run = store.runs.get(id);
      if (!run) return json({ error: { code: "RUN_NOT_FOUND" } }, 404);
      if (run.status === "running" || store.raceRunning)
        return json({ error: { code: "RUN_RUNNING" } }, 409);
      if (method === "PATCH") {
        if (typeof body.archived !== "boolean")
          return json({ error: { code: "INVALID_REQUEST" } }, 400);
        run.archivedAt = body.archived ? "2026-10-19T12:00:00.000Z" : null;
        return json({ run });
      }
      if (body.confirm !== true)
        return json({ error: { code: "INVALID_REQUEST" } }, 400);
      store.deleted.add(id);
      store.runs.delete(id);
      return json({ id, deleted: true });
    }
    if (url.pathname.startsWith("/api/runs/") && method === "GET") {
      if (store.failRun) return json({ error: "synthetic failure" }, 503);
      const id = decodeURIComponent(url.pathname.slice("/api/runs/".length));
      if (store.deleted.has(id))
        return json({ error: { code: "RUN_DELETED" } }, 410);
      const run = store.runs.get(id);
      if (!run)
        return json(
          { error: { code: "NOT_FOUND", message: "private diagnostic" } },
          404,
        );
      if (run.status === "running" && !store.hold) {
        finish(run, store.failNext ? "failed" : "succeeded");
        store.failNext = false;
        if (store.activeId === run.id) store.activeId = null;
      }
      const output = structuredClone(run);
      if (store.malformedRun) output.source = "private diagnostic";
      if (store.corrupt && output.data?.length)
        output.data[0].url = "javascript:alert('private diagnostic')";
      return json({ run: output });
    }
    // An unmatched API call must never reach a real API or provider.
    return route.abort();
  });
  return store;
}
async function fillForm(page, source) {
  for (const [key, value] of Object.entries(inputs[source]))
    await page.locator('[name="' + key + '"]').fill(String(value));
}
async function noOverflow(page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

for (const source of Object.keys(names)) {
  test(
    source + " collection saves a stable run and reload is GET-only",
    async ({ page }) => {
      const store = await fakeApi(page);
      store.hold = true;
      await page.goto("/sources/" + source);
      await expect(
        page.getByRole("heading", { name: names[source], exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("No saved results for this source yet.", {
          exact: false,
        }),
      ).toBeVisible();
      expect(store.posts).toHaveLength(0);
      await fillForm(page, source);
      await page
        .getByRole("button", { name: "Collect fresh data", exact: true })
        .click();
      await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
      await expect(page.locator(".collection-availability")).toHaveText(
        "Collecting " + names[source] + "…",
      );
      store.hold = false;
      await expect(
        page.getByText("Saved successfully", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Open saved run", exact: true }),
      ).toHaveCount(0);
      await expect(page.locator(".collection-availability")).toHaveText(
        names[source] + " collection complete",
      );
      expect(store.posts).toHaveLength(1);
      expect(await page.evaluate(() => window.history.state?.usr)).toBeFalsy();
      expect(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
      ).toBe(0);
      expect(store.posts[0].inputs).toEqual(inputs[source]);
      const path = new URL(page.url()).pathname;
      await page.reload();
      await expect(page.locator(".collection-availability")).toHaveText(
        "Fresh collection available",
      );
      await expect(
        page.getByText("Saved successfully", { exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(path + "$"));
      await expect(
        page.getByRole("link", { name: "Open saved run", exact: true }),
      ).toHaveCount(0);
      expect(store.posts).toHaveLength(1);
      if (source === "booking")
        await expect(
          page.getByText("0 reviews", { exact: true }),
        ).toBeVisible();
      if (source === "tiobe")
        await expect(page.getByRole("row")).toHaveCount(21);
      if (source === "amazon")
        await expect(page.getByText(/Or \$19.99 to buy/)).toBeVisible();
      await noOverflow(page);
    },
  );

  test(
    source + " saved link opens its snapshot and hides only the current run",
    async ({ page }, testInfo) => {
      const run = saved(source);
      const store = await fakeApi(page, [run]);
      store.enabled = false;
      await page.goto("/sources/" + source);
      const link = page.getByRole("link", {
        name: "Open saved run",
        exact: true,
      });
      await expect(link).toHaveAttribute("href", "/runs/" + run.id);
      await link.click();
      await expect(page).toHaveURL(new RegExp("/runs/" + run.id + "$"));
      await expect(
        page.getByRole("heading", { name: "Saved run · " + names[source] }),
      ).toBeVisible();
      await expect(
        page.getByText("Saved successfully", { exact: true }),
      ).toBeVisible();
      await expect(link).toHaveCount(0);
      await page.goto("/runs/" + run.id + "?view=saved");
      await page.reload();
      await expect(
        page.getByText("Saved successfully", { exact: true }),
      ).toBeVisible();
      await expect(link).toHaveCount(0);
      if (
        source === "amazon" &&
        ["desktop", "mobile"].includes(testInfo.project.name)
      )
        await page.screenshot({
          path:
            "artifacts/saved-run-link/" +
            testInfo.project.name +
            "-succeeded.png",
          fullPage: true,
          animations: "disabled",
        });
      await page.getByRole("link", { name: "View all history" }).click();
      await expect(page).toHaveURL(/\/history$/);
      const historyLink = page.locator(".activity-row a");
      await expect(historyLink).toHaveAttribute("href", "/runs/" + run.id);
      await historyLink.click();
      await expect(
        page.getByText("Saved successfully", { exact: true }),
      ).toBeVisible();
      await expect(link).toHaveCount(0);
      expect(store.posts).toHaveLength(0);
    },
  );
}

for (const status of ["failed", "running"]) {
  test(
    status + " saved run keeps the link to a different previous success",
    async ({ page }, testInfo) => {
      const previous = saved("amazon", 1);
      const current = running("amazon", 8);
      if (status === "failed") finish(current, "failed");
      const store = await fakeApi(page, [previous, current]);
      store.enabled = false;
      store.hold = true;
      await page.goto("/runs/" + current.id);
      await expect(page.locator(".run-context")).toHaveCount(2);
      await expect(page.locator(".run-context").first()).toContainText(
        status === "failed" ? "Collection failed" : "Collection running",
      );
      await expect(
        page
          .locator(".run-context")
          .first()
          .getByRole("link", { name: "Open saved run", exact: true }),
      ).toHaveCount(0);
      const previousLink = page.getByRole("link", {
        name: "Open saved run",
        exact: true,
      });
      await expect(previousLink).toHaveCount(1);
      await expect(previousLink).toHaveAttribute(
        "href",
        "/runs/" + previous.id,
      );
      await expect(
        page.getByRole("heading", { name: "Example Python Book" }),
      ).toBeVisible();
      if (
        status === "failed" &&
        ["desktop", "mobile"].includes(testInfo.project.name)
      )
        await page.screenshot({
          path:
            "artifacts/saved-run-link/" + testInfo.project.name + "-failed.png",
          fullPage: true,
          animations: "disabled",
        });
      await previousLink.click();
      await expect(page).toHaveURL(new RegExp("/runs/" + previous.id + "$"));
      await expect(
        page.getByRole("heading", { name: "Saved results", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Saved successfully", { exact: true }),
      ).toBeVisible();
      await expect(previousLink).toHaveCount(0);
      expect(store.posts).toHaveLength(0);
    },
  );
}

test("global indicator finds external activity across navigation and reload using only GETs", async ({
  page,
}) => {
  await page.clock.install();
  const old = saved("amazon", 1);
  const active = running("indeed", 8);
  const store = await fakeApi(page, [old]);
  store.hold = true;
  await page.goto("/");
  const indicator = page.locator(".collection-availability");
  await expect(indicator).toHaveText("Fresh collection available");
  await expect(indicator).toHaveAttribute("role", "status");
  await expect(indicator).toHaveAttribute("aria-live", "polite");
  await expect(indicator).toHaveAttribute("aria-atomic", "true");
  store.runs.set(active.id, active);
  store.activeId = active.id;
  await page.clock.runFor(5001);
  await expect(indicator).toHaveText("Collecting Indeed…");
  await page.getByRole("link", { name: "Open Amazon collector" }).click();
  await expect(page).toHaveURL(/\/sources\/amazon$/);
  await expect(indicator).toHaveText("Collecting Indeed…");
  await page.goto("/runs/" + old.id);
  await expect(
    page.getByText("Saved successfully", { exact: true }),
  ).toBeVisible();
  await expect(indicator).toHaveText("Collecting Indeed…");
  await page.reload();
  await expect(indicator).toHaveText("Collecting Indeed…");
  finish(active);
  store.activeId = null;
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Indeed collection complete");
  expect(store.gets).toContain("/api/runs/" + active.id);
  expect(store.posts).toHaveLength(0);
});

for (const status of ["succeeded", "failed"]) {
  test(
    "global indicator announces a fast same-tab " +
      status +
      " run and resets after ten seconds",
    async ({ page }) => {
      await page.clock.install();
      const store = await fakeApi(page);
      store.terminalPost = true;
      store.failNext = status === "failed";
      await page.goto("/sources/indeed");
      const indicator = page.locator(".collection-availability");
      await expect(indicator).toHaveText("Fresh collection available");
      await fillForm(page, "indeed");
      await page
        .getByRole("button", { name: "Collect fresh data", exact: true })
        .click();
      const notice =
        "Indeed collection " + (status === "succeeded" ? "complete" : "failed");
      await expect(indicator).toHaveText(notice);
      await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
      await page.clock.runFor(9000);
      await expect(indicator).toHaveText(notice);
      await page.clock.runFor(1001);
      await expect(indicator).toHaveText("Fresh collection available");
      await page.clock.runFor(5001);
      await expect(indicator).toHaveText("Fresh collection available");
      expect(store.posts).toHaveLength(1);
      await expect(
        page.getByText("private diagnostic do not display"),
      ).toHaveCount(0);
    },
  );
}

test("global indicator recovers from malformed and failed health without losing the tracked run", async ({
  page,
}) => {
  await page.clock.install();
  const active = running();
  const store = await fakeApi(page, [active]);
  store.hold = true;
  store.activeId = active.id;
  await page.goto("/");
  const indicator = page.locator(".collection-availability");
  await expect(indicator).toHaveText("Collecting Indeed…");
  store.healthOverride = {
    status: "ok",
    collectionEnabled: true,
    activeRun: { id: active.id, source: "private diagnostic" },
  };
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Collection status unavailable");
  store.healthOverride = null;
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Collecting Indeed…");
  store.failHealth = true;
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Collection status unavailable");
  store.failHealth = false;
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Collecting Indeed…");
  expect(store.posts).toHaveLength(0);
  await expect(page.getByText("private diagnostic")).toHaveCount(0);
});

test("active disappearance and failed or malformed readback cannot fabricate completion", async ({
  page,
}) => {
  await page.clock.install();
  const active = running();
  const store = await fakeApi(page, [active]);
  store.hold = true;
  store.activeId = active.id;
  await page.goto("/");
  const indicator = page.locator(".collection-availability");
  await expect(indicator).toHaveText("Collecting Indeed…");
  store.activeId = null;
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Collection status unavailable");
  store.failRun = true;
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Collection status unavailable");
  finish(store.runs.get(active.id));
  store.failRun = false;
  store.malformedRun = true;
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Collection status unavailable");
  store.malformedRun = false;
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Indeed collection complete");
  expect(store.posts).toHaveLength(0);
  await expect(page.getByText("private diagnostic")).toHaveCount(0);
});

test("stale idle health cannot erase a newer admitted collection", async ({
  page,
}) => {
  await page.clock.install();
  const store = await fakeApi(page);
  store.hold = true;
  await page.goto("/sources/amazon");
  const indicator = page.locator(".collection-availability");
  await expect(indicator).toHaveText("Fresh collection available");
  await fillForm(page, "amazon");
  store.holdHealth = true;
  await page.clock.runFor(5001);
  await expect.poll(() => store.releaseHealth !== null).toBe(true);
  await page
    .getByRole("button", { name: "Collect fresh data", exact: true })
    .click();
  expect(store.posts).toHaveLength(1);
  await expect(indicator).toHaveText("Collecting Amazon…");
  store.holdHealth = false;
  store.releaseHealth();
  await expect(indicator).toHaveText("Collecting Amazon…");
  store.hold = false;
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Amazon collection complete");
  expect(store.posts).toHaveLength(1);
});

test("collection indicator active and terminal headers remain readable", async ({
  page,
}, testInfo) => {
  test.skip(
    !["desktop", "mobile"].includes(testInfo.project.name),
    "One batched desktop/mobile review covers this compact header refinement.",
  );
  await page.clock.install();
  const active = running("booking", 8);
  const store = await fakeApi(page, [active]);
  store.hold = true;
  store.activeId = active.id;
  await page.goto("/");
  const indicator = page.locator(".collection-availability");
  await expect(indicator).toHaveText("Collecting Booking.com…");
  const capture = async (state) => {
    await noOverflow(page);
    await expect(indicator).toBeVisible();
    const box = await indicator.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(
      testInfo.project.use.viewport.width,
    );
    await page.locator(".workspace-header").screenshot({
      path:
        "artifacts/collection-indicator/" +
        testInfo.project.name +
        "-" +
        state +
        ".png",
      animations: "disabled",
    });
  };
  await capture("active");
  finish(store.runs.get(active.id));
  store.activeId = null;
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Booking.com collection complete");
  await capture("complete");
  const next = running("booking", 9);
  store.runs.set(next.id, next);
  store.activeId = next.id;
  await page.clock.runFor(5001);
  await expect(indicator).toHaveText("Collecting Booking.com…");
  finish(next, "failed");
  store.activeId = null;
  await page.clock.runFor(1501);
  await expect(indicator).toHaveText("Booking.com collection failed");
  await capture("failed");
  expect(store.posts).toHaveLength(0);
});

test("four sources, keyboard navigation and legacy aliases", async ({
  page,
}, testInfo) => {
  const store = await fakeApi(page);
  await page.goto("/");
  await expect(page).toHaveTitle("Overview | Webby");
  if (testInfo.project.use.viewport.width < 992) {
    const toggle = page.getByRole("button", { name: "Open navigation" });
    await toggle.click();
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await toggle.click();
  }
  for (const source of Object.keys(names))
    await expect(
      page
        .getByRole("navigation")
        .getByRole("link", { name: names[source], exact: true }),
    ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Amazon", exact: true })
    .click();
  await expect(page.getByLabel("Title or keyword")).toBeVisible();
  await expect(page.locator("#main-content")).toBeFocused();
  await page.goto("/tiobe/Tiobe");
  await expect(page).toHaveURL(/\/sources\/tiobe$/);
  await page.goto("/amazon/Amazon");
  await expect(page).toHaveURL(/\/sources\/amazon$/);
  expect(store.posts).toHaveLength(0);
  await noOverflow(page);
});

test("history preserves snapshots, filters and stable page URLs", async ({
  page,
}) => {
  const old = saved("amazon", 1),
    newer = saved("amazon", 2),
    hotel = saved("booking", 3),
    job = saved("indeed", 4);
  old.data[0].title = "Older saved book";
  newer.data[0].title = "Newer saved book";
  const store = await fakeApi(page, [old, newer, hotel, job]);
  store.pageSize = 2;
  await page.goto("/history");
  await expect(page.locator(".history-list .activity-row")).toHaveCount(2);
  await page.getByRole("button", { name: "Older runs" }).click();
  await expect(page).toHaveURL(/cursor=next-page/);
  await expect(page.getByRole("link", { name: "Amazon · Python" })).toHaveCount(
    2,
  );
  await page.getByRole("link", { name: "Amazon · Python" }).last().click();
  await expect(
    page.getByRole("heading", { name: "Older saved book" }),
  ).toBeVisible();
  await page.goto("/history?source=amazon");
  await expect(page.getByLabel("Source", { exact: true })).toHaveValue(
    "amazon",
  );
  await page.reload();
  await expect(page.getByRole("link", { name: "Amazon · Python" })).toHaveCount(
    2,
  );
  await page.getByRole("link", { name: "Amazon · Python" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Newer saved book" }),
  ).toBeVisible();
  expect(store.posts).toHaveLength(0);
});

function historyRow(page, id) {
  return page.locator(".history-list .activity-row").filter({
    has: page.locator('a[href="/runs/' + id + '"]'),
  });
}

test("history archive and restore persist while latest results and Overview exclude archives", async ({
  page,
}) => {
  const previous = saved("amazon", 1);
  const current = saved("amazon", 2);
  previous.data[0].title = "Previous unarchived book";
  current.data[0].title = "Newest saved book";
  const store = await fakeApi(page, [previous, current]);
  await page.goto("/history?source=amazon");
  await historyRow(page, current.id)
    .getByRole("button", { name: /^Archive\b/ })
    .click();
  await expect(historyRow(page, current.id)).toHaveCount(0);
  expect(store.runs.get(current.id)).toEqual({
    ...current,
    archivedAt: "2026-10-19T12:00:00.000Z",
  });
  await page.reload();
  await expect(historyRow(page, previous.id)).toBeVisible();
  await expect(historyRow(page, current.id)).toHaveCount(0);
  await page.goto("/");
  await expect(
    page.locator('.activity-row a[href="/runs/' + current.id + '"]'),
  ).toHaveCount(0);
  await page.goto("/sources/amazon");
  await expect(
    page.getByRole("heading", { name: "Previous unarchived book" }),
  ).toBeVisible();
  await page.goto("/runs/" + current.id);
  await expect(
    page.getByText(/hidden from active history and latest results/),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Newest saved book" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "View archived history" }).click();
  await expect(page.getByLabel("Visibility", { exact: true })).toHaveValue(
    "archived",
  );
  await expect(historyRow(page, current.id)).toBeVisible();
  await historyRow(page, current.id)
    .getByRole("button", { name: /^Restore\b/ })
    .click();
  await expect(historyRow(page, current.id)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".history-list .activity-row")).toHaveCount(0);
  await page.goto("/sources/amazon");
  await expect(
    page.getByRole("heading", { name: "Newest saved book" }),
  ).toBeVisible();
  expect(store.management).toEqual([
    { method: "PATCH", id: current.id, body: { archived: true } },
    { method: "PATCH", id: current.id, body: { archived: false } },
  ]);
  expect(store.posts).toHaveLength(0);
});

test("delete confirmation traps focus and cancellation never mutates saved data", async ({
  page,
}, testInfo) => {
  const run = saved("booking", 3);
  const store = await fakeApi(page, [run]);
  await page.goto("/history");
  const trigger = historyRow(page, run.id).getByRole("button", {
    name: /^Delete\b/,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Delete saved run?" });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await expect(dialog).toContainText("Booking.com");
  await expect(dialog).toContainText("London");
  await expect(dialog).toContainText(/1 record/);
  await expect(dialog).toContainText(/permanent|cannot be undone/i);
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await noOverflow(page);
  await page.screenshot({
    path:
      "artifacts/history-management/" +
      testInfo.project.name +
      "-delete-confirmation.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await cancel.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(store.management).toHaveLength(0);
  expect(store.runs.get(run.id)).toEqual(run);
  expect(store.posts).toHaveLength(0);
});

test("confirmed deletion removes an archived snapshot and its URL has safe recovery", async ({
  page,
}, testInfo) => {
  const previous = saved("indeed", 1);
  const archived = saved("indeed", 2);
  archived.archivedAt = "2026-10-19T12:00:00.000Z";
  const store = await fakeApi(page, [previous, archived]);
  await page.goto("/history?source=indeed&visibility=archived");
  await expect(historyRow(page, archived.id)).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path:
      "artifacts/history-management/" +
      testInfo.project.name +
      "-archived-history.png",
    fullPage: true,
    animations: "disabled",
  });
  await historyRow(page, archived.id)
    .getByRole("button", { name: /^Delete\b/ })
    .click();
  await page
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Delete saved run?" }),
  ).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(page.locator(".history-list .activity-row")).toHaveCount(0);
  expect(store.runs.has(archived.id)).toBe(false);
  expect(store.deleted.has(archived.id)).toBe(true);
  expect(store.runs.get(previous.id)).toEqual(previous);
  await page.goto("/runs/" + archived.id);
  await expect(page.getByRole("alert")).toContainText("permanently deleted");
  await expect(
    page.getByRole("link", { name: "View all history" }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("permanently deleted");
  expect(store.management).toEqual([
    { method: "DELETE", id: archived.id, body: { confirm: true } },
  ]);
  expect(store.posts).toHaveLength(0);
});

test("pending deletion prevents duplicate actions and dismissal until the saved response", async ({
  page,
}) => {
  const run = saved();
  const store = await fakeApi(page, [run]);
  store.holdMutation = true;
  await page.goto("/history");
  await historyRow(page, run.id)
    .getByRole("button", { name: /^Delete\b/ })
    .click();
  const dialog = page.getByRole("dialog", { name: "Delete saved run?" });
  await dialog
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect.poll(() => store.releaseMutation !== null).toBe(true);
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: /Deleting|Delete permanently/i }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(store.management).toHaveLength(1);
  expect(store.runs.has(run.id)).toBe(true);
  store.releaseMutation();
  await expect(dialog).toBeHidden();
  await expect(historyRow(page, run.id)).toHaveCount(0);
  expect(store.management).toHaveLength(1);
  expect(store.posts).toHaveLength(0);
});

test("management failures keep the run and confirmation usable without automatic retries", async ({
  page,
}) => {
  const run = saved();
  const store = await fakeApi(page, [run]);
  store.failMutation = true;
  await page.goto("/history");
  const row = historyRow(page, run.id);
  await row.getByRole("button", { name: /^Archive\b/ }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(row).toBeVisible();
  expect(store.runs.get(run.id).archivedAt).toBeNull();
  const trigger = row.getByRole("button", { name: /^Delete\b/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Delete saved run?" });
  await dialog
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  expect(store.management).toHaveLength(2);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(row).toBeVisible();
  expect(store.runs.get(run.id)).toEqual(run);
  expect(store.deleted.has(run.id)).toBe(false);
  expect(store.management).toHaveLength(2);
  expect(store.posts).toHaveLength(0);
});

test("running actions are disabled and a server-side running race leaves a terminal row intact", async ({
  page,
}) => {
  const active = running("indeed", 8);
  const terminal = saved("booking", 3);
  const store = await fakeApi(page, [active, terminal]);
  store.hold = true;
  await page.goto("/history");
  const activeRow = historyRow(page, active.id);
  await expect(
    activeRow.getByRole("button", { name: /^Archive\b/ }),
  ).toBeDisabled();
  await expect(
    activeRow.getByRole("button", { name: /^Delete\b/ }),
  ).toBeDisabled();
  await expect(activeRow).toContainText(/running|finish/i);
  store.raceRunning = true;
  await historyRow(page, terminal.id)
    .getByRole("button", { name: /^Archive\b/ })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(historyRow(page, terminal.id)).toBeVisible();
  expect(store.runs.get(terminal.id)).toEqual(terminal);
  expect(store.management).toHaveLength(1);
  expect(store.posts).toHaveLength(0);
});

test("history management preserves filters and returns emptied cursor pages to newest", async ({
  page,
}) => {
  const old = saved("amazon", 1);
  const newer = saved("amazon", 2);
  const job = saved("indeed", 3);
  const store = await fakeApi(page, [old, newer, job]);
  store.pageSize = 1;
  await page.goto("/history?source=amazon");
  await page.getByRole("button", { name: "Older runs" }).click();
  await expect(historyRow(page, old.id)).toBeVisible();
  await historyRow(page, old.id)
    .getByRole("button", { name: /^Archive\b/ })
    .click();
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(page.getByLabel("Source", { exact: true })).toHaveValue(
    "amazon",
  );
  await expect(historyRow(page, newer.id)).toBeVisible();
  await page.getByLabel("Visibility", { exact: true }).selectOption("archived");
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(historyRow(page, old.id)).toBeVisible();
  await page.reload();
  await expect(historyRow(page, old.id)).toBeVisible();
  await page.getByLabel("Source", { exact: true }).selectOption("indeed");
  await expect(page.getByLabel("Visibility", { exact: true })).toHaveValue(
    "archived",
  );
  await expect(page.locator(".history-list .activity-row")).toHaveCount(0);
  await page.getByLabel("Visibility", { exact: true }).selectOption("active");
  await expect(historyRow(page, job.id)).toBeVisible();
  expect(store.management).toHaveLength(1);
  expect(store.posts).toHaveLength(0);
});

test("pending archive disables repeat mutation and failures leave the saved page link intact", async ({
  page,
}) => {
  const run = saved();
  const store = await fakeApi(page, [run]);
  store.holdMutation = true;
  await page.goto("/history");
  const row = historyRow(page, run.id);
  await row.getByRole("button", { name: /^Archive\b/ }).click();
  await expect.poll(() => store.releaseMutation !== null).toBe(true);
  await expect(
    row.getByRole("button", { name: /Archiving|Archive/i }),
  ).toBeDisabled();
  await expect(row.getByRole("button", { name: /^Delete\b/ })).toBeDisabled();
  expect(store.management).toHaveLength(1);
  store.failMutation = true;
  store.releaseMutation();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(row.getByRole("link")).toHaveAttribute(
    "href",
    "/runs/" + run.id,
  );
  expect(store.management).toHaveLength(1);
  expect(store.posts).toHaveLength(0);
});

test("a failed fresh run retains the previous successful records and history", async ({
  page,
}) => {
  const previous = saved();
  const store = await fakeApi(page, [previous]);
  store.failNext = true;
  await page.goto("/sources/amazon");
  await expect(page.getByRole("article")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Collect fresh data", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Previous successful results are retained",
  );
  await expect(
    page.getByRole("heading", { name: "Example Python Book" }),
  ).toBeVisible();
  await expect(page.getByText("private diagnostic do not display")).toHaveCount(
    0,
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Example Python Book" }),
  ).toBeVisible();
  await page.goto("/history?source=amazon");
  await expect(
    page.locator(".activity-row").filter({ hasText: "Failed" }),
  ).toContainText("0 records saved");
  await expect(
    page.locator(".activity-row").filter({ hasText: "Succeeded" }),
  ).toContainText("1 record in snapshot");
  expect(store.posts).toHaveLength(1);
});

test("running requests poll reads only and preserve prior records", async ({
  page,
}) => {
  const store = await fakeApi(page, [saved()]);
  store.hold = true;
  await page.goto("/sources/amazon");
  await page
    .getByRole("button", { name: "Collect fresh data", exact: true })
    .click();
  await expect(
    page.getByText(/Collection is running. This page checks saved status only/),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.reload();
  await expect(
    page.getByText(/Collection is running. This page checks saved status only/),
  ).toBeVisible();
  expect(store.posts).toHaveLength(1);
  store.hold = false;
  await expect(
    page.getByText("Saved successfully", { exact: true }),
  ).toBeVisible();
  expect(store.posts).toHaveLength(1);
});

test("previous-results failure does not stop a running saved request's GET polling", async ({
  page,
}) => {
  const running = saved("amazon", 2);
  running.status = "running";
  running.completedAt = null;
  running.collectedAt = null;
  running.resultCount = 0;
  running.data = null;
  const store = await fakeApi(page, [saved(), running]);
  store.enabled = false;
  store.hold = true;
  store.failLatest = true;
  await page.goto("/runs/" + running.id);
  await expect(
    page.getByText(/Collection is running. This page checks saved status only/),
  ).toBeVisible();
  await expect(
    page.getByText("Could not load previous successful results", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No previous successful results are available for this source.",
    ),
  ).toHaveCount(0);
  store.hold = false;
  await expect(
    page.getByText("Saved successfully", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(
    page.getByText("Could not load previous successful results", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    store.gets.filter((path) => path === "/api/runs/" + running.id).length,
  ).toBeGreaterThanOrEqual(2);
  expect(store.posts).toHaveLength(0);
});

test("pending submission disables collection and prevents a duplicate POST", async ({
  page,
}) => {
  const store = await fakeApi(page, [saved()]);
  store.holdPost = true;
  await page.goto("/sources/amazon");
  await page
    .getByRole("button", { name: "Collect fresh data", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Starting collection…", exact: true }),
  ).toBeDisabled();
  await page.locator("form").evaluate((form) => form.requestSubmit());
  expect(store.posts).toHaveLength(1);
  expect(store.releasePost).not.toBeNull();
  store.releasePost();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(
    page.getByText("Saved successfully", { exact: true }),
  ).toBeVisible();
  expect(store.posts).toHaveLength(1);
});

test("a lost POST response is recoverable without repeating collection", async ({
  page,
}) => {
  const store = await fakeApi(page, [saved()]);
  store.lostResponse = true;
  await page.goto("/sources/amazon");
  await page
    .getByRole("button", { name: "Collect fresh data", exact: true })
    .click();
  await expect(page.getByText("No automatic retry was made.")).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page
    .getByRole("link", { name: "Check this request’s saved run" })
    .click();
  await expect(
    page.getByText("Saved successfully", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(1);
  expect(store.posts).toHaveLength(1);
});

test("validation blocks bad inputs and disabled collection still allows saved reads", async ({
  page,
}) => {
  const store = await fakeApi(page);
  await page.goto("/sources/indeed");
  await page
    .getByRole("button", { name: "Collect fresh data", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("1–200");
  await expect(page.getByLabel("Job title or keyword")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByLabel("Job title or keyword")).toBeFocused();
  await page.goto("/sources/booking");
  await fillForm(page, "booking");
  await page.getByLabel("Check-out", { exact: true }).fill("2025-12-31");
  await page
    .getByRole("button", { name: "Collect fresh data", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("later than check-in");
  expect(store.posts).toHaveLength(0);
  store.enabled = false;
  store.runs.set(saved().id, saved());
  await page.goto("/sources/amazon");
  await expect(
    page.getByRole("button", { name: "Collect fresh data", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/Fresh collection is disabled/)).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);
  expect(store.posts).toHaveLength(0);
});

test("Booking validation identifies invalid whole-number and date inputs without a POST", async ({
  page,
}) => {
  const store = await fakeApi(page);
  await page.goto("/sources/booking");
  for (const [field, value] of [
    ["adults", "1.5"],
    ["adults", "9007199254740992"],
    ["rooms", "1.5"],
    ["checkin", "10000-01-01"],
    ["checkout", "10000-01-03"],
  ]) {
    await fillForm(page, "booking");
    const invalidInput = page.locator(`[name="${field}"]`);
    await invalidInput.fill(value);
    await page
      .getByRole("button", { name: "Collect fresh data", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      ["adults", "rooms"].includes(field)
        ? "positive whole numbers"
        : "valid check-in and check-out dates",
    );
    await expect(invalidInput).toHaveAttribute("aria-invalid", "true");
    await expect(invalidInput).toBeFocused();
    expect(store.posts).toHaveLength(0);
  }
});

test("unsafe saved records fail safely and missing runs are not recollected", async ({
  page,
}) => {
  const run = saved();
  const store = await fakeApi(page, [run]);
  store.corrupt = true;
  await page.goto("/runs/" + run.id);
  await expect(page.getByRole("alert")).toContainText("invalid saved data");
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByText("private diagnostic")).toHaveCount(0);
  store.corrupt = false;
  const hotel = saved("booking", 5);
  hotel.data[0].url = hotel.data[0].url.replace(
    "checkin=2026-01-01",
    "checkin=2026-01-02",
  );
  store.runs.set(hotel.id, hotel);
  await page.goto("/runs/" + hotel.id);
  await expect(page.getByRole("alert")).toContainText("invalid saved data");
  await expect(page.getByRole("article")).toHaveCount(0);
  await page.goto("/runs/00000000-0000-4000-8000-000000000099");
  await expect(page.getByRole("alert")).toContainText("not found");
  expect(store.posts).toHaveLength(0);
});

test("legacy provenance and nullable fields remain honest", async ({
  page,
}) => {
  const run = saved();
  run.id = "legacy-YW1hem9uOlB5dGhvbg";
  run.provenance = "legacy-cache";
  run.startedAt = null;
  run.completedAt = null;
  run.collectedAt = null;
  run.data[0].authors = [];
  run.data[0].price = null;
  const store = await fakeApi(page, [run]);
  await page.goto("/runs/" + run.id);
  await expect(
    page.getByText(/Original collection time unavailable/),
  ).toBeVisible();
  await expect(page.getByText("Author not listed")).toBeVisible();
  await expect(page.getByText("Price unavailable")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open saved run", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText(/Original collection time unavailable/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open saved run", exact: true }),
  ).toHaveCount(0);
  expect(store.posts).toHaveLength(0);
});

function visualRuns() {
  const book = saved(),
    hotel = saved("booking", 2),
    job = saved("indeed", 3),
    tiobe = saved("tiobe", 4),
    failed = saved("booking", 5),
    legacy = saved("amazon", 6),
    running = saved("indeed", 7);
  book.data = Array.from({ length: 4 }, (_, index) => ({
    ...book.data[0],
    title:
      index === 0
        ? "Example book with a long descriptive title that wraps naturally across the available card width"
        : "Synthetic practical programming volume " + (index + 1),
    url: "https://www.amazon.com/dp/B00000000" + (index + 1),
    authors: index === 1 ? [] : ["Example Author", "Another Example Author"],
    rating: index === 0 ? "4.7 out of 5 stars" : null,
    reviews: index === 0 ? "1,284 ratings" : null,
    price: index === 1 ? null : book.data[0].price,
  }));
  hotel.data = Array.from({ length: 3 }, (_, index) => ({
    ...hotel.data[0],
    name:
      index === 0
        ? "Synthetic riverside hotel with a long property name and neighbourhood"
        : "Synthetic city hotel " + (index + 1),
    url: hotel.data[0].url.replace(
      "example.html",
      "example-" + index + ".html",
    ),
    price: index === 1 ? null : hotel.data[0].price,
    currency: index === 1 ? null : "GBP",
    rating: index === 0 ? "8.9" : null,
    reviewCount: index === 2 ? null : hotel.data[0].reviewCount,
    location: index === 2 ? null : "Central London \u00b7 near the river",
  }));
  job.data = Array.from({ length: 3 }, (_, index) => ({
    ...job.data[0],
    jobId: "0123456789abcde" + index,
    url: "https://www.indeed.com/viewjob?jk=0123456789abcde" + index,
    title:
      index === 0
        ? "Synthetic senior developer, data collection and platform integrations"
        : "Synthetic software developer " + (index + 1),
    company: "Example Technology and Research Company",
    location: index === 1 ? "Remote \u00b7 United Kingdom" : "London",
  }));
  for (const run of [book, hotel, job]) run.resultCount = run.data.length;
  failed.status = "failed";
  failed.data = null;
  failed.resultCount = 0;
  failed.collectedAt = null;
  failed.error = { code: "UPSTREAM_FAILURE", message: "Synthetic failure" };
  legacy.id = "legacy-YW1hem9uOlB5dGhvbg";
  legacy.provenance = "legacy-cache";
  legacy.startedAt = null;
  legacy.completedAt = null;
  legacy.collectedAt = null;
  legacy.data = structuredClone(book.data);
  legacy.resultCount = legacy.data.length;
  running.status = "running";
  running.completedAt = null;
  running.collectedAt = null;
  running.data = null;
  running.resultCount = 0;
  return [book, hotel, job, tiobe, failed, legacy, running];
}

test("synthetic workspace is readable at each viewport", async ({
  page,
}, testInfo) => {
  const runs = visualRuns();
  const store = await fakeApi(page, runs);
  store.enabled = false;
  store.hold = true;
  const paths = [
    ["overview", "/"],
    ...Object.keys(names).map((source) => [source, "/sources/" + source]),
    ["history", "/history"],
    ["run", "/runs/" + runs[0].id],
  ];
  for (const [name, path] of paths) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(
      page.getByText("Fresh collection paused", { exact: true }),
    ).toBeVisible();
    if (name === "overview")
      await expect(
        page
          .getByRole("region", { name: "Recent runs" })
          .locator(".activity-row"),
      ).toHaveCount(5);
    else if (name === "history")
      await expect(page.locator(".history-list .activity-row")).toHaveCount(
        runs.length,
      );
    else if (name === "run")
      await expect(page.getByRole("article")).toHaveCount(4);
    else
      await expect(
        page.getByRole("heading", { name: "Latest saved results" }),
      ).toBeVisible();
    await noOverflow(page);
    await page.screenshot({
      path:
        "artifacts/webby-ui/" +
        testInfo.project.name +
        "-" +
        name +
        "-synthetic.png",
      fullPage: true,
      animations: "disabled",
    });
  }
  expect(store.posts).toHaveLength(0);
});

test("Overview shows four descriptive collectors and only five recent snapshots", async ({
  page,
}) => {
  const store = await fakeApi(page, visualRuns());
  store.enabled = false;
  store.hold = true;
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  for (const source of Object.keys(names)) {
    const entry = page.getByRole("link", {
      name: "Open " + names[source] + " collector",
      exact: true,
    });
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute("href", "/sources/" + source);
    expect((await entry.textContent()).trim().length).toBeGreaterThan(
      names[source].length + 5,
    );
  }
  const recent = page.getByRole("region", { name: "Recent runs" });
  await expect(recent.locator(".activity-row")).toHaveCount(5);
  await expect(recent.getByText("Failed", { exact: true })).toBeVisible();
  await expect(recent.getByText("Running", { exact: true })).toBeVisible();
  await expect(
    recent.getByText(/original collection time unavailable/i),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View all history", exact: true }),
  ).toHaveAttribute("href", "/history");
  await expect(
    page.getByText("Fresh collection paused", { exact: true }),
  ).toBeVisible();
  expect(store.gets.some((path) => path.startsWith("/api/runs?"))).toBe(true);
  expect(store.gets.some((path) => path.startsWith("/api/runs/latest"))).toBe(
    false,
  );
  expect(store.gets.some((path) => /^\/api\/runs\/[^?]/.test(path))).toBe(
    false,
  );
  await page.reload();
  await expect(recent.locator(".activity-row")).toHaveCount(5);
  expect(store.posts).toHaveLength(0);
});

test("Overview loading does not hide independently available collection status", async ({
  page,
}) => {
  const store = await fakeApi(page, [saved()]);
  store.holdHistory = true;
  await page.goto("/");
  await expect(
    page.getByText("Loading recent runs\u2026", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Fresh collection available", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => store.releaseHistory !== null).toBe(true);
  store.releaseHistory();
  await expect(
    page.getByRole("region", { name: "Recent runs" }).locator(".activity-row"),
  ).toHaveCount(1);
  expect(store.posts).toHaveLength(0);
});

test("Overview history stays usable when availability is delayed or fails", async ({
  page,
}) => {
  const store = await fakeApi(page, [saved()]);
  store.holdHealth = true;
  store.failHealth = true;
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Recent runs" }).locator(".activity-row"),
  ).toHaveCount(1);
  await expect.poll(() => store.releaseHealth !== null).toBe(true);
  store.releaseHealth();
  await expect(page.getByText(/Collection status unavailable/i)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Amazon \u00b7 Python", exact: true }),
  ).toBeVisible();
  expect(store.posts).toHaveLength(0);
});

test("Overview history errors and empty results stay distinct", async ({
  page,
}) => {
  const store = await fakeApi(page);
  store.failHistory = true;
  store.enabled = false;
  await page.goto("/");
  await expect(
    page.getByText("Could not load recent runs", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Fresh collection paused", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/No saved runs yet/)).toHaveCount(0);
  store.failHistory = false;
  await page.reload();
  await expect(page.getByText(/No saved runs yet/)).toBeVisible();
  await expect(
    page.getByText("Could not load recent runs", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Recent runs" }).locator(".activity-row"),
  ).toHaveCount(0);
  expect(store.posts).toHaveLength(0);
});

test("Overview preserves unavailable legacy timestamps without inventing collection times", async ({
  page,
}) => {
  const legacy = saved();
  legacy.id = "legacy-YW1hem9uOlB5dGhvbg";
  legacy.provenance = "legacy-cache";
  for (const field of [
    "createdAt",
    "startedAt",
    "completedAt",
    "collectedAt",
    "savedAt",
  ])
    legacy[field] = null;
  const store = await fakeApi(page, [legacy]);
  await page.goto("/");
  const recent = page.getByRole("region", { name: "Recent runs" });
  await expect(recent.locator(".activity-row")).toHaveCount(1);
  await expect(
    recent.getByText(/original collection time unavailable/i),
  ).toBeVisible();
  await expect(recent.getByText(/unavailable/i).first()).toBeVisible();
  await expect(recent.locator("time")).toHaveCount(0);
  expect(store.posts).toHaveLength(0);
});

test("Webby metadata, decorative identity and route context are consistent", async ({
  page,
}) => {
  const run = saved();
  const store = await fakeApi(page, [run]);
  for (const [path, title] of [
    ["/", "Overview"],
    ...Object.entries(names).map(([source, name]) => [
      "/sources/" + source,
      name,
    ]),
    ["/history", "Collection history"],
    ["/runs/" + run.id, "Saved run"],
    ["/not-a-page", "Page not found"],
  ]) {
    await page.goto(path);
    await expect(page).toHaveTitle(title + " | Webby");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator("head title")).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(
      page.getByRole("heading", { name: "Web Scraper", exact: true }),
    ).toHaveCount(0);
    await noOverflow(page);
  }
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveCount(1);
  await expect(icon).toHaveAttribute("href", /\.svg$/);
  const asset = await page.evaluate(async () => {
    const icon = document.querySelector('link[rel="icon"]');
    const response = await fetch(icon.href);
    return {
      ok: response.ok,
      type: response.headers.get("content-type"),
      text: await response.text(),
    };
  });
  expect(asset.ok).toBe(true);
  expect(asset.type).toContain("svg");
  expect(asset.text).toContain("<svg");
  expect(asset.text).not.toMatch(/<script|(?:href|src)=["']https?:\/\//i);
  expect(store.posts).toHaveLength(0);
});

test("responsive drawer traps focus and restores the trigger on Escape, close and backdrop", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.use.viewport.width >= 992,
    "Persistent desktop navigation has no modal drawer.",
  );
  const store = await fakeApi(page);
  await page.goto("/");
  const toggle = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  const drawer = page.getByRole("dialog", {
    name: "Webby navigation",
    exact: true,
  });
  await toggle.click();
  await expect(drawer).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // Bootstrap activates its focus trap after the entrance transition.
  await expect(drawer).toHaveClass(/(?:^|\s)show(?:\s|$)/);
  await expect
    .poll(() =>
      drawer.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    expect(
      await drawer.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(
    await drawer.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await toggle.click();
  await drawer
    .getByRole("button", { name: "Close navigation", exact: true })
    .click();
  await expect(drawer).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.click();
  const box = await page.locator("#workspace-navigation").boundingBox();
  await page.mouse.click(
    Math.min(box.x + box.width + 24, testInfo.project.use.viewport.width - 8),
    120,
  );
  await expect(drawer).toBeHidden();
  await expect(toggle).toBeFocused();
  expect(store.posts).toHaveLength(0);
});

test("drawer selection and resizing leave usable page focus and no modal residue", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.use.viewport.width >= 992,
    "This exercises the small-screen to desktop boundary.",
  );
  const store = await fakeApi(page);
  await page.goto("/");
  const toggle = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  await toggle.click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Amazon", exact: true })
    .click();
  await expect(page).toHaveURL(/\/sources\/amazon$/);
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page.locator(".offcanvas-backdrop")).toHaveCount(0);
  await toggle.click();
  await expect(
    page.getByRole("dialog", { name: "Webby navigation" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".offcanvas-backdrop")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation")
      .getByRole("link", { name: "Amazon", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  expect(
    await page
      .locator("body")
      .evaluate((element) => getComputedStyle(element).overflow),
  ).not.toBe("hidden");
  await noOverflow(page);
  expect(store.posts).toHaveLength(0);
});

test("bee greeting, hover and keyboard focus are finite within a fixed footprint", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    window.__webbyBeeStarts = [];
    document.addEventListener("animationstart", (event) => {
      if (event.target.closest?.(".brand-bee"))
        window.__webbyBeeStarts.push(event.animationName);
    });
  });
  await fakeApi(page);
  await page.goto("/");
  const brand = page.locator(".brand-link:visible");
  const bee = brand.locator(".brand-bee");
  const walk = bee.locator(".bee-walk");
  await expect(bee).toHaveAttribute("aria-hidden", "true");
  await expect(bee).toHaveAttribute("focusable", "false");
  const box = await bee.boundingBox();
  expect(box.width).toBe(36);
  expect(box.height).toBe(36);
  await expect
    .poll(() => page.evaluate(() => window.__webbyBeeStarts.length))
    .toBeGreaterThan(0);
  // The initial greeting ends instead of leaving a background animation running.
  await expect(bee).not.toHaveClass(/is-walking/);
  await expect
    .poll(() =>
      walk.evaluate(
        (element) =>
          element
            .getAnimations()
            .filter((animation) => animation.playState === "running").length,
      ),
    )
    .toBe(0);
  const footprint = await brand.boundingBox();
  await brand.hover();
  await expect(bee).toHaveClass(/is-walking/);
  const motion = await walk.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      name: style.animationName,
      duration: parseFloat(style.animationDuration),
      iterations: style.animationIterationCount,
    };
  });
  expect(motion.name).not.toBe("none");
  expect(motion.duration).toBeGreaterThan(0);
  expect(motion.duration).toBeLessThanOrEqual(1);
  expect(motion.iterations).toBe("1");
  await expect(bee).not.toHaveClass(/is-walking/);
  await expect
    .poll(() =>
      walk.evaluate(
        (element) =>
          element
            .getAnimations()
            .filter((animation) => animation.playState === "running").length,
      ),
    )
    .toBe(0);
  await page.mouse.move(0, 0);
  await page.locator("#main-content").focus();
  await brand.focus();
  await expect(bee).toHaveClass(/is-walking/);
  await expect(bee).not.toHaveClass(/is-walking/);
  const after = await brand.boundingBox();
  expect(after).toEqual(footprint);
  const afterBee = await bee.boundingBox();
  expect(afterBee.width).toBe(box.width);
  expect(afterBee.height).toBe(box.height);
});

test("reduced motion keeps the bee static for greeting and interaction", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fakeApi(page);
  await page.goto("/");
  const brand = page.locator(".brand-link:visible");
  const groups = brand.locator(".bee-walk, .bee-leg-front, .bee-leg-back");
  const animations = () =>
    groups.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).animationName),
    );
  await expect.poll(animations).toEqual(["none", "none", "none"]);
  await expect(brand.locator(".brand-bee")).not.toHaveClass(/is-walking/);
  await brand.hover();
  await brand.focus();
  await expect.poll(animations).toEqual(["none", "none", "none"]);
  expect(
    await groups.evaluateAll(
      (elements) =>
        elements.flatMap((element) => element.getAnimations()).length,
    ),
  ).toBe(0);
});
