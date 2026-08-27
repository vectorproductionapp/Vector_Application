"""One-off optional migration for deployments with existing BOQ Item Codes.

The application performs the same idempotent backfill automatically whenever
the Item Code catalog is queried.  Run this script before rollout if you want
to pre-populate the catalog instead:

    python migrate_item_codes.py
"""

from models import _sync_legacy_item_codes


if __name__ == "__main__":
    _sync_legacy_item_codes()
    print("Item Code catalog migration completed.")
