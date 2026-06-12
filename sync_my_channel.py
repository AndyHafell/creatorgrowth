#!/usr/bin/env python3
"""Sync Andy's YouTube channel (AI Andy Automation, UCjWpQlNWtRo_3zZtvyBsmdg)
into the my_channel_videos table. Run daily via cron.

Pulls every upload via the channel's uploads playlist, then batches videos.list
calls (50 IDs per call) to fetch fresh statistics + snippet + duration.
Upserts into videos.db so the brief generator has current performance data.
"""
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen
from urllib.error import HTTPError, URLError

CHANNEL_ID = os.environ.get("MY_CHANNEL_ID", "UCn2RJFAA1ndipnVJsYAwWOw")  # AI Andy (@theaiandy)
API_KEY = os.environ.get("YOUTUBE_API_KEY", "")
DB_PATH = os.environ.get("VIDEOS_DB_PATH", "/app/videos.db")

if not API_KEY:
    print("ERROR: YOUTUBE_API_KEY not set", file=sys.stderr)
    sys.exit(1)


def _get(url, retries=3):
    """GET a YouTube API URL with simple retry on 5xx/transient errors."""
    for attempt in range(retries):
        try:
            with urlopen(url, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            if e.code >= 500 and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise
        except URLError:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise


def get_uploads_playlist_id(channel_id):
    url = f"https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id={channel_id}&key={API_KEY}"
    data = _get(url)
    items = data.get("items") or []
    if not items:
        raise RuntimeError(f"channel {channel_id} not found")
    return items[0]["contentDetails"]["relatedPlaylists"]["uploads"]


def get_all_upload_ids(playlist_id):
    """Paginate through the uploads playlist and return every video_id."""
    ids = []
    page_token = ""
    while True:
        url = (
            f"https://www.googleapis.com/youtube/v3/playlistItems"
            f"?part=contentDetails&maxResults=50&playlistId={playlist_id}"
            f"&key={API_KEY}"
        )
        if page_token:
            url += f"&pageToken={page_token}"
        data = _get(url)
        for item in data.get("items", []):
            vid = item.get("contentDetails", {}).get("videoId")
            if vid:
                ids.append(vid)
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return ids


def _parse_iso8601_duration(s):
    """PT1H2M3S → 3723 seconds. Returns 0 on parse failure."""
    if not s:
        return 0
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s)
    if not m:
        return 0
    h, mn, sec = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mn * 60 + sec


def fetch_video_details(video_ids):
    """Batch fetch up to 50 videos per call. Returns a list of detail dicts."""
    out = []
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i:i + 50]
        url = (
            f"https://www.googleapis.com/youtube/v3/videos"
            f"?part=snippet,statistics,contentDetails"
            f"&id={','.join(batch)}&key={API_KEY}"
        )
        data = _get(url)
        for item in data.get("items", []):
            snippet = item.get("snippet", {})
            stats = item.get("statistics", {})
            content = item.get("contentDetails", {})
            out.append({
                "video_id": item["id"],
                "title": snippet.get("title", ""),
                "description": snippet.get("description", "")[:2000],
                "published_at": snippet.get("publishedAt", ""),
                "view_count": int(stats.get("viewCount", 0)),
                "like_count": int(stats.get("likeCount", 0)),
                "comment_count": int(stats.get("commentCount", 0)),
                "duration_seconds": _parse_iso8601_duration(content.get("duration", "")),
                "thumbnail_url": (snippet.get("thumbnails", {}).get("maxres") or
                                  snippet.get("thumbnails", {}).get("high") or
                                  snippet.get("thumbnails", {}).get("default") or {}).get("url", ""),
            })
    return out


