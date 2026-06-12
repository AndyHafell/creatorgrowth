"""Per-tenant isolation for /api/content/* endpoints.

Each user only sees files inside CONTENT_DIR/u<their_id>/. Path traversal
attempts via `..` are rejected. Two users with the same filename never collide."""


def test_content_list_isolated_per_tenant(client, seed_user, login_as, app_module):
    """Files written into alice's u<id> dir aren't visible to bob."""
    alice = seed_user("alice@example.com", "alice-handle")
    bob   = seed_user("bob@example.com",   "bob-handle")
    root = app_module.CONTENT_DIR
    (root / f"u{alice}").mkdir(parents=True, exist_ok=True)
    (root / f"u{bob}").mkdir(parents=True, exist_ok=True)
    (root / f"u{alice}" / "alice_only.md").write_text("hello from alice")
    (root / f"u{bob}"   / "bob_only.md").write_text("hello from bob")

    login_as("alice@example.com")
    r = client.get("/api/content")
    assert r.status_code == 200
    paths = [f["path"] for f in r.get_json()["files"]]
    assert "alice_only.md" in paths
    assert "bob_only.md" not in paths


def test_content_read_blocks_cross_tenant(client, seed_user, login_as, app_module):
    """Bob cannot read alice's file even if he knows the filename."""
    alice = seed_user("alice@example.com", "alice-handle")
    bob   = seed_user("bob@example.com",   "bob-handle")
    root = app_module.CONTENT_DIR
    (root / f"u{alice}").mkdir(parents=True, exist_ok=True)
    (root / f"u{alice}" / "secret.md").write_text("alice secret")

    login_as("bob@example.com")
    r = client.get("/api/content/file?path=secret.md")
    assert r.status_code == 404


def test_content_path_traversal_blocked(client, seed_user, login_as, app_module):
    """`../alice_file.md`-style paths can't escape the tenant root."""
    alice = seed_user("alice@example.com", "alice-handle")
    bob   = seed_user("bob@example.com",   "bob-handle")
    root = app_module.CONTENT_DIR
    (root / f"u{alice}").mkdir(parents=True, exist_ok=True)
    (root / f"u{alice}" / "treasure.md").write_text("$$$")

    login_as("bob@example.com")
    # Try to escape via ../
    r = client.get(f"/api/content/file?path=../u{alice}/treasure.md")
    assert r.status_code in (403, 404)


def test_content_save_writes_to_own_root(client, seed_user, login_as, app_module):
    """PUT lands in /u<bob>/ not in the shared root."""
    bob = seed_user("bob@example.com", "bob-handle")
    login_as("bob@example.com")
    r = client.put(
        "/api/content/file",
        json={"path": "bob_doc.md", "content": "from bob"},
    )
    assert r.status_code == 200

    target = app_module.CONTENT_DIR / f"u{bob}" / "bob_doc.md"
    assert target.exists()
    assert target.read_text() == "from bob"
    # And NOT at the shared root
    assert not (app_module.CONTENT_DIR / "bob_doc.md").exists()


def test_content_same_filename_different_tenants(client, seed_user, login_as, app_module):
    """Two users can both have notes.md without colliding."""
    alice = seed_user("alice@example.com", "alice-handle")
    bob   = seed_user("bob@example.com",   "bob-handle")

    login_as("alice@example.com")
    client.put("/api/content/file", json={"path": "notes.md", "content": "alice's notes"})

    login_as("bob@example.com")
    client.put("/api/content/file", json={"path": "notes.md", "content": "bob's notes"})

    login_as("alice@example.com")
    r = client.get("/api/content/file?path=notes.md")
    assert r.get_json()["content"] == "alice's notes"

    login_as("bob@example.com")
    r = client.get("/api/content/file?path=notes.md")
    assert r.get_json()["content"] == "bob's notes"
