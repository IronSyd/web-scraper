# Verification and limits

## Goal

State what has actually been checked, how to repeat the maintained local checks and which claims those results do not establish.

## Context Pointers

- [Setup prerequisites and commands](setup-verification.md).
- [Architecture](architecture.md) and [demo runbook](demo-runbook.md).
- [API tests](../apps/api/test), [Python tests](../collectors/python/tests), [browser tests](../tests/e2e), [guarded Mongo tests](../tests/integration) and [browser/PDF tests](../tools/browser).

## Observed checks

The following results were observed in the prepared Windows AMD64 environment on **17 October 2026** after the source-aware header increment. They are local results, not hosted CI or a fresh-machine installation claim.

| Check                            | Observed result                                                                                                                                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/Run.ps1 check`          | Passed: 209 Node tests (190 API, 17 browser/PDF and 2 guarded Mongo integration), 59 Python tests, strict API/web/browser JavaScript diagnostics, ESLint/Prettier, Ruff lint/format, strict mypy, compileall and `pip check`. |
| `scripts/Run.ps1 build`          | Passed; production frontend build, 51 modules.                                                                                                                                                                                |
| `scripts/Run.ps1 e2e`            | 126 passed, zero failures, six expected skips across desktop/wide/tablet/mobile. Four skips cover drawer cases in permanent-sidebar desktop layouts; two restrict header screenshot capture to desktop/mobile.                |
| Header visual review             | Active, complete and failed states inspected at desktop and mobile sizes; no material clipping, overlap or legibility defect observed.                                                                                        |
| Existing saved-data preservation | Collection-disabled health and saved-run reads verified after restart; all four existing source snapshots remained unchanged.                                                                                                 |

Controlled API/browser tests cover saved-data reloads, history/filtering/pagination, collection admission/idempotency, prior-success preservation, errors, cancellation/recovery, validation and header activity/outcome races. Browser fixtures intercept API calls and abort unmatched/external requests. Mongo integration tests use disposable guarded namespaces and fake collectors, not the application database.

The offline PDF fixture verifies protected text/graphics, all ranking rows, repeated headers, page geometry and clipping, and renders every page at 120 DPI. Missing inspection packages or native renderer fail rather than silently skipping checks.

## History management checks — 19 October 2026

The local Archive/Restore and confirmed Delete increment passed **214 Node tests** (including two guarded Mongo integration tests), **59 Python tests** and **182 offline browser cases**, with six expected browser skips and zero failures in the final runs. The browser matrix covered desktop, wide desktop, tablet and mobile; its intercepted API blocked external traffic and never submitted collection to the application API.

Strict API/web/browser JavaScript diagnostics, ESLint over all 52 maintained JavaScript files, whole-project Prettier, Ruff lint/format, strict mypy, compileall, `pip check`, `git diff --check` and the 53-module frontend build passed. Independent source review found no blocking issue. Batched synthetic screenshots confirmed readable archived-history controls and confirmation dialogs at all four sizes. Initial dialog focus failures were corrected before the final browser run.

Controlled cases cover persistence/reopen, immutable legacy archive bytes, latest-result fallback, pre-limit filtering, confirmed/cancelled deletion, keyboard focus, running guards, concurrent mutations, minimal tombstones, malformed metadata and deleted UUID replay without dispatch. The real API was restarted only after an idle check, retaining enabled mode for the user's self-operated demo. Saved-data GETs confirmed the new DTO/filter contract; before/after raw stored-data hashes matched. No real snapshot was archived/deleted and no scraping call ran during verification.

The earlier three browser-global lint errors in a private documentation-preview helper were corrected with explicit browser-global references, without disabling rules. A fresh `scripts/Run.ps1 check` passed the full-workspace lint, formatting, strict diagnostics, all 214 Node tests and 59 Python tests, plus the Python checks above. The helper correction remains local and is not part of the published source. Its isolated desktop/mobile diagram preview passed with zero network attempts; historical publication receipts were preserved.

## Repository presentation checks — 19 October 2026

Five refreshed interface screenshots use only fictional in-memory fixtures: desktop Overview, Indeed saved results, History controls, delete confirmation and mobile Overview. All image bytes and dimensions were checked against their capture receipt and visually reviewed. The isolated browser intercepted eight fixture GETs and128 local asset reads, with zero external or mutation requests and no browser errors. It never contacted the application database or production API.

The architecture diagram now includes a separate guarded History-management path, alongside collection and saved reads. Local rendering and exact regeneration pass with13nodes/20edges, accessible SVG title/description, unclipped text and no active/external SVG content. The collection-flow diagram remains unchanged. PNGs, scalable SVGs and editable Mermaid sources are retained so documentation display does not depend on GitHub's interactive diagram renderer.

These are local documentation checks, not evidence of public deployment, current upstream availability or live scraping. Screenshots remain explicitly labeled illustrative; source attribution and existing licensing limits remain documented.

## Live evidence

One bounded Indeed and Booking collection-to-storage acceptance completed on 17 October 2026, with successful full-run/latest/history reads and browser reloads afterward. Existing Amazon and TIOBE legacy snapshots were preserved and reloaded; those sources were not recollected in that batch.

The original legacy collection times are unknown. Historical saved data is not a claim of current availability. Scraped snapshots, local database volumes, acceptance inputs/identifiers and account receipts are not included in this repository; a new clone starts empty.

## Constraints and remaining limits

- **Changing sources:** target markup, access rules, provider features and allowances can change. Deterministic tests and one successful live attempt do not guarantee future collection success or undetectability.
- **Empty upstream results:** unknown, challenged or unrecognized zero-result pages fail conservatively. Genuine target empty states require explicit recognized evidence rather than an invented successful empty array.
- **Provider cost:** manual collection can consume allowance. Timeouts, session TTL and response limits are not account-wide credit caps; remote close acknowledgement does not independently certify the end of provider billing.
- **Header polling:** status is observed through local GETs and same-tab notifications, not a real-time push connection. A fast other-tab run between idle polls can be missed. Terminal disappearance alone never earns a success label.
- **Browser/PDF utilities:** successful export reports readability as unverified. Synthetic layout checks do not certify the current live target's typography/layout or every real exported page.
- **Local security:** loopback/Host/Origin checks do not provide user authentication or make public deployment suitable. Production hosting, monitoring, multi-user access control and rollback orchestration are separate work.
- **Portability:** the launcher and maintained PDF checks no longer require another application's installation paths. This does not prove installation on a fresh Windows machine or another operating system. Native Poppler remains an explicit prerequisite.
- **External images:** saved-data page reads do not collect, but source-hosted covers/icons may still load. Strict browser network isolation requires controlled routing outside normal app behavior.
- **Accessibility:** keyboard, drawer, reduced-motion and state behavior have controlled coverage; visual review is not a screen-reader or WCAG certification.

## Done When

Re-run the documented commands in the intended environment after relevant changes, retain actual failures and limitations, and investigate newly changed source/provider behavior before relying on it. A build is a local artifact, not evidence of deployment or recurring reliability.
