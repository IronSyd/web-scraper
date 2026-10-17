# Setup and verification

## Goal

Install the pinned local Web Scraper environment, start a collection-disabled app and run its maintained offline checks without depending on another application's runtime paths.

## Context Pointers

- [README](../README.md) and [demo runbook](demo-runbook.md).
- [Launcher](../scripts/Run.ps1), [JavaScript package](../package.json) and [Python project](../pyproject.toml).
- [Observed verification and limits](verification.md).

## Constraints

The maintained launcher and hash locks target **Windows AMD64**. Use Node **24.22.0**, pnpm **11.28.6**, Python **3.14.8** and Docker with Linux containers. MongoDB **8.0.34** is selected by the digest-pinned Compose image. The launcher requires the exact Node version. A different platform or runtime needs its own reviewed lock and verification; cross-platform execution is not established by these instructions.

Dependency and browser installation can download packages. Offline tests do not need ZenRows credentials, provider calls or target scraping. Do not copy an existing `.env`, database volume, private key or local artifacts into a repository.

## Install

From the repository root, verify the selected runtime versions:

```powershell
node --version
pnpm --version
py -3.14 --version
```

Expected results are `v24.22.0`, `11.28.6` and `Python 3.14.8`. Install those versions using your usual runtime tooling before continuing if they differ. Then install the locked dependencies and local browser:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
py -3.14 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --require-hashes --only-binary=:all: -r requirements.lock
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.cache\ms-playwright'
node node_modules/playwright/cli.js install chromium
```

Dependency scripts are disabled. The selected Playwright install uses Chromium revision 1248 in the ignored project cache. The Python lock contains Windows/CPython 3.14 wheel hashes; do not remove hash enforcement to make another environment appear supported.

No credentials are needed to start the empty or previously populated saved-data workspace:

```powershell
docker compose up -d mongo
& .\scripts\Run.ps1 api-offline
```

Run `& .\scripts\Run.ps1 web` in another PowerShell window and open [Webby](http://127.0.0.1:5174). The first database start is empty. No sample data is inserted automatically.

The default API/Mongo ports are 3001/27017 on loopback. The Vite proxy expects API port 3001. Process-level `PORT`/`MONGO_URI` overrides still apply in offline mode; keep the API and proxy configuration consistent.

### Optional collection configuration

The blank [.env.example](../.env.example) documents server-side settings. Copy it to the ignored `.env` only when preparing deliberate live use. Add a local ZenRows key privately; never put it in frontend variables or command arguments. `api-offline` skips that file. `scripts/Run.ps1 api` explicitly loads it and enables collection, so it is a live command rather than an installation check.

### Node selection

The launcher uses `WSP_NODE_EXE` if supplied; otherwise it resolves the first `node` executable on PATH. Either must report exactly `v24.22.0`. An invalid override fails rather than falling back silently. PATH and other launcher environment changes are scoped to its execution and restored afterward.

### Verification packages and Poppler

Install the separately hash-locked PDF inspection tools for the full check:

```powershell
& .\.venv\Scripts\python.exe -m pip install --require-hashes --only-binary=:all: -r requirements-verification.lock
```

This lock includes the core dependencies plus PDF inspection dependencies. Install native **Poppler** separately and make `pdftoppm` available on PATH. Alternatively, set `WSP_PDFTOPPM_EXE` to the existing absolute path of your `pdftoppm.exe` in the PowerShell session used for verification. The project does not install native Poppler or change machine configuration automatically.

PDF checks use `.venv/Scripts/python.exe`. `WSP_PDF_PYTHON_EXE` can select another existing absolute interpreter with the same verification dependencies. Missing packages or renderer fail the check; they are not borrowed silently or skipped.

The PDF regression checks protected text, complete ranking rows, repeated headers, page dimensions, chart geometry and clipping, then renders **every page at 120 DPI**. Its synthetic fixture blocks external requests. A passing fixture does not certify live target PDF readability.

## Run checks

Start local MongoDB for the guarded integration tests, then run:

```powershell
& .\scripts\Run.ps1 check
& .\scripts\Run.ps1 build
& .\scripts\Run.ps1 e2e
```

`check` runs formatting, lint, strict API/web/browser JavaScript diagnostics, API/browser/PDF and Mongo integration tests, Python lint/format/type/compile/tests and `pip check`. Integration tests use disposable guarded namespaces and fake collectors, not application storage. The browser suite uses its own Vite port 5184, intercepts API calls and blocks unmatched external requests. Keep port 5184 free.

To run only the PDF regression with the selected Node on PATH:

```powershell
node --test tools/browser/print-layout.test.js
```

## Done When

The selected runtime versions and prerequisites are present, Webby opens with collection paused, and actual check/build/browser commands pass. Record failures honestly. The published source and these instructions do not establish that a fresh-machine installation or hosted CI run has been performed.
