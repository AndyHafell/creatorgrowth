#!/usr/bin/env python3
"""Manual allowlist CLI for creatorgrowth's Skool member gate.

Use when onboarding (or evicting) a Skool member. The nightly sync handles
the bulk path; this is the manual-override hatch for when sync is down or
for one-off cases (founders, team, free trial extension).

Examples:
    python3 scripts/skool_allowlist.py add   --handle theaiandy   --email andhaf94@gmail.com
    python3 scripts/skool_allowlist.py add   --handle mike-skool                                   # email optional, derived later
    python3 scripts/skool_allowlist.py revoke --handle some-handle --reason "churned 2026-06-01"
    python3 scripts/skool_allowlist.py list
    python3 scripts/skool_allowlist.py list --revoked
"""
import argparse
import os
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DB = str(REPO / "videos.db")


def _ensure_schema(db_path: str) -> None:
    """Trigger app's migrate_schema() against the target DB so the CLI works
    on a freshly-cloned repo before any web request has booted the app."""
    os.environ["DB_PATH"] = db_path
    sys.path.insert(0, str(REPO))
    # Importing app runs init_db() + migrate_schema() at module scope.
    import importlib
    if "app" in sys.modules:
        importlib.reload(sys.modules["app"])
    else:
        importlib.import_module("app")


def _conn(db_path: str) -> sqlite3.Connection:
    _ensure_schema(db_path)
    c = sqlite3.connect(db_path, timeout=30.0)
    c.row_factory = sqlite3.Row
    return c


def cmd_add(args, c: sqlite3.Connection) -> int:
    handle = args.handle.strip().lower()
    email = (args.email or f"{handle}@skool.placeholder").strip().lower()
    # display_name defaults to the handle (capitalized), so the login typeahead
    # has something to show even when --name isn't supplied.
    display_name = (args.name or "").strip() or handle
    c.execute(
        "INSERT INTO users (email, skool_handle, display_name, allowlisted, allowlist_source, allowlisted_at, revoked_at) "
        "VALUES (?, ?, ?, 1, ?, datetime('now'), NULL) "
        "ON CONFLICT(email) DO UPDATE SET "
        "  skool_handle = excluded.skool_handle, "
        "  display_name = COALESCE(NULLIF(excluded.display_name,''), users.display_name, excluded.skool_handle), "
        "  allowlisted = 1, "
        "  allowlist_source = excluded.allowlist_source, "
        "  allowlisted_at = COALESCE(users.allowlisted_at, datetime('now')), "
        "  revoked_at = NULL",
        (email, handle, display_name, args.source),
    )
    c.commit()
    row = c.execute("SELECT id, email, skool_handle, display_name, allowlisted, allowlist_source, allowlisted_at "
                    "FROM users WHERE email = ?", (email,)).fetchone()
    print(f"added: {dict(row)}")
    return 0


def cmd_revoke(args, c: sqlite3.Connection) -> int:
    handle = args.handle.strip().lower()
    row = c.execute("SELECT id, email FROM users WHERE skool_handle = ?", (handle,)).fetchone()
    if not row:
        print(f"no user with handle '{handle}'", file=sys.stderr)
        return 2
    c.execute(
        "UPDATE users SET allowlisted = 0, revoked_at = datetime('now'), "
        "allowlist_source = COALESCE(?, allowlist_source) WHERE id = ?",
        (f"revoked:{args.reason}" if args.reason else None, row["id"]),
    )
    c.commit()
    print(f"revoked: handle={handle} email={row['email']} reason={args.reason or '<none>'}")
    return 0


def cmd_list(args, c: sqlite3.Connection) -> int:
    where = "allowlisted = 0 AND revoked_at IS NOT NULL" if args.revoked else "allowlisted = 1"
    rows = c.execute(
        f"SELECT id, email, skool_handle, allowlist_source, allowlisted_at, revoked_at "
        f"FROM users WHERE {where} ORDER BY allowlisted_at DESC NULLS LAST, id DESC"
    ).fetchall()
    if not rows:
        print(f"<no rows match {'revoked' if args.revoked else 'allowlisted'} filter>")
        return 0
    print(f"{'id':>4}  {'handle':<22}  {'email':<32}  {'source':<18}  ts")
    for r in rows:
        ts = r["revoked_at"] if args.revoked else r["allowlisted_at"]
        print(f"{r['id']:>4}  {(r['skool_handle'] or ''):<22}  {(r['email'] or ''):<32}  "
              f"{(r['allowlist_source'] or ''):<18}  {ts or ''}")
    return 0


def cmd_check(args, c: sqlite3.Connection) -> int:
    handle = args.handle.strip().lower()
    row = c.execute(
        "SELECT id, email, allowlisted, allowlist_source, allowlisted_at, revoked_at "
        "FROM users WHERE skool_handle = ?", (handle,)
    ).fetchone()
    if not row:
        print(f"NOT FOUND: {handle}")
        return 3
    print(dict(row))
    return 0 if row["allowlisted"] else 1


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=os.environ.get("DB_PATH", DEFAULT_DB),
                   help="Path to videos.db (default: env DB_PATH or repo videos.db)")
    sub = p.add_subparsers(dest="cmd", required=True)

    add = sub.add_parser("add", help="Add or re-enable a Skool handle")
    add.add_argument("--handle", required=True)
    add.add_argument("--email")
    add.add_argument("--name", help="Friendly name shown in the login typeahead (defaults to handle)")
    add.add_argument("--source", default="manual",
                     help="Tag for who/what added this row (default: manual)")
    add.set_defaults(func=cmd_add)

    rev = sub.add_parser("revoke", help="Set allowlisted=0 for a handle")
    rev.add_argument("--handle", required=True)
    rev.add_argument("--reason")
    rev.set_defaults(func=cmd_revoke)

    lst = sub.add_parser("list", help="List allowlisted (or revoked) users")
    lst.add_argument("--revoked", action="store_true")
    lst.set_defaults(func=cmd_list)

    chk = sub.add_parser("check", help="Print one handle's allowlist state (exit 0 if allowed)")
    chk.add_argument("--handle", required=True)
    chk.set_defaults(func=cmd_check)

    args = p.parse_args(argv)
    c = _conn(args.db)
    try:
        return args.func(args, c)
    finally:
        c.close()


if __name__ == "__main__":
    raise SystemExit(main())
