"""Credential-free stand-ins for ``firebase_admin``.

The smoke tests build the *real* Flask application so they can exercise
``/health``, CORS and the ``/ws`` registration.  Building it for real imports
``firebase_config``, which would use Google credentials and then read and write
whatever project those credentials belong to.  A pull request must never be able
to touch production data, so ``firebase_admin`` is replaced *before* the
application is imported and every collection/document call is a no-op.

Call :func:`install` before importing anything from the backend package.
"""

import sys
import types


class _FakeResource:
    def __init__(self, *args, **kwargs):
        pass

    def __getattr__(self, name):
        return lambda *args, **kwargs: _FakeResource()

    def __call__(self, *args, **kwargs):
        return _FakeResource()


class _FakeDocument(_FakeResource):
    @property
    def id(self):
        return "fake-id"

    @property
    def exists(self):
        return False

    def to_dict(self):
        return {}

    def get(self):
        return self

    def set(self, *args, **kwargs):
        return None

    def delete(self):
        return None


class _FakeCollection(_FakeResource):
    def document(self, *args, **kwargs):
        return _FakeDocument()

    def collection(self, *args, **kwargs):
        return _FakeCollection()

    def add(self, *args, **kwargs):
        return (None, _FakeDocument())

    def get(self, *args, **kwargs):
        return _FakeCollection()

    def where(self, *args, **kwargs):
        return self

    def limit(self, *args, **kwargs):
        return self

    def order_by(self, *args, **kwargs):
        return self

    def stream(self, *args, **kwargs):
        return iter(())

    def __iter__(self):
        return iter(())


class _FakeDb(_FakeResource):
    def collection(self, *args, **kwargs):
        return _FakeCollection()

    def collection_group(self, *args, **kwargs):
        return _FakeCollection()

    def transaction(self):
        return _FakeTransaction()

    def batch(self):
        return _FakeTransaction()


class _FakeTransaction(_FakeResource):
    def get(self, *args, **kwargs):
        return _FakeDocument()

    def set(self, *args, **kwargs):
        return self

    def update(self, *args, **kwargs):
        return self

    def delete(self, *args, **kwargs):
        return self

    def commit(self):
        return []


_installed = False


def install():
    """Replace ``firebase_admin`` in ``sys.modules``. Idempotent."""
    global _installed
    if _installed:
        return
    _installed = True

    firebase_admin = types.ModuleType("firebase_admin")
    credentials = types.ModuleType("firebase_admin.credentials")
    firestore = types.ModuleType("firebase_admin.firestore")
    storage = types.ModuleType("firebase_admin.storage")

    # A credential class that refuses to load anything: if the application ever
    # reaches for a real key file the test fails loudly instead of silently
    # using one that happens to be on the machine.
    def _no_credentials(*args, **kwargs):
        raise RuntimeError(
            "Tests must not load Google credentials. firebase_admin is stubbed."
        )

    credentials.Certificate = _no_credentials
    credentials.ApplicationDefault = _no_credentials

    firestore.client = lambda *args, **kwargs: _FakeDb()
    firestore.transaction = lambda fn: fn
    firestore.FieldValue = types.SimpleNamespace(
        server_timestamp=lambda: None,
        increment=lambda value: value,
        delete=lambda: None,
        array_union=lambda *values: list(values),
        array_remove=lambda *values: list(values),
    )
    firestore.SERVER_TIMESTAMP = object()

    def _identity(fn=None, **kwargs):
        if callable(fn):
            return fn
        return lambda target: target

    firestore.transactional = _identity
    firestore.Transaction = _FakeTransaction

    storage.bucket = lambda *args, **kwargs: _FakeResource()

    firebase_admin.initialize_app = lambda *args, **kwargs: None
    firebase_admin.delete_app = lambda *args, **kwargs: None
    # Truthy so `if not firebase_admin._apps` in firebase_config skips init.
    firebase_admin._apps = {"stub": object()}
    firebase_admin.credentials = credentials
    firebase_admin.firestore = firestore
    firebase_admin.storage = storage

    for name, module in (
        ("firebase_admin", firebase_admin),
        ("firebase_admin.credentials", credentials),
        ("firebase_admin.firestore", firestore),
        ("firebase_admin.storage", storage),
    ):
        sys.modules[name] = module
