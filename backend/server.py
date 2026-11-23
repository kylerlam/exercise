"""Exercise: persistent training records and single-account sign-in, using stdlib only."""

from collections import defaultdict, deque
from contextlib import closing
from datetime import date, datetime
import hashlib
import hmac
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
from urllib.parse import parse_qs, unquote, urlsplit
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent.parent
APP_VERSION = "0.1.3"
COOKIE = "exercise_session"
SESSION_SECONDS = 30 * 24 * 60 * 60
PASSWORD_ITERATIONS = 600_000
MAX_BODY = 32_768
RECORD_FIELDS = {"day", "type", "bodyPart", "exercise", "sets", "reps", "weight", "duration", "distance", "notes"}


class RequestError(Exception):
    def __init__(self, message, status=400, code="INVALID_REQUEST"):
        super().__init__(message)
        self.status = status
        self.code = code


def fields(data, allowed):
    if type(data) is not dict:
        raise RequestError("The request must be a JSON object.", code="INVALID_BODY")
    if data.keys() - allowed:
        raise RequestError("The request contains unsupported fields.", code="UNKNOWN_FIELDS")


def text(value, label, minimum=0, maximum=100):
    if type(value) is not str or not minimum <= len(value) <= maximum:
        raise RequestError(f"{label} has an invalid length or type.", code=f"INVALID_{label.upper()}")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise RequestError(f"{label} contains invalid text.", code=f"INVALID_{label.upper()}") from None
    return value


def integer(value, label, maximum=10_000):
    if type(value) is not int or not 1 <= value <= maximum:
        raise RequestError(f"{label} must be a positive integer, at most {maximum}.", code=f"INVALID_{label.upper()}")
    return value


def positive_number(value, label, maximum):
    if type(value) not in (int, float) or not 0 < value <= maximum or not math.isfinite(value):
        raise RequestError(f"{label} must be a positive number, at most {maximum}.", code=f"INVALID_{label.upper()}")
    return value


def valid_date(value):
    if type(value) is not str or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise RequestError("Use a valid YYYY-MM-DD date.", code="INVALID_DATE")
    try:
        result = date.fromisoformat(value)
        if not 1900 <= result.year <= 9998:
            raise ValueError
    except ValueError:
        raise RequestError("Use a real date between 1900 and 9998.", code="INVALID_DATE") from None
    return result.isoformat()


def valid_month(value):
    if type(value) is not str or not re.fullmatch(r"\d{4}-\d{2}", value):
        raise RequestError("Use a valid YYYY-MM month.", code="INVALID_MONTH")
    valid_date(value + "-01")
    return value


def validate_record(data, editing=False):
    fields(data, RECORD_FIELDS | ({"version"} if editing else set()))
    record = {
        "day": valid_date(data.get("day")),
        "type": data.get("type"),
        "bodyPart": text(data.get("bodyPart", ""), "BODY_PART", maximum=60).strip(),
        "exercise": text(data.get("exercise"), "EXERCISE", 1, 100).strip(),
        "sets": data.get("sets"), "reps": data.get("reps"), "weight": data.get("weight"),
        "duration": data.get("duration"), "distance": data.get("distance"),
        "notes": text(data.get("notes", ""), "NOTES", maximum=2000),
    }
    if not record["exercise"]:
        raise RequestError("Enter an exercise.", code="INVALID_EXERCISE")
    if record["type"] == "strength":
        if not record["bodyPart"]:
            raise RequestError("Enter a body part.", code="INVALID_BODY_PART")
        integer(record["sets"], "SETS")
        integer(record["reps"], "REPS")
        if record["weight"] is not None:
            positive_number(record["weight"], "WEIGHT", 10_000)
        if record["duration"] is not None or record["distance"] is not None:
            raise RequestError("Strength records use sets and reps, without cardio fields.", code="INVALID_STRENGTH")
    elif record["type"] == "cardio":
        if record["bodyPart"] or record["sets"] is not None or record["reps"] is not None or record["weight"] is not None:
            raise RequestError("Cardio records use duration and optional distance.", code="INVALID_CARDIO")
        positive_number(record["duration"], "DURATION", 10_080)
        if record["distance"] is not None:
            positive_number(record["distance"], "DISTANCE", 100_000)
    else:
        raise RequestError("Choose strength or cardio.", code="INVALID_TYPE")
    if editing:
        integer(data.get("version"), "VERSION", 2 ** 31 - 1)
    return record


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PASSWORD_ITERATIONS).hex()


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


