"""Pixel-face + faceless thumb gate (M4 + SHOULD from 2026-05-28 audit).

Both gemini-driven thumb routes hard-require assets curated by the admin:
- pixel-face needs `assets/face_references/` (admin's face crops)
- faceless needs `_FACELESS_SOP_PATH` (admin's pixel-art SOP)

Until Settings v2 ships per-user face-ref upload, these routes must reject
non-admin users with `settings_v2_required`."""


def _make_video(db, user_id: int, title: str = "thumb test vid") -> int:
    db.execute(
        "INSERT INTO videos (video_id, title, status, user_id) "
        "VALUES (?, ?, 'published', ?)",
        (f"vid_{user_id}_{title}", title, user_id),
    )
    db.commit()
    return db.execute("SELECT id FROM videos WHERE title = ?", (title,)).fetchone()["id"]


def test_pixel_face_blocks_non_admin(client, db, seed_user, login_as):
    bob = seed_user("bob@example.com", "bob-handle")
    vid = _make_video(db, bob)
    login_as("bob@example.com")
    r = client.post(f"/api/videos/{vid}/gemini-pixel-face", json={"count": 3})
    assert r.status_code == 403
    assert r.get_json().get("error") == "settings_v2_required"


def test_faceless_blocks_non_admin(client, db, seed_user, login_as):
    bob = seed_user("bob@example.com", "bob-handle")
    vid = _make_video(db, bob)
    login_as("bob@example.com")
    r = client.post(f"/api/videos/{vid}/gemini-faceless", json={"count": 3})
    assert r.status_code == 403
    assert r.get_json().get("error") == "settings_v2_required"


def test_pixel_face_admin_passes_gate(client, db, seed_user, login_as):
    """Admin gets past the settings_v2 gate. Path then fails on missing face refs
    or downstream issues — but NOT with settings_v2_required."""
    andy = seed_user("andhaf94@gmail.com", "andy-handle")
    vid = _make_video(db, andy)
    login_as("andhaf94@gmail.com")
    r = client.post(f"/api/videos/{vid}/gemini-pixel-face", json={"count": 3})
    body = r.get_json() or {}
    assert body.get("error") != "settings_v2_required"
