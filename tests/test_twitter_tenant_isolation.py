"""Per-tenant isolation for /api/twitter/feed.

GET /api/twitter/feed must only return the logged-in workspace's tweets.
Pre-fix this endpoint returned every tweet in the table to every authed user,
leaking cross-tenant content. See handoff M1 (2026-05-28)."""


def _insert_tweet(db, text: str, user_id: int) -> int:
    db.execute(
        "INSERT INTO tweets (text, blotato_id, media_url, thread_json, user_id) "
        "VALUES (?, ?, ?, ?, ?)",
        (text, "", "", "[]", user_id),
    )
    db.commit()
    return db.execute("SELECT id FROM tweets WHERE text = ?", (text,)).fetchone()["id"]


def test_twitter_feed_only_returns_own_tweets(client, db, seed_user, login_as):
    alice = seed_user("alice@example.com", "alice-handle")
    bob   = seed_user("bob@example.com",   "bob-handle")
    _insert_tweet(db, "alice-tweet-1", alice)
    _insert_tweet(db, "alice-tweet-2", alice)
    _insert_tweet(db, "bob-tweet-1",   bob)

    login_as("alice@example.com")
    r = client.get("/api/twitter/feed")
    assert r.status_code == 200
    texts = sorted(t["text"] for t in r.get_json())
    assert texts == ["alice-tweet-1", "alice-tweet-2"]

    login_as("bob@example.com")
    r = client.get("/api/twitter/feed")
    assert r.status_code == 200
    texts = [t["text"] for t in r.get_json()]
    assert texts == ["bob-tweet-1"]


def test_twitter_feed_excludes_legacy_null_user_rows(client, db, seed_user, login_as):
    """Pre-migration tweets with user_id IS NULL must not leak to fresh users.
    (In prod they're backfilled to Andy, but the query must still filter.)"""
    alice = seed_user("alice@example.com", "alice-handle")
    db.execute(
        "INSERT INTO tweets (text, blotato_id, media_url, thread_json, user_id) "
        "VALUES (?, '', '', '[]', NULL)",
        ("legacy-orphan",),
    )
    db.commit()

    login_as("alice@example.com")
    r = client.get("/api/twitter/feed")
    assert r.status_code == 200
    texts = [t["text"] for t in r.get_json()]
    assert "legacy-orphan" not in texts
