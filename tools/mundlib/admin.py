"""The data entry tool on this computer: a small web server for the page in
``admin/`` that reads and writes the files of the local copy of the
repository and keeps it in step with GitHub through git.

For the person entering data there are only files that are *saved*: a save
validates the database, records the change (a git commit) and sends it to
GitHub (a git push).  When sending is not possible (offline, not logged in)
the change stays saved on this computer and is sent later.

The server listens on 127.0.0.1 only.  The page is opened with a key that
is exchanged for a cookie; every API call needs that cookie, a Host header
naming this server, and (for changes) a JSON body from the same origin.
"""
from __future__ import annotations

import difflib
import hashlib
import http.server
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import webbrowser
from pathlib import Path
from typing import Dict, List, Optional

from . import build, extraction, extraction_ai, jsonfmt
from .database import MASTER_DIR, MASTER_FORMATS, Database, canonical_text, is_data_file_path

# The pages run with the key of this server, so they may load code only from here and from the
# one pinned editor package (Monaco on cdnjs); they may connect only to this server and to the
# bibliographic services (Crossref, DataCite).
CONTENT_SECURITY_POLICY = "; ".join((
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/",
    "font-src 'self' data: https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://api.crossref.org https://api.datacite.org",
    "worker-src 'self' data: blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
))
COOKIE = "mund_admin"
# A fixed address keeps the page's own storage (unsaved changes, language) from one start to the next.
DEFAULT_PORT = 8742
TAG_RE = re.compile(r"^v\d+\.\d+\.\d+$")
SERVED_DIRS = ("admin", "site")


class AdminError(Exception):
    """A failure the page can explain: ``code`` names it, ``status`` is the HTTP status."""

    def __init__(self, code: str, message: str, status: int = 400, **extra):
        super().__init__(message)
        self.code = code
        self.status = status
        self.extra = extra

    def body(self) -> dict:
        return dict(code=self.code, message=str(self), **self.extra)


