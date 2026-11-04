"""Scheduled report runs: due checks, at-most-once sending, retries, caller check."""

import os
import sys
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

os.environ.setdefault("JWT_SECRET", "unit-test-secret-not-a-real-production-secret")

from tests import fakes  # noqa: E402

fakes.install()

from flask import Flask  # noqa: E402

import daily_report  # noqa: E402
import report_runs  # noqa: E402

# Keep the one-line-per-run summary out of the test output.
report_runs.log.setLevel("WARNING")

IST = report_runs.IST
# Monday 2 Nov 2026.
MONDAY = datetime(2026, 11, 2, tzinfo=IST)


def at(day, hhmm):
    hour, minute = (int(part) for part in hhmm.split(":"))
    return day.replace(hour=hour, minute=minute)


SETTINGS = {
    "enabled": True,
    "weekly_enabled": True,
    "recipients": ["director@example.com", "ops@example.com"],
    "send_time": "09:00",
    "weekly_send_time": "10:00",
    "weekly_send_day": 0,  # Monday
    "working_days": [0, 1, 2, 3, 4, 5],
    "holidays": [],
}


class MemoryRunStore:
    """Same rules as the Firestore store; the lock stands in for the transaction."""

    def __init__(self):
        self.docs = {}
        self.lock = threading.Lock()

    def claim(self, key, report, now):
        with self.lock:
            allowed, reason = report_runs.decide_claim(self.docs.get(key), now)
            if allowed:
                previous = self.docs.get(key) or {}
                self.docs[key] = {"status": "sending", "startedAt": now,
                                  "attempts": previous.get("attempts", 0) + 1}
            return allowed, reason

    def mark_sent(self, key, recipient_count, now):
        self.docs[key].update(status="sent", sentAt=now, recipients=recipient_count)

    def is_sent(self, key):
        return (self.docs.get(key) or {}).get("status") == "sent"

    def mark_failed(self, key, error, now):
        self.docs[key].update(status="failed", error=error, failedAt=now)


class FakeSession:
    def __init__(self, fail_times=0, delay=0.0):
        self.sent = []
        self.fail_times = fail_times
        self.delay = delay
        self.lock = threading.Lock()

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def send(self, recipients, subject, html, text, attachments=None):
        if self.delay:
            time.sleep(self.delay)
        with self.lock:
            if self.fail_times:
                self.fail_times -= 1
                raise RuntimeError("SMTP down")
            self.sent.append(subject)


class _StateRef:
    def __init__(self):
        self.fields = {}

    def set(self, fields, merge=False):
        self.fields.update(fields)


def _fake_build(name):
    def build(now, settings, period_key):
        return f"{name} {period_key}", "<p>html</p>", "text", [], {}
    return build


