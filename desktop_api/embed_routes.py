"""Embed shell for loading kiosk recipe UI inside the desktop client."""

from __future__ import annotations

import json
import os
import pathlib

from flask import Blueprint, Response, send_from_directory

from desktop_api.auth_store import consume_embed_ticket

_STATIC_DIR = pathlib.Path(__file__).resolve().parent / "static"


def create_embed_blueprint(kiosk):
    bp = Blueprint(
        "rle_desktop_embed",
        __name__,
        static_folder=str(_STATIC_DIR),
        static_url_path="/desktop/embed/static",
    )

    def _app_root() -> pathlib.Path:
        root = os.environ.get("APP_ROOT") or "/opt/kiosk"
        return pathlib.Path(root)

    @bp.route("/desktop/embed/static/<path:filename>")
    def embed_static(filename):
        return send_from_directory(str(_STATIC_DIR), filename)

    @bp.route("/desktop/embed/recipes")
    def embed_recipes():
        from flask import request

        ticket = (request.args.get("ticket") or "").strip()
        entry = consume_embed_ticket(ticket)
        if not entry:
            return Response("Invalid or expired embed ticket.", status=403, mimetype="text/plain")

        index_path = _app_root() / "index.html"
        if not index_path.is_file():
            return Response("Kiosk index.html not found.", status=500, mimetype="text/plain")

        html = index_path.read_text(encoding="utf-8")
        user_json = json.dumps(entry.get("user") or {})
        bearer_json = json.dumps(entry.get("bearer") or "")

        inject_head = (
            '<base href="/">\n'
            '<link rel="stylesheet" href="/styles.css?v=19">\n'
            '<link rel="stylesheet" href="/desktop/embed/static/desktop_embed.css">\n'
            "<script>window.DESKTOP_EMBED_MODE='recipes';"
            "window.currentUser={user};"
            "window.__DESKTOP_EMBED_USER={user};"
            "window.DESKTOP_EMBED_BEARER={bearer};</script>\n"
            '<script src="/desktop/embed/static/desktop_embed_bootstrap.js"></script>\n'
        ).format(user=user_json, bearer=bearer_json)

        if "</head>" in html:
            html = html.replace("</head>", inject_head + "</head>", 1)
        else:
            html = inject_head + html

        inject_body = '<script src="/desktop/embed/static/desktop_embed.js"></script>'
        if '<script src="keyboard.js' in html:
            html = html.replace(
                '<script src="keyboard.js',
                inject_body + '\n<script src="keyboard.js',
                1,
            )
        elif "</body>" in html:
            html = html.replace("</body>", inject_body + "</body>", 1)
        else:
            html += inject_body

        return Response(html, mimetype="text/html")

    return bp