def blob_sha(data: bytes) -> str:
    """The git blob id of a file content."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def merge_lines(base: str, ours: str, theirs: str) -> Optional[str]:
    """Three-way merge by lines; None when both sides change the same lines.

    With one data entry per line, two people correcting neighbouring entries
    touch neighbouring lines; unlike git's merge this accepts that, and refuses
    only changes to the same lines (or two different insertions at one place).
    """
    b, o, t = base.splitlines(True), ours.splitlines(True), theirs.splitlines(True)

    def edits(new):
        return [(i1, i2, new[j1:j2]) for op, i1, i2, j1, j2 in
                difflib.SequenceMatcher(None, b, new, autojunk=False).get_opcodes() if op != "equal"]

    combined = []
    for edit in edits(o) + edits(t):
        same = [e for e in combined if e == edit]
        if same:
            continue
        for i1, i2, _ in combined:
            overlap = edit[0] < i2 and i1 < edit[1]
            touching_insertion = (edit[0] == edit[1] and i1 <= edit[0] <= i2) or (i1 == i2 and edit[0] <= i1 <= edit[1])
            if overlap or touching_insertion:
                return None
        combined.append(edit)
    out = list(b)
    for i1, i2, lines in sorted(combined, key=lambda e: (e[0], e[1]), reverse=True):
        out[i1:i2] = lines
    return "".join(out)


def classify(stderr: str) -> str:
    """offline | auth | rejected, from what git or gh wrote."""
    text = stderr.lower()
    if any(s in text for s in ("could not resolve host", "unable to access", "failed to connect",
                               "network is unreachable", "timed out", "could not read from remote")):
        return "offline"
    if any(s in text for s in ("authentication failed", "could not read username", "permission denied",
                               "403", "terminal prompts disabled", "invalid username or password")):
        return "auth"
    return "rejected"


ERROR_TEXT = {
    "offline": "GitHub cannot be reached; the change is saved on this computer and will be sent later.",
    "auth": "GitHub needs a login; run `pixi run login` once, then send again.",
    "rejected": "GitHub has changes that could not be combined with this one automatically.",
}


class LocalRepository:
    """The working copy at ``root`` and the git operations the tool needs."""

    def __init__(self, root, practice: bool = False):
        self.root = Path(root).resolve()
        self.practice = practice
        self.lock = threading.Lock()
        # names this copy for the page's storage of unsaved changes: a practice copy is new at every start
        self.copy = secrets.token_hex(6) if practice else hashlib.sha1(str(self.root).encode("utf-8")).hexdigest()[:12]

    # -- git -------------------------------------------------------------------
    def git(self, *args: str, input_text: Optional[str] = None, check: bool = True) -> subprocess.CompletedProcess:
        env = dict(os.environ, GIT_TERMINAL_PROMPT="0", LC_ALL="C", LANG="C")
        result = subprocess.run(["git", "-C", str(self.root)] + list(args), input=input_text,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        if check and result.returncode != 0:
            raise subprocess.CalledProcessError(result.returncode, result.args, result.stdout, result.stderr)
        return result

    def _out(self, *args: str) -> Optional[str]:
        result = self.git(*args, check=False)
        return result.stdout.strip() if result.returncode == 0 else None

    def upstream(self) -> Optional[str]:
        return self._out("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")

    def pending(self) -> int:
        return int(self._out("rev-list", "--count", "@{u}..HEAD") or 0) if self.upstream() else 0

    def repository(self) -> Optional[str]:
        url = self._out("remote", "get-url", "origin") or ""
        m = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$", url)
        return m.group(1) if m else None

    def session(self) -> dict:
        name, email = self._out("config", "user.name"), self._out("config", "user.email")
        return {"repository": self.repository(), "branch": self._out("rev-parse", "--abbrev-ref", "HEAD"),
                "user": {"name": name, "email": email} if name else None,
                "remote": self.upstream() is not None, "practice": self.practice, "copy": self.copy,
                "pending": self.pending()}

    # -- keeping in step with GitHub ----------------------------------------------
    def sync(self) -> dict:
        """Fetch, then bring this copy up to date (saved changes not yet sent go on top)."""
        with self.lock:
            return self._sync()

    def _sync(self) -> dict:
        if not self.upstream():
            return {"updated": False, "pending": 0, "error": None}
        fetched = self.git("fetch", "--quiet", check=False)
        if fetched.returncode != 0:
            return self._failure(fetched.stderr, updated=False)
        before = self._out("rev-parse", "HEAD")
        if self.pending():
            moved = self.git("rebase", "--quiet", "@{u}", check=False)
            if moved.returncode != 0:
                self.git("rebase", "--abort", check=False)
                return {"updated": False, "pending": self.pending(),
                        "error": {"code": "rejected", "message": ERROR_TEXT["rejected"]}}
        else:
            moved = self.git("merge", "--ff-only", "--quiet", "@{u}", check=False)
            if moved.returncode != 0:
                return {"updated": False, "pending": 0,
                        "error": {"code": "dirty", "message": "files changed on this computer outside the tool "
                                  "block the update: " + moved.stderr.strip()}}
        return {"updated": self._out("rev-parse", "HEAD") != before, "pending": self.pending(), "error": None}

    def _failure(self, stderr: str, **fields) -> dict:
        code = classify(stderr)
        return dict(fields, pending=self.pending(), error={"code": code, "message": ERROR_TEXT[code]})

    def send(self) -> dict:
        """Send the saved changes to GitHub (one more try after combining with others' changes)."""
        with self.lock:
            return self._send()

    def _send(self) -> dict:
        if not self.upstream():
            return {"sent": False, "pending": 0, "error": None}
        if not self.pending():
            return {"sent": True, "pending": 0, "error": None}
        pushed = self.git("push", "--quiet", check=False)
        if pushed.returncode != 0 and classify(pushed.stderr) == "rejected":
            synced = self._sync()
            if synced["error"]:
                return dict(synced, sent=False)
            pushed = self.git("push", "--quiet", check=False)
        if pushed.returncode != 0:
            return self._failure(pushed.stderr, sent=False)
        return {"sent": True, "pending": self.pending(), "error": None}

    # -- files -------------------------------------------------------------------------
    def watched(self, path: str) -> bool:
        """The files the tool lists: the database, the schemas, VERSION, CHANGELOG.md and the
        files of the extraction work area."""
        return path.startswith("data/") and path.endswith(".json") or \
            bool(re.match(r"^schema/v1/[^/]+\.json$", path)) or path in ("VERSION", "CHANGELOG.md") or \
            extraction.is_work_file(path)

    @staticmethod
    def writable(path: str) -> bool:
        """The files a save may change."""
        master = path[len(MASTER_DIR) + 1:] if path.startswith(MASTER_DIR + "/") else None
        return is_data_file_path(path) or master in MASTER_FORMATS or path in ("VERSION", "CHANGELOG.md") or \
            extraction.is_work_file(path)

    def files(self) -> List[dict]:
        found = list((self.root / "data").glob("**/*.json")) + list((self.root / "schema" / "v1").glob("*.json"))
        found += [self.root / name for name in ("VERSION", "CHANGELOG.md")]
        found += list((self.root / extraction.WORK_DIR).glob("*/*.json"))
        out = []
        for path in sorted(p for p in found if p.is_file()):
            rel = path.relative_to(self.root).as_posix()
            if self.watched(rel):
                out.append({"path": rel, "sha": blob_sha(path.read_bytes())})
        return out

    def read(self, path: str) -> str:
        target = self.root / path
        if not self.watched(path) or not target.is_file():
            raise AdminError("not-found", "%s is not a file of the database" % path, 404)
        return target.read_text(encoding="utf-8")

    def save(self, message: str, changes: List[dict], writer: Optional[str] = None) -> dict:
        """Validate, write, record and send one set of changes.  ``writer`` names the step of the
        extraction work area that makes them ('ai', 'publish'; see extraction.check_task)."""
        if not message.strip() or not changes:
            raise AdminError("bad-request", "a message and at least one change are needed")
        for c in changes:
            if not isinstance(c.get("path"), str) or not self.writable(c["path"]) or ".." in c["path"].split("/"):
                raise AdminError("bad-request", "%r cannot be saved by the tool" % c.get("path"))
        with self.lock:
            self._sync()                                     # offline: carry on with this copy
            conflicts, merged = [], []
            for c in changes:
                target = self.root / c["path"]
                current = blob_sha(target.read_bytes()) if target.is_file() else None
                if current == c.get("baseSha"):
                    continue
                text = self._merge(c, target)
                if text is None:
                    conflicts.append(c["path"])
                else:
                    c["content"] = text
                    merged.append(c["path"])
            if conflicts:
                raise AdminError("conflict", "changed in the meantime: " + ", ".join(conflicts), 409, paths=conflicts)

            texts = {p.relative_to(self.root).as_posix(): p.read_text(encoding="utf-8")
                     for p in (self.root / "data").glob("**/*.json")}
            for c in changes:
                if c["path"].startswith("data/"):
                    if c.get("content") is None:
                        texts.pop(c["path"], None)
                    else:
                        texts[c["path"]] = c["content"]
            errors = [i for i in Database.from_texts(texts).validate() if i.level == "error"]
            if any(extraction.is_work_file(c["path"]) for c in changes):
                errors += [i for i in extraction.check_save(self.root, changes, self._out("config", "user.name"), writer)
                           if i.level == "error"]
            if errors:
                raise AdminError("invalid", "the database would not be valid", 422,
                                 issues=[{"level": i.level, "code": i.code, "file": i.file,
                                          "pointer": i.pointer, "message": i.message} for i in errors])

            for c in changes:
                target = self.root / c["path"]
                if c.get("content") is None:
                    if target.exists():
                        target.unlink()
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(c["content"], encoding="utf-8")
            paths = [c["path"] for c in changes]
            self.git("add", "--all", "--", *paths, check=False)      # a new file deleted again is no path
            if self.git("diff", "--cached", "--quiet", check=False).returncode != 0:
                committed = self.git("commit", "--quiet", "--file", "-", input_text=message.strip() + "\n", check=False)
                if committed.returncode != 0:
                    self.git("reset", "--quiet", "--", *paths, check=False)
                    raise AdminError("identity", "git does not know who is saving (name and e-mail); "
                                     "run `pixi run login` once: " + committed.stderr.strip(), 400)
            sha = self._out("rev-parse", "HEAD")
            sent = self._send()
            return {"sha": sha, "sent": sent["sent"], "pending": sent["pending"], "error": sent["error"],
                    "merged": merged}

    def _merge(self, change: dict, target: Path) -> Optional[str]:
        """Combine a change made on an older version of a file with what the file is now
        (see merge_lines).  None when that is not possible: the same lines changed, a file
        deleted on one side, an older version this copy does not know, or a result that
        is not a file in canonical form."""
        if change.get("content") is None or not change.get("baseSha") or not target.is_file():
            return None
        base = self.git("cat-file", "blob", change["baseSha"], check=False)
        if base.returncode != 0:
            return None
        merged = merge_lines(base.stdout, change["content"], target.read_text(encoding="utf-8"))
        try:
            if merged is None or canonical_text(jsonfmt.loads(merged)) != merged:
                return None
        except ValueError:
            return None
        return merged

    # -- history and versions -----------------------------------------------------------
    def history(self, path: str = "", limit: int = 30) -> List[dict]:
        args = ["log", "-n", str(max(1, min(int(limit), 500))), "--format=%H%x1f%an%x1f%aI%x1f%s"]
        if path:
            args += ["--", path]
        out = self._out(*args) or ""
        return [dict(zip(("sha", "author", "date", "message"), line.split("\x1f")))
                for line in out.splitlines() if line]

    def tags(self) -> List[dict]:
        out = self._out("for-each-ref", "refs/tags/v*", "--format=%(refname:short) %(*objectname) %(objectname)") or ""
        tags = []
        for line in out.splitlines():
            parts = line.split()
            tags.append({"name": parts[0], "sha": parts[1] if len(parts) == 3 else parts[-1]})
        return tags

    def release_commit(self, version: str) -> Optional[str]:
        """The commit that set VERSION to ``version`` (the release commit of that version)."""
        for sha in (self._out("log", "--format=%H", "--", "VERSION") or "").split():
            shown = self.git("show", "%s:VERSION" % sha, check=False)
            if shown.returncode == 0 and shown.stdout.strip() == version:
                return sha
        return None

    def tag(self, name: str) -> dict:
        """Publish the version ``name`` (vX.Y.Z).

        The tag goes on the commit that set VERSION to X.Y.Z - never on a later
        state, also when an earlier attempt failed and this one repeats it.  A
        major version (N.0.0) is frozen first: its files are built from that
        commit into releases/vN and saved (see build.freeze_release).
        """
        if not TAG_RE.match(str(name)):
            raise AdminError("bad-request", "a version tag looks like v1.2.3")
        version = name[1:]
        with self.lock:
            sha = self.release_commit(version)
            if sha is None:
                raise AdminError("not-found", "no saved state has the version %s" % version, 404)
            tagged = self._out("rev-parse", "--verify", "--quiet", "refs/tags/%s^{commit}" % name)
            if tagged and tagged != sha:
                raise AdminError("tag-exists", "the version %s is published already" % name, 409)
            frozen = self._freeze(version, sha)
            if not tagged:
                self.git("tag", name, sha)
            sent = self._send()
            if self.upstream():
                pushed = self.git("push", "--quiet", "origin", "refs/tags/%s" % name, check=False)
                if pushed.returncode != 0:
                    return self._failure(pushed.stderr, name=name, sha=sha, frozen=frozen, sent=False)
            return {"name": name, "sha": sha, "frozen": frozen, "sent": sent["sent"],
                    "pending": sent["pending"], "error": sent["error"]}

    def _freeze(self, version: str, sha: str) -> Optional[str]:
        """releases/vN of a major version, built from its release commit and saved once."""
        label = build.release_label(version)
        if label is None:
            return None
        rel = "%s/%s" % (build.RELEASES_DIR, label)
        if (self.root / rel).exists():
            problems = build.verify_release(self.root, label)["errors"]
            if problems:
                raise AdminError("invalid", "; ".join(problems), 422)
            return label
        try:
            build.freeze_release(self.root, sha)
        except ValueError as exc:
            raise AdminError("invalid", str(exc), 422)
        self.git("add", "--", rel)
        committed = self.git("commit", "--quiet", "-m", "Freeze release %s" % version, "--", rel, check=False)
        if committed.returncode != 0:
            self.git("reset", "--quiet", "--", rel, check=False)
            shutil.rmtree(self.root / rel, ignore_errors=True)
            raise AdminError("identity", "git does not know who is saving (name and e-mail); "
                             "run `pixi run login` once: " + committed.stderr.strip(), 400)
        return label


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def make_handler(repo: LocalRepository, code_root: Path, key: str):
    """Request handler for one server: the page from ``code_root``, the API on ``repo``."""

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "muND-admin"

        def log_message(self, fmt, *args):  # keep the terminal quiet
            pass

        # -- helpers ------------------------------------------------------------
        def send_json(self, status: int, body) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def own_host(self) -> bool:
            port = self.server.server_address[1]
            return self.headers.get("Host") in ("127.0.0.1:%d" % port, "localhost:%d" % port)

        def has_cookie(self) -> bool:
            cookies = dict(part.strip().split("=", 1) for part in (self.headers.get("Cookie") or "").split(";")
                           if "=" in part)
            return secrets.compare_digest(cookies.get(COOKIE, ""), key)

        def same_origin(self) -> bool:
            origin = self.headers.get("Origin")
            return origin is None or origin == "http://%s" % self.headers.get("Host")

        # -- requests -------------------------------------------------------------
        def do_GET(self):
            self.handle_request("GET")

        def do_POST(self):
            self.handle_request("POST")

        def handle_request(self, method: str) -> None:
            if not self.own_host():
                return self.send_json(403, {"code": "forbidden", "message": "unknown host"})
            url = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(url.query)
            if url.path.startswith("/api/"):
                if not self.has_cookie():
                    return self.send_json(403, {"code": "forbidden", "message": "open the tool with the address "
                                                "printed by `mund.py admin`"})
                if method == "POST" and (not self.same_origin()
                                         or not (self.headers.get("Content-Type") or "").startswith("application/json")):
                    return self.send_json(403, {"code": "forbidden", "message": "not from the tool's page"})
                try:
                    return self.send_json(200, self.api(method, url.path[5:], query))
                except AdminError as err:
                    return self.send_json(err.status, err.body())
                except (ValueError, KeyError, TypeError) as err:
                    return self.send_json(400, {"code": "bad-request", "message": str(err)})
            if method != "GET":
                return self.send_json(405, {"code": "bad-request", "message": "method not allowed"})
            if query.get("key") == [key]:
                self.send_response(303)
                self.send_header("Set-Cookie", "%s=%s; HttpOnly; SameSite=Strict; Path=/" % (COOKIE, key))
                self.send_header("Location", "/admin/")
                self.end_headers()
                return
            self.serve_file(url.path)

        def api(self, method: str, name: str, query: dict):
            body = {}
            if method == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            route = (method, name)
            if route == ("GET", "session"):
                return repo.session()
            if route == ("POST", "sync"):
                return repo.sync()
            if route == ("GET", "files"):
                return repo.files()
            if route == ("GET", "file"):
                return {"path": query["path"][0], "text": repo.read(query["path"][0])}
            if route == ("POST", "save"):
                return repo.save(str(body.get("message", "")), list(body.get("changes") or []))
            if route == ("POST", "send"):
                return repo.send()
            if route == ("GET", "history"):
                return repo.history(query.get("path", [""])[0], int(query.get("limit", ["30"])[0]))
            if route == ("GET", "tags"):
                return repo.tags()
            if name.startswith("extraction/"):
                try:
                    return extraction.api(repo, method, name[len("extraction/"):], query, body, extraction_ai)
                except extraction.WorkError as err:
                    raise AdminError(err.code, str(err), err.status, **err.extra)
            if route == ("POST", "tag"):
                return repo.tag(str(body.get("name", "")))
            raise AdminError("not-found", "no such API: %s %s" % (method, name), 404)

        def serve_file(self, path: str) -> None:
            if path in ("/", "/admin"):
                path = "/admin/"
            if path.endswith("/"):
                path += "index.html"
            parts = [p for p in urllib.parse.unquote(path).split("/") if p]
            target = code_root.joinpath(*parts) if parts else None
            if (not parts or parts[0] not in SERVED_DIRS or ".." in parts or target is None
                    or not target.is_file()):
                return self.send_json(404, {"code": "not-found", "message": path})
            data = target.read_bytes()
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if target.suffix in (".js", ".mjs"):
                ctype = "text/javascript"
            self.send_response(200)
            self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or
                                                      ctype == "application/json" else ""))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(data)

    return Handler


