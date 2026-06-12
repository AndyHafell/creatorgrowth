#!/bin/bash
# Safe rebuild: commits current code state before rebuilding the container.
# Live DBs (videos.db, ideas.db, dashboard.db) are excluded via .gitignore so
# `git reset --hard` during deploys can't clobber prod data with a stale copy.
#
# Usage: ./rebuild.sh [optional commit message]

set -e
cd /opt/idea_dashboard

MSG="${1:-auto-save before rebuild}"

# Commit code changes only — never the live DB files.
if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "$MSG"
    echo "Committed: $MSG"
else
    echo "No changes to commit"
fi

echo "Current version: $(git describe --tags --always)"
echo "Rebuilding container..."
cd /root && docker compose up -d --build idea-dashboard
echo "Done. Container rebuilt."