class ReportRunTestCase(unittest.TestCase):
    def setUp(self):
        self.store = MemoryRunStore()
        self.state_refs = {"daily": _StateRef(), "weekly": _StateRef()}
        patches = [
            patch.dict(report_runs.REPORTS["daily"], {"build": _fake_build("daily"),
                                                      "state_ref": lambda: self.state_refs["daily"]}),
            patch.dict(report_runs.REPORTS["weekly"], {"build": _fake_build("weekly"),
                                                       "state_ref": lambda: self.state_refs["weekly"]}),
            patch.dict(os.environ, {"WEEKLY_STOCK_REPORT": "on"}),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def run_daily(self, now, session):
        return report_runs.run_report("daily", now, SETTINGS, self.store, session)

    def run_weekly(self, now, session):
        return report_runs.run_report("weekly", now, SETTINGS, self.store, session)


class DailyReportRunTests(ReportRunTestCase):
    def test_not_due_before_the_send_time(self):
        session = FakeSession()
        result, failed = self.run_daily(at(MONDAY, "08:59"), session)
        self.assertEqual(result, {"report": "daily", "due": False, "sent": False, "skippedReason": "not yet time"})
        self.assertFalse(failed)
        self.assertEqual(session.sent, [])

    def test_due_after_the_send_time_even_if_minutes_differ(self):
        session = FakeSession()
        result, failed = self.run_daily(at(MONDAY, "09:13"), session)
        self.assertTrue(result["due"])
        self.assertTrue(result["sent"])
        self.assertFalse(failed)
        self.assertEqual(session.sent, ["daily daily_2026-11-02"])
        self.assertEqual(self.store.docs["daily_2026-11-02"]["status"], "sent")
        self.assertEqual(self.store.docs["daily_2026-11-02"]["recipients"], 2)
        self.assertEqual(self.state_refs["daily"].fields["last_status"], "sent")

    def test_second_call_the_same_day_is_skipped(self):
        session = FakeSession()
        self.run_daily(at(MONDAY, "09:00"), session)
        result, failed = self.run_daily(at(MONDAY, "15:30"), session)
        self.assertTrue(result["due"])
        self.assertFalse(result["sent"])
        self.assertEqual(result["skippedReason"], "already sent")
        self.assertFalse(failed)
        self.assertEqual(len(session.sent), 1)

    def test_next_day_sends_again(self):
        session = FakeSession()
        self.run_daily(at(MONDAY, "09:00"), session)
        result, _ = self.run_daily(at(MONDAY + timedelta(days=1), "09:00"), session)
        self.assertTrue(result["sent"])
        self.assertEqual(len(session.sent), 2)

    def test_sunday_is_not_a_working_day(self):
        result, _ = self.run_daily(at(MONDAY - timedelta(days=1), "12:00"), FakeSession())
        self.assertEqual(result["skippedReason"], "not a working day")

    def test_concurrent_calls_send_only_once(self):
        session = FakeSession(delay=0.05)
        results = []

        def call():
            results.append(self.run_daily(at(MONDAY, "09:15"), session)[0])

        threads = [threading.Thread(target=call) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(session.sent), 1)
        self.assertEqual(sum(1 for result in results if result["sent"]), 1)
        self.assertTrue(all(r["skippedReason"] in (None, "another run is sending", "already sent") for r in results))

    def test_failed_send_is_retried_on_the_next_run(self):
        session = FakeSession(fail_times=1)
        result, failed = self.run_daily(at(MONDAY, "09:00"), session)
        self.assertTrue(failed)
        self.assertFalse(result["sent"])
        self.assertEqual(self.store.docs["daily_2026-11-02"]["status"], "failed")
        self.assertEqual(self.state_refs["daily"].fields["last_status"], "failed")

        result, failed = self.run_daily(at(MONDAY, "09:15"), session)
        self.assertFalse(failed)
        self.assertTrue(result["sent"])
        self.assertEqual(self.store.docs["daily_2026-11-02"]["attempts"], 2)

    def test_failed_send_waits_five_minutes_before_retrying(self):
        session = FakeSession(fail_times=1)
        self.run_daily(at(MONDAY, "09:00"), session)
        result, failed = self.run_daily(at(MONDAY, "09:01"), session)
        self.assertEqual(result["skippedReason"], "waiting to retry")
        self.assertFalse(failed)
        result, _ = self.run_daily(at(MONDAY, "09:06"), session)
        self.assertTrue(result["sent"])

    def test_gives_up_after_six_failed_attempts(self):
        session = FakeSession(fail_times=100)
        minute = 0
        for _ in range(report_runs.MAX_ATTEMPTS):
            self.run_daily(at(MONDAY, f"10:{minute:02d}"), session)
            minute += 6
        result, failed = self.run_daily(at(MONDAY, "11:00"), session)
        self.assertEqual(result["skippedReason"], "gave up after 6 failed attempts")
        self.assertFalse(failed)
        self.assertEqual(self.store.docs["daily_2026-11-02"]["attempts"], 6)

    def test_every_minute_runs_send_at_the_set_minute(self):
        session = FakeSession()
        with patch.dict(SETTINGS, {"send_time": "00:01"}):
            self.assertEqual(self.run_daily(at(MONDAY, "00:00"), session)[0]["skippedReason"], "not yet time")
            self.assertTrue(self.run_daily(at(MONDAY, "00:01"), session)[0]["sent"])
        with patch.dict(SETTINGS, {"send_time": "12:00"}):
            tuesday = MONDAY + timedelta(days=1)
            self.assertEqual(self.run_daily(at(tuesday, "11:59"), session)[0]["skippedReason"], "not yet time")
            self.assertTrue(self.run_daily(at(tuesday, "12:00"), session)[0]["sent"])

    def test_a_stuck_sending_record_is_taken_over_after_ten_minutes(self):
        now = at(MONDAY, "09:00").astimezone(timezone.utc)
        self.store.docs["daily_2026-11-02"] = {"status": "sending", "startedAt": now - timedelta(minutes=11)}
        result, _ = self.run_daily(at(MONDAY, "09:00"), FakeSession())
        self.assertTrue(result["sent"])

    def test_a_recent_sending_record_is_left_alone(self):
        now = at(MONDAY, "09:00").astimezone(timezone.utc)
        self.store.docs["daily_2026-11-02"] = {"status": "sending", "startedAt": now - timedelta(minutes=3)}
        result, _ = self.run_daily(at(MONDAY, "09:00"), FakeSession())
        self.assertEqual(result["skippedReason"], "another run is sending")

    def test_disabled_report_is_not_due(self):
        with patch.dict(SETTINGS, {"enabled": False}):
            result, _ = self.run_daily(at(MONDAY, "12:00"), FakeSession())
        self.assertEqual(result["skippedReason"], "disabled")


class WeeklyReportRunTests(ReportRunTestCase):
    def test_sent_once_per_iso_week(self):
        session = FakeSession()
        self.assertEqual(self.run_weekly(at(MONDAY, "09:59"), session)[0]["skippedReason"], "not yet time")
        first, _ = self.run_weekly(at(MONDAY, "10:00"), session)
        self.assertTrue(first["sent"])
        again, _ = self.run_weekly(at(MONDAY, "18:00"), session)
        self.assertEqual(again["skippedReason"], "already sent")
        tuesday, _ = self.run_weekly(at(MONDAY + timedelta(days=1), "10:00"), session)
        self.assertEqual(tuesday["skippedReason"], "not the send day")
        next_week, _ = self.run_weekly(at(MONDAY + timedelta(days=7), "10:30"), session)
        self.assertTrue(next_week["sent"])
        self.assertEqual(session.sent, ["weekly weekly_2026-W45", "weekly weekly_2026-W46"])

    def test_holiday_moves_the_weekly_email_to_the_next_working_day(self):
        holiday = dict(SETTINGS, holidays=[{"date": "2026-11-02", "description": "Holiday"}])
        session = FakeSession()
        monday, _ = report_runs.run_report("weekly", at(MONDAY, "11:00"), holiday, self.store, session)
        self.assertEqual(monday["skippedReason"], "not the send day")
        tuesday, _ = report_runs.run_report("weekly", at(MONDAY + timedelta(days=1), "11:00"), holiday, self.store, session)
        self.assertTrue(tuesday["sent"])


class AnyTimeOfDayTests(ReportRunTestCase):
    """Any send time works, including just before midnight."""

    def run_with(self, name, now, **overrides):
        settings = dict(SETTINGS, **overrides)
        return report_runs.run_report(name, now, settings, self.store, self.session)

    def setUp(self):
        super().setUp()
        self.session = FakeSession()

    def test_early_morning_time(self):
        self.assertEqual(self.run_with("daily", at(MONDAY, "05:00"), send_time="05:30")[0]["skippedReason"], "not yet time")
        self.assertTrue(self.run_with("daily", at(MONDAY, "05:30"), send_time="05:30")[0]["sent"])

    def test_time_just_before_midnight_is_sent_by_the_midnight_run(self):
        # 23:55 Monday is first reached by the 00:00 Tuesday run.
        result, _ = self.run_with("daily", at(MONDAY + timedelta(days=1), "00:00"), send_time="23:55")
        self.assertTrue(result["sent"])
        self.assertEqual(self.session.sent, ["daily daily_2026-11-02"])
        # The next run does not send it again, and Tuesday's own email waits.
        result, _ = self.run_with("daily", at(MONDAY + timedelta(days=1), "00:15"), send_time="23:55")
        self.assertEqual(result["skippedReason"], "not yet time")
        self.assertEqual(len(self.session.sent), 1)

    def test_late_time_sent_the_same_day_is_not_repeated_after_midnight(self):
        self.assertTrue(self.run_with("daily", at(MONDAY, "23:45"), send_time="23:40")[0]["sent"])
        result, _ = self.run_with("daily", at(MONDAY + timedelta(days=1), "00:00"), send_time="23:40")
        self.assertEqual(result["skippedReason"], "not yet time")
        self.assertEqual(len(self.session.sent), 1)

    def test_catch_up_only_for_a_working_day(self):
        # Saturday is a working day here; Sunday is not, so Monday 00:00 sends nothing for Sunday.
        result, _ = self.run_with("daily", at(MONDAY, "00:00"), send_time="23:55")
        self.assertEqual(result["skippedReason"], "not yet time")

    def test_weekly_time_just_before_midnight(self):
        result, _ = self.run_with("weekly", at(MONDAY + timedelta(days=1), "00:00"), weekly_send_time="23:50")
        self.assertTrue(result["sent"])
        self.assertEqual(self.session.sent, ["weekly weekly_2026-W45"])
        again, _ = self.run_with("weekly", at(MONDAY + timedelta(days=1), "00:15"), weekly_send_time="23:50")
        self.assertEqual(again["skippedReason"], "not the send day")


class RunAllTests(ReportRunTestCase):
    def test_both_reports_share_one_mail_session(self):
        sessions = []

        def factory():
            session = FakeSession()
            sessions.append(session)
            return session

        results, failed = report_runs.run_reports(
            ("daily", "weekly"), now=at(MONDAY, "10:00"), settings=SETTINGS,
            store=self.store, session_factory=factory,
        )
        self.assertFalse(failed)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(len(sessions[0].sent), 2)
        self.assertEqual([r["report"] for r in results], ["daily", "weekly"])


class HookAuthTests(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.register_blueprint(report_runs.reports_bp)
        self.client = app.test_client()
        env = patch.dict(os.environ, {
            "REPORT_AUDIENCE": "https://vector-application-xyz.a.run.app",
            "REPORT_SCHEDULER_SA": "report-scheduler@vector-production-506505.iam.gserviceaccount.com",
            "REPORT_RUN_KEY": "manual-run-key",
        })
        env.start()
        self.addCleanup(env.stop)
        self.ran = []

        def fake_run(names, **kwargs):
            self.ran.append(tuple(names))
            return [{"report": name, "due": False, "sent": False, "skippedReason": "not yet time"} for name in names], False

        runner = patch.object(report_runs, "run_reports", side_effect=fake_run)
        runner.start()
        self.addCleanup(runner.stop)

    def test_missing_credentials_is_401(self):
        self.assertEqual(self.client.post("/internal/reports/run").status_code, 401)
        self.assertEqual(self.ran, [])

    def test_invalid_token_is_401(self):
        with patch("google.oauth2.id_token.verify_oauth2_token", side_effect=ValueError("bad token")):
            response = self.client.post("/internal/reports/run", headers={"Authorization": "Bearer not-a-token"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.ran, [])

    def test_token_from_another_account_is_403(self):
        claims = {"email": "someone@else.iam.gserviceaccount.com", "email_verified": True}
        with patch("google.oauth2.id_token.verify_oauth2_token", return_value=claims):
            response = self.client.post("/internal/reports/run", headers={"Authorization": "Bearer t"})
        self.assertEqual(response.status_code, 403)

    def test_scheduler_token_runs_both_reports(self):
        claims = {"email": "report-scheduler@vector-production-506505.iam.gserviceaccount.com", "email_verified": True}
        with patch("google.oauth2.id_token.verify_oauth2_token", return_value=claims) as verify:
            response = self.client.post("/internal/reports/run", headers={"Authorization": "Bearer t"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(verify.call_args.kwargs["audience"], "https://vector-application-xyz.a.run.app")
        self.assertEqual(self.ran, [("daily", "weekly")])
        self.assertEqual(len(response.get_json()["results"]), 2)

    def test_report_key_allows_a_manual_run_of_one_report(self):
        response = self.client.post("/internal/reports/run?report=daily", headers={"X-Report-Key": "manual-run-key"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(),
                         {"report": "daily", "due": False, "sent": False, "skippedReason": "not yet time"})

    def test_wrong_report_key_is_401(self):
        response = self.client.post("/internal/reports/run", headers={"X-Report-Key": "guess"})
        self.assertEqual(response.status_code, 401)

    def test_only_post_is_accepted(self):
        self.assertEqual(self.client.get("/internal/reports/run").status_code, 405)

    def test_failed_send_returns_500(self):
        report_runs.run_reports.side_effect = lambda names, **kw: (
            [{"report": "daily", "due": True, "sent": False, "skippedReason": "send failed (RuntimeError)"}], True)
        response = self.client.post("/internal/reports/run?report=daily", headers={"X-Report-Key": "manual-run-key"})
        self.assertEqual(response.status_code, 500)


class SendTimeSettingsTests(unittest.TestCase):
    def payload(self, **overrides):
        return {**SETTINGS, **overrides}

    def test_any_time_of_day_is_accepted(self):
        for value in ("00:00", "05:30", "12:30", "21:46", "23:59"):
            with self.subTest(value=value):
                cleaned = daily_report._clean_settings(self.payload(send_time=value, weekly_send_time=value))
                self.assertEqual(cleaned["send_time"], value)
                self.assertEqual(cleaned["weekly_send_time"], value)

    def test_malformed_times_are_rejected(self):
        for value in ("24:00", "9:00", "12:60", "noon"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    daily_report._clean_settings(self.payload(send_time=value))


if __name__ == "__main__":
    unittest.main()
