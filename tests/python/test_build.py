import csv
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from helpers import ROOT
from mundlib import build, jsonfmt


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / "latest"
        cls.manifest = build.build_dist(ROOT, cls.out, "latest", "9.9.9", "abc", "2026-11-16T00:00:00+09:00")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_manifest(self):
        m = self.manifest
        self.assertEqual(m["version"], "9.9.9")
        self.assertEqual(m["sublibraries"]["LT"]["status"], "available")
        self.assertEqual(m["sublibraries"]["LT"]["counts"], {"EXP": 67, "TH": 0, "CUR": 8, "EVAL": 580})
        self.assertEqual(m["sublibraries"]["BR"]["status"], "planned")
        for f in m["files"]:
            self.assertEqual((self.out / f["path"]).stat().st_size, f["bytes"])

    def test_aggregate(self):
        agg = jsonfmt.loads((self.out / "LT.json").read_text(encoding="utf-8"))
        self.assertEqual(len(agg["data"]), 655)
        metas = {m["id"] for m in agg["meta"]}
        self.assertTrue(all(r["metaId"] in metas for r in agg["data"]))
        self.assertEqual([b["DOI"] for b in agg["bibliography"]],
                         ["10.1103/PhysRevC.111.034614", "10.1103/PhysRevC.35.2212", "10.1103/vl7z-rzp8"])
        # every entry is self-contained
        entry = next(r for r in agg["data"] if r["datasetId"] == "e2551c5951a7")
        self.assertEqual(jsonfmt.plain(entry), {
            "datasetId": "e2551c5951a7", "datasetType": "experiment", "metaId": "dcb3b051457e",
            "bibId": "10.1103/vl7z-rzp8", "nuclide": {"element": "Si", "mass": 28, "isomer": 0},
            "observable": {"kind": "lifetime", "lifetime": {
                "value": 743.9, "unit": "ns", "uncertainties": [{"source": "total", "value": 5.0}]}}})
        si = [r for r in agg["data"] if r["nuclide"]["element"] == "Si" and r["datasetType"] == "curated"]
        self.assertEqual(jsonfmt.lexeme(si[1]["observable"]["capture_rate"]["uncertainties"][0]["value"]),
                         "0.0090")   # digits kept

    def test_csv(self):
        rows = list(csv.DictReader(io.StringIO((self.out / "csv/LT.csv").read_text(encoding="utf-8"))))
        self.assertEqual(len(rows), 655)
        self.assertEqual(list(rows[0]), build.CSV_COLUMNS)
        r = next(r for r in rows if r["datasetId"] == "e2551c5951a7")
        self.assertEqual((r["datasetType"], r["element"], r["z"], r["mass"], r["observable"], r["value"],
                          r["uncertainty"], r["unit"]),
                         ("experiment", "Si", "14", "28", "lifetime", "743.9", "5.0", "ns"))
        self.assertEqual(r["reference"], "Mizuno et al., Phys. Rev. C 112, 024307 (2025)")
        self.assertAlmostEqual(float(r["capture_rate_us-1"]), 1 / 0.7439 - 0.9924 / 2.1969811, places=5)
        exp = list(csv.DictReader(io.StringIO((self.out / "csv/LT_EXP.csv").read_text(encoding="utf-8"))))
        self.assertEqual(len(exp), 67)
        self.assertFalse((self.out / "csv/LT_TH.csv").exists())

    def test_raw_files_are_identical_to_the_repository(self):
        for path in (ROOT / "data").glob("**/*.json"):
            rel = path.relative_to(ROOT / "data").as_posix()
            self.assertEqual((self.out / "raw" / rel).read_bytes(), path.read_bytes())

    def test_archive(self):
        with zipfile.ZipFile(self.out / "mund-latest.zip") as zf:
            names = zf.namelist()
            self.assertIn("mund-latest/LT.json", names)
            self.assertIn("mund-latest/schema/v1/lt.schema.json", names)
            self.assertIsNone(zf.testzip())

    def test_citation_text(self):
        ref = {"DOI": "10.1234/x", "author": [{"family": "Suzuki"}, {"family": "Measday"}, {"family": "Roalsvig"}],
               "container-title": ["Physical Review C"], "short-container-title": ["Phys. Rev. C"],
               "volume": "35", "page": "2212-2224", "published": {"date-parts": [[1987, 6, 1]]}}
        self.assertEqual(build.cite_text(ref), "Suzuki et al., Phys. Rev. C 35, 2212 (1987)")
        self.assertEqual(build.cite_label(ref), "Suzuki1987")
        self.assertEqual(build.cite_text(dict(ref, **{"article-number": "024307"})),
                         "Suzuki et al., Phys. Rev. C 35, 024307 (1987)")
        self.assertEqual(build.cite_text(None, "10.1000/unpublished"), "10.1000/unpublished")
        self.assertEqual(build.cite_text({"title": ["A report"]}, "10.1000/mund.x"), "A report")

    def test_statistical_and_systematic_columns(self):
        from mundlib.database import Database
        db = Database.load(ROOT)
        physics = build.Physics(db.master_obj("huff_factors.json"), db.master_obj("constants.json"))
        agg = {"meta": [{"id": "m"}], "data": [{
            "datasetId": "d", "datasetType": "experiment", "metaId": "m", "bibId": "10.1103/vl7z-rzp8",
            "nuclide": {"element": "Si", "mass": 0, "isomer": 0},
            "observable": {"kind": "lifetime", "lifetime": {"value": jsonfmt.make_number("751.4"), "unit": "ns",
                           "uncertainties": [{"source": "statistical", "value": jsonfmt.make_number("0.8")},
                                             {"source": "systematic", "value": jsonfmt.make_number("0.7")}]}}}]}
        row = next(csv.DictReader(io.StringIO(build.csv_text(agg, db, physics))))
        self.assertEqual((row["value"], row["uncertaintyStatistical"], row["uncertaintySystematic"]),
                         ("751.4", "0.8", "0.7"))
        self.assertAlmostEqual(float(row["uncertainty"]), (0.8 ** 2 + 0.7 ** 2) ** 0.5, places=5)
        self.assertAlmostEqual(float(row["lifetime_ns_unc"]), (0.8 ** 2 + 0.7 ** 2) ** 0.5, places=5)

    def test_site(self):
        site = Path(self.tmp.name) / "site"
        versions = build.build_site(ROOT, site, releases=False)
        self.assertEqual(versions["default"], "latest")
        for rel in ("index.html", "admin/index.html", "schema/v1/lt.schema.json",
                    "data/versions.json", "data/latest/manifest.json", "tests/index.html", ".nojekyll"):
            self.assertTrue((site / rel).is_file(), rel)
        json.loads((site / "data/versions.json").read_text(encoding="utf-8"))

    def test_every_script_reference_carries_the_same_stamp(self):
        """No module may be loaded under two addresses (stale and fresh copies would mix)."""
        import re
        site = Path(self.tmp.name) / "stamped"
        build.build_site(ROOT, site, releases=False)
        stamps = set()
        specifier = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}/[^'"]+)['"]""")
        asset = re.compile(r"""\b(?:src|href)="([^"?]+\.(?:js|css)(?:\?[^"]*)?)\"""")
        checked = 0
        for path in site.rglob("*"):
            if path.suffix not in (".js", ".mjs", ".html") or not path.is_file():
                continue
            text = path.read_text(encoding="utf-8")
            found = specifier.findall(text) + (asset.findall(text) if path.suffix == ".html" else [])
            for ref in found:
                if ref.startswith("http"):
                    continue
                self.assertRegex(ref, r"\.(js|css)\?v=[0-9a-f]{10}$", "%s in %s" % (ref, path.name))
                stamps.add(ref.split("?v=")[1])
                checked += 1
        self.assertGreater(checked, 60)
        self.assertEqual(len(stamps), 1)
        # the sources themselves are not touched
        self.assertNotIn("?v=", (ROOT / "site/assets/js/explorer/main.js").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()


class ReleaseBuildTests(unittest.TestCase):
    """Released versions are built from their tags, with the tools of the tag."""

    def test_frozen_release_next_to_latest(self):
        import shutil
        import subprocess

        if shutil.which("git") is None:
            self.skipTest("git is not available")
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            ignore = shutil.ignore_patterns(".git", ".venv", "_site", "dev", "__pycache__", ".claude")
            shutil.copytree(ROOT, repo, ignore=ignore)

            def git(*args):
                subprocess.run(["git", "-C", str(repo), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                                "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"] + list(args),
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            git("init", "-q", "-b", "main")
            (repo / "VERSION").write_text("1.0.0\n", encoding="utf-8")
            git("add", "-A")
            git("commit", "-q", "-m", "Release 1.0.0")
            git("tag", "v1.0.0")
            # a correction after the release: must show up in latest only
            path = repo / "data/LT/EXP/Mizuno2025_dcb3b051457e.json"
            text = path.read_text(encoding="utf-8")
            self.assertIn('"value": 743.9, "unit": "ns"', text)
            path.write_text(text.replace('"value": 743.9, "unit": "ns"', '"value": 744.9, "unit": "ns"'),
                            encoding="utf-8")
            git("commit", "-q", "-am", "correct a value")
            git("tag", "v1.0.1")      # not a major release: no folder of its own

            site = Path(tmp) / "site"
            versions = build.build_site(repo, site)
            self.assertEqual(versions["default"], "v1")
            self.assertEqual([(v["label"], v["kind"]) for v in versions["versions"]],
                             [("v1", "release"), ("latest", "development")])
            self.assertEqual(versions["versions"][0]["version"], "1.0.0")
            self.assertEqual(versions["versions"][1]["version"], "1.0.1")
            self.assertFalse((site / "data" / "v1.0.1").exists())

            def si28(label):
                agg = jsonfmt.loads((site / "data" / label / "LT.json").read_text(encoding="utf-8"))
                entry = next(r for r in agg["data"] if r["datasetId"] == "e2551c5951a7")
                return jsonfmt.lexeme(entry["observable"]["lifetime"]["value"])

            self.assertEqual(si28("v1"), "743.9")
            self.assertEqual(si28("latest"), "744.9")
            manifest = json.loads((site / "data/v1/manifest.json").read_text(encoding="utf-8"))
            self.assertEqual((manifest["label"], manifest["version"], manifest["kind"]), ("v1", "1.0.0", "release"))
            self.assertTrue((site / "data/v1/mund-v1.zip").is_file())
