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
import getpass
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

from . import jsonfmt, releases
from .build import SOURCE_PATTERNS
from .database import MASTER_DIR, MASTER_FORMATS, Database, is_data_file_path
from .schema import canonical_text

# The pages run with the key of this server, so they may load code only from here and from the
# one pinned editor package (Monaco on cdnjs); they may connect only to this server and to the
# bibliographic services (Crossref, DataCite).
MONACO_BASE = "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/"
CONTENT_SECURITY_POLICY = "; ".join((
    "default-src 'self'",
    "script-src 'self' " + MONACO_BASE,
    "style-src 'self' 'unsafe-inline' " + MONACO_BASE,
    "font-src 'self' data: " + MONACO_BASE,
    "img-src 'self' data: blob:",
    "connect-src 'self' https://api.crossref.org https://api.datacite.org",
    "worker-src 'self' data: blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
))
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
    """Combine edits to disjoint lines, including neighbouring data entries.
    Return None for overlapping edits or insertions that touch another edit.
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
    """The cause of a send failure, from what git or gh wrote."""
    text = stderr.lower()
    if any(s in text for s in ("authentication failed", "could not read username", "permission denied (publickey",
                               "401", "terminal prompts disabled", "invalid username or password")):
        return "auth"
    if any(s in text for s in ("403", "permission denied", "denied to ", "write access to repository not granted")):
        return "permission"
    if any(s in text for s in ("could not resolve host", "unable to access", "failed to connect",
                               "network is unreachable", "timed out", "could not read from remote")):
        return "offline"
    return "rejected"


ERROR_TEXT = {
    "offline": "GitHub cannot be reached; the change is saved on this computer and will be sent later.",
    "permission": "GitHub denied access. Ask the data maintainer to check your permissions.",
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
        # never let git guess a name or e-mail from the account and host name
        result = subprocess.run(["git", "-C", str(self.root), "-c", "user.useConfigOnly=true"] + list(args),
                                input=input_text,
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
        ident = re.match(r"^(.*) <(.*)> \d+ [+-]\d{4}$", self._out("var", "GIT_AUTHOR_IDENT") or "")
        return {"repository": self.repository(), "branch": self._out("rev-parse", "--abbrev-ref", "HEAD"),
                "user": {"name": ident.group(1), "email": ident.group(2)} if ident else None,
                "practice": self.practice, "copy": self.copy, "pending": self.pending()}

    # -- keeping in step with GitHub ----------------------------------------------
    def sync(self) -> dict:
        """Fetch, then bring this copy up to date (saved changes not yet sent go on top)."""
        with self.lock:
            return self._sync()

    def _uncommitted(self) -> List[str]:
        status = self.git("status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--",
                          "data", "schema/v1", "VERSION", "CHANGELOG.md").stdout
        return [entry[3:] for entry in status.split("\0") if self.watched(entry[3:])]

    def _sync(self) -> dict:
        dirty = self._uncommitted()
        if dirty:
            return {"updated": False, "pending": self.pending(), "error": {"code": "dirty",
                    "message": "files changed on this computer but not recorded: " + ", ".join(dirty)}}
        if not self.upstream():
            return {"updated": False, "pending": 0, "error": None}
        fetched = self.git("-c", "remote.origin.fetch=refs/tags/v*:refs/mund/published/v*",
                           "fetch", "--quiet", check=False)
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
        for attempt in range(2):
            dirty = self._uncommitted()
            if dirty:
                return {"sent": False, "pending": self.pending(), "error": {"code": "dirty",
                        "message": "files changed on this computer but not recorded: " + ", ".join(dirty)}}
            if self._errors():
                return {"sent": False, "pending": self.pending(),
                        "error": {"code": "rejected", "message": ERROR_TEXT["rejected"]}}
            pushed = self.git("push", "--quiet", check=False)
            if pushed.returncode == 0:
                return {"sent": True, "pending": self.pending(), "error": None}
            if attempt or classify(pushed.stderr) != "rejected":
                break
            synced = self._sync()
            if synced["error"]:
                return {"sent": False, "pending": synced["pending"], "error": synced["error"]}
        return self._failure(pushed.stderr, sent=False)

    # -- files -------------------------------------------------------------------------
    def watched(self, path: str) -> bool:
        """The files the tool lists: the database, the schemas, VERSION and CHANGELOG.md."""
        return path.startswith("data/") and path.endswith(".json") or \
            bool(re.match(r"^schema/v1/[^/]+\.json$", path)) or path in ("VERSION", "CHANGELOG.md")

    @staticmethod
    def writable(path: str) -> bool:
        """The files a save may change."""
        master = path[len(MASTER_DIR) + 1:] if path.startswith(MASTER_DIR + "/") else None
        return is_data_file_path(path) or master in MASTER_FORMATS or path in ("VERSION", "CHANGELOG.md")

    def files(self) -> List[dict]:
        """The files the tool lists, each with its blob id and its text."""
        found = list((self.root / "data").glob("**/*.json")) + list((self.root / "schema" / "v1").glob("*.json"))
        found += [self.root / name for name in ("VERSION", "CHANGELOG.md")]
        out = []
        for path in sorted(p for p in found if p.is_file()):
            rel = path.relative_to(self.root).as_posix()
            if self.watched(rel):
                data = path.read_bytes()
                text = data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
                out.append({"path": rel, "sha": blob_sha(data), "text": text})
        return out

    def _errors(self, changes=()):
        texts = {p.relative_to(self.root).as_posix(): p.read_bytes().decode("utf-8")
                 for p in (self.root / "data").glob("**/*.json") if p.is_file()}
        for c in changes:
            if c["path"].startswith("data/"):
                if c.get("content") is None:
                    texts.pop(c["path"], None)
                else:
                    texts[c["path"]] = c["content"]
        return [i for i in Database.from_texts(texts).validate() if i.level == "error"]

    def save(self, message: str, changes: List[dict]) -> dict:
        """Validate, write, record and send one set of changes; files that cannot be recorded are put back."""
        if not message.strip() or not changes:
            raise AdminError("bad-request", "a message and at least one change are needed")
        for c in changes:
            if not isinstance(c.get("path"), str) or not self.writable(c["path"]) or ".." in c["path"].split("/"):
                raise AdminError("bad-request", "%r cannot be saved by the tool" % c.get("path"))
        paths = [c["path"] for c in changes]
        with self.lock:
            self._check_identity()
            staged = self.git("diff", "--cached", "--name-only", "--no-renames", "-z").stdout.split("\0")
            foreign = sorted((set(staged) | set(self._uncommitted())) - set(paths) - {""})
            if foreign:
                raise AdminError("dirty", "files changed on this computer outside the tool: " + ", ".join(foreign))
            self._sync()                                     # offline: carry on with this copy
            removed = {c["path"].casefold(): c["path"] for c in changes if c.get("content") is None}
            case_moves = {}
            conflicts = []
            for c in changes:
                target = self.root / c["path"]
                old = removed.get(c["path"].casefold())
                if old and c.get("content") is not None and c.get("baseSha") is None and target.is_file():
                    names = os.listdir(target.parent)
                    if target.name not in names and Path(old).name in names and target.samefile(self.root / old):
                        case_moves[c["path"]] = old
                        continue
                current = blob_sha(target.read_bytes()) if target.is_file() else None
                if current == c.get("baseSha"):
                    continue
                text = self._merge(c, target)
                if text is None:
                    conflicts.append(c["path"])
                else:
                    c["content"] = text
            if conflicts:
                raise AdminError("conflict", "changed in the meantime: " + ", ".join(conflicts), 409, paths=conflicts)

            errors = self._errors(changes)
            if errors:
                raise AdminError("invalid", "the database would not be valid", 422,
                                 issues=[{"level": i.level, "code": i.code, "file": i.file,
                                          "pointer": i.pointer, "message": i.message} for i in errors])

            original = {p: (self.root / p).read_bytes() if p not in case_moves and (self.root / p).is_file()
                        else None for p in paths}
            try:
                if case_moves:
                    self.git("rm", "--", *case_moves.values())
                for c in changes:
                    if c["path"] in case_moves.values():
                        continue
                    target = self.root / c["path"]
                    if c.get("content") is None:
                        if target.exists():
                            target.unlink()
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(c["content"].encode("utf-8"))  # LF on every system, so the blob id is git's
                self.git("add", "--all", "--", *(p for p in paths if p not in case_moves.values()))
                if self.git("diff", "--cached", "--quiet", "--", *paths, check=False).returncode != 0:
                    committed = self.git("commit", "--quiet", "--file", "-", input_text=message.strip() + "\n",
                                         check=False)
                    if committed.returncode != 0:
                        raise AdminError("commit", committed.stderr.strip() or "git commit failed")
            except Exception as exc:
                self._restore(original)
                if isinstance(exc, AdminError):
                    raise
                raise AdminError("commit", (getattr(exc, "stderr", None) or str(exc)).strip())
            sha = self._out("rev-parse", "HEAD")
            sent = self._send()
            return {"sha": sha, "sent": sent["sent"], "pending": sent["pending"], "error": sent["error"]}

    def _check_identity(self) -> None:
        """Refuse before anything is written when git does not know who is saving."""
        for var in ("GIT_COMMITTER_IDENT", "GIT_AUTHOR_IDENT"):
            known = self.git("var", var, check=False)
            if known.returncode != 0:
                raise AdminError("identity", "git does not know who is saving (name and e-mail); "
                                 "run `pixi run login` once: " + known.stderr.strip(), 400)

    def _restore(self, original: Dict[str, Optional[bytes]]) -> None:
        """Put back the files of a save that was not recorded (None: the file did not exist)."""
        # Remove created names before restoring a file under its original capitalization.
        for path, data in sorted(original.items(), key=lambda item: item[1] is not None):
            target = self.root / path
            if data is None:
                if target.is_file():
                    target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        self.git("reset", "--quiet", "--", *original, check=False)

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
        merged = merge_lines(base.stdout, change["content"], target.read_bytes().decode("utf-8"))
        try:
            if merged is None or canonical_text(jsonfmt.loads(merged)) != merged:
                return None
        except ValueError:
            return None
        return merged

    # -- history and versions -----------------------------------------------------------
    def history(self, path: str = "", limit: int = 30) -> List[dict]:
        """The saves that changed ``path`` (all saves without it), newest first, with
        their full messages.  The saves of a single file include those made under its
        earlier names."""
        args = ["log", "-n", str(max(1, min(int(limit), 500))), "--format=%H%x1f%an%x1f%aI%x1f%B%x1e"]
        if path:
            args += (["--follow"] if not (self.root / path).is_dir() else []) + ["--", path]
        out = self._out(*args) or ""
        entries = [record.strip().split("\x1f", 3) for record in out.split("\x1e")]
        return [dict(sha=sha, author=author, date=date, message=message.strip())
                for sha, author, date, message in (e for e in entries if len(e) == 4)]

    def tags(self) -> List[dict]:
        """Versions confirmed by a fetch or a successful publication to origin."""
        out = self._out("for-each-ref", "refs/mund/published/",
                        "--format=%(refname:lstrip=3) %(*objectname) %(objectname)") or ""
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
        commit into releases/vN and saved (see releases.freeze_release).
        """
        if not TAG_RE.match(str(name)):
            raise AdminError("bad-request", "a version tag looks like v1.2.3")
        version = name[1:]
        with self.lock:
            if self.upstream() != "origin/main":
                return {"name": name, "sha": None, "frozen": None, "sent": False, "pending": self.pending(),
                        "error": {"code": "rejected", "message": ERROR_TEXT["rejected"]}}
            synced = self._sync()
            sent = synced if synced["error"] else self._send()
            if sent["error"]:
                return {"name": name, "sha": self.release_commit(version), "frozen": None, "sent": False,
                        "pending": sent["pending"], "error": sent["error"]}
            sha = self.release_commit(version)
            if sha is None:
                raise AdminError("not-found", "no saved state has the version %s" % version, 404)
            if self.git("merge-base", "--is-ancestor", sha, "origin/main", check=False).returncode:
                return self._failure("", name=name, sha=sha, frozen=None, sent=False)
            tagged = self._out("rev-parse", "--verify", "--quiet", "refs/tags/%s^{commit}" % name)
            if tagged and tagged != sha:
                raise AdminError("tag-exists", "the version %s is published already" % name, 409)
            frozen = self._freeze(version, sha)
            if not tagged:
                self.git("tag", name, sha)
            pushed = self.git("push", "--quiet", "--atomic", "origin", "HEAD:refs/heads/main",
                              "refs/tags/%s" % name, check=False)
            if pushed.returncode != 0:
                return self._failure(pushed.stderr, name=name, sha=sha, frozen=frozen, sent=False)
            self.git("update-ref", "refs/mund/published/%s" % name, sha)
            return {"name": name, "sha": sha, "frozen": frozen, "sent": True,
                    "pending": self.pending(), "error": None}

    def _freeze(self, version: str, sha: str) -> Optional[str]:
        """releases/vN of a major version, built from its release commit and saved once."""
        label = releases.release_label(version)
        if label is None:
            return None
        rel = "%s/%s" % (releases.RELEASES_DIR, label)
        folder = self.root / rel
        if self._out("rev-parse", "--verify", "HEAD:" + rel):
            problems = releases.verify_release(self.root, label)["errors"]
            if problems:
                raise AdminError("invalid", "; ".join(problems), 422)
            manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
            recorded = set(self.git("ls-tree", "-r", "-z", "--name-only", "HEAD:" + rel).stdout.split("\0"))
            required = {"manifest.json", manifest["archive"]["path"]} | {f["path"] for f in manifest["files"]}
            if (manifest["commit"] != sha or not required <= recorded
                    or self.git("diff", "--quiet", "HEAD", "--", rel, check=False).returncode):
                raise AdminError("dirty", "the saved release differs from the files on this computer")
            return label
        self._check_identity()
        if folder.is_dir():
            self.git("reset", "--quiet", "--", rel)
            shutil.rmtree(folder)
        try:
            releases.freeze_release(self.root, sha)
        except ValueError as exc:
            raise AdminError("invalid", str(exc), 422)
        try:
            self.git("add", "--force", "--", rel)
            self.git("commit", "--quiet", "-m", "Freeze release %s" % version, "--", rel)
        except (OSError, subprocess.CalledProcessError) as exc:
            self.git("reset", "--quiet", "--", rel, check=False)
            shutil.rmtree(folder, ignore_errors=True)
            raise AdminError("commit", (getattr(exc, "stderr", None) or str(exc)).strip())
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

        def cookie_name(self) -> str:
            return "mund_admin_%d" % self.server.server_address[1]

        def has_cookie(self) -> bool:
            cookies = dict(part.strip().split("=", 1) for part in (self.headers.get("Cookie") or "").split(";")
                           if "=" in part)
            return secrets.compare_digest(cookies.get(self.cookie_name(), ""), key)

        def same_origin(self) -> bool:
            origin = self.headers.get("Origin")
            return origin is None or origin == "http://%s" % self.headers.get("Host")

        # -- requests -------------------------------------------------------------
        def do_GET(self):
            self.handle_request("GET")

        def do_POST(self):
            self.handle_request("POST")

        def handle_request(self, method: str) -> None:
            try:
                self.dispatch(method)
            except AdminError as err:
                self.send_json(err.status, err.body())
            except Exception:
                self.send_json(500, {"code": "internal", "message": "the tool could not finish this request"})

        def dispatch(self, method: str) -> None:
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
                return self.send_json(200, self.api(method, url.path[5:], query))
            if method != "GET":
                return self.send_json(405, {"code": "bad-request", "message": "method not allowed"})
            if query.get("key") == [key]:
                self.send_response(303)
                self.send_header("Set-Cookie", "%s=%s; HttpOnly; SameSite=Strict; Path=/" % (self.cookie_name(), key))
                self.send_header("Location", "/admin/")
                self.end_headers()
                return
            self.serve_file(url.path)

        def api(self, method: str, name: str, query: dict):
            body = {}
            if method == "POST":
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    if length < 0:
                        raise ValueError("negative content length")
                    body = json.loads(self.rfile.read(length)) if length else {}
                except (ValueError, OverflowError, RecursionError) as err:
                    raise AdminError("bad-request", "invalid JSON request") from err
                if not isinstance(body, dict):
                    raise AdminError("bad-request", "a request must be a JSON object")
            route = (method, name)
            if route == ("GET", "session"):
                return repo.session()
            if route == ("POST", "sync"):
                return repo.sync()
            if route == ("GET", "files"):
                return repo.files()
            if route == ("POST", "save"):
                message, changes = body.get("message"), body.get("changes")
                if not isinstance(message, str) or not isinstance(changes, list):
                    raise AdminError("bad-request", "a save needs a message and a list of changes")
                for change in changes:
                    if (not isinstance(change, dict) or not isinstance(change.get("path"), str)
                            or "content" not in change or "baseSha" not in change
                            or not isinstance(change["content"], (str, type(None)))
                            or not isinstance(change["baseSha"], (str, type(None)))):
                        raise AdminError("bad-request", "invalid file change")
                return repo.save(message, changes)
            if route == ("POST", "send"):
                return repo.send()
            if route == ("GET", "history"):
                try:
                    limit = int(query.get("limit", ["30"])[0])
                except ValueError as err:
                    raise AdminError("bad-request", "the history limit must be a number") from err
                return repo.history(query.get("path", [""])[0], limit)
            if route == ("GET", "tags"):
                return repo.tags()
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
    for pattern in SOURCE_PATTERNS + ("CHANGELOG.md", ".gitignore", ".gitattributes"):
        for source in root.glob(pattern):
            if source.is_file():
                target = seed / source.relative_to(root)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(source, target)

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
            raise SystemExit("ポート %d は使用中です(ツールがすでに動いていませんか?)。--port で別の番号を選んでください。\n"
                             "port %d is in use (is the tool running already?); choose another one with --port: %s"
                             % (port, port, err))
        url = "http://127.0.0.1:%d/?key=%s" % (httpd.server_address[1], key)
        print("muND データ入力ツール%s / data entry%s: %s"
              % ("(練習用のコピー)" if practice else "", " (practice copy)" if practice else "", url), flush=True)
        print("終了するには Ctrl+C / Ctrl+C to stop.", flush=True)
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
    token is read without echo in a terminal or from a pipe. Use a fine-grained token limited to this
    repository with the permission "Contents: read and write".  gh keeps the token
    in the system's credential store (the macOS keychain, Windows Credential
    Manager, or ~/.config/gh/hosts.yml where there is none).
    """
    root = Path(root).resolve()
    if shutil.which("gh") is None:
        print("gh (GitHub CLI) がありません。pixi run login で実行してください。\n"
              "gh (GitHub CLI) is not installed here; run this through pixi: pixi run login")
        return 1
    if with_token:
        if sys.stdin.isatty():
            token = getpass.getpass("アクセストークン / Access token: ").strip()
        else:
            token = sys.stdin.readline().strip()
        if not token:
            print("トークンが入力されていません(貼り付けて Enter を押してください)。\n"
                  "no token given (paste it and press Enter, or pipe it in)")
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
    name, email = repo._out("config", "user.name"), repo._out("config", "user.email")
    print("GitHub にログインしました。保存は %s <%s> の名前で記録されます。\n"
          "Logged in to GitHub; saves are recorded as %s <%s>." % (name, email, name, email))
    return 0
