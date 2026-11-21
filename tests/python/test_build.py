import csv
import io
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from helpers import ROOT, make_repository
from mundlib import build, jsonfmt
from mundlib.convert import Physics
from mundlib.database import Database

RELEASE = {"version": "9.9.9", "commit": "abc", "date": "2026-11-16T00:00:00+09:00", "kind": "release"}


class BuildTests(unittest.TestCase):
    """One version of the data and the site, built from the test database."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.repo = make_repository(Path(cls.tmp.name) / "repo")
        cls.out = Path(cls.tmp.name) / "latest"
        cls.manifest = build.build_dist(cls.repo, cls.out, "latest", RELEASE)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_manifest(self):
        m = self.manifest
        self.assertEqual((m["label"], m["version"], m["kind"], m["commit"]), ("latest", "9.9.9", "release", "abc"))
        self.assertEqual(m["sublibraries"]["LT"]["status"], "available")
        self.assertEqual(m["sublibraries"]["LT"]["counts"], {"EXP": 10, "TH": 0, "CUR": 8, "EVAL": 22})
        self.assertEqual(m["sublibraries"]["BR"]["status"], "planned")
        for f in m["files"]:
            self.assertEqual((self.out / f["path"]).stat().st_size, f["bytes"])

    def test_aggregate(self):
        agg = jsonfmt.loads((self.out / "LT.json").read_text(encoding="utf-8"))
        self.assertEqual(len(agg["data"]), 40)
        metas = {m["id"] for m in agg["meta"]}
        self.assertTrue(all(e["metaId"] in metas for e in agg["data"]))
        self.assertEqual([b["id"] for b in agg["bibliography"]], ["DOI:10.1103/PhysRevC.111.034614", "DOI:10.1103/vl7z-rzp8"])
        entry = next(e for e in agg["data"] if e["datasetId"] == "e489422fdeb4")
        self.assertEqual(jsonfmt.plain(entry), {
            "datasetId": "e489422fdeb4", "datasetType": "experiment", "metaId": "4d2ed5c83736",
            "bibId": "DOI:10.1103/vl7z-rzp8", "nuclide": {"element": "Si", "mass": 28, "isomer": 0},
            "observable": {"kind": "lifetime", "lifetime": {
                "value": 743.9, "unit": "ns", "uncertainties": [{"source": "total", "value": 5.0}]}},
            "legacyIds": ["e2551c5951a7"]})
        si = [e for e in agg["data"] if e["nuclide"]["element"] == "Si" and e["datasetType"] == "curated"]
        self.assertEqual(jsonfmt.lexeme(si[1]["observable"]["capture_rate"]["uncertainties"][0]["value"]),
                         "0.0090", "digits are kept")

    def test_master(self):
        master = json.loads((self.out / "master.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(master), ["constants", "facilities", "format", "huff_factors", "nuclides", "version"])

    def test_csv(self):
        rows = list(csv.DictReader(io.StringIO((self.out / "csv/LT.csv").read_text(encoding="utf-8"))))
        self.assertEqual(len(rows), 40)
        self.assertEqual(list(rows[0]), build.CSV_COLUMNS)
        r = next(r for r in rows if r["datasetId"] == "e489422fdeb4")
        self.assertEqual((r["datasetType"], r["element"], r["z"], r["mass"], r["observable"], r["value"],
                          r["uncertainty"], r["unit"]),
                         ("experiment", "Si", "14", "28", "lifetime", "743.9", "5.0", "ns"))
        self.assertEqual(r["reference"], "Mizuno et al., Phys. Rev. C 112, 024307 (2025)")
        self.assertAlmostEqual(float(r["capture_rate_us-1"]), 1 / 0.7439 - 0.9924 / 2.1969811, places=5)
        exp = list(csv.DictReader(io.StringIO((self.out / "csv/LT_EXP.csv").read_text(encoding="utf-8"))))
        self.assertEqual(len(exp), 10)
        self.assertFalse((self.out / "csv/LT_TH.csv").exists())

    def test_statistical_and_systematic_columns(self):
        db = Database.load(self.repo)
        physics = Physics(db.master_obj("huff_factors.json"), db.master_obj("constants.json"))
        agg = {"meta": [{"id": "m"}], "data": [jsonfmt.loads(
            '{"datasetId": "d", "datasetType": "experiment", "metaId": "m", "bibId": "DOI:10.1103/vl7z-rzp8",'
            ' "nuclide": {"element": "Si", "mass": 0, "isomer": 0}, "observable": {"kind": "lifetime",'
            ' "lifetime": {"value": 751.4, "unit": "ns", "uncertainties": [{"source": "statistical", "value": 0.8},'
            ' {"source": "systematic", "value": 0.7}]}}}')]}
        row = next(csv.DictReader(io.StringIO(build.csv_text(agg, db, physics))))
        self.assertEqual((row["value"], row["uncertaintyStatistical"], row["uncertaintySystematic"]),
                         ("751.4", "0.8", "0.7"))
        self.assertAlmostEqual(float(row["uncertainty"]), (0.8 ** 2 + 0.7 ** 2) ** 0.5, places=5)
        self.assertAlmostEqual(float(row["lifetime_ns_unc"]), (0.8 ** 2 + 0.7 ** 2) ** 0.5, places=5)

    def test_raw_files_are_identical_to_the_repository(self):
        for path in (self.repo / "data").glob("**/*.json"):
            rel = path.relative_to(self.repo / "data").as_posix()
            self.assertEqual((self.out / "raw" / rel).read_bytes(), path.read_bytes())

    def test_archive(self):
        with zipfile.ZipFile(self.out / "mund-latest.zip") as zf:
            names = zf.namelist()
            self.assertIn("mund-latest/LT.json", names)
            self.assertIn("mund-latest/schema/v1/lt.schema.json", names)
            self.assertIsNone(zf.testzip())

    def test_site(self):
        site = Path(self.tmp.name) / "site"
        source = (self.repo / "site/assets/js/explorer/main.js").read_bytes()
        versions = build.build_site(self.repo, site, releases=False)
        self.assertEqual(versions["default"], "latest")
        self.assertFalse((site / "admin").exists(), "the data entry tool is not published")
        for rel in ("index.html", "db/index.html", "schema/v1/lt.schema.json",
                    "data/versions.json", "data/latest/manifest.json", "tests/index.html",
                    "tests/vectors/cases.json", ".nojekyll"):
            self.assertTrue((site / rel).is_file(), rel)
        self.assertFalse(list((site / "tests").glob("*.mjs")), "the Node runner is not published")

        # one folder per page, made from index.html with the addresses moved down
        for page in ("explorer", "downloads", "tools/converter", "docs", "docs/data-format", "api"):
            text = (site / page / "index.html").read_text(encoding="utf-8")
            up = "../" * (page.count("/") + 1)
            self.assertIn('src="%sassets/js/explorer/main.js?v=' % up, text, page)
            self.assertIn('class="brand" href="%s"' % up, text, page)
            self.assertIn('<body data-page="%s">' % page, text)
        doc = (site / "docs/data-format/index.html").read_text(encoding="utf-8")
        self.assertIn("<title>muND data format – Muon Nuclear Data</title>", doc)
        self.assertIn('<h2 id="6-published-files">', doc)
        self.assertIn('href="../../docs/identifiers/"', doc, "links between the documents lead to their pages")
        self.assertLess(doc.index("</h1>"), doc.index('class="doc-toc"'), "the contents follow the title")
        self.assertIn('href="https://github.com/mu-nd/mund/blob/main/docs/extraction.ja.md"', doc)
        api_page = (site / "api/index.html").read_text(encoding="utf-8")
        self.assertIn('href="../downloads/"', api_page, "links to the site itself are relative")

        # the API of the version
        self.assertEqual(json.loads((site / "api/versions.json").read_text(encoding="utf-8")), versions)
        si28 = json.loads((site / "api/latest/LT/Si-28.json").read_text(encoding="utf-8"))
        self.assertEqual(si28["format"], "muND/api/LT/1")
        self.assertEqual(si28["selection"], {"nuclide": "Si-28", "element": "Si", "z": 14, "mass": 28, "isomer": 0,
                                             "entries": len(si28["data"])})
        entry = next(e for e in si28["data"] if e["datasetId"] == "e489422fdeb4")
        self.assertEqual((entry["converted"]["lifetime_ns"], entry["converted"]["huff_source"]), (743.9, "nuclide"))
        self.assertAlmostEqual(entry["converted"]["capture_rate_us-1"], 1 / 0.7439 - 0.9924 / 2.1969811, places=5)
        self.assertEqual({m["id"] for m in si28["meta"]}, {e["metaId"] for e in si28["data"]})
        one = json.loads((site / "api/latest/LT/entry/e489422fdeb4.json").read_text(encoding="utf-8"))
        self.assertEqual(one["data"][0]["datasetId"], "e489422fdeb4")
        self.assertIn("DOI:10.48550/arXiv.2501.05897", [b["id"] for b in one["bibliography"]] + one["meta"][0]["relatedBibIds"])
        index = json.loads((site / "api/latest/LT/index.json").read_text(encoding="utf-8"))
        si = next(e for e in index["elements"] if e["element"] == "Si")
        self.assertEqual(si["file"], "Si.json")
        self.assertIn("Si-nat.json", [n["file"] for n in si["nuclides"]])
        for item in [si] + si["nuclides"]:
            self.assertTrue((site / "api/latest/LT" / item["file"]).is_file(), item["file"])
        evaluated = json.loads((site / "api/latest/LT/evaluated.json").read_text(encoding="utf-8"))
        self.assertEqual(len(evaluated["data"]), 22)
        self.assertEqual({e["datasetType"] for e in evaluated["data"]}, {"evaluated"})
        info = json.loads((site / "api/latest/info.json").read_text(encoding="utf-8"))
        self.assertEqual(info["citation"]["paper"], "Y. Watanabe et al., Muon Nuclear Data Development Project, arXiv:2605.15539 (2026).")
        self.assertRegex(info["citation"]["database"], r"^muND Project Team, muND: Muon Nuclear Data, development version \S+, "
                         r"not a stable version( \(\d{4}\))?, https://ribf\.riken\.jp/muon/explorer/\?v=latest\.$")
        self.assertEqual(si28["citation"], info["citation"], "every file says how to cite")
        self.assertEqual(info["files"], {"LT": "LT/index.json"})

        # every script and style sheet is referenced with the same stamp
        stamps = set()
        specifier = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}/[^'"]+)['"]""")
        asset = re.compile(r"""\b(?:src|href)="([^"?]+\.(?:js|css)(?:\?[^"]*)?)\"""")
        for path in site.rglob("*"):
            if path.suffix not in (".js", ".html") or "data" in path.relative_to(site).parts[:1]:
                continue
            text = path.read_text(encoding="utf-8")
            for ref in specifier.findall(text) + (asset.findall(text) if path.suffix == ".html" else []):
                if not ref.startswith("http"):
                    self.assertRegex(ref, r"\.(js|css)\?v=[0-9a-f]{10}$", "%s in %s" % (ref, path.name))
                    stamps.add(ref.split("?v=")[1])
        self.assertEqual(len(stamps), 1)
        self.assertEqual((self.repo / "site/assets/js/explorer/main.js").read_bytes(), source,
                         "the sources are not stamped")


