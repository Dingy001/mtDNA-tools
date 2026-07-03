#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8765
echo "============================================"
echo "  Roundtree Frontend - Local (Range)"
echo "============================================"
echo "  Open: http://localhost:$PORT/index.html"
echo "  Ctrl+C to stop."
echo ""
cd "$SCRIPT_DIR"
python3 -c "
import http.server
import os
import re
import socketserver

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Range')
        self.send_header('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length')
        super().end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            for index in ('index.html', 'index.htm'):
                index_path = os.path.join(path, index)
                if os.path.exists(index_path):
                    path = index_path
                    break
            else:
                return self.list_directory(path)
        if not os.path.exists(path):
            self.send_error(404, 'File not found')
            return None

        ctype = self.guess_type(path)
        size = os.path.getsize(path)
        range_header = self.headers.get('Range')
        if range_header:
            m = re.match(r'bytes=(\d*)-(\d*)$', range_header.strip())
            if m:
                start_s, end_s = m.groups()
                start = int(start_s) if start_s else 0
                end = int(end_s) if end_s else size - 1
                if start >= size:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.end_headers()
                    return None
                end = min(end, size - 1)
                length = end - start + 1
                f = open(path, 'rb')
                f.seek(start)
                self.send_response(206)
                self.send_header('Content-type', ctype)
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.send_header('Content-Length', str(length))
                self.end_headers()
                self.range = (start, end)
                return f

        f = open(path, 'rb')
        self.send_response(200)
        self.send_header('Content-type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(size))
        self.end_headers()
        self.range = None
        return f

    def copyfile(self, source, outputfile):
        byte_range = getattr(self, 'range', None)
        if not byte_range:
            return super().copyfile(source, outputfile)
        start, end = byte_range
        remaining = end - start + 1
        while remaining > 0:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

with ThreadingHTTPServer(('', $PORT), H) as h:
    print(f'HTTP server on port $PORT with Range support')
    h.serve_forever()
"
