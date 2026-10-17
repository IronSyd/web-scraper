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
