"""Which Models-page model a record belongs to.

Pages filter by the product model (a document on the Models page).  Some
records name it directly (modelId), others only through a unit's serial
number (defect reports), and some carry a free-text "model" that may or may
not be a product model.  These helpers resolve all of them to a model name.
"""

import logging

from google.cloud.firestore_v1.base_query import FieldFilter

from firebase_config import db

log = logging.getLogger(__name__)

_IN_BATCH = 30  # Firestore's limit for an "in" filter


def _text(value):
    return str(value or "").strip()


def model_names_by_id():
    """{model id: model name} for every model on the Models page."""
    return {doc.id: _text((doc.to_dict() or {}).get("name")) for doc in db.collection("models").stream()}


def canonical_names(names_by_id):
    """{lower-case name: name as written on the Models page}."""
    return {name.casefold(): name for name in names_by_id.values() if name}


def models_for_serials(serials, names_by_id=None):
    """{serial (case-folded): product model name} from the assembled units."""
    wanted = sorted({_text(serial) for serial in serials if _text(serial)})
    found = {}
    try:
        for start in range(0, len(wanted), _IN_BATCH):
            batch = wanted[start:start + _IN_BATCH]
            for doc in db.collection("assembly_units").where(filter=FieldFilter("serial", "in", batch)).stream():
                data = doc.to_dict() or {}
                name = (names_by_id or {}).get(_text(data.get("modelId"))) or _text(data.get("model"))
                if name:
                    found[_text(data.get("serial")).casefold()] = name
    except Exception:
        log.warning("could not look up units by serial for the product model", exc_info=True)
    return found


def product_model_for(serial="", model_ids=(), model_text="", *, names_by_id, canonical, by_serial):
    """The product model names for one record, best source first."""
    result = []

    def add(name):
        if name and name not in result:
            result.append(name)

    for model_id in model_ids or ():
        add(names_by_id.get(_text(model_id), ""))
    add(by_serial.get(_text(serial).casefold(), ""))
    if not result:
        # A free-text model counts only when it names a real product model.
        add(canonical.get(_text(model_text).casefold(), ""))
    return result
