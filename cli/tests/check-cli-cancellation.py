#!/usr/bin/env python3
"""Check that terminal Ctrl-C cancels a proof and retains its evidence."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from semantics_fixture import IDENTITY, seed

if os.name == "posix":
    import termios

BINARY = Path(sys.argv.pop(1)).resolve()
KEY = "test-cancellation-key"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.server.authorization_headers.append(self.headers.get("Authorization"))
        if self.path == "/semantics":
            self.respond({"semantics": [IDENTITY]})
        elif self.path.endswith(("/stdout", "/stderr")):
            self.respond("retained server log")
        elif self.path.endswith("/metrics"):
            self.respond({})
        elif self.path == "/tasks/cancel-task":
            self.respond({"id": "cancel-task", "semantics": IDENTITY,
                          "status": "cancelled" if self.server.cancelled else "running",
                          "toolRuns": [{"tool": "kprove", "exitCode": None}], "result": None})
            self.server.first_poll.set()
        else:
            self.respond({}, 404)

    def do_POST(self):
        self.server.authorization_headers.append(self.headers.get("Authorization"))
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.server.submissions.append(self.path)
        if self.path == "/proofs":
            self.respond({"id": "cancel-task", "status": "queued", "semantics": IDENTITY}, 202)
        elif self.path == "/tasks/cancel-task/cancel":
            self.server.cancelled = True
            self.respond({"status": "cancelling"}, 202)
        else:
            self.respond({}, 404)


@unittest.skipUnless(os.name == "posix", "requires POSIX terminal Ctrl-C delivery")
class CancellationTests(unittest.TestCase):
    def test_terminal_interrupt_cancels_and_retains_evidence(self):
        with tempfile.TemporaryDirectory(prefix="intent-cancellation-") as directory, \
                ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            root = Path(directory)
            config = root / "config/intent-prover"
            seed(config)
            origin = f"http://127.0.0.1:{server.server_port}"
            (config / "config.toml").write_text(
                f'server_url = "{origin}"\npoll_interval_seconds = 1\n')
            credentials = config / "credentials.json"
            credentials.write_text(json.dumps({"keys": {origin: KEY}}))
            credentials.chmod(0o600)
            server.cancelled = False
            server.submissions = []
            server.authorization_headers = []
            server.first_poll = threading.Event()
            env = dict(os.environ, XDG_CONFIG_HOME=str(root / "config"))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            terminal = None
            try:
                session = subprocess.run([BINARY, "session", "start", "--semantics", "test"],
                                         cwd=root, env=env, capture_output=True, text=True,
                                         timeout=5, check=True)
                session = json.loads(session.stdout)
                workspace = Path(session["workspaceDir"])
                (workspace / "inputs").mkdir()
                (workspace / "inputs/spec.k").write_text("module TEST endmodule\n")
                terminal = os.openpty()
                settings = termios.tcgetattr(terminal[1])
                settings[3] &= ~termios.ECHO
                termios.tcsetattr(terminal[1], termios.TCSANOW, settings)
                command = [sys.executable, "-c",
                           "import fcntl, os, sys, termios; "
                           "fcntl.ioctl(0, termios.TIOCSCTTY, 0); "
                           "os.execv(sys.argv[1], sys.argv[1:])",
                           str(BINARY), "prove", "--session", session["sessionId"],
                           "--spec", "inputs/spec.k", "--spec-module", "TEST"]
                with subprocess.Popen(command, cwd=root, env=env, stdin=terminal[1],
                                      start_new_session=True, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True) as process:
                    os.close(terminal[1])
                    terminal = (terminal[0],)
                    try:
                        self.assertTrue(server.first_poll.wait(5))
                        os.write(terminal[0], b"\x03")
                        stdout, stderr = process.communicate(timeout=10)
                    finally:
                        if process.poll() is None:
                            process.kill()
                            process.communicate(timeout=5)
                self.assertEqual(process.returncode, 1, stdout + stderr)
                result = json.loads(stdout)
                self.assertIn("Interrupted", result.get("message", "") + stderr)
                snapshot = json.loads((workspace / "proof-001/result.json").read_text())
                self.assertEqual(snapshot["task"]["status"], "cancelled")
                self.assertEqual(snapshot["wait"]["reason"], "interrupted")
                self.assertTrue(snapshot["wait"]["cancellationConfirmed"])
                self.assertIn("retained server log", snapshot["stdout"])
                self.assertIn("retained server log", snapshot["stderr"])
                self.assertEqual(server.submissions, ["/proofs", "/tasks/cancel-task/cancel"])
                self.assertTrue(server.authorization_headers)
                self.assertEqual(set(server.authorization_headers), {f"Bearer {KEY}"})
            finally:
                if terminal:
                    for fd in terminal:
                        os.close(fd)
                server.shutdown()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
