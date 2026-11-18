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
        self.assertIn("recommended_action", ev["score_breakdown"])
        self.assertIn("intent_factors", ev["score_breakdown"])
        self.assertIn("value_factors", ev["score_breakdown"])
        self.assertIn("confidence_factors", ev["score_breakdown"])

    def test_telegram_token_redaction_in_logs(self):
        raw = "Failed calling https://api.telegram.org/bot123456789:AAH_SecretToken_XYZ/sendMessage"
        clean = sanitize_log_text(raw)
        self.assertNotIn("AAH_SecretToken_XYZ", clean)
        self.assertIn("bot[REDACTED]", clean)


if __name__ == "__main__":
    unittest.main()
