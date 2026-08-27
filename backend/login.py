import bcrypt
from flask import Blueprint, request, jsonify
from firebase_config import user_document_for_email
from auth_utils import generate_token, token_required

login_bp = Blueprint("login", __name__)


@login_bp.route("/login", methods=["POST"])
def login():
    data = request.get_json()

    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    email = (data.get("email") or "").strip().lower()
    password = data.get("password")

    if not email or not password:
        return jsonify({"success": False, "message": "Email and password required"}), 400

    user_doc = user_document_for_email(email)
    if not user_doc:
        return jsonify({"success": False, "message": "Invalid Email or Password"}), 401
    user = user_doc.to_dict()

    stored_hash = user.get("password", "").encode("utf-8")

    if bcrypt.checkpw(password.encode("utf-8"), stored_hash):
        role = user.get("role", "user")  # defaults new/legacy users to "user"
        token = generate_token(user_doc.id, email, role, user.get("name", ""))

        return jsonify({
            "success": True,
            "message": "Login Successful",
            "name": user.get("name", ""),
            "userId": user_doc.id,
            "role": role,
            "token": token,
        }), 200

    return jsonify({
        "success": False,
        "message": "Invalid Email or Password"
    }), 401


@login_bp.route("/account/change-password", methods=["POST"])
@token_required
def change_password():
    data = request.get_json(silent=True) or {}
    current_password = str(data.get("currentPassword") or "")
    new_password = str(data.get("newPassword") or "")
    if not current_password or not new_password:
        return jsonify({"success": False, "message": "Current and new passwords are required"}), 400
    if len(new_password) < 8:
        return jsonify({"success": False, "message": "New password must be at least 8 characters"}), 400
    user_ref = users_collection.document(str(request.user.get("sub") or ""))
    user_doc = user_ref.get()
    if not user_doc.exists:
        return jsonify({"success": False, "message": "Account not found"}), 404
    stored_hash = str((user_doc.to_dict() or {}).get("password") or "").encode("utf-8")
    if not bcrypt.checkpw(current_password.encode("utf-8"), stored_hash):
        return jsonify({"success": False, "message": "Current password is incorrect"}), 401
    user_ref.update({"password": bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")})
    return jsonify({"success": True, "message": "Password changed successfully"}), 200
