"""Test harness for the Skool gate + per-user data scoping.

Strategy: each test gets a fresh sqlite DB at a temp path. We import `app` with
that DB path env so migrate_schema runs against the new file. We talk to the
app via Flask's test client (no network). The `seed_user` fixture mints
allowlisted users for the test to log in with.
"""
import importlib
import os
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))


@pytest.fixture
def app_module(tmp_path, monkeypatch):
    """Import a clean app.py instance bound to a temp DB.

    We have to fully reload the module because top-level `init_db()` and
    `migrate_schema()` only run once per process; each test wants its own DB
    state."""
    db_path = tmp_path / "videos_test.db"
    monkeypatch.setenv("DB_PATH", str(db_path))
    # Isolate per-tenant content writes to a temp dir so tests never touch the
    # real content_docs folder. CONTENT_DIR is read at import, and app_module
    # reloads the module fresh per test, so this takes effect.
    monkeypatch.setenv("CONTENT_DIR", str(tmp_path / "content"))
    monkeypatch.setenv("SECRET_KEY", "pytest-secret-key")
    monkeypatch.setenv("DM_VERIFY_TOKEN", "pytest-dm-token")
    monkeypatch.setenv("PAID_WEBHOOK_TOKEN", "pytest-paid-token")
    monkeypatch.setenv("ADMIN_LOGIN_PASSWORD", "admin")
    # Clear any prior import so module-level init runs fresh against this DB.
    for mod in [m for m in list(sys.modules) if m == "app"]:
        del sys.modules[mod]
    mod = importlib.import_module("app")
    mod.app.config["TESTING"] = True
    return mod


@pytest.fixture
def client(app_module):
    return app_module.app.test_client()


@pytest.fixture
def db(app_module):
    """A short-lived connection to the test DB for direct row reads/writes."""
    import sqlite3
    c = sqlite3.connect(app_module.DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    yield c
    c.close()


def _seed_allowlisted(db, email: str, handle: str) -> int:
    """Helper used by individual tests to add allowlisted users."""
    db.execute(
        "INSERT INTO users (email, skool_handle, allowlisted, allowlist_source, allowlisted_at) "
        "VALUES (?, ?, 1, 'pytest', datetime('now')) "
        "ON CONFLICT(email) DO UPDATE SET "
        "  skool_handle=excluded.skool_handle, allowlisted=1, "
        "  allowlist_source='pytest', allowlisted_at=datetime('now'), revoked_at=NULL",
        (email, handle),
    )
    db.commit()
    return db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()["id"]


@pytest.fixture
def seed_user(db):
    """Returns a factory: seed_user(email, handle) → uid."""
    def _seed(email: str, handle: str) -> int:
        return _seed_allowlisted(db, email, handle)
    return _seed


@pytest.fixture
def login_as(client):
    """Returns a factory: login_as(user_email) → uses /api/auth/skool/callback
    mock path to mint a session. Asserts the response is 200; raises on
    rejection so tests fail loudly when the gate accidentally blocks an
    allowlisted user."""
    def _login(user_email: str):
        r = client.post(
            "/api/auth/skool/callback",
            json={"code": "pytest", "user_email": user_email},
        )
        assert r.status_code == 200, (
            f"login_as({user_email}) expected 200, got {r.status_code}: {r.get_json()}"
        )
        return r.get_json()
    return _login
