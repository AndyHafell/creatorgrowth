"""Per-user card-push API token + POST /api/cards/push.

A user generates a token in Settings (session-authed), then pushes cards
programmatically with `Authorization: Bearer <token>`. Cards (and any attached
content doc) are scoped to the token's user — never another tenant.
"""


def _gen_token(client, email, login_as):
    login_as(email)
    r = client.post("/api/settings/api-token")
    assert r.status_code == 200, r.get_json()
    tok = r.get_json()["token"]
    assert tok.startswith("cg_")
    return tok


def _auth(tok):
    return {"Authorization": f"Bearer {tok}"}


def test_token_generate_get_and_mask(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")

    # Before generating: not set.
    r = client.get("/api/settings/api-token")
    assert r.status_code == 200
    assert r.get_json()["set"] is False

    # Generate → full token returned once.
    r = client.post("/api/settings/api-token")
    tok = r.get_json()["token"]
    assert tok.startswith("cg_")

    # GET now reports set=True and never echoes the full token.
    r = client.get("/api/settings/api-token")
    body = r.get_json()
    assert body["set"] is True
    assert "token" not in body
    assert tok not in body["masked"]
    assert body["masked"].startswith("cg_")


def test_push_card_with_token(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    tok = _gen_token(client, "alice@example.com", login_as)

    r = client.post("/api/cards/push", headers=_auth(tok), json={"title": "Pushed Idea"})
    assert r.status_code == 201, r.get_json()
    card = r.get_json()["card"]
    assert card["title"] == "Pushed Idea"
    assert card["video_id"].startswith("cg_")

    # It shows up in the owner's dashboard.
    login_as("alice@example.com")
    titles = [v["title"] for v in client.get("/api/videos").get_json()]
    assert "Pushed Idea" in titles


def test_push_scoped_to_token_user(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    seed_user("bob@example.com", "bob-handle")
    tok_alice = _gen_token(client, "alice@example.com", login_as)

    r = client.post("/api/cards/push", headers=_auth(tok_alice), json={"title": "Alice Only"})
    assert r.status_code == 201

    # Bob never sees Alice's pushed card.
    login_as("bob@example.com")
    titles = [v["title"] for v in client.get("/api/videos").get_json()]
    assert "Alice Only" not in titles


def test_push_with_content_doc_is_readable(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    tok = _gen_token(client, "alice@example.com", login_as)

    r = client.post(
        "/api/cards/push",
        headers=_auth(tok),
        json={"title": "Doc Card", "content_doc": "# Hello\n\nbody text", "doc_filename": "my-doc"},
    )
    assert r.status_code == 201
    rel = r.get_json()["content_doc_path"]
    assert rel == "content_docs/my-doc.md"

    # The owner can read it back through the per-tenant content reader.
    login_as("alice@example.com")
    rr = client.get(f"/api/content/file?path={rel}")
    assert rr.status_code == 200
    assert "body text" in rr.get_json()["content"]


def test_push_status_override(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    tok = _gen_token(client, "alice@example.com", login_as)
    r = client.post("/api/cards/push", headers=_auth(tok), json={"title": "Scripted", "status": "script"})
    assert r.status_code == 201
    assert r.get_json()["card"]["status"] == "script"


def test_push_requires_token(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    # No token at all.
    r = client.post("/api/cards/push", json={"title": "X"})
    assert r.status_code == 401
    # Bogus token.
    r = client.post("/api/cards/push", headers=_auth("cg_not_a_real_token"), json={"title": "X"})
    assert r.status_code == 401


def test_push_requires_title(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    tok = _gen_token(client, "alice@example.com", login_as)
    r = client.post("/api/cards/push", headers=_auth(tok), json={"title": "   "})
    assert r.status_code == 400


def test_regenerate_invalidates_old_token(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    tok1 = _gen_token(client, "alice@example.com", login_as)
    # Regenerate → new token, old one dies.
    login_as("alice@example.com")
    tok2 = client.post("/api/settings/api-token").get_json()["token"]
    assert tok2 != tok1

    assert client.post("/api/cards/push", headers=_auth(tok1), json={"title": "A"}).status_code == 401
    assert client.post("/api/cards/push", headers=_auth(tok2), json={"title": "A"}).status_code == 201


def test_revoke_token(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    tok = _gen_token(client, "alice@example.com", login_as)
    login_as("alice@example.com")
    assert client.delete("/api/settings/api-token").status_code == 200
    assert client.post("/api/cards/push", headers=_auth(tok), json={"title": "A"}).status_code == 401
    assert client.get("/api/settings/api-token").get_json()["set"] is False
