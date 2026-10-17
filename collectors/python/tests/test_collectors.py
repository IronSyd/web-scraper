"""Offline contract tests. Reduced fixtures are synthetic, based on observed selector forms."""

from unittest.mock import MagicMock
from urllib.parse import parse_qs, quote, urlsplit

import pytest
import requests
from playwright.sync_api import TimeoutError as BrowserTimeout
from web_scraper import cli, transport
from web_scraper.contracts import BookingInput, CollectorError, amazon_url, indeed_url
from web_scraper.parsers import parse_amazon, parse_booking, parse_indeed

AMAZON = "https://www.amazon.com/s?k=python&i=stripbooks"
INDEED = "https://www.indeed.com/jobs?q=engineer&l=New+York"
TRAVEL = BookingInput("New York", "2026-11-16", "2026-11-17", 2, 1)


@pytest.fixture(autouse=True)
def clean_driver_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "DEBUG",
        "PWDEBUG",
        "NODE_DEBUG",
        "NODE_DEBUG_NATIVE",
        "NODE_OPTIONS",
        "NODE_TLS_REJECT_UNAUTHORIZED",
    ):
        monkeypatch.delenv(name, raising=False)


def book_card(
    asin: str = "B012345678",
    *,
    title: str = "Python",
    sponsored: bool = False,
    authors: bool = True,
    offer: bool = True,
    href: str | None = None,
) -> str:
    byline = (
        '<div class="a-row"><span>by </span><a>Alex Author</a>'
        "<span> and </span><span>Robin Writer</span></div>"
        if authors
        else ""
    )
    price = (
        '<div data-cy="price-recipe"><div>Kindle</div><span class="a-price">'
        '<span class="a-offscreen">$0.00</span><span aria-hidden="true">$000</span></span>'
        "<span>Free with Kindle Unlimited membership</span><span>Or $9.99 to buy</span></div>"
        if offer
        else ""
    )
    return (
        f'<div data-component-type="s-search-result" data-asin="{asin}" '
        f'class="{"AdHolder" if sponsored else ""}"><div data-cy="title-recipe">'
        f'<a href="{href or f"/dp/{asin}"}"><h2>{title}</h2></a>{byline}</div>{price}</div>'
    )


def hotel_card(*, label: str = "Current price $247.", query: str | None = None) -> str:
    query = (
        query
        or "checkin=2026-11-16&amp;checkout=2026-11-17&amp;group_adults=2"
        "&amp;no_rooms=1&amp;srpvid=discard"
    )
    return (
        '<div data-testid="property-card"><a data-testid="title-link" '
        f'href="/hotel/us/example.html?{query}"><div data-testid="title">Example Hotel</div>'
        '</a><div data-testid="availability-rate-information"><div>Per night'
        '<span data-testid="price-and-discounted-price">$227</span></div>'
        '<span data-testid="price-and-discounted-price">$247</span>'
        f'<span>{label}</span></div><div data-testid="review-score">'
        'Scored 7.1 Good 2,223 reviews</div><span data-testid="address-link">Manhattan</span></div>'
    )


def job_card(*, company: str = "Example", href: str = "/rc/clk?jk=12345678abcdef00") -> str:
    return (
        '<div id="mosaic-provider-jobcards"><div class="job_seen_beacon">'
        f'<a class="jcs-JobTitle" data-jk="12345678abcdef00" href="{href}">Engineer</a>'
        f'<span data-testid="company-name">{company}</span>'
        '<div data-testid="text-location">New York</div></div></div>'
    )


def test_amazon_preserves_conditional_price_and_span_authors() -> None:
    result = parse_amazon(book_card(), AMAZON, " python ")[0]
    assert result["authors"] == ["Alex Author", "Robin Writer"]
    assert result["searchTerm"] == "python"
    assert result["url"] == "https://www.amazon.com/dp/B012345678"
    assert result["price"] == "Kindle $0.00 Free with Kindle Unlimited membership Or $9.99 to buy"
    assert result["reviews"] is None and result["rating"] is None


def test_amazon_prefers_first_organic_placement_without_merging() -> None:
    html = (
        book_card(title="Sponsored", sponsored=True)
        + book_card(title="Organic", authors=False, offer=False)
        + book_card(title="Later")
    )
    result = parse_amazon(html, AMAZON, "python")
    assert len(result) == 1
    assert result[0]["title"] == "Organic"
    assert result[0]["authors"] == [] and result[0]["price"] is None


