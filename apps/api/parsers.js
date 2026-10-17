import { load } from "cheerio";
import { AppError, invalidPage } from "./errors.js";

/** @param {string} text */
const clean = (text) => text.replace(/\s+/gu, " ").trim();

/** @param {string} value @param {string} base @param {string[]} hosts */
export function safeUrl(value, base, hosts) {
  try {
    const url = new URL(value, base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !hosts.includes(url.hostname) ||
      url.port
    )
      throw invalidPage();
    return url;
  } catch {
    throw invalidPage();
  }
}

/** @param {string} html */
function recognizedDocument(html) {
  if (!/<(?:!doctype\s+html|html)(?:\s|>)/iu.test(html)) throw invalidPage();
  const $ = load(html);
  const title = clean($("title").text());
  if (
    /^(?:robot check|access denied|captcha|sorry!?)/iu.test(title) ||
    $('form[action*="validateCaptcha"], #captchacharacters, #challenge-running')
      .length
  ) {
    throw new AppError(
      502,
      "UPSTREAM_BLOCKED",
      "The upstream site returned a challenge or denial.",
    );
  }
  return $;
}

/** @param {string} html @param {string} pageUrl @returns {import('./types.js').Language[]} */
export function parseTiobe(
  html,
  pageUrl = "https://www.tiobe.com/tiobe-index/",
) {
  const $ = recognizedDocument(html);
  const table = $("table#top20.table-top20");
  if (table.length !== 1) throw invalidPage();
  const rows = table.find("tbody tr");
  if (rows.length !== 20) throw invalidPage();
  const names = new Set();
  return rows.toArray().map((row, index) => {
    const cells = $(row).children("td");
    const rankText = clean(cells.eq(0).text());
    const ranking = Number(rankText);
    const pLang = clean(cells.eq(4).text());
    const image = cells.eq(3).find("img").attr("src");
    if (
      !/^\d+$/u.test(rankText) ||
      ranking !== index + 1 ||
      !pLang ||
      pLang.length > 200 ||
      names.has(pLang) ||
      !image
    )
      throw invalidPage();
    names.add(pLang);
    const imagePath = safeUrl(image, pageUrl, [
      "www.tiobe.com",
      "tiobe.com",
    ]).href;
    return { ranking, pLang, imagePath };
  });
}

/** @param {string} href @param {string} asin @param {string} pageUrl */
export function amazonProductUrl(href, asin, pageUrl) {
  let url = safeUrl(href, pageUrl, ["www.amazon.com", "amazon.com"]);
  if (url.pathname === "/sspa/click") {
    const nested = url.searchParams.get("url");
    if (!nested) throw invalidPage();
    url = safeUrl(nested, pageUrl, ["www.amazon.com", "amazon.com"]);
  }
  const match = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/u.exec(
    url.pathname,
  );
  if (!match || match[1] !== asin) throw invalidPage();
  return `https://www.amazon.com/dp/${asin}`;
}

