import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import test from "node:test";
import { PRINT_CSS, preservedPrint, printSnapshot } from "./page-contract.js";

const ROOT = resolve(import.meta.dirname, "../..");
const PYTHON =
  process.env.WSP_PDF_PYTHON_EXE ??
  resolve(
    ROOT,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
assert.ok(
  isAbsolute(PYTHON) && existsSync(PYTHON) && statSync(PYTHON).isFile(),
  "PDF verification requires the project virtual environment or an existing absolute WSP_PDF_PYTHON_EXE executable.",
);
const OUTPUT = resolve(ROOT, "artifacts/tiobe-print-offline");
const label = process.env.WSP_PRINT_FIXTURE_LABEL ?? "latest";
assert.match(label, /^(?:red|green|confirmation|latest)$/u);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(ROOT, ".cache/ms-playwright");
const { chromium } = await import("playwright");

const icon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Ccircle cx='10' cy='10' r='8' fill='%23287ac8'/%3E%3C/svg%3E";
const rows = (prefix) =>
  Array.from(
    { length: 4 },
    (_, index) =>
      `<tr><td><span>${prefix}_${index + 1}_START</span><span class="row-end">${prefix}_${index + 1}_END</span></td><td>Complete row ${index + 1}</td></tr>`,
  ).join("");

/** Synthetic fixture models observed failure classes, not inaccessible theme CSS. */
export const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic TIOBE print regression</title><style>
html,body{margin:0;font:16px Arial,sans-serif;color:#17212a;background:#f2f7fb}
body.kleine-golf::before{content:"";position:absolute;top:0;left:10%;width:90%;height:260px;background:#287ac8;border-radius:0 0 0 60%;z-index:100}
header,nav.responsive-nav{height:80px} .tiobe-index.container{width:1400px;max-width:96%;margin:auto}
article.content{overflow:auto} h1{font-size:34px}h2{font-size:24px;margin:24px 0 12px}p{line-height:1.5}
table{width:100%;border-spacing:0;border-radius:10px;overflow:hidden}th{background:#287ac8;color:white;padding:8px;text-align:left}
td{padding:8px;vertical-align:top}tr:nth-child(even){background:#dfebf5}#top20 td{height:20px}#top20 img{width:20px;height:20px}
#otherPL td,#VLTH td,#PLHoF td{height:205px}.row-end{display:block;margin-top:150px}
#container{width:100%;height:450px;margin:12px 0}.faq-blok,.cta-blok,footer{padding:20px}
#container svg{width:100%;height:450px;background:white} .faq-blok svg{width:12px;height:12px}
</style></head><body class="page-template-page-index wp-theme-tiobe kleine-golf">
<header>Known site header</header><section class="website-content"><div class="tiobe-index container"><article class="content">
<h1>TIOBE Index - synthetic offline fixture</h1><p>HEADLINE_PRESERVED. This self-contained fixture exercises print layout without target requests.</p>
<table id="top20" class="table-top20"><thead><tr><th>Rank</th><th>Last</th><th>Change</th><th>Icon</th><th>Language</th><th>Rating</th></tr></thead><tbody>${Array.from({ length: 20 }, (_, index) => `<tr><td>${index + 1}</td><td>${index + 1}</td><td>0</td><td><img src="${icon}" alt="Language icon ${index + 1}"></td><td>Language ${index + 1}</td><td>1.00%</td></tr>`).join("")}</tbody></table>
<div id="container"><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Meaningful chart" viewBox="0 0 1400 450"><text x="30" y="25">CHART_TOP_SENTINEL</text><path d="M30 400L250 200L500 280L800 100L1350 80" fill="none" stroke="#287ac8" stroke-width="5"/><text x="30" y="435">CHART_BOTTOM_SENTINEL</text></svg></div>
<h2>Other programming languages</h2><table id="otherPL"><thead><tr><th>OTHER_REPEAT_HEADER</th><th>Values</th></tr></thead><tbody>${rows("OTHER")}</tbody></table>
<h2>Very Long Term History</h2><table id="VLTH"><thead><tr><th>HISTORY_REPEAT_HEADER</th><th>Values</th></tr></thead><tbody>${rows("HISTORY")}</tbody></table>
<h2>Programming Language Hall of Fame</h2><table id="PLHoF"><thead><tr><th>AWARD_REPEAT_HEADER</th><th>Values</th></tr></thead><tbody>${rows("AWARD")}</tbody></table>
<div class="faq-blok"><h2>FAQ_PRESERVED</h2><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><path d="M6 0V12M0 6H12" stroke="black"/></svg><p>Visible answer remains present.</p></div>
</article><div class="cta-blok"><h2>CTA_PRESERVED</h2><img src="${icon}" alt="Meaningful CTA illustration"><p>Request your proof of concept.</p></div></div></section>
<nav class="responsive-nav">Known responsive site navigation</nav><footer>FOOTER_PRESERVED <img src="${icon}" alt="Meaningful footer logo"></footer></body></html>`;

async function offlinePage() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ offline: true });
  const externalRequests = [];
  await context.route("**/*", async (route) => {
    if (route.request().url() === "https://wsp-fixture.invalid/print")
      await route.fulfill({ contentType: "text/html", body: fixture });
    else {
      externalRequests.push(route.request().url());
      await route.abort("blockedbyclient");
    }
  });
  const page = await context.newPage();
  await page.goto("https://wsp-fixture.invalid/print");
  await page.waitForFunction(() =>
    [...globalThis.document.images].every(
      (image) => image.complete && image.naturalWidth,
    ),
  );
  return { browser, page, externalRequests };
}

test("offline print preserves source, suppresses empty decoration and keeps PDF rows/chart complete", async () => {
  const { browser, page, externalRequests } = await offlinePage();
  try {
    await page.emulateMedia({ media: "print" });
    const before = await page.evaluate(printSnapshot);
    const graphicsBefore = await page
      .locator("img,svg")
      .evaluateAll((nodes) => nodes.map((node) => node.outerHTML));
    await page.addStyleTag({ content: PRINT_CSS });
    const after = await page.evaluate(printSnapshot);
    const geometry = await page.evaluate(() => ({
      waveDisplay: globalThis.getComputedStyle(
        globalThis.document.body,
        "::before",
      ).display,
      rows: [...globalThis.document.querySelectorAll("article.content tr")].map(
        (row) => globalThis.getComputedStyle(row).breakInside,
      ),
      chartBreak: globalThis.getComputedStyle(
        globalThis.document.querySelector("#container"),
      ).breakInside,
      headerDisplay: globalThis.getComputedStyle(
        globalThis.document.querySelector("#VLTH thead"),
      ).display,
    }));
    const graphicsAfter = await page
      .locator("img,svg")
      .evaluateAll((nodes) => nodes.map((node) => node.outerHTML));
    await mkdir(OUTPUT, { recursive: true });
    const pdfPath = resolve(OUTPUT, `${label}.pdf`);
    const { TIOBE_PDF_OPTIONS } = await import("./pdf.js");
    await page.pdf({
      ...(TIOBE_PDF_OPTIONS ?? {
        format: "A3",
        landscape: true,
        printBackground: true,
      }),
      path: pdfPath,
    });
    const review = spawnSync(
      PYTHON,
      [resolve(import.meta.dirname, "verify-print-fixture.py"), pdfPath],
      { encoding: "utf8", timeout: 60_000, windowsHide: true },
    );
    if (review.error)
      throw new Error("Could not run the PDF fixture verifier.", {
        cause: review.error,
      });
    await writeFile(
      resolve(OUTPUT, `${label}.json`),
      JSON.stringify(
        {
          synthetic: true,
          externalRequests,
          before,
          after,
          geometry,
          pdfReview: JSON.parse(review.stdout || "{}"),
        },
        null,
        2,
      ),
    );
    assert.equal(review.status, 0, review.stdout || review.stderr);
    assert.equal(geometry.waveDisplay, "none");
    assert.ok(geometry.rows.every((value) => value === "avoid"));
    assert.equal(geometry.chartBreak, "avoid");
    assert.equal(geometry.headerDisplay, "table-header-group");
    assert.equal(preservedPrint(before, after), true);
    assert.deepEqual(graphicsAfter, graphicsBefore);
    assert.deepEqual(externalRequests, []);
    await page.emulateMedia({ media: "screen" });
    assert.notEqual(
      await page.evaluate(
        () =>
          globalThis.getComputedStyle(globalThis.document.body, "::before")
            .display,
      ),
      "none",
    );
    assert.equal(
      await page
        .locator("article.content")
        .evaluate((node) => globalThis.getComputedStyle(node).overflow),
      "auto",
    );
    assert.equal(
      await page
        .locator("#VLTH tr")
        .first()
        .evaluate((node) => globalThis.getComputedStyle(node).breakInside),
      "auto",
    );
  } finally {
    await browser.close();
  }
});

test("offline source guard rejects nonempty generated wrapper content before it can be hidden", async () => {
  const { browser, page, externalRequests } = await offlinePage();
  try {
    await page.emulateMedia({ media: "print" });
    for (const selector of [
      "body.kleine-golf",
      "section.website-content",
      ".tiobe-index.container",
      "article.content",
    ]) {
      const style = await page.addStyleTag({
        content: `${selector}::before{content:"Meaningful generated source"}`,
      });
      assert.equal(
        (await page.evaluate(printSnapshot)).sourceValid,
        false,
        selector,
      );
      await style.evaluate((node) => node.remove());
    }
    for (const content of [
      'url("data:image/svg+xml,%3Csvg/%3E")',
      "counter(source-content)",
    ]) {
      const style = await page.addStyleTag({
        content: `body.kleine-golf::after{content:${content}}`,
      });
      assert.equal(
        (await page.evaluate(printSnapshot)).sourceValid,
        false,
        content,
      );
      await style.evaluate((node) => node.remove());
    }
    assert.deepEqual(externalRequests, []);
  } finally {
    await browser.close();
  }
});

test("offline source guard rejects unexpected wrapper and protected graphic hiding", async () => {
  const { browser, page, externalRequests } = await offlinePage();
  try {
    await page.emulateMedia({ media: "print" });
    const before = await page.evaluate(printSnapshot);
    await page.addStyleTag({ content: PRINT_CSS });
    await page.locator("#container svg").evaluate((node) => {
      node.style.display = "none";
    });
    assert.equal(
      preservedPrint(before, await page.evaluate(printSnapshot)),
      false,
    );
    await page.locator(".tiobe-index.container").evaluate((node) => {
      node.classList.remove("tiobe-index");
    });
    assert.equal((await page.evaluate(printSnapshot)).sourceValid, false);
    assert.deepEqual(externalRequests, []);
  } finally {
    await browser.close();
  }
});

test("offline source guard rejects unknown page identity and missing ranking data", async () => {
  const { browser, page, externalRequests } = await offlinePage();
  try {
    await page.emulateMedia({ media: "print" });
    await page
      .locator("body")
      .evaluate((node) => node.classList.remove("kleine-golf"));
    assert.equal((await page.evaluate(printSnapshot)).sourceValid, false);
    await page
      .locator("body")
      .evaluate((node) => node.classList.add("kleine-golf"));
    await page
      .locator("#top20 tbody tr")
      .last()
      .evaluate((node) => node.remove());
    assert.equal((await page.evaluate(printSnapshot)).rankingValid, false);
    assert.deepEqual(externalRequests, []);
  } finally {
    await browser.close();
  }
});
