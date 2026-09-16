"""DSİ adapter unit tests (mocked HTTP, no network needed)."""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fetch_dsi import normalize_dam_row


class FakeHeaders(dict):
    def items(self):
        return super().items()


class FakeResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode("utf-8")
        self.headers = {}

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def fake_urlopen_factory(routes):
    def fake_urlopen(request, timeout=None):
        url = request.full_url if hasattr(request, "full_url") else str(request)
        for prefix, payload in routes.items():
            if url.startswith(prefix):
                if isinstance(payload, Exception):
                    raise payload
                return FakeResponse(payload)
        raise AssertionError(f"unexpected URL {url}")
    return fake_urlopen


def sandboxed_providers(testcase):
    """Redirect provider-file writes to a temp dir so tests can NEVER leak
    mock observations into public/data."""
    import tempfile
    import providers
    directory = tempfile.TemporaryDirectory()
    testcase.addCleanup(directory.cleanup)
    patcher = patch.object(providers, "OBS_DIR", Path(directory.name))
    patcher.start()
    testcase.addCleanup(patcher.stop)


class DsiAdapterTest(unittest.TestCase):
    def test_normalize_dam_row(self):
        row = {"damName": "KEBAN", "activeFullnessPercent": 72.5,
               "activeVolumeMillionM3": 9000, "observationDate": "2026-09-16"}
        obs = normalize_dam_row(row, "https://example")
        self.assertIsNotNone(obs)
        assert obs is not None
        self.assertEqual(obs["provider"], "dsi")
        self.assertEqual(obs["sourceClass"], "official_published")
        self.assertAlmostEqual(obs["fullnessPercent"], 72.5)
        self.assertFalse(obs.get("isEstimated", True) is True)

    def test_normalize_rejects_incomplete(self):
        self.assertIsNone(normalize_dam_row({"damName": "X", "observationDate": "2026-09-16"}, "u"))
        self.assertIsNone(normalize_dam_row({"damName": "X", "activeFullnessPercent": 50}, "u"))
        self.assertIsNone(normalize_dam_row("not-a-dict", "u"))

    def test_no_per_dam_endpoint_honest(self):
        sandboxed_providers(self)
        import fetch_dsi
        routes = {
            "https://x/api/Dashboard/latest-published-date": {"publishedDataDate": "2026-09-16"},
            "https://x/api/DamMetrics/national/purpose-daily": [],
            "https://x/api/DamMetrics/province/daily": [],
        }
        # Call main() for real (argparse defaults) under the same mocks.
        with patch.object(fetch_dsi, "DEFAULT_BASE_URL", "https://x"):
            with patch("fetch_dsi.urlopen", side_effect=fake_urlopen_factory(routes)):
                with patch.dict("os.environ", {}, clear=False):
                    import os
                    os.environ.pop("DSI_DAM_ENDPOINT", None)
                    import tempfile
                    with tempfile.TemporaryDirectory() as directory:
                        out = str(Path(directory) / "dsi.json")
                        with patch("sys.argv", ["fetch_dsi", "--output", out]):
                            self.assertEqual(fetch_dsi.main(), 0)
                        payload = json.loads(Path(out).read_text(encoding="utf-8"))
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["publishedDataDate"], "2026-09-16")
        self.assertEqual(payload["records"], [])
        self.assertFalse(payload["perDamAvailable"])

    def test_per_dam_endpoint_when_configured(self):
        sandboxed_providers(self)
        import fetch_dsi
        routes = {
            "https://x/api/Dashboard/latest-published-date": {"publishedDataDate": "2026-09-16"},
            "https://x/api/DamMetrics/national/purpose-daily": [],
            "https://x/api/DamMetrics/province/daily": [],
            "https://dams/feed": [{"damName": "KEBAN", "activeFullnessPercent": 70,
                                   "observationDate": "2026-09-16"}],
        }
        with patch.object(fetch_dsi, "DEFAULT_BASE_URL", "https://x"):
            with patch("fetch_dsi.urlopen", side_effect=fake_urlopen_factory(routes)):
                with patch.dict("os.environ", {"DSI_DAM_ENDPOINT": "https://dams/feed"}):
                    import tempfile
                    with tempfile.TemporaryDirectory() as directory:
                        out = str(Path(directory) / "dsi.json")
                        with patch("sys.argv", ["fetch_dsi", "--output", out]):
                            self.assertEqual(fetch_dsi.main(), 0)
                        payload = json.loads(Path(out).read_text(encoding="utf-8"))
        self.assertTrue(payload["perDamAvailable"])
        self.assertEqual(len(payload["records"]), 1)
        self.assertEqual(payload["records"][0]["sourceClass"], "official_published")

    def test_dedupe_key_shared(self):
        from providers import dedupe_key
        self.assertEqual(dedupe_key("h", "dsi", "2026-09-16", "official_published"),
                         "h|dsi|2026-09-16|official_published")


if __name__ == "__main__":
    unittest.main()
