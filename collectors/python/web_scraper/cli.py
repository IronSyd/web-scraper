"""Six collector modes with safe JSON output and a process-level deadline."""

import argparse
import json
import multiprocessing
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from dotenv import load_dotenv

from .contracts import BookingInput, CollectorError, Mode, Records, Target, amazon_url, indeed_url
from .parsers import parse_amazon, parse_booking, parse_indeed
from .transport import booking_html, fetch_html

ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Request:
    target: Target
    mode: Mode
    query: str
    url: str
    booking: BookingInput | None = None


def collect(request: Request) -> dict[str, object]:
    key: str | None = None
    records: Records
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".cache" / "ms-playwright"))
    if request.mode == "managed":
        load_dotenv(ROOT / ".env", override=False)
        key = os.environ.get("ZENROWS_API_KEY")
    if request.target == "booking":
        if request.booking is None:
            raise CollectorError("invalid_input", "Booking travel inputs are required.")
        page = booking_html(request.url, request.mode, key)
        records = parse_booking(page.html, page.url, request.booking)
    elif request.target == "amazon":
        page = fetch_html(request.url, request.target, request.mode, key)
        records = parse_amazon(page.html, page.url, request.query)
    else:
        page = fetch_html(request.url, request.target, request.mode, key)
        records = parse_indeed(page.html, page.url)
    return {
        "ok": True,
        "target": request.target,
        "mode": request.mode,
        "status": page.status,
        "count": len(records),
        "records": records,
    }


def _worker(request: Request, output: str) -> None:
    try:
        try:
            result = collect(request)
        except CollectorError as error:
            result = {
                "ok": False,
                "error": {"code": error.code, "message": error.message, "status": error.status},
            }
        except Exception:
            result = {
                "ok": False,
                "error": {
                    "code": "internal_error",
                    "message": "The collector failed unexpectedly.",
                },
            }
        Path(output).write_text(json.dumps(result, ensure_ascii=True), encoding="utf-8")
    except OSError, ValueError, TypeError:
        # A missing/invalid result is classified safely by the parent.
        return


def run_bounded(request: Request) -> dict[str, object]:
    seconds = (
        60.0 if request.target == "booking" else (200.0 if request.mode == "managed" else 40.0)
    )
    deadline = time.monotonic() + seconds
    context = multiprocessing.get_context("spawn")
    with tempfile.TemporaryDirectory(prefix="wsp-collector-") as folder:
        output = Path(folder) / "result.json"
        worker = context.Process(target=_worker, args=(request, str(output)), daemon=True)
        try:
            worker.start()
            worker.join(timeout=max(0.0, deadline - time.monotonic()))
            if worker.is_alive() or time.monotonic() >= deadline:
                raise CollectorError(
                    "timeout", "The collector did not finish within its process deadline."
                )
            if worker.exitcode != 0 or output.stat().st_size > 20_000_000:
                raise CollectorError(
                    "worker_failure", "The collector worker result is unavailable."
                )
            return cast(dict[str, object], json.loads(output.read_text(encoding="utf-8")))
        except OSError, ValueError:
            raise CollectorError(
                "worker_failure", "The collector worker did not return a valid result."
            ) from None
        finally:
            if worker.is_alive():
                worker.terminate()
                worker.join(timeout=1)
            if worker.is_alive():
                worker.kill()
                worker.join(timeout=1)
            if worker.pid is not None and not worker.is_alive():
                worker.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Web Scraper: one standard or managed results page."
    )
    parser.add_argument("target", choices=("amazon", "indeed", "booking"))
    parser.add_argument("--mode", choices=("standard", "managed"), default="standard")
    parser.add_argument("--query")
    parser.add_argument("--location")
    parser.add_argument("--destination")
    parser.add_argument("--checkin")
    parser.add_argument("--checkout")
    parser.add_argument("--adults", type=int)
    parser.add_argument("--rooms", type=int)
    args = parser.parse_args(argv)
    try:
        target, mode = cast(Target, args.target), cast(Mode, args.mode)
        booking = None
        if target == "booking":
            if any(
                value is None
                for value in (
                    args.destination,
                    args.checkin,
                    args.checkout,
                    args.adults,
                    args.rooms,
                )
            ):
                raise CollectorError(
                    "invalid_input", "Booking requires destination, dates, adults and rooms."
                )
            booking = BookingInput(
                args.destination, args.checkin, args.checkout, args.adults, args.rooms
            ).validated()
            url = booking.url()
        elif target == "indeed":
            url = indeed_url(args.query or "", args.location or "")
        else:
            url = amazon_url(args.query or "")
        result = run_bounded(Request(target, mode, (args.query or "").strip(), url, booking))
    except CollectorError as error:
        result = {
            "ok": False,
            "error": {"code": error.code, "message": error.message, "status": error.status},
        }
    except Exception:
        result = {
            "ok": False,
            "error": {"code": "internal_error", "message": "The collector failed unexpectedly."},
        }
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result.get("ok") is True else 1
