"""Run with python3 -B -m unittest discover -s tests -v. Uses isolated temporary data."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta
import http.client
import json
from pathlib import Path
import socket
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from backend.server import COOKIE, SESSION_SECONDS, RequestError, Store, create_server, token_hash, validate_record


def strength(**changes):
    return {"day": "2026-11-16", "type": "strength", "bodyPart": "腿", "exercise": "深蹲", "sets": 4,
            "reps": 15, "duration": None, "distance": None, "notes": "", **changes}


def cardio(**changes):
    return {"day": "2026-11-16", "type": "cardio", "bodyPart": "", "exercise": "跑步", "sets": None,
            "reps": None, "duration": 30.5, "distance": 5.2, "notes": "", **changes}


class ValidationTests(unittest.TestCase):
    def test_strength_requires_strict_positive_integers(self):
        for field in ("sets", "reps"):
            for value in (0, -1, 1.0, 1.5, True, False, "4", None, 10001):
                with self.subTest(field=field, value=value), self.assertRaises(RequestError):
                    validate_record(strength(**{field: value}))
        self.assertEqual(validate_record(strength(sets=1, reps=10000))["reps"], 10000)

    def test_required_text_and_lengths(self):
        for changes in ({"bodyPart": " "}, {"exercise": " "}, {"bodyPart": "x" * 61},
                        {"exercise": "x" * 101}, {"notes": "x" * 2001}, {"exercise": 3},
                        {"notes": "\ud800"}, {"notes": None}):
            with self.subTest(changes=changes), self.assertRaises(RequestError):
                validate_record(strength(**changes))

    def test_dates_and_leap_year(self):
        for value in ("2026-02-29", "2026-13-01", "2026-04-31", "2026-1-01", "1899-12-31", "9999-01-01", None):
            with self.subTest(value=value), self.assertRaises(RequestError):
                validate_record(strength(day=value))
        for value in ("2024-02-29", "1900-01-01", "9998-12-31"):
            self.assertEqual(validate_record(strength(day=value))["day"], value)

    def test_cardio_validates_finite_positive_numbers(self):
        self.assertEqual(validate_record(cardio(distance=None))["duration"], 30.5)
        for field in ("duration", "distance"):
            for value in (0, -1, "30", True, float("inf"), float("nan"), 10 ** 400):
                with self.subTest(field=field, value=value), self.assertRaises(RequestError):
                    validate_record(cardio(**{field: value}))
        with self.assertRaises(RequestError):
            validate_record(cardio(duration=None))

    def test_record_types_cannot_mix(self):
        for value in (strength(duration=20), strength(distance=3), cardio(sets=2), cardio(reps=5),
                      cardio(bodyPart="腿"), strength(type="unknown"), strength(type=["strength"])):
            with self.subTest(value=value), self.assertRaises(RequestError):
                validate_record(value)

    def test_weight_is_optional_and_bounded_for_strength(self):
        self.assertIsNone(validate_record(strength())["weight"])
        self.assertEqual(validate_record(strength(weight=60))["weight"], 60)
        self.assertEqual(validate_record(strength(weight=62.5))["weight"], 62.5)
        self.assertIsNone(validate_record(strength(weight=None))["weight"])
        for value in (0, -1, "60", True, float("inf"), float("nan"), 10001, 10 ** 400):
            with self.subTest(value=value), self.assertRaises(RequestError):
                validate_record(strength(weight=value))
        with self.assertRaises(RequestError):
            validate_record(cardio(weight=60))

    def test_unknown_fields_and_non_objects(self):
        for value in ([], None, {**strength(), "owner": "someone"}, {**strength(), "id": 1}):
            with self.subTest(value=value), self.assertRaises(RequestError):
                validate_record(value)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.now = datetime(2026, 11, 16, 23, 40, tzinfo=ZoneInfo("Asia/Hong_Kong"))
        self.store = Store(self.directory.name, clock=lambda: self.now)

    def tearDown(self):
        self.directory.cleanup()

    def test_restart_preserves_records_credentials_and_sessions(self):
        record = self.store.create(strength())
        token, _ = self.store.login({"username": "admin", "password": "admin123"})
        reopened = Store(self.directory.name, clock=lambda: self.now)
        self.assertEqual(reopened.month("2026-11")["records"], [record])
        self.assertEqual(reopened.session_user(token), {"username": "admin"})
        with closing(reopened.connect()) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertNotEqual(db.execute("SELECT token_hash FROM sessions").fetchone()[0], token)
            self.assertNotEqual(db.execute("SELECT password_hash FROM accounts").fetchone()[0], "admin123")

    def test_session_expiry_and_logout(self):
        token, _ = self.store.login({"username": "admin", "password": "admin123"})
        self.assertIsNotNone(self.store.session_user(token))
        self.now += timedelta(seconds=SESSION_SECONDS)
        self.assertIsNone(self.store.session_user(token))
        token, _ = self.store.login({"username": "admin", "password": "admin123"})
        self.store.logout(token)
        self.assertIsNone(self.store.session_user(token))

    def test_expired_session_cannot_mutate_records(self):
        record = self.store.create(strength())
        token, _ = self.store.login({"username": "admin", "password": "admin123"})
        self.now += timedelta(seconds=SESSION_SECONDS)
        operations = (lambda: self.store.create(strength(), token=token),
                      lambda: self.store.patch(record["id"], {**strength(), "version": 1}, token=token),
                      lambda: self.store.delete(record["id"], {"version": 1}, token=token),
                      lambda: self.store.update_account({"username": "trainer", "current_password": "admin123"}, token=token))
        for operation in operations:
            with self.assertRaises(RequestError) as error:
                operation()
            self.assertEqual(error.exception.status, 401)
        self.assertEqual(self.store.export()["records"], [record])

    def test_password_change_revokes_all_sessions_and_hides_defaults(self):
        token1, _ = self.store.login({"username": "admin", "password": "admin123"})
        token2, _ = self.store.login({"username": "admin", "password": "admin123"})
        self.store.update_account({"username": "trainer", "current_password": "admin123", "new_password": "new-password-123"})
        self.assertIsNone(self.store.session_user(token1))
        self.assertIsNone(self.store.session_user(token2))
        self.assertFalse(self.store.show_default_credentials())
        with self.assertRaises(RequestError):
            self.store.login({"username": "admin", "password": "admin123"})
        self.assertEqual(self.store.login({"username": "trainer", "password": "new-password-123"})[1], {"username": "trainer"})

    def test_account_rejects_invalid_current_or_new_password(self):
        for changes in ({"current_password": "wrong"}, {"new_password": "short"}, {"new_password": None},
                        {"username": " spaced "}, {"username": "a\nb"}, {"username": 3}):
            value = {"username": "admin", "current_password": "admin123", **changes}
            with self.subTest(value=value), self.assertRaises(RequestError):
                self.store.update_account(value)
        self.assertTrue(self.store.show_default_credentials())

    def test_username_only_change_retains_password(self):
        self.store.update_account({"username": "trainer", "current_password": "admin123"})
        self.assertFalse(self.store.show_default_credentials())
        self.assertEqual(self.store.login({"username": "trainer", "password": "admin123"})[1]["username"], "trainer")

    def test_weight_persists_and_clears_between_record_types(self):
        record = self.store.create(strength(weight=60))
        self.assertEqual(record["weight"], 60)
        self.assertEqual(self.store.month("2026-11")["records"][0]["weight"], 60)
        cleared = self.store.patch(record["id"], {**strength(), "version": 1})
        self.assertIsNone(cleared["weight"])
        to_cardio = self.store.patch(record["id"], {**cardio(), "version": 2})
        self.assertIsNone(to_cardio["weight"])

    def test_opens_and_migrates_a_database_without_the_weight_column(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "exercise.sqlite3"
        with closing(sqlite3.connect(path)) as db:
            db.execute("""CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT,
                day TEXT NOT NULL, type TEXT NOT NULL, bodyPart TEXT NOT NULL, exercise TEXT NOT NULL,
                sets INTEGER, reps INTEGER, duration REAL, distance REAL, notes TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
            db.execute("""INSERT INTO records (day,type,bodyPart,exercise,sets,reps,notes,created_at,updated_at)
                VALUES('2026-11-16','strength','腿','深蹲',4,15,'','2026-11-16T00:00:00','2026-11-16T00:00:00')""")
            db.commit()
        store = Store(directory.name, clock=lambda: self.now)
        self.assertIsNone(store.month("2026-11")["records"][0]["weight"])
        self.assertEqual(store.create(strength(weight=72.5))["weight"], 72.5)

    def test_existing_records_seed_exercise_library_once(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "exercise.sqlite3"
        with closing(sqlite3.connect(path)) as db:
            db.execute("""CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT,
                day TEXT NOT NULL, type TEXT NOT NULL, bodyPart TEXT NOT NULL, exercise TEXT NOT NULL,
                sets INTEGER, reps INTEGER, weight REAL, duration REAL, distance REAL, notes TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
            for body, name, kind, sets, duration in (("腿", "深蹲", "strength", 4, None), ("腿", "深蹲 ", "strength", 3, None),
                                                      ("胸", "卧推", "strength", 4, None), ("", "跑步", "cardio", None, 30)):
                db.execute("""INSERT INTO records (day,type,bodyPart,exercise,sets,reps,duration,notes,created_at,updated_at)
                    VALUES('2026-11-16',?,?,?,?,?,?,'','2026-11-16T00:00:00','2026-11-16T00:00:00')""",
                           (kind, body, name, sets, 10 if sets else None, duration))
            db.commit()
        store = Store(directory.name, clock=lambda: self.now)
        items = store.exercises()["exercises"]
        self.assertEqual([(i["type"], i["bodyPart"], i["name"]) for i in items],
                         [("strength", "腿", "深蹲"), ("strength", "胸", "卧推"), ("cardio", "", "跑步")])
        store.delete_exercise(items[0]["id"], {})
        reopened = Store(directory.name, clock=lambda: self.now)
        self.assertEqual(len(reopened.exercises()["exercises"]), 2)

    def test_exercise_library_validation_and_duplicates(self):
        item = self.store.create_exercise({"type": "strength", "bodyPart": " 背 ", "name": " 划船 "})
        self.assertEqual((item["bodyPart"], item["name"]), ("背", "划船"))
        for bad in ({"type": "strength", "bodyPart": "", "name": "x"}, {"type": "cardio", "bodyPart": "腿", "name": "x"},
                    {"type": "yoga", "name": "x"}, {"type": "cardio", "name": " "}, {"type": "cardio", "name": "x", "extra": 1}):
            with self.subTest(bad=bad), self.assertRaises(RequestError):
                self.store.create_exercise(bad)
        with self.assertRaises(RequestError) as error:
            self.store.create_exercise({"type": "strength", "bodyPart": "背", "name": "划船"})
        self.assertEqual(error.exception.status, 409)
        self.store.delete_exercise(item["id"], {})
        with self.assertRaises(RequestError) as error:
            self.store.delete_exercise(item["id"], {})
        self.assertEqual(error.exception.status, 404)

    def test_month_filtering_leap_day_and_boundaries(self):
        for day in ("2024-02-29", "2024-03-01", "9998-12-31"):
            self.store.create(strength(day=day))
        self.assertEqual([r["day"] for r in self.store.month("2024-02")["records"]], ["2024-02-29"])
        self.assertEqual(len(self.store.month("9998-12")["records"]), 1)
        self.assertEqual(self.store.month("2026-11")["records"], [])
        for month in ("2026-13", "2026-00", "2026-2", "2026-02-01", "9999-01"):
            with self.subTest(month=month), self.assertRaises(RequestError):
                self.store.month(month)

    def test_crud_preserves_typed_values(self):
        record = self.store.create(strength(notes="记录"))
        self.assertIs(type(record["sets"]), int)
        self.assertIs(type(record["reps"]), int)
        self.assertEqual(record["version"], 1)
        updated = self.store.patch(record["id"], {**cardio(), "version": 1})
        self.assertEqual(updated["type"], "cardio")
        self.assertIsNone(updated["sets"])
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["created_at"], record["created_at"])
        self.store.delete(record["id"], {"version": 2})
        self.assertEqual(self.store.month("2026-11")["records"], [])
        with self.assertRaises(RequestError) as error:
            self.store.delete(record["id"], {"version": 2})
        self.assertEqual(error.exception.status, 404)

    def test_version_conflicts_do_not_overwrite_or_delete(self):
        record = self.store.create(strength())
        updated = self.store.patch(record["id"], {**strength(reps=20), "version": 1})
        for action in (lambda: self.store.patch(record["id"], {**strength(reps=10), "version": 1}),
                       lambda: self.store.delete(record["id"], {"version": 1})):
            with self.assertRaises(RequestError) as error:
                action()
            self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.store.month("2026-11")["records"], [updated])

    def test_concurrent_writes_preserve_every_record(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            records = list(pool.map(lambda i: self.store.create(strength(exercise=f"动作{i}")), range(24)))
        self.assertEqual(len({record["id"] for record in records}), 24)
        self.assertEqual(len(self.store.month("2026-11")["records"]), 24)

    def test_same_record_race_has_one_winner(self):
        record = self.store.create(strength())
        def save(reps):
            try:
                return self.store.patch(record["id"], {**strength(reps=reps), "version": 1})["version"]
            except RequestError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, (20, 30)))
        self.assertCountEqual(results, [2, 409])

    def test_export_contains_only_records_and_metadata(self):
        record = self.store.create(strength(exercise="<script>alert(1)</script>", notes="<img src=x onerror=alert(1)>"))
        exported = self.store.export()
        self.assertEqual(set(exported), {"format", "version", "exported_at", "records"})
        self.assertEqual(exported["records"], [record])
        self.assertEqual(exported["format"], "exercise")


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.dist = Path(self.directory.name) / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text("<title>Exercise</title>")
        (self.dist / "login.html").write_text("<title>Sign in</title>")
        (self.dist / "app.js").write_text("export const app = 'Exercise';")
        self.store = Store(Path(self.directory.name) / "data")
        self.server = create_server(port=0, store=self.store, dist_dir=self.dist)
        self.server.RequestHandlerClass.log_message = lambda *args: None
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.cookie = None

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, method, path, data=None, headers=None, cookie=True, raw=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=10)
        outgoing = {"Content-Type": "application/json"} if data is not None or raw is not None else {}
        if cookie and self.cookie:
            outgoing["Cookie"] = self.cookie
        outgoing.update(headers or {})
        body = raw if raw is not None else json.dumps(data) if data is not None else None
        connection.request(method, path, body=body, headers=outgoing)
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, dict(response.getheaders()),
                  json.loads(payload) if payload and "application/json" in response.getheader("Content-Type", "") else payload)
        connection.close()
        return result

    def login(self):
        status, headers, body = self.request("POST", "/api/auth/login", {"username": "admin", "password": "admin123"})
        self.assertEqual(status, 200)
        self.cookie = headers["Set-Cookie"].split(";", 1)[0]
        return headers

    def test_public_health_auth_status_and_guard(self):
        status, _, body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        version = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text())["version"]
        self.assertEqual((body["status"], body["app"], body["version"]), ("ok", "exercise", version))
        self.assertIs(type(body["pid"]), int)
        status, _, body = self.request("GET", "/api/auth/status")
        self.assertEqual(status, 200)
        self.assertFalse(body["authenticated"])
        self.assertTrue(body["show_default_credentials"])
        self.assertIsNone(body["user"])
        self.assertEqual(self.request("GET", "/api/records?month=2026-11")[0], 401)
        self.assertEqual(self.request("GET", "/api/export")[0], 401)
        self.assertEqual(self.request("GET", "/")[1]["Location"], "/login.html")

    def test_login_cookie_flags_and_logout(self):
        headers = self.login()
        for value in (COOKIE + "=", "HttpOnly", "SameSite=Strict", "Path=/", f"Max-Age={SESSION_SECONDS}"):
            self.assertIn(value, headers["Set-Cookie"])
        self.assertNotIn("Secure", headers["Set-Cookie"])
        self.assertTrue(self.request("GET", "/api/auth/status")[2]["authenticated"])
        self.assertEqual(self.request("GET", "/login.html")[1]["Location"], "/")
        self.assertEqual(self.request("POST", "/api/auth/logout", {})[0], 200)
        self.assertFalse(self.request("GET", "/api/auth/status")[2]["authenticated"])

    def test_record_http_crud_and_validation(self):
        self.login()
        status, _, body = self.request("POST", "/api/records", strength())
        self.assertEqual(status, 201)
        record = body["record"]
        self.assertEqual(self.request("POST", "/api/records", strength(reps=12.5))[0], 400)
        self.assertEqual(self.request("POST", "/api/records", cardio())[0], 201)
        self.assertEqual(len(self.request("GET", "/api/records?month=2026-11")[2]["records"]), 2)
        updated = self.request("PATCH", f'/api/records/{record["id"]}', {**strength(sets=3), "version": 1})
        self.assertEqual(updated[0], 200)
        self.assertEqual(updated[2]["record"]["version"], 2)
        self.assertEqual(self.request("DELETE", f'/api/records/{record["id"]}', {"version": 1})[0], 409)
        self.assertEqual(self.request("DELETE", f'/api/records/{record["id"]}', {"version": 2})[0], 200)
        self.assertEqual(self.request("DELETE", "/api/records/999", {"version": 1})[0], 404)

    def test_exercise_http_crud(self):
        self.assertEqual(self.request("GET", "/api/exercises")[0], 401)
        self.login()
        self.assertEqual(self.request("GET", "/api/exercises")[2], {"exercises": []})
        status, _, body = self.request("POST", "/api/exercises", {"type": "strength", "bodyPart": "腿", "name": "深蹲"})
        self.assertEqual(status, 201)
        self.assertEqual(self.request("POST", "/api/exercises", {"type": "strength", "bodyPart": "腿", "name": "深蹲"})[2]["code"], "EXERCISE_EXISTS")
        self.assertEqual(self.request("POST", "/api/exercises", {"type": "cardio", "name": "跑步"})[0], 201)
        self.assertEqual([i["name"] for i in self.request("GET", "/api/exercises")[2]["exercises"]], ["深蹲", "跑步"])
        self.assertEqual(self.request("GET", "/api/exercises?x=1")[0], 400)
        self.assertEqual(self.request("DELETE", f'/api/exercises/{body["exercise"]["id"]}', {})[0], 200)
        self.assertEqual(self.request("DELETE", f'/api/exercises/{body["exercise"]["id"]}', {})[0], 404)
        self.assertEqual(len(self.request("GET", "/api/exercises")[2]["exercises"]), 1)

    def test_weight_round_trips_through_http(self):
        self.login()
        status, _, body = self.request("POST", "/api/records", strength(weight=80))
        self.assertEqual(status, 201)
        self.assertEqual(body["record"]["weight"], 80)
        self.assertEqual(self.request("POST", "/api/records", strength(weight=0))[0], 400)
        self.assertEqual(self.request("POST", "/api/records", cardio(weight=50))[0], 400)
        self.assertEqual(self.request("GET", "/api/records?month=2026-11")[2]["records"][0]["weight"], 80)

    def test_http_huge_numeric_cardio_fields_return_validation_error(self):
        self.login()
        for field in ("duration", "distance"):
            with self.subTest(field=field):
                status, _, body = self.request("POST", "/api/records", cardio(**{field: 10 ** 400}))
                self.assertEqual(status, 400)
                self.assertEqual(body["code"], "INVALID_" + field.upper())
        self.assertEqual(self.request("GET", "/api/health")[0], 200)

    def test_exact_month_query_required(self):
        self.login()
        for path in ("/api/records", "/api/records?month=", "/api/records?month=2026-13",
                     "/api/records?month=2026-11&month=2026-12", "/api/records?month=2026-11&extra=x"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 400)

    def test_origin_and_content_type_rejected(self):
        self.assertEqual(self.request("POST", "/api/auth/login", {}, {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/auth/login", {}, {"Origin": "null"})[0], 403)
        self.assertEqual(self.request("POST", "/api/auth/login", {}, {"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.request("POST", "/api/auth/login", {}, {"Content-Type": "text/plain"})[0], 415)
        origin = f"http://{self.server.server_address[0]}:{self.server.server_address[1]}"
        self.assertEqual(self.request("POST", "/api/auth/login", {}, {"Origin": origin.replace("http:", "https:")})[0], 403)
        self.assertEqual(self.request("POST", "/api/auth/login", {"username": "admin", "password": "admin123"}, {"Origin": origin})[0], 200)

    def test_malformed_and_nonfinite_json_rejected(self):
        for raw in ("{", "[]", "null", '{"username":NaN,"password":"x"}', '{"username":Infinity,"password":"x"}'):
            with self.subTest(raw=raw):
                self.assertEqual(self.request("POST", "/api/auth/login", raw=raw)[0], 400)
        self.assertEqual(self.request("POST", "/api/auth/login", raw="x" * 32769)[0], 413)

    def test_login_rate_limit(self):
        for _ in range(10):
            self.assertEqual(self.request("POST", "/api/auth/login", {"username": "admin", "password": "wrong"})[0], 401)
        self.assertEqual(self.request("POST", "/api/auth/login", {"username": "admin", "password": "admin123"})[0], 429)

    def test_account_http_invalidates_session(self):
        self.login()
        status, headers, body = self.request("PATCH", "/api/account", {
            "username": "trainer", "current_password": "admin123", "new_password": "a-new-password"})
        self.assertEqual(status, 200)
        self.assertTrue(body["reauthenticate"])
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        self.assertEqual(self.request("GET", "/api/export")[0], 401)
        self.assertFalse(self.request("GET", "/api/auth/status")[2]["show_default_credentials"])
        self.assertEqual(self.request("POST", "/api/auth/login", {"username": "trainer", "password": "a-new-password"})[0], 200)

    def delayed_mutation(self, method, path, data, revoke):
        waiting = threading.Event()
        original_body = self.server.RequestHandlerClass.body
        def wait_for_body(handler):
            if handler.command == method and handler.path == path:
                waiting.set()
            return original_body(handler)
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        payload = json.dumps(data).encode()
        with patch.object(self.server.RequestHandlerClass, "body", wait_for_body):
            try:
                connection.putrequest(method, path)
                connection.putheader("Content-Type", "application/json")
                connection.putheader("Cookie", self.cookie)
                connection.putheader("Content-Length", str(len(payload)))
                connection.endheaders()
                self.assertTrue(waiting.wait(2), "The request did not reach its delayed body read.")
                revoke()
                connection.send(payload)
                response = connection.getresponse()
                result = json.loads(response.read())
                self.assertEqual(response.status, 401)
                self.assertEqual(result["code"], "AUTH_REQUIRED")
            finally:
                connection.close()

    def test_delayed_mutations_recheck_session_after_logout(self):
        record = self.store.create(strength())
        operations = (("POST", "/api/records", strength(exercise="未授权动作")),
                      ("PATCH", f'/api/records/{record["id"]}', {**strength(reps=20), "version": 1}),
                      ("DELETE", f'/api/records/{record["id"]}', {"version": 1}),
                      ("PATCH", "/api/account", {"username": "trainer", "current_password": "admin123"}))
        for method, path, data in operations:
            with self.subTest(method=method, path=path):
                self.login()
                self.delayed_mutation(method, path, data,
                                      lambda: self.assertEqual(self.request("POST", "/api/auth/logout", {})[0], 200))
        self.assertEqual(self.store.export()["records"], [record])
        self.login()

    def test_delayed_record_creation_rechecks_session_after_password_change(self):
        self.login()
        def change_password():
            self.assertEqual(self.request("PATCH", "/api/account", {
                "username": "trainer", "current_password": "admin123", "new_password": "a-new-password"})[0], 200)
        self.delayed_mutation("POST", "/api/records", strength(), change_password)
        self.assertEqual(self.store.export()["records"], [])

    def test_malformed_request_url_returns_400(self):
        with socket.create_connection(self.server.server_address, timeout=5) as connection:
            connection.sendall(b"GET http://[ HTTP/1.1\r\nHost: localhost\r\n\r\n")
            response = http.client.HTTPResponse(connection)
            response.begin()
            self.assertEqual(response.status, 400)
            self.assertEqual(json.loads(response.read())["code"], "INVALID_PATH")
        self.assertEqual(self.request("GET", "/api/health")[0], 200)

    def test_static_traversal_and_security_headers(self):
        for path in ("/%2e%2e/backend/server.py", "/../data/exercise.sqlite3", "/.env", "/%00", "/missing.js"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)
        status, headers, body = self.request("GET", "/app.js")
        self.assertEqual(status, 200)
        self.assertIn(b"Exercise", body)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertEqual(self.request("HEAD", "/app.js")[2], b"")

    def test_export_is_private_json_without_credentials(self):
        self.login()
        self.request("POST", "/api/records", strength())
        status, headers, body = self.request("GET", "/api/export")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["records"]), 1)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn("admin123", json.dumps(body))
        self.assertNotIn("password_hash", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