class Store:
    def __init__(self, data_dir, clock=None, timezone="Asia/Hong_Kong"):
        self.zone = ZoneInfo(timezone)
        self.clock = clock or (lambda: datetime.now(self.zone))
        directory = Path(data_dir)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = directory / "exercise.sqlite3"
        try:
            descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            pass
        else:
            os.close(descriptor)
        with closing(self.connect()) as db, db:
            db.executescript("""
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS accounts (
                    id INTEGER PRIMARY KEY CHECK(id = 1), username TEXT NOT NULL UNIQUE,
                    salt TEXT NOT NULL, password_hash TEXT NOT NULL,
                    account_changed INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                    expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    day TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('strength', 'cardio')),
                    bodyPart TEXT NOT NULL, exercise TEXT NOT NULL,
                    sets INTEGER, reps INTEGER, weight REAL, duration REAL, distance REAL,
                    notes TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    CHECK ((type = 'strength' AND length(bodyPart) > 0
                        AND typeof(sets) = 'integer' AND sets BETWEEN 1 AND 10000
                        AND typeof(reps) = 'integer' AND reps BETWEEN 1 AND 10000
                        AND (weight IS NULL OR (weight > 0 AND weight <= 10000))
                        AND duration IS NULL AND distance IS NULL)
                        OR (type = 'cardio' AND bodyPart = '' AND sets IS NULL AND reps IS NULL
                        AND weight IS NULL
                        AND duration > 0 AND duration <= 10080
                        AND (distance IS NULL OR (distance > 0 AND distance <= 100000))))
                );
                CREATE INDEX IF NOT EXISTS records_day ON records(day, id);
            """)
            if not any(row[1] == "weight" for row in db.execute("PRAGMA table_info(records)")):
                db.execute("ALTER TABLE records ADD COLUMN weight REAL")
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM accounts WHERE id=1").fetchone() is None:
                salt = secrets.token_hex(16)
                db.execute("INSERT INTO accounts(id,username,salt,password_hash) VALUES(1,?,?,?)",
                           ("admin", salt, password_hash("admin123", salt)))

    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        return db

    def now(self):
        return self.clock().astimezone(self.zone).isoformat(timespec="microseconds")

    def today(self):
        return self.now()[:10]

    def epoch(self):
        return int(datetime.fromisoformat(self.now()).timestamp())

    def show_default_credentials(self):
        with closing(self.connect()) as db:
            return not bool(db.execute("SELECT account_changed FROM accounts WHERE id=1").fetchone()[0])

    def login(self, data):
        fields(data, {"username", "password"})
        username = text(data.get("username"), "USERNAME", maximum=64)
        password = text(data.get("password"), "PASSWORD", maximum=256)
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            account = db.execute("SELECT * FROM accounts WHERE id=1").fetchone()
            valid = hmac.compare_digest(password_hash(password, account["salt"]), account["password_hash"])
            if not hmac.compare_digest(username.encode(), account["username"].encode()) or not valid:
                raise RequestError("Invalid username or password.", 401, "INVALID_CREDENTIALS")
            token = secrets.token_urlsafe(32)
            now = self.epoch()
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            db.execute("INSERT INTO sessions VALUES(?,1,?)", (token_hash(token), now + SESSION_SECONDS))
            return token, {"username": account["username"]}

    def session_user(self, token):
        if not token:
            return None
        try:
            digest = token_hash(token)
        except UnicodeError:
            return None
        with closing(self.connect()) as db:
            row = db.execute("""SELECT a.username FROM sessions s JOIN accounts a ON a.id=s.user_id
                WHERE s.token_hash=? AND s.expires_at > ?""", (digest, self.epoch())).fetchone()
            return {"username": row["username"]} if row else None

    def logout(self, token):
        if token:
            with closing(self.connect()) as db, db:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(token),))

    def require_session(self, db, token):
        # Direct Store calls are trusted; HTTP mutations always supply their session token.
        if token is not None and not db.execute(
                "SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?",
                (token_hash(token), self.epoch())).fetchone():
            raise RequestError("Sign in to continue.", 401, "AUTH_REQUIRED")

    def update_account(self, data, token=None):
        fields(data, {"username", "current_password", "new_password"})
        username = text(data.get("username"), "USERNAME", 2, 64)
        if username != username.strip() or any(unicodedata.category(char) == "Cc" for char in username):
            raise RequestError("Use a username without control characters or outer spaces.", code="INVALID_USERNAME")
        current = text(data.get("current_password"), "CURRENT_PASSWORD", maximum=256)
        new_password = data.get("new_password", "")
        if new_password != "":
            text(new_password, "PASSWORD", 8, 256)
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.require_session(db, token)
            account = db.execute("SELECT * FROM accounts WHERE id=1").fetchone()
            if not hmac.compare_digest(password_hash(current, account["salt"]), account["password_hash"]):
                raise RequestError("The current password is incorrect.", code="INVALID_CURRENT_PASSWORD")
            changed_password = bool(new_password) and not hmac.compare_digest(new_password.encode(), current.encode())
            changed = changed_password or username != account["username"]
            salt = secrets.token_hex(16) if changed_password else account["salt"]
            hashed = password_hash(new_password, salt) if changed_password else account["password_hash"]
            db.execute("""UPDATE accounts SET username=?,salt=?,password_hash=?,
                account_changed=CASE WHEN ? THEN 1 ELSE account_changed END WHERE id=1""",
                       (username, salt, hashed, changed))
            db.execute("DELETE FROM sessions")

    @staticmethod
    def record(db, record_id):
        row = db.execute("SELECT * FROM records WHERE id=?", (record_id,)).fetchone()
        if row is None:
            raise RequestError("The training record was not found.", 404, "NOT_FOUND")
        return dict(row)

    def month(self, month):
        month = valid_month(month)
        with closing(self.connect()) as db:
            rows = db.execute("SELECT * FROM records WHERE day >= ? AND day <= ? ORDER BY day,id",
                              (month + "-01", month + "-31")).fetchall()
            return {"records": [dict(row) for row in rows], "today": self.today()}

    def create(self, data, token=None):
        record = validate_record(data)
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.require_session(db, token)
            now = self.now()
            record_id = db.execute("""INSERT INTO records
                (day,type,bodyPart,exercise,sets,reps,weight,duration,distance,notes,created_at,updated_at)
                VALUES(:day,:type,:bodyPart,:exercise,:sets,:reps,:weight,:duration,:distance,:notes,:created_at,:updated_at)""",
                                   {**record, "created_at": now, "updated_at": now}).lastrowid
            return self.record(db, record_id)

    def patch(self, record_id, data, token=None):
        record = validate_record(data, editing=True)
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.require_session(db, token)
            current = self.record(db, record_id)
            if current["version"] != data["version"]:
                raise RequestError("This record changed on another screen. Refresh and try again.", 409, "RECORD_CHANGED")
            values = {**record, "id": record_id, "updated_at": self.now()}
            db.execute("""UPDATE records SET day=:day,type=:type,bodyPart=:bodyPart,exercise=:exercise,
                sets=:sets,reps=:reps,weight=:weight,duration=:duration,distance=:distance,notes=:notes,
                version=version+1,updated_at=:updated_at WHERE id=:id""", values)
            return self.record(db, record_id)

    def delete(self, record_id, data, token=None):
        fields(data, {"version"})
        version = integer(data.get("version"), "VERSION", 2 ** 31 - 1)
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.require_session(db, token)
            current = self.record(db, record_id)
            if current["version"] != version:
                raise RequestError("This record changed on another screen. Refresh and try again.", 409, "RECORD_CHANGED")
            db.execute("DELETE FROM records WHERE id=?", (record_id,))

    def export(self):
        with closing(self.connect()) as db:
            return {"format": "exercise", "version": 1, "exported_at": self.now(),
                    "records": [dict(row) for row in db.execute("SELECT * FROM records ORDER BY day,id")]}


