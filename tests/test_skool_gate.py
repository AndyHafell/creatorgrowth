"""End-to-end tests for the Skool allowlist gate + per-user data isolation.

Each test gets a clean DB (no Andy backfill from videos.db). Users are seeded
via the conftest fixture before the test calls login_as().
"""


def test_callback_rejects_non_allowlisted(client, seed_user):
    # No users seeded except Andy (auto-added by migrate_schema).
    r = client.post(
        "/api/auth/skool/callback",
        json={"code": "x", "user_email": "stranger@nowhere.com"},
    )
    assert r.status_code == 403
    body = r.get_json()
    assert body["error"] == "not on allowlist"


def test_callback_accepts_allowlisted(client, seed_user):
    seed_user("alice@example.com", "alice-handle")
    r = client.post(
        "/api/auth/skool/callback",
        json={"code": "x", "user_email": "alice@example.com"},
    )
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["user"]["email"] == "alice@example.com"
    assert body["user"]["handle"] == "alice-handle"


def test_unauthenticated_request_is_401(client):
    r = client.get("/api/videos")
    assert r.status_code == 401


def test_videos_isolated_between_users_read(client, seed_user, login_as, db):
    # Two allowlisted users, each owning one video.
    uid_a = seed_user("alice@example.com", "alice-handle")
    uid_b = seed_user("bob@example.com",   "bob-handle")
    db.execute("INSERT INTO videos (video_id, title, user_id) VALUES ('vid_A', 'Alice video', ?)", (uid_a,))
    db.execute("INSERT INTO videos (video_id, title, user_id) VALUES ('vid_B', 'Bob video',   ?)", (uid_b,))
    db.commit()

    login_as("alice@example.com")
    r = client.get("/api/videos")
    assert r.status_code == 200
    titles = [v["title"] for v in r.get_json()]
    assert "Alice video" in titles
    assert "Bob video" not in titles


def test_videos_isolated_between_users_write_owns(client, seed_user, login_as, db):
    # User A creates a video; user B tries to delete it → 404
    uid_a = seed_user("alice@example.com", "alice-handle")
    uid_b = seed_user("bob@example.com",   "bob-handle")
    cur = db.execute("INSERT INTO videos (video_id, title, user_id) VALUES ('vid_X', 'Alice X', ?)", (uid_a,))
    db.commit()
    vid_x_id = cur.lastrowid

    login_as("bob@example.com")
    r = client.delete(f"/api/videos/{vid_x_id}")
    assert r.status_code == 404, f"Bob shouldn't be able to delete Alice's video, got {r.status_code}"

    # And the row still exists for Alice.
    row = db.execute("SELECT id FROM videos WHERE id = ?", (vid_x_id,)).fetchone()
    assert row is not None


def test_dm_code_revoked_handle_403(client, seed_user, db):
    # Seed and then revoke
    uid = seed_user("eve@example.com", "eve-handle")
    db.execute(
        "UPDATE users SET allowlisted = 0, revoked_at = datetime('now') WHERE id = ?",
        (uid,),
    )
    db.commit()
    r = client.post("/api/auth/skool/dm-code/start", json={"handle": "eve-handle"})
    assert r.status_code == 403


def test_dm_code_full_flow(client, seed_user, db, monkeypatch):
    seed_user("alice@example.com", "alice-handle")
    r = client.post("/api/auth/skool/dm-code/start", json={"handle": "alice-handle"})
    assert r.status_code == 200
    code = r.get_json()["code"]

    # Poll before verify → pending
    r = client.get(f"/api/auth/skool/dm-code/poll?code={code}")
    assert r.status_code == 200
    assert r.get_json()["status"] == "pending"

    # Verify via admin endpoint
    monkeypatch.setenv("DM_VERIFY_TOKEN", "pytest-dm-token")  # already set in conftest
    r = client.post(
        "/api/auth/skool/dm-code/admin-verify",
        headers={"Authorization": "Bearer pytest-dm-token"},
        json={"code": code, "sender_handle": "alice-handle", "source": "pytest"},
    )
    assert r.status_code == 200

    # Poll again → minted + session active
    r = client.get(f"/api/auth/skool/dm-code/poll?code={code}")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["user"]["handle"] == "alice-handle"

    # Subsequent calls are guarded by session
    r = client.get("/api/auth-status")
    assert r.status_code == 200
    assert r.get_json()["authenticated"] is True


