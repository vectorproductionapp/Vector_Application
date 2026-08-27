import bcrypt
from flask import Blueprint, request, jsonify
from firebase_config import users_collection
from auth_utils import generate_token

admin_login_bp = Blueprint("admin_login", __name__)

# Only full admins are allowed to sign in through the admin console.
ALLOWED_ADMIN_ROLES = ("admin",)


def _admin_exists():
    existing_admins = users_collection.where("role", "==", "admin").limit(1).get()
    return len(existing_admins) > 0


@admin_login_bp.route("/admin/login", methods=["POST"])
def admin_login():
    data = request.get_json()

    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    email = (data.get("email") or "").strip().lower()
    password = data.get("password")

    if not email or not password:
        return jsonify({"success": False, "message": "Email and password required"}), 400

    results = users_collection.where("email", "==", email).limit(1).get()

    if not results:
        return jsonify({"success": False, "message": "Invalid Email or Password"}), 401

    user_doc = results[0]
    user = user_doc.to_dict()

    stored_hash = user.get("password", "").encode("utf-8")

    if not bcrypt.checkpw(password.encode("utf-8"), stored_hash):
        return jsonify({"success": False, "message": "Invalid Email or Password"}), 401

    role = user.get("role", "user")

    # A valid password isn't enough here — the account must also hold an
    # admin-tier role. A regular "user" account gets rejected even with
    # correct credentials, so this endpoint can't be used as a backdoor.
    if role not in ALLOWED_ADMIN_ROLES:
        return jsonify({
            "success": False,
            "message": "This account does not have access to the admin console",
        }), 403

    token = generate_token(user_doc.id, email, role, user.get("name", ""))

    return jsonify({
        "success": True,
        "message": "Login Successful",
        "name": user.get("name", ""),
        "userId": user_doc.id,
        "role": role,
        "token": token,
    }), 200


@admin_login_bp.route("/admin/bootstrap-status", methods=["GET"])
def bootstrap_status():
    """Frontend calls this to decide whether to show the setup link at all."""
    return jsonify({"success": True, "setup_required": not _admin_exists()}), 200


@admin_login_bp.route("/admin/bootstrap", methods=["POST"])
def bootstrap_admin():
    """
    Creates the very first admin account with no auth required. Only works
    while zero admin accounts exist anywhere in the system — the moment one
    exists, this route refuses every request, so it can never be used to
    mint a second admin or as a standing backdoor.
    """
    if _admin_exists():
        return jsonify({
            "success": False,
            "message": "An admin account already exists. Ask an existing Admin to create your account.",
        }), 403

    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    email = (data.get("email") or "").strip().lower()
    password = data.get("password")
    name = (data.get("name") or "").strip()

    if not email or not password or not name:
        return jsonify({"success": False, "message": "Name, email and password are required"}), 400

    if len(password) < 8:
        return jsonify({"success": False, "message": "Password must be at least 8 characters"}), 400

    existing = users_collection.where("email", "==", email).limit(1).get()
    if existing:
        return jsonify({"success": False, "message": "An account with this email already exists"}), 409

    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    _, doc_ref = users_collection.add({
        "email": email,
        "password": hashed,
        "name": name,
        "role": "admin",
    })

    token = generate_token(doc_ref.id, email, "admin", name)

    return jsonify({
        "success": True,
        "message": "First admin account created",
        "name": name,
        "userId": doc_ref.id,
        "role": "admin",
        "token": token,
    }), 201


@admin_login_bp.route("/admin/register", methods=["POST"])
def register_admin():
    """Register an additional admin account — no key required."""
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    email = (data.get("email") or "").strip().lower()
    password = data.get("password")
    name = (data.get("name") or "").strip()

    if not email or not password or not name:
        return jsonify({"success": False, "message": "Name, email and password are required"}), 400

    if len(password) < 8:
        return jsonify({"success": False, "message": "Password must be at least 8 characters"}), 400

    existing = users_collection.where("email", "==", email).limit(1).get()
    if existing:
        return jsonify({"success": False, "message": "An account with this email already exists"}), 409

    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    _, doc_ref = users_collection.add({
        "email": email,
        "password": hashed,
        "name": name,
        "role": "admin",
    })

    token = generate_token(doc_ref.id, email, "admin", name)

    return jsonify({
        "success": True,
        "message": "Admin account registered",
        "name": name,
        "userId": doc_ref.id,
        "role": "admin",
        "token": token,
    }), 201
