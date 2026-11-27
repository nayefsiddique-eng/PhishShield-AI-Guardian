import socket

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    def reject_network(*args, **kwargs):
        raise OSError("Network disabled in API tests")

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(socket.socket, "connect", reject_network)
        from server import app

        with TestClient(app) as test_client:
            yield test_client


@pytest.mark.parametrize("url", ["HTTPS://WWW.GOOGLE.COM/", "https://google.com.:443/"])
def test_whitelist_uses_canonical_hostname(client, url):
    response = client.post("/predict", json={"url": url})
    assert response.status_code == 200
    assert response.json()["whitelist"] is True
    assert response.json()["domain"] == "google.com"


def test_non_allowlisted_url_runs_shipped_model(client):
    response = client.post("/predict", json={"url": "example.org"})
    assert response.status_code == 200
    assert response.json()["whitelist"] is False
    assert 0 <= response.json()["ml_score"] <= 100


@pytest.mark.parametrize("url", ["ftp://example.org", "https:///example.org", "https://example.org:invalid", "https://exa mple.org"])
def test_malformed_url(client, url):
    assert client.post("/predict", json={"url": url}).status_code == 400
