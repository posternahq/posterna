"""A stand-in for https://posterna.com/v1/ingest, for the end-to-end run only.

Writes each request it receives (headers that matter and the decompressed
JSON body) to the file given as the second argument, one JSON object per
line, and answers like the real ingest endpoint with a "return to monitor"
override.

Usage: python3 -I mock-ingest.py PORT OUTPUT_FILE
"""

import gzip
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1])
OUTPUT = sys.argv[2]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (http.server naming)
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        if self.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        record = {
            "path": self.path,
            "authorization": self.headers.get("Authorization", ""),
            "content_type": self.headers.get("Content-Type", ""),
            "content_encoding": self.headers.get("Content-Encoding", ""),
            "user_agent": self.headers.get("User-Agent", ""),
            "body": json.loads(raw.decode("utf-8")),
        }
        with open(OUTPUT, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")
        answer = json.dumps({"accepted": len(record["body"].get("buckets", [])), "modeOverride": "monitor"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(answer)))
        self.end_headers()
        self.wfile.write(answer)

    def log_message(self, *args):
        pass


HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
