"""
JWT issuing + role-guard decorators.

Install: pip install pyjwt

Set a real secret in production:
    export JWT_SECRET="a-long-random-value"
Never leave the default fallback in prod.
"""

import os
import datetime
import time
from functools import wraps

import jwt
from flask import request, jsonify, g

JWT_SECRET = os.getenv("JWT_SECRET", "change-this-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = int(os.getenv("JWT_EXPIRY_HOURS", "8"))

# Higher number = more privilege. Used by min_role_required.
ROLE_HIERARCHY = {
    "user": 1,
    "production_incharge": 2,
    "coadmin": 3,
    "admin": 4,
}


def generate_token(user_id, email, role, name=""):
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "name": name,
        "iat": datetime.datetime.utcnow(),
        "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token):
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


def _get_token_from_header():
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header.split(" ", 1)[1]
    return None


def token_required(f):
    """Attaches request.user = {sub, email, role, name} if token is valid."""

    @wraps(f)
    def wrapper(*args, **kwargs):
        started_at = time.perf_counter()
        token = _get_token_from_header()
        if not token:
            return jsonify({"success": False, "message": "Missing authentication token"}), 401
        try:
            payload = decode_token(token)
        except jwt.ExpiredSignatureError:
            return jsonify({"success": False, "message": "Session expired, please log in again"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"success": False, "message": "Invalid authentication token"}), 401

        request.user = payload
        g.auth_duration_ms = (time.perf_counter() - started_at) * 1000
        return f(*args, **kwargs)

    return wrapper


def roles_required(*allowed_roles):
    """Exact-match role check. e.g. @roles_required("admin", "coadmin")"""

    def decorator(f):
        @wraps(f)
        @token_required
        def wrapper(*args, **kwargs):
            user_role = request.user.get("role")
            if user_role not in allowed_roles:
                return jsonify({
                    "success": False,
                    "message": "You do not have permission to access this resource",
                }), 403
            return f(*args, **kwargs)

        return wrapper

    return decorator


def min_role_required(min_role):
    """Hierarchy check. e.g. @min_role_required("coadmin") allows coadmin + admin."""

    def decorator(f):
        @wraps(f)
        @token_required
        def wrapper(*args, **kwargs):
            user_role = request.user.get("role")
            if ROLE_HIERARCHY.get(user_role, 0) < ROLE_HIERARCHY.get(min_role, 99):
                return jsonify({
                    "success": False,
                    "message": "You do not have permission to access this resource",
                }), 403
            return f(*args, **kwargs)

        return wrapper

    return decorator
