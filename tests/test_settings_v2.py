"""Settings v2 — per-user API keys, prompt presets, and face-library listing.

These back the Settings v2 UI sections (API Keys / Face Library / Prompt
Presets). Same harness as test_uploads.py — fresh temp DB per test, Skool-gate
login via the callback mock.

Security invariant under test: GET /api/settings/api-keys NEVER returns a raw
key, only {set, masked}. Per-tenant isolation: a user only sees their own
keys / presets / face refs.
"""
import pytest


class _FakeS3:
    def __init__(self):
        self.deleted = []
    def generate_presigned_url(self, op, Params=None, ExpiresIn=None, HttpMethod=None):
        return f"https://fake-s3/{Params['Key']}?op={op}&expires={ExpiresIn}"
    def delete_object(self, Bucket=None, Key=None):
        self.deleted.append(Key)


@pytest.fixture
def fake_s3(app_module, monkeypatch):
    fake = _FakeS3()
    monkeypatch.setattr(app_module, "S3_BUCKET", "test-bucket")
    monkeypatch.setattr(app_module, "_s3_client", lambda: fake)
    return fake


# ── API keys ────────────────────────────────────────────────

def test_api_keys_get_empty_when_none_stored(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    r = client.get("/api/settings/api-keys")
    assert r.status_code == 200
    body = r.get_json()
    assert body["replicate_api_key"]["set"] is False
    assert body["airtable_token"]["set"] is False


def test_api_keys_post_persists_and_get_masks(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    r = client.post("/api/settings/api-keys",
                    json={"replicate_api_key": "r8_secretvalue1234"})
    assert r.status_code == 200

    r = client.get("/api/settings/api-keys")
    body = r.get_json()
    assert body["replicate_api_key"]["set"] is True
    # Masked hint shows only the last 4 chars, never the whole key.
    assert body["replicate_api_key"]["masked"] == "…1234"
    assert "r8_secretvalue1234" not in r.get_data(as_text=True)
    # Other key still unset.
    assert body["airtable_token"]["set"] is False


def test_api_keys_post_merges_only_provided(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    client.post("/api/settings/api-keys", json={"replicate_api_key": "r8_aaaa1111"})
    # Posting only airtable_token must not wipe the replicate key.
    client.post("/api/settings/api-keys", json={"airtable_token": "pat_bbbb2222"})
    body = client.get("/api/settings/api-keys").get_json()
    assert body["replicate_api_key"]["set"] is True
    assert body["airtable_token"]["set"] is True


def test_api_keys_empty_string_clears(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    client.post("/api/settings/api-keys", json={"replicate_api_key": "r8_xxxx9999"})
    client.post("/api/settings/api-keys", json={"replicate_api_key": ""})
    body = client.get("/api/settings/api-keys").get_json()
    assert body["replicate_api_key"]["set"] is False


def test_api_keys_isolated_per_tenant(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    seed_user("bob@example.com", "bob-handle")
    login_as("alice@example.com")
    client.post("/api/settings/api-keys", json={"replicate_api_key": "r8_alicekey0001"})

    login_as("bob@example.com")
    body = client.get("/api/settings/api-keys").get_json()
    assert body["replicate_api_key"]["set"] is False


# ── Prompt presets ──────────────────────────────────────────

def test_prompt_presets_get_falls_back_to_channel_default(client, seed_user, login_as, app_module):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    r = client.get("/api/settings/prompt-presets")
    assert r.status_code == 200
    body = r.get_json()
    # Defaults come from the bundled SOP / template.
    assert body["pixel_face"] == app_module._default_prompt_preset("pixel_face")
    assert body["faceless"] == app_module._default_prompt_preset("faceless")
    assert body["pixel_face_is_default"] is True
    assert body["faceless_is_default"] is True
    assert len(body["pixel_face"]) > 50
    assert len(body["faceless"]) > 50


def test_prompt_presets_post_persists(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    client.post("/api/settings/prompt-presets",
                json={"pixel_face": "my custom pixel prompt"})
    body = client.get("/api/settings/prompt-presets").get_json()
    assert body["pixel_face"] == "my custom pixel prompt"
    assert body["pixel_face_is_default"] is False
    # faceless untouched → still default
    assert body["faceless_is_default"] is True


def test_prompt_presets_empty_string_resets_to_default(client, seed_user, login_as, app_module):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    client.post("/api/settings/prompt-presets", json={"pixel_face": "temp override"})
    client.post("/api/settings/prompt-presets", json={"pixel_face": ""})
    body = client.get("/api/settings/prompt-presets").get_json()
    assert body["pixel_face"] == app_module._default_prompt_preset("pixel_face")
    assert body["pixel_face_is_default"] is True


def test_prompt_presets_isolated_per_tenant(client, seed_user, login_as):
    seed_user("alice@example.com", "alice-handle")
    seed_user("bob@example.com", "bob-handle")
    login_as("alice@example.com")
    client.post("/api/settings/prompt-presets", json={"faceless": "alice only"})

    login_as("bob@example.com")
    body = client.get("/api/settings/prompt-presets").get_json()
    assert body["faceless_is_default"] is True
    assert body["faceless"] != "alice only"


# ── Face library (uploads kind filter) ──────────────────────

def test_uploads_kind_filter_returns_only_matching(client, seed_user, login_as, fake_s3):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    client.post("/api/uploads/presign", json={"filename": "face1.png", "kind": "face_ref"})
    client.post("/api/uploads/presign", json={"filename": "face2.png", "kind": "face_ref"})
    client.post("/api/uploads/presign", json={"filename": "doc.pdf", "kind": "generic"})

    r = client.get("/api/uploads?kind=face_ref")
    assert r.status_code == 200
    names = sorted(u["original_filename"] for u in r.get_json())
    assert names == ["face1.png", "face2.png"]


def test_uploads_no_kind_filter_returns_all(client, seed_user, login_as, fake_s3):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    client.post("/api/uploads/presign", json={"filename": "face1.png", "kind": "face_ref"})
    client.post("/api/uploads/presign", json={"filename": "doc.pdf", "kind": "generic"})
    r = client.get("/api/uploads")
    assert len(r.get_json()) == 2
