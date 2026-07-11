"""RLE Desktop Client API — isolated Flask blueprint for PC sync.

Register via bridge.py so app.py kiosk behaviour is unchanged.
"""

from desktop_api.routes import create_blueprint
from desktop_api.embed_routes import create_embed_blueprint


def register(flask_app, kiosk_module):
    """Attach /api/desktop/v1/* and embed routes to the running Flask app."""
    flask_app.register_blueprint(create_blueprint(kiosk_module))
    flask_app.register_blueprint(create_embed_blueprint(kiosk_module))
