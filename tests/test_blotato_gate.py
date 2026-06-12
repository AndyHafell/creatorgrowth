"""Blotato publish gate (M2 from 2026-05-28 multi-tenant audit).

The Blotato account IDs (X, YouTube, TikTok, FB, IG, LI, Pinterest, Bluesky,
Threads) are hardcoded to Andy's accounts via env vars. Until Settings v2
ships per-user social-account configuration, all Blotato publish endpoints
must reject non-admin users with `settings_v2_required` so cross-tenant users
can't accidentally publish to Andy's accounts."""

import pytest


def _make_video(db, user_id: int, title: str = "test vid") -> int:
    db.execute(
        "INSERT INTO videos (video_id, title, status, user_id) "
        "VALUES (?, ?, 'published', ?)",
        (f"vid_{user_id}_{title}", title, user_id),
    )
    db.commit()
    return db.execute("SELECT id FROM videos WHERE title = ?", (title,)).fetchone()["id"]


def test_twitter_post_blocks_non_admin(client, seed_user, login_as):
    bob = seed_user("bob@example.com", "bob-handle")
    login_as("bob@example.com")

    r = client.post(
        "/api/twitter/post",
        json={"text": "hello from bob"},
    )
    assert r.status_code == 403
    body = r.get_json()
    assert body.get("error") == "settings_v2_required"


def test_twitter_post_admin_passes_gate(client, seed_user, login_as, monkeypatch):
    """Andy (admin) gets past the settings_v2 gate. We don't have BLOTATO_API_KEY
    set in the test env, so the route returns its own 500 — confirming we cleared
    the new gate and only failed on the env-var check that has always existed."""
    seed_user("andhaf94@gmail.com", "andy-handle")
    login_as("andhaf94@gmail.com")
    monkeypatch.delenv("BLOTATO_API_KEY", raising=False)

    r = client.post("/api/twitter/post", json={"text": "hi"})
    assert r.status_code != 403  # not blocked by the new gate
    body = r.get_json()
    assert body.get("error") != "settings_v2_required"


def test_publish_blotato_blocks_non_admin(client, db, seed_user, login_as):
    bob = seed_user("bob@example.com", "bob-handle")
    vid = _make_video(db, bob)
    login_as("bob@example.com")

    r = client.post(
        f"/api/videos/{vid}/publish-blotato",
        json={"privacy": "private"},
    )
    assert r.status_code == 403
    body = r.get_json()
    assert body.get("error") == "settings_v2_required"


def test_publish_blotato_admin_passes_gate(client, db, seed_user, login_as, monkeypatch):
    andy = seed_user("andhaf94@gmail.com", "andy-handle")
    vid = _make_video(db, andy)
    login_as("andhaf94@gmail.com")
    monkeypatch.delenv("BLOTATO_API_KEY", raising=False)

    r = client.post(f"/api/videos/{vid}/publish-blotato", json={"privacy": "private"})
    assert r.status_code != 403
    body = r.get_json()
    assert body.get("error") != "settings_v2_required"
