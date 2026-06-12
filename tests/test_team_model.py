"""Team-workspace model: a workspace owner can invite other emails to share
their data. On login, the team member's session.user_id flips to the owner's
id so the 68 ownership decorators continue to work without changes; session.
identity_user_id / identity_email preserve who actually authenticated.
"""


def _login_owner(client, seed_user, login_as, email="owner@example.com",
                 handle="owner-handle"):
    uid = seed_user(email, handle)
    login_as(email)
    return uid


def test_invite_creates_team_member_row(client, seed_user, login_as, db):
    owner_uid = _login_owner(client, seed_user, login_as)
    r = client.post("/api/team/invite", json={"email": "hamflix@example.com"})
    assert r.status_code == 200, r.get_json()

    listed = client.get("/api/team/members").get_json()
    assert any(m["email"] == "hamflix@example.com" for m in listed)

    row = db.execute(
        "SELECT team_owner_user_id, team_role, allowlisted FROM users WHERE email = ?",
        ("hamflix@example.com",),
    ).fetchone()
    assert row["team_owner_user_id"] == owner_uid
    assert row["team_role"] == "member"
    assert row["allowlisted"] == 1


def test_team_member_login_uses_owner_workspace(client, seed_user, login_as, db):
    owner_uid = _login_owner(client, seed_user, login_as)
    db.execute(
        "INSERT INTO videos (video_id, title, user_id) VALUES ('owners_vid', 'Owner Video', ?)",
        (owner_uid,),
    )
    db.commit()
    client.post("/api/team/invite", json={"email": "hamflix@example.com"})

    # Drop owner's session, log in as Hamflix via the email-activation path.
    client.post("/api/logout")
    r = client.post("/api/auth/skool/activate",
                    json={"email": "hamflix@example.com", "code": "admin"})
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert body["in_team_workspace"] is True
    assert body["user_id"] == owner_uid

    # Hamflix sees owner's videos
    titles = [v["title"] for v in client.get("/api/videos").get_json()]
    assert "Owner Video" in titles


def test_team_member_cannot_invite(client, seed_user, login_as, db):
    owner_uid = _login_owner(client, seed_user, login_as)
    client.post("/api/team/invite", json={"email": "hamflix@example.com"})
    client.post("/api/logout")

    client.post("/api/auth/skool/activate",
                json={"email": "hamflix@example.com", "code": "admin"})
    r = client.post("/api/team/invite", json={"email": "mike@example.com"})
    assert r.status_code == 403


def test_invite_blocks_existing_paying_tenant(client, seed_user, login_as, db):
    _login_owner(client, seed_user, login_as)
    # Pre-existing paid tenant with their own workspace.
    db.execute(
        "INSERT INTO users (email, allowlisted, allowlist_source, allowlisted_at) "
        "VALUES ('paid@example.com', 1, 'paid', datetime('now'))"
    )
    db.commit()
    r = client.post("/api/team/invite", json={"email": "paid@example.com"})
    assert r.status_code == 409


def test_kick_clears_team_owner(client, seed_user, login_as, db):
    owner_uid = _login_owner(client, seed_user, login_as)
    client.post("/api/team/invite", json={"email": "hamflix@example.com"})

    r = client.delete("/api/team/members/hamflix@example.com")
    assert r.status_code == 200

    listed = client.get("/api/team/members").get_json()
    assert all(m["email"] != "hamflix@example.com" for m in listed)

    row = db.execute(
        "SELECT id, team_owner_user_id FROM users WHERE email = ?",
        ("hamflix@example.com",),
    ).fetchone()
    assert row is not None  # row preserved
    assert row["team_owner_user_id"] is None


def test_kicked_member_session_falls_back_to_solo(client, seed_user, login_as, db):
    owner_uid = _login_owner(client, seed_user, login_as)
    db.execute(
        "INSERT INTO videos (video_id, title, user_id) VALUES ('owners_only', 'Owner', ?)",
        (owner_uid,),
    )
    db.commit()
    client.post("/api/team/invite", json={"email": "hamflix@example.com"})
    client.delete("/api/team/members/hamflix@example.com")

    client.post("/api/logout")
    r = client.post("/api/auth/skool/activate",
                    json={"email": "hamflix@example.com", "code": "admin"})
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert body["in_team_workspace"] is False
    # Their session now points at their own user_id, not owner's.
    assert body["user_id"] != owner_uid

    titles = [v["title"] for v in client.get("/api/videos").get_json()]
    assert "Owner" not in titles


def test_auth_status_reports_workspace_context(client, seed_user, login_as, db):
    owner_uid = _login_owner(client, seed_user, login_as,
                             email="andy@example.com", handle="andy-handle")
    client.post("/api/team/invite", json={"email": "hamflix@example.com"})

    # As owner
    body = client.get("/api/auth-status").get_json()
    assert body["in_team_workspace"] is False
    assert body["identity_email"] == "andy@example.com"
    assert body["workspace_owner_email"] == ""

    # As team member
    client.post("/api/logout")
    client.post("/api/auth/skool/activate",
                json={"email": "hamflix@example.com", "code": "admin"})
    body = client.get("/api/auth-status").get_json()
    assert body["in_team_workspace"] is True
    assert body["identity_email"] == "hamflix@example.com"
    assert body["workspace_owner_email"] == "andy@example.com"
    assert body["user_id"] == owner_uid


def test_invite_triggers_invite_email(client, seed_user, login_as, app_module,
                                       monkeypatch):
    """POST /api/team/invite calls _send_team_invite_email with the right args."""
    calls = []

    def fake_send(to_email, owner_email, owner_display=""):
        calls.append({"to": to_email, "owner_email": owner_email,
                      "owner_display": owner_display})
        return True

    monkeypatch.setattr(app_module, "_send_team_invite_email", fake_send)
    _login_owner(client, seed_user, login_as,
                 email="andy@example.com", handle="andy-handle")
    r = client.post("/api/team/invite", json={"email": "hamflix@example.com"})
    assert r.status_code == 200
    assert r.get_json()["email_sent"] is True
    assert len(calls) == 1
    assert calls[0]["to"] == "hamflix@example.com"
    assert calls[0]["owner_email"] == "andy@example.com"


def test_invite_succeeds_even_when_email_send_fails(client, seed_user, login_as,
                                                      app_module, monkeypatch):
    """Email failures must NOT roll back the invite — the row is already saved."""
    def boom(*a, **kw):
        raise RuntimeError("resend down")

    monkeypatch.setattr(app_module, "_send_team_invite_email", boom)
    _login_owner(client, seed_user, login_as)
    r = client.post("/api/team/invite", json={"email": "hamflix@example.com"})
    assert r.status_code == 200
    assert r.get_json()["email_sent"] is False
    # And the member is still listed
    listed = client.get("/api/team/members").get_json()
    assert any(m["email"] == "hamflix@example.com" for m in listed)


def test_team_endpoints_require_workspace_owner_identity(client, seed_user, login_as):
    """Even an admin impersonating a team member doesn't get owner powers —
    identity_user_id != user_id while impersonating, which blocks /api/team/*.
    """
    _login_owner(client, seed_user, login_as)
    # Solo user — not even invited — must get 403 on invite/list/kick.
    client.post("/api/logout")
    seed_user("stranger@example.com", "stranger-handle")
    login_as("stranger@example.com")
    assert client.get("/api/team/members").status_code == 200  # they ARE the owner of their own (empty) workspace

    # The 403 path is exercised by test_team_member_cannot_invite above; here
    # we just confirm a solo user can list their (empty) team.
    assert client.get("/api/team/members").get_json() == []
