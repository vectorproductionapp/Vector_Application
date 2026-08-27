import uuid
import math
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify
from firebase_config import db, bucket
from auth_utils import roles_required
from read_cache import cached_read

defects_bp = Blueprint("defects", __name__)
defects_collection = db.collection("defective_units")

REQUIRED_FIELDS = ["date", "make", "model", "serial", "part", "problem", "observations", "solution", "scratches", "dent", "status"]

ALLOWED_UPDATE_FIELDS = [
    "date", "make", "model", "serial", "part", "problem",
    "observations", "solution", "scratches", "dent", "status",
]


def _serialize(doc):
    d = doc.to_dict()
    return {
        "id": doc.id,
        "date": d.get("date"),
        "make": d.get("make"),
        "model": d.get("model"),
        "serial": d.get("serial"),
        "part": d.get("part"),
        "problem": d.get("problem"),
        "observations": d.get("observations", ""),
        "solution": d.get("solution", ""),
        "scratches": d.get("scratches", ""),
        "dent": d.get("dent", ""),
        "status": d.get("status"),
        "attachments": d.get("attachments", []),
        "createdAt": d.get("createdAt").isoformat() if d.get("createdAt") else None,
    }


def _upload_attachments(files):
    """Uploads each file to Firebase Storage and returns their public URLs."""
    urls = []
    for file in files:
        if not file or file.filename == "":
            continue
        ext = file.filename.rsplit(".", 1)[-1] if "." in file.filename else ""
        blob_name = f"defective-units/{uuid.uuid4().hex}.{ext}" if ext else f"defective-units/{uuid.uuid4().hex}"
        blob = bucket.blob(blob_name)
        blob.upload_from_file(file, content_type=file.content_type)
        blob.make_public()
        urls.append(blob.public_url)
    return urls


@defects_bp.route("/defects", methods=["POST"])
@roles_required("admin", "coadmin", "production_incharge")
def create_defect():
    data = request.form
    if not data:
        return jsonify({"success": False, "message": "Request must be form-data"}), 400

    missing = [f for f in REQUIRED_FIELDS if not str(data.get(f, "")).strip()]
    if missing:
        return jsonify({"success": False, "message": f"Missing required fields: {', '.join(missing)}"}), 400

    try:
        files = request.files.getlist("attachment")
        attachment_urls = _upload_attachments(files)

        doc_ref = defects_collection.document()
        created_at = datetime.now(timezone.utc)
        record = {
            "date": data.get("date", ""),
            "make": data.get("make", ""),
            "model": data.get("model", ""),
            "serial": data.get("serial", ""),
            "part": data.get("part", ""),
            "problem": data.get("problem", ""),
            "observations": data.get("observations", ""),
            "solution": data.get("solution", ""),
            "scratches": data.get("scratches", ""),
            "dent": data.get("dent", ""),
            "status": data.get("status", "Open"),
            "attachments": attachment_urls,
            "createdAt": created_at,
        }
        doc_ref.set(record)

        return jsonify({
            "success": True,
            "message": "Defective unit created",
            "id": doc_ref.id,
            **{k: record[k] for k in record if k != "createdAt"},
            "createdAt": created_at.isoformat(),
        }), 201
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to create defective unit: {exc}"}), 500


