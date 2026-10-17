# Web Scraper API

## Goal

Collect, clean, persist and display Amazon, Booking, Indeed and TIOBE through durable saved runs. Reloading saved results/history never collects again.

## Context Pointers

- [Architecture and public API contract](../../docs/architecture.md).
- Entry: `server.js`; injectable application: `app.js`; HTTP/parsing: `transport.js`/`parsers.js`; Python boundary: `python-collectors.js`.
- Run validation: `run-contract.js`; lifecycle: `run-service.js`; Mongo storage/ownership/legacy compatibility: `mongo-runs.js`.
- [Source provenance](../../docs/provenance.md) and [observed verification](../../docs/verification.md).

## Constraints

The server binds loopback on port 3001 by default and rejects non-loopback Host/Origin values. Fresh collection requires size-limited application/json inputs. Set `WSP_COLLECTION_ENABLED=true` deliberately to allow new work; false or absent keeps saved results/history usable and disables fresh collection. The saved-data launcher uses disabled collection. Configure `MONGO_URI`, `PORT`, `TIOBE_URL`, server-only `ZENROWS_API_KEY` and optional `WSP_PYTHON_EXE` locally. Never put the provider key in a client variable, displayed URL, log or source file.

TIOBE uses its validated public index URL; Amazon uses one bounded ZenRows Fetch request. Indeed/Booking use supervised managed Python collectors with fixed executable/argv, bounded output and process-tree cleanup. TLS/debug refusal, deadlines, response caps and no-retry behavior apply. Plan live inputs, request limits and provider allowance before enabling collection; local timeout/cleanup does not guarantee provider termination or an account-wide spending cap.

Collection refuses `NODE_TLS_REJECT_UNAUTHORIZED=0` and nonempty `DEBUG`, `NODE_DEBUG`, `NODE_DEBUG_NATIVE` or `NODE_OPTIONS` overrides before making a request. Run ordinary development through the project scripts with verified TLS; this boundary prevents process debug settings from exposing authenticated request details.

`POST /api/runs` accepts exactly `{source,inputs,requestId}` with a client UUID. It saves a running record before dispatch and returns 202 `{run}`. Same-token/same-input replay returns the existing run (202 running, 200 terminal); mismatched reuse and distinct concurrent work return 409. One collection runs at a time, without an automatic queue/retry. HTTP disconnect does not cancel accepted work.

`GET /api/runs/:id` returns the saved full attempt; a running attempt can later become terminal, while successful snapshots remain immutable. `GET /api/runs/latest?source=...` returns the latest success or null. `GET /api/runs?source=&limit=&cursor=` returns summaries with a stable cursor, default 20/max 50. Every GET avoids collection. Existing Amazon/TIOBE routes read matching saved results or return 404; they do not collect on a cache miss.

New snapshots live in `collectionruns`. Existing `collectionbatches` stay untouched and appear as virtual legacy-cache runs with stable IDs and honest unknown original collection times. No TTL/purge/delete endpoint exists. A singleton PID/nonce owner refuses competing API instances; only confirmed-dead ownership permits startup recovery. Abandoned runs become interrupted failures without retry. Shutdown aborts active work; ambiguous persistence or unconfirmed cleanup blocks further collection. Previous successful runs remain available after later failures.

Source fields/inputs follow the current contract. Deterministic normalization/validation/deduplication preserves source meaning, price conditions and nullable missing fields. Unknown/challenge/zero-row pages fail conservatively. Public DTOs exclude Mongo/internal state; no LLM is involved.

`GET /api/health` returns `{status:"ok",collectionEnabled,activeRun}` without database or provider work. `activeRun` is `null` or `{id,source}` from the runtime's currently active collection; it is not derived from recent history. Health does not certify continuing database/provider availability. The frontend uses its local proxy and relative API paths. No public hosting/CORS exposure is configured.

## Done When

Run `node --test apps/api/test/*.test.js`, strict API checkJs, ESLint and Prettier with the pinned Node runtime. `tests/integration/runs.test.js` verifies actual local Mongo close/reopen persistence, all four fake source records, ownership/recovery, history and unchanged legacy values in an absent, nonce-owned disposable database. It never accesses the application database or credentials. The verification record distinguishes offline/local evidence from live source acceptance.
