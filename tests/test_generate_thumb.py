"""Faceless thumbnail generation on the user's OWN key (Replicate Flux).

The first "works for any member" thumb button: no face refs, no server Gemini
key — it runs on the signed-in user's stored Replicate key, with a transparent
prompt taken from their editable faceless preset (or an explicit override).

The Replicate HTTP call is stubbed via `_replicate_flux_image` so we test the
gating + prompt composition + slot persistence, not the network.
"""
import pytest


def _seed_owned_video(db, uid, title="My Faceless Video"):
    cur = db.execute(
        "INSERT INTO videos (video_id, title, user_id) VALUES (?, ?, ?)",
        (f"vid_{uid}_{title[:4]}", title, uid),
    )
    db.commit()
    return cur.lastrowid


@pytest.fixture
def fake_flux(app_module, monkeypatch):
    """Record every prompt and return a 1x1 PNG so slots fill."""
    calls = []
    PNG = b"\x89PNG\r\n\x1a\n_fake_"
    def _gen(prompt, api_key, aspect_ratio="16:9"):
        calls.append({"prompt": prompt, "api_key": api_key})
        return PNG, None
    monkeypatch.setattr(app_module, "_replicate_flux_image", _gen)
    return calls


def _set_key(db, uid, field, val):
    db.execute(f"UPDATE users SET {field}=? WHERE id=?", (val, uid))
    db.commit()


def test_generate_thumb_403_without_any_key(client, seed_user, login_as, db, fake_flux):
    uid = seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    vid = _seed_owned_video(db, uid)
    r = client.post(f"/api/videos/{vid}/generate-thumb",
                    json={"kind": "faceless", "count": 3})
    assert r.status_code == 403
    assert r.get_json()["error"] == "thumb_key_required"


def test_generate_thumb_faceless_fills_slots(client, seed_user, login_as, db, fake_flux):
    uid = seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    _set_key(db, uid, "replicate_api_key", "r8_userkey123")
    vid = _seed_owned_video(db, uid)
    r = client.post(f"/api/videos/{vid}/generate-thumb",
                    json={"kind": "faceless", "count": 3})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["count"] == 3
    filled = [u for u in body["original_thumbs"] if u]
    assert len(filled) == 3
    # used the user's own key
    assert all(c["api_key"] == "r8_userkey123" for c in fake_flux)


def test_generate_thumb_uses_prompt_override(client, seed_user, login_as, db, fake_flux):
    uid = seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    _set_key(db, uid, "replicate_api_key", "r8_userkey123")
    vid = _seed_owned_video(db, uid)
    client.post(f"/api/videos/{vid}/generate-thumb",
                json={"kind": "faceless", "count": 1,
                      "prompt_override": "UNIQUE_OVERRIDE_TOKEN_xyz"})
    assert any("UNIQUE_OVERRIDE_TOKEN_xyz" in c["prompt"] for c in fake_flux)


def test_generate_thumb_uses_saved_preset_when_no_override(client, seed_user, login_as, db, fake_flux):
    uid = seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    _set_key(db, uid, "replicate_api_key", "r8_userkey123")
    _set_key(db, uid, "prompt_preset_faceless", "MY_SAVED_FACELESS_PRESET_abc")
    vid = _seed_owned_video(db, uid)
    client.post(f"/api/videos/{vid}/generate-thumb",
                json={"kind": "faceless", "count": 1})
    assert any("MY_SAVED_FACELESS_PRESET_abc" in c["prompt"] for c in fake_flux)


def test_generate_thumb_includes_video_title(client, seed_user, login_as, db, fake_flux):
    uid = seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    _set_key(db, uid, "replicate_api_key", "r8_userkey123")
    vid = _seed_owned_video(db, uid, title="Ten Wild AI Agents")
    client.post(f"/api/videos/{vid}/generate-thumb",
                json={"kind": "faceless", "count": 1})
    assert any("Ten Wild AI Agents" in c["prompt"] for c in fake_flux)


def test_generate_thumb_rejects_non_faceless_kind(client, seed_user, login_as, db, fake_flux):
    uid = seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    _set_key(db, uid, "replicate_api_key", "r8_userkey123")
    vid = _seed_owned_video(db, uid)
    r = client.post(f"/api/videos/{vid}/generate-thumb",
                    json={"kind": "pixel-face", "count": 1})
    assert r.status_code == 400


def test_generate_thumb_blocks_cross_tenant(client, seed_user, login_as, db, fake_flux):
    uid_a = seed_user("alice@example.com", "alice-handle")
    seed_user("bob@example.com", "bob-handle")
    vid = _seed_owned_video(db, uid_a)
    login_as("bob@example.com")
    _set_key(db, db.execute("SELECT id FROM users WHERE email='bob@example.com'").fetchone()["id"],
             "replicate_api_key", "r8_bobkey")
    r = client.post(f"/api/videos/{vid}/generate-thumb",
                    json={"kind": "faceless", "count": 1})
    assert r.status_code in (403, 404)  # not bob's video
