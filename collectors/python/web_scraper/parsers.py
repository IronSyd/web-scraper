"""Pure BeautifulSoup parsers grounded in the saved target markup.

Unknown or zero-result pages fail explicitly until legitimate empty-page contracts are verified.
"""

import re
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup, Tag

from .contracts import (
    Book,
    BookingInput,
    CollectorError,
    Hotel,
    Job,
    search_text,
    validate_target_url,
)

MAX_HTML_BYTES = 5_000_000


def text(node: Tag | None) -> str | None:
    value = " ".join(node.get_text(" ", strip=True).split()) if node else ""
    return value or None


def attribute(node: Tag | None, name: str) -> str | None:
    value = node.get(name) if node else None
    return value if isinstance(value, str) and value else None


def document(html: str) -> BeautifulSoup:
    if len(html.encode("utf-8")) > MAX_HTML_BYTES:
        raise CollectorError("response_too_large", "The HTML response exceeded the 5 MB limit.")
    soup = BeautifulSoup(html, "html.parser")
    for node in soup.select("script, style, noscript, template"):
        node.decompose()
    if soup.select_one(
        'form[action*="validateCaptcha"], #challenge-form, #awswaf-captcha-container'
    ):
        raise CollectorError("blocked", "The target returned an access challenge.")
    title = text(soup.find("title")) or ""
    if re.search(r"access denied|robot check|just a moment|verify you are human", title, re.I):
        raise CollectorError("blocked", "The target returned a denial or verification page.")
    return soup


def missing_results(soup: BeautifulSoup) -> None:
    visible = (text(soup.body) or text(soup) or "")[:3000]
    if re.search(
        r"access denied|verify you are human|verify that you.re not a robot|enter the characters",
        visible,
        re.I,
    ):
        raise CollectorError("blocked", "The target returned an access challenge.")
    raise CollectorError(
        "unrecognized_page", "No recognized results were found; this is not confirmed empty data."
    )


def safe_url(raw: str | None, base: str, hosts: set[str]) -> str:
    try:
        if not raw:
            raise ValueError
        resolved = urljoin(base, raw)
        parts = urlsplit(resolved)
        if parts.scheme not in {"http", "https"} or parts.hostname not in hosts:
            raise ValueError
        if (
            parts.username is not None
            or parts.password is not None
            or parts.port not in (None, 80, 443)
        ):
            raise ValueError
        return resolved
    except ValueError:
        raise CollectorError(
            "invalid_result", "A result contains an unsafe or unexpected URL."
        ) from None


def amazon_product_url(raw: str | None, base: str, asin: str) -> str:
    url = safe_url(raw, base, {"www.amazon.com", "amazon.com"})
    parts = urlsplit(url)
    if parts.path == "/sspa/click":
        nested = parse_qs(parts.query).get("url", [])
        if len(nested) != 1:
            raise CollectorError("invalid_result", "The sponsored product link is ambiguous.")
        url = safe_url(nested[0], base, {"www.amazon.com", "amazon.com"})
        parts = urlsplit(url)
    match = re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})(?:/|$)", parts.path)
    if not match or match.group(1) != asin:
        raise CollectorError("invalid_result", "The product link does not match its ASIN.")
    return f"https://www.amazon.com/dp/{asin}"


def amazon_authors(card: Tag) -> list[str]:
    rows = [
        row
        for row in card.select('[data-cy="title-recipe"] .a-row')
        if (text(row) or "").startswith("by ")
    ]
    if not rows:
        return []
    row = rows[-1]
    names: list[str] = []
    for child in row.find_all(["a", "span"], recursive=False):
        name = text(child)
        if name and name not in {"by", "and", ",", "et al."} and name not in names:
            names.append(name)
    return names


def amazon_price(card: Tag) -> str | None:
    recipe = card.select_one('[data-cy="price-recipe"]')
    if not recipe or not recipe.select_one(".a-price:not(.a-text-price) .a-offscreen"):
        return None
    # Preserve source format, membership qualification and alternative purchase text.
    # Remove duplicate visual digits, retaining the accessible price display strings.
    copy = BeautifulSoup(str(recipe), "html.parser")
    for duplicate in copy.select('.a-price > [aria-hidden="true"]'):
        duplicate.decompose()
    return text(copy)


