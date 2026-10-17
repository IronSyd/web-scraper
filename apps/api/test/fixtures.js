// Synthetic, sanitized fixtures exercise contracts; they are not observed target HTML.
export const tiobeHtml = (change = "") =>
  `<!doctype html><html><head><title>TIOBE Index</title></head><body><table id="top20" class="table-top20"><tbody>${Array.from({ length: 20 }, (_, index) => `<tr><td>${index + 1}</td><td></td><td></td><td><img src="/images/${index + 1}.png"></td><td>Language ${index + 1}</td></tr>`).join("")}</tbody></table>${change}</body></html>`;

export const card = ({
  asin = "B000000001",
  title = "Synthetic Book",
  sponsored = false,
  byline = '<span class="a-size-base">by</span><a>Alice Example</a><span>and</span><span>Bob Example</span>',
  price = '<div data-cy="price-recipe"><a class="a-size-base a-link-normal s-underline-text">Kindle</a><span class="a-price"><span class="a-offscreen">$0.00</span></span><span>Free with Kindle Unlimited membership</span></div><div data-cy="secondary-offer-recipe"><span>Or $3.99 to buy</span></div>',
  href = `/dp/${asin}`,
} = {}) =>
  `<div data-component-type="s-search-result" data-asin="${asin}" class="${sponsored ? "AdHolder" : ""}"><a href="${href}"><h2>${title}</h2></a><div class="a-row">${byline}</div>${price}<span class="a-icon-alt">4.5 out of 5 stars</span><a href="/dp/${asin}#customerReviews" aria-label="1,234 ratings">(1.2K)</a><img class="s-image" src="https://m.media-amazon.com/images/test.png"></div>`;
export const amazonHtml = (...cards) =>
  `<!doctype html><html><head><title>Amazon.com : synthetic query</title></head><body>${cards.join("")}</body></html>`;
export const languageRecords = () =>
  Array.from({ length: 20 }, (_, index) => ({
    ranking: index + 1,
    pLang: `Language ${index + 1}`,
    imagePath: `https://www.tiobe.com/images/${index + 1}.png`,
  }));
export const bookRecord = (searchTerm = "query") => ({
  searchTerm,
  title: "Synthetic Book",
  authors: ["Alice Example"],
  url: "https://www.amazon.com/dp/B000000001",
  price: "$3.99",
  rating: null,
  reviews: null,
  image: null,
});

export function memoryRepository() {
  const entries = new Map();
  return {
    entries,
    get: async (key) => entries.get(key) ?? null,
    set: async (key, data) => {
      entries.set(key, data);
    },
  };
}
