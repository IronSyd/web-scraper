/* global document, Image, XMLSerializer */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleSha256 =
  "a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f";
const args = process.argv.slice(2);
const check = args.includes("--check");
const bundleIndex = args.indexOf("--bundle");
if (
  bundleIndex < 0 ||
  !args[bundleIndex + 1] ||
  args.some(
    (arg, index) =>
      arg !== "--check" && index !== bundleIndex && index !== bundleIndex + 1,
  )
) {
  throw new Error(
    "Usage: node scripts/render-diagrams.mjs --bundle <mermaid.min.js> [--check]",
  );
}
const bundle = await readFile(path.resolve(root, args[bundleIndex + 1]));
assert.equal(
  sha256(bundle),
  bundleSha256,
  "Expected the pinned Mermaid 12.2.0 bundle",
);
const config = JSON.parse(
  await readFile(path.join(root, "docs/diagrams/mermaid-config.json"), "utf8"),
);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(
  root,
  ".cache/ms-playwright",
);
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1800, height: 1600 },
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
});
const networkAttempts = [];
await context.route("**/*", async (route) => {
  networkAttempts.push(route.request().url());
  await route.abort();
});
const report = {
  renderer: "mermaid@12.2.0",
  bundleSha256,
  chromium: browser.version(),
  mode: check ? "check" : "render",
  diagrams: [],
};
try {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.setContent(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local diagram rendering</title></head><body style="margin:0;background:white"></body></html>',
  );
  await page.addScriptTag({ content: bundle.toString("utf8") });
  await page.evaluate(
    (settings) => globalThis.mermaid.initialize(settings),
    config,
  );
  for (const [name, nodes, edges] of [
    ["collection-flow", 6, 5],
    ["architecture", 11, 17],
  ]) {
    const source = await readFile(
      path.join(root, `docs/diagrams/${name}.mmd`),
      "utf8",
    );
    const rendered = await page.evaluate(
      async ({ name, source, nodes, edges }) => {
        await globalThis.mermaid.parse(source);
        const { svg: markup } = await globalThis.mermaid.render(
          `web-scraper-${name}`,
          source,
        );
        document.body.innerHTML = markup;
        await document.fonts.ready;
        const svg = document.querySelector("svg");
        const box = svg.viewBox.baseVal;
        const width = Math.ceil(box.width);
        const height = Math.ceil(box.height);
        svg.setAttribute("width", String(width));
        svg.setAttribute("height", String(height));
        svg.style.backgroundColor = "#FFFFFF";
        const background = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "rect",
        );
        for (const [key, value] of Object.entries({
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          fill: "#FFFFFF",
        }))
          background.setAttribute(key, String(value));
        svg.insertBefore(background, svg.querySelector("g"));
        const fail = (message) => {
          throw new Error(`${name}: ${message}`);
        };
        if (svg.querySelectorAll(".node").length !== nodes)
          fail("node count changed");
        if (svg.querySelectorAll(".edgePaths .flowchart-link").length !== edges)
          fail("edge count changed");
        if (
          !svg.querySelector("title")?.textContent ||
          !svg.querySelector("desc")?.textContent
        )
          fail("missing accessible title/description");
        if (
          !svg.getAttribute("aria-labelledby") ||
          !svg.getAttribute("aria-describedby")
        )
          fail("missing accessible references");
        if (
          svg.querySelector(
            "script, foreignObject, image, a, iframe, animate, set",
          )
        )
          fail("active/HTML/external-capable SVG content");
        const ids = new Set(
          [...svg.querySelectorAll("[id]")].map((node) => node.id),
        );
        ids.add(svg.id);
        const checkReferences = (value) => {
          for (const match of value.matchAll(/url\(["']?([^)'"\s]+)["']?\)/g)) {
            if (!match[1].startsWith("#") || !ids.has(match[1].slice(1)))
              fail("nonlocal paint reference");
          }
        };
        for (const element of [svg, ...svg.querySelectorAll("*")]) {
          for (const attribute of element.attributes) {
            if (/^on/i.test(attribute.name)) fail("event handler");
            if (
              /href$/i.test(attribute.name) &&
              !attribute.value.startsWith("#")
            )
              fail("external reference");
            checkReferences(attribute.value);
          }
        }
        for (const style of svg.querySelectorAll("style")) {
          if (/@import/i.test(style.textContent))
            fail("stylesheet resource reference");
          checkReferences(style.textContent);
        }
        const svgBounds = svg.getBoundingClientRect();
        for (const text of svg.querySelectorAll("text")) {
          const bounds = text.getBoundingClientRect();
          if (
            bounds.width <= 0 ||
            bounds.height <= 0 ||
            bounds.left < svgBounds.left - 1 ||
            bounds.top < svgBounds.top - 1 ||
            bounds.right > svgBounds.right + 1 ||
            bounds.bottom > svgBounds.bottom + 1
          )
            fail("empty/clipped text geometry");
        }
        const labels = [...svg.querySelectorAll(".node")].map((node) =>
          [...node.querySelectorAll(".text-outer-tspan")]
            .map((line) => line.textContent.trim())
            .join(" "),
        );
        if (labels.length !== nodes || labels.some((label) => !label))
          fail("missing node label");
        const data = new XMLSerializer().serializeToString(svg);
        const image = new Image();
        image.alt = svg.querySelector("title").textContent;
        image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(data)))}`;
        document.body.replaceChildren(image);
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight)
          fail("SVG image decoding failed");
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const drawing = canvas.getContext("2d");
        drawing.drawImage(image, 0, 0);
        const pixels = drawing.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        for (let alpha = 3; alpha < pixels.length; alpha += 4) {
          if (pixels[alpha] !== 255) fail("nonopaque SVG background");
        }
        return {
          svg: data + "\n",
          width,
          height,
          nodes,
          edges,
          labels,
          title: svg.querySelector("title").textContent,
          description: svg.querySelector("desc").textContent,
          svgSafety: "passed",
          textBounds: "passed",
          svgImageDecoded: true,
          opaqueBackground: true,
        };
      },
      { name, source, nodes, edges },
    );
    const svg = Buffer.from(rendered.svg);
    const png = await page
      .locator("img")
      .screenshot({ animations: "disabled" });
    for (const [extension, contents] of [
      ["svg", svg],
      ["png", png],
    ]) {
      const target = path.join(root, `docs/images/${name}.${extension}`);
      if (check)
        assert.deepEqual(
          contents,
          await readFile(target),
          `${name}.${extension} needs regeneration`,
        );
      else await writeFile(target, contents);
    }
    const details = { ...rendered };
    delete details.svg;
    report.diagrams.push({
      name,
      sourceSha256: sha256(source),
      svgSha256: sha256(svg),
      pngSha256: sha256(png),
      ...details,
    });
  }
  assert.equal(
    networkAttempts.length,
    0,
    "Rendering attempted a network request",
  );
  report.networkAttempts = networkAttempts.length;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
