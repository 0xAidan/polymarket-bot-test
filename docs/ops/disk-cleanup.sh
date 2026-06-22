#!/usr/bin/env bash
# Phase 0A disk emergency cleanup for Ditto production host.
# Target: ≥20% free on /. Safe to re-run.
set -euo pipefail

echo "=== Before ==="
df -h /

USE_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
FREE_PCT=$((100 - USE_PCT))
echo "Free on /: ${FREE_PCT}%"

if [ "$FREE_PCT" -lt 20 ]; then
  echo "=== Running cleanup (free < 20%) ==="
  sudo systemctl stop polymarket-discovery-worker.service 2>/dev/null || true
  sudo systemctl stop polymarket-discovery-worker-staging.service 2>/dev/null || true
  sudo systemctl disable polymarket-discovery-worker.service 2>/dev/null || true
  sudo journalctl --vacuum-size=200M || true

  # Stale deploy backups (never delete active data/)
  rm -rf /opt/polymarket-bot/data.backup-* 2>/dev/null || true
  rm -rf /opt/polymarket-bot-staging/data.bak-on-root 2>/dev/null || true
  rm -rf /opt/polymarket-bot-staging/data.backup-* 2>/dev/null || true
  rm -rf /opt/polymarket-bot-staging/data.local-backup-* 2>/dev/null || true
  rm -f /opt/polymarket-bot/.env.backup* 2>/dev/null || true
  rm -f /opt/polymarket-bot-staging/.env.backup* 2>/dev/null || true

  # Syslog rotation when journal vacuum is not enough
  if [ -f /var/log/syslog.1 ] && [ "$(df / | tail -1 | awk '{print $5}' | tr -d '%')" -gt 95 ]; then
    echo "Truncating oversized syslog.1"
    sudo truncate -s 0 /var/log/syslog.1 || true
  fi

  if [ -x /opt/polymarket-bot/scripts/disk-maintenance.sh ]; then
    APP_DIR=/opt/polymarket-bot bash /opt/polymarket-bot/scripts/disk-maintenance.sh || true
  fi

  sudo systemctl start polymarket-discovery-worker-staging.service 2>/dev/null || true
else
  echo "=== Skipping cleanup (free >= 20%) ==="
fi

echo "=== After ==="
df -h /
USE_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
echo "Free on /: $((100 - USE_PCT))%"
