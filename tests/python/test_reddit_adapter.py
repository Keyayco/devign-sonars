import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from worker.adapters.reddit import RedditAdapter, extract_utc, normalize_url, strip_html
from worker.worker import send_telegram

ATOM_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>r/forhire</title>
  <entry>
    <title>Need a website for my local business - budget ready</title>
    <link href="https://old.reddit.com/r/forhire/comments/xyz1/need_website/?utm_source=share" />
    <updated>2026-11-10T10:00:00Z</updated>
    <author><name>/u/client_one</name></author>
    <content type="html">&lt;p&gt;Looking to hire a developer ASAP for a paid project.&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Just sharing my weekend hobby</title>
    <link href="https://www.reddit.com/r/forhire/comments/xyz2/weekend/" />
    <updated>2026-11-10T09:00:00Z</updated>
    <author><name>/u/dev_two</name></author>
    <content type="html">&lt;p&gt;Nothing commercial here.&lt;/p&gt;</content>
  </entry>
</feed>
"""


class RedditAdapterTests(unittest.TestCase):
    def test_url_normalization_and_html_stripping(self):
        self.assertEqual(
            normalize_url("https://old.reddit.com/r/ForHire/comments/ABC/Title/?utm_source=rss&ref=1"),
            "https://www.reddit.com/r/forhire/comments/abc/title",
        )
        self.assertEqual(strip_html("<p>Hello <b>world</b>&nbsp;test</p>"), "Hello world &nbsp;test")
        ts = extract_utc({"published": "2026-11-10T10:00:00Z"})
        self.assertGreater(ts, 1700000000)

    def test_poll_dedup_etag_429_and_fault_isolation(self):
        state = {"hits": 0, "rate_limit": True}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/r/forhire/.rss":
                    state["hits"] += 1
                    if self.headers.get("If-None-Match") == '"etag-v1"':
                        self.send_response(304)
                        self.end_headers()
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "application/atom+xml")
                    self.send_header("ETag", '"etag-v1"')
                    self.end_headers()
                    self.wfile.write(ATOM_XML)
                elif self.path == "/r/ratelimited/.rss":
                    self.send_response(429)
                    self.send_header("Retry-After", "180")
                    self.end_headers()
                else:
                    self.send_response(500)
                    self.end_headers()

            def log_message(self, format, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()

        try:
            logs = []
            adapter = RedditAdapter(
                {
                    "interval": 60,
                    "feeds": [
                        f"http://127.0.0.1:{port}/r/forhire/.rss",
                        f"http://127.0.0.1:{port}/r/ratelimited/.rss",
                        "http://127.0.0.1:9/r/unreachable/.rss",
                    ],
                    "keywords": ["need a website", "hire a developer"],
                },
                log_fn=lambda lvl, msg: logs.append((lvl, msg)),
            )
            seen = set()

            # Cycle 1: 1 healthy feed signal, 1 rate-limited 429, 1 unreachable feed isolated
            signals1, metrics1 = adapter.poll(seen)
            self.assertEqual(len(signals1), 1)
            self.assertEqual(
                signals1[0].source_entity_id,
                "https://www.reddit.com/r/forhire/comments/xyz1/need_website",
            )
            self.assertEqual(metrics1["posts_checked"], 2)
            self.assertEqual(metrics1["errors"], 2)
            self.assertIn(f"http://127.0.0.1:{port}/r/ratelimited/.rss", adapter._backoff_until)
            self.assertTrue(any("429" in msg for _, msg in logs))

            # Cycle 2: ETag -> 304 Not Modified and 429 feed skipped due to cooldown
            signals2, metrics2 = adapter.poll(seen)
            self.assertEqual(len(signals2), 0)
            self.assertTrue(any("304" in msg for _, msg in logs))
            self.assertTrue(any("cooldown" in msg for _, msg in logs))

            # Cycle 3: Clear ETag cache to verify seen_ids deduplication directly
            adapter._etag_cache.clear()
            signals3, metrics3 = adapter.poll(seen)
            self.assertEqual(len(signals3), 0)
            self.assertEqual(metrics3["dupes_skipped"], 2)
        finally:
            server.shutdown()
            server.server_close()

    def test_telegram_safe_no_credentials(self):
        sent = send_telegram("", "", "r/forhire", "Test", "https://example.com", "high", 80, 75)
        self.assertFalse(sent)


if __name__ == "__main__":
    unittest.main()