def create_server(host="127.0.0.1", port=4186, data_dir=None, dist_dir=None, secure_cookie=False, store=None):
    store = store or Store(data_dir or ROOT / "data", timezone=os.environ.get("TZ", "Asia/Hong_Kong"))
    dist = Path(dist_dir or ROOT / "dist").resolve()
    attempts = defaultdict(deque)
    attempts_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "Exercise/" + APP_VERSION

        def send_bytes(self, content, content_type, status=200):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store" if self.path.startswith("/api") else "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
            if self.pending_cookie is not None:
                self.send_header("Set-Cookie", self.pending_cookie)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(content)

        def send_json(self, value, status=200):
            self.send_bytes(json.dumps(value, ensure_ascii=False, allow_nan=False).encode(), "application/json; charset=utf-8", status)

        def session_token(self):
            cookie = SimpleCookie()
            try:
                cookie.load(self.headers.get("Cookie", ""))
                return cookie[COOKIE].value if COOKIE in cookie else ""
            except CookieError:
                return ""

        def set_cookie(self, token=""):
            cookie = SimpleCookie()
            cookie[COOKIE] = token
            cookie[COOKIE]["path"] = "/"
            cookie[COOKIE]["httponly"] = True
            cookie[COOKIE]["samesite"] = "Strict"
            cookie[COOKIE]["max-age"] = SESSION_SECONDS if token else 0
            if secure_cookie:
                cookie[COOKIE]["secure"] = True
            self.pending_cookie = cookie.output(header="").strip()

        def mutation_check(self):
            origin = self.headers.get("Origin")
            if origin is not None:
                try:
                    parsed = urlsplit(origin)
                    valid = (parsed.scheme == ("https" if secure_cookie else "http")
                             and parsed.netloc.lower() == self.headers.get("Host", "").lower()
                             and not (parsed.path or parsed.query or parsed.fragment))
                except ValueError:
                    valid = False
                if not valid:
                    raise RequestError("Cross-origin requests are not allowed.", 403, "CSRF_REJECTED")
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                raise RequestError("Cross-site requests are not allowed.", 403, "CSRF_REJECTED")
            if self.headers.get_content_type() != "application/json":
                raise RequestError("Use application/json.", 415, "UNSUPPORTED_CONTENT_TYPE")

        def login_limit(self):
            now = time.monotonic()
            with attempts_lock:
                for ip in list(attempts):
                    while attempts[ip] and attempts[ip][0] <= now - 300:
                        attempts[ip].popleft()
                    if not attempts[ip]:
                        del attempts[ip]
                history = attempts[self.client_address[0]]
                if len(history) >= 10:
                    raise RequestError("Too many login attempts. Try again in five minutes.", 429, "RATE_LIMITED")
                history.append(now)

        def body(self):
            if self.headers.get("Transfer-Encoding"):
                raise RequestError("Chunked requests are not supported.", code="INVALID_CONTENT_LENGTH")
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                raise RequestError("The request length is invalid.", code="INVALID_CONTENT_LENGTH") from None
            if not 0 < length <= MAX_BODY:
                raise RequestError("The request body is too large or empty.", 413, "BODY_TOO_LARGE")
            try:
                def reject_constant(value):
                    raise ValueError(value)
                return json.loads(self.rfile.read(length), parse_constant=reject_constant)
            except (ValueError, UnicodeError, RecursionError):
                raise RequestError("The JSON body is invalid.", code="INVALID_JSON") from None

        def redirect(self, location):
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def static(self, path):
            if "\x00" in path or "\\" in path or any(part.startswith(".") for part in path.split("/") if part):
                raise RequestError("The path is invalid.", 404, "NOT_FOUND")
            if path == "/login.html" and self.user:
                return self.redirect("/")
            target = (dist / (path.lstrip("/") or "index.html")).resolve()
            if not target.is_relative_to(dist):
                raise RequestError("The path is invalid.", 404, "NOT_FOUND")
            if not target.is_file():
                raise RequestError("The file was not found.", 404, "NOT_FOUND")
            if target == dist / "index.html" and not self.user:
                return self.redirect("/login.html")
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
                content_type += "; charset=utf-8"
            self.send_bytes(target.read_bytes(), content_type)

        def handle_request(self):
            self.pending_cookie = None
            try:
                try:
                    parsed = urlsplit(self.path)
                    path = unquote(parsed.path)
                    query = parse_qs(parsed.query, keep_blank_values=True)
                except ValueError:
                    raise RequestError("The request path is invalid.", code="INVALID_PATH") from None
                if self.command not in ("GET", "HEAD"):
                    self.mutation_check()
                token = self.session_token()
                self.user = store.session_user(token)
                if path == "/api/auth/status" and self.command in ("GET", "HEAD"):
                    return self.send_json({"authenticated": self.user is not None, "user": self.user,
                                           "show_default_credentials": store.show_default_credentials(), "today": store.today()})
                if path == "/api/health" and self.command in ("GET", "HEAD"):
                    with closing(store.connect()) as db:
                        db.execute("SELECT 1")
                    return self.send_json({"ok": True, "status": "ok", "app": "exercise", "version": APP_VERSION,
                                           "pid": os.getpid(), "today": store.today()})
                if path == "/api/auth/login" and self.command == "POST":
                    self.login_limit()
                    token, user = store.login(self.body())
                    self.set_cookie(token)
                    with attempts_lock:
                        attempts.pop(self.client_address[0], None)
                    return self.send_json({"user": user})
                if path == "/api/auth/logout" and self.command == "POST":
                    fields(self.body(), set())
                    store.logout(token)
                    self.set_cookie()
                    return self.send_json({"ok": True})
                if (path == "/api" or path.startswith("/api/")) and self.user is None:
                    raise RequestError("Sign in to continue.", 401, "AUTH_REQUIRED")
                if path == "/api/account" and self.command == "PATCH":
                    store.update_account(self.body(), token=token)
                    self.set_cookie()
                    return self.send_json({"reauthenticate": True})
                if path == "/api/records" and self.command in ("GET", "HEAD"):
                    if set(query) != {"month"} or len(query["month"]) != 1:
                        raise RequestError("Provide exactly one month parameter.", code="INVALID_QUERY")
                    return self.send_json(store.month(query["month"][0]))
                if path == "/api/export" and self.command in ("GET", "HEAD"):
                    if query:
                        raise RequestError("This endpoint does not take parameters.", code="INVALID_QUERY")
                    return self.send_json(store.export())
                if path == "/api/records" and self.command == "POST":
                    return self.send_json({"record": store.create(self.body(), token=token)}, 201)
                match = re.fullmatch(r"/api/records/([1-9]\d{0,18})", path)
                if match and int(match[1]) < 2 ** 63:
                    if self.command == "PATCH":
                        return self.send_json({"record": store.patch(int(match[1]), self.body(), token=token)})
                    if self.command == "DELETE":
                        store.delete(int(match[1]), self.body(), token=token)
                        return self.send_json({"ok": True})
                if path == "/api" or path.startswith("/api/"):
                    raise RequestError("The endpoint was not found.", 404, "NOT_FOUND")
                if self.command in ("GET", "HEAD"):
                    return self.static(path)
                raise RequestError("This method is not allowed.", 405, "METHOD_NOT_ALLOWED")
            except RequestError as error:
                self.send_json({"error": str(error), "code": error.code}, error.status)
            except (sqlite3.DatabaseError, OSError):
                self.send_json({"error": "Unable to read or save data. Try again later.", "code": "STORAGE_ERROR"}, 500)

        do_GET = handle_request
        do_HEAD = handle_request
        do_POST = handle_request
        do_PATCH = handle_request
        do_DELETE = handle_request
        do_PUT = handle_request

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.store = store
    return server


if __name__ == "__main__":
    server = create_server(os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "4186")),
                           os.environ.get("DATA_DIR", ROOT / "data"), os.environ.get("DIST_DIR", ROOT / "dist"),
                           os.environ.get("SESSION_COOKIE_SECURE", "false").lower() in ("true", "1"))
    print(f"Exercise running at http://{server.server_address[0]}:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
