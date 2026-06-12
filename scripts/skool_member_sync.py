#!/usr/bin/env python3
"""Nightly Skool member sync — flips users.allowlisted to match Skool's
current paid AI Mate roster.

Data source (in priority order):
1. Chrome extension POST to /api/admin/sync-members (if Andy has Skool open in
   his browser, the extension scrapes the member list and POSTs it). The
   extension writes the snapshot to `overnight/skool_members_snapshot.json`
   with the schema: [{"handle":"...","email":"...","status":"paid|free|churned"}].
   This script reads that file when present.
2. Manual roster file: `overnight/skool_members_manual.json`, same schema.
   Mike or Andy can edit this directly. Wins if newer than the Chrome snapshot.
3. SKOOL_ADMIN_KEY env var: if Skool ever exposes a real admin API, the call
   goes here. Currently no-op (raises if invoked).

Effect:
- Every handle in the roster with status=='paid' is UPSERTed and allowlisted=1.
- Every existing allowlisted user whose handle is in the roster with
  status!='paid' (or who is missing from the roster entirely) gets allowlisted=0
  and revoked_at=now. EXCEPTION: rows with allowlist_source in ('seed','manual')
  are never auto-revoked — those are explicit overrides, only the manual CLI
  can revoke them.

Run with --dry-run to preview changes without writing.

Cron entry (see scripts/skool_cron.sh):
    0 4 * * * cd /opt/idea_dashboard && python3 scripts/skool_member_sync.py >> logs/skool_sync.log 2>&1
"""
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DB = str(REPO / "videos.db")
SNAPSHOT_PATH = REPO / "overnight" / "skool_members_snapshot.json"
MANUAL_PATH   = REPO / "overnight" / "skool_members_manual.json"
NEVER_REVOKE_SOURCES = ("seed", "manual", "legacy")


def load_roster(verbose: bool = False) -> list[dict]:
    """Returns [{handle, email, status}, ...] from the best available source."""
    snap = SNAPSHOT_PATH.stat().st_mtime if SNAPSHOT_PATH.exists() else 0
    manl = MANUAL_PATH.stat().st_mtime   if MANUAL_PATH.exists()   else 0
    if not (snap or manl):
        if os.environ.get("SKOOL_ADMIN_KEY"):
            raise NotImplementedError(
                "SKOOL_ADMIN_KEY is set but no admin-API implementation exists yet. "
                "Wire it here when Skool ships one."
            )
        if verbose:
            print("no roster source found (snapshot or manual file)", file=sys.stderr)
        return []
    src = MANUAL_PATH if manl >= snap else SNAPSHOT_PATH
    if verbose:
        print(f"loading roster from {src}", file=sys.stderr)
    data = json.loads(src.read_text())
    if not isinstance(data, list):
        raise ValueError(f"{src} must be a JSON array")
    return data


def sync(db_path: str, dry_run: bool = False, verbose: bool = False) -> dict:
    roster = load_roster(verbose=verbose)
    paid    = {r["handle"].strip().lower(): r for r in roster if r.get("status") == "paid"}
    non_paid = {r["handle"].strip().lower(): r for r in roster if r.get("status") != "paid"}

    c = sqlite3.connect(db_path, timeout=30.0)
    c.row_factory = sqlite3.Row
    try:
        # Current state
        existing = {
            (r["skool_handle"] or "").strip().lower(): r
            for r in c.execute(
                "SELECT id, email, skool_handle, allowlisted, allowlist_source "
                "FROM users WHERE skool_handle IS NOT NULL AND skool_handle <> ''"
            )
        }

        added, reactivated, revoked, skipped_override = [], [], [], []

        # 1. UPSERT every paid handle, allowlist them
        for h, r in paid.items():
            email = (r.get("email") or f"{h}@skool.placeholder").strip().lower()
            row = existing.get(h)
            if row is None:
                if not dry_run:
                    c.execute(
                        "INSERT INTO users (email, skool_handle, allowlisted, "
                        "allowlist_source, allowlisted_at, revoked_at) "
                        "VALUES (?, ?, 1, 'sync', datetime('now'), NULL) "
                        "ON CONFLICT(email) DO UPDATE SET "
                        "  skool_handle = excluded.skool_handle, "
                        "  allowlisted = 1, "
                        "  allowlist_source = CASE "
                        "    WHEN users.allowlist_source IN ('seed','manual') THEN users.allowlist_source "
                        "    ELSE 'sync' END, "
                        "  allowlisted_at = COALESCE(users.allowlisted_at, datetime('now')), "
                        "  revoked_at = NULL",
                        (email, h),
                    )
                added.append(h)
            elif not row["allowlisted"]:
                if not dry_run:
                    c.execute(
                        "UPDATE users SET allowlisted = 1, "
                        "allowlist_source = CASE WHEN allowlist_source IN ('seed','manual') "
                        "  THEN allowlist_source ELSE 'sync' END, "
                        "revoked_at = NULL, "
                        "allowlisted_at = COALESCE(allowlisted_at, datetime('now')) "
                        "WHERE id = ?", (row["id"],),
                    )
                reactivated.append(h)

        # 2. Revoke anyone allowlisted who is no longer paid
        for h, row in existing.items():
            if not row["allowlisted"]:
                continue
            in_paid = h in paid
            in_non_paid = h in non_paid
            roster_says_gone = (not in_paid) and (in_non_paid or roster)  # only act when we actually have a roster
            if in_paid:
                continue
            if not roster_says_gone:
                continue
            if row["allowlist_source"] in NEVER_REVOKE_SOURCES:
                skipped_override.append(h)
                continue
            if not dry_run:
                c.execute(
                    "UPDATE users SET allowlisted = 0, revoked_at = datetime('now'), "
                    "allowlist_source = 'sync:revoked' WHERE id = ?", (row["id"],),
                )
            revoked.append(h)

        if not dry_run:
            c.commit()
    finally:
        c.close()

    return {
        "roster_paid":     len(paid),
        "roster_non_paid": len(non_paid),
        "added":           added,
        "reactivated":     reactivated,
        "revoked":         revoked,
        "skipped_override": skipped_override,
        "dry_run":         dry_run,
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=os.environ.get("DB_PATH", DEFAULT_DB))
    p.add_argument("--dry-run", action="store_true", help="Report changes without writing")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    result = sync(args.db, dry_run=args.dry_run, verbose=args.verbose)
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
