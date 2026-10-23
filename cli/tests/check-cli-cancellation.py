#!/usr/bin/env python3
"""Exercise the built CLI against isolated loopback cancellation failures.

Usage: python3 cli/tests/check-cli-cancellation.py /absolute/path/to/intent-check
"""

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from semantics_fixture import IDENTITY, seed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if os.name == "posix":
    import termios


BINARY = Path(sys.argv.pop(1)).resolve()


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, scenario):
        super().__init__(("127.0.0.1", 0), Handler)
        self.scenario = scenario
        self.cancelled = False
        self.polls = 0
        self.requests = []
        self.authorization_headers = []
        self.first_poll = threading.Event()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        self.server.authorization_headers.append((self.path, self.headers.get("Authorization")))
        self.server.requests.append(("GET", self.path))
        if self.path == "/semantics":
            self.respond({"semantics": [IDENTITY]})
        elif self.path.endswith(("/stdout", "/stderr")):
            self.respond("retained server log")
        elif self.path.endswith("/metrics"):
            self.respond({})
        elif self.path == "/tasks/cancel-task":
            status = "running"
            if self.server.cancelled:
                self.server.polls += 1
                scenario = self.server.scenario
                if scenario == "observation_error":
                    self.respond({"message": "controlled status failure"}, 503)
                    return
                if scenario in ("slow_observation", "deadline_observation"):
                    time.sleep(6 if scenario == "deadline_observation" else 2)
                if scenario in ("ordinary", "slow_observation"):
                    status = "cancelled"
                elif scenario == "delayed" and self.server.polls >= 3:
                    status = "cancelled"
                elif scenario in ("completed", "conflict_completed",
                                  "rejected_completed"):
                    status = "completed"
                elif scenario == "failed":
                    status = "failed"
                elif scenario in ("timed_out", "data_expired"):
                    status = scenario
            self.respond({"id": "cancel-task", "status": status, "semantics": IDENTITY,
                          "toolRuns": [{"tool": "kprove",
                                        "exitCode": 0 if status == "completed" else None}],
                          "definitionId": "test-definition",
                          "result": "proved" if status == "completed" else None})
            self.server.first_poll.set()
        else:
            self.respond({"message": "unexpected path"}, 404)

    def do_POST(self):
        self.server.authorization_headers.append((self.path, self.headers.get("Authorization")))
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.server.requests.append(("POST", self.path))
        if self.path == "/proofs":
            self.respond({"id": "cancel-task", "status": "queued", "semantics": IDENTITY}, 202)
        elif self.path == "/tasks/cancel-task/cancel":
            self.server.cancelled = True
            scenario = self.server.scenario
            if scenario in ("rejected", "rejected_completed"):
                self.respond({"code": "cancel-failed",
                              "message": "controlled cancellation failure"}, 500)
            elif scenario == "transport":
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
            elif scenario in ("slow_request", "deadline_request"):
                time.sleep(6 if scenario == "deadline_request" else 2)
                self.respond({"status": "cancelling"}, 202)
            elif scenario.startswith("conflict"):
                self.respond({"message": "task cannot be cancelled"}, 409)
            else:
                # Acceptance alone must never be treated as terminal evidence.
                self.respond({"status": "cancelling"}, 202)
        else:
            self.respond({"message": "unexpected path"}, 404)


