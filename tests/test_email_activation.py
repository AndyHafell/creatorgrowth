"""Email-based activation + paid-member webhook tests.

The new default auth path:
  /api/auth/skool/activate {email} → 7-day trial, session, allowlisted=1
  /api/admin/paid-members  {email, name} → UPSERT, flips to 'paid', NULL trial_end

before_request enforces trial-expiry: if trial_end < now and source still
'trial', flip to 'trial:expired' and 401.
"""


def test_activate_new_user_starts_trial(client, db):
    r = client.post("/api/auth/skool/activate", json={"code": "admin", "email": "new@example.com"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["email"] == "new@example.com"

    row = db.execute(
        "SELECT allowlisted, allowlist_source, trial_end FROM users WHERE email = ?",
        ("new@example.com",),
    ).fetchone()
    assert row["allowlisted"] == 1
    assert row["allowlist_source"] == "trial"
    assert row["trial_end"] is not None

    # Session is live: subsequent authed request succeeds
    r = client.get("/api/auth-status")
    assert r.status_code == 200
    assert r.get_json()["authenticated"] is True


def test_activate_rejects_invalid_email(client):
    r = client.post("/api/auth/skool/activate", json={"code": "admin", "email": "not-an-email"})
    assert r.status_code == 400


def test_activate_blocks_revoked_user(client, db):
    db.execute(
        "INSERT INTO users (email, allowlisted, allowlist_source, revoked_at) "
        "VALUES ('churned@example.com', 0, 'trial:expired', datetime('now'))"
    )
    db.commit()
    r = client.post("/api/auth/skool/activate", json={"code": "admin", "email": "churned@example.com"})
    assert r.status_code == 403
    assert "join_url" in r.get_json()


def test_activate_logs_in_existing_paid_user(client, db):
    db.execute(
        "INSERT INTO users (email, allowlisted, allowlist_source, allowlisted_at) "
        "VALUES ('paid@example.com', 1, 'paid', datetime('now'))"
    )
    db.commit()
    r = client.post("/api/auth/skool/activate", json={"code": "admin", "email": "paid@example.com"})
    assert r.status_code == 200
    # Source stays 'paid' (we don't downgrade a paid user to trial)
    row = db.execute(
        "SELECT allowlist_source FROM users WHERE email = ?", ("paid@example.com",)
    ).fetchone()
    assert row["allowlist_source"] == "paid"


def test_paid_webhook_requires_bearer(client):
    r = client.post("/api/admin/paid-members", json={"email": "x@y.com"})
    assert r.status_code == 401


def test_paid_webhook_creates_new_paid_user(client, db):
    r = client.post(
        "/api/admin/paid-members",
        headers={"Authorization": "Bearer pytest-paid-token"},
        json={"email": "fresh@example.com", "name": "Fresh Convert"},
    )
    assert r.status_code == 200

    row = db.execute(
        "SELECT allowlisted, allowlist_source, trial_end, display_name "
        "FROM users WHERE email = ?", ("fresh@example.com",)
    ).fetchone()
    assert row["allowlisted"] == 1
    assert row["allowlist_source"] == "paid"
    assert row["trial_end"] is None
    assert row["display_name"] == "Fresh Convert"

    log = db.execute(
        "SELECT email, name FROM paid_webhook_log WHERE email = ?",
        ("fresh@example.com",),
    ).fetchone()
    assert log is not None
    assert log["name"] == "Fresh Convert"


def test_paid_webhook_upgrades_trial_user_to_paid(client, db):
    # User starts a trial, then Skool fires new_paid_member
    client.post("/api/auth/skool/activate", json={"code": "admin", "email": "convert@example.com"})
    row = db.execute(
        "SELECT allowlist_source, trial_end FROM users WHERE email = ?",
        ("convert@example.com",),
    ).fetchone()
    assert row["allowlist_source"] == "trial"
    assert row["trial_end"] is not None

    r = client.post(
        "/api/admin/paid-members",
        headers={"Authorization": "Bearer pytest-paid-token"},
        json={"email": "convert@example.com", "name": "Conversion Name"},
    )
    assert r.status_code == 200

    row = db.execute(
        "SELECT allowlisted, allowlist_source, trial_end, revoked_at "
        "FROM users WHERE email = ?", ("convert@example.com",),
    ).fetchone()
    assert row["allowlisted"] == 1
    assert row["allowlist_source"] == "paid"
    assert row["trial_end"] is None
    assert row["revoked_at"] is None


def test_paid_webhook_unrevokes_churned_user(client, db):
    # Old user was revoked; Skool fires new_paid_member (they re-subscribed)
    db.execute(
        "INSERT INTO users (email, allowlisted, allowlist_source, revoked_at) "
        "VALUES ('back@example.com', 0, 'trial:expired', datetime('now'))"
    )
    db.commit()
    r = client.post(
        "/api/admin/paid-members",
        headers={"Authorization": "Bearer pytest-paid-token"},
        json={"email": "back@example.com", "name": "Back Again"},
    )
    assert r.status_code == 200
    row = db.execute(
        "SELECT allowlisted, allowlist_source, revoked_at "
        "FROM users WHERE email = ?", ("back@example.com",),
    ).fetchone()
    assert row["allowlisted"] == 1
    assert row["allowlist_source"] == "paid"
    assert row["revoked_at"] is None


def test_trial_expiry_revokes_on_next_request(client, db):
    # Start trial then artificially backdate trial_end to the past
    client.post("/api/auth/skool/activate", json={"code": "admin", "email": "stale@example.com"})
    db.execute(
        "UPDATE users SET trial_end = datetime('now', '-1 hour') WHERE email = ?",
        ("stale@example.com",),
    )
    db.commit()

    # Next authed request should 401 with 'trial expired'
    r = client.get("/api/videos")
    assert r.status_code == 401
    body = r.get_json()
    assert body["error"] == "trial expired"
    assert body["join_url"] == "https://www.skool.com/aimate"

    # And the row is flipped
    row = db.execute(
        "SELECT allowlisted, allowlist_source FROM users WHERE email = ?",
        ("stale@example.com",),
    ).fetchone()
    assert row["allowlisted"] == 0
    assert row["allowlist_source"] == "trial:expired"


def test_trial_expiry_does_not_affect_paid_user(client, db):
    # Paid user has trial_end NULL — expiry sweep must skip them.
    client.post(
        "/api/admin/paid-members",
        headers={"Authorization": "Bearer pytest-paid-token"},
        json={"email": "loyal@example.com", "name": "Loyal Customer"},
    )
    # Now do an authed action as Loyal
    client.post("/api/auth/skool/activate", json={"code": "admin", "email": "loyal@example.com"})
    r = client.get("/api/videos")
    assert r.status_code == 200

    row = db.execute(
        "SELECT allowlisted, allowlist_source FROM users WHERE email = ?",
        ("loyal@example.com",),
    ).fetchone()
    assert row["allowlisted"] == 1
    assert row["allowlist_source"] == "paid"


def test_trial_still_valid_inside_window(client, db):
    # Fresh trial — trial_end is +7d. Next request should pass.
    client.post("/api/auth/skool/activate", json={"code": "admin", "email": "fresh@example.com"})
    r = client.get("/api/videos")
    assert r.status_code == 200


# ── Magic-code flow tests ────────────────────────────────────────────


def test_request_code_mints_pending_row(client, db):
    r = client.post("/api/auth/skool/request-code", json={"email": "code@example.com"})
    assert r.status_code == 200
    assert r.get_json()["sent_to"] == "code@example.com"

    row = db.execute(
        "SELECT code, status, expires_at FROM login_codes WHERE email = ?",
        ("code@example.com",),
    ).fetchone()
    assert row is not None
    assert len(row["code"]) == 6
    assert row["code"].isdigit()
    assert row["status"] == "pending"


def test_request_code_rejects_invalid_email(client):
    r = client.post("/api/auth/skool/request-code", json={"email": "not-an-email"})
    assert r.status_code == 400


def test_request_code_throttles_within_30s(client, db):
    client.post("/api/auth/skool/request-code", json={"email": "spam@example.com"})
    # Second call within 30s returns 200 + throttled flag, doesn't mint a new code
    r = client.post("/api/auth/skool/request-code", json={"email": "spam@example.com"})
    assert r.status_code == 200
    body = r.get_json()
    assert body.get("throttled") is True

    count = db.execute(
        "SELECT COUNT(*) c FROM login_codes WHERE email = ?", ("spam@example.com",)
    ).fetchone()["c"]
    assert count == 1


def test_activate_with_valid_code_logs_in(client, db):
    client.post("/api/auth/skool/request-code", json={"email": "real@example.com"})
    code = db.execute(
        "SELECT code FROM login_codes WHERE email = ? AND status = 'pending'",
        ("real@example.com",),
    ).fetchone()["code"]

    r = client.post(
        "/api/auth/skool/activate",
        json={"email": "real@example.com", "code": code},
    )
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["email"] == "real@example.com"

    # Code is now consumed
    status = db.execute(
        "SELECT status FROM login_codes WHERE code = ?", (code,)
    ).fetchone()["status"]
    assert status == "consumed"


def test_activate_rejects_wrong_code(client, db):
    client.post("/api/auth/skool/request-code", json={"email": "real@example.com"})
    r = client.post(
        "/api/auth/skool/activate",
        json={"email": "real@example.com", "code": "999999"},
    )
    assert r.status_code == 400


def test_activate_rejects_consumed_code(client, db):
    client.post("/api/auth/skool/request-code", json={"email": "twice@example.com"})
    code = db.execute(
        "SELECT code FROM login_codes WHERE email = ? AND status = 'pending'",
        ("twice@example.com",),
    ).fetchone()["code"]
    # First use succeeds
    client.post("/api/auth/skool/activate", json={"email": "twice@example.com", "code": code})
    # Second use fails
    r = client.post(
        "/api/auth/skool/activate",
        json={"email": "twice@example.com", "code": code},
    )
    assert r.status_code == 400
    assert "consumed" in r.get_json()["error"]


def test_activate_rejects_expired_code(client, db):
    client.post("/api/auth/skool/request-code", json={"email": "old@example.com"})
    code = db.execute(
        "SELECT code FROM login_codes WHERE email = ? AND status = 'pending'",
        ("old@example.com",),
    ).fetchone()["code"]
    # Backdate the code
    db.execute(
        "UPDATE login_codes SET expires_at = datetime('now', '-1 hour') WHERE code = ?",
        (code,),
    )
    db.commit()
    r = client.post(
        "/api/auth/skool/activate",
        json={"email": "old@example.com", "code": code},
    )
    assert r.status_code == 400
    assert "expired" in r.get_json()["error"].lower()


def test_admin_override_bypasses_code_check(client, db):
    # No /request-code call at all; admin string just works
    r = client.post(
        "/api/auth/skool/activate",
        json={"email": "owner@example.com", "code": "admin"},
    )
    assert r.status_code == 200
    assert r.get_json()["email"] == "owner@example.com"


def test_activate_requires_code(client):
    r = client.post("/api/auth/skool/activate", json={"email": "a@b.com"})
    assert r.status_code == 400
    assert "code" in r.get_json()["error"].lower()


def test_code_is_email_scoped(client, db):
    """Code minted for email A cannot be used to log into email B."""
    client.post("/api/auth/skool/request-code", json={"email": "a@example.com"})
    code = db.execute(
        "SELECT code FROM login_codes WHERE email = ?", ("a@example.com",)
    ).fetchone()["code"]
    r = client.post(
        "/api/auth/skool/activate",
        json={"email": "b@example.com", "code": code},
    )
    assert r.status_code == 400