def upsert(rows):
    conn = sqlite3.connect(DB_PATH)
    now = datetime.now(timezone.utc).isoformat()
    inserted = 0
    updated = 0
    for r in rows:
        existing = conn.execute(
            "SELECT video_id FROM my_channel_videos WHERE video_id = ?",
            (r["video_id"],),
        ).fetchone()
        if existing:
            conn.execute("""
                UPDATE my_channel_videos
                SET title = ?, description = ?, published_at = ?,
                    view_count = ?, like_count = ?, comment_count = ?,
                    duration_seconds = ?, thumbnail_url = ?, refreshed_at = ?
                WHERE video_id = ?
            """, (
                r["title"], r["description"], r["published_at"],
                r["view_count"], r["like_count"], r["comment_count"],
                r["duration_seconds"], r["thumbnail_url"], now,
                r["video_id"],
            ))
            updated += 1
        else:
            conn.execute("""
                INSERT INTO my_channel_videos
                    (video_id, title, description, published_at, view_count,
                     like_count, comment_count, duration_seconds, thumbnail_url,
                     refreshed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                r["video_id"], r["title"], r["description"], r["published_at"],
                r["view_count"], r["like_count"], r["comment_count"],
                r["duration_seconds"], r["thumbnail_url"], now,
            ))
            inserted += 1
    conn.commit()
    conn.close()
    return inserted, updated


def _normalize_title(t):
    """Lowercase + strip non-alphanumeric for fuzzy title matching."""
    return re.sub(r"[^a-z0-9]", "", (t or "").lower())[:80]


def _first_n_words(t, n=5):
    return " ".join(re.sub(r"[^a-z0-9\s]", "", (t or "").lower()).split()[:n])


def _match_card_to_channel(card_title, channel_rows):
    """Try several matching strategies, return the best my_channel_videos row or None.
    Order: exact normalized → substring (either direction) → first-5-words match.
    """
    if not card_title:
        return None
    card_norm = _normalize_title(card_title)
    card_words = _first_n_words(card_title, 5)

    # 1. Exact normalized match
    for r in channel_rows:
        if _normalize_title(r["title"]) == card_norm:
            return r

    # 2. Substring match (one contains the other), prefer longer overlap
    candidates = []
    for r in channel_rows:
        yt_norm = _normalize_title(r["title"])
        if len(card_norm) >= 15 and (card_norm in yt_norm or yt_norm in card_norm):
            overlap = min(len(card_norm), len(yt_norm))
            candidates.append((overlap, r))
    if candidates:
        candidates.sort(reverse=True)
        return candidates[0][1]

    # 3. First-5-words match
    if card_words and len(card_words) >= 12:
        for r in channel_rows:
            if _first_n_words(r["title"], 5) == card_words:
                return r

    return None


def _get_stored_yt_id(conn, card_id):
    """Read the YouTube Video ID stored in a card's custom_fields, if any."""
    row = conn.execute(
        "SELECT custom_fields FROM video_details WHERE video_id = ?",
        (card_id,),
    ).fetchone()
    if not row or not row["custom_fields"]:
        return None
    try:
        for f in json.loads(row["custom_fields"]):
            if f.get("key") == "YouTube Video ID" and f.get("value"):
                return f["value"]
    except (json.JSONDecodeError, TypeError):
        pass
    return None


def bridge_to_published_cards():
    """Update Andy's Published-tab cards (channel='AI Andy') with current view_count
    + published_at from my_channel_videos. Two-tier match:
      1. Stored YouTube Video ID in custom_fields (set by llm_link_published_cards.py)
      2. Fuzzy title match as fallback
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    channel_rows = conn.execute("SELECT * FROM my_channel_videos").fetchall()
    yt_by_id = {r["video_id"]: r for r in channel_rows}

    matched_via_id = 0
    matched_via_fuzzy = 0
    unmatched_cards = []
    for card in conn.execute(
        "SELECT id, video_id, title FROM videos WHERE channel_title = 'AI Andy'"
    ).fetchall():
        # Tier 1: stored YouTube ID
        stored_id = _get_stored_yt_id(conn, card["id"])
        hit = yt_by_id.get(stored_id) if stored_id else None
        if hit:
            conn.execute(
                "UPDATE videos SET view_count = ?, published_at = ? WHERE id = ?",
                (hit["view_count"], hit["published_at"], card["id"]),
            )
            matched_via_id += 1
            continue
        # Tier 2: fuzzy title match
        hit = _match_card_to_channel(card["title"], channel_rows)
        if hit:
            conn.execute(
                "UPDATE videos SET view_count = ?, published_at = ? WHERE id = ?",
                (hit["view_count"], hit["published_at"], card["id"]),
            )
            matched_via_fuzzy += 1
        else:
            unmatched_cards.append(card["title"])
    matched = matched_via_id + matched_via_fuzzy

    conn.commit()
    conn.close()
    print(f"  bridged {matched} published cards to real YouTube stats ({matched_via_id} via stored YT ID, {matched_via_fuzzy} via fuzzy match)")
    if unmatched_cards:
        print(f"  {len(unmatched_cards)} cards unmatched (need manual link or title edit):")
        for t in unmatched_cards[:15]:
            print(f"    - {t}")


def main():
    print(f"[{datetime.now(timezone.utc).isoformat()}] syncing channel {CHANNEL_ID}")
    playlist_id = get_uploads_playlist_id(CHANNEL_ID)
    print(f"  uploads playlist: {playlist_id}")
    video_ids = get_all_upload_ids(playlist_id)
    print(f"  {len(video_ids)} videos in playlist")
    details = fetch_video_details(video_ids)
    print(f"  fetched details for {len(details)}")
    inserted, updated = upsert(details)
    print(f"  inserted {inserted}, updated {updated}")
    bridge_to_published_cards()
    return 0


if __name__ == "__main__":
    sys.exit(main())
