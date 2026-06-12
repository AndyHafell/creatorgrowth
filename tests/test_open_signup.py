"""OPEN_SIGNUP mode — the self-host escape hatch from the Skool gate.

When a self-hoster clones the repo and sets OPEN_SIGNUP=1, the Skool-membership
machinery (7-day trial + day-7 auto-revoke + paid-webhook re-allowlist) must
get out of the way: any email that activates gets permanent full access, and
no authed request is ever revoked. With the flag OFF, the existing Skool gate
must behave exactly as before.
"""
import pytest


def _expire_trial(db, uid):
    """Force a user into the 'live trial, clock already passed' state."""
    db.execute(
        "UPDATE users SET allowlisted=1, allowlist_source='trial', "
        "trial_end=datetime('now','-1 day') WHERE id=?",
        (uid,),
    )
    db.commit()


# ── activate grants permanent access in open mode ──────────

def test_open_signup_new_user_is_permanent_no_trial(client, app_module, monkeypatch, db):
    monkeypatch.setenv("OPEN_SIGNUP", "1")
    # admin-override code ("admin" via conftest) skips email verification but
    # still runs the same user UPSERT the real code path uses.
    r = client.post("/api/auth/skool/activate",
                    json={"email": "selfhoster@example.com", "code": "admin"})
    assert r.status_code == 200
    row = db.execute(
        "SELECT allowlisted, allowlist_source, trial_end FROM users WHERE email=?",
        ("selfhoster@example.com",),
    ).fetchone()
    assert row["allowlisted"] == 1
    assert row["allowlist_source"] == "open"
    assert row["trial_end"] is None


def test_open_signup_lets_in_previously_revoked(client, app_module, monkeypatch, db, seed_user):
    uid = seed_user("lapsed@example.com", "lapsed-handle")
    db.execute(
        "UPDATE users SET allowlisted=0, allowlist_source='trial:expired', "
        "revoked_at=datetime('now') WHERE id=?", (uid,))
    db.commit()
    monkeypatch.setenv("OPEN_SIGNUP", "1")
    r = client.post("/api/auth/skool/activate",
                    json={"email": "lapsed@example.com", "code": "admin"})
    assert r.status_code == 200
    row = db.execute("SELECT allowlisted, allowlist_source FROM users WHERE id=?", (uid,)).fetchone()
    assert row["allowlisted"] == 1
    assert row["allowlist_source"] == "open"


# ── no revoke-on-request in open mode ──────────────────────

def test_open_signup_does_not_revoke_expired_trial(client, app_module, monkeypatch, db, seed_user, login_as):
    uid = seed_user("trialer@example.com", "trialer-handle")
    login_as("trialer@example.com")
    _expire_trial(db, uid)
    monkeypatch.setenv("OPEN_SIGNUP", "1")
    # Any authed endpoint triggers before_request. Must NOT 401.
    r = client.get("/api/auth-status")
    assert r.status_code == 200
    r2 = client.get("/api/uploads")
    assert r2.status_code == 200
    row = db.execute("SELECT allowlisted FROM users WHERE id=?", (uid,)).fetchone()
    assert row["allowlisted"] == 1  # never got swept


def test_closed_mode_still_revokes_expired_trial(client, app_module, monkeypatch, db, seed_user, login_as):
    uid = seed_user("trialer2@example.com", "trialer2-handle")
    login_as("trialer2@example.com")
    _expire_trial(db, uid)
    monkeypatch.delenv("OPEN_SIGNUP", raising=False)
    r = client.get("/api/uploads")
    assert r.status_code == 401
    assert r.get_json().get("error") == "trial expired"


# ── auth-status advertises the mode to the frontend ────────

def test_open_signup_returns_code_when_no_email_provider(client, app_module, monkeypatch):
    # No RESEND_API_KEY in the test env → a self-hoster has no inbox. In open
    # mode the code is handed back in the response so login still works.
    monkeypatch.setenv("OPEN_SIGNUP", "1")
    r = client.post("/api/auth/skool/request-code", json={"email": "me@local.test"})
    assert r.status_code == 200
    body = r.get_json()
    assert "dev_code" in body and body["dev_code"].isdigit()


def test_closed_mode_never_returns_code(client, app_module, monkeypatch):
    monkeypatch.delenv("OPEN_SIGNUP", raising=False)
    r = client.post("/api/auth/skool/request-code", json={"email": "me@local.test"})
    assert r.status_code == 200
    assert "dev_code" not in r.get_json()


def test_auth_status_exposes_open_signup_flag(client, app_module, monkeypatch, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    monkeypatch.setenv("OPEN_SIGNUP", "1")
    assert client.get("/api/auth-status").get_json()["open_signup"] is True
    monkeypatch.delenv("OPEN_SIGNUP", raising=False)
    assert client.get("/api/auth-status").get_json()["open_signup"] is False
