# Browser PDF utilities

## Goal

Export one bounded local- or managed-browser PDF for a supported target, then inspect its actual readability separately.

## Context Pointers

Run from the project root after installing its pinned Node dependencies and Playwright Chromium. See [setup](../../docs/setup-verification.md), [architecture](../../docs/architecture.md) and [verification limits](../../docs/verification.md). The output directory must already exist. Existing output files are never overwritten.

```powershell
node tools/browser/pdf.js --mode local --target tiobe --output artifacts/tiobe-local.pdf
node --env-file-if-exists=.env tools/browser/pdf.js --mode remote --target tiobe --output artifacts/tiobe-remote.pdf
```

## Constraints

`--target` accepts only `tiobe` and `sannysoft`; `--mode` accepts only `local` and `remote`. Both example commands visit external target pages. Remote mode uses the server/CLI-only `ZENROWS_API_KEY` and consumes provider allowance. Choose exact operations, spending bounds and stop conditions before live use. Never pass a key in arguments or enable Playwright/Node debug logging.

The utility performs one navigation and at most one PDF, with no retries. Work is limited to 55 seconds, including connection (at most 15 seconds), navigation (at most 30 seconds) and remaining readiness/consent/print/export work. Browser close has a separate five-second limit; remote sessions also have the verified one-minute provider TTL. A close acknowledgement does not independently prove provider termination.

TIOBE requires all 20 ranks and names. Optional cookies are rejected only through its exact visible Cookiebot Deny control; unknown state or an existing optional-cookie choice stops the operation. Its print stylesheet hides the verified disjoint header/navigation/privacy-widget nodes and empty generated decoration on known body/content wrappers. Nonempty generated text, image content or counters stop before injection. Protected text, ranking names and meaningful image/SVG fingerprints and visibility must remain unchanged. Print-only overflow normalization, intact table rows/chart, repeating existing semantic table headers and 10mm PDF margins address print layout; Sannysoft keeps its original PDF options, requires its observed dynamic markers and makes no promise about detection scores.

## Done When

Successful export returns only a safe JSON receipt with byte count, SHA256, cleanup acknowledgement and `readable: "not_verified"`. A valid PDF header is not a readability pass. Inspect text, page structure and every rendered page before accepting an artifact. Real target readability and independent provider termination are not established by the offline synthetic fixture.

```powershell
node --test tools/browser/*.test.js
node node_modules/typescript/bin/tsc --noEmit -p tools/browser/tsconfig.json
```

The print-layout regression launches installed local Chromium with offline mode, route-fulfills one reserved `.invalid` fixture URL and aborts every other route. It uses synthetic source, data graphics and no credentials. It creates one local fixture PDF, verifies protected content/graphics, row/chart page containment and text geometry with the project verification Python environment, then renders every page with separately installed Poppler. The modeled wave and pagination failure demonstrate offline behavior; they do not establish current live theme CSS or certify either real target's readability. Local receipts/renders are written under the ignored `artifacts/tiobe-print-offline/` directory. Real target acceptance requires a bounded live operation and every-page inspection.