def parse_amazon(html: str, page_url: str, query: str) -> list[Book]:
    validate_target_url(page_url, "amazon")
    query = search_text(query)
    soup = document(html)
    cards = soup.select('[data-component-type="s-search-result"][data-asin]')
    if not cards:
        missing_results(soup)
    selected: dict[str, tuple[bool, Book]] = {}
    for card in cards:
        asin = attribute(card, "data-asin") or ""
        heading = card.select_one("h2")
        title = text(heading)
        anchor = heading.find_parent("a", href=True) if heading else None
        if not isinstance(anchor, Tag) or anchor not in card.descendants:
            anchor = heading.select_one("a[href]") if heading else None
        if not re.fullmatch(r"[A-Z0-9]{10}", asin) or not title:
            raise CollectorError(
                "schema_drift", "An Amazon result is missing its required title or ASIN."
            )
        url = amazon_product_url(attribute(anchor, "href"), page_url, asin)
        image_raw = attribute(card.select_one("img.s-image[src]"), "src")
        image = safe_url(image_raw, page_url, {"m.media-amazon.com"}) if image_raw else None
        reviews = attribute(
            card.select_one('a[href*="#customerReviews"][aria-label]'), "aria-label"
        )
        book: Book = {
            "searchTerm": query,
            "asin": asin,
            "title": title,
            "authors": amazon_authors(card),
            "url": url,
            "price": amazon_price(card),
            "rating": text(card.select_one(".a-icon-alt")),
            "reviews": reviews,
            "image": image,
        }
        sponsored = "AdHolder" in (card.get("class") or []) or any(
            "Sponsored" in str(label) for label in card.select("[aria-label]")[:4]
        )
        if asin not in selected or (selected[asin][0] and not sponsored):
            selected[asin] = (sponsored, book)
    return [entry[1] for entry in selected.values()]


def parse_indeed(html: str, page_url: str) -> list[Job]:
    validate_target_url(page_url, "indeed")
    soup = document(html)
    cards = soup.select("#mosaic-provider-jobcards .job_seen_beacon")
    if not cards:
        missing_results(soup)
    jobs: dict[str, Job] = {}
    for card in cards:
        anchor = card.select_one("a.jcs-JobTitle[data-jk]")
        job_id = attribute(anchor, "data-jk") or ""
        title, company, location = (
            text(anchor),
            text(card.select_one('[data-testid="company-name"]')),
            text(card.select_one('[data-testid="text-location"]')),
        )
        if (
            not re.fullmatch(r"[a-zA-Z0-9]{8,64}", job_id)
            or not title
            or not company
            or not location
        ):
            raise CollectorError("schema_drift", "An Indeed result is missing its required fields.")
        url = safe_url(attribute(anchor, "href"), page_url, {"www.indeed.com", "indeed.com"})
        if parse_qs(urlsplit(url).query).get("jk") != [job_id]:
            raise CollectorError("invalid_result", "The job link does not match its job identity.")
        jobs[job_id] = {
            "jobId": job_id,
            "title": title,
            "company": company,
            "location": location,
            "url": "https://www.indeed.com/viewjob?" + urlencode({"jk": job_id}),
        }
    return list(jobs.values())


def parse_booking(html: str, page_url: str, request: BookingInput) -> list[Hotel]:
    validate_target_url(page_url, "booking")
    request = request.validated()
    soup = document(html)
    cards = soup.select('[data-testid="property-card"]')
    if not cards:
        missing_results(soup)
    currency_label = (
        attribute(soup.select_one('[data-testid="header-currency-picker-trigger"]'), "aria-label")
        or ""
    )
    currency_match = re.search(r"\b([A-Z]{3})$", currency_label)
    currency = currency_match.group(1) if currency_match else None
    hotels: dict[str, Hotel] = {}
    for card in cards:
        name = text(card.select_one('[data-testid="title"]'))
        if not name:
            raise CollectorError("schema_drift", "A Booking result is missing its hotel name.")
        url = safe_url(
            attribute(card.select_one('a[data-testid="title-link"]'), "href"),
            page_url,
            {"www.booking.com", "booking.com"},
        )
        parts = urlsplit(url)
        if not re.fullmatch(r"/hotel/[a-z]{2}/[^/]+\.html", parts.path):
            raise CollectorError(
                "invalid_result", "A hotel link has an unrecognized property path."
            )
        expected = {
            "checkin": request.checkin,
            "checkout": request.checkout,
            "group_adults": str(request.adults),
            "no_rooms": str(request.rooms),
        }
        actual = parse_qs(parts.query)
        if any(actual.get(key) != [value] for key, value in expected.items()):
            raise CollectorError(
                "input_mismatch", "Hotel travel dates or occupancy do not match the request."
            )
        clean_url = urlunsplit(("https", "www.booking.com", parts.path, urlencode(expected), ""))
        rate = card.select_one('[data-testid="availability-rate-information"]')
        prices = rate.select('[data-testid="price-and-discounted-price"]') if rate else []
        last_price = text(prices[-1]) if prices else None
        rate_text = text(rate) or ""
        price = (
            last_price
            if last_price
            and re.search(r"(?:Current price|Price)\s+" + re.escape(last_price), rate_text)
            else None
        )
        review_text = text(card.select_one('[data-testid="review-score"]')) or ""
        rating_match = re.search(r"\bScored\s+(\d+(?:\.\d+)?)\b", review_text)
        count_match = re.search(r"(?<![\d,])((?:\d{1,3}(?:,\d{3})+|\d+))\s+reviews\b", review_text)
        reviews = int(count_match.group(1).replace(",", "")) if count_match else None
        hotels[parts.path] = {
            "name": name,
            "url": clean_url,
            "price": price,
            "currency": currency,
            "rating": rating_match.group(1) if rating_match else None,
            "reviewCount": reviews,
            "location": text(card.select_one('[data-testid="address-link"]')),
        }
    return list(hotels.values())
