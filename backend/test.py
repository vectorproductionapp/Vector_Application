# """

# seed_po_details.py
 
# Inserts 100 sample PO Detail rows into the Firestore 'po_details' collection.

# Values are picked randomly from small sample lists, so duplicates across rows

# are expected (this mirrors realistic PO data where the same phase/code/make

# repeats across multiple purchase orders).
 
# Usage:

#     python seed_po_details.py

# """
 
# import random

# from datetime import datetime, timezone, timedelta
 
# from firebase_config import db  # reuses your existing Firebase Admin init
 
# po_details_collection = db.collection("po_details")
 
# # ---- Sample pools (feel free to edit these) --------------------------------
 
# PHASES = ["Phase 1", "Phase 2", "Phase 3", "Phase 4"]

# MODEL_IDS = ["model_a", "model_b", "model_c"]

# PHASE_IDS = ["phase_1", "phase_2", "phase_3", "phase_4"]

# PO_NUMBERS = [f"PO-{n}" for n in range(1001, 1011)]          # 10 POs -> guarantees dup POs

# CODES = [f"ITM-{n:03d}" for n in range(1, 16)]                # 15 item codes

# MAKES = ["Siemens", "ABB", "Schneider", "Honeywell", "L&T"]

# MODELS = ["X100", "X200", "Pro-5", "Elite-9", "Standard-2"]

# DESCRIPTIONS = [

#     "Circuit Breaker 63A",

#     "Contactor 40A",

#     "Relay Module",

#     "Power Cable 3-core",

#     "Terminal Block",

#     "PLC Module",

#     "HMI Panel 7-inch",

#     "VFD Drive 5HP",

#     "Junction Box",

#     "Cable Gland Set",

# ]

# STATUSES = ["Pending", "Approved", "Delivered", "Cancelled"]
 
# # ---- Helpers -----------------------------------------------------------------
 
# def random_date(days_back=90):

#     d = datetime.now(timezone.utc) - timedelta(days=random.randint(0, days_back))

#     return d.strftime("%Y-%m-%d")
 
 
# def random_future_date(days_ahead=60):

#     d = datetime.now(timezone.utc) + timedelta(days=random.randint(1, days_ahead))

#     return d.strftime("%Y-%m-%d")
 
 
# def build_record():

#     qty = random.randint(1, 500)

#     rate = round(random.uniform(50, 5000), 2)

#     base_value = qty * rate

#     gst = round(base_value * 0.18, 2)

#     value = round(base_value + gst, 2)
 
#     now = datetime.now(timezone.utc)
 
#     return {

#         "phase": random.choice(PHASES),

#         "modelId": random.choice(MODEL_IDS),

#         "phaseId": random.choice(PHASE_IDS),

#         "po": random.choice(PO_NUMBERS),

#         "date": random_date(),

#         "code": random.choice(CODES),

#         "make": random.choice(MAKES),

#         "model": random.choice(MODELS),

#         "desc": random.choice(DESCRIPTIONS),

#         "qty": qty,

#         "rate": rate,

#         "gst": gst,

#         "value": value,

#         "expectedDeliveryDate": random_future_date(),

#         "status": random.choice(STATUSES),

#         "createdAt": now,

#         "updatedAt": now,

#     }
 
 
# def seed(n=100):

#     batch = db.batch()

#     count_in_batch = 0

#     total_written = 0
 
#     for _ in range(n):

#         doc_ref = po_details_collection.document()

#         batch.set(doc_ref, build_record())

#         count_in_batch += 1

#         total_written += 1
 
#         # Firestore batches max out at 500 writes; commit periodically anyway.

#         if count_in_batch == 400:

#             batch.commit()

#             batch = db.batch()

#             count_in_batch = 0
 
#     if count_in_batch > 0:

#         batch.commit()
 
#     print(f"✅ Inserted {total_written} PO Detail records into 'po_details'.")
 
 
# if __name__ == "__main__":

#     seed(100)
 




 #for boq,s----------------------------------------------------------------------------->

















"""
seed_sales_test_data.py
-------------------------
Standalone testing script that seeds sample Sale Register records into
your Flask API (saleregister_bp routes) — no direct DB access.

Unlike the BOQ seeder, /sales has no bulk-create endpoint, so this script
POSTs one row at a time to POST /sales.

Includes intentional duplicates (same Client PO No / Serial No reused
across a few rows) so you can test how the app behaves with repeat data
in search, filtering, and the details popup.

USAGE
-----
    python seed_sales_test_data.py
    python seed_sales_test_data.py --total 50
    python seed_sales_test_data.py --base-url http://localhost:5000 --total 100
"""

import argparse
import random
import sys
from datetime import date, timedelta

