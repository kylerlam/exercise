"""Launcher regression tests use copied source, temporary data, and independent ports."""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        for name in ("backend", "scripts", "dist", ".runtime"):
            (self.root / name).mkdir()
        shutil.copy2(ROOT / "backend/server.py", self.root / "backend/server.py")
        shutil.copy2(ROOT / "scripts/run.py", self.root / "scripts/run.py")
        spec = importlib.util.spec_from_file_location("exercise_launcher_test", ROOT / "scripts/run.py")
        self.launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.launcher)
        self.launcher.ROOT = self.root
        self.launcher.RUNTIME = self.root / ".runtime"
        self.owned = {}

    def tearDown(self):
        for port, pid in self.owned.items():
            state = self.health(port)
            if state and state["pid"] == pid:
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        self.directory.cleanup()

    @staticmethod
    def free_port():
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    @staticmethod
    def health(port):
        try:
            with urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as response:
                return json.load(response)
        except (URLError, OSError, ValueError):
            return None

    def command(self, port, action):
        env = {**os.environ, "PORT": str(port), "DATA_DIR": str(self.root / "data"),
               "DIST_DIR": str(self.root / "dist"), "SESSION_COOKIE_SECURE": "false"}
        return [sys.executable, "-B", str(self.root / "scripts/run.py"), action], env

    def run_launcher(self, port, action):
        command, env = self.command(port, action)
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=20)
        if action == "start" and result.returncode == 0:
            state = self.health(port)
            pid_file = self.root / ".runtime" / f"server-{port}.pid"
            if state and pid_file.exists() and int(pid_file.read_text()) == state["pid"]:
                self.owned[port] = state["pid"]
        return result

    def test_health_rejects_non_objects_and_invalid_pids(self):
        invalid = ([], None, "exercise", 3, {"app": "exercise", "status": "ok", "pid": True},
                   {"app": "exercise", "status": "ok", "pid": -1},
                   {"app": "exercise", "status": "ok", "pid": "123"},
                   {"app": "another-app", "status": "ok", "pid": 123})
        for value in invalid:
            with self.subTest(value=value), patch.object(self.launcher, "urlopen", return_value=io.BytesIO(json.dumps(value).encode())):
                self.assertIsNone(self.launcher.health())
        value = {"app": "exercise", "status": "ok", "pid": 123}
        with patch.object(self.launcher, "urlopen", return_value=io.BytesIO(json.dumps(value).encode())):
            self.assertEqual(self.launcher.health(), value)
        with patch.object(self.launcher, "urlopen", return_value=io.BytesIO(b"[" * 2000 + b"]" * 2000)):
            self.assertIsNone(self.launcher.health())

    def test_default_port_preserves_existing_pid_file_for_stop(self):
        self.launcher.PORT = 4186
        pid_file = self.root / ".runtime/server.pid"
        pid_file.write_text("12345")
        state = {"app": "exercise", "status": "ok", "pid": 12345}
        with patch.object(self.launcher, "health", side_effect=[state, None]), patch.object(self.launcher.os, "kill") as kill:
            self.launcher.manage("stop")
        kill.assert_called_once_with(12345, signal.SIGTERM)
        self.assertFalse(pid_file.exists())

    def test_failed_start_does_not_replace_pid_file(self):
        self.launcher.PORT = 12345
        pid_file = self.root / ".runtime/server-12345.pid"
        pid_file.write_text("67890")
        process = Mock(pid=12345)
        process.poll.return_value = 1
        with patch.object(self.launcher, "health", return_value=None), patch.object(self.launcher.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(SystemExit, "Startup failed"):
                self.launcher.manage("start")
        self.assertEqual(pid_file.read_text(), "67890")
        process.wait.assert_called_once()

    def test_invalid_pid_file_is_rejected_without_traceback(self):
        self.launcher.PORT = 4186
        (self.root / ".runtime/server.pid").write_text("not-a-pid")
        state = {"app": "exercise", "status": "ok", "pid": 12345}
        with patch.object(self.launcher, "health", return_value=state), patch.object(self.launcher.os, "kill") as kill:
            with self.assertRaisesRegex(SystemExit, "started elsewhere"):
                self.launcher.manage("stop")
        kill.assert_not_called()

    def test_concurrent_starts_share_one_owned_process(self):
        port = self.free_port()
        command, env = self.command(port, "start")
        processes = [subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        try:
            results = [process.communicate(timeout=20) for process in processes]
            state = self.health(port)
            pid_file = self.root / ".runtime" / f"server-{port}.pid"
            if state and pid_file.exists() and int(pid_file.read_text()) == state["pid"]:
                self.owned[port] = state["pid"]
            self.assertEqual([process.returncode for process in processes], [0, 0], results)
            self.assertIsNotNone(state)
            self.assertEqual(int(pid_file.read_text()), state["pid"])
            self.assertEqual(self.run_launcher(port, "stop").returncode, 0)
            self.assertFalse(pid_file.exists())
            self.assertIsNone(self.health(port))
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.wait()

    def test_distinct_ports_retain_independent_process_ownership(self):
        first = self.free_port()
        second = self.free_port()
        while second == first:
            second = self.free_port()
        for port in (first, second):
            result = self.run_launcher(port, "start")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(int((self.root / ".runtime" / f"server-{port}.pid").read_text()), self.health(port)["pid"])
        self.assertNotEqual(self.owned[first], self.owned[second])
        self.assertEqual(self.run_launcher(first, "stop").returncode, 0)
        self.assertEqual(self.health(second)["pid"], self.owned[second])
        self.assertEqual(self.run_launcher(second, "stop").returncode, 0)
        self.assertIsNone(self.health(first))
        self.assertIsNone(self.health(second))


if __name__ == "__main__":
    unittest.main()
