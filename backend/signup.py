# from flask import Blueprint, request, jsonify
# from firebase_admin import auth
# from firebase_config import users_collection

# signup_bp = Blueprint("signup", __name__)


# @signup_bp.route("/signup", methods=["POST"])
# def signup():
#     data = request.get_json()

#     email = data.get("email")
#     password = data.get("password")
#     name = data.get("name")

#     if not email or not password:
#         return jsonify({"success": False, "message": "Email and password required"}), 400

#     try:
#         # Creates the user in Firebase Authentication (handles hashing/security)
#         user_record = auth.create_user(
#             email=email,
#             password=password,
#             display_name=name
#         )

#         # Store additional profile info in Firestore, keyed by Auth UID
#         users_collection.document(user_record.uid).set({
#             "name": name,
#             "email": email
#         })

#         return jsonify({
#             "success": True,
#             "message": "Signup successful",
#             "uid": user_record.uid
#         }), 201

#     except auth.EmailAlreadyExistsError:
#         return jsonify({"success": False, "message": "Email already registered"}), 409
#     except Exception as e:
#         return jsonify({"success": False, "message": str(e)}), 500




import bcrypt
from flask import Blueprint, request, jsonify
from firebase_config import users_collection, user_document_for_email, create_user_email_index

signup_bp = Blueprint("signup", __name__)


@signup_bp.route("/signup", methods=["POST"])
def signup():
    data = request.get_json()

    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    role = (data.get("role") or "user").strip().lower()

    ALLOWED_SELF_ROLES = ["user", "production_incharge", "coadmin", "admin"]
    if role not in ALLOWED_SELF_ROLES:
        role = "user"

    if not email or not password:
        return jsonify({"success": False, "message": "Email and password required"}), 400

    try:
        if user_document_for_email(email):
            return jsonify({"success": False, "message": "Email already registered"}), 409

        hashed_password = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())

        doc_ref = users_collection.document()
        doc_ref.set({
            "name": name,
            "email": email,
            "password": hashed_password.decode("utf-8"),
            "role": role
        })
        create_user_email_index(email, doc_ref.id)

        return jsonify({
            "success": True,
            "message": "Signup successful",
            "uid": doc_ref.id
        }), 201
    except Exception as exc:
        return jsonify({
            "success": False,
            "message": f"Failed to create Firestore user: {exc}"
        }), 500