@unittest.skipUnless(os.name == "posix", "requires POSIX SIGINT delivery")
class CancellationTests(unittest.TestCase):
    def exercise(self, scenario, terminal_interrupt=False, authenticated=False):
        shared = Path(tempfile.gettempdir()) / "codex-agent-tmp"
        shared.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="codex-cli-cancellation-", dir=shared,
        ) as directory, Server(scenario) as server:
            root = Path(directory)
            config = root / "config/intent-check"
            config.mkdir(parents=True)
            (config / "config.toml").write_text(
                f'server_url = "http://127.0.0.1:{server.server_port}"\n'
                f'request_timeout_seconds = {30 if scenario.startswith("deadline") else 1}\n'
                'poll_interval_seconds = 1\n'
            )
            if authenticated:
                credentials = config / "credentials.json"
                credentials.write_text(json.dumps({"keys": {
                    f"http://127.0.0.1:{server.server_port}": "test-cancellation-key",
                }}))
                credentials.chmod(0o600)
            (root / "spec.k").write_text("module TEST endmodule\n")
            seed(root / "config/intent-check")
            env = dict(os.environ, XDG_CONFIG_HOME=str(root / "config"))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            terminal = None
            try:
                session = subprocess.run(
                    [BINARY, "session", "start", "--semantics", "test"], cwd=root, env=env,
                    capture_output=True, text=True, timeout=5, check=True,
                )
                session_id = json.loads(session.stdout)["sessionId"]
                workspace = Path(json.loads(session.stdout)["workspaceDir"])
                (workspace / "inputs").mkdir()
                (workspace / "inputs/spec.k").write_text("module TEST endmodule\n")
                command = [BINARY, "prove", "--session", session_id,
                           "--semantics", "test", "--spec", "inputs/spec.k",
                           "--spec-module", "TEST"]
                if terminal_interrupt:
                    terminal = os.openpty()
                    settings = termios.tcgetattr(terminal[1])
                    settings[3] &= ~termios.ECHO
                    termios.tcsetattr(terminal[1], termios.TCSANOW, settings)
                    # Give the child its own controlling terminal so a typed
                    # Ctrl-C exercises terminal signal delivery to the CLI.
                    command = [sys.executable, "-c",
                               "import fcntl, os, sys, termios; "
                               "fcntl.ioctl(0, termios.TIOCSCTTY, 0); "
                               "os.execv(sys.argv[1], sys.argv[1:])", *command]
                started = time.monotonic()
                with subprocess.Popen(command, cwd=root, env=env,
                                      stdin=terminal[1] if terminal else None,
                                      start_new_session=True,
                                      stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True) as proc:
                    if terminal:
                        os.close(terminal[1])
                        terminal = (terminal[0],)
                    try:
                        self.assertTrue(server.first_poll.wait(5))
                        if terminal_interrupt:
                            os.write(terminal[0], b"\x03")
                        else:
                            proc.send_signal(signal.SIGINT)
                        stdout, stderr = proc.communicate(timeout=10)
                    finally:
                        if proc.poll() is None:
                            proc.kill()
                            proc.communicate()
                self.assertLess(time.monotonic() - started, 9)
                result = json.loads(stdout)
                evidence = workspace / "proof-001"
                snapshot = json.loads((evidence / "result.json").read_text())
                task = snapshot["task"]
                wait = snapshot["wait"]
                self.assertEqual({p.name for p in evidence.iterdir()},
                                 {"result.json"})
                state = json.loads((config / "sessions" / session_id / "session.json").read_text())
                self.assertEqual(task["id"], "cancel-task")
                self.assertEqual(wait["taskId"], "cancel-task")
                self.assertEqual(wait["reason"], "interrupted")
                self.assertEqual(state["attemptsUsed"], 1)
                for stream in ("stdout", "stderr"):
                    self.assertIn("retained server log", snapshot[stream])
                self.assertEqual(server.requests.count(("POST", "/proofs")), 1)
                self.assertEqual(server.requests.count(("POST", "/tasks/cancel-task/cancel")), 1)
                for path, header in server.authorization_headers:
                    expected = "Bearer test-cancellation-key" if authenticated else None
                    self.assertEqual(header, expected, path)
                text = result.get("message", "") + stderr
                self.assertIn("Interrupted", text)
                self.assertIn("cancel-task", text)
                self.assertIn(str(evidence), text)
                confirmed = scenario in ("ordinary", "delayed")
                self.assertEqual(wait["cancellationConfirmed"], confirmed)
                self.assertEqual(proc.returncode, 1, stdout + stderr)
                if confirmed:
                    self.assertEqual(task["status"], "cancelled")
                elif scenario in ("completed", "conflict_completed"):
                    self.assertEqual(task["result"], "proved")
                    self.assertEqual(task["status"], "completed")
                if scenario in ("rejected", "rejected_completed"):
                    self.assertIn("HTTP 500", text)
                    self.assertIn("cancel-failed: controlled cancellation failure", text)
                if scenario in ("transport", "slow_request", "deadline_request"):
                    self.assertEqual(wait["requestStatus"], "failed")
                    self.assertTrue(wait["requestError"])
                if scenario in ("observation_error", "slow_observation",
                                "deadline_observation"):
                    self.assertTrue(wait["observationError"])
                if scenario in ("pending", "conflict_running", "rejected",
                                "transport", "slow_request", "observation_error",
                                "slow_observation", "deadline_request",
                                "deadline_observation"):
                    self.assertEqual(task["status"], "running")
                    self.assertIn("cancellation not confirmed", text)
                if scenario == "delayed":
                    self.assertEqual(server.polls, 3)
                if scenario in ("timed_out", "data_expired"):
                    self.assertIn(f"task {scenario} during cancellation", text)
                    self.assertNotIn("may still be active", text)
                if scenario.startswith("conflict"):
                    self.assertEqual(wait["requestStatus"], "conflict")
            finally:
                if terminal:
                    for fd in terminal:
                        os.close(fd)
                server.shutdown()
                thread.join(timeout=5)

    def test_authenticated_cancellation(self):
        self.exercise("ordinary", authenticated=True)

    def test_cancellation_outcomes(self):
        for scenario in ("rejected", "transport", "ordinary", "delayed",
                         "pending", "completed", "conflict_completed",
                         "conflict_running", "rejected_completed", "failed", "timed_out", "data_expired",
                         "observation_error", "slow_request", "slow_observation",
                         "deadline_request", "deadline_observation"):
            with self.subTest(scenario=scenario):
                self.exercise(scenario)

    def test_terminal_interrupt(self):
        for scenario in ("rejected", "transport", "ordinary", "delayed",
                         "pending", "completed", "conflict_completed"):
            with self.subTest(scenario=scenario):
                self.exercise(scenario, terminal_interrupt=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
