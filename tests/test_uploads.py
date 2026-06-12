"""S3 presigned upload metadata + per-tenant ownership.

S3 calls themselves are stubbed via monkeypatching `_s3_client` — we verify
the metadata flow + the access control around it, not boto3 itself."""

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


def test_presign_requires_filename(client, seed_user, login_as, fake_s3):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    r = client.post("/api/uploads/presign", json={})
    assert r.status_code == 400


def test_presign_returns_signed_put_url(client, seed_user, login_as, fake_s3, db):
    uid = seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    r = client.post("/api/uploads/presign", json={
        "filename": "feedback video.mp4",
        "kind": "feedback_video",
        "content_type": "video/mp4",
    })
    assert r.status_code == 200
    body = r.get_json()
    assert "upload_url" in body
    assert body["upload_url"].startswith("https://fake-s3/")
    assert body["expires_in"] == 900
    # Filename gets sanitized (space → underscore)
    assert "feedback_video.mp4" in body["key"]
    # Key is scoped under u<uid>/
    assert f"/u{uid}/" in body["key"]

    # Row exists, uploaded=0
    row = db.execute(
        "SELECT user_id, kind, content_type, uploaded FROM uploads WHERE id = ?",
        (body["upload_id"],),
    ).fetchone()
    assert row["user_id"] == uid
    assert row["kind"] == "feedback_video"
    assert row["content_type"] == "video/mp4"
    assert row["uploaded"] == 0


def test_presign_503_when_s3_not_configured(client, seed_user, login_as, app_module, monkeypatch):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    monkeypatch.setattr(app_module, "S3_BUCKET", "")
    r = client.post("/api/uploads/presign", json={"filename": "x.mp4"})
    assert r.status_code == 503


def test_finalize_marks_row_uploaded(client, seed_user, login_as, fake_s3, db):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    r = client.post("/api/uploads/presign", json={"filename": "a.bin"})
    upload_id = r.get_json()["upload_id"]

    r = client.post(f"/api/uploads/{upload_id}/finalize", json={"size_bytes": 12345})
    assert r.status_code == 200

    row = db.execute(
        "SELECT uploaded, size_bytes, finalized_at FROM uploads WHERE id = ?",
        (upload_id,),
    ).fetchone()
    assert row["uploaded"] == 1
    assert row["size_bytes"] == 12345
    assert row["finalized_at"] is not None


def test_finalize_blocks_cross_tenant(client, seed_user, login_as, fake_s3):
    seed_user("alice@example.com", "alice-handle")
    seed_user("bob@example.com",   "bob-handle")
    login_as("alice@example.com")
    upload_id = client.post("/api/uploads/presign", json={"filename": "alice.bin"}).get_json()["upload_id"]

    login_as("bob@example.com")
    r = client.post(f"/api/uploads/{upload_id}/finalize", json={"size_bytes": 1})
    assert r.status_code == 404


def test_list_returns_only_own(client, seed_user, login_as, fake_s3):
    seed_user("alice@example.com", "alice-handle")
    seed_user("bob@example.com",   "bob-handle")
    login_as("alice@example.com")
    client.post("/api/uploads/presign", json={"filename": "alice1.bin"})
    client.post("/api/uploads/presign", json={"filename": "alice2.bin"})

    login_as("bob@example.com")
    client.post("/api/uploads/presign", json={"filename": "bob1.bin"})

    r = client.get("/api/uploads")
    assert r.status_code == 200
    filenames = sorted(u["original_filename"] for u in r.get_json())
    assert filenames == ["bob1.bin"]


def test_download_signs_get_url(client, seed_user, login_as, fake_s3):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    upload_id = client.post("/api/uploads/presign", json={"filename": "x.bin"}).get_json()["upload_id"]
    r = client.get(f"/api/uploads/{upload_id}/download")
    assert r.status_code == 200
    body = r.get_json()
    assert body["download_url"].startswith("https://fake-s3/")
    assert "op=get_object" in body["download_url"]
    assert body["expires_in"] == 3600


def test_download_blocks_cross_tenant(client, seed_user, login_as, fake_s3):
    seed_user("alice@example.com", "alice-handle")
    seed_user("bob@example.com",   "bob-handle")
    login_as("alice@example.com")
    upload_id = client.post("/api/uploads/presign", json={"filename": "secret.bin"}).get_json()["upload_id"]

    login_as("bob@example.com")
    r = client.get(f"/api/uploads/{upload_id}/download")
    assert r.status_code == 404


def test_delete_removes_s3_and_row(client, seed_user, login_as, fake_s3, db):
    seed_user("alice@example.com", "alice-handle")
    login_as("alice@example.com")
    presign = client.post("/api/uploads/presign", json={"filename": "doomed.bin"}).get_json()
    upload_id, key = presign["upload_id"], presign["key"]

    r = client.delete(f"/api/uploads/{upload_id}")
    assert r.status_code == 200
    assert key in fake_s3.deleted

    row = db.execute("SELECT 1 FROM uploads WHERE id = ?", (upload_id,)).fetchone()
    assert row is None


def test_delete_blocks_cross_tenant(client, seed_user, login_as, fake_s3):
    seed_user("alice@example.com", "alice-handle")
    seed_user("bob@example.com",   "bob-handle")
    login_as("alice@example.com")
    upload_id = client.post("/api/uploads/presign", json={"filename": "alice.bin"}).get_json()["upload_id"]

    login_as("bob@example.com")
    r = client.delete(f"/api/uploads/{upload_id}")
    assert r.status_code == 404
