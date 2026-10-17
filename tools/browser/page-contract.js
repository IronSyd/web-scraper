/**
 * @typedef {{hasResponse?: unknown, declined?: unknown, consent?: {necessary?: unknown, preferences?: unknown, statistics?: unknown, marketing?: unknown}}} CookiebotState
 * @typedef {{known: boolean, responded: boolean, denied: boolean, dialogs: number, dialogVisible: boolean}} ConsentState
 */

export const PRINT_CSS = `@media print {
  body > header, body > nav.responsive-nav, #CookiebotWidget {
    display: none !important;
  }
  body.kleine-golf::before, body.kleine-golf::after,
  body > section.website-content::before, body > section.website-content::after,
  body > section.website-content > .tiobe-index.container::before,
  body > section.website-content > .tiobe-index.container::after,
  body > section.website-content > .tiobe-index.container > article.content::before,
  body > section.website-content > .tiobe-index.container > article.content::after {
    display: none !important;
  }
  html, body.kleine-golf, body > section.website-content,
  body > section.website-content > .tiobe-index.container,
  body > section.website-content > .tiobe-index.container > article.content {
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    max-width: 100% !important;
    overflow: visible !important;
  }
  body > section.website-content article.content table {
    overflow: visible !important;
  }
  body > section.website-content article.content thead {
    display: table-header-group !important;
  }
  body > section.website-content article.content tr,
  body > section.website-content article.content #container {
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }
  body > section.website-content article.content h1,
  body > section.website-content article.content h2,
  body > section.website-content article.content h3 {
    break-after: avoid !important;
    page-break-after: avoid !important;
  }
}`;

/** Browser-side function; keep its runtime dependencies self-contained. */
export function tiobeReady() {
  const rows = [
    ...globalThis.document.querySelectorAll("table#top20.table-top20 tbody tr"),
  ];
  return (
    rows.length === 20 &&
    rows.every((row, index) => {
      const cells = row.querySelectorAll("td");
      return (
        cells[0]?.textContent?.trim() === String(index + 1) &&
        Boolean(cells[4]?.textContent?.trim())
      );
    })
  );
}

/** Browser-side function; marker presence is not a bot-detection score. */
export function sannysoftReady() {
  return (
    Boolean(
      globalThis.document
        .querySelector("#user-agent-result")
        ?.textContent?.trim(),
    ) &&
    Boolean(
      globalThis.document
        .querySelector("#webdriver-result")
        ?.textContent?.trim(),
    ) &&
    globalThis.document.querySelectorAll("table#fp2 tr").length > 0
  );
}

/** @returns {ConsentState} */
export function consentSnapshot() {
  const bot = /** @type {Window & {Cookiebot?: CookiebotState}} */ (
    globalThis.window
  ).Cookiebot;
  const dialogs = [
    ...globalThis.document.querySelectorAll("#CybotCookiebotDialog"),
  ];
  const dialog = dialogs[0];
  const style = dialog ? globalThis.getComputedStyle(dialog) : null;
  const rect = dialog?.getBoundingClientRect();
  const visible = Boolean(
    style &&
    rect &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    rect.width > 0 &&
    rect.height > 0,
  );
  return {
    known: Boolean(
      bot &&
      [
        bot.hasResponse,
        bot.declined,
        bot.consent?.necessary,
        bot.consent?.preferences,
        bot.consent?.statistics,
        bot.consent?.marketing,
      ].every((value) => typeof value === "boolean"),
    ),
    responded: bot?.hasResponse === true,
    denied:
      bot?.hasResponse === true &&
      bot.declined === true &&
      bot.consent?.necessary === true &&
      bot.consent?.preferences === false &&
      bot.consent?.statistics === false &&
      bot.consent?.marketing === false,
    dialogs: dialogs.length,
    dialogVisible: visible,
  };
}

/** @param {ConsentState} state @returns {'ready'|'deny'|'stop'} */
export function consentAction(state) {
  if (!state.known || state.dialogs > 1) return "stop";
  if (state.responded)
    return state.denied && !state.dialogVisible ? "ready" : "stop";
  return state.dialogs === 1 && state.dialogVisible ? "deny" : "stop";
}

