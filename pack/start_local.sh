#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8765
echo "============================================"
echo "  Roundtree Frontend - Local"
echo "============================================"
echo "  Open: http://localhost:$PORT/index.html"
echo "  Ctrl+C to stop."
echo ""
cd "$SCRIPT_DIR"
python3 -c "
import http.server, socketserver
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin','*')
        super().end_headers()
with socketserver.TCPServer(('',$PORT), H) as h:
    print(f'HTTP server on port $PORT'); h.serve_forever()
"
