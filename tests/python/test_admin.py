import http.client
import io
import json
import os
import re
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from helpers import ROOT, git, make_repository, needs_git, remote_and_clones
from mundlib import admin

MIZUNO = "data/LT/EXP/Mizuno2025_4d2ed5c83736.json"
RENAMED = "data/LT/EXP/MizunoEtAl2025_4d2ed5c83736.json"
CUR = "data/LT/CUR/unpublished_15fd4fea826c.json"


class SendErrorTests(unittest.TestCase):
    def test_login_and_permission_errors_take_precedence_over_transport_text(self):
        cases = [
            ("unable to access 'https://sample.invalid/': The requested URL returned error: 401", "auth"),
            ("Permission denied (publickey). Could not read from remote repository.", "auth"),
            ("unable to access 'https://sample.invalid/': The requested URL returned error: 403", "permission"),
            ("remote: Write access to repository not granted.", "permission"),
            ("unable to access 'https://sample.invalid/': Could not resolve host", "offline"),
        ]
        for message, expected in cases:
            with self.subTest(message=message):
                self.assertEqual(admin.classify(message), expected)


class LoginTests(unittest.TestCase):
    def test_interactive_token_is_hidden_and_piped_token_is_read_from_stdin(self):
        for interactive in (True, False):
            with self.subTest(interactive=interactive), mock.patch("getpass.getpass", return_value="test-token") as hidden, \
                    mock.patch("sys.stdin") as stdin, mock.patch("shutil.which", return_value="gh"), \
                    mock.patch("subprocess.run") as run, mock.patch.object(admin.LocalRepository, "_out",
                                                                          return_value="configured"):
                stdin.isatty.return_value = interactive
                stdin.readline.return_value = "piped-token\n"
                self.assertEqual(admin.login(ROOT, with_token=True), 0)
                if interactive:
                    hidden.assert_called_once()
                    stdin.readline.assert_not_called()
                else:
                    hidden.assert_not_called()
                    stdin.readline.assert_called_once()
                self.assertEqual(run.call_args_list[0].kwargs["input"],
                                 "test-token\n" if interactive else "piped-token\n")


class MergeTests(unittest.TestCase):
    def test_line_merge(self):
        base = "a\nb\nc\nd\n"
        self.assertEqual(admin.merge_lines(base, "A\nb\nc\nd\n", "a\nB\nc\nd\n"), "A\nB\nc\nd\n", "neighbouring lines")
        self.assertEqual(admin.merge_lines(base, "A\nb\nc\nd\n", "A\nb\nc\nD\n"), "A\nb\nc\nD\n", "the same change twice")
        self.assertIsNone(admin.merge_lines(base, "A\nb\nc\nd\n", "X\nb\nc\nd\n"), "the same line")
        self.assertEqual(admin.merge_lines(base, "a\nb\nc\nd\ne\n", "a\nc\nd\n"), "a\nc\nd\ne\n", "insert and delete apart")
        self.assertIsNone(admin.merge_lines(base, "a\nx\nb\nc\nd\n", "a\ny\nb\nc\nd\n"), "two insertions at one place")


