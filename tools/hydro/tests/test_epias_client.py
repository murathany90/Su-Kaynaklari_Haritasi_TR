"""EPİAŞ client unit tests (mocked transport, no credentials needed)."""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from epias_client import EpiasError, extract_rows, fetch_active_fullness, normalize_row


class FakeResponse:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code = status
        self._payload = payload
        self.text = text
        self.ok = 200 <= status < 300

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeSession:
    def __init__(self, routes):
        self.routes = routes
        self.posts = []

    def post(self, url, **kwargs):
        self.posts.append((url, kwargs.get("json")))
        handler = self.routes.get(url)
        if handler is None:
            return FakeResponse(404, {})
        return handler(url, kwargs.get("json"))


def session_with(responses):
    return FakeSession(responses)


class EpiasClientTest(unittest.TestCase):
    def test_missing_credentials_skips(self):
        with patch.dict("os.environ", {}, clear=False):
            import os
            os.environ.pop("EPIAS_USERNAME", None)
            os.environ.pop("EPIAS_PASSWORD", None)
            result = fetch_active_fullness([{"damName": "X"}])
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["errorCode"], "credentials_missing")

    def test_auth_failure_taxonomy(self):
        import requests
        session = session_with({"https://tgt": lambda u, b: FakeResponse(401, {}, text="")})
        with patch("epias_client.requests.Session", return_value=session):
            with patch.dict("os.environ", {"EPIAS_USERNAME": "u", "EPIAS_PASSWORD": "p"}):
                result = fetch_active_fullness([{"damName": "X"}], tgt_url="https://tgt")
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["errorCode"], "auth_failed")

    def test_post_shape_pagination_and_normalize(self):
        passtickets = {"https://tgt": lambda u, b: FakeResponse(200, None, text="TGT-1")}
        seen_bodies = []

        def data(url, body):
            seen_bodies.append(dict(body))
            page = body["page"]
            if page == 0:
                return FakeResponse(200, {"items": [{"damName": body["damName"], "basinName": "B",
                                                     "activeFullness": 71.2, "observationDate": "2026-09-15"}],
                                          "hasMore": True})
            return FakeResponse(200, {"items": [{"damName": body["damName"], "activeFullness": 70.1,
                                                 "observationDate": "2026-09-14"}], "hasMore": False})

        routes = {**passtickets, "https://e/v1/dams/data/active-fullness": data}
        with patch("epias_client.requests.Session", return_value=session_with(routes)):
            with patch.dict("os.environ", {"EPIAS_USERNAME": "u", "EPIAS_PASSWORD": "p"}):
                result = fetch_active_fullness([{"damName": "Atatürk", "basinName": "Fırat"}],
                                               endpoint="https://e/v1/dams/data/active-fullness",
                                               tgt_url="https://tgt", request_gap_s=0)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["observations"]), 2)
        # Required POST contract: damName + basinName + page, TGT header used.
        self.assertEqual(seen_bodies[0]["damName"], "Atatürk")
        self.assertEqual(seen_bodies[0]["basinName"], "Fırat")
        self.assertEqual(seen_bodies[0]["page"], 0)
        self.assertEqual(seen_bodies[1]["page"], 1)
        obs = result["observations"][0]
        self.assertEqual(obs["provider"], "epias")
        self.assertEqual(obs["sourceClass"], "official_live")
        self.assertAlmostEqual(obs["fullnessPercent"], 71.2)

    def test_access_denied_and_rate_limit(self):
        for status, code in ((403, "access_denied"), (429, "rate_limited")):
            routes = {"https://tgt": lambda u, b: FakeResponse(200, None, text="T"),
                      "https://e/x": lambda u, b: FakeResponse(status, {})}
            with patch("epias_client.requests.Session", return_value=session_with(routes)):
                with patch.dict("os.environ", {"EPIAS_USERNAME": "u", "EPIAS_PASSWORD": "p"}):
                    result = fetch_active_fullness([{"damName": "X"}], endpoint="https://e/x", tgt_url="https://tgt", request_gap_s=0)
            self.assertEqual(result["errorCode"], code, status)

    def test_schema_error_on_bad_envelope(self):
        with self.assertRaises(EpiasError) as ctx:
            extract_rows({"unexpected": 1})
        self.assertEqual(ctx.exception.code, "schema_error")

    def test_empty_result(self):
        routes = {"https://tgt": lambda u, b: FakeResponse(200, None, text="T"),
                  "https://e/x": lambda u, b: FakeResponse(200, {"items": []})}
        with patch("epias_client.requests.Session", return_value=session_with(routes)):
            with patch.dict("os.environ", {"EPIAS_USERNAME": "u", "EPIAS_PASSWORD": "p"}):
                result = fetch_active_fullness([{"damName": "X"}], endpoint="https://e/x", tgt_url="https://tgt", request_gap_s=0)
        self.assertEqual(result["status"], "empty")
        self.assertEqual(result["errorCode"], "empty_result")

    def test_schema_change_tolerance(self):
        # Alternate field names still normalize.
        row = {"barajAdi": "Y", "dolulukOrani": "64,5".replace(",", "."), "tarih": "2026-09-14"}
        obs = normalize_row(row, "2026-09-16T00:00:00Z")
        self.assertAlmostEqual(obs["fullnessPercent"], 64.5)
        self.assertEqual(obs["damName"], "Y")

    def test_derived_out_of_range_not_clamped(self):
        # The source client preserves the raw value + flag; the resolver decides.
        row = {"damName": "Y", "activeVolume": 500, "minVolumeHm3": 10, "maxVolumeHm3": 110,
               "observationDate": "2026-09-16"}
        obs = normalize_row(row, "2026-09-16T00:00:00Z")
        self.assertGreater(obs["fullnessPercent"], 100)
        self.assertIsNotNone((obs.get("raw") or {}).get("volumeOutOfRange"))
        row = {"damName": "Y", "activeVolume": 50, "minVolumeHm3": 10, "maxVolumeHm3": 110,
               "observationDate": "2026-09-16"}
        obs = normalize_row(row, "2026-09-16T00:00:00Z")
        self.assertAlmostEqual(obs["fullnessPercent"], 40.0)
        self.assertIsNone((obs.get("raw") or {}).get("volumeOutOfRange"))

    def test_duplicate_observations_share_dedupe_key(self):
        from providers import dedupe_key
        rows = [{"damName": "Y", "activeFullness": 64.5, "observationDate": "2026-09-14"},
                {"damName": "Y", "activeFullness": 64.5, "observationDate": "2026-09-14"}]
        keys = {dedupe_key("h1", "epias", r["observationDate"], "official_live") for r in rows}
        self.assertEqual(len(keys), 1)


if __name__ == "__main__":
    unittest.main()
