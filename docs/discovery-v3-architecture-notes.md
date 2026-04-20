# Discovery v3 — Architecture Notes

_Last updated: 2026-04-20_

## Summary

Discovery v3 is the full rebuild of wallet discovery with tiered scoring
(alpha / whale / specialist) and point-in-time-pure historical replay. All
code is additive, gated on `DISCOVERY_V3=true`, and landed in a single PR
(branch `discovery-v3-rebuild`).

## What changed vs. legacy discovery

| Concern | Legacy | v3 |
|---|---|---|
| Scoring dimensions | single composite | three tiers, each its own z-score blend |
| Eligibility | implicit | explicit gate (span 30d, ≥10 markets, ≥20 trades, ≥5 closed, ≤45d dormant) |
| Historical store | SQLite only | DuckDB (analytics) + SQLite (read model) |
| Backfill | on-demand API scrape | parquet-based batch via HuggingFace dataset |
| Live ingest | polling data-api | Goldsky OrderFilled subgraph (5-min cadence) |
| Point-in-time purity | none | snapshots enforce `ts < day_end` and `market.end_date ≤ snapshot_day` |

## Data flow

```
Goldsky OrderFilled ──► normalizeOrderFilled ──► DuckDB discovery_activity_v3
                                                          │
HF parquet (backfill) ───► COPY INTO DuckDB ──────────────┤
                                                          ▼
                                            buildSnapshotEmitSql()
                                                          │
                                                          ▼
                                       discovery_feature_snapshots_v3
                                                          │
                                                          ▼ scoreTiers()
                                              discovery_wallet_scores_v3
                                                          │
                                                          ▼
                                              SQLite (hot read model)
                                                          │
                                                          ▼
                                                 /api/discovery/v3/*
                                                          │
                                                          ▼
                                                   /discovery-v3/ UI
```

## Non-obvious design choices

- **Maker + taker split:** each OrderFilled event writes two rows. Taker
  `log_index` is offset by `+1_000_000_000` to preserve `UNIQUE(tx_hash,
  log_index)` — we cannot have two rows with the same pair even though the
  chain-level event shares one log.
- **Python-list outcome_prices:** the HF dataset stores prices as
  `"['0.55', 'None']"` (Python repr). The markets ingest query chain-replaces
  `'None'` → `null` before the quote conversion, so downstream JSON parsing
  works.
- **Dedup inside backfill source:** `buildEventIngestSqlAntiJoin` first
  `ROW_NUMBER()`s over `(tx_hash, log_index)` to collapse in-source
  duplicates *before* the anti-join against existing rows.
- **Determinism:** snapshots are fully DELETE+rebuild on every refresh tick
  — no incremental writes. Byte-identical across runs for a fixed input.
- **Eligibility is ex-post:** `scoreTiers` keeps ineligible wallets out of
  the output but records their eligibility reasons in stats for diagnostics.

## Scripts

- `scripts/backfill/00_fetch_parquet.ts` — pulls markets.parquet; refuses
  users.parquet if <70GB free (fails with code 2 + manual instructions).
- `02_load_events.ts --source-url URL --limit N --sample-report` — supports
  sandbox sampling via httpfs.
- `06_validate.ts` — spot-checks 20 wallets against data-api activity
  totals (1% tolerance).

## Cutover flag matrix

| `DISCOVERY_V3` | `DISCOVERY_V3_LEGACY_WRITES` | Effect |
|---|---|---|
| unset / false | any | v3 invisible (all 404s), legacy unchanged |
| true | unset | v3 live, legacy writes blocked by `legacyMode.ts` |
| true | true | v3 live, legacy writes still allowed (dual-write window) |

## Tests (on this branch)

- `tests/v3-eligibility.test.ts` — truth table incl. edge cases
- `tests/v3-schema.test.ts` — DDL idempotency + UNIQUE enforcement
- `tests/v3-backfill-mapping.test.ts` — synthetic parquet roundtrip
- `tests/v3-snapshot-purity.test.ts` — determinism (sha256 equal) + point-in-time
- `tests/v3-scoring.test.ts` — tier rankings + eligibility exclusion
- `tests/v3-goldsky-listener.test.ts` — normalize + dedup + cursor advance
- `tests/v3-api.test.ts` — all 9 endpoints (flag-on shape, flag-off 404)
- `tests/v3-legacy-mode.test.ts` — flag matrix
