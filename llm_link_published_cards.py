#!/usr/bin/env python3
"""One-shot LLM-powered linker for Andy's Published tab cards.

Many Published cards have titles that drift from their final YouTube titles
(e.g. card "I Added These 5 Skills" → published as "5 Claude Code Skills I
Can't Live Without (174,000+ Github Stars)"). Fuzzy string matching can't
bridge those gaps.

This script sends all unmatched card titles + all channel YouTube titles to
Gemini in a single call and asks it to return the best match per card.
Stores the youtube video_id in each card's custom_fields["YouTube Video ID"]
so future daily syncs can use it directly. Also writes the current view_count
+ published_at to the videos table immediately.
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

DB_PATH = os.environ.get("VIDEOS_DB_PATH", "/app/videos.db")
API_KEY = os.environ.get("GEMINI_API_KEY", "")

if not API_KEY:
    print("ERROR: GEMINI_API_KEY not set", file=sys.stderr)
    sys.exit(1)


def _normalize(t):
    return re.sub(r"[^a-z0-9]", "", (t or "").lower())[:80]


def get_unmatched_cards(conn):
    """Andy's Published cards that don't have current view counts."""
    rows = conn.execute("""
        SELECT id, video_id, title, view_count
        FROM videos
        WHERE channel_title = 'AI Andy' AND (view_count IS NULL OR view_count = 0)
    """).fetchall()
    return rows


def get_channel_videos(conn):
    return conn.execute("""
        SELECT video_id, title, published_at, view_count
        FROM my_channel_videos
        WHERE published_at != ''
        ORDER BY published_at DESC
    """).fetchall()


def gemini_match(unmatched_cards, channel_videos):
    """Send all cards + channel titles to Gemini, get back a card_id → yt_video_id map."""
    cards_list = "\n".join(
        f'{c["id"]}: "{c["title"]}"' for c in unmatched_cards
    )
    yt_list = "\n".join(
        f'{v["video_id"]}: "{v["title"]}" (published {v["published_at"][:10]}, {v["view_count"]:,} views)'
        for v in channel_videos
    )

    prompt = f"""You are matching Andy's "Published" video cards (working/draft titles from his content pipeline) to the actual videos he uploaded to YouTube. Card titles often differ significantly from the final published title because Andy iterates titles during the publish process.

UNMATCHED CARDS (card_id: working title):
{cards_list}

ANDY'S YOUTUBE CHANNEL UPLOADS (yt_video_id: actual title):
{yt_list}

For each unmatched card, find the YouTube video that is MOST LIKELY the same video. Match based on:
- Semantic similarity (a card about NAS storage probably matches a YT video about storage even if titles differ)
- Topic overlap (Claude Code skills cards match Claude Code skills YT videos)
- Temporal plausibility (cards in the Published tab were uploaded within the last ~6 months)
- The card's working title often captures the IDEA, while the YT title is the punched-up clickbait version

If a card has NO plausible match (the video was never published, or is on a different channel), use null.

Return ONLY a JSON object mapping card_id to either a yt_video_id string or null. No commentary, no markdown fences.

Example output:
{{"749": "abc123XYZ", "743": null, "731": "def456PQR"}}
"""

    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.2,
        }
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={API_KEY}"
    req = Request(url, data=json.dumps(body).encode("utf-8"),
                  headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text)


def apply_matches(conn, mapping, channel_videos):
    yt_by_id = {v["video_id"]: v for v in channel_videos}
    linked = 0
    skipped = 0
    for card_id_str, yt_id in mapping.items():
        try:
            card_id = int(card_id_str)
        except (ValueError, TypeError):
            continue
        if not yt_id:
            skipped += 1
            continue
        yt = yt_by_id.get(yt_id)
        if not yt:
            print(f"  card {card_id}: Gemini returned unknown yt_id {yt_id}")
            skipped += 1
            continue
        # Update card view_count + published_at
        conn.execute(
            "UPDATE videos SET view_count = ?, published_at = ? WHERE id = ?",
            (yt["view_count"], yt["published_at"], card_id),
        )
        # Persist the link in custom_fields so future syncs use it directly
        details = conn.execute(
            "SELECT custom_fields FROM video_details WHERE video_id = ?",
            (card_id,),
        ).fetchone()
        fields = json.loads(details["custom_fields"]) if details and details["custom_fields"] else []
        # Remove any stale entry
        fields = [f for f in fields if f.get("key") != "YouTube Video ID"]
        fields.append({"key": "YouTube Video ID", "value": yt_id})
        if details:
            conn.execute(
                "UPDATE video_details SET custom_fields = ? WHERE video_id = ?",
                (json.dumps(fields), card_id),
            )
        else:
            conn.execute(
                "INSERT INTO video_details (video_id, custom_fields) VALUES (?, ?)",
                (card_id, json.dumps(fields)),
            )
        card_row = conn.execute("SELECT title FROM videos WHERE id = ?", (card_id,)).fetchone()
        print(f"  ✓ {card_row['title'][:50]} → {yt['title'][:50]} ({yt['view_count']:,} views)")
        linked += 1
    conn.commit()
    print(f"\nlinked {linked}, skipped {skipped}")


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cards = get_unmatched_cards(conn)
    if not cards:
        print("no unmatched cards")
        return 0
    print(f"unmatched cards: {len(cards)}")
    channel = get_channel_videos(conn)
    print(f"channel videos: {len(channel)}")
    print("asking Gemini to match…")
    mapping = gemini_match(cards, channel)
    print(f"Gemini returned {len(mapping)} mappings")
    apply_matches(conn, mapping, channel)
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