def test_amazon_validates_nested_sponsored_url() -> None:
    href = "/sspa/click?url=" + quote("/Some-Title/dp/B012345678/ref=tracking?tag=discard", safe="")
    assert parse_amazon(book_card(href=href), AMAZON, "python")[0]["url"].endswith("/dp/B012345678")


@pytest.mark.parametrize(
    "href",
    [
        "javascript:alert(1)",
        "https://evil.example/dp/B012345678",
        "/dp/B999999999",
        "https://user:secret@www.amazon.com/dp/B012345678",
        "/sspa/click?url=https%3A%2F%2Fevil.example%2Fdp%2FB012345678",
    ],
)
def test_amazon_rejects_unsafe_or_mismatched_product(href: str) -> None:
    with pytest.raises(CollectorError):
        parse_amazon(book_card(href=href), AMAZON, "python")


def test_amazon_exact_ratings_label_and_image() -> None:
    html = book_card().replace(
        "</div></div>",
        '<a href="/dp/B012345678#customerReviews" aria-label="1,234 ratings">1.2K</a>'
        '<span class="a-icon-alt">4.7 out of 5 stars</span>'
        '<img class="s-image" src="https://m.media-amazon.com/images/test.jpg"></div></div>',
        1,
    )
    item = parse_amazon(html, AMAZON, "python")[0]
    assert item["reviews"] == "1,234 ratings"
    assert item["image"] == "https://m.media-amazon.com/images/test.jpg"


def test_booking_stay_price_explicit_currency_and_safe_context() -> None:
    html = (
        '<button data-testid="header-currency-picker-trigger" '
        'aria-label="Prices in U.S. Dollar USD">USD</button>' + hotel_card()
    )
    item = parse_booking(html, TRAVEL.url(), TRAVEL)[0]
    assert item["price"] == "$247" and item["price"] != "$227"
    assert item["currency"] == "USD"
    assert item["rating"] == "7.1" and item["reviewCount"] == 2223
    assert item["location"] == "Manhattan" and "srpvid" not in item["url"]


def test_booking_does_not_guess_stay_price_or_currency() -> None:
    item = parse_booking(hotel_card(label="Unknown caption"), TRAVEL.url(), TRAVEL)[0]
    assert item["price"] is None and item["currency"] is None


def test_booking_malformed_review_counter_is_not_invented() -> None:
    html = hotel_card().replace("2,223 reviews", "2,23 reviews")
    assert parse_booking(html, TRAVEL.url(), TRAVEL)[0]["reviewCount"] is None


def test_booking_rejects_mismatched_travel_context() -> None:
    with pytest.raises(CollectorError, match="do not match"):
        parse_booking(
            hotel_card(
                query="checkin=2026-11-16&amp;checkout=2026-11-18&amp;group_adults=2&amp;no_rooms=1"
            ),
            TRAVEL.url(),
            TRAVEL,
        )


def test_indeed_primary_fields_and_stable_job_url() -> None:
    item = parse_indeed(job_card(), INDEED)[0]
    assert item == {
        "jobId": "12345678abcdef00",
        "title": "Engineer",
        "company": "Example",
        "location": "New York",
        "url": "https://www.indeed.com/viewjob?jk=12345678abcdef00",
    }


@pytest.mark.parametrize("html", [job_card(company=""), job_card(href="/rc/clk?jk=otheridentity")])
def test_indeed_required_fields_and_identity_fail_closed(html: str) -> None:
    with pytest.raises(CollectorError):
        parse_indeed(html, INDEED)


@pytest.mark.parametrize(
    "html, code",
    [
        ("<html>No results</html>", "unrecognized_page"),
        ("<title>Access Denied</title>", "blocked"),
        ('<form action="/errors/validateCaptcha">Challenge</form>', "blocked"),
    ],
)
def test_zero_or_challenged_pages_are_never_successful_empty(html: str, code: str) -> None:
    for action in (
        lambda: parse_amazon(html, AMAZON, "python"),
        lambda: parse_indeed(html, INDEED),
        lambda: parse_booking(html, TRAVEL.url(), TRAVEL),
    ):
        with pytest.raises(CollectorError) as raised:
            action()
        assert raised.value.code == code


