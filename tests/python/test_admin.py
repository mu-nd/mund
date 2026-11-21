import http.client
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

from helpers import ROOT, make_repository
from mundlib import admin

MIZUNO = "data/LT/EXP/Mizuno2025_4d2ed5c83736.json"


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"] + list(args),
                          check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()


def identify(repo: Path, name: str) -> None:
    git(repo, "config", "user.name", name)
    git(repo, "config", "user.email", "%s@example.invalid" % name.lower())
    git(repo, "config", "commit.gpgsign", "false")
    git(repo, "config", "tag.gpgsign", "false")


class MergeTests(unittest.TestCase):
    def test_line_merge(self):
        base = "a\nb\nc\nd\n"
        self.assertEqual(admin.merge_lines(base, "A\nb\nc\nd\n", "a\nB\nc\nd\n"), "A\nB\nc\nd\n", "neighbouring lines")
        self.assertEqual(admin.merge_lines(base, "A\nb\nc\nd\n", "A\nb\nc\nD\n"), "A\nb\nc\nD\n", "the same change twice")
        self.assertIsNone(admin.merge_lines(base, "A\nb\nc\nd\n", "X\nb\nc\nd\n"), "the same line")
        self.assertEqual(admin.merge_lines(base, "a\nb\nc\nd\ne\n", "a\nc\nd\n"), "a\nc\nd\ne\n", "insert and delete apart")
        self.assertIsNone(admin.merge_lines(base, "a\nx\nb\nc\nd\n", "a\ny\nb\nc\nd\n"), "two insertions at one place")