@defects_bp.route("/defects", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge")
@cached_read("defects", ttl_seconds=120)
def list_defects():
    try:
        try:
            page = max(1, int(request.args.get("page", 1)))
        except (TypeError, ValueError):
            page = 1
        try:
            limit = min(100, max(1, int(request.args.get("limit", 10))))
        except (TypeError, ValueError):
            limit = 10

        base_query = defects_collection.order_by("createdAt", direction="DESCENDING")
        try:
            total_count = base_query.count(alias="total").get()[0][0].value
        except Exception:
            # Compatibility fallback for older Firestore client libraries.
            total_count = len(list(base_query.stream()))
        total_pages = max(1, math.ceil(total_count / limit))
        page = min(page, total_pages)
        defects = [_serialize(doc) for doc in base_query.offset((page - 1) * limit).limit(limit).stream()]

        return jsonify({
            "success": True,
            "defects": defects,
            "pagination": {
                "page": page,
                "limit": limit,
                "totalCount": total_count,
                "totalPages": total_pages,
            },
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch defective units: {exc}"}), 500


@defects_bp.route("/defects/bulk-delete", methods=["POST"])
@roles_required("admin", "coadmin", "production_incharge")
def bulk_delete_defects():
    """Delete the rows selected by the Defective Units toolbar."""
    data = request.get_json(silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "message": "No defective unit IDs provided"}), 400

    try:
        deleted = []
        missing = []
        batch = db.batch()

        # De-duplicate IDs so a repeated selection cannot inflate the count.
        for defect_id in dict.fromkeys(str(item) for item in ids if item):
            doc_ref = defects_collection.document(defect_id)
            if doc_ref.get().exists:
                batch.delete(doc_ref)
                deleted.append(defect_id)
            else:
                missing.append(defect_id)

        if deleted:
            batch.commit()

        if not deleted:
            return jsonify({
                "success": False,
                "message": "None of the selected defective units could be found",
                "missingIds": missing,
            }), 404

        return jsonify({
            "success": True,
            "message": f"Deleted {len(deleted)} defective unit(s)",
            "deletedCount": len(deleted),
            "missingIds": missing,
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete defective units: {exc}"}), 500


@defects_bp.route("/defects/<defect_id>", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge")
def get_defect(defect_id):
    try:
        doc = defects_collection.document(defect_id).get()
        if not doc.exists:
            return jsonify({"success": False, "message": "Defective unit not found"}), 404
        return jsonify({"success": True, "defect": _serialize(doc)}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch defective unit: {exc}"}), 500


@defects_bp.route("/defects/<defect_id>", methods=["PUT"])
@roles_required("admin", "coadmin", "production_incharge")
def update_defect(defect_id):
    # Now accepts multipart/form-data (like create_defect) so edits can
    # include new attachment uploads, not just plain JSON text fields.
    data = request.form
    if not data:
        return jsonify({"success": False, "message": "Request must be form-data"}), 400

    update_fields = {k: v for k, v in data.items() if k in ALLOWED_UPDATE_FIELDS}

    try:
        doc_ref = defects_collection.document(defect_id)
        doc = doc_ref.get()
        if not doc.exists:
            return jsonify({"success": False, "message": "Defective unit not found"}), 404

        # Merge any newly uploaded files with the existing attachment list
        # instead of overwriting it.
        files = request.files.getlist("attachment")
        new_urls = _upload_attachments(files)
        if new_urls:
            existing_urls = doc.to_dict().get("attachments", [])
            update_fields["attachments"] = existing_urls + new_urls

        if not update_fields:
            return jsonify({"success": False, "message": "Nothing to update"}), 400

        doc_ref.update(update_fields)
        return jsonify({"success": True, "message": "Defective unit updated"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to update defective unit: {exc}"}), 500


@defects_bp.route("/defects/<defect_id>", methods=["DELETE"])
@roles_required("admin", "coadmin", "production_incharge")
def delete_defect(defect_id):
    try:
        doc_ref = defects_collection.document(defect_id)
        doc = doc_ref.get()
        if not doc.exists:
            return jsonify({"success": False, "message": "Defective unit not found"}), 404

        # best-effort cleanup of uploaded files
        for url in doc.to_dict().get("attachments", []):
            try:
                blob_path = url.split(f"{bucket.name}/")[-1]
                bucket.blob(blob_path).delete()
            except Exception:
                pass

        doc_ref.delete()
        return jsonify({"success": True, "message": "Defective unit deleted"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete defective unit: {exc}"}), 500
