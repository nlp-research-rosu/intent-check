#!/usr/bin/env python3
"""Exercise global semantics and explicit sessions against a loopback server."""
import concurrent.futures
from contextlib import contextmanager
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from semantics_fixture import IDENTITY, seed

BINARY = Path(sys.argv.pop(1)).resolve()
KEY = "semantics-test-key"
ARCHIVE_FILES = {"semantics.k": b'requires "lib/core.k"\n',
                 "lib/core.k": b"module CORE endmodule\n",
                 "include/data.bin": bytes(range(256))}


def archive_bytes(identity, files=None):
    output = io.BytesIO()
    root = f'{identity["id"]}_{identity["commit"]}'
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in (ARCHIVE_FILES if files is None else files).items():
            archive.writestr(f"{root}/{name}", content)
    return output.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.server.file_requests.append((self.path, self.headers.get("Authorization")))
        if self.path == "/semantics":
            self.respond({"semantics": [self.server.identity]})
        elif self.path == "/semantics/test/archive":
            self.server.archive_requests.append(self.headers.get("Authorization"))
            if self.headers.get("Authorization") != f"Bearer {KEY}":
                self.respond({}, 401)
                return
            body = self.server.archive_body
            self.send_response(self.server.archive_status)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(body)))
            if self.server.archive_status == 302:
                self.send_header("Location", "/must-not-follow")
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/must-not-follow":
            self.server.redirect_followed = True
            self.respond({})
        elif self.path.startswith("/bucket/"):
            if self.server.bucket_status != 200:
                self.respond({}, self.server.bucket_status)
            elif self.path.endswith("metrics"):
                self.respond(self.server.task_metrics or {})
            else:
                self.respond("log")
        elif self.path.endswith(("stdout", "stderr", "metrics")):
            name = self.path.rsplit("/", 1)[-1]
            status = self.server.metrics_status if name == "metrics" else self.server.log_status
            if status == 302:
                self.send_response(302)
                if self.server.link_location is not None:
                    self.send_header("Location", self.server.link_location + name)
                self.send_header("Content-Length", "0")
                self.end_headers()
            elif status == 204:
                self.send_response(204)
                self.end_headers()
            else:
                self.respond(self.server.task_metrics or {} if name == "metrics" else "log", status)
        else:
            task_id = self.path.rsplit("/", 1)[-1]
            with self.server.changed:
                self.server.task_polls[task_id] = self.server.task_polls.get(task_id, 0) + 1
                status = self.server.task_states.get(task_id, self.server.task_status)
                poll_error = self.server.poll_error or task_id in self.server.task_poll_errors
                self.server.changed.notify_all()
            if poll_error:
                self.respond({"code": "INTERNAL_ERROR", "message": "controlled polling outage"}, 500)
                return
            last_run = {"tool": "kprove" if self.server.has_result else "kompile",
                        "exitCode": None if status == "cancelled" else self.server.exit_code}
            if self.server.tool_outcome is not None:
                last_run["outcome"] = self.server.tool_outcome
            task = {"id": task_id, "status": status,
                    "semantics": self.server.task_identity,
                    "newBackendField": {"retained": True},
                    "toolRuns": self.server.tool_prefix + [last_run],
                    "definitionId": "test-definition",
                    "result": self.server.outcome
                    if self.server.has_result else None}
            self.respond(task)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        if self.path.endswith("/cancel"):
            task_id = self.path.split("/")[-2]
            with self.server.changed:
                self.server.cancel_requests.append(task_id)
                self.server.task_states[task_id] = "cancelled"
                self.server.changed.notify_all()
            self.respond({"status": "cancelling"}, 202)
            return
        with self.server.changed:
            self.server.uploads.append((self.path, body))
            task_id = f"task-{len(self.server.uploads)}"
            self.server.changed.notify_all()
        if self.server.reject:
            self.respond({"code": "UNSUPPORTED_SEMANTICS", "message": "Revision changed"}, 400)
            return
        self.respond({"id": self.server.override_id or task_id, "status": "queued",
                      "semantics": self.server.task_identity}, 202)