@needs_git
class LocalRepositoryTests(unittest.TestCase):
    """A stand-in for GitHub (a bare repository) and two people's copies of it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.github, (self.alice, self.bob) = remote_and_clones(Path(self.tmp.name), "Alice", "Bob")
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
        self.assertEqual((s["branch"], s["pending"], s["user"]["name"]), ("main", 0, "Alice"))
        files = {f["path"]: f for f in self.repo.files()}
        self.assertEqual(files[MIZUNO]["text"], (self.alice / MIZUNO).read_text(encoding="utf-8"))
        self.assertIn("schema/v1/lt.schema.json", files)
        self.assertIn("VERSION", files)
        self.assertNotIn("tools/mund.py", files)

    def test_save_records_and_sends(self):
        message = "Update LT/EXP Mizuno2025\n\nThe lifetime of table 2."
        result = self.repo.save(message, [self.change()])
        self.assertTrue(result["sent"])
        self.assertEqual(result["pending"], 0)
        self.assertIn('"value": 744.9', self.github_text())
        log = git(self.github, "log", "-1", "--format=%an|%s", "main")
        self.assertEqual(log, "Alice|Update LT/EXP Mizuno2025")
        self.assertEqual([e["message"] for e in self.repo.history(MIZUNO, 5)[:1]], [message])
        self.assertEqual(self.repo.history("data", 1)[0]["message"], message)

    def test_saved_file_has_git_line_ends_on_every_system(self):
        windows = lambda path, text, encoding=None: path.write_bytes(text.replace("\n", "\r\n").encode(encoding or "utf-8"))
        with mock.patch.object(Path, "write_text", windows):
            self.repo.save("Update LT/EXP Mizuno2025", [self.change()])
        self.assertNotIn(b"\r", (self.alice / MIZUNO).read_bytes())
        files = {f["path"]: f for f in self.repo.files()}
        self.assertEqual(files[MIZUNO]["sha"], git(self.alice, "rev-parse", "HEAD:" + MIZUNO))

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

    def test_neighbouring_entries_are_combined_the_same_line_is_not(self):
        bob = admin.LocalRepository(self.bob)
        bob.save("Bob corrects Al plate", [self.change(old='"value": 863.7, "unit": "ns"', new='"value": 863.9, "unit": "ns"',
                                                       root=self.bob)])
        mg = self.change(old='"value": 1065.5, "unit": "ns"', new='"value": 1066.5, "unit": "ns"')     # the line before
        self.assertTrue(self.repo.save("Alice corrects Mg", [mg])["sent"])
        text = self.github_text()
        self.assertIn('"value": 1066.5', text)
        self.assertIn('"value": 863.9', text)
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

    def test_send_refuses_an_invalid_combination(self):
        git(self.alice, "remote", "set-url", "origin", str(Path(self.tmp.name) / "missing.git"))
        offline = self.repo.save("Use D2", [self.change(old="J-PARC (D1)", new="J-PARC (D2)")])
        self.assertFalse(offline["sent"])
        path = "data/master/facilities.json"
        facilities = json.loads((self.bob / path).read_text(encoding="utf-8"))
        facilities["facilities"] = [f for f in facilities["facilities"] if f["abbr"] != "J-PARC (D2)"]
        change = {"path": path, "content": admin.canonical_text(facilities),
                  "baseSha": admin.blob_sha((self.bob / path).read_bytes())}
        self.assertTrue(admin.LocalRepository(self.bob).save("Remove unused D2", [change])["sent"])
        shared = git(self.github, "rev-parse", "main")
        git(self.alice, "remote", "set-url", "origin", str(self.github))
        for _ in range(2):
            sent = self.repo.send()
            self.assertFalse(sent["sent"])
            self.assertEqual((sent["pending"], sent["error"]["code"]), (1, "rejected"))
            self.assertEqual(git(self.github, "rev-parse", "main"), shared)
        self.assertEqual(git(self.alice, "rev-parse", "HEAD^"), shared)

    def test_unsent_save_that_conflicts_is_kept(self):
        git(self.alice, "remote", "set-url", "origin", str(Path(self.tmp.name) / "missing.git"))
        self.repo.save("Alice's correction", [self.change()])
        admin.LocalRepository(self.bob).save("Bob's correction",
                                             [self.change(new='"value": 745.9, "unit": "ns"', root=self.bob)])
        git(self.alice, "remote", "set-url", "origin", str(self.github))
        self.assertEqual(self.repo.send(), {"sent": False, "pending": 1,
                                            "error": {"code": "rejected", "message": admin.ERROR_TEXT["rejected"]}})
        self.assertIn('"value": 744.9', (self.alice / MIZUNO).read_text(encoding="utf-8"))
        self.assertEqual(git(self.alice, "status", "--porcelain"), "")

    def refused(self, code, changes) -> None:
        """The save is refused with ``code`` and leaves no trace: HEAD, the files and the index are as before."""
        head, status = git(self.alice, "rev-parse", "HEAD"), git(self.alice, "status", "--porcelain")
        with self.assertRaises(admin.AdminError) as caught:
            self.repo.save("Refused", changes)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual((git(self.alice, "rev-parse", "HEAD"), git(self.alice, "status", "--porcelain")), (head, status))
        self.assertEqual({f["path"]: f["sha"] for f in self.repo.files()}[MIZUNO],
                         git(self.alice, "rev-parse", "HEAD:" + MIZUNO))

    def test_unknown_identity_writes_nothing(self):
        git(self.alice, "config", "--unset", "user.name")
        git(self.alice, "config", "--unset", "user.email")
        empty = Path(self.tmp.name) / "empty.gitconfig"
        empty.write_text("", encoding="utf-8")
        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(empty), "GIT_CONFIG_NOSYSTEM": "1"}):
            self.assertIsNone(self.repo.session()["user"])
            self.refused("identity", [self.change()])

    def test_failed_commit_puts_the_files_back(self):
        hook = Path(self.tmp.name) / "hooks" / "pre-commit"          # refuses every commit
        hook.parent.mkdir()
        hook.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        hook.chmod(0o755)
        git(self.alice, "config", "core.hooksPath", str(hook.parent))
        cur = self.alice / CUR
        self.refused("commit", [self.change(), {"path": CUR, "content": None, "baseSha": admin.blob_sha(cur.read_bytes())}])
        self.assertTrue(cur.is_file())

    def test_failed_write_puts_the_files_back(self):
        old = self.alice / MIZUNO
        (self.alice / RENAMED).mkdir()                    # the new file cannot be written
        self.refused("commit", [{"path": MIZUNO, "content": None, "baseSha": admin.blob_sha(old.read_bytes())},
                                {"path": RENAMED, "content": old.read_text(encoding="utf-8"), "baseSha": None}])
        self.assertTrue(old.is_file())

    def test_files_staged_outside_the_tool_are_not_saved(self):
        (self.alice / "notes.txt").write_text("not for the database\n", encoding="utf-8")
        git(self.alice, "add", "notes.txt")
        self.refused("dirty", [self.change()])

    def test_unsaved_facility_cannot_validate_a_save(self):
        path = self.alice / "data/master/facilities.json"
        facilities = json.loads(path.read_text(encoding="utf-8"))
        facilities["facilities"].append({"abbr": "Test lab", "facility": "Test lab", "detail": "Test beam"})
        path.write_text(admin.canonical_text(facilities), encoding="utf-8")
        self.refused("dirty", [self.change(old="J-PARC (D1)", new="Test lab")])
        self.assertNotIn("Test lab", self.github_text())

    def test_sync_reports_unrecorded_changes(self):
        self.repo.save("Record a correction", [self.change()])
        self.assertIsNone(self.repo.sync()["error"])
        path = self.alice / MIZUNO
        path.write_text(path.read_text(encoding="utf-8") + " ", encoding="utf-8")
        error = self.repo.sync()["error"]
        self.assertIsNotNone(error)
        self.assertEqual(error["code"], "dirty")
        self.assertIn(MIZUNO, error["message"])

    def test_sync_brings_others_changes(self):
        bob = admin.LocalRepository(self.bob)
        bob.save("Bob's correction", [self.change(new='"value": 745.9, "unit": "ns"', root=self.bob)])
        self.assertEqual(self.repo.sync(), {"updated": True, "pending": 0, "error": None})
        self.assertIn('"value": 745.9', (self.alice / MIZUNO).read_text(encoding="utf-8"))

    def test_rename_and_refused_deletion(self):
        old = self.alice / MIZUNO
        sha = admin.blob_sha(old.read_bytes())
        before = self.repo.history(MIZUNO)
        result = self.repo.save("Rename", [{"path": MIZUNO, "content": None, "baseSha": sha},
                                           {"path": RENAMED, "content": old.read_text(encoding="utf-8"), "baseSha": None}])
        self.assertTrue(result["sent"])
        self.assertFalse(old.exists())
        self.assertIn(RENAMED, git(self.github, "ls-tree", "-r", "--name-only", "main"))
        self.assertEqual(self.repo.history(RENAMED), [self.repo.history(limit=1)[0]] + before,
                         "the saves made under the earlier name are kept")
        # the curated data refer to entries of this file: deleting it is refused and nothing changes
        new = self.alice / RENAMED
        with self.assertRaises(admin.AdminError) as caught:
            self.repo.save("Delete", [{"path": RENAMED, "content": None, "baseSha": admin.blob_sha(new.read_bytes())}])
        self.assertEqual(caught.exception.code, "invalid")
        self.assertTrue(new.is_file())

    def test_case_only_rename(self):
        path = self.alice / MIZUNO
        renamed = MIZUNO.replace("Mizuno", "MIZUNO")
        changes = [{"path": renamed, "content": path.read_text(encoding="utf-8"), "baseSha": None},
                   {"path": MIZUNO, "content": None, "baseSha": admin.blob_sha(path.read_bytes())}]
        hook = self.alice / ".git/hooks/pre-commit"
        hook.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        hook.chmod(0o755)
        self.refused("commit", changes)
        self.assertIn(path.name, os.listdir(path.parent))
        hook.unlink()
        self.assertTrue(self.repo.save("Correct capitalization", changes)["sent"])
        shared = git(self.github, "ls-tree", "-r", "--name-only", "main").splitlines()
        self.assertIn(renamed, shared)
        self.assertNotIn(MIZUNO, shared)
        self.assertIn(Path(renamed).name, os.listdir(path.parent))
        self.assertEqual(git(self.alice, "status", "--porcelain"), "")

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

    def test_offline_release_is_tagged_after_reconciliation(self):
        git(self.alice, "remote", "set-url", "origin", str(Path(self.tmp.name) / "missing.git"))
        offline = self.set_version("1.0.0")
        admin.LocalRepository(self.bob).save("Correct a value", [self.change(root=self.bob)])
        git(self.alice, "remote", "set-url", "origin", str(self.github))
        result = self.repo.tag("v1.0.0")
        self.assertTrue(result["sent"])
        release = git(self.github, "rev-parse", "v1.0.0^{commit}")
        self.assertNotEqual(release, offline)
        git(self.github, "merge-base", "--is-ancestor", release, "main")
        manifest = json.loads(self.github_text("releases/v1/manifest.json"))
        self.assertEqual(manifest["commit"], release)
        self.assertIn('"value": 744.9', self.github_text("releases/v1/LT.json"))

    def test_conflicting_release_is_not_tagged(self):
        git(self.alice, "remote", "set-url", "origin", str(Path(self.tmp.name) / "missing.git"))
        self.set_version("0.2.0")
        admin.LocalRepository(self.bob).save("Release 0.3.0", [self.change(path="VERSION", old="0.0.1",
                                                                            new="0.3.0", root=self.bob)])
        git(self.alice, "remote", "set-url", "origin", str(self.github))
        self.assertFalse(self.repo.tag("v0.2.0")["sent"])
        for copy in (self.alice, self.github):
            self.assertEqual(git(copy, "tag", "--list", "v0.2.0"), "")

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

    def test_failed_tag_send_stays_unpublished_across_restart(self):
        release = self.set_version("0.2.0")
        hook = self.github / "hooks" / "update"
        hook.write_text('#!/bin/sh\ncase "$1" in refs/tags/*) exit 1;; esac\n', encoding="utf-8")
        hook.chmod(0o755)
        self.assertFalse(self.repo.tag("v0.2.0")["sent"])
        restarted = admin.LocalRepository(self.alice)
        self.assertEqual(restarted.tags(), [])
        self.assertEqual(git(self.github, "tag", "--list"), "")
        hook.unlink()
        self.assertTrue(restarted.tag("v0.2.0")["sent"])
        published = [{"name": "v0.2.0", "sha": release}]
        self.assertEqual(restarted.tags(), published)
        colleague = admin.LocalRepository(self.bob)
        colleague.sync()
        self.assertEqual(colleague.tags(), published)

    def test_failed_freeze_build_can_be_retried(self):
        release = self.set_version("1.0.0")

        def interrupted(root, out, label, info):
            out.mkdir(parents=True)
            (out / "LT.json").write_bytes(b"{")
            raise ValueError("unable to build the release")

        with mock.patch.object(admin.releases, "build_dist", interrupted), self.assertRaises(admin.AdminError):
            self.repo.tag("v1.0.0")
        self.assertFalse((self.alice / "releases/v1").exists())
        self.assertEqual(git(self.github, "tag", "--list"), "")
        self.assertTrue(self.repo.tag("v1.0.0")["sent"])
        self.assertEqual(json.loads(self.github_text("releases/v1/manifest.json"))["commit"], release)

    def test_complete_uncommitted_freeze_is_recorded_on_retry(self):
        release = self.set_version("1.0.0")
        admin.releases.freeze_release(self.alice, release)
        git(self.alice, "add", "--", "releases/v1/LT.json")
        self.assertTrue(self.repo.tag("v1.0.0")["sent"])
        self.assertEqual(json.loads(self.github_text("releases/v1/manifest.json"))["commit"], release)

    def test_partial_freeze_and_failed_add_can_be_retried(self):
        release = self.set_version("1.0.0")
        folder = self.alice / "releases/v1"
        folder.mkdir(parents=True)
        (folder / "LT.json").write_bytes(b"{")
        real_git = self.repo.git

        def fail_add(*args, **kwargs):
            if args[0] == "add" and args[-1] == "releases/v1":
                raise admin.subprocess.CalledProcessError(1, "git add", stderr="cannot record the files")
            return real_git(*args, **kwargs)

        with mock.patch.object(self.repo, "git", fail_add), self.assertRaises(admin.AdminError) as caught:
            self.repo.tag("v1.0.0")
        self.assertEqual(caught.exception.code, "commit")
        self.assertFalse(folder.exists())
        self.assertEqual(git(self.alice, "status", "--porcelain"), "")
        self.assertEqual(git(self.github, "tag", "--list"), "")
        self.assertTrue(self.repo.tag("v1.0.0")["sent"])
        self.assertEqual(json.loads(self.github_text("releases/v1/manifest.json"))["commit"], release)

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
        from mundlib import releases
        self.assertEqual(releases.verify_release(self.alice, "v1"), {"errors": [], "warnings": []})
        # a frozen release that no longer matches its manifest is refused with the reason
        (self.alice / "releases/v1/LT.json").write_text(frozen.replace("743.9", "744.9"), encoding="utf-8")
        with self.assertRaises(admin.AdminError) as caught:
            self.repo.tag("v1.0.0")
        self.assertEqual((caught.exception.code, str(caught.exception)),
                         ("invalid", "v1: LT.json differs from the manifest"))


@needs_git
class PracticeCopyTests(unittest.TestCase):
    def test_major_version_can_be_published_in_practice(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = make_repository(Path(tmp) / "source")
            work = admin.practice_copy(source, Path(tmp) / "practice")
            repo = admin.LocalRepository(work, practice=True)
            version = (work / "VERSION").read_bytes()
            repo.save("Practice release", [{"path": "VERSION", "baseSha": admin.blob_sha(version),
                                            "content": "1.0.0\n"}])
            result = repo.tag("v1.0.0")
            self.assertTrue(result["sent"])
            remote = Path(tmp) / "practice/github.git"
            manifest = json.loads(git(remote, "show", "main:releases/v1/manifest.json"))
            self.assertEqual(manifest["commit"], git(remote, "rev-parse", "v1.0.0"))
            self.assertEqual(set(manifest["sources"]), set(admin.releases.source_hashes(source)))
            self.assertFalse((source / "releases").exists())

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


class HandlerTests(unittest.TestCase):
    def request(self, port, key, method, path, headers=None, data=b""):
        headers = {"Host": "127.0.0.1:%d" % port, "Content-Length": str(len(data)), **(headers or {})}
        head = [method + " " + path + " HTTP/1.0"] + [k + ": " + v for k, v in headers.items()]
        sock = mock.Mock()
        sock.makefile.return_value = io.BytesIO(("\r\n".join(head) + "\r\n\r\n").encode() + data)
        output = io.BytesIO()
        sock.sendall.side_effect = output.write
        handler = admin.make_handler(self.repo, ROOT, key)
        handler(sock, ("127.0.0.1", 1), mock.Mock(server_address=("127.0.0.1", port)))
        sock.makefile.return_value = io.BytesIO(output.getvalue())
        response = http.client.HTTPResponse(sock)
        response.begin()
        return response

    def setUp(self):
        self.repo = mock.Mock()
        self.repo.session.return_value = {}

    def test_malformed_save_returns_a_json_error(self):
        cookie = self.request(8742, "key", "GET", "/?key=key").getheader("Set-Cookie").split(";")[0]
        headers = {"Cookie": cookie, "Content-Type": "application/json"}
        change = {"path": "VERSION", "content": "1.0.0", "baseSha": None}
        for body in ([], {"message": {}, "changes": [change]}, {"message": "Save", "changes": [None]},
                     {"message": "Save", "changes": [dict(change, content=1)]},
                     {"message": "Save", "changes": [{"path": "VERSION", "baseSha": None}]}):
            with self.subTest(body=body):
                response = self.request(8742, "key", "POST", "/api/save", headers, json.dumps(body).encode())
                self.assertEqual((response.status, json.load(response)["code"]), (400, "bad-request"))
        self.repo.save.assert_not_called()

    def test_internal_api_failure_returns_a_json_error(self):
        cookie = self.request(8742, "key", "GET", "/?key=key").getheader("Set-Cookie").split(";")[0]
        for error in (OSError("unreadable file"), ValueError("invalid local file")):
            with self.subTest(error=error):
                self.repo.files.side_effect = error
                response = self.request(8742, "key", "GET", "/api/files", {"Cookie": cookie})
                self.assertEqual(response.status, 500)
                body = json.load(response)
                self.assertEqual(body["code"], "internal")
                self.assertTrue(body["message"])

    def test_two_ports_keep_their_sessions(self):
        cookies = {}
        servers = [(8742, "first"), (8743, "second")]
        for port, key in servers:
            cookie = self.request(port, key, "GET", "/?key=" + key).getheader("Set-Cookie")
            name, value = cookie.split(";", 1)[0].split("=", 1)
            cookies[name] = value
        for port, key in servers:
            response = self.request(port, key, "GET", "/api/session",
                                    {"Cookie": "; ".join(k + "=" + v for k, v in cookies.items())})
            self.assertEqual(response.status, 200)


@needs_git
class ServerTests(unittest.TestCase):
    """The HTTP side: the key, the cookie and the routes; the page and its code come from this repository."""

    KEY = "test-key"

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        _, (alice,) = remote_and_clones(Path(cls.tmp.name), "Alice")
        handler = admin.make_handler(admin.LocalRepository(alice), ROOT, cls.KEY)
        cls.httpd = admin.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None, cookie=True):
        """(status, headers, JSON body or None) of one request; ``headers`` add to or replace the usual ones."""
        conn = http.client.HTTPConnection(*self.httpd.server_address)
        h = {"Host": "%s:%d" % self.httpd.server_address}
        if cookie:
            h["Cookie"] = "mund_admin_%d=%s" % (self.httpd.server_address[1], self.KEY)
        if body is not None:
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        conn.request(method, path, json.dumps(body) if body is not None else None, h)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        is_json = (response.getheader("Content-Type") or "").startswith("application/json")
        return response.status, response.headers, json.loads(data) if is_json else None

    def test_key_gives_the_cookie(self):
        status, headers, _ = self.request("GET", "/?key=%s" % self.KEY, cookie=False)
        self.assertEqual(status, 303)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIsNone(self.request("GET", "/?key=wrong", cookie=False)[1]["Set-Cookie"])

    def test_api_needs_cookie_and_own_host(self):
        self.assertEqual(self.request("GET", "/api/session", cookie=False)[0], 403)
        self.assertEqual(self.request("GET", "/api/session", headers={"Host": "evil.example:80"})[0], 403)
        self.assertEqual(self.request("POST", "/api/sync", body={}, headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/sync", body={}, headers={"Content-Type": "text/plain"})[0], 403)
        status, _, session = self.request("GET", "/api/session")
        self.assertEqual((status, session["branch"]), (200, "main"))

    def test_files_and_save(self):
        entry = next(f for f in self.request("GET", "/api/files")[2] if f["path"] == MIZUNO)
        text = entry["text"]
        status, _, result = self.request("POST", "/api/save", body={"message": "Update", "changes": [
            {"path": MIZUNO, "content": text.replace("743.9", "744.9"), "baseSha": entry["sha"]}]})
        self.assertEqual((status, result["sent"]), (200, True), result)
        status, _, result = self.request("POST", "/api/save", body={"message": "Another value", "changes": [
            {"path": MIZUNO, "content": text.replace("743.9", "745.9"), "baseSha": entry["sha"]}]})
        self.assertEqual((status, result["code"]), (409, "conflict"))

    def test_pages_limit_where_code_comes_from(self):
        headers = self.request("GET", "/admin/", cookie=False)[1]
        policy = headers["Content-Security-Policy"] or ""
        loader = (ROOT / "admin/js/monaco.js").read_text(encoding="utf-8")
        version = re.search(r"const VERSION = '(\d+\.\d+\.\d+)';", loader).group(1)
        base = re.search(r"const BASE = `([^`]+)`;", loader).group(1).replace("${VERSION}", version) + "/"
        directives = {parts[0]: parts[1:] for parts in (rule.split() for rule in policy.split("; "))}
        self.assertEqual(directives["script-src"], ["'self'", base])
        self.assertEqual(directives["style-src"], ["'self'", "'unsafe-inline'", base])
        self.assertEqual(directives["font-src"], ["'self'", "data:", base])
        self.assertIn("frame-ancestors 'none'", policy)
        self.assertIn("frame-src 'none'", policy)
        self.assertNotIn("unsafe-eval", policy)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

    def test_page_and_shared_code_are_served_nothing_else(self):
        self.assertEqual(self.request("GET", "/admin/", cookie=False)[0], 200)
        self.assertEqual(self.request("GET", "/site/assets/js/core/dom.js", cookie=False)[0], 200)
        for path in ("/tools/mund.py", "/data/master/constants.json", "/admin/../tools/mund.py", "/.git/config"):
            self.assertEqual(self.request("GET", path)[0], 404, path)


if __name__ == "__main__":
    unittest.main()