@unittest.skipIf(shutil.which("git") is None, "git is not available")
class LocalRepositoryTests(unittest.TestCase):
    """A stand-in for GitHub (a bare repository) and two people's copies of it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        seed = make_repository(base / "seed")
        git(seed, "init", "-q", "-b", "main")
        identify(seed, "Seed")
        git(seed, "add", "-A")
        git(seed, "commit", "-q", "-m", "initial")
        self.github = base / "github.git"
        subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(self.github)], check=True)
        self.alice, self.bob = base / "alice", base / "bob"
        for path, name in ((self.alice, "Alice"), (self.bob, "Bob")):
            subprocess.run(["git", "clone", "-q", str(self.github), str(path)], check=True)
            identify(path, name)
        self.repo = admin.LocalRepository(self.alice)

    def tearDown(self):
        self.tmp.cleanup()

    def change(self, path=MIZUNO, old='"value": 743.9, "unit": "ns"', new='"value": 744.9, "unit": "ns"', root=None):
        text = ((root or self.alice) / path).read_text(encoding="utf-8")
        self.assertIn(old, text)
        return {"path": path, "content": text.replace(old, new), "baseSha": admin.blob_sha(text.encode("utf-8"))}

    def github_text(self, path=MIZUNO) -> str:
        return git(self.github, "show", "main:" + path)

    def test_session_and_files(self):
        s = self.repo.session()
        self.assertEqual((s["branch"], s["remote"], s["pending"], s["user"]["name"]), ("main", True, 0, "Alice"))
        paths = [f["path"] for f in self.repo.files()]
        self.assertIn(MIZUNO, paths)
        self.assertIn("schema/v1/lt.schema.json", paths)
        self.assertIn("VERSION", paths)
        self.assertNotIn("tools/mund.py", paths)
        with self.assertRaises(admin.AdminError):
            self.repo.read("tools/mund.py")

    def test_save_records_and_sends(self):
        result = self.repo.save("Update LT/EXP Mizuno2025", [self.change()])
        self.assertTrue(result["sent"])
        self.assertEqual(result["pending"], 0)
        self.assertIn('"value": 744.9', self.github_text())
        log = git(self.github, "log", "-1", "--format=%an|%s", "main")
        self.assertEqual(log, "Alice|Update LT/EXP Mizuno2025")
        self.assertEqual(self.repo.history(MIZUNO, 5)[0]["message"], "Update LT/EXP Mizuno2025")

    def test_invalid_change_is_not_saved(self):
        bad = self.change(new='"value": -744.9, "unit": "ns"')
        with self.assertRaises(admin.AdminError) as caught:
            self.repo.save("bad", [bad])
        self.assertEqual(caught.exception.code, "invalid")
        self.assertEqual(caught.exception.extra["issues"][0]["code"], "E_SCHEMA")
        self.assertIn('"value": 743.9', (self.alice / MIZUNO).read_text(encoding="utf-8"))

    def test_only_database_files_can_be_saved(self):
        for path in ("tools/mund.py", "schema/v1/lt.schema.json", "data/../tools/x.json"):
            with self.assertRaises(admin.AdminError):
                self.repo.save("x", [{"path": path, "content": "{}\n", "baseSha": None}])

    def test_someone_else_changed_the_file(self):
        bob = admin.LocalRepository(self.bob)
        bob.save("Bob's correction", [self.change(new='"value": 745.9, "unit": "ns"', root=self.bob)])
        stale = self.change()                     # based on what Alice loaded before Bob's save
        with self.assertRaises(admin.AdminError) as caught:
            self.repo.save("Alice's correction", [stale])
        self.assertEqual((caught.exception.code, caught.exception.extra["paths"]), ("conflict", [MIZUNO]))
        self.assertIn('"value": 745.9', (self.alice / MIZUNO).read_text(encoding="utf-8"), "Alice got Bob's change")

    def test_changes_to_different_entries_of_one_file_are_combined(self):
        bob = admin.LocalRepository(self.bob)
        bob.save("Bob corrects Al", [self.change(old='"value": 863.7, "unit": "ns"', new='"value": 863.9, "unit": "ns"',
                                                 root=self.bob)])
        result = self.repo.save("Alice corrects Si", [self.change()])     # based on the file before Bob's save
        self.assertEqual((result["sent"], result["merged"]), (True, [MIZUNO]))
        text = self.github_text()
        self.assertIn('"value": 744.9', text)
        self.assertIn('"value": 863.9', text)

    def test_neighbouring_entries_are_combined_the_same_line_is_not(self):
        bob = admin.LocalRepository(self.bob)
        bob.save("Bob corrects Al plate", [self.change(old='"value": 863.7, "unit": "ns"', new='"value": 863.9, "unit": "ns"',
                                                       root=self.bob)])
        mg = self.change(old='"value": 1065.5, "unit": "ns"', new='"value": 1066.5, "unit": "ns"')     # the line before
        self.assertEqual(self.repo.save("Alice corrects Mg", [mg])["merged"], [MIZUNO])
        same = self.change(old='"value": 863.9, "unit": "ns"', new='"value": 864.9, "unit": "ns"')
        bob.save("Bob again", [self.change(old='"value": 863.9, "unit": "ns"', new='"value": 865.9, "unit": "ns"',
                                           root=self.bob)])
        with self.assertRaises(admin.AdminError) as caught:
            self.repo.save("Alice corrects Al plate", [same])
        self.assertEqual(caught.exception.code, "conflict")

    def test_changes_to_different_files_are_combined(self):
        bob = admin.LocalRepository(self.bob)
        bob.save("Bob adds a comment", [self.change("data/LT/CUR/unpublished_15fd4fea826c.json",
                                                    '"Weighted average of two data"', '"Weighted average of two data sets"',
                                                    root=self.bob)])
        result = self.repo.save("Alice's correction", [self.change()])
        self.assertTrue(result["sent"])
        self.assertIn('"value": 744.9', self.github_text())
        self.assertIn("two data sets", self.github_text("data/LT/CUR/unpublished_15fd4fea826c.json"))

    def test_saved_while_offline_is_sent_later(self):
        git(self.alice, "remote", "set-url", "origin", str(Path(self.tmp.name) / "missing.git"))
        result = self.repo.save("Update LT/EXP Mizuno2025", [self.change()])
        self.assertFalse(result["sent"])
        self.assertEqual(result["pending"], 1)
        self.assertIsNotNone(result["error"])
        self.assertIn('"value": 743.9', self.github_text())
        git(self.alice, "remote", "set-url", "origin", str(self.github))
        self.assertEqual(self.repo.send(), {"sent": True, "pending": 0, "error": None})
        self.assertIn('"value": 744.9', self.github_text())

    def test_sync_brings_others_changes(self):
        bob = admin.LocalRepository(self.bob)
        bob.save("Bob's correction", [self.change(new='"value": 745.9, "unit": "ns"', root=self.bob)])
        self.assertEqual(self.repo.sync(), {"updated": True, "pending": 0, "error": None})
        self.assertIn('"value": 745.9', (self.alice / MIZUNO).read_text(encoding="utf-8"))

    def test_rename_and_refused_deletion(self):
        old = self.alice / MIZUNO
        sha = admin.blob_sha(old.read_bytes())
        renamed = "data/LT/EXP/MizunoEtAl2025_4d2ed5c83736.json"
        result = self.repo.save("Rename", [{"path": MIZUNO, "content": None, "baseSha": sha},
                                           {"path": renamed, "content": old.read_text(encoding="utf-8"), "baseSha": None}])
        self.assertTrue(result["sent"])
        self.assertFalse(old.exists())
        self.assertIn(renamed, git(self.github, "ls-tree", "-r", "--name-only", "main"))
        # the curated data refer to entries of this file: deleting it is refused and nothing changes
        new = self.alice / renamed
        with self.assertRaises(admin.AdminError) as caught:
            self.repo.save("Delete", [{"path": renamed, "content": None, "baseSha": admin.blob_sha(new.read_bytes())}])
        self.assertEqual(caught.exception.code, "invalid")
        self.assertTrue(new.is_file())

    def set_version(self, version: str) -> str:
        """Save VERSION as the release page does; returns the commit."""
        path = self.alice / "VERSION"
        self.repo.save("Release %s" % version, [{"path": "VERSION", "content": version + "\n",
                                                  "baseSha": admin.blob_sha(path.read_bytes())}])
        return git(self.alice, "rev-parse", "HEAD")

    def change_value(self, old: str, new: str) -> None:
        path = self.alice / MIZUNO
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        self.repo.save("Correct a value", [{"path": MIZUNO, "content": text.replace(old, new),
                                            "baseSha": admin.blob_sha(path.read_bytes())}])

    def test_release_tag_is_on_the_release_commit(self):
        release = self.set_version("0.2.0")
        self.change_value('"value": 743.9, "unit": "ns"', '"value": 744.9, "unit": "ns"')   # saved afterwards
        result = self.repo.tag("v0.2.0")
        self.assertEqual((result["name"], result["sha"], result["frozen"], result["sent"], result["pending"]),
                         ("v0.2.0", release, None, True, 0))
        self.assertEqual(git(self.github, "rev-parse", "v0.2.0^{commit}"), release)
        self.assertNotEqual(git(self.alice, "rev-parse", "HEAD"), release)
        self.assertEqual(self.repo.tags(), [{"name": "v0.2.0", "sha": release}])
        # repeating it changes nothing; a version that was never saved, or a malformed name, is refused
        self.assertEqual(self.repo.tag("v0.2.0")["sha"], release)
        with self.assertRaises(admin.AdminError):
            self.repo.tag("v0.3.0")
        with self.assertRaises(admin.AdminError):
            self.repo.tag("latest")

    def test_retry_after_a_failed_send_uses_the_release_commit(self):
        release = self.set_version("0.2.0")
        moved = self.github.with_name("away.git")
        self.github.rename(moved)                        # GitHub cannot be reached
        try:
            first = self.repo.tag("v0.2.0")
        finally:
            moved.rename(self.github)
        self.assertEqual((first["sha"], first["sent"]), (release, False))
        self.change_value('"value": 743.9, "unit": "ns"', '"value": 744.9, "unit": "ns"')   # more work meanwhile
        second = self.repo.tag("v0.2.0")
        self.assertEqual((second["sha"], second["sent"]), (release, True))
        self.assertEqual(git(self.github, "rev-parse", "v0.2.0^{commit}"), release)

    def test_major_release_is_frozen_from_its_release_commit(self):
        release = self.set_version("1.0.0")
        self.change_value('"value": 743.9, "unit": "ns"', '"value": 744.9, "unit": "ns"')   # not part of 1.0.0
        result = self.repo.tag("v1.0.0")
        self.assertEqual((result["sha"], result["frozen"], result["sent"]), (release, "v1", True))
        manifest = json.loads((self.alice / "releases/v1/manifest.json").read_text(encoding="utf-8"))
        self.assertEqual((manifest["version"], manifest["commit"]), ("1.0.0", release))
        frozen = (self.alice / "releases/v1/LT.json").read_text(encoding="utf-8")
        self.assertIn('"value": 743.9', frozen)
        self.assertNotIn('"value": 744.9', frozen)
        self.assertEqual(git(self.github, "rev-parse", "v1.0.0^{commit}"), release)
        self.assertEqual(git(self.github, "log", "-1", "--format=%s", "main"), "Freeze release 1.0.0")
        from mundlib import build
        self.assertEqual(build.verify_release(self.alice, "v1"), {"errors": [], "warnings": []})


@unittest.skipIf(shutil.which("git") is None, "git is not available")
class PracticeCopyTests(unittest.TestCase):
    def test_practice_copy_starts_from_the_files_on_disk_and_sends_nowhere_else(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = make_repository(Path(tmp) / "source")      # not even a git repository
            work = admin.practice_copy(source, Path(tmp) / "practice")
            repo = admin.LocalRepository(work, practice=True)
            expected = [p.relative_to(source).as_posix() for p in source.glob("data/**/*.json")]
            expected += [p.relative_to(source).as_posix() for p in (source / "schema/v1").glob("*.json")]
            self.assertEqual(sorted(f["path"] for f in repo.files()), sorted(expected + ["VERSION"]))
            text = (work / MIZUNO).read_text(encoding="utf-8")
            result = repo.save("Practice", [{"path": MIZUNO, "content": text.replace("743.9", "744.9"),
                                             "baseSha": admin.blob_sha(text.encode("utf-8"))}])
            self.assertTrue(result["sent"])
            self.assertIn("743.9", (source / MIZUNO).read_text(encoding="utf-8"), "the source is untouched")


@unittest.skipIf(shutil.which("git") is None, "git is not available")
class ServerTests(unittest.TestCase):
    """The HTTP side: the key, the cookie and the routes."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        repo = make_repository(Path(cls.tmp.name) / "repo")
        shutil.copytree(ROOT / "admin", repo / "admin")
        git(repo, "init", "-q", "-b", "main")
        identify(repo, "Alice")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "initial")
        cls.key = "test-key"
        handler = admin.make_handler(admin.LocalRepository(repo), repo, cls.key)
        cls.httpd = admin.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, cookie=True, host=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        h = {"Host": host or "127.0.0.1:%d" % self.port}
        if cookie:
            h["Cookie"] = "%s=%s" % (admin.COOKIE, self.key)
        if body is not None:
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        conn.request(method, path, json.dumps(body) if body is not None else None, h)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, response.getheader("Set-Cookie"), data

    def test_key_gives_the_cookie(self):
        status, cookie, _ = self.request("GET", "/?key=%s" % self.key, cookie=False)
        self.assertEqual(status, 303)
        self.assertIn("HttpOnly", cookie)
        self.assertEqual(self.request("GET", "/?key=wrong", cookie=False)[1], None)

    def test_api_needs_cookie_and_own_host(self):
        self.assertEqual(self.request("GET", "/api/session", cookie=False)[0], 403)
        self.assertEqual(self.request("GET", "/api/session", host="evil.example:80")[0], 403)
        self.assertEqual(self.request("POST", "/api/sync", body={}, headers={"Origin": "http://evil.example"})[0], 403)
        status, _, data = self.request("GET", "/api/session")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["branch"], "main")

    def test_files_and_save(self):
        files = json.loads(self.request("GET", "/api/files")[2])
        entry = next(f for f in files if f["path"] == MIZUNO)
        text = json.loads(self.request("GET", "/api/file?path=" + MIZUNO)[2])["text"]
        status, _, data = self.request("POST", "/api/save", body={"message": "Update", "changes": [
            {"path": MIZUNO, "content": text.replace("743.9", "744.9"), "baseSha": entry["sha"]}]})
        self.assertEqual(status, 200, data)
        self.assertEqual(json.loads(data)["sent"], False, "no GitHub stand-in here")
        status, _, data = self.request("POST", "/api/save", body={"message": "Another value", "changes": [
            {"path": MIZUNO, "content": text.replace("743.9", "745.9"), "baseSha": entry["sha"]}]})
        self.assertEqual((status, json.loads(data)["code"]), (409, "conflict"))

    def test_pages_limit_where_code_comes_from(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request("GET", "/admin/", headers={"Host": "127.0.0.1:%d" % self.port})
        response = conn.getresponse()
        response.read()
        conn.close()
        policy = response.getheader("Content-Security-Policy") or ""
        self.assertIn("script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/;", policy)
        self.assertIn("frame-ancestors 'none'", policy)
        self.assertNotIn("unsafe-eval", policy)
        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")

    def test_page_and_shared_code_are_served_nothing_else(self):
        self.assertEqual(self.request("GET", "/admin/", cookie=False)[0], 200)
        self.assertEqual(self.request("GET", "/site/assets/js/core/dom.js", cookie=False)[0], 200)
        for path in ("/tools/mund.py", "/data/master/constants.json", "/admin/../tools/mund.py", "/.git/config"):
            self.assertEqual(self.request("GET", path)[0], 404, path)


if __name__ == "__main__":
    unittest.main()