class Tests(unittest.TestCase):
    def setUp(self):
        shared = Path(tempfile.gettempdir()) / "codex-agent-tmp"
        shared.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix="codex-sessions-", dir=shared)
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / "project"
        self.root.mkdir()
        self.data = self.base / "config/intent-check"
        self.source = seed(self.data)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.identity = dict(IDENTITY)
        self.server.task_identity = {key: IDENTITY[key] for key in ("id", "commit")}
        self.server.archive_requests = []
        self.server.archive_status = 200
        self.server.archive_body = archive_bytes(IDENTITY)
        self.server.redirect_followed = False
        self.server.task_status = "completed"
        self.server.has_result = True
        self.server.uploads = []
        self.server.mutex = threading.Lock()
        self.server.changed = threading.Condition(self.server.mutex)
        self.server.task_states = {}
        self.server.task_polls = {}
        self.server.task_poll_errors = set()
        self.server.cancel_requests = []
        self.server.poll_error = False
        self.server.reject = False
        self.server.exit_code = 0
        self.server.tool_outcome = None
        self.server.tool_prefix = [{"tool": "kompile", "exitCode": 0}]
        self.server.outcome = "proved"
        self.server.override_id = None
        self.server.task_metrics = None
        self.server.file_requests = []
        self.server.log_status = 302
        self.server.metrics_status = 200
        self.server.bucket_status = 200
        self.server.link_location = f"http://127.0.0.1:{self.server.server_port}/bucket/"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        config = self.base / "config/intent-check"
        config.mkdir(parents=True, exist_ok=True)
        self.config = config / "config.toml"
        self.config.write_text(
            f'server_url = "http://127.0.0.1:{self.server.server_port}"\n'
            'poll_interval_seconds = 1\n')
        self.env = dict(os.environ, XDG_CONFIG_HOME=str(self.base / "config"))
        (self.root / "program.mpy").write_text("pass\n")
        self.session = self.start()
        self.workspace = Path(self.session["workspaceDir"])

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def cli(self, *args, code=0, project=None):
        result = subprocess.run([BINARY, *args], cwd=project or self.root,
                                env=self.env, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def start(self, project=None):
        session = self.cli("session", "start", "--semantics", "test", project=project)
        (Path(session["workspaceDir"]) / "inputs").mkdir()
        (Path(session["workspaceDir"]) / "inputs/spec.k").write_text("module SPEC endmodule\n")
        return session

    def operation(self, command, session=None, code=0, extra=(), project=None):
        session = session or self.session
        args = (["--program", "program.mpy"] if command == "run" else
                ["--spec", "inputs/spec.k", "--spec-module", "SPEC"])
        return self.cli(command, "--session", session["sessionId"], *args, *extra,
                        code=code, project=project)

    def show(self, session=None):
        return self.cli("session", "show", (session or self.session)["sessionId"])

    @contextmanager
    def pending_operations(self):
        processes = []

        def launch(command="prove", extra=()):
            args = (["--program", "program.mpy"] if command == "run" else
                    ["--spec", "inputs/spec.k", "--spec-module", "SPEC"])
            process = subprocess.Popen(
                [BINARY, command, "--session", self.session["sessionId"], *args, *extra],
                cwd=self.root, env=self.env, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True)
            processes.append(process)
            return process

        try:
            yield launch
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)

    def wait_for_task(self, task_id):
        with self.server.changed:
            self.assertTrue(self.server.changed.wait_for(
                lambda: self.server.task_polls.get(task_id, 0) > 0, timeout=5),
                f"{task_id} was not submitted and polled while its sibling was running")

    def finish_operation(self, process, code=0):
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, code, stdout + stderr)
        return json.loads(stdout)

    def enable_archive_download(self):
        shutil.rmtree(self.source)
        origin = f"http://127.0.0.1:{self.server.server_port}"
        credentials = self.data / "credentials.json"
        credentials.write_text(json.dumps({"keys": {origin: KEY}}))
        credentials.chmod(0o600)

    def test_authenticated_archive_preserves_all_files_and_reuses_cache(self):
        self.enable_archive_download()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.cli("semantics", "fetch", "test"), range(4)))
        self.assertEqual(self.server.archive_requests, [f"Bearer {KEY}"])
        self.assertEqual({r["sourceDir"] for r in results}, {str(self.source)})
        actual = {str(p.relative_to(self.source)): p.read_bytes()
                  for p in self.source.rglob("*") if p.is_file()}
        self.assertEqual(actual, ARCHIVE_FILES)
        self.assertEqual(self.show()["semantics"], IDENTITY)
        self.assertEqual(list(self.source.parent.glob(".download-*")), [])

    def test_archive_accepts_sources_without_semantics_k(self):
        self.enable_archive_download()
        self.server.archive_body = archive_bytes(IDENTITY, {"driver.md": b"module EVM"})
        result = self.cli("semantics", "fetch", "test")
        self.assertIsNone(result["entryFile"])
        self.assertEqual((self.source / "driver.md").read_bytes(), b"module EVM")

    def test_archive_rejects_symlink_entries(self):
        self.enable_archive_download()
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            link = zipfile.ZipInfo(f'test_{IDENTITY["commit"]}/link')
            link.create_system = 3
            link.external_attr = 0o120777 << 16
            archive.writestr(link, "../../outside")
        self.server.archive_body = output.getvalue()
        result = self.cli("semantics", "fetch", "test", code=1)
        self.assertIn("Unsupported entry", result["message"])
        self.assertFalse(self.source.exists())

    def test_archive_failures_do_not_cache_or_fall_back(self):
        self.enable_archive_download()
        for status in (401, 403, 404, 500, 302):
            with self.subTest(status=status):
                self.server.archive_status = status
                result = self.cli("semantics", "fetch", "test", code=1)
                self.assertIn(str(status), result["message"])
                self.assertNotIn(KEY, json.dumps(result))
                self.assertFalse(self.source.exists())
                self.assertEqual(list(self.source.parent.glob(".download-*")), [])
        self.assertEqual(len(self.server.archive_requests), 5)
        self.assertFalse(self.server.redirect_followed)

    def test_archive_requires_saved_credential(self):
        shutil.rmtree(self.source)
        result = self.cli("semantics", "fetch", "test", code=1)
        self.assertIn("401", result["message"])
        self.assertFalse(self.source.exists())

    def test_archive_rejects_corruption_revision_changes_and_unsafe_paths(self):
        self.enable_archive_download()
        for body in (b"not a ZIP", archive_bytes(dict(IDENTITY, commit="b" * 12)),
                     archive_bytes(IDENTITY, {"../../escaped.k": b"bad"}),
                     archive_bytes(IDENTITY, {})):
            with self.subTest(size=len(body)):
                self.server.archive_body = body
                self.cli("semantics", "fetch", "test", code=1)
                self.assertFalse(self.source.exists())
                self.assertEqual(list(self.source.parent.glob(".download-*")), [])
        self.assertFalse((self.source.parent / "escaped.k").exists())
        self.server.archive_body = archive_bytes(IDENTITY)
        self.cli("semantics", "fetch", "test")

    def test_global_metadata_local_workspace(self):
        self.assertEqual(self.workspace, self.root / ".intent/prove/sessions" / self.session["sessionId"])
        self.assertEqual(self.session["projectRoot"], str(self.root))
        self.assertEqual(self.session["semantics"], IDENTITY)
        stored = json.loads((self.data / "sessions" / self.session["sessionId"] / "session.json").read_text())
        self.assertEqual(set(stored), {"sessionId", "projectRoot", "semantics",
                                      "attemptsUsed", "validationsUsed", "runsUsed"})
        self.assertEqual(self.session, dict(stored, workspaceDir=str(self.workspace)))
        self.assertEqual(self.show(), self.session)

    def test_fetch_shared_between_projects_and_sessions(self):
        other = self.base / "other"
        other.mkdir()
        second = self.start(project=other)
        result = self.cli("semantics", "fetch", "test", project=other)
        self.assertEqual(result["sourceDir"], str(self.source))
        self.assertEqual(second["semantics"], self.session["semantics"])
        self.assertFalse((other / ".intent/prove/semantics").exists())
        self.assertTrue(Path(result["entryFile"]).is_file())

    def test_unknown_id_preserves_sessions(self):
        result = self.cli("semantics", "fetch", "unknown", code=1)
        self.assertIn("Unknown", result["message"])
        self.assertEqual(self.show(), self.session)

    def test_all_submissions_send_pin_and_retain_results(self):
        for command in ("run", "validate", "prove"):
            self.server.outcome = {"run": "success", "validate": "valid", "prove": "proved"}[command]
            result = self.operation(command)
            evidence = Path(result["evidenceDir"])
            self.assertEqual({p.name for p in evidence.iterdir()},
                             {"result.json"})
            kind = {"run": "run", "validate": "validation", "prove": "proof"}[command]
            self.assertEqual(evidence.name, f"{kind}-001")
            snapshot = json.loads((evidence / "result.json").read_text())
            self.assertEqual(set(snapshot), {"task", "stdout", "stderr", "metrics"})
            self.assertEqual(snapshot["metrics"], {})
            self.assertEqual(snapshot["task"]["result"], self.server.outcome)
            self.assertEqual(snapshot["task"]["definitionId"], "test-definition")
            self.assertEqual(snapshot["stdout"], '"log"')
            self.assertEqual(snapshot["stderr"], '"log"')
            self.assertEqual(snapshot["task"]["status"], "completed")
            self.assertEqual(result["task"], snapshot["task"])
            self.assertEqual(set(result), {"task", "sessionId", "budget", "evidenceDir"})
            self.assertTrue(evidence.is_relative_to(self.workspace))
            self.assertFalse((evidence / "inputs").exists())
            self.assertFalse((evidence / "request.json").exists())
        self.assertEqual([p for p, _ in self.server.uploads], ["/runs", "/proof-dry-runs", "/proofs"])
        for _, body in self.server.uploads:
            self.assertIn('name="semanticsCommit"\r\n\r\n' + IDENTITY["commit"], body)
            self.assertIn('name="semanticsId"\r\n\r\ntest', body)
            self.assertNotIn('name="timeout"', body)
        self.assertEqual(self.show()["attemptsUsed"], 1)
        self.assertEqual(self.show()["validationsUsed"], 1)

    def test_obsolete_timeout_settings_are_ignored(self):
        with self.config.open("a") as config:
            config.write('task_timeout_seconds = 0\nproof_timeout_seconds = 0\n')
        effective = self.cli("config")["config"]
        self.assertNotIn("task_timeout_seconds", effective)
        self.assertNotIn("proof_timeout_seconds", effective)
        for command in ("run", "validate", "prove"):
            self.operation(command)
            self.assertNotIn('name="timeout"', self.server.uploads[-1][1])

    def test_queue_and_execution_wait_for_server_without_local_deadline(self):
        with self.config.open("a") as config:
            config.write('task_timeout_seconds = 1\nproof_timeout_seconds = 1\n')
        self.server.task_status = "queued"
        with self.pending_operations() as launch:
            processes = [launch(command) for command in ("run", "validate", "prove")]
            for phase, polls in (("queued", 3), ("running", 4)):
                with self.server.changed:
                    self.server.task_status = phase
                    self.server.task_polls.clear()
                    self.assertTrue(self.server.changed.wait_for(
                        lambda: len(self.server.task_polls) == 3 and
                        all(count >= polls for count in self.server.task_polls.values()),
                        timeout=8), (phase, self.server.task_polls))
                    self.assertEqual(self.server.cancel_requests, [])
                self.assertTrue(all(process.poll() is None for process in processes))
            self.server.task_status = "completed"
            for process in processes:
                result = self.finish_operation(process)
                self.assertEqual(result["task"]["status"], "completed")
                saved = json.loads((Path(result["evidenceDir"]) / "result.json").read_text())
                self.assertNotIn("wait", saved)
        self.assertEqual(self.server.cancel_requests, [])

    def test_signed_downloads_never_forward_credentials(self):
        origin = f"http://127.0.0.1:{self.server.server_port}"
        credentials = self.data / "credentials.json"
        credentials.write_text(json.dumps({"keys": {origin: KEY}}))
        credentials.chmod(0o600)
        self.server.metrics_status = 302
        self.server.task_metrics = {"SPEC.entry": {"leaves": [], "nodeCount": 2,
                                                 "splitCount": 0, "longestPathLength": 1}}
        for host in ("127.0.0.1", "localhost"):
            with self.subTest(host=host):
                self.server.file_requests.clear()
                self.server.link_location = f"http://{host}:{self.server.server_port}/bucket/"
                result = self.operation("prove")
                snapshot = json.loads((Path(result["evidenceDir"]) / "result.json").read_text())
                self.assertEqual(snapshot["stdout"], '"log"')
                self.assertEqual(snapshot["stderr"], '"log"')
                self.assertEqual(snapshot["metrics"], self.server.task_metrics)
                self.assertEqual({path for path, _ in self.server.file_requests
                                  if path.startswith("/bucket/")},
                                 {"/bucket/stdout", "/bucket/stderr", "/bucket/metrics"})
                for path, header in self.server.file_requests:
                    self.assertEqual(header, None if path.startswith("/bucket/") else f"Bearer {KEY}")

    def test_empty_logs_and_expired_files_preserve_task_outcome(self):
        for status in (204, 410):
            with self.subTest(status=status):
                self.server.log_status = status
                self.server.metrics_status = 200 if status == 204 else 410
                result = self.operation("prove")
                snapshot = json.loads((Path(result["evidenceDir"]) / "result.json").read_text())
                self.assertEqual(snapshot["task"]["result"], "proved")
                if status == 204:
                    self.assertEqual(snapshot["stdout"], "")
                    self.assertEqual(snapshot["stderr"], "")
                    self.assertEqual(snapshot["metrics"], {})
                else:
                    self.assertIn("410", snapshot["stdout"])
                    self.assertIn("410", snapshot["stderr"])
                    self.assertIn("410", snapshot["metricsError"])
                    self.assertNotIn("metrics", snapshot)

    def test_broken_file_links_preserve_task_and_report_download_errors(self):
        self.server.metrics_status = 302
        for missing_location in (True, False):
            with self.subTest(missing_location=missing_location):
                self.server.link_location = (None if missing_location else
                    f"http://127.0.0.1:{self.server.server_port}/bucket/")
                self.server.bucket_status = 403
                result = self.operation("prove")
                snapshot = json.loads((Path(result["evidenceDir"]) / "result.json").read_text())
                self.assertEqual(snapshot["task"]["result"], "proved")
                for field in ("stdout", "stderr", "metricsError"):
                    self.assertIn("Location" if missing_location else "403", snapshot[field])

    def test_timeout_override_is_rejected_without_submitting(self):
        for command in ("run", "validate", "prove"):
            args = (["--program", "program.mpy"] if command == "run" else
                    ["--spec", "inputs/spec.k", "--spec-module", "SPEC"])
            result = subprocess.run(
                [BINARY, command, "--session", self.session["sessionId"],
                 *args, "--task-timeout", "7200"], cwd=self.root, env=self.env,
                capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("unexpected argument '--task-timeout'", result.stderr)
        self.assertEqual(self.server.uploads, [])
        session = self.show()
        for counter in ("attemptsUsed", "validationsUsed", "runsUsed"):
            self.assertEqual(session[counter], 0)

    def test_running_metrics_refresh_evidence_before_completion(self):
        self.server.metrics_status = 302
        self.server.task_status = "running"
        self.server.has_result = False
        self.server.task_metrics = {"SPEC.entry": {
            "nodeCount": 1, "splitCount": 0, "longestPathLength": 0,
            "leaves": [{"node": 1, "statuses": ["pending"],
                        "coversGoal": False, "conditions": []}]}}
        command = [BINARY, "prove", "--session", self.session["sessionId"],
                   "--spec", "inputs/spec.k", "--spec-module", "SPEC"]
        process = subprocess.Popen(command, cwd=self.root, env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True)
        evidence = self.workspace / "proof-001/result.json"
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if evidence.exists():
                    snapshot = json.loads(evidence.read_text())
                    if snapshot.get("metrics") == self.server.task_metrics:
                        break
                time.sleep(0.05)
            else:
                self.fail("live proof metrics were not saved during polling")
            self.assertEqual(snapshot["task"]["status"], "running")
            self.server.task_status = "completed"
            self.server.has_result = True
            self.server.task_metrics = {"SPEC.entry": {
                "nodeCount": 2, "splitCount": 0, "longestPathLength": 1,
                "leaves": [{"node": 2, "statuses": ["terminal"],
                            "coversGoal": True, "conditions": []}]}}
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stdout + stderr)
            result = json.loads(stdout)
            self.assertNotIn("metrics", result["task"])
            self.assertEqual(json.loads(evidence.read_text())["metrics"], self.server.task_metrics)
            self.assertEqual(json.loads(evidence.read_text())["task"], result["task"])
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)

    def test_metrics_download_failure_retains_last_successful_snapshot(self):
        self.server.task_status = "running"
        self.server.has_result = False
        self.server.task_metrics = {"SPEC.entry": {"leaves": [], "nodeCount": 2,
                                                 "splitCount": 0, "longestPathLength": 1}}
        evidence = self.workspace / "proof-001/result.json"
        with self.pending_operations() as launch:
            process = launch()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if evidence.exists() and json.loads(evidence.read_text()).get("metrics"):
                    break
                time.sleep(0.05)
            else:
                self.fail("metrics snapshot was not saved")
            self.server.metrics_status = 503
            self.server.task_status = "completed"
            self.server.has_result = True
            result = self.finish_operation(process)
        snapshot = json.loads(evidence.read_text())
        self.assertEqual(snapshot["task"], result["task"])
        self.assertEqual(snapshot["metrics"], self.server.task_metrics)
        self.assertIn("503", snapshot["metricsError"])

    def test_operation_sequences_preserve_previous_evidence(self):
        for command, kind in (("run", "run"), ("validate", "validation"), ("prove", "proof")):
            first = Path(self.operation(command)["evidenceDir"])
            before = (first / "result.json").read_bytes()
            second = Path(self.operation(command)["evidenceDir"])
            self.assertEqual(first.name, f"{kind}-001")
            self.assertEqual(second.name, f"{kind}-002")
            self.assertEqual((first / "result.json").read_bytes(), before)
        self.assertEqual(self.show()["runsUsed"], 2)

    def test_existing_session_can_start_numbered_runs(self):
        path = self.data / "sessions" / self.session["sessionId"] / "session.json"
        stored = json.loads(path.read_text())
        del stored["runsUsed"]
        path.write_text(json.dumps(stored))
        result = self.operation("run")
        self.assertEqual(Path(result["evidenceDir"]).name, "run-001")
        self.assertEqual(self.show()["runsUsed"], 1)

    def test_rejected_submission_does_not_consume_attempt(self):
        self.server.reject = True
        result = self.operation("prove", code=1)
        self.assertIn("UNSUPPORTED_SEMANTICS", result["message"])
        self.assertEqual(self.show()["attemptsUsed"], 0)
        self.server.reject = False
        self.operation("prove")
        self.assertTrue((self.workspace / "proof-001/result.json").is_file())

    def test_raw_exit_codes_and_response_fields_for_every_command(self):
        for command in ("run", "validate", "prove"):
            self.config.write_text(self.config.read_text() +
                                  f"max_{ {'run': 'run', 'validate': 'validation', 'prove': 'proof'}[command] }_attempts = 10\n")
            # Outcome disagrees with zero deliberately: classification
            # belongs to the backend, not the CLI.
            self.server.outcome = "futureOutcome"
            for code in (0, 1, 10, 20, 42, 113):
                with self.subTest(command=command, code=code):
                    self.server.exit_code = code
                    result = self.operation(command, code=code)
                    task = result["task"]
                    self.assertEqual(task["status"], "completed")
                    self.assertEqual(task["toolRuns"][-1]["exitCode"], code)
                    self.assertEqual(task["result"], "futureOutcome")
                    self.assertEqual(task["newBackendField"], {"retained": True})
                    saved = json.loads((Path(result["evidenceDir"]) / "result.json").read_text())
                    self.assertEqual(saved["task"], task)

    def test_missing_exit_code_and_failed_tasks_keep_backend_response(self):
        self.server.exit_code = None
        for command in ("run", "validate", "prove"):
            for status in ("completed", "failed", "cancelled", "data_expired"):
                self.server.task_status = status
                self.server.has_result = status == "completed"
                result = self.operation(command, code=1)
                self.assertIsNone(result["exitCode"])
                self.assertEqual(result["error"], "Backend did not provide a final tool exit code.")
                saved = json.loads((Path(result["evidenceDir"]) / "result.json").read_text())
                self.assertEqual(saved["task"], result["task"])
                self.assertEqual(result["task"]["status"], status)
                self.assertEqual(result["budget"]["used"],
                                 ("completed", "failed", "cancelled", "data_expired").index(status) + 1)

    def test_task_timeout_reports_backend_reason_for_every_command(self):
        self.server.exit_code = None
        self.server.task_status = "timed_out"
        self.server.has_result = False
        for command in ("run", "validate", "prove"):
            result = self.operation(command, code=1)
            self.assertIsNone(result["exitCode"])
            self.assertEqual(result["error"], "Prover task timed out.")
            self.assertEqual(result["task"]["status"], "timed_out")
            self.assertIsNone(result["task"]["result"])
            self.assertEqual(self.server.cancel_requests, [])
            saved = json.loads((Path(result["evidenceDir"]) / "result.json").read_text())
            self.assertEqual(saved["task"], result["task"])

    def test_cached_execution_and_compilation_failure(self):
        self.server.tool_prefix = []
        self.operation("prove")
        self.server.has_result = False
        self.server.task_status = "failed"
        self.server.exit_code = 113
        result = self.operation("validate", code=113)
        self.assertIsNone(result["task"]["result"])

    def test_polling_error_preserves_evidence_and_counts_attempt(self):
        self.server.poll_error = True
        result = self.operation("validate", code=1)
        self.assertIn("controlled polling outage", result["message"])
        self.assertNotIn("mismatched", result["message"])
        self.assertTrue((self.workspace / "validation-001/result.json").is_file())
        self.assertEqual(self.show()["validationsUsed"], 1)

    def test_semantics_metadata_and_module_names_are_not_interpreted(self):
        metadata = self.source / "semantics.json"
        for content in (None, "not valid JSON", '{"mainModule":"LANG"}'):
            if content is not None:
                metadata.write_text(content)
            self.cli("semantics", "fetch", "test")
            (self.workspace / "inputs/spec.k").write_text("module LANG endmodule\n")
            self.operation("validate")
        self.assertEqual(len(self.server.uploads), 3)

    def test_task_identity_mismatch_retains_evidence(self):
        self.server.task_identity["commit"] = "b" * 12
        result = self.operation("validate", code=1)
        self.assertIn("mismatched", result["message"])
        self.assertTrue((self.workspace / "validation-001/result.json").is_file())

    def test_wrong_semantics_assertion(self):
        result = self.operation("run", code=1, extra=("--semantics", "other"))
        self.assertIn("differs", result["message"])
        self.assertEqual(self.server.uploads, [])

    def test_new_session_fresh_budgets_preserves_previous_session(self):
        self.operation("prove")
        self.operation("validate")
        new = self.start()
        self.assertNotEqual(new["sessionId"], self.session["sessionId"])
        self.assertEqual(new["attemptsUsed"], 0)
        self.assertEqual(new["validationsUsed"], 0)
        self.assertEqual(self.show()["attemptsUsed"], 1)
        self.assertEqual(self.show()["validationsUsed"], 1)
        self.assertTrue((self.workspace / "proof-001/result.json").exists())

    def test_proof_and_validation_limits_independent(self):
        self.config.write_text(self.config.read_text() +
                               'max_proof_attempts = 3\nmax_validation_attempts = 3\n')
        self.server.outcome = "notProved"
        self.server.exit_code = 1
        for code in (1, 1, 1, 20):
            self.operation("prove", code=code)
        self.assertEqual(len(self.server.uploads), 3)
        self.assertEqual(self.show()["validationsUsed"], 0)
        other = self.start()
        self.server.valid = False
        for code in (1, 1, 1, 20):
            self.operation("validate", session=other, code=code)
        self.operation("prove", session=other, code=1)
        self.assertEqual(len(self.server.uploads), 7)
        self.assertEqual(self.show(other)["attemptsUsed"], 1)

    def test_run_limit_counts_failures_and_is_independent(self):
        self.config.write_text(self.config.read_text() + 'max_run_attempts = 3\n')
        self.server.exit_code = 1
        for used, code in ((1, 1), (2, 1), (3, 1), (3, 20)):
            result = self.operation("run", code=code)
            self.assertEqual(result["budget"], {"used": used, "limit": 3, "remaining": 3-used})
        self.assertEqual(len(self.server.uploads), 3)
        self.assertEqual(self.show()["runsUsed"], 3)
        self.assertEqual(self.show()["attemptsUsed"], 0)
        self.assertEqual(self.show()["validationsUsed"], 0)
        self.server.exit_code = 0
        self.operation("validate")
        self.operation("prove")

    def test_run_limit_reloads_config_and_preserves_final_success(self):
        self.config.write_text(self.config.read_text() + "max_run_attempts = 1\n")
        result = self.operation("run")
        self.assertEqual(result["task"]["status"], "completed")
        self.assertEqual(result["budget"], {"used": 1, "limit": 1, "remaining": 0})
        self.operation("run", code=20)
        self.assertEqual(len(self.server.uploads), 1)
        self.config.write_text(self.config.read_text().replace("max_run_attempts = 1", "max_run_attempts = 2"))
        self.operation("run")
        self.assertEqual(self.show()["runsUsed"], 2)
        self.config.write_text(self.config.read_text().replace("max_run_attempts = 2", "max_run_attempts = 0"))
        self.operation("run", code=1)
        self.assertEqual(len(self.server.uploads), 2)

    def test_rejected_submission_does_not_count_but_polling_failure_does(self):
        for command, counter, prefix in (("run", "runsUsed", "run"),
                                         ("validate", "validationsUsed", "validation"),
                                         ("prove", "attemptsUsed", "proof")):
            with self.subTest(command=command):
                self.server.poll_error = False
                self.server.reject = True
                self.operation(command, code=1)
                self.assertEqual(self.show()[counter], 0)
                self.server.reject = False
                self.server.poll_error = True
                self.operation(command, code=1)
                self.assertEqual(self.show()[counter], 1)
                self.assertTrue((self.workspace / f"{prefix}-001/result.json").is_file())

    def test_concurrent_runs_serialize_limit(self):
        self.config.write_text(self.config.read_text() + 'max_run_attempts = 3\n')
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: self.operation("run"), range(3)))
        self.assertEqual({r["budget"]["used"] for r in results}, {1, 2, 3})
        self.operation("run", code=20)
        self.assertEqual(len(self.server.uploads), 3)

    def test_valid_final_validation_allows_proof(self):
        self.config.write_text(self.config.read_text() + 'max_validation_attempts = 3\n')
        for _ in range(3):
            self.operation("validate")
        self.operation("prove")
        self.operation("validate", code=20)

    def test_limits_are_read_from_config_each_time(self):
        self.operation("prove")
        self.config.write_text(self.config.read_text() + 'max_proof_attempts = 1\n')
        self.operation("prove", code=20)
        self.assertEqual(self.show()["attemptsUsed"], 1)
        self.config.write_text(self.config.read_text().replace("max_proof_attempts = 1", "max_proof_attempts = 5"))
        self.operation("prove")
        self.assertEqual(self.show()["attemptsUsed"], 2)
        self.assertEqual(self.cli("config")["config"]["max_proof_attempts"], 5)

    def test_fetch_new_revision_does_not_repin_existing_session(self):
        updated = dict(IDENTITY, commit="b" * 12)
        new_source = self.source.parent / updated["commit"]
        shutil.copytree(self.source, new_source)
        self.server.identity = updated
        result = self.cli("semantics", "fetch", "test")
        self.assertEqual(result["semantics"], updated)
        self.assertEqual(self.show()["semantics"], IDENTITY)
        self.assertEqual(self.start()["semantics"], updated)
        self.operation("prove")
        self.assertIn(IDENTITY["commit"], self.server.uploads[-1][1])

    def test_arbitrary_cwd_and_project_assertion(self):
        other = self.base / "elsewhere"
        other.mkdir()
        self.operation("prove", project=other)
        result = self.operation("prove", code=1, extra=("--project", str(other)))
        self.assertIn("does not match", result["message"])
        self.operation("prove", extra=("--project", str(self.root)))

    def test_multifile_upload_and_input_boundaries(self):
        (self.workspace / "inputs/lib").mkdir(parents=True)
        (self.workspace / "inputs/spec.k").write_text('requires "verification.k"\nmodule SPEC endmodule\n')
        (self.workspace / "inputs/verification.k").write_text('requires "semantics.k"\nrequires "lib/helper.k"\nmodule VERIFICATION endmodule\n')
        (self.workspace / "inputs/lib/helper.k").write_text("module HELPER endmodule\n")
        for operation in ("validate", "prove"):
            self.cli(operation, "--session", self.session["sessionId"],
                     "--spec", "inputs/spec.k", "--spec-module", "SPEC",
                     "--verification", "inputs/verification.k",
                     "--verification-module", "VERIFICATION",
                     "--source", "inputs/lib/helper.k")
            body = self.server.uploads[-1][1]
            for path in ("spec.k", "verification.k", "lib/helper.k"):
                self.assertIn(f'name="specFile[{path}]"', body)
            self.assertNotIn("name*=", body)
            self.assertNotIn("inputs/", body)
            self.assertIn('name="specEntryFile"\r\n\r\nspec.k', body)
            self.assertIn('name="verificationEntryFile"\r\n\r\nverification.k', body)
            for path in ("spec.k", "verification.k", "lib/helper.k"):
                self.assertIn((self.workspace / "inputs" / path).read_text(), body)
        result = self.operation("prove", code=1, extra=("--source", str(self.root / "program.mpy")))
        self.assertIn("escapes", result["message"])
        self.assertEqual(self.show()["attemptsUsed"], 1)

    def test_proof_inputs_reject_workspace_files_and_symlink_escapes(self):
        outside = self.workspace / "outside.k"
        outside.write_text("module OUTSIDE endmodule\n")
        (self.workspace / "inputs/link.k").symlink_to(outside)
        for operation in ("validate", "prove"):
            for flag in ("--spec", "--verification", "--source"):
                for path in ("outside.k", "inputs/link.k"):
                    extra = (flag, path)
                    if flag == "--verification":
                        extra += ("--verification-module", "OUTSIDE")
                    if flag == "--spec":
                        result = self.cli(operation, "--session", self.session["sessionId"],
                                          "--spec", path, "--spec-module", "OUTSIDE", code=1)
                    else:
                        result = self.operation(operation, code=1, extra=extra)
                    self.assertIn("escapes session inputs", result["message"])
        self.assertEqual(self.server.uploads, [])
        self.assertEqual(self.show()["attemptsUsed"], 0)
        self.assertEqual(self.show()["validationsUsed"], 0)

    def test_upload_rejects_header_characters(self):
        for name in ('bad"name.k', 'bad\rname.k', 'bad\nname.k'):
            (self.workspace / "inputs" / name).write_text("module HELPER endmodule\n")
            result = self.operation("prove", code=1, extra=("--source", "inputs/" + name))
            self.assertIn("Unsupported characters in upload path", result["message"])
        self.assertEqual(self.server.uploads, [])

    def test_concurrent_sessions_and_fetches(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.start(), range(4)))
            fetches = list(pool.map(lambda _: self.cli("semantics", "fetch", "test"), range(4)))
        self.assertEqual(len({r["sessionId"] for r in results}), 4)
        self.assertEqual({r["sourceDir"] for r in fetches}, {str(self.source)})

    def test_concurrent_proofs_share_budget(self):
        self.config.write_text(self.config.read_text() + 'max_proof_attempts = 3\n')
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: self.operation("prove"), range(3)))
        self.assertEqual({r["budget"]["used"] for r in results}, {1, 2, 3})
        self.operation("prove", code=20)

    def test_proofs_overlap_and_complete_out_of_order(self):
        self.config.write_text(self.config.read_text() + 'max_proof_attempts = 3\n')
        self.server.task_status = "running"
        with self.pending_operations() as launch:
            processes = []
            for attempt in range(1, 4):
                processes.append(launch(extra=("--claim", f"SPEC.job-{attempt}")))
                self.wait_for_task(f"task-{attempt}")
            self.assertEqual(self.show()["attemptsUsed"], 3)
            self.operation("prove", code=20)
            self.assertEqual(len(self.server.uploads), 3)
            for attempt in range(1, 4):
                evidence = self.workspace / f"proof-{attempt:03}/result.json"
                self.assertEqual(json.loads(evidence.read_text())["task"]["id"], f"task-{attempt}")
                self.assertIn(f'SPEC.job-{attempt}', self.server.uploads[attempt - 1][1])
            for attempt in (3, 1, 2):
                with self.server.changed:
                    self.server.task_states[f"task-{attempt}"] = "completed"
                result = self.finish_operation(processes[attempt - 1])
                self.assertEqual(result["task"]["id"], f"task-{attempt}")
                self.assertEqual(result["budget"], {"used": attempt, "limit": 3,
                                                   "remaining": 3 - attempt})
                evidence = Path(result["evidenceDir"])
                self.assertEqual(evidence.name, f"proof-{attempt:03}")
                self.assertEqual(json.loads((evidence / "result.json").read_text())["task"],
                                 result["task"])
                self.assertEqual(self.show()["attemptsUsed"], 3)

    def test_run_validation_and_proof_overlap(self):
        self.server.task_status = "running"
        with self.pending_operations() as launch:
            processes = []
            for index, command in enumerate(("run", "validate", "prove"), 1):
                processes.append(launch(command))
                self.wait_for_task(f"task-{index}")
            state = self.show()
            for counter in ("runsUsed", "validationsUsed", "attemptsUsed"):
                self.assertEqual(state[counter], 1)
            with self.server.changed:
                self.server.task_status = "completed"
            results = [self.finish_operation(process) for process in processes]
            self.assertEqual({Path(result["evidenceDir"]).name for result in results},
                             {"run-001", "validation-001", "proof-001"})
            self.assertEqual({result["task"]["id"] for result in results},
                             {"task-1", "task-2", "task-3"})

    def test_racing_submissions_do_not_exceed_limits(self):
        self.config.write_text(self.config.read_text() +
                               'max_run_attempts = 3\nmax_validation_attempts = 3\n'
                               'max_proof_attempts = 3\n')
        for command, counter in (("run", "runsUsed"), ("validate", "validationsUsed"),
                                 ("prove", "attemptsUsed")):
            with self.subTest(command=command), self.pending_operations() as launch:
                with self.server.changed:
                    start = len(self.server.uploads)
                    self.server.task_status = "running"
                processes = [launch(command) for _ in range(6)]
                self.wait_for_task(f"task-{start + 3}")
                with self.server.changed:
                    self.assertEqual(len(self.server.uploads), start + 3)
                    self.server.task_status = "completed"
                results = []
                codes = []
                for process in processes:
                    stdout, stderr = process.communicate(timeout=10)
                    self.assertIn(process.returncode, (0, 20), stdout + stderr)
                    results.append(json.loads(stdout))
                    codes.append(process.returncode)
                self.assertEqual(codes.count(0), 3)
                self.assertEqual(codes.count(20), 3)
                self.assertEqual({r["budget"]["used"] for r in results if "task" in r},
                                 {1, 2, 3})
                self.assertEqual(len(self.server.uploads), start + 3)
                self.assertEqual(self.show()[counter], 3)

    def test_polling_failure_does_not_stop_sibling_proof(self):
        self.server.task_status = "running"
        with self.pending_operations() as launch:
            first = launch()
            self.wait_for_task("task-1")
            second = launch()
            self.wait_for_task("task-2")
            with self.server.changed:
                self.server.task_poll_errors.add("task-1")
            failure = self.finish_operation(first, code=1)
            self.assertIn("task-1", failure["message"])
            self.assertIsNone(second.poll())
            self.assertEqual(self.server.cancel_requests, [])
            with self.server.changed:
                self.server.task_states["task-2"] = "completed"
            result = self.finish_operation(second)
            self.assertEqual(result["task"]["id"], "task-2")
            self.assertEqual(result["task"]["status"], "completed")
            self.assertEqual(self.show()["attemptsUsed"], 2)
            for attempt in (1, 2):
                snapshot = json.loads((self.workspace / f"proof-{attempt:03}/result.json").read_text())
                self.assertEqual(snapshot["task"]["id"], f"task-{attempt}")

    @unittest.skipUnless(os.name == "posix", "requires POSIX SIGINT delivery")
    def test_cancellation_does_not_stop_sibling_proof(self):
        self.server.task_status = "running"
        with self.pending_operations() as launch:
            first = launch()
            self.wait_for_task("task-1")
            second = launch()
            self.wait_for_task("task-2")
            first.send_signal(signal.SIGINT)
            failure = self.finish_operation(first, code=1)
            self.assertIn("Interrupted", failure["message"])
            self.assertEqual(self.server.cancel_requests, ["task-1"])
            self.assertIsNone(second.poll())
            snapshot = json.loads((self.workspace / "proof-001/result.json").read_text())
            self.assertEqual(snapshot["task"]["status"], "cancelled")
            self.assertEqual(snapshot["wait"]["taskId"], "task-1")
            self.assertTrue(snapshot["wait"]["cancellationConfirmed"])
            with self.server.changed:
                self.server.task_states["task-2"] = "completed"
            result = self.finish_operation(second)
            self.assertEqual(result["task"]["id"], "task-2")
            self.assertEqual(result["task"]["status"], "completed")
            self.assertEqual(self.show()["attemptsUsed"], 2)

    def test_legacy_project_state_untouched(self):
        legacy = self.root / ".intent/prove/session.json"
        legacy.write_text('{"legacy":true}')
        self.start()
        self.operation("prove")
        self.assertEqual(legacy.read_text(), '{"legacy":true}')


    def test_default_config(self):
        limits = ('max_run_attempts', 'max_validation_attempts', 'max_proof_attempts')
        partial = self.cli("config")["config"]
        self.assertEqual({key: partial[key] for key in limits}, dict.fromkeys(limits, 50))
        self.config.unlink()
        defaults = self.cli("config")["config"]
        self.assertEqual(defaults["server_url"], "https://prover.intentcomputing.org")
        self.assertEqual({key: defaults[key] for key in limits}, dict.fromkeys(limits, 50))


if __name__ == "__main__":
    unittest.main(verbosity=2)