def practice_copy(root: Path, workdir: Path) -> Path:
    """A throw-away copy of the database files of ``root`` as they are on disk, with its own
    stand-in for GitHub."""
    seed, remote, work = workdir / "seed", workdir / "github.git", workdir / "mund"
    for part in ("data", "schema"):
        shutil.copytree(root / part, seed / part)
    if (root / extraction.WORK_DIR).is_dir():                     # the work area, without the PDFs
        shutil.copytree(root / extraction.WORK_DIR, seed / extraction.WORK_DIR,
                        ignore=shutil.ignore_patterns("*.pdf", "*.PDF"))
    for name in ("VERSION", "CHANGELOG.md", ".gitignore"):
        if (root / name).is_file():
            shutil.copy(root / name, seed / name)

    def git(where: Path, *args: str) -> None:
        subprocess.run(["git", "-C", str(where)] + list(args), check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    identity = ("-c", "user.name=Practice user", "-c", "user.email=practice@example.invalid",
                "-c", "commit.gpgsign=false")
    git(seed, "init", "--quiet", "-b", "main")
    git(seed, "add", "--all")
    git(seed, *identity, "commit", "--quiet", "-m", "Practice copy")
    subprocess.run(["git", "clone", "--quiet", "--bare", str(seed), str(remote)], check=True)
    subprocess.run(["git", "clone", "--quiet", str(remote), str(work)], check=True)
    for key, value in (("user.name", "Practice user"), ("user.email", "practice@example.invalid"),
                       ("commit.gpgsign", "false"), ("tag.gpgsign", "false")):
        git(work, "config", key, value)
    return work


def serve(root, port: int = DEFAULT_PORT, practice: bool = False, open_browser: bool = True) -> None:
    """Run the tool until Ctrl+C."""
    code_root = Path(root).resolve()
    workdir = Path(tempfile.mkdtemp(prefix="mund-practice-")) if practice else None
    try:
        data_root = practice_copy(code_root, workdir) if practice else code_root
        repo = LocalRepository(data_root, practice=practice)
        key = secrets.token_urlsafe(24)
        try:
            httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), make_handler(repo, code_root, key))
        except OSError as err:
            raise SystemExit("port %d is in use (is the tool running already?); choose another one with --port: %s"
                             % (port, err))
        url = "http://127.0.0.1:%d/?key=%s" % (httpd.server_address[1], key)
        print("muND data entry%s: %s" % (" (practice copy)" if practice else "", url), flush=True)
        print("Ctrl+C to stop.", flush=True)
        if open_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            httpd.server_close()
    finally:
        if workdir is not None:
            shutil.rmtree(workdir, ignore_errors=True)


