# Python collectors

## Goal

Collect one results page from Amazon books, Indeed or Booking using standard transport or ZenRows managed transport. Return normalized JSON or an explicit safe error.

## Context Pointers

Run from the repository root with the pinned `.venv` interpreter. `collect.py` is the CLI entry; `web_scraper/contracts.py`, `parsers.py` and `transport.py` separate public contracts, pure parsing and external I/O. See [setup](../../docs/setup-verification.md), [source provenance](../../docs/provenance.md) and [verification](../../docs/verification.md).

```powershell
.venv\Scripts\python.exe collectors/python/collect.py amazon --query "python programming" --mode standard
.venv\Scripts\python.exe collectors/python/collect.py indeed --query "data analyst" --location "Chicago, IL" --mode standard
.venv\Scripts\python.exe collectors/python/collect.py booking --help
```

Replace `--mode standard` with `--mode managed` for the other three modes. Booking additionally requires `--destination`, future `--checkin`/`--checkout` in `YYYY-MM-DD` form, positive `--adults` and `--rooms`; there are no default travel dates or destinations. The Amazon/Indeed examples make real external requests. Choose exact inputs and request/spending limits before running; managed modes consume provider allowance. `--help` alone is a local usage check.

## Constraints

- Standard Amazon/Indeed use one Requests GET; standard Booking uses local Playwright Chromium. Managed Amazon/Indeed use one ZenRows Fetch GET with the fixed verified flags; managed Booking uses one CDP session/navigation and the existing page. No scrolling, pagination, retry or automatic fallback.
- Managed mode loads the ignored root `.env` only in the collector worker. The key stays out of JSON, logs and browser-facing frontend code. Standard mode does not load `.env`. Browser binaries use the shared local `.cache/ms-playwright` cache.
- Managed browser use refuses driver-debug/Node override variables before allocation; managed transports refuse an explicit disabled-TLS environment setting. Any browser-close failure reports cleanup as unconfirmed, including after another error. HTTP 202 alone is inconclusive: recognized, validated hotel cards may succeed, while a 202 response whose cards never become ready reports a verification failure.
- Fetch work uses a 190-second cumulative check plus a 200-second parent deadline; standard HTTP uses 30/40 seconds. Requests connect/read timeouts do not by themselves enforce a universal wall-clock deadline, so the parent process terminates a stalled worker. Booking work is cumulative 55 seconds, with a nominal 60-second parent and `session_ttl=1m` remotely. OS startup/termination can overrun; client cleanup does not establish immediate remote termination or a credit cap.
- Unknown, challenged and zero-result pages are errors, never fabricated successful empty arrays. A missing required title/name/identity/URL fails the collection. Optional values stay missing. No result is cached by these independent CLIs.
- Booking requires matching dates/occupancy on hotel links, keeps only non-secret travel context, uses the labeled stay price rather than the per-night value, and does not claim taxes/fees inclusion. Currency is explicit, rating source text and review counts validated integers.
- Amazon deduplicates ASINs, preferring the first non-sponsored placement without merging offers. Price display preserves format, membership qualifications and alternate purchase text; authors may be links or spans. The `reviews` field retains source-labeled ratings-count text. URL identity and image hosts are validated.

## Done When

Deterministic tests, formatting/lint and strict type checks pass. Managed Indeed and Booking also completed one bounded dashboard collection-to-storage acceptance on 17 October 2026. This does not establish every CLI mode or future source availability; the current [verification record](../../docs/verification.md) distinguishes those scopes. Independent CLI results are not persisted to the dashboard database.

The first implementation passed 59 offline tests, including an actual Windows-spawn worker that returns an input failure without reading `.env` or reaching a transport. The parent waits for the worker's exit before reading one bounded temporary public-result JSON file; it never blocks on a partially written pipe payload. Temporary results are removed after collection.

```powershell
.venv\Scripts\python.exe -m ruff check collectors/python
.venv\Scripts\python.exe -m ruff format --check collectors/python
.venv\Scripts\python.exe -m mypy --strict --python-version 3.14 collectors/python/web_scraper
.venv\Scripts\python.exe -m pytest -q collectors/python/tests
```
