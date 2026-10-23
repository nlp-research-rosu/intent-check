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

    def respond(self, body, status=200, retry_after=None):
        body = json.dumps(body).encode()
        self.send_response(status)
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
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
        if self.server.poll_failures:
            self.server.poll_failures -= 1
            self.respond({}, self.server.poll_error_status, self.server.retry_after)
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
        self.server.poll_failures = 0
        self.server.poll_error_status = 503
        self.server.retry_after = None
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

    def start_login(self, env=None):
        process = subprocess.Popen([BINARY, "login"], env=env or self.env, cwd=self.root,
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

    def test_poll_errors_are_retried_until_approval(self):
        self.server.poll_failures = 2
        process = self.start_login()
        time.sleep(2.5)
        self.assertIsNone(process.poll())
        self.server.status = "approved"
        self.finish_login(process, "connected", 0)

    def test_rate_limit_waits_retry_after_then_approval_succeeds(self):
        self.server.poll_failures = 1
        self.server.poll_error_status = 429
        self.server.retry_after = 2
        self.server.status = "approved"
        started = time.time()
        self.finish_login(self.start_login(), "connected", 0)
        self.assertGreaterEqual(time.time() - started, 1.8)

    def test_gives_up_after_forty_consecutive_poll_errors(self):
        self.server.poll_failures = 1000
        self.server.poll_error_status = 429
        self.server.retry_after = 0
        process = self.start_login()
        stdout, stderr = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 1, stdout + stderr)
        self.assertEqual(json.loads(stdout)["status"], "failure")
        self.assertFalse((self.data / "credentials.json").exists())

    def test_blank_url_variables_count_as_unset(self):
        env = dict(self.env, INTENT_API_URL="  ", INTENT_CONSOLE_URL="")
        self.server.status = "approved"
        self.finish_login(self.start_login(env), "connected", 0)

    def test_environment_overrides_config_file_and_saved_key(self):
        (self.data / "config.toml").write_text('server_url = "http://127.0.0.1:1"\nportal_url = "http://127.0.0.1:1"\n')
        env = dict(self.env, INTENT_API_URL=self.server.origin, INTENT_CONSOLE_URL=self.server.origin)
        self.server.status = "approved"
        self.finish_login(self.start_login(env), "connected", 0)
        self.assertEqual(json.loads((self.data / "credentials.json").read_text())["keys"][self.server.origin], KEY)
        self.env = dict(env, INTENT_API_KEY="  env-key  ")
        self.cli("health")
        self.assertEqual(self.server.authorization, "Bearer env-key")


if __name__ == "__main__":
    unittest.main()
