import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from worker.adapters.osm import (
    OSM_ATTRIBUTION,
    OsmDiscoveryAdapter,
    OsmDiscoveryError,
    build_overpass_query,
)
from worker.scoring import evaluate_signal


class OsmAdapterTests(unittest.TestCase):
    def test_query_builder_enforces_bbox_bounds_and_categories(self):
        ql = build_overpass_query([-33.95, 18.38, -33.90, 18.46], "retail_shops", limit=20)
        self.assertIn("[out:json]", ql)
        self.assertIn('["shop"]["name"]', ql)
        self.assertIn("out center 20;", ql)

        with self.assertRaises(ValueError):
            # Overly huge bounding box blocked to protect Overpass
            build_overpass_query([-35.0, 18.0, -33.0, 20.0], "retail_shops")

        with self.assertRaises(ValueError):
            build_overpass_query([-33.95, 18.38, -33.90, 18.46], "nonexistent_cat")

    def test_discovery_attribution_no_fabricated_fields_caching_and_429(self):
        state = {"hits": 0, "mode": "ok", "user_agent": ""}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                _ = self.rfile.read(length)
                state["hits"] += 1
                state["user_agent"] = self.headers.get("User-Agent", "")

                if state["mode"] == "rate_limit_remark":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"remark":"Dispatcher_Client::request_read_and_idx::rate_limited"}')
                    return
                if state["mode"] == "http_429":
                    self.send_response(429)
                    self.send_header("Retry-After", "90")
                    self.end_headers()
                    return
                if state["mode"] == "malformed":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"<html>bad gateway</html>")
                    return

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "elements": [
                                {
                                    "type": "node",
                                    "id": 1001,
                                    "lat": -33.9249,
                                    "lon": 18.4241,
                                    "tags": {
                                        "name": "Table Bay Bakery",
                                        "shop": "bakery",
                                        "addr:street": "Long Street",
                                        "addr:city": "Cape Town",
                                    },
                                },
                                {
                                    "type": "way",
                                    "id": 2002,
                                    "center": {"lat": -33.928, "lon": 18.419},
                                    "tags": {
                                        "name": "Atlantic Dental Studio",
                                        "amenity": "dentist",
                                        "website": "https://atlanticdental.example.co.za",
                                        "phone": "+27 21 555 0100",
                                    },
                                },
                                {
                                    "type": "node",
                                    "id": 1001,
                                    "lat": -33.9249,
                                    "lon": 18.4241,
                                    "tags": {"name": "Table Bay Bakery", "shop": "bakery"},
                                },
                            ]
                        }
                    ).encode("utf-8")
                )

            def log_message(self, format, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()

        clock = {"now": 5000.0}
        env = {"OSM_OVERPASS_URL": f"http://127.0.0.1:{port}/api/interpreter"}

        try:
            adapter = OsmDiscoveryAdapter(
                {},
                env=env,
                allow_local_test=True,
                time_fn=lambda: clock["now"],
                min_interval_sec=0.0,
                cache_ttl_sec=300.0,
            )

            sigs, meta = adapter.discover_businesses(area="cape_town_cbd", category="all_commercial", limit=25)
            self.assertEqual(len(sigs), 2)
            self.assertEqual(meta["dupes_skipped"], 1)
            self.assertIn("ODbL", meta["attribution"])
            self.assertIn("SONARS-OSM-Discovery", state["user_agent"])

            # Record 1: Missing website -> digital_presence_gap, fields NOT invented, no buying intent
            bakery = sigs[0]
            self.assertEqual(bakery.source_entity_id, "node/1001")
            self.assertEqual(bakery.observation_type, "digital_presence_gap")
            self.assertEqual(bakery.attribution, OSM_ATTRIBUTION)
            self.assertIsNone(bakery.raw_payload["website"])
            self.assertIsNone(bakery.raw_payload["phone"])
            ev_bakery = evaluate_signal(bakery)
            self.assertEqual(ev_bakery["intent_score"], 0)
            self.assertEqual(ev_bakery["opportunity_type"], "digital_need")
            self.assertIn("not confirmed buying", ev_bakery["score_breakdown"]["recommended_action"].lower())

            # Record 2: Has website + phone -> contact_information_found, not active buying intent
            dentist = sigs[1]
            self.assertEqual(dentist.observation_type, "contact_information_found")
            ev_dentist = evaluate_signal(dentist)
            self.assertEqual(ev_dentist["intent_score"], 0)
            self.assertEqual(ev_dentist["opportunity_type"], "entity_exists")

            # Cache hit avoids duplicate Overpass hit
            sigs_cached, meta_cached = adapter.discover_businesses(area="cape_town_cbd", category="all_commercial", limit=25)
            self.assertEqual(len(sigs_cached), 2)
            self.assertTrue(meta_cached["cached"])
            self.assertEqual(state["hits"], 1)

            # Advance beyond cache TTL & trigger Overpass rate_limited remark
            clock["now"] += 400.0
            state["mode"] = "rate_limit_remark"
            with self.assertRaises(OsmDiscoveryError) as cm_rl:
                adapter.discover_businesses(area="cape_town_cbd", category="all_commercial", limit=25)
            self.assertEqual(cm_rl.exception.status_code, 429)

            # While cooldown is active, requests fail fast cleanly
            with self.assertRaises(OsmDiscoveryError) as cm_cd:
                adapter.discover_businesses(area="sandton_jhb", category="retail_shops", limit=10)
            self.assertEqual(cm_cd.exception.status_code, 429)

            # Advance past cooldown and test HTTP 429 & malformed XML/HTML response
            clock["now"] += 120.0
            state["mode"] = "http_429"
            with self.assertRaises(OsmDiscoveryError) as cm429:
                adapter.discover_businesses(area="sandton_jhb", category="retail_shops", limit=10)
            self.assertEqual(cm429.exception.status_code, 429)
            self.assertEqual(cm429.exception.retry_after, 90)

            clock["now"] += 120.0
            state["mode"] = "malformed"
            with self.assertRaises(OsmDiscoveryError) as cm_bad:
                adapter.discover_businesses(area="pretoria_east", category="professional_offices", limit=10)
            self.assertEqual(cm_bad.exception.status_code, 502)
        finally:
            server.shutdown()
            server.server_close()

    def test_expanded_gauteng_east_rand_and_retained_presets_are_valid(self):
        from worker.adapters.osm import GEOGRAPHIC_AREAS

        expected_new = {
            "benoni",
            "boksburg",
            "kempton_park",
            "germiston",
            "alberton",
            "brakpan",
            "springs",
            "edenvale",
            "johannesburg",
            "pretoria",
            "sandton",
            "midrand",
        }
        retained = {
            "cape_town_cbd",
            "sandton_jhb",
            "pretoria_east",
            "durban_umhlanga",
            "stellenbosch",
            "gqeberha",
        }
        self.assertTrue(expected_new.issubset(GEOGRAPHIC_AREAS.keys()))
        self.assertTrue(retained.issubset(GEOGRAPHIC_AREAS.keys()))

        for key, info in GEOGRAPHIC_AREAS.items():
            bbox = info["bbox"]
            self.assertEqual(len(bbox), 4, f"{key} bbox must have 4 coords")
            s, w, n, e = bbox
            self.assertTrue(-90 <= s < n <= 90, f"{key} invalid lat bounds: {bbox}")
            self.assertTrue(-180 <= w < e <= 180, f"{key} invalid lon bounds: {bbox}")
            self.assertLessEqual(n - s, 0.35, f"{key} lat span exceeds 0.35 deg")
            self.assertLessEqual(e - w, 0.35, f"{key} lon span exceeds 0.35 deg")
            self.assertTrue(info.get("label"), f"{key} missing readable label")
            ql = build_overpass_query(bbox, "retail_shops", limit=500)
            self.assertIn("out center 100;", ql)  # Limit clamped cleanly at 100

    def test_invalid_area_reversed_bbox_and_timeout_handling(self):
        from unittest.mock import patch

        adapter = OsmDiscoveryAdapter(
            {},
            env={"OSM_OVERPASS_URL": "https://user:secret-pass@custom-overpass.example.com/api/interpreter"},
        )
        st = adapter.get_status()
        self.assertFalse(st["is_public_overpass"])
        self.assertEqual(st["provider_mode"], "custom_overpass")
        self.assertEqual(st["provider_url"], "https://custom-overpass.example.com/api/interpreter")
        self.assertNotIn("secret-pass", json.dumps(st))

        with self.assertRaises(ValueError):
            adapter.discover_businesses(area="unknown_town", category="retail_shops")
        with self.assertRaises(ValueError):
            build_overpass_query([-26.1, 28.2, -26.2, 28.1], "retail_shops")

        with patch("worker.adapters.osm.safe_fetch_bytes", side_effect=TimeoutError("timed out")):
            with self.assertRaises(OsmDiscoveryError) as cm_to:
                adapter.discover_businesses(area="benoni", category="retail_shops", limit=15)
            self.assertEqual(cm_to.exception.status_code, 504)


if __name__ == "__main__":
    unittest.main()
