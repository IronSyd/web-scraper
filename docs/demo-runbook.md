# Webby demo runbook

## Goal

Demonstrate collecting, cleaning, saving and browsing records from Amazon, Booking.com, Indeed and TIOBE, using previously saved local snapshots with fresh collection paused.

## Context Pointers

- [Setup and verification](setup-verification.md).
- [Architecture and API](architecture.md).
- [Observed verification and limits](verification.md).
- [Local launcher](../scripts/Run.ps1).

## Constraints

The saved-data walkthrough does not make provider or target collection requests. A new clone has an empty database: no scraped data or database backup is included. Do not insert presentation fixtures into application storage. Use genuine locally saved runs when available, or demonstrate the honest empty state.

Saved covers and icons may still load from external image hosts. Do not select result links during a walkthrough that must avoid visiting external sites. Missing images do not invalidate saved text records.

## Done When

Webby shows **Fresh collection paused**, source and history views load, any available saved run reopens after refresh, and the presenter distinguishes a recorded snapshot from current source availability.

## Start

Prepare runtimes, dependencies and Docker before presenting; avoid reinstalling or upgrading immediately beforehand. From the project folder in PowerShell:

```powershell
docker compose up -d mongo
& .\scripts\Run.ps1 api-offline
```

In a second PowerShell window:

```powershell
& .\scripts\Run.ps1 web
```

Open [Webby](http://127.0.0.1:5174). The frontend expects the API on port 3001; MongoDB uses loopback port 27017 and the API defaults to the `web_scraper` database. Existing process-level `MONGO_URI` and `PORT` overrides still apply. Keep the intended database configuration; changing it can select a different, empty database.

Confirm the header says **Fresh collection paused** and **Collect fresh data** is disabled. The read-only [health endpoint](http://127.0.0.1:3001/api/health) should show `status: "ok"`, `collectionEnabled: false` and `activeRun: null`. Health alone does not certify database availability: open History and an available saved run too.

The offline launcher skips `.env` and requires no provider credential for saved reads. It does not erase variables inherited from the parent process. If collection is available, stop that API normally and restart with `api-offline` before presenting.

## Walkthrough

1. **Overview:** introduce the four sources, their purposes and recent saved activity. Recent history is not an all-time total or a live feed.
2. **Amazon:** show a saved book snapshot when available, including authors, qualified price, rating, review information and source links. Missing optional fields remain visibly unavailable.
3. **Booking.com:** show saved stays, requested dates/occupancy and the original stay-price qualifications. A captured price is not a current booking offer.
4. **Indeed:** show saved jobs, company/location fields and canonical source links. A saved job is not proof the vacancy remains open.
5. **TIOBE Index:** show the saved top-20 table and its time metadata. It describes the captured ranking.
6. **History:** filter by source, open a saved run and inspect requested inputs, outcome, snapshot count and timestamps. Paginate only when another page exists.
7. **Persistence:** refresh a saved-run URL. Existing records should reload through local GET requests without initiating collection.
8. **Responsive navigation:** narrow the browser, open the sidebar drawer and return to Overview.

Suggested introduction: “Webby collects source-specific records, validates and cleans them, saves snapshots in MongoDB, and lets us reopen results and history. This walkthrough uses saved data with fresh collection paused.”

Entering new form inputs does not filter or replace an old snapshot while collection is paused. A later failed collection is distinct from the previous successful results. Legacy records can have an unknown original collection time; preserve that label.

## Collection indicator

During a deliberately enabled collection, the global header names the source, such as **Collecting Indeed…**. A saved terminal outcome is verified before showing **Indeed collection complete** or **Indeed collection failed** for ten seconds. It then returns to the current availability label. Unavailable status is reported instead of inventing success.

Header detection uses local polling and same-tab admission notifications. A very short other-tab run entirely between idle polls may not appear in the header. There is no percentage estimate or real-time push channel.

## Stop and recover

- Press `Ctrl+C` in the frontend and API windows, allowing normal API shutdown. Then run `docker compose stop mongo` to retain saved records.
- For a port conflict or second-runtime guard, stop the previous process normally before starting another. Do not bypass database ownership records or terminate unrelated processes.
- If saved reads fail, confirm Docker/MongoDB are running and restart the offline API and frontend. Keep the intended database configuration. Do not reset storage to fix a read error.
- If a view is empty, use a genuinely saved run from History or present the empty state. An API failure is not proof that records were deleted.
- Do not run `docker compose down -v` or remove the Mongo volume unless deliberate data deletion is intended.

## Optional live walkthrough

Real collection requires a separate operational decision: choose exact inputs, request count, allowance/spending bounds and stop conditions first. Configure the local ignored `.env`, then use `scripts/Run.ps1 api` to enable collection. Managed Amazon/Indeed/Booking can consume provider allowance; TIOBE also makes an external request. The code does not enforce an account-wide credit budget.

Keep credentials server-side, avoid debug logging and return to `api-offline` afterward. A previous successful collection is evidence of that attempt, not a guarantee of future target or provider availability. Browser/PDF tools are separate from the four-source saved-data walkthrough.
