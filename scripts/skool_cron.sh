#!/usr/bin/env bash
# Nightly Skool member sync, wired into the VPS crontab.
#
# Install once:
#   ( crontab -l 2>/dev/null; echo "0 4 * * * /opt/idea_dashboard/scripts/skool_cron.sh" ) | crontab -
#
# The 4am UTC slot is after the Skool snapshot cron (assumed) writes
# overnight/skool_members_snapshot.json. If the Chrome extension hook is the
# data source instead, this can run any time of day — pick a quiet hour.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
{
    echo ""
    echo "=== skool_member_sync $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    python3 scripts/skool_member_sync.py -v
} >> logs/skool_sync.log 2>&1
