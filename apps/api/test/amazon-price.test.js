import test from "node:test";
import assert from "node:assert/strict";
import { parseAmazon } from "../parsers.js";
import { amazonHtml, card } from "./fixtures.js";

// Synthetic sanitized markup follows the observed price-recipe and secondary-offer-recipe structure.
const primary = (amount = "$0.00", membership = true) =>
  `<div data-cy="price-recipe"><a class="a-size-base a-link-normal s-underline-text">Kindle</a><span class="a-price"><span class="a-offscreen">${amount}</span></span>${membership ? '<div class="a-row"><span>Free with Kindle Unlimited membership</span></div>' : ""}</div>`;
const alternate = (text) =>
  `<div data-cy="secondary-offer-recipe"><div class="a-row"><span>${text}</span></div></div>`;
const priceOf = (price, title = "Synthetic book") =>
  parseAmazon(amazonHtml(card({ title, price })), "query")[0].price;

test("P01: title containing for and CSS cannot enter the alternate purchase price", () => {
  const price =
    '<style>.s-price{color:red;--offer:"polluted"}</style>' +
    primary() +
    alternate("Or $1.99 to buy");
  assert.equal(
    priceOf(price, "Python for Everyone"),
    "Kindle — $0.00 — Free with Kindle Unlimited membership — Or $1.99 to buy",
  );
});
test("P02: split inline alternate amount retains source monetary text", () => {
  assert.equal(
    priceOf(primary() + alternate("Or <span>$</span><span>3.99</span> to buy")),
    "Kindle — $0.00 — Free with Kindle Unlimited membership — Or $3.99 to buy",
  );
});
test("P02: localized displayed amount is retained without currency inference", () => {
  assert.equal(
    priceOf(
      primary("€0,00") +
        alternate("Or <span>€</span><span>1.234,56</span> to buy"),
    ),
    "Kindle — €0,00 — Free with Kindle Unlimited membership — Or €1.234,56 to buy",
  );
});
test("P02: adjacent inline offer tokens normalize whitespace without losing amount", () => {
  assert.equal(
    priceOf(
      primary() +
        alternate(
          "<span>Or</span><span>$</span><span>3.99</span><span>to buy</span>",
        ),
    ),
    "Kindle — $0.00 — Free with Kindle Unlimited membership — Or $3.99 to buy",
  );
});
test("P03: title-only purchase wording is not an alternate offer", () => {
  assert.equal(
    priceOf(primary(), "Or $99.99 to buy: a synthetic title"),
    "Kindle — $0.00 — Free with Kindle Unlimited membership",
  );
});
test("P03: review, script, style, template and hidden alternate decoys are ignored", () => {
  const decoys =
    '<div data-cy="reviews-block">Or $91.00 to buy</div><script>Or $92.00 to buy</script><style>/* Or $93.00 to buy */</style><template>' +
    alternate("Or $94.00 to buy") +
    "</template><div hidden>" +
    alternate("Or $95.00 to buy") +
    '</div><div aria-hidden="true">' +
    alternate("Or $96.00 to buy") +
    '</div><div style="display: none !important">' +
    alternate("Or $97.00 to buy") +
    "</div>";
  assert.equal(
    priceOf(decoys + primary() + alternate("Or $2.99 to buy")),
    "Kindle — $0.00 — Free with Kindle Unlimited membership — Or $2.99 to buy",
  );
});
test("P03: hidden primary price and format cannot replace a visible offer", () => {
  assert.equal(
    priceOf(
      "<div hidden>" +
        primary("$777.00", false) +
        "</div>" +
        primary("$12.99", false),
    ),
    "Kindle — $12.99",
  );
});
test("P03: absent or nonmonetary alternate offers are omitted", () => {
  for (const text of [
    "Or contact seller to buy",
    "Or 123 to buy",
    "Or $TBD to buy",
    "Or $3.99 to buy and earn points",
  ]) {
    assert.equal(
      priceOf(primary() + alternate(text)),
      "Kindle — $0.00 — Free with Kindle Unlimited membership",
    );
  }
});
test("P03: missing primary price stays null despite unrelated purchase wording", () => {
  assert.equal(
    priceOf(alternate("Or $3.99 to buy"), "Synthetic book for readers"),
    null,
  );
});
test("P03: deduplication keeps the organic price and existing nullable DTO fields", () => {
  const rows = parseAmazon(
    amazonHtml(
      card({ sponsored: true, price: primary("$9.99", false) }),
      card({
        title: "Organic book for readers",
        byline: "",
        price: primary("$12.99", false),
      }),
    ),
    "query",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, "Kindle — $12.99");
  assert.deepEqual(rows[0].authors, []);
  assert.equal(rows[0].reviews, "1,234 ratings");
});