def login(root, with_token: bool = False) -> int:
    """Log in to GitHub with gh, let git use that login, and name the author of saves.

    By default gh's browser login is used.  With ``with_token`` a personal access
    token is read from standard input (never from the command line, where it would
    end up in the shell history) - for a fine-grained token limited to this
    repository with the permission "Contents: read and write".  gh keeps the token
    in the system's credential store (the macOS keychain, Windows Credential
    Manager, or ~/.config/gh/hosts.yml where there is none).
    """
    root = Path(root).resolve()
    if shutil.which("gh") is None:
        print("gh (GitHub CLI) is not installed here; run this through pixi: pixi run login")
        return 1
    if with_token:
        token = sys.stdin.readline().strip()
        if not token:
            print("no token given (paste it and press Enter, or pipe it in)")
            return 1
        subprocess.run(["gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"],
                       input=token + "\n", text=True, check=True)
    elif subprocess.run(["gh", "auth", "status", "--hostname", "github.com"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        subprocess.run(["gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"],
                       check=True)
    subprocess.run(["gh", "auth", "setup-git", "--hostname", "github.com"], check=True)
    repo = LocalRepository(root)
    if not repo._out("config", "user.name") or not repo._out("config", "user.email"):
        user = json.loads(subprocess.run(["gh", "api", "user"], check=True, stdout=subprocess.PIPE,
                                         text=True).stdout)
        # the address GitHub keeps private for the account
        email = "%d+%s@users.noreply.github.com" % (user["id"], user["login"])
        repo.git("config", "user.name", user.get("name") or user["login"])
        repo.git("config", "user.email", email)
    print("Logged in to GitHub; saves are recorded as %s <%s>."
          % (repo._out("config", "user.name"), repo._out("config", "user.email")))
    return 0
