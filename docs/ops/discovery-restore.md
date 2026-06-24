# Discovery archive restore

See also: [discovery-lab-setup.md](./discovery-lab-setup.md)

## Prerequisites

- Hetzner Storage Box configured in rclone (`hetznerbox` remote)
- `archive/discovery-YYYY-MM/manifest.json` in repo (checksums + paths)
- Target host has enough disk for DuckDB (~130 GB)

## Fast restore (~1–2 hours)

```bash
export DUCKDB_PATH=/mnt/HC_Volume_105468668/discovery_v3.duckdb
export ARCHIVE_TAG=discovery-2026-06

rclone copy "hetznerbox:ditto-discovery-archive/$ARCHIVE_TAG/discovery_v3.duckdb" "$(dirname "$DUCKDB_PATH")/"
rclone copy "hetznerbox:ditto-discovery-archive/$ARCHIVE_TAG/discovery_v3.duckdb.wal" "$(dirname "$DUCKDB_PATH")/" || true

# Verify checksum against archive/discovery-2026-06/manifest.sha256
sha256sum "$DUCKDB_PATH"

# Enable Discovery in .env
DISCOVERY_V3=true
DISCOVERY_ENABLED=true

sudo systemctl enable --now polymarket-discovery-worker.service
curl -s http://127.0.0.1:3002/health
```

## Rebuild from parquet (if DuckDB lost)

```bash
export DISCOVERY_LAB_ROOT=/mnt/HC_Volume_105468668
export DUCKDB_PATH=$DISCOVERY_LAB_ROOT/discovery_v3.duckdb
export SORTED_PARQUET_DIR=$DISCOVERY_LAB_ROOT/bucket_parquets
export DUCKDB_TEMP_DIR=$DISCOVERY_LAB_ROOT/duckdb_tmp

mkdir -p "$DISCOVERY_LAB_ROOT/backfill"
rclone copy hetznerbox:ditto-discovery-archive/$ARCHIVE_TAG/users.parquet "$DISCOVERY_LAB_ROOT/backfill/"

cd /opt/polymarket-bot
DISCOVERY_V3=true bash scripts/backfill/finish_backfill.sh
```

## Scores-only restore

```bash
sqlite3 /path/to/copytrade.db <<'SQL'
.mode json
.read archive/discovery-2026-06/scores-v3-staging.json
SQL
```

Prefer re-running `05_score_and_publish` after activity data is restored.
