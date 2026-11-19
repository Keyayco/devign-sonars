import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from worker.adapters.cipc import CipcAdapter, CipcApiError, CipcConfigError
from worker.scoring import evaluate_signal


class CipcAdapterTests(unittest.TestCase):
    def test_disabled_by_default_and_missing_credentials_safe_status(self):
        adapter = CipcAdapter({}, env={})
        st = adapter.get_status()
        self.assertFalse(st["enabled"])
        self.assertFalse(st["configured"])
        self.assertFalse(st["ready"])
        self.assertIn("CIPC_CLIENT_ID", st["missing"])
        self.assertIn("CIPC_CLIENT_SECRET", st["missing"])
        self.assertIn("CIPC_TOKEN_URL", st["missing"])
        self.assertFalse(adapter.health_check())
        with self.assertRaises(CipcConfigError):
            adapter.search_companies(query="Devign")

    def test_oauth_token_search_refresh_429_and_error_handling(self):
        state = {
            "token_calls": 0,
            "current_token": "tok-initial-1",
            "mode": "ok",
            "last_auth": "",
        }

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                _ = self.rfile.read(length)
                if self.path == "/oauth/token":
                    state["token_calls"] += 1
                    if state["mode"] == "auth_fail":
                        self.send_response(401)
                        self.end_headers()
                        self.wfile.write(b'{"error":"invalid_client"}')
                        return
                    if state["mode"] == "bad_json":
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(b"not-json")
                        return
                    tok = f"tok-v{state['token_calls']}"
                    state["current_token"] = tok
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(
                        json.dumps({"access_token": tok, "expires_in": 120}).encode("utf-8")
                    )
                    return
                self.send_response(404)
                self.end_headers()

            def do_GET(self):
                state["last_auth"] = self.headers.get("Authorization", "")
                if state["mode"] == "force_401_once":
                    state["mode"] = "ok"
                    self.send_response(401)
                    self.end_headers()
                    return
                if state["mode"] == "rate_limit":
                    self.send_response(429)
                    self.send_header("Retry-After", "45")
                    self.end_headers()
                    return
                if state["mode"] == "service_down":
                    self.send_response(503)
                    self.end_headers()
                    return
                if state["mode"] == "invalid_api_json":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"{broken-json")
                    return

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "companies": [
                                {
                                    "registrationNumber": "2021/555111/07",
                                    "enterpriseName": "Cape Horizon Logistics (Pty) Ltd",
                                    "enterpriseType": "Private Company",
                                    "status": "In Business",
                                    "registrationDate": "2021-04-12",
                                    "province": "Western Cape",
                                    "directors": [
                                        {"name": "Private Director PII", "idNumber": "8001015009087"}
                                    ],
                                },
                                {
                                    "registrationNumber": "2021/555111/07",
                                    "enterpriseName": "Cape Horizon Logistics (Pty) Ltd",
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

        clock = {"now": 1000.0}
        env = {
            "CIPC_ENABLED": "true",
            "CIPC_CLIENT_ID": "test-client-id-secret",
            "CIPC_CLIENT_SECRET": "super-secret-cipc-key-999",
            "CIPC_TOKEN_URL": f"http://127.0.0.1:{port}/oauth/token",
            "CIPC_API_BASE_URL": f"http://127.0.0.1:{port}",
            "CIPC_SEARCH_PATH": "companies/search",
        }

        try:
            adapter = CipcAdapter({}, env=env, allow_local_test=True, time_fn=lambda: clock["now"])
            st = adapter.get_status()
            self.assertTrue(st["ready"])
            # Secrets must never appear in status payload
            self.assertNotIn("super-secret-cipc-key-999", json.dumps(st))

            # 1. Authorized search + POPIA director minimization + deduplication + no buying intent
            sigs, meta = adapter.search_companies(query="Cape Horizon", limit=10)
            self.assertEqual(len(sigs), 1)
            self.assertEqual(meta["dupes_skipped"], 1)
            sig = sigs[0]
            self.assertEqual(sig.source_type, "cipc")
            self.assertEqual(sig.source_entity_id, "2021/555111/07")
            self.assertEqual(sig.observation_type, "entity_verified")
            self.assertFalse(sig.is_personal_info)
            self.assertFalse(sig.contact_eligible)
            self.assertNotIn("Private Director PII", sig.content)
            self.assertNotIn("8001015009087", json.dumps(sig.raw_payload))

            ev = evaluate_signal(sig)
            self.assertEqual(ev["intent_score"], 0)
            self.assertEqual(ev["intent"], "low")
            self.assertEqual(ev["opportunity_type"], "entity_exists")
            self.assertGreaterEqual(ev["confidence_score"], 85)

            # 2. Cached token reused before expiry
            adapter.search_companies(query="Cape Horizon")
            self.assertEqual(state["token_calls"], 1)

            # 3. Token expiry triggers refresh
            clock["now"] += 200.0
            adapter.search_companies(query="Cape Horizon")
            self.assertEqual(state["token_calls"], 2)

            # 4. Reactive 401 triggers single re-auth and succeeds
            state["mode"] = "force_401_once"
            sigs_retry, _ = adapter.search_companies(query="Cape Horizon")
            self.assertEqual(len(sigs_retry), 1)
            self.assertEqual(state["token_calls"], 3)

            # 5. Rate limiting 429 respected cleanly
            state["mode"] = "rate_limit"
            with self.assertRaises(CipcApiError) as cm429:
                adapter.search_companies(query="RateLimit")
            self.assertEqual(cm429.exception.status_code, 429)
            self.assertEqual(cm429.exception.retry_after, 45)

            # Clear cooldown clock and test invalid JSON & 503
            clock["now"] += 60.0
            state["mode"] = "invalid_api_json"
            with self.assertRaises(CipcApiError) as cm_json:
                adapter.search_companies(query="BadJson")
            self.assertEqual(cm_json.exception.status_code, 502)

            state["mode"] = "service_down"
            with self.assertRaises(CipcApiError) as cm503:
                adapter.search_companies(query="Down")
            self.assertEqual(cm503.exception.status_code, 503)

            # 6. OAuth failure never leaks client_secret
            clock["now"] += 200.0
            state["mode"] = "auth_fail"
            with self.assertRaises(CipcApiError) as cm_auth:
                adapter.search_companies(query="AuthFail")
            self.assertEqual(cm_auth.exception.status_code, 401)
            self.assertNotIn("super-secret-cipc-key-999", str(cm_auth.exception))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
