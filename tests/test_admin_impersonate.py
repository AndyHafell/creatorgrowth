"""Admin impersonation: ADMIN_EMAILS can log in as any user to debug, then
restore via /api/admin/stop-impersonating."""

import pytest


@pytest.fixture
def admin_setup(app_module, monkeypatch):
    """Set ADMIN_EMAILS to a known value for tests."""
    monkeypatch.setattr(app_module, "ADMIN_EMAILS", {"admin@example.com"})
    return app_module


def test_admin_users_403_for_non_admin(client, seed_user, login_as, admin_setup):
    seed_user("bob@example.com", "bob-handle")
    login_as("bob@example.com")
    r = client.get("/api/admin/users")
    assert r.status_code == 403


def test_admin_users_200_for_admin(client, seed_user, login_as, admin_setup):
    seed_user("admin@example.com", "admin-handle")
    seed_user("bob@example.com",   "bob-handle")
    login_as("admin@example.com")
    r = client.get("/api/admin/users")
    assert r.status_code == 200
    emails = [u["email"] for u in r.get_json()]
    assert "admin@example.com" in emails
    assert "bob@example.com" in emails


def test_impersonate_403_for_non_admin(client, seed_user, login_as, admin_setup):
    seed_user("bob@example.com",   "bob-handle")
    seed_user("alice@example.com", "alice-handle")
    login_as("bob@example.com")
    r = client.post("/api/admin/impersonate", json={"email": "alice@example.com"})
    assert r.status_code == 403


def test_impersonate_flips_session(client, seed_user, login_as, admin_setup):
    seed_user("admin@example.com", "admin-handle")
    bob_uid = seed_user("bob@example.com", "bob-handle")
    login_as("admin@example.com")

    r = client.post("/api/admin/impersonate", json={"email": "bob@example.com"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["user_id"] == bob_uid
    assert body["impersonating"] == "bob@example.com"
    assert body["impersonator_email"] == "admin@example.com"

    # auth-status reflects the swap
    r = client.get("/api/auth-status")
    body = r.get_json()
    assert body["email"] == "bob@example.com"
    assert body["user_id"] == bob_uid
    assert body["impersonating"] is True
    assert body["is_admin"] is True  # impersonator IS admin even while impersonating


def test_impersonate_unknown_user_404(client, seed_user, login_as, admin_setup):
    seed_user("admin@example.com", "admin-handle")
    login_as("admin@example.com")
    r = client.post("/api/admin/impersonate", json={"email": "ghost@nowhere.com"})
    assert r.status_code == 404


def test_stop_restores_admin(client, seed_user, login_as, admin_setup):
    admin_uid = seed_user("admin@example.com", "admin-handle")
    seed_user("bob@example.com", "bob-handle")
    login_as("admin@example.com")
    client.post("/api/admin/impersonate", json={"email": "bob@example.com"})

    r = client.post("/api/admin/stop-impersonating")
    assert r.status_code == 200
    body = r.get_json()
    assert body["restored_email"] == "admin@example.com"
    assert body["user_id"] == admin_uid

    r = client.get("/api/auth-status")
    body = r.get_json()
    assert body["email"] == "admin@example.com"
    assert body["impersonating"] is False


def test_stop_400_when_not_impersonating(client, seed_user, login_as, admin_setup):
    seed_user("admin@example.com", "admin-handle")
    login_as("admin@example.com")
    r = client.post("/api/admin/stop-impersonating")
    assert r.status_code == 400


def test_impersonator_email_persists_across_hops(client, seed_user, login_as, admin_setup):
    """admin → alice → bob → stop ends up as admin (not alice or bob)."""
    seed_user("admin@example.com", "admin-handle")
    seed_user("alice@example.com", "alice-handle")
    seed_user("bob@example.com",   "bob-handle")
    login_as("admin@example.com")

    client.post("/api/admin/impersonate", json={"email": "alice@example.com"})
    client.post("/api/admin/impersonate", json={"email": "bob@example.com"})
    r = client.post("/api/admin/stop-impersonating")
    assert r.get_json()["restored_email"] == "admin@example.com"


def test_impersonate_bypasses_user_allowlist(client, seed_user, login_as, admin_setup, db):
    """Admin impersonating a revoked user can still access — they need to debug."""
    seed_user("admin@example.com", "admin-handle")
    eve_uid = seed_user("eve@example.com", "eve-handle")
    # Revoke eve
    db.execute(
        "UPDATE users SET allowlisted = 0, revoked_at = datetime('now'), "
        "allowlist_source = 'trial:expired' WHERE id = ?", (eve_uid,)
    )
    db.commit()

    login_as("admin@example.com")
    r = client.post("/api/admin/impersonate", json={"email": "eve@example.com"})
    assert r.status_code == 200

    # Admin (now session=eve) can still hit data endpoints
    r = client.get("/api/videos")
    assert r.status_code == 200

    # Eve's allowlisted=0 was NOT mutated by the request
    row = db.execute("SELECT allowlisted FROM users WHERE id = ?", (eve_uid,)).fetchone()
    assert row["allowlisted"] == 0


def test_data_scoping_uses_impersonated_user_id(client, seed_user, login_as, admin_setup, db):
    """While admin impersonates bob, /api/videos returns bob's videos, not admin's."""
    admin_uid = seed_user("admin@example.com", "admin-handle")
    bob_uid   = seed_user("bob@example.com",   "bob-handle")
    db.execute("INSERT INTO videos (video_id, title, user_id) VALUES ('admin_vid', 'Admin', ?)", (admin_uid,))
    db.execute("INSERT INTO videos (video_id, title, user_id) VALUES ('bob_vid', 'Bob', ?)", (bob_uid,))
    db.commit()

    login_as("admin@example.com")
    titles = [v["title"] for v in client.get("/api/videos").get_json()]
    assert "Admin" in titles
    assert "Bob" not in titles

    client.post("/api/admin/impersonate", json={"email": "bob@example.com"})
    titles = [v["title"] for v in client.get("/api/videos").get_json()]
    assert "Bob" in titles
    assert "Admin" not in titles
