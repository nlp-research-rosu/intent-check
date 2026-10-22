#!/usr/bin/env python3
"""Exercise browser login, private credential storage and authenticated requests."""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BINARY = Path(sys.argv.pop(1)).resolve()
KEY = "test-clerk-api-key-secret"
DEVICE = "a" * 64


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, body, status=200):
        body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/cli-connect":
            self.respond({}, 404)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if body["action"] == "start":
            self.respond({"device_code": DEVICE, "user_code": "BCDF-GHJK",
                          "expires_in": self.server.expires_in, "interval": 1}, 201)
            return
        if body["device_code"] != DEVICE:
            self.respond({"status": "expired"})
            return
        response = {"status": self.server.status}
        if self.server.status == "approved":
            response["api_key"] = KEY
            self.server.status = "consumed"
        self.respond(response)

    def do_GET(self):
        self.server.authorization = self.headers.get("Authorization")
        self.respond({"status": "ok"})


class LoginTests(unittest.TestCase):
    def setUp(self):
        shared = Path(tempfile.gettempdir()) / "codex-agent-tmp"
        shared.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix="codex-cli-login-", dir=shared)
        self.root = Path(self.tmp.name)
        self.data = self.root / "config/intent-check"
        self.data.mkdir(parents=True)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.server.status = "pending"
        self.server.expires_in = 30
        self.server.authorization = None
        (self.data / "config.toml").write_text(
            f'server_url = "{self.server.origin}"\n'
            f'portal_url = "{self.server.origin}"\n'
            )
        self.env = dict(os.environ, XDG_CONFIG_HOME=str(self.root / "config"))
        self.processes = []
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=5)
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def sanitized(self, output):
        self.assertNotIn(KEY, output)
        self.assertNotIn(DEVICE, output)

    def cli(self, *args):
        result = subprocess.run([BINARY, *args], env=self.env, cwd=self.root,
                                capture_output=True, text=True, timeout=15)
        self.sanitized(result.stdout + result.stderr)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def start_login(self):
        process = subprocess.Popen([BINARY, "login"], env=self.env, cwd=self.root,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        output = queue.Queue()
        reader = threading.Thread(target=lambda: output.put(process.stdout.readline()), daemon=True)
        reader.start()
        line = output.get(timeout=5)
        reader.join(timeout=1)
        self.sanitized(line)
        pending = json.loads(line)
        self.assertEqual(pending["status"], "pending")
        self.assertEqual(pending["verification_url"], f"{self.server.origin}/connect/{pending['user_code']}")
        return process

    def finish_login(self, process, status, code):
        stdout, stderr = process.communicate(timeout=8)
        self.sanitized(stdout + stderr)
        self.assertEqual(process.returncode, code, stdout + stderr)
        self.assertEqual(json.loads(stdout)["status"], status)

    def test_same_command_waits_for_approval_then_saves_the_key(self):
        process = self.start_login()
        time.sleep(.1)
        self.assertIsNone(process.poll())
        self.assertFalse((self.data / "credentials.json").exists())
        self.server.status = "approved"
        self.finish_login(process, "connected", 0)
        credentials = json.loads((self.data / "credentials.json").read_text())
        self.assertEqual(credentials["keys"][self.server.origin], KEY)
        if os.name != "nt":
            self.assertEqual((self.data / "credentials.json").stat().st_mode & 0o777, 0o600)
        self.cli("config")
        self.cli("health")
        self.assertEqual(self.server.authorization, f"Bearer {KEY}")

    def test_denial_and_expiry_finish_without_storing_keys(self):
        self.server.status = "denied"
        process = self.start_login()
        self.finish_login(process, "denied", 1)
        self.assertFalse((self.data / "credentials.json").exists())
        self.server.status = "pending"
        self.server.expires_in = 1
        process = self.start_login()
        self.finish_login(process, "expired", 1)
        self.assertFalse((self.data / "credentials.json").exists())


if __name__ == "__main__":
    unittest.main()
