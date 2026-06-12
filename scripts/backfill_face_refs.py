#!/usr/bin/env python3
"""One-shot backfill: copy the bundled channel face references into a user's
per-user Face Library (Settings v2 §3).

Why: the legacy Gemini thumb route reads face refs from the bundled
`assets/face_references/` dir. The Settings v2 / Replicate route reads each
user's own face refs from the `uploads` table (kind='face_ref') + S3. To make
Andy's thumb output identical after the cutover, his existing bundled refs need
to land in his per-user storage once.

Idempotent: skips any ref whose filename already exists for the target user
(kind='face_ref'). Safe to re-run.

Run INSIDE the container (S3 creds + bucket live in its env):

    docker exec root-idea-dashboard-1 python3 scripts/backfill_face_refs.py --user-id 2

Dry-run first:

    docker exec root-idea-dashboard-1 python3 scripts/backfill_face_refs.py --user-id 2 --dry-run
"""
import argparse
import sys
import uuid

import app  # imports the live app context (DB path, S3 client, bucket)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user-id", type=int, required=True,
                    help="users.id to attach the face refs to (Andy = 2 on prod)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would happen, write nothing")
    args = ap.parse_args()

    if not app.S3_BUCKET:
        print("ERROR: S3 not configured (S3_BUCKET empty). Run inside the container.")
        sys.exit(1)

    refs = app._FACE_REFS_DIR
    if not refs.exists():
        print(f"ERROR: face refs dir missing: {refs}")
        sys.exit(1)

    files = [p for p in sorted(refs.iterdir())
             if not p.name.startswith(".") and p.suffix.lower() in (".png", ".jpg", ".jpeg")]
    if not files:
        print(f"No face refs found in {refs}")
        sys.exit(1)

    conn = app.get_db()
    # Existing per-user face-ref filenames → skip those.
    existing = {
        r["original_filename"]
        for r in conn.execute(
            "SELECT original_filename FROM uploads WHERE user_id=? AND kind='face_ref'",
            (args.user_id,),
        ).fetchall()
    }

    user = conn.execute("SELECT id, email FROM users WHERE id=?", (args.user_id,)).fetchone()
    if not user:
        print(f"ERROR: no user with id={args.user_id}")
        sys.exit(1)
    print(f"Target user: id={user['id']} email={user['email']}")
    print(f"Found {len(files)} bundled refs; {len(existing)} already in user's library.")

    s3 = app._s3_client()
    added = 0
    for p in files:
        safe = app._safe_filename(p.name)
        if safe in existing or p.name in existing:
            print(f"  skip (exists): {p.name}")
            continue
        key = f"creatorgrowth/uploads/u{args.user_id}/{uuid.uuid4().hex}_{safe}"
        ctype = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
        data = p.read_bytes()
        if args.dry_run:
            print(f"  WOULD upload {p.name} ({len(data)} bytes) → s3://{app.S3_BUCKET}/{key}")
            continue
        s3.put_object(Bucket=app.S3_BUCKET, Key=key, Body=data, ContentType=ctype)
        conn.execute(
            "INSERT INTO uploads (user_id, key, original_filename, kind, content_type, "
            "size_bytes, uploaded, finalized_at) "
            "VALUES (?, ?, ?, 'face_ref', ?, ?, 1, datetime('now'))",
            (args.user_id, key, safe, ctype, len(data)),
        )
        conn.commit()
        print(f"  uploaded: {p.name} → {key}")
        added += 1

    conn.close()
    print(f"Done. {added} new face ref(s) added{' (dry-run)' if args.dry_run else ''}.")


if __name__ == "__main__":
    main()
