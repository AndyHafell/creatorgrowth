#!/usr/bin/env python3
"""Manual DM-code verifier for when the Chrome ext hook can't auto-confirm.

Usage:
    python3 scripts/skool_dm_verify.py 482917 --sender mike-skool

Hits POST /api/auth/skool/dm-code/admin-verify with the DM_VERIFY_TOKEN
bearer credential. The user with that code's session will start on their
next /poll request.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = os.environ.get("CREATORGROWTH_URL", "http://127.0.0.1:5050")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("code", help="6-digit DM code shown to the member")
    p.add_argument("--sender", help="Skool handle of the sender (Chrome ext supplies; optional for manual)")
    p.add_argument("--source", default="manual",
                   help="Tag for who/what verified (default: manual)")
    p.add_argument("--base", default=DEFAULT_BASE,
                   help=f"App base URL (default: {DEFAULT_BASE})")
    args = p.parse_args(argv)
    token = os.environ.get("DM_VERIFY_TOKEN")
    if not token:
        print("ERR: DM_VERIFY_TOKEN env var required", file=sys.stderr)
        return 2
    body = {"code": args.code, "source": args.source}
    if args.sender:
        body["sender_handle"] = args.sender
    req = urllib.request.Request(
        f"{args.base}/api/auth/skool/dm-code/admin-verify",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            print(r.read().decode())
            return 0
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"URL error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