@pytest.mark.parametrize("query", ["", "  ", "x" * 201, "bad\nquery"])
def test_input_validation(query: str) -> None:
    with pytest.raises(CollectorError):
        amazon_url(query)


def test_query_parameters_are_encoded() -> None:
    assert parse_qs(urlsplit(amazon_url("C++ & Python")).query)["k"] == ["C++ & Python"]
    assert parse_qs(urlsplit(indeed_url("engineer", "New York, NY")).query)["l"] == ["New York, NY"]


@pytest.mark.parametrize(
    "travel",
    [
        BookingInput("NY", "2026-02-30", "2026-03-01", 2, 1),
        BookingInput("NY", "2026-11-16", "2026-11-16", 2, 1),
        BookingInput("NY", "2026-11-16", "2026-11-17", 0, 1),
    ],
)
def test_booking_input_validation(travel: BookingInput) -> None:
    with pytest.raises(CollectorError):
        travel.url()


def mock_http(
    monkeypatch: pytest.MonkeyPatch, *, status: int = 200, chunks: list[bytes] | None = None
) -> tuple[MagicMock, MagicMock]:
    response = MagicMock()
    response.status_code = status
    response.iter_content.return_value = chunks or [b"<html>Target HTML</html>"]
    response.__enter__.return_value = response
    session = MagicMock()
    session.get.return_value = response
    session.__enter__.return_value = session
    monkeypatch.setattr(transport.requests, "Session", lambda: session)
    return session, response


def test_managed_transport_fixed_flags_no_retries_and_text_plain_html(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session, response = mock_http(monkeypatch)
    page = transport.fetch_html(AMAZON, "amazon", "managed", "DUMMY")
    assert page.html == "<html>Target HTML</html>"
    assert session.get.call_count == 1 and session.trust_env is False
    kwargs = session.get.call_args.kwargs
    assert kwargs["params"] == {
        "apikey": "DUMMY",
        "url": AMAZON,
        "js_render": "true",
        "premium_proxy": "true",
        "proxy_country": "us",
        "original_status": "true",
    }
    assert kwargs["timeout"] == (15.0, 190.0) and kwargs["allow_redirects"] is False
    response.__exit__.assert_called_once()
    session.__exit__.assert_called_once()


@pytest.mark.parametrize(
    "status, code",
    [
        (403, "blocked"),
        (429, "blocked"),
        (402, "provider_access"),
        (503, "upstream_http"),
        (302, "upstream_http"),
    ],
)
def test_transport_status_failures_are_explicit(
    monkeypatch: pytest.MonkeyPatch, status: int, code: str
) -> None:
    session, _ = mock_http(monkeypatch, status=status)
    with pytest.raises(CollectorError) as raised:
        transport.fetch_html(AMAZON, "amazon", "standard")
    assert raised.value.code == code and raised.value.status == status
    assert session.get.call_count == 1


@pytest.mark.parametrize(
    "provider_code, expected", [("CTX0002", "provider_timeout"), ("RESP009", "provider_capacity")]
)
def test_known_provider_json_code_precedes_generic_status(
    monkeypatch: pytest.MonkeyPatch, provider_code: str, expected: str
) -> None:
    mock_http(monkeypatch, status=500, chunks=[('{"code":"' + provider_code + '"}').encode()])
    with pytest.raises(CollectorError) as raised:
        transport.fetch_html(AMAZON, "amazon", "managed", "DUMMY")
    assert raised.value.code == expected


@pytest.mark.parametrize(
    "error",
    [
        requests.Timeout("SECRET authenticated URL"),
        requests.ConnectionError("SECRET authenticated URL"),
    ],
)
def test_transport_exception_redaction(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    session, _ = mock_http(monkeypatch)
    session.get.side_effect = error
    with pytest.raises(CollectorError) as raised:
        transport.fetch_html(AMAZON, "amazon", "managed", "SECRET")
    assert "SECRET" not in str(raised.value)


def test_response_size_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    mock_http(monkeypatch, chunks=[b"x" * (5_000_001)])
    with pytest.raises(CollectorError) as raised:
        transport.fetch_html(AMAZON, "amazon", "standard")
    assert raised.value.code == "response_too_large"


def test_http_cumulative_deadline_stops_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    mock_http(monkeypatch)
    ticks = iter([0.0, 190.0])
    monkeypatch.setattr(transport.time, "monotonic", lambda: next(ticks))
    with pytest.raises(CollectorError) as raised:
        transport.fetch_html(AMAZON, "amazon", "managed", "DUMMY")
    assert raised.value.code == "timeout"


def test_managed_requires_configuration_before_network(monkeypatch: pytest.MonkeyPatch) -> None:
    session, _ = mock_http(monkeypatch)
    with pytest.raises(CollectorError) as raised:
        transport.fetch_html(AMAZON, "amazon", "managed")
    assert raised.value.code == "missing_configuration"
    session.get.assert_not_called()


def test_managed_fetch_refuses_tls_override_before_network(monkeypatch: pytest.MonkeyPatch) -> None:
    session, _ = mock_http(monkeypatch)
    monkeypatch.setenv("NODE_TLS_REJECT_UNAUTHORIZED", "0")
    with pytest.raises(CollectorError) as raised:
        transport.fetch_html(AMAZON, "amazon", "managed", "DUMMY")
    assert raised.value.code == "unsafe_environment"
    session.get.assert_not_called()


def mock_browser(monkeypatch: pytest.MonkeyPatch) -> tuple[MagicMock, MagicMock, MagicMock]:
    page, browser, playwright = MagicMock(), MagicMock(), MagicMock()
    page.url = TRAVEL.url()
    page.goto.return_value.status = 202
    page.content.return_value = hotel_card()
    browser.contexts = [MagicMock()]
    browser.contexts[0].pages = [page]
    playwright.chromium.connect_over_cdp.return_value = browser
    manager = MagicMock()
    manager.__enter__.return_value = playwright
    monkeypatch.setattr(transport, "sync_playwright", lambda: manager)
    return page, browser, playwright


def test_browser_one_navigation_and_cleanup(monkeypatch: pytest.MonkeyPatch) -> None:
    page, browser, playwright = mock_browser(monkeypatch)
    result = transport.booking_html(TRAVEL.url(), "managed", "DUMMY")
    assert result.status == 202
    page.goto.assert_called_once()
    browser.close.assert_called_once()
    private_url = playwright.chromium.connect_over_cdp.call_args.args[0]
    assert parse_qs(urlsplit(private_url).query) == {
        "apikey": ["DUMMY"],
        "proxy_country": ["us"],
        "session_ttl": ["1m"],
    }


def test_browser_navigation_failure_is_redacted_and_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    page, browser, _ = mock_browser(monkeypatch)
    page.goto.side_effect = RuntimeError("SECRET private websocket")
    with pytest.raises(CollectorError) as raised:
        transport.booking_html(TRAVEL.url(), "managed", "SECRET")
    assert "SECRET" not in str(raised.value)
    browser.close.assert_called_once()


@pytest.mark.parametrize("mode", ["standard", "managed"])
def test_202_without_ready_hotel_cards_fails_blocked(
    monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    page, browser, playwright = mock_browser(monkeypatch)
    playwright.chromium.launch.return_value = browser
    browser.new_context.return_value.new_page.return_value = page
    page.locator.return_value.first.wait_for.side_effect = BrowserTimeout("SECRET timeout")
    with pytest.raises(CollectorError) as raised:
        transport.booking_html(TRAVEL.url(), mode, "DUMMY")
    assert raised.value.code == "blocked" and raised.value.status == 202
    browser.close.assert_called_once()


@pytest.mark.parametrize(
    "name", ["DEBUG", "PWDEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS"]
)
def test_managed_browser_refuses_debug_environment_before_allocation(
    monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    _, _, playwright = mock_browser(monkeypatch)
    monkeypatch.setenv(name, "DUMMY-OVERRIDE")
    with pytest.raises(CollectorError) as raised:
        transport.booking_html(TRAVEL.url(), "managed", "DUMMY")
    assert raised.value.code == "unsafe_environment"
    playwright.chromium.connect_over_cdp.assert_not_called()


def test_browser_ambiguous_context_stops_before_navigation(monkeypatch: pytest.MonkeyPatch) -> None:
    page, browser, _ = mock_browser(monkeypatch)
    browser.contexts = []
    with pytest.raises(CollectorError) as raised:
        transport.booking_html(TRAVEL.url(), "managed", "DUMMY")
    assert raised.value.code == "browser_state"
    page.goto.assert_not_called()
    browser.close.assert_called_once()


def test_browser_cleanup_failure_prevents_success(monkeypatch: pytest.MonkeyPatch) -> None:
    _, browser, _ = mock_browser(monkeypatch)
    browser.close.side_effect = RuntimeError("SECRET private websocket")
    with pytest.raises(CollectorError) as raised:
        transport.booking_html(TRAVEL.url(), "managed", "DUMMY")
    assert raised.value.code == "cleanup_failed" and "SECRET" not in str(raised.value)


def test_browser_reports_cleanup_failure_after_navigation_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page, browser, _ = mock_browser(monkeypatch)
    page.goto.side_effect = RuntimeError("SECRET navigation")
    browser.close.side_effect = RuntimeError("SECRET cleanup")
    with pytest.raises(CollectorError) as raised:
        transport.booking_html(TRAVEL.url(), "managed", "DUMMY")
    assert raised.value.code == "cleanup_failed" and "SECRET" not in str(raised.value)


def test_managed_browser_refuses_tls_override_before_allocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, playwright = mock_browser(monkeypatch)
    monkeypatch.setenv("NODE_TLS_REJECT_UNAUTHORIZED", "0")
    with pytest.raises(CollectorError) as raised:
        transport.booking_html(TRAVEL.url(), "managed", "DUMMY")
    assert raised.value.code == "unsafe_environment"
    playwright.chromium.connect_over_cdp.assert_not_called()


def test_browser_deadline_is_cumulative(monkeypatch: pytest.MonkeyPatch) -> None:
    page, browser, _ = mock_browser(monkeypatch)
    ticks = iter([0.0, 1.0, 56.0])
    monkeypatch.setattr(transport.time, "monotonic", lambda: next(ticks))
    with pytest.raises(CollectorError) as raised:
        transport.booking_html(TRAVEL.url(), "managed", "DUMMY")
    assert raised.value.code == "timeout"
    page.goto.assert_not_called()
    browser.close.assert_called_once()


def test_cli_invalid_inputs_do_not_start_worker(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    worker = MagicMock()
    monkeypatch.setattr(cli, "run_bounded", worker)
    assert cli.main(["amazon", "--query", " "]) == 1
    assert "invalid_input" in capsys.readouterr().out
    worker.assert_not_called()


def test_parent_watchdog_terminates_stalled_worker_without_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker, context = MagicMock(), MagicMock()
    context.Process.return_value = worker
    worker.is_alive.side_effect = [True, True, False, False]
    worker.pid = 123
    monkeypatch.setattr(cli.multiprocessing, "get_context", lambda _: context)
    with pytest.raises(CollectorError) as raised:
        cli.run_bounded(cli.Request("amazon", "standard", "python", AMAZON))
    assert raised.value.code == "timeout"
    worker.start.assert_called_once()
    worker.terminate.assert_called_once()
    worker.kill.assert_not_called()
    worker.close.assert_called_once()


def test_parent_watchdog_returns_worker_payload_and_closes_handles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pathlib import Path

    worker, context = MagicMock(), MagicMock()
    context.Process.return_value = worker
    worker.is_alive.return_value = False
    worker.pid = 123
    worker.exitcode = 0
    worker.start.side_effect = lambda: Path(context.Process.call_args.kwargs["args"][1]).write_text(
        '{"ok":false,"error":{"code":"blocked"}}', encoding="utf-8"
    )
    monkeypatch.setattr(cli.multiprocessing, "get_context", lambda _: context)
    result = cli.run_bounded(cli.Request("amazon", "standard", "python", AMAZON))
    assert result["ok"] is False
    worker.terminate.assert_not_called()
    worker.close.assert_called_once()


def test_real_spawn_worker_returns_offline_input_failure() -> None:
    # No BookingInput means collect() fails before any transport or .env loading.
    result = cli.run_bounded(cli.Request("booking", "standard", "", "", None))
    assert result == {
        "ok": False,
        "error": {
            "code": "invalid_input",
            "message": "Booking travel inputs are required.",
            "status": None,
        },
    }
