"""One-time migration: create direct email lookup records for existing users."""
from firebase_config import users_collection, create_user_email_index


def main():
    count = 0
    for user_doc in users_collection.stream():
        email = str((user_doc.to_dict() or {}).get("email") or "").strip().lower()
        if email:
            create_user_email_index(email, user_doc.id)
            count += 1
    print(f"Created or updated {count} user email index records.")


if __name__ == "__main__":
    main()
