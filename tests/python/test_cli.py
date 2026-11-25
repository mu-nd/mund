import contextlib
import io
import os
import re
import shlex
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from helpers import FIXTURE, ROOT, commit_all, git, load_script, make_repository, needs_git
from mundlib import jsonfmt
from mundlib.database import Database, fix_files

mund = load_script(ROOT / "tools" / "mund.py")


def run(*argv, root=FIXTURE):
    """(exit status, standard output, standard error) of ``mund.py --root ROOT ARGV``."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        status = mund.main(["--root", str(root)] + list(argv))
    return status, out.getvalue(), err.getvalue()


class CliTests(unittest.TestCase):
    def test_validate(self):
        self.assertEqual(run("validate")[0], 0)
        with tempfile.TemporaryDirectory() as tmp:
            root = make_repository(Path(tmp) / "repo")
            (root / "data/master/constants.json").write_bytes(b"{")
            status, out, _ = run("validate", root=root)
            self.assertEqual(status, 1)
            self.assertIn("E_JSON", out)
            self.assertIn("data/master/constants.json", out)

    def test_id_reproduces_the_worked_example(self):
        doc = (ROOT / "docs" / "id-definition.md").read_text(encoding="utf-8")
        command = re.search(r"^python3 tools/mund\.py (id .+)$", doc, re.M).group(1)
        expected = re.findall(r"^(MetaID|DataID) += (\w+)$", doc, re.M)
        status, out, _ = run(*shlex.split(command))
        self.assertEqual(status, 0)
        self.assertEqual(re.findall(r"^(MetaID|DataID) +(\w+)", out, re.M), expected)

    def test_fix_and_releases_require_a_database_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            for root in (Path(tmp), Path(tmp) / "missing"):
                for command in ("fix", "releases"):
                    with self.subTest(root=root, command=command):
                        status, out, err = run(command, root=root)
                        self.assertEqual((status, out), (1, ""))
                        self.assertIn(str(root), err)

    @needs_git
    def test_major_release_tag_requires_a_frozen_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = make_repository(Path(tmp) / "repo")
            commit_all(root, "Test", "release")
            git(root, "tag", "v1.2.0")
            self.assertEqual(run("releases", root=root)[0], 0)
            git(root, "tag", "v1.0.0")
            status, out, err = run("releases", root=root)
            self.assertEqual(status, 1)
            self.assertIn("releases/v1", out + err)

    def test_id_refuses_an_invalid_bib_id(self):
        status, out, err = run("id", "LT", "EXP", "x")
        self.assertEqual((status, out), (1, ""))
        self.assertIn("error:", err)

    def test_serve_keeps_serving_the_folder_it_was_given(self):
        # The build may move the folder that a relative --out names (run from inside an earlier build).
        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                expected = os.path.abspath(".")
                with mock.patch.object(mund.site, "build_site", return_value={"versions": [], "default": "latest"}) as build, \
                        mock.patch.object(mund.http.server, "ThreadingHTTPServer") as server:
                    self.assertEqual(run("serve", "--out", ".", "--port", "0")[0], 0)
            finally:
                os.chdir(cwd)
        self.assertEqual(build.call_args[0][1], expected)
        self.assertEqual(server.call_args[0][1].keywords["directory"], expected)


class FixTests(unittest.TestCase):
    """``fix`` on a copy of the test database."""

    NAME = "Mizuno2025_4d2ed5c83736.json"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = make_repository(Path(self.tmp.name) / "repo")
        self.exp = self.root / "data" / "LT" / "EXP"
        self.text = (self.exp / self.NAME).read_text(encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_clean_data_are_left_alone(self):
        self.assertEqual(run("fix", root=self.root), (0, "0 file(s) changed\n", ""))

    def test_layout_identifiers_and_name_are_fixed(self):
        obj = jsonfmt.loads(self.text)
        del obj["data"][0]["datasetId"]
        (self.exp / self.NAME).unlink()
        (self.exp / "Wrong_4d2ed5c83736.json").write_text(jsonfmt.compact(obj), encoding="utf-8")
        self.assertEqual(fix_files(self.root),
                         [("data/LT/EXP/Wrong_4d2ed5c83736.json", "data/LT/EXP/" + self.NAME)])
        self.assertEqual((self.exp / self.NAME).read_text(encoding="utf-8"), self.text)
        self.assertEqual([str(i) for i in Database.load(self.root).validate()], [])
        self.assertEqual(fix_files(self.root), [])

    def test_a_second_file_of_one_source_is_refused(self):
        copy = self.text.replace("1065.5", "999.9")
        (self.exp / "Copy_4d2ed5c83736.json").write_text(copy, encoding="utf-8")
        status, out, err = run("fix", root=self.root)
        self.assertEqual((status, out), (1, ""))
        self.assertIn("which another file has", err)
        self.assertEqual((self.exp / self.NAME).read_text(encoding="utf-8"), self.text)
        self.assertEqual((self.exp / "Copy_4d2ed5c83736.json").read_text(encoding="utf-8"), copy)

    def test_fix_refuses_undefined_sublibraries(self):
        for folder, sub, fmt in (("BR", "BR", "muND/BR/draft"), ("Other", "Other", "muND/Other/1"),
                                 ("LT", "LTT", "muND/LT/1"), ("LT", "LT", "muND/LT/draft")):
            with self.subTest(folder=folder, sub=sub, fmt=fmt):
                path = self.root / "data" / folder / "TH/sample.json"
                jsonfmt.write(path, {"format": fmt, "sublibrary": sub, "datasetType": "theory",
                                     "meta": {"bibId": "muND:sample"}, "data": []})
                before = path.read_bytes()
                status, _, err = run("fix", root=self.root)
                self.assertEqual(status, 1)
                self.assertIn(folder, err)
                self.assertEqual(path.read_bytes(), before)
                path.unlink()
                if folder != "LT":
                    path.parent.rmdir()
                    path.parent.parent.rmdir()

    def test_case_equivalent_destinations_name_both_inputs(self):
        folder = self.root / "data/LT/TH"
        folder.mkdir(exist_ok=True)
        for name, bib in (("first.json", "Sample"), ("second.json", "sample")):
            jsonfmt.write(folder / name, {"format": "muND/LT/1", "sublibrary": "LT", "datasetType": "theory",
                                          "meta": {"bibId": "muND:" + bib}, "data": []})
        before = {p.name: p.read_bytes() for p in folder.iterdir()}
        status, _, err = run("fix", root=self.root)
        self.assertEqual(status, 1)
        self.assertIn("first.json", err)
        self.assertIn("second.json", err)
        self.assertEqual({p.name: p.read_bytes() for p in folder.iterdir()}, before)

    def test_a_change_of_case_is_a_rename(self):
        (self.exp / self.NAME).rename(self.exp / self.NAME.lower())
        self.assertEqual(run("fix", root=self.root)[0], 0)
        self.assertEqual(sorted(p.name for p in self.exp.iterdir()), [self.NAME])
        self.assertEqual((self.exp / self.NAME).read_text(encoding="utf-8"), self.text)

    def test_fix_batch_preserves_files_on_failure(self):
        master = self.root / "data/master"
        first, second = master / "constants.json", master / "facilities.json"
        first.write_bytes(b" " + first.read_bytes())
        second.write_bytes(b" " + second.read_bytes())
        before = [p.read_bytes() for p in (first, second)]
        second.chmod(0o444)
        try:
            if not os.access(second, os.W_OK):
                self.assertEqual(run("fix", root=self.root)[0], 1)
                self.assertEqual([p.read_bytes() for p in (first, second)], before)
        finally:
            second.chmod(0o644)
        replace = Path.replace

        def fail_second(path, dest):
            if dest.name == second.name:
                raise OSError("cannot install second file")
            return replace(path, dest)

        with mock.patch.object(Path, "replace", fail_second):
            self.assertEqual(run("fix", root=self.root)[0], 1)
        self.assertEqual([p.read_bytes() for p in (first, second)], before)

        second.write_bytes(b'{"value":"\\ud800"}')
        self.assertEqual(run("fix", root=self.root)[0], 1)
        self.assertEqual(first.read_bytes(), before[0])
        self.assertEqual(second.read_bytes(), b'{"value":"\\ud800"}')

    def test_identifiers_are_not_changed(self):
        edited = self.text.replace('"element": "Al", "mass": 27', '"element": "Al", "mass": 28', 1)
        self.assertNotEqual(edited, self.text)
        (self.exp / self.NAME).write_text(edited, encoding="utf-8")
        status, out, err = run("fix", root=self.root)
        self.assertEqual((status, out), (1, ""))
        self.assertIn("identifiers would change (datasetId dd91adba8444 -> ", err)
        self.assertEqual((self.exp / self.NAME).read_text(encoding="utf-8"), edited)


if __name__ == "__main__":
    unittest.main()
