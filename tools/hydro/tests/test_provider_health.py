"""Provider health semantics: healthy / healthy_empty / skipped / failed."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from providers import SKIP_CODES, FAIL_CODES, classify_provider_health, usable_observations


class ProviderHealthTest(unittest.TestCase):
    def test_healthy(self):
        self.assertEqual(classify_provider_health(called=True, status="ok", error_code=None, usable=5), "healthy")
        self.assertEqual(classify_provider_health(called=True, status="partial", error_code=None, usable=1), "healthy")

    def test_healthy_empty(self):
        self.assertEqual(classify_provider_health(called=True, status="ok", error_code=None, usable=0), "healthy_empty")
        self.assertEqual(classify_provider_health(called=True, status="empty", error_code="empty_result", usable=0), "healthy_empty")

    def test_skipped(self):
        for code in ("credentials_missing", "disabled_opt_in", "endpoint_not_configured",
                     "public_per_dam_endpoint_unavailable", "fetcher_output_missing"):
            self.assertIn(code, SKIP_CODES)
            self.assertEqual(classify_provider_health(called=False, status="skipped", error_code=code, usable=0), "skipped", code)
        # Never called at all -> skipped, never healthy.
        self.assertEqual(classify_provider_health(called=False, status=None, error_code=None, usable=0), "skipped")

    def test_failed(self):
        for code in ("auth_failed", "endpoint_error", "timeout", "schema_error", "parse_error", "access_denied", "rate_limited"):
            self.assertIn(code, FAIL_CODES)
            self.assertEqual(classify_provider_health(called=True, status="error", error_code=code, usable=0), "failed", code)

    def test_usable_counts_real_measurements_only(self):
        rows = [{"fullnessPercent": 70}, {"fullnessPercent": 150}, {"waterLevelM": 105.2},
                {"surfaceAreaKm2": 12.0}, {"fullnessPercent": None}, {"quality": "unparsed"}]
        self.assertEqual(usable_observations(rows), 3)


if __name__ == "__main__":
    unittest.main()
