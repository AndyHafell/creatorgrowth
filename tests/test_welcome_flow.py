"""Welcome/Join gate tests.

The front door: unauthenticated visitors land on /welcome (yes/no), where
"Yes" → /activate (the existing email-code overlay) and "No" → /join (the
'go start your Skool trial' page). Both /welcome and /join are open paths.
"""


def test_welcome_open_no_auth(client):
    r = client.get("/welcome")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    # Both CTAs present.
    assert 'href="/activate"' in body
    assert 'href="/join"' in body
    # Welcome card rendered (not the email form).
    assert "welcome-card" in body
    assert "Agent OS" in body
    assert "YouTube channel" in body
    # And the auth-overlay backdrop is showing (so the SPA blurs behind it).
    assert 'class="auth-overlay ' in body or "auth-overlay\"" in body
    # Value-based copy, not "dashboard for AI Mate members" framing.
    assert "dashboard for AI Mate members" not in body


def test_join_open_no_auth(client):
    r = client.get("/join")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    # External Skool link (canonical URL, no hyphen).
    assert "https://www.skool.com/aimate" in body
    assert "skool.com/ai-mate" not in body
    # Back link to welcome.
    assert 'href="/welcome"' in body


def test_root_unauthenticated_redirects_to_welcome(client):
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["Location"].endswith("/welcome")


def test_root_authenticated_renders_spa(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 200
    # SPA marker — main container of the dashboard lives in index.html.
    body = r.get_data(as_text=True)
    assert "authOverlay" in body  # auth overlay markup exists even when hidden


def test_welcome_authenticated_redirects_to_root(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    r = client.get("/welcome", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["Location"].endswith("/")


def test_activate_open_no_auth_shows_overlay(client):
    r = client.get("/activate")
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    # The auth overlay must NOT be hidden when serving /activate to an
    # unauthenticated visitor — otherwise the email-code form is unreachable.
    assert 'id="authOverlay"' in body
    assert 'class="auth-overlay hidden"' not in body
    # Back link to /welcome is present on /activate (the front-door path).
    assert 'class="auth-back-link"' in body
    assert 'href="/welcome"' in body