class ReleaseBuildTests(unittest.TestCase):
    """A major release is built once from its release commit, stored in releases/ and
    published as stored; later changes of data or tools do not touch it."""

    def setUp(self):
        if shutil.which("git") is None:
            self.skipTest("git is not available")
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = make_repository(Path(self.tmp.name) / "repo")
        self.git("init", "-q", "-b", "main")
        (self.repo / "VERSION").write_text("1.0.0\n", encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "Release 1.0.0")
        self.release = self.out("rev-parse", "HEAD")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"] + list(args),
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def out(self, *args):
        return subprocess.run(["git", "-C", str(self.repo)] + list(args), check=True,
                              stdout=subprocess.PIPE, text=True).stdout.strip()

    def freeze(self):
        manifest = build.freeze_release(self.repo, self.release)
        self.git("add", "releases")
        self.git("commit", "-q", "-m", "Freeze release 1.0.0")
        self.git("tag", "v1.0.0", self.release)
        return manifest

    @staticmethod
    def hashes(folder: Path) -> dict:
        return {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(folder.rglob("*")) if p.is_file()}

    def test_frozen_release_is_published_unchanged(self):
        manifest = self.freeze()
        self.assertEqual((manifest["label"], manifest["version"], manifest["kind"], manifest["commit"]),
                         ("v1", "1.0.0", "release", self.release))
        self.assertEqual(manifest["sources"]["VERSION"], hashlib.sha256(b"1.0.0\n").hexdigest())
        self.assertIn("tools/mundlib/convert.py", manifest["builder"])
        self.assertEqual(build.verify_release(self.repo, "v1"), {"errors": [], "warnings": []})
        frozen = self.hashes(self.repo / "releases" / "v1")

        # later: a correction, a new version and a change of the conversion code
        path = self.repo / "data/LT/EXP/Mizuno2025_4d2ed5c83736.json"
        text = path.read_text(encoding="utf-8")
        self.assertIn('"value": 743.9, "unit": "ns"', text)
        path.write_text(text.replace('"value": 743.9, "unit": "ns"', '"value": 744.9, "unit": "ns"'), encoding="utf-8")
        (self.repo / "VERSION").write_text("1.0.1\n", encoding="utf-8")
        self.git("commit", "-q", "-am", "Release 1.0.1")
        self.git("tag", "v1.0.1")      # not a major release: no folder of its own

        site = Path(self.tmp.name) / "site"
        versions = build.build_site(self.repo, site)
        self.assertEqual(versions["default"], "v1")
        self.assertEqual([(v["label"], v["kind"], v["version"]) for v in versions["versions"]],
                         [("v1", "release", "1.0.0"), ("latest", "development", "1.0.1")])
        self.assertFalse((site / "data" / "v1.0.1").exists())
        self.assertEqual(self.hashes(site / "data" / "v1"), frozen, "published byte for byte as frozen")

        def si28(label):
            agg = jsonfmt.loads((site / "data" / label / "LT.json").read_text(encoding="utf-8"))
            entry = next(e for e in agg["data"] if e["datasetId"] == "e489422fdeb4")
            return jsonfmt.lexeme(entry["observable"]["lifetime"]["value"])

        self.assertEqual(si28("v1"), "743.9")
        self.assertEqual(si28("latest"), "744.9")

    def test_only_major_versions_and_only_once(self):
        self.freeze()
        with self.assertRaises(ValueError):
            build.freeze_release(self.repo, self.release)          # frozen already
        (self.repo / "VERSION").write_text("1.1.0\n", encoding="utf-8")
        self.git("commit", "-q", "-am", "Release 1.1.0")
        with self.assertRaises(ValueError):
            build.freeze_release(self.repo, "HEAD")                # minor versions are not frozen

    def test_a_changed_frozen_file_is_refused(self):
        self.freeze()
        target = self.repo / "releases/v1/csv/LT.csv"
        target.write_text(target.read_text(encoding="utf-8") + "x\n", encoding="utf-8")
        self.assertTrue(any("differs from the manifest" in e for e in build.verify_release(self.repo, "v1")["errors"]))
        with self.assertRaises(ValueError):
            build.build_site(self.repo, Path(self.tmp.name) / "site")

    def test_a_frozen_release_changed_in_a_later_commit_is_refused(self):
        self.freeze()
        manifest_path = self.repo / "releases/v1/manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["date"] = "2000-01-01T00:00:00+00:00"          # consistent with its files, but changed
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        self.git("commit", "-q", "-am", "edit a frozen release")
        self.assertTrue(any("changed after it was frozen" in e for e in build.verify_release(self.repo, "v1")["errors"]))

    def test_tag_on_another_commit_is_refused_and_a_missing_tag_is_reported(self):
        build.freeze_release(self.repo, self.release)
        self.git("add", "releases")
        self.git("commit", "-q", "-m", "Freeze release 1.0.0")
        report = build.verify_release(self.repo, "v1")
        self.assertEqual(report["errors"], [])
        self.assertTrue(any("tag v1.0.0 is missing" in w for w in report["warnings"]))
        self.git("tag", "v1.0.0", "HEAD")                         # the freeze commit, not the release commit
        self.assertTrue(any("not on the release commit" in e for e in build.verify_release(self.repo, "v1")["errors"]))


if __name__ == "__main__":
    unittest.main()
