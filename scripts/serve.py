import http.server
import os

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


# Plain SimpleHTTPRequestHandler sends no Cache-Control header, so browsers
# heuristically cache JS modules across reloads during local dev — an edit
# can silently keep running the previous version for several reloads. This
# is a dev-server-only concern; GitHub Pages serves the deployed site with
# its own headers, untouched by this file.
class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


http.server.test(HandlerClass=NoCacheHandler, port=8765)