import requests

API_BASE_URL = "http://localhost:5000"

CLIENTS = ["Acme Pvt Ltd", "Vector Industries", "Bright Sparks Co", "Om Electricals",
           "Metro Hardware", "Sri Vendor Traders", "Vignesh Suppliers", "Northline Corp"]
LOCATIONS = ["Chennai", "Bengaluru", "Hyderabad", "Coimbatore", "Mumbai", "Pune", "Delhi", "Kolkata"]
MODELS = ["GSB-13RE", "GSB-20RE", "HX-450", "HX-900", "VT-100", "VT-250"]
DISPATCH_OPTIONS = ["Pending", "Processing", "Dispatched", "Delivered", "Cancelled"]
WARRANTY_YEARS = [1, 2, 3, 4, 5]


def random_date(start_days_ago=365, end_days_ago=0):
    """Random date between `start_days_ago` and `end_days_ago` days before today."""
    days = random.randint(end_days_ago, start_days_ago)
    return (date.today() - timedelta(days=days)).isoformat()


def add_years(date_str, years):
    if not date_str or not years:
        return ""
    y, m, d = (int(part) for part in date_str.split("-"))
    try:
        return date(y + years, m, d).isoformat()
    except ValueError:
        # e.g. Feb 29 on a non-leap target year — fall back a day
        return date(y + years, m, d - 1).isoformat()


def build_row(index, poNo=None, serial=None):
    client_po_date = random_date(300, 60)
    invoice_date = random_date(59, 5)
    dispatch = random.choice(DISPATCH_OPTIONS)
    qty = random.randint(1, 25)
    rate = round(random.uniform(5000, 250000), 2)
    warranty_period = random.choice(WARRANTY_YEARS)

    return {
        "poNo": poNo or f"PO-{4000 + index}",
        "client": random.choice(CLIENTS),
        "location": random.choice(LOCATIONS),
        "model": random.choice(MODELS),
        "serial": serial or f"SN-{10000 + index}",
        "qty": qty,
        "dispatch": dispatch,
        "value": round(rate * qty, 2),
        "date": client_po_date,
        "clientPoDate": client_po_date,
        "expectedDispatchDate": random_date(45, 10),
        "actualDispatchDate": random_date(9, 0) if dispatch in ("Dispatched", "Delivered") else "",
        "invoiceNumber": f"INV-2026-{1000 + index}" if dispatch != "Pending" else "",
        "invoiceDate": invoice_date if dispatch != "Pending" else "",
        "unitCost": round(rate * random.uniform(0.6, 0.85), 2),
        "warrantyPeriod": warranty_period,
        "warrantyStartDate": invoice_date if dispatch != "Pending" else "",
        "warrantyEndDate": add_years(invoice_date, warranty_period) if dispatch != "Pending" else "",
    }


def build_rows(total, duplicate_ratio=0.15):
    rows = []
    duplicate_count = int(total * duplicate_ratio)
    unique_count = total - duplicate_count

    for i in range(1, unique_count + 1):
        rows.append(build_row(i))

    # Intentional duplicates — reuse an earlier row's PO No / Serial No,
    # but everything else varies, mimicking a record re-entered by mistake.
    for j in range(duplicate_count):
        source = random.choice(rows)
        dup_index = unique_count + j + 1
        rows.append(build_row(dup_index, poNo=source["poNo"], serial=source["serial"]))

    random.shuffle(rows)
    return rows


def seed(base_url, total):
    rows = build_rows(total)
    created, failed = 0, 0

    for i, row in enumerate(rows, start=1):
        try:
            res = requests.post(f"{base_url}/sales", json=row)
            data = res.json()
            if res.status_code == 201 and data.get("success"):
                created += 1
            else:
                failed += 1
                print(f"[{i}/{len(rows)}] Failed: {data.get('message')}", file=sys.stderr)
        except requests.RequestException as exc:
            failed += 1
            print(f"[{i}/{len(rows)}] Request error: {exc}", file=sys.stderr)

    unique_po_nos = len({r["poNo"] for r in rows})
    print(f"\nDone. Created {created}/{len(rows)} sale(s), {failed} failed.")
    print(f"{unique_po_nos} unique Client PO Nos, "
          f"{len(rows) - unique_po_nos} duplicate rows by PO No.")


def main():
    parser = argparse.ArgumentParser(description="Seed dummy Sale Register records for testing.")
    parser.add_argument("--base-url", default=API_BASE_URL, help="Flask API base URL")
    parser.add_argument("--total", type=int, default=100, help="Total number of sale records to create")
    args = parser.parse_args()

    seed(args.base_url.rstrip("/"), args.total)


if __name__ == "__main__":
    main()