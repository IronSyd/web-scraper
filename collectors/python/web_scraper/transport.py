"""One-attempt HTTP and browser boundaries. All public errors are allowlisted."""

import json
import os
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import requests
from playwright.sync_api import Browser, sync_playwright
from playwright.sync_api import TimeoutError as BrowserTimeout

from .contracts import CollectorError, Mode, Target, validate_target_url
from .parsers import MAX_HTML_BYTES


@dataclass(frozen=True)
class PageData:
    html: str
    url: str
    status: int


def status_error(status: int) -> CollectorError:
    if status in {401, 402}:
        return CollectorError(
            "provider_access",
            "Provider authentication or included allowance is unavailable.",
            status,
        )
    if status in {403, 429}:
        return CollectorError("blocked", "The request was denied or rate limited.", status)
    return CollectorError(
        "upstream_http", "The upstream returned an unsuccessful HTTP response.", status
    )


def provider_error(status: int, body: bytes) -> CollectorError:
    try:
        payload = json.loads(body)
    except ValueError, UnicodeDecodeError:
        return status_error(status)
    if isinstance(payload, dict):
        code = payload.get("code")
        if code == "CTX0002":
            return CollectorError(
                "provider_timeout", "The provider reported a target timeout.", status
            )
        if code == "RESP009":
            return CollectorError(
                "provider_capacity", "The provider reported unavailable capacity.", status
            )
    return status_error(status)


def fetch_html(url: str, target: Target, mode: Mode, api_key: str | None = None) -> PageData:
    validate_target_url(url, target)
    if mode == "managed" and not api_key:
        raise CollectorError(
            "missing_configuration", "ZENROWS_API_KEY must be configured for managed mode."
        )
    if mode == "managed" and os.environ.get("NODE_TLS_REJECT_UNAUTHORIZED") == "0":
        raise CollectorError("unsafe_environment", "TLS verification overrides must be disabled.")
    endpoint = "https://api.zenrows.com/v1/" if mode == "managed" else url
    params = (
        {
            "apikey": api_key or "",
            "url": url,
            "js_render": "true",
            "premium_proxy": "true",
            "proxy_country": "us",
            "original_status": "true",
        }
        if mode == "managed"
        else None
    )
    total = 190.0 if mode == "managed" else 30.0
    started = time.monotonic()
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.get(
                endpoint,
                params=params,
                stream=True,
                allow_redirects=False,
                timeout=(min(15.0, total), total),
            ) as response:
                if response.status_code != 200:
                    if mode == "managed":
                        # Error bodies are never logged; inspect one bounded chunk for known codes.
                        body = next(iter(response.iter_content(chunk_size=16_384)), b"")
                        raise provider_error(response.status_code, body)
                    raise status_error(response.status_code)
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_content(chunk_size=65_536):
                    if time.monotonic() - started >= total:
                        raise CollectorError("timeout", "The HTTP work deadline was exceeded.")
                    size += len(chunk)
                    if size > MAX_HTML_BYTES:
                        raise CollectorError(
                            "response_too_large", "The HTML response exceeded the 5 MB limit."
                        )
                    chunks.append(chunk)
                if time.monotonic() - started >= total:
                    raise CollectorError("timeout", "The HTTP work deadline was exceeded.")
                return PageData(
                    b"".join(chunks).decode("utf-8", errors="replace"), url, response.status_code
                )
    except CollectorError:
        raise
    except requests.Timeout:
        raise CollectorError("timeout", "The upstream request timed out.") from None
    except requests.RequestException:
        raise CollectorError("transport_failure", "The upstream connection failed.") from None


def booking_html(url: str, mode: Mode, api_key: str | None = None) -> PageData:
    validate_target_url(url, "booking")
    if mode == "managed" and not api_key:
        raise CollectorError(
            "missing_configuration", "ZENROWS_API_KEY must be configured for managed mode."
        )
    if mode == "managed" and any(
        os.environ.get(name)
        for name in ("DEBUG", "PWDEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS")
    ):
        raise CollectorError(
            "unsafe_environment",
            "Disable driver debug and Node override variables before managed browser use.",
        )
    if mode == "managed" and os.environ.get("NODE_TLS_REJECT_UNAUTHORIZED") == "0":
        raise CollectorError("unsafe_environment", "TLS verification overrides must be disabled.")
    deadline = time.monotonic() + 55.0

    def remaining(cap: float) -> float:
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise CollectorError("timeout", "The browser work deadline was exceeded.")
        return min(cap, seconds) * 1000

    browser: Browser | None = None
    try:
        with sync_playwright() as playwright:
            try:
                if mode == "managed":
                    private_url = "wss://browser.zenrows.com?" + urlencode(
                        {"apikey": api_key or "", "proxy_country": "us", "session_ttl": "1m"}
                    )
                    browser = playwright.chromium.connect_over_cdp(
                        private_url, timeout=remaining(15)
                    )
                    if len(browser.contexts) != 1 or len(browser.contexts[0].pages) > 1:
                        raise CollectorError(
                            "browser_state", "The remote browser context or page is ambiguous."
                        )
                    context = browser.contexts[0]
                    page = context.pages[0] if context.pages else context.new_page()
                else:
                    browser = playwright.chromium.launch(timeout=remaining(15))
                    context = browser.new_context()
                    page = context.new_page()
                response = page.goto(url, wait_until="domcontentloaded", timeout=remaining(30))
                if response is None:
                    raise CollectorError(
                        "browser_navigation", "Navigation returned no document response."
                    )
                if response.status not in {200, 202}:
                    raise status_error(response.status)
                validate_target_url(page.url, "booking")
                try:
                    page.locator('[data-testid="property-card"]').first.wait_for(
                        state="attached", timeout=remaining(10)
                    )
                except BrowserTimeout:
                    if response.status == 202:
                        raise CollectorError(
                            "blocked",
                            "A verification response did not produce recognized hotel results.",
                            202,
                        ) from None
                    raise
                html = page.content()
                remaining(1)
                if len(html.encode("utf-8")) > MAX_HTML_BYTES:
                    raise CollectorError(
                        "response_too_large", "The HTML response exceeded the 5 MB limit."
                    )
                return PageData(html, page.url, response.status)
            except CollectorError:
                raise
            except Exception:
                raise CollectorError(
                    "browser_failure", "Browser navigation or result readiness failed."
                ) from None
            finally:
                if browser is not None:
                    try:
                        browser.close()
                    except Exception:
                        raise CollectorError(
                            "cleanup_failed", "The browser did not acknowledge cleanup."
                        ) from None
    except CollectorError:
        raise
    except Exception:
        raise CollectorError(
            "browser_failure", "Browser startup or driver cleanup failed."
        ) from None
