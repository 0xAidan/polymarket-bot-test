# Discovery v3 Backfill Pipeline

Ingests ~4 years of historical Polymarket trades from the
[SII-WANGZJ/Polymarket_data](https://huggingface.co/datasets/SII-WANGZJ/Polymarket_data)
HuggingFace dataset into the v3 DuckDB sidecar. See
`2026-04-20-discovery-backfill-addendum.md` for the full rationale.

## Prerequisites

- Node 20+, `npm install` already done (`duckdb@^1.1.0` is in `package.json`).
- **~70 GB free disk** (to hold `users.parquet` locally) OR use the `--source-url`
  flag on `02_load_events.ts` to stream over `httpfs` (slower, no local copy).
- `DISCOVERY_V3=true` in your env (so the SQLite hot-read tables are also created).
- `DUCKDB_PATH=./data/discovery_v3.duckdb` (default).

## Run order

```bash
# 1. Download parquet files into ./data/ (checksums verified from HF)
tsx scripts/backfill/00_fetch_parquet.ts

# 2. Initialize DuckDB file + schema (idempotent)
tsx scripts/backfill/01_init_duckdb.ts

# 3. Load events (single INSERT; supports --limit and --source-url for sampling)
tsx scripts/backfill/02_load_events.ts
# Sandbox sampled proof (no local parquet needed):
tsx scripts/backfill/02_load_events.ts \
  --source-url https://huggingface.co/datasets/SII-WANGZJ/Polymarket_data/resolve/main/users.parquet \
  --limit 500000

# 4. Load markets dimension (Python-list outcome_prices parsed to JSON)
tsx scripts/backfill/03_load_markets.ts

# 5. Emit point-in-time daily snapshots
tsx scripts/backfill/04_emit_snapshots.ts

# 6. Apply eligibility + compute tier scores, write SQLite hot read model
tsx scripts/backfill/05_score_and_publish.ts

# 7. 20-wallet spot check against the Data API
tsx scripts/backfill/06_validate.ts
```

## Flags

All scripts accept `--help`. Common ones:

- `--limit N` — cap input rows (used for sandbox proof).
- `--source-url URL` — read parquet over `httpfs` instead of local file.

## Determinism

`04_emit_snapshots.ts` is deterministic — running it twice on the same event
set produces byte-identical snapshot rows. This is exercised by
`tests/v3-snapshot-purity.test.ts`.

## Storage layout

- **DuckDB** (`./data/discovery_v3.duckdb`): raw events, markets, snapshots.
- **SQLite** (`./data/copytrade.db`): hot read model (`discovery_wallet_scores_v3`)
  + `pipeline_cursor`.

The API reads only from SQLite; DuckDB is the compute sidecar.
