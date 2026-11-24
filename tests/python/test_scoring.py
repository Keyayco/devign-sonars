import unittest
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from worker.adapters.base import CanonicalSignal
from worker.scoring import (
    HIGH_INTENT,
    LOW_INTENT,
    LEAD_VALUE,
    score_post,
    classify_intent,
    compute_lead_value,
    evaluate_signal,
)
from worker.worker import sanitize_log_text


class ScoringTests(unittest.TestCase):
    def test_reference_weight_dictionaries_present(self):
        high_map = dict(HIGH_INTENT)
        low_map = dict(LOW_INTENT)
        val_map = dict(LEAD_VALUE)
        self.assertEqual(high_map["developer disappeared"], 45)
        self.assertEqual(high_map["hire a developer"], 42)
        self.assertEqual(low_map["rate my"], -35)
        self.assertEqual(low_map["student project"], -35)
        self.assertEqual(val_map["saas"], 20)
        self.assertEqual(val_map["student"], -22)

    def test_high_intent_scoring_and_thresholds(self):
        score, detail = score_post(
            "Developer disappeared on my shopify store, urgent budget ready",
            "Looking for a developer for a paid project ASAP to replace our agency.",
        )
        self.assertEqual(score, 100)  # clamped to 100
        self.assertEqual(classify_intent(score), "high")
        self.assertTrue(any('+45 "developer disappeared"' in d for d in detail))

    def test_medium_intent_classification(self):
        score, _ = score_post(
            "Need a developer for my local business",
            "What would it cost to launch?",
        )
        # "need a developer" (38) + "need developer"? no + "local business" (18) + "what would it cost" (28) = 84;
        # test exact medium boundary (45..69)
        score2, _ = score_post("Need a developer for startup", "Small inquiry")
        # 38 + 18 = 56
        self.assertEqual(score2, 56)
        self.assertEqual(classify_intent(score2), "medium")

    def test_low_intent_suppression_clamps_to_zero(self):
        score, detail = score_post(
            "Rate my portfolio showcase - student project",
            "I built this hobby mockup on dribbble for fun, what do you think?",
        )
        self.assertEqual(score, 0)
        self.assertEqual(classify_intent(score), "low")
        self.assertTrue(any('-35 "rate my"' in d for d in detail))

    def test_lead_value_computation(self):
        val, factors = compute_lead_value(
            "Need Shopify ecommerce replacement",
            "SaaS integration with urgent launch budget",
        )
        self.assertGreaterEqual(val, 90)
        self.assertLessEqual(val, 100)
        self.assertTrue(factors[0] == "base 50")

        low_val, _ = compute_lead_value("Student hobby site", "Just a personal project for fun")
        self.assertEqual(low_val, 0)

    def test_evaluate_signal_breakdown_and_opportunity(self):
        sig = CanonicalSignal(
            source_type="reddit",
            source_entity_id="https://www.reddit.com/r/forhire/comments/abc123/hiring",
            source_channel="r/forhire",
            entity_name="founder123",
            title="Hire a developer for ecommerce Shopify store",
            content="Our developer disappeared last week. We have a budget and need someone to build ASAP. " * 4,
            url="https://www.reddit.com/r/forhire/comments/abc123/hiring",
            matched_keyword="hire a developer",
            published_utc=9999999999,
        )
        ev = evaluate_signal(sig)
        self.assertEqual(ev["intent"], "high")
        self.assertGreaterEqual(ev["intent_score"], 70)
        self.assertEqual(ev["opportunity_type"], "active_buying_intent")
        self.assertEqual(ev["record_kind"], "buying_intent")
        self.assertTrue(ev["score_breakdown"]["is_buying_intent"])
        self.assertIn("recommended_action", ev["score_breakdown"])
        self.assertIn("intent_factors", ev["score_breakdown"])
        self.assertIn("value_factors", ev["score_breakdown"])
        self.assertIn("confidence_factors", ev["score_breakdown"])

    def test_telegram_token_redaction_in_logs(self):
        raw = "Failed calling https://api.telegram.org/bot123456789:AAH_SecretToken_XYZ/sendMessage"
        clean = sanitize_log_text(raw)
        self.assertNotIn("AAH_SecretToken_XYZ", clean)
        self.assertIn("bot[REDACTED]", clean)

    def test_cipc_and_osm_signals_do_not_assign_buying_intent(self):
        cipc_sig = CanonicalSignal(
            source_type="cipc",
            source_entity_id="2020/111222/07",
            source_channel="cipc-apiverse",
            entity_name="Horizon Web Holdings (Pty) Ltd",
            title="Horizon Web Holdings (Pty) Ltd (2020/111222/07)",
            content="Official CIPC company record",
            url="https://api.cipc.example",
            matched_keyword="Horizon",
            published_utc=1760000000,
            observation_type="entity_verified",
            raw_payload={"registration_number": "2020/111222/07", "status": "In Business"},
        )
        ev_cipc = evaluate_signal(cipc_sig)
        self.assertEqual(ev_cipc["intent_score"], 0)
        self.assertEqual(ev_cipc["lead_value"], 0)
        self.assertEqual(ev_cipc["intent"], "low")
        self.assertEqual(ev_cipc["record_kind"], "entity_discovery")
        self.assertFalse(ev_cipc["score_breakdown"]["is_buying_intent"])
        self.assertEqual(ev_cipc["observation_type"], "entity_verified")
        self.assertEqual(ev_cipc["opportunity_type"], "entity_exists")

        osm_gap = CanonicalSignal(
            source_type="osm",
            source_entity_id="node/987654",
            source_channel="osm:Cape Town",
            entity_name="Harbour Coffee",
            title="Harbour Coffee — amenity:cafe (no website listed)",
            content="No website tag in OpenStreetMap",
            url="https://www.openstreetmap.org/node/987654",
            matched_keyword="restaurants_hospitality",
            published_utc=1760000000,
            observation_type="digital_presence_gap",
            category="amenity:cafe",
            raw_payload={"lat": -33.91, "lon": 18.42, "address": "Cape Town", "website": None},
        )
        ev_osm = evaluate_signal(osm_gap)
        self.assertEqual(ev_osm["intent_score"], 0)
        self.assertEqual(ev_osm["lead_value"], 0)
        self.assertEqual(ev_osm["fit_score"], 42)
        self.assertEqual(ev_osm["record_kind"], "entity_discovery")
        self.assertFalse(ev_osm["score_breakdown"]["is_buying_intent"])
        self.assertEqual(ev_osm["observation_type"], "digital_presence_gap")
        self.assertEqual(ev_osm["opportunity_type"], "digital_need")
        self.assertIn("not confirmed buying demand", ev_osm["score_breakdown"]["fit_factors"][0].lower())

        osm_with_site = CanonicalSignal(
            source_type="osm",
            source_entity_id="node/987655",
            source_channel="osm:Benoni, Gauteng",
            entity_name="East Rand Print",
            title="East Rand Print — shop:copyshop",
            content="Website listed",
            url="https://www.openstreetmap.org/node/987655",
            matched_keyword="retail_shops",
            published_utc=1760000000,
            observation_type="contact_information_found",
            category="shop:copyshop",
            raw_payload={"lat": -26.18, "lon": 28.32, "website": "https://example.co.za"},
        )
        ev_osm_site = evaluate_signal(osm_with_site)
        self.assertEqual(ev_osm_site["intent_score"], 0)
        self.assertEqual(ev_osm_site["lead_value"], 0)
        self.assertEqual(ev_osm_site["fit_score"], 30)
        self.assertEqual(ev_osm_site["record_kind"], "entity_discovery")


if __name__ == "__main__":
    unittest.main()
