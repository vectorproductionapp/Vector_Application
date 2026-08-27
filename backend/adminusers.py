import bcrypt
from flask import Blueprint, request, jsonify
from firebase_config import users_collection, user_document_for_email, create_user_email_index, user_email_index
from auth_utils import roles_required
from read_cache import cached_read

admin_users_bp = Blueprint("admin_users", __name__)

ALLOWED_ROLES = ("admin", "coadmin", "production_incharge", "user")


@admin_users_bp.route("/admin/create-user", methods=["POST"])
@roles_required("admin")  # only a full admin can create accounts — including other admins
def create_user():
    data = request.get_json()

    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    email = (data.get("email") or "").strip().lower()
    password = data.get("password")
    name = (data.get("name") or "").strip()
    role = data.get("role", "user")

    if not email or not password or not name:
        return jsonify({"success": False, "message": "Name, email and password are required"}), 400

    if role not in ALLOWED_ROLES:
        return jsonify({"success": False, "message": "Invalid role"}), 400

    if len(password) < 8:
        return jsonify({"success": False, "message": "Password must be at least 8 characters"}), 400

    if user_document_for_email(email):
        return jsonify({"success": False, "message": "An account with this email already exists"}), 409

    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    _, user_ref = users_collection.add({
        "email": email,
        "password": hashed,
        "name": name,
        "role": role,
        "created_by": request.user.get("email"),
    })
    create_user_email_index(email, user_ref.id)

    role_label = "Production In-charge" if role == "production_incharge" else role.replace("coadmin", "Co-Admin").title()
    return jsonify({"success": True, "message": f"{role_label} account created"}), 201


@admin_users_bp.route("/admin/users", methods=["GET"])
@roles_required("admin", "coadmin")  # coadmin can view, only admin can create (above)
@cached_read("admin-users", ttl_seconds=120)
def list_users():
    docs = users_collection.stream()
    users = [
        {
            "id": doc.id,
            "email": doc.to_dict().get("email"),
            "name": doc.to_dict().get("name"),
            "role": doc.to_dict().get("role", "user"),
        }
        for doc in docs
    ]
    return jsonify({"success": True, "users": users}), 200


@admin_users_bp.route("/admin/users/<user_id>", methods=["DELETE"])
@roles_required("admin")
def delete_user(user_id):
    doc_ref = users_collection.document(user_id)
    doc = doc_ref.get()
    if not doc.exists:
        return jsonify({"success": False, "message": "User not found"}), 404

    data = doc.to_dict() or {}
    current_email = str(request.user.get("email") or "").strip().lower()
    target_email = str(data.get("email") or "").strip().lower()
    if current_email and target_email == current_email:
        return jsonify({"success": False, "message": "You cannot delete your own account"}), 403

    doc_ref.delete()
    if target_email:
        user_email_index.document(target_email).delete()
    return jsonify({"success": True, "message": "User deleted"}), 200


@admin_users_bp.route("/admin/users/<user_id>/account", methods=["PATCH"])
@roles_required("admin")
def update_user_account(user_id):
    """Update another user's role and/or password after re-authentication."""
    data = request.get_json(silent=True) or {}
    role = data.get("role")

    actor_ref = users_collection.document(str(request.user.get("sub") or ""))
    actor = actor_ref.get()

    target_ref = users_collection.document(user_id)
    target = target_ref.get()
    if not target.exists:
        return jsonify({"success": False, "message": "User not found"}), 404
    if target.id == actor.id:
        return jsonify({"success": False, "message": "You cannot change your own account from this screen"}), 403

    updates = {}
    if role is not None:
        if role not in ALLOWED_ROLES:
            return jsonify({"success": False, "message": "Invalid role"}), 400
        updates["role"] = role
    if not updates:
        return jsonify({"success": False, "message": "Choose a role"}), 400

    target_ref.update(updates)
    return jsonify({"success": True, "message": "Account updated"}), 200
