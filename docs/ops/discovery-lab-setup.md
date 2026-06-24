# Discovery v3 lab — setup, archive, and restore

Historical runbooks: [`2026-04-22-discovery-backfill-final-fix-rev2.md`](../../2026-04-22-discovery-backfill-final-fix-rev2.md)

## Volume layout (Hetzner)

| Path | Purpose |
|------|---------|
| `/mnt/HC_Volume_105468668/discovery_v3.duckdb` | Primary DuckDB activity store |
| `/mnt/HC_Volume_105468668/backfill/users.parquet` | HuggingFace source for rebuild |
| `/mnt/HC_Volume_105468668/trades.parquet` | Extra trade parquet |
| `/mnt/HC_Volume_105468668/duckdb_tmp/` | DuckDB spill (disposable) |
| `/mnt/HC_Volume_105468668/polymarket-staging-data/` | Staging app SQLite + keystores |

Production app data: `/opt/polymarket-bot/data`

## Environment variables

```env
DISCOVERY_ENABLED=false
DISCOVERY_V3=false
DUCKDB_PATH=/mnt/HC_Volume_105468668/discovery_v3.duckdb
DUCKDB_TEMP_DIR=/mnt/HC_Volume_105468668/duckdb_tmp
SORTED_PARQUET_DIR=/mnt/HC_Volume_105468668/bucket_parquets
DISCOVERY_LAB_ROOT=/mnt/HC_Volume_105468668
DISCOVERY_ARCHIVE_REMOTE=hetznerbox:ditto-discovery-archive
```

## Archive (before teardown)

```bash
# Configure rclone once: rclone config → name hetznerbox, type sftp
export DISCOVERY_ARCHIVE_REMOTE=hetznerbox:ditto-discovery-archive
bash scripts/archive-discovery-lab.sh
```

Small exports land in `archive/discovery-YYYY-MM/` in the repo. Large files upload to Storage Box.

## Restore (fast path)

1. Ensure ≥150 GB free on target volume
2. `rclone copy hetznerbox:ditto-discovery-archive/discovery-YYYY-MM/discovery_v3.duckdb $DUCKDB_PATH`
3. Restore scores from `archive/discovery-YYYY-MM/scores-v3-staging.json` if needed
4. Set `DISCOVERY_V3=true`, start `polymarket-discovery-worker.service`
5. Verify `GET /api/discovery/v3/health`

## Restore (rebuild path)

1. Restore `users.parquet` from Storage Box to `$DISCOVERY_LAB_ROOT/backfill/`
2. Run `scripts/backfill/finish_backfill.sh`
3. Run scoring pipeline (`04` → `05` → `06`)

## Tear down safely

```bash
bash scripts/archive-discovery-lab.sh   # verify upload first
bash scripts/teardown-discovery-lab.sh
```

With `DISCOVERY_V3=false`, hourly maintenance runs `scripts/cleanup-discovery-lab.sh` automatically.