/** Browser-side snapshot: retain only bounded public names and source fingerprints. */
export async function printSnapshot() {
  const sections = [
    ...globalThis.document.querySelectorAll("body > section.website-content"),
  ];
  const articles =
    sections.length === 1
      ? [...sections[0].querySelectorAll("article.content")]
      : [];
  const containers =
    sections.length === 1
      ? [...sections[0].querySelectorAll(":scope > .tiobe-index.container")]
      : [];
  const tables =
    articles.length === 1
      ? [...articles[0].querySelectorAll("table#top20.table-top20")]
      : [];
  const footers = [...globalThis.document.querySelectorAll("body > footer")];
  const headers = [...globalThis.document.querySelectorAll("body > header")];
  const navs = [
    ...globalThis.document.querySelectorAll("body > nav.responsive-nav"),
  ];
  const widgets = [...globalThis.document.querySelectorAll("#CookiebotWidget")];
  const consentNodes = [
    ...globalThis.document.querySelectorAll('[id^="CybotCookiebotDialog"]'),
  ];
  const protectedNodes = [...sections, ...articles, ...tables, ...footers];
  const wrappers = [
    globalThis.document.body,
    ...sections,
    ...containers,
    ...articles,
  ];
  // Only empty generated decoration may be suppressed. Text, URLs and counters
  // are source content; do not guess whether they are safe to discard.
  const pseudoStyles = wrappers.flatMap((node) =>
    ["::before", "::after"].map((pseudo) =>
      globalThis.getComputedStyle(node, pseudo),
    ),
  );
  const decorationSafe = pseudoStyles.every((style) =>
    ["none", "normal", '""', "''"].includes(style.content),
  );
  const hideNodes = [...headers, ...navs, ...widgets];
  const sourceValid =
    [sections, containers, articles, tables, footers, headers, navs].every(
      (nodes) => nodes.length === 1,
    ) &&
    globalThis.document.body.classList.contains("kleine-golf") &&
    containers[0]?.contains(articles[0]) &&
    decorationSafe &&
    widgets.length <= 1 &&
    hideNodes.every((node) =>
      [...protectedNodes, ...consentNodes].every(
        (content) => !node.contains(content) && !content.contains(node),
      ),
    ) &&
    sections[0].querySelectorAll("#container").length === 1 &&
    sections[0].querySelectorAll(".faq-blok").length === 1 &&
    sections[0].querySelectorAll(".cta-blok").length === 1;
  const rows =
    tables.length === 1 ? [...tables[0].querySelectorAll("tbody tr")] : [];
  const names = rows.map(
    (row) => row.querySelectorAll("td")[4]?.textContent?.trim() ?? "",
  );
  const rankingValid =
    rows.length === 20 &&
    rows.every(
      (row, index) =>
        row.querySelectorAll("td")[0]?.textContent?.trim() ===
        String(index + 1),
    ) &&
    names.every((name) => name.length > 0 && name.length <= 100) &&
    new Set(names).size === 20;
  const encoder = new TextEncoder();
  const text = protectedNodes.map((node) =>
    encoder.encode(node.textContent ?? ""),
  );
  const textValid =
    sourceValid &&
    text.every((value) => value.length > 0) &&
    text.reduce((total, value) => total + value.length, 0) <= 1_048_576;
  /** @param {Element} node */
  const visible = (node) => {
    const style = globalThis.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const fingerprints = textValid
    ? await Promise.all(
        text.map(async (value) =>
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", value)),
          )
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        ),
      )
    : [];
  const graphics = [
    ...new Set(
      protectedNodes.flatMap((node) => [...node.querySelectorAll("img,svg")]),
    ),
  ];
  const graphicBytes = graphics.map((node) => encoder.encode(node.outerHTML));
  const graphicsBounded =
    graphicBytes.reduce((total, value) => total + value.length, 0) <= 2_097_152;
  const graphicFingerprints = graphicsBounded
    ? await Promise.all(
        graphicBytes.map(async (value) =>
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", value)),
          )
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        ),
      )
    : [];
  const chart = sections[0]?.querySelector("#container");
  const articleRows = articles.flatMap((node) => [
    ...node.querySelectorAll("table tr"),
  ]);
  const articleHeads = articles.flatMap((node) => [
    ...node.querySelectorAll("table thead"),
  ]);
  // A3 landscape minus the explicit 10mm top/bottom margins, in CSS pixels.
  const pageContentHeight = (297 - 20) * (96 / 25.4);
  return {
    sourceValid: Boolean(sourceValid && textValid && graphicsBounded),
    rankingValid,
    names,
    fingerprints,
    graphicFingerprints,
    graphicVisibility: graphics.map(visible),
    printActive: globalThis.matchMedia("print").matches,
    contentVisible:
      protectedNodes.length === 4 && protectedNodes.every(visible),
    chromeHidden: hideNodes.every(
      (node) => globalThis.getComputedStyle(node).display === "none",
    ),
    decorationHidden: pseudoStyles.every((style) => style.display === "none"),
    layoutReady:
      Boolean(chart) &&
      articleRows.length > 0 &&
      [...articleRows, ...(chart ? [chart] : [])].every((node) => {
        const style = globalThis.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.breakInside === "avoid" &&
          rect.height > 0 &&
          rect.height <= pageContentHeight
        );
      }) &&
      articleHeads.every(
        (node) =>
          globalThis.getComputedStyle(node).display === "table-header-group",
      ),
    imagesReady: protectedNodes
      .flatMap((node) => [...node.querySelectorAll("img")])
      .filter(visible)
      .every((image) => image.complete && image.naturalWidth > 0),
  };
}

/** @typedef {Awaited<ReturnType<typeof printSnapshot>>} PrintState */
/** @param {PrintState} before @param {PrintState} after */
export function preservedPrint(before, after) {
  return (
    before.sourceValid &&
    before.rankingValid &&
    after.sourceValid &&
    after.rankingValid &&
    after.printActive &&
    after.contentVisible &&
    after.chromeHidden &&
    after.decorationHidden &&
    after.layoutReady &&
    after.imagesReady &&
    before.fingerprints.length === 4 &&
    before.fingerprints.every(
      (value, index) => value === after.fingerprints[index],
    ) &&
    before.names.length === 20 &&
    before.names.every((value, index) => value === after.names[index]) &&
    before.graphicFingerprints.length === after.graphicFingerprints.length &&
    before.graphicFingerprints.every(
      (value, index) => value === after.graphicFingerprints[index],
    ) &&
    before.graphicVisibility.length === after.graphicVisibility.length &&
    before.graphicVisibility.every(
      (value, index) => value === after.graphicVisibility[index],
    )
  );
}
