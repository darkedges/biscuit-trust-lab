"""Development server for simulated credits; bind only to the selected interface."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from network import Demo

WEB = Path(__file__).parent / "web"


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        routes = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"), "/style.css": ("style.css", "text/css; charset=utf-8")}
        path = urlparse(self.path).path
        if path == "/api/health":
            return self.send(200, b'{"ok":true,"biscuit":"0.4.0"}')
        if path not in routes:
            return self.send(404, b'{"error":"Not found"}')
        name, content_type = routes[path]
        self.send(200, (WEB / name).read_bytes(), content_type)

    def do_POST(self):
        if self.path != "/api/run":
            return self.send(404, b'{"error":"Not found"}')
        # Local playground, no cross-origin mutations.
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{self.headers.get('Host')}":
            return self.send(403, b'{"error":"Cross-origin requests are not accepted"}')
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                raise ValueError("Request body must be between 1 and 16384 bytes")
            config = json.loads(self.rfile.read(length))
            if not isinstance(config, dict):
                raise ValueError("Expected a JSON object")
            result = Demo(config).run()
            self.send(200, json.dumps(result).encode())
        except (ValueError, TypeError) as exc:
            self.send(400, json.dumps({"error": str(exc)}).encode())
        except Exception:
            import traceback
            traceback.print_exc()
            self.send(500, b'{"error":"The run failed unexpectedly. See the server log."}')


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Biscuit network lab")
    parser.add_argument("--host", default="127.0.0.1", help="IP address to listen on (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    print(f"Biscuit network lab: http://{args.host}:{args.port}", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
