# Peak10 Facility Dashboard Repo v3

This repo is a more functional local app build with:
- a React + TypeScript dashboard
- a FastAPI backend
- workbook upload and in-memory model registry
- actual workbook parsing for:
  - `CF`
  - `Strip Pricing`
  - `1-month Term SOFR`
  - `GRC Hedges`
  - `Brown Pony Hedges`
- a facility engine that uses the parsed monthly dataset

## Key assumptions
- Current-base replication uses PDP ResCat only:
  - `RSV_CAT == 1PDP`
  - `SCENARIO == PK10`
- Existing hedge payoffs are recomputed monthly using stressed strip prices.
- New acquisitions are assumed hedged at the stressed strip used in the scenario, so they do not create incremental hedge MTM / settlement benefit in that same scenario.
- PV10 is based on discounted remaining monthly cash flow, not a perpetuity proxy.

## Run backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

## Run frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend expects backend at `http://localhost:8000`.

## Next improvements
- persist uploaded models beyond process memory
- add scenario save/load to backend
- tighten close-test and ABS underwriting logic further
- export IC / lender views


## v4 fixes

- SOFR parsing now maps by `EoMonth` when present, with fallback to `Date`
- Added simple local run scripts:
  - `scripts/run_backend.sh`
  - `scripts/run_frontend.sh`

## Quick start

Backend:
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Frontend:
```bash
cd frontend
npm install
npm run dev
```


## v5 Aegis integration

This version adds a server-side Aegis integration layer using OAuth client_credentials and a cached bearer token.

### Environment variables

Set these in the backend environment:
- `AEGIS_CLIENT_ID`
- `AEGIS_CLIENT_SECRET`

### New endpoints

- `GET /api/aegis/ping`
- `GET /api/aegis/entities`
- `GET /api/aegis/combined-curves?as_of_date=YYYY-MM-DD&product_codes=R,H&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`
- `POST /api/aegis/refresh-strip-from-aegis`

### Notes

- Secrets are not stored in the repo.
- Browser calls should always go through the backend.
- Combined curves are normalized to monthly rows.