const displayedAmount = String.raw`(?:\d{1,3}(?:[., ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const displayedCurrency = String.raw`(?:US\$|CA\$|A\$|USD|EUR|GBP|CAD|AUD|JPY|INR|CNY|CHF|\p{Sc})`;
const alternatePurchase = new RegExp(
  `^(Or)\\s*((?:${displayedCurrency}\\s*${displayedAmount}|${displayedAmount}\\s*${displayedCurrency}))\\s*(to\\s+buy)$`,
  "iu",
);

/** @param {import('cheerio').CheerioAPI} $ @param {ReturnType<import('cheerio').CheerioAPI>} card */
function amazonPrice($, card) {
  // Limit extraction to the observed offer regions, never the card's title/review text.
  const visible = card.clone();
  visible
    .find(
      'script, style, template, noscript, [hidden], [aria-hidden="true"], .aok-hidden, .a-hidden, h1, h2, h3, h4, h5, h6, [data-cy="title-recipe"], [data-cy="reviews-block"]',
    )
    .remove();
  visible
    .find("[style]")
    .filter((_index, node) =>
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/iu.test(
        $(node).attr("style") ?? "",
      ),
    )
    .remove();
  const primaryRegion = visible.find('[data-cy="price-recipe"]').first();
  const primary = clean(
    primaryRegion
      .find(".a-price:not(.a-text-price) .a-offscreen")
      .first()
      .text(),
  );
  if (!primary) return null;
  const format = primaryRegion
    .find("a")
    .toArray()
    .map((node) => clean($(node).text()))
    .find((text) =>
      /^(?:Kindle|Paperback|Hardcover|Audible Audiobook)$/u.test(text),
    );
  const membership = primaryRegion
    .find("span")
    .toArray()
    .map((node) => clean($(node).text()))
    .find((text) => /^Free with Kindle Unlimited membership$/iu.test(text));
  const alternateText = clean(
    visible.find('[data-cy="secondary-offer-recipe"]').first().text(),
  );
  const purchase = alternatePurchase.exec(alternateText);
  const purchaseText = purchase
    ? `${purchase[1]} ${purchase[2]} ${purchase[3]}`
    : null;
  return [format, primary, membership, purchaseText]
    .filter(Boolean)
    .join(" — ");
}

/** @param {string} html @param {string} searchTerm @param {string} pageUrl @returns {import('./types.js').Book[]} */
export function parseAmazon(
  html,
  searchTerm,
  pageUrl = "https://www.amazon.com/s",
) {
  const $ = recognizedDocument(html);
  const cards = $('[data-component-type="s-search-result"][data-asin]');
  if (!cards.length || cards.length > 100) throw invalidPage();
  /** @type {Map<string,{book:import('./types.js').Book,sponsored:boolean}>} */
  const results = new Map();
  for (const card of cards.toArray()) {
    const el = $(card);
    const asin = el.attr("data-asin") ?? "";
    const heading = el.find("h2").first();
    const title = clean(heading.text());
    const href = heading.parent("a").attr("href");
    if (!/^[A-Z0-9]{10}$/u.test(asin) || !title || title.length > 2000 || !href)
      throw invalidPage();
    const url = amazonProductUrl(href, asin, pageUrl);
    /** @type {string[]} */
    const authors = [];
    for (const row of el.find(".a-row").toArray()) {
      const children = $(row).children().toArray();
      const marker = children.findIndex(
        (child) => child.tagName === "span" && clean($(child).text()) === "by",
      );
      if (marker < 0) continue;
      for (const child of children.slice(marker + 1)) {
        const text = clean($(child).text());
        if (child.tagName !== "a" && child.tagName !== "span") continue;
        if ($(child).hasClass("a-color-secondary") || /^[|·]/u.test(text))
          break;
        if (text && !/^(?:and|,|et al\.?|&)$/iu.test(text))
          authors.push(text.replace(/\s*,\s*$/u, ""));
      }
      break;
    }
    const price = amazonPrice($, el);
    const rating = clean(el.find(".a-icon-alt").first().text()) || null;
    const count = el
      .find('a[href*="#customerReviews"]')
      .first()
      .attr("aria-label");
    const reviews =
      count && /^\s*[\d,.]+\s+ratings?\s*$/iu.test(count) ? clean(count) : null;
    const imageValue = el.find("img.s-image").attr("src");
    const image = imageValue
      ? safeUrl(imageValue, pageUrl, ["m.media-amazon.com"]).href
      : null;
    const book = {
      searchTerm,
      title,
      authors: [...new Set(authors)],
      url,
      price,
      rating,
      reviews,
      image,
    };
    const sponsored = el.hasClass("AdHolder");
    const previous = results.get(asin);
    if (!previous || (previous.sponsored && !sponsored))
      results.set(asin, { book, sponsored });
  }
  return [...results.values()].map((entry) => entry.book);
}