def test_admin_verify_requires_bearer(client):
    r = client.post(
        "/api/auth/skool/dm-code/admin-verify",
        json={"code": "000000"},
    )
    assert r.status_code == 401


def test_live_revocation_kills_session(client, seed_user, login_as, db):
    uid = seed_user("mike@example.com", "mike-handle")
    login_as("mike@example.com")
    # First request succeeds
    r = client.get("/api/videos")
    assert r.status_code == 200
    # Revoke
    db.execute("UPDATE users SET allowlisted = 0, revoked_at = datetime('now') WHERE id = ?", (uid,))
    db.commit()
    # Next request 401s
    r = client.get("/api/videos")
    assert r.status_code == 401
    body = r.get_json()
    assert body["error"] == "access revoked"


def test_oauth_configured_rejects_user_email_field(client, seed_user, monkeypatch):
    """When SKOOL_API_KEY is set we treat ourselves as in production — the
    mock-mode `user_email` field MUST be rejected."""
    seed_user("alice@example.com", "alice-handle")
    monkeypatch.setattr("app.SKOOL_API_KEY",       "fake-prod-key")
    monkeypatch.setattr("app.SKOOL_CLIENT_ID",     "fake-id")
    monkeypatch.setattr("app.SKOOL_CLIENT_SECRET", "fake-secret")
    r = client.post(
        "/api/auth/skool/callback",
        json={"code": "x", "user_email": "alice@example.com"},
    )
    assert r.status_code == 400, f"OAuth-configured mode should reject user_email, got {r.status_code}"


def test_per_user_video_id_dedupe(client, seed_user, login_as, db):
    """Two users can each track the same YouTube ID — the UNIQUE drop works.
    Same user dedupes within their own scope."""
    uid_a = seed_user("alice@example.com", "alice-handle")
    uid_b = seed_user("bob@example.com",   "bob-handle")
    # Insert same video_id under both users directly
    db.execute("INSERT INTO videos (video_id, title, user_id) VALUES ('dQw4w9WgXcQ', 'Alice copy', ?)", (uid_a,))
    db.execute("INSERT INTO videos (video_id, title, user_id) VALUES ('dQw4w9WgXcQ', 'Bob copy',   ?)", (uid_b,))
    db.commit()
    # And dupe within one user fails
    import sqlite3
    with __import__('pytest').raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO videos (video_id, title, user_id) VALUES ('dQw4w9WgXcQ', 'Alice dupe', ?)", (uid_a,))
        db.commit()


def test_clear_videos_only_nukes_own(client, seed_user, login_as, db):
    uid_a = seed_user("alice@example.com", "alice-handle")
    uid_b = seed_user("bob@example.com",   "bob-handle")
    db.execute("INSERT INTO videos (video_id, title, user_id) VALUES ('A1', 'A1', ?)", (uid_a,))
    db.execute("INSERT INTO videos (video_id, title, user_id) VALUES ('A2', 'A2', ?)", (uid_a,))
    db.execute("INSERT INTO videos (video_id, title, user_id) VALUES ('B1', 'B1', ?)", (uid_b,))
    db.commit()

    login_as("alice@example.com")
    r = client.post("/api/videos/clear")
    assert r.status_code == 200
    # Alice has zero, Bob still has his
    a_count = db.execute("SELECT COUNT(*) FROM videos WHERE user_id = ?", (uid_a,)).fetchone()[0]
    b_count = db.execute("SELECT COUNT(*) FROM videos WHERE user_id = ?", (uid_b,)).fetchone()[0]
    assert a_count == 0
    assert b_count == 1
