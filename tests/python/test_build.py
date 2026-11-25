import csv
import io
import hashlib
import json
import os
import posixpath
import re
import shutil
import tempfile
import unittest
import zipfile
from collections import Counter
from pathlib import Path
from unittest import mock

from helpers import FIXTURE, ROOT, commit_all, git, make_repository, needs_git
from mundlib import CODES, api, build, cite, jsonfmt, releases, site
from mundlib.database import Database

RELEASE = {"version": "9.9.9", "commit": "abc", "date": "2026-11-16T00:00:00+09:00", "kind": "release"}
FIXTURE_FILES = Database.load(FIXTURE).files


def fixture_counts(keep=lambda entry: True) -> dict:
    """The entries of the test database that ``keep`` accepts, per code (every code)."""
    counts = Counter(f.code for f in FIXTURE_FILES for entry in f.data if keep(entry))
    return {code: counts[code] for code in CODES}


COUNTS = fixture_counts()


def csv_rows(path: Path) -> list:
    return list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8"))))


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class BuildTests(unittest.TestCase):
    """One version of the data and the site, built from the test database."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.repo = make_repository(Path(cls.tmp.name) / "repo")
        cls.out = Path(cls.tmp.name) / "latest"
        cls.manifest = build.build_dist(cls.repo, cls.out, "latest", RELEASE)
        cls.site = Path(cls.tmp.name) / "site"
        cls.versions = site.build_site(cls.repo, cls.site)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_manifest(self):
        m = self.manifest
        self.assertEqual((m["label"], m["version"], m["kind"], m["commit"]), ("latest", "9.9.9", "release", "abc"))
        self.assertEqual(m["sublibraries"]["LT"]["status"], "available")
        self.assertEqual(m["sublibraries"]["LT"]["counts"], COUNTS)
        self.assertEqual(m["sublibraries"]["BR"]["status"], "planned")
        for f in m["files"]:
            self.assertEqual((self.out / f["path"]).stat().st_size, f["bytes"])
        self.assertEqual((self.out / "manifest.json").read_text(encoding="utf-8"), jsonfmt.dumps(m))

    def test_aggregate(self):
        agg = jsonfmt.loads((self.out / "LT.json").read_text(encoding="utf-8"))
        self.assertEqual(len(agg["data"]), sum(COUNTS.values()))
        metas = {m["id"] for m in agg["meta"]}
        self.assertTrue(all(e["metaId"] in metas for e in agg["data"]))
        self.assertEqual([b["id"] for b in agg["bibliography"]],
                         ["DOI:10.1103/PhysRevC.111.034614", "DOI:10.1103/vl7z-rzp8", "DOI:10.48550/arXiv.2501.05897"])
        entry = next(e for e in agg["data"] if e["datasetId"] == "e489422fdeb4")
        self.assertEqual(entry, {
            "datasetId": "e489422fdeb4", "datasetType": "experiment", "metaId": "4d2ed5c83736",
            "bibId": "DOI:10.1103/vl7z-rzp8", "nuclide": {"element": "Si", "mass": 28, "isomer": 0},
            "observable": {"kind": "lifetime", "lifetime": {
                "value": 743.9, "unit": "ns", "uncertainties": [{"source": "total", "value": 5.0}]}},
            "legacyIds": ["e2551c5951a7"]})
        si = [e for e in agg["data"] if e["nuclide"]["element"] == "Si" and e["datasetType"] == "curated"]
        self.assertEqual(jsonfmt.number_text(si[1]["observable"]["capture_rate"]["uncertainties"][0]["value"]),
                         "0.0090", "digits are kept")

    def test_master(self):
        master = read_json(self.out / "master.json")
        self.assertEqual(sorted(master), ["constants", "facilities", "format", "huff_factors", "nuclides", "version"])

    def test_csv(self):
        rows = csv_rows(self.out / "csv/LT.csv")
        self.assertEqual(len(rows), sum(COUNTS.values()))
        self.assertEqual(list(rows[0]), build.CSV_COLUMNS)
        r = next(r for r in rows if r["datasetId"] == "e489422fdeb4")
        self.assertEqual((r["datasetType"], r["element"], r["z"], r["mass"], r["observable"], r["value"],
                          r["uncertainty"], r["unit"]),
                         ("experiment", "Si", "14", "28", "lifetime", "743.9", "5.0", "ns"))
        self.assertEqual(r["reference"], "Mizuno et al., Phys. Rev. C 112, 024307 (2025)")
        self.assertAlmostEqual(float(r["capture_rate_us-1"]), 1 / 0.7439 - 0.9924 / 2.1969811, places=5)
        for code, count in COUNTS.items():          # one table per code that has entries
            path = self.out / "csv" / ("LT_%s.csv" % code)
            if count:
                self.assertEqual(len(csv_rows(path)), count, code)
            else:
                self.assertFalse(path.exists(), code)

    def test_csv_preserves_carriage_returns(self):
        lt = read_json(self.out / "LT.json")
        lt["data"] = lt["data"][:1]
        comment = "first\rsecond"
        lt["data"][0]["comment"] = comment
        text = build.csv_text(lt, read_json(self.out / "master.json"))
        records = list(csv.DictReader(io.StringIO(text, newline="")))
        self.assertEqual([r["comment"] for r in records], [comment])
        self.assertIn(',"first\rsecond",', text)
        self.assertEqual(text.count("\n"), 2)              # header and record end in LF only
        self.assertNotIn("\r\n", text)

    def test_csv_quotes_exactly_what_needs_it(self):
        self.assertEqual(build._csv_record(["a", "b,c", 'say "x"', "1\n2", "", None, 3]),
                         'a,"b,c","say ""x""","1\n2",,,3\n')

    def test_statistical_and_systematic_columns(self):
        master = jsonfmt.loads((self.out / "master.json").read_text(encoding="utf-8"))
        lt = {"bibliography": [], "meta": [{"id": "m"}], "data": [jsonfmt.loads(
            '{"datasetId": "d", "datasetType": "experiment", "metaId": "m", "bibId": "DOI:10.1103/vl7z-rzp8",'
            ' "nuclide": {"element": "Si", "mass": 0, "isomer": 0}, "observable": {"kind": "lifetime",'
            ' "lifetime": {"value": 751.4, "unit": "ns", "uncertainties": [{"source": "statistical", "value": 0.8},'
            ' {"source": "systematic", "value": 0.7}]}}}')]}
        row = next(csv.DictReader(io.StringIO(build.csv_text(lt, master))))
        self.assertEqual((row["value"], row["uncertaintyStatistical"], row["uncertaintySystematic"]),
                         ("751.4", "0.8", "0.7"))
        self.assertAlmostEqual(float(row["uncertainty"]), (0.8 ** 2 + 0.7 ** 2) ** 0.5, places=5)
        self.assertAlmostEqual(float(row["lifetime_ns_unc"]), (0.8 ** 2 + 0.7 ** 2) ** 0.5, places=5)
        parts = lt["data"][0]["observable"]["lifetime"]["uncertainties"]
        parts.extend([{"source": "statistical", "value": 0.6}, {"source": "systematic", "value": 2.4}])
        row = next(csv.DictReader(io.StringIO(build.csv_text(lt, master))))
        self.assertEqual((row["uncertaintyStatistical"], row["uncertaintySystematic"]), ("1", "2.5"))

    def test_generated_bytes_are_independent_of_platform_defaults(self):
        def write_crlf(path, data, encoding=None, errors=None):
            with path.open("w", encoding=encoding, errors=errors, newline="\r\n") as stream:
                return stream.write(data)

        sources = list(releases.source_hashes(self.repo))
        with mock.patch.object(Path, "__lt__", lambda a, b: a.as_posix().casefold() < b.as_posix().casefold()):
            self.assertEqual(list(releases.source_hashes(self.repo)), sources)

        initialize = zipfile.ZipInfo.__init__

        def windows_zip_info(info, *args, **kwargs):
            initialize(info, *args, **kwargs)
            info.create_system = 0

        out = Path(self.tmp.name) / "windows"
        with mock.patch.object(Path, "write_text", write_crlf), mock.patch.object(zipfile.ZipInfo, "__init__", windows_zip_info):
            site.build_site(self.repo, out)
        for path in self.site.rglob("*"):
            if path.is_file():
                rel = path.relative_to(self.site)
                self.assertEqual((out / rel).read_bytes(), path.read_bytes(), str(rel))
        with zipfile.ZipFile(out / "data/latest/mund-latest.zip") as archive:
            self.assertEqual({item.create_system for item in archive.infolist()}, {3})
        self.assertNotIn(b"\r", (out / "api/versions.json").read_bytes())

    def test_raw_files_are_identical_to_the_repository(self):
        for path in (self.repo / "data").glob("**/*.json"):
            rel = path.relative_to(self.repo / "data").as_posix()
            self.assertEqual((self.out / "raw" / rel).read_bytes(), path.read_bytes())

    def test_archive(self):
        with zipfile.ZipFile(self.out / "mund-latest.zip") as zf:
            names = zf.namelist()
            self.assertIn("mund-latest/LT.json", names)
            self.assertEqual(sorted(n for n in names if n.startswith("mund-latest/schema/")),
                             sorted("mund-latest/schema/v1/" + p.name for p in (ROOT / "schema/v1").glob("*.json")))
            self.assertIsNone(zf.testzip())
            config = read_json(self.repo / "site/config.json")
            readme = zf.read("mund-latest/README.txt").decode("utf-8")
            self.assertIn("Format: {0}docs/data-format/\nHow to cite: {0}?v=latest#cite\nLicence of the data: {1}\n".format(
                config["siteUrl"], config["dataLicence"] or "not decided"), readme)
            lines = readme.splitlines()
            self.assertTrue(lines[0].startswith("muND - Muon Nuclear Data, version "))
            self.assertEqual(lines[1], "=" * len(lines[0]))
            self.assertIn("raw/master", readme.split("LT.json")[0])
            self.assertLessEqual(max(map(len, lines[2:])), 80)

    def test_pages(self):
        """One folder per page, made from index.html with the addresses moved down and the page marked in the menu."""
        for rel in ("db/index.html", "schema/v1/lt.schema.json", "tests/index.html", "tests/vectors/cases.json"):
            self.assertTrue((self.site / rel).is_file(), rel)
        self.assertFalse(list((self.site / "tests").glob("*.mjs")), "the Node runner is not published")
        repository = read_json(self.repo / "site/config.json")["repository"]
        contents = []
        for page in list(site.PAGES) + list(site.DOCUMENTS):
            text = (self.site / page / "index.html").read_text(encoding="utf-8")
            up = "../" * (page.count("/") + 1) if page else ""
            self.assertIn('src="%sassets/js/pages/main.js?v=' % up, text, page)
            self.assertIn('class="brand" href="%s"' % (up or "./"), text, page)
            self.assertIn('<body data-page="%s">' % page, text, page)
            self.assertIn('id="source" href="https://github.com/%s"' % repository, text, page)
            self.assertRegex(text, r'<body [^>]*>\s*<a class="skip-link" href="#main">Skip to content</a>')
            self.assertRegex(text, r'<main [^>]*id="main"[^>]*tabindex="-1"')
            menu = re.search(r'<nav class="site-nav".*?</nav>', text, re.S).group(0)
            links = {posixpath.normpath(posixpath.join(page, href)): marked
                     for href, marked in re.findall(r'href="([^"]*)"( aria-current="page")?', menu)}
            for target in links:
                self.assertTrue((self.site / target / "index.html").is_file(), "%s: %s" % (page, target))
            section = "docs" if page.startswith("docs") or page == "tools/converter" else page
            self.assertEqual([target for target, marked in links.items() if marked], [section or "."], page)
            if 'class="doc-toc"' in text:
                contents.append(page)
                self.assertLess(text.index("</h1>"), text.index('class="doc-toc"'), "%s: the contents follow the title" % page)
        self.assertTrue(contents, "longer documents have contents")

    def test_links_of_the_pages_to_sections_of_documents(self):
        links = [m for path in (ROOT / "site/assets/js").glob("**/*.js")
                 for m in re.findall(r"pageUrl\('([^']+)'\)\}#([\w-]+)", path.read_text(encoding="utf-8"))]
        self.assertIn(("docs/data-format", "csv-columns"), links)
        for page, ident in links:
            self.assertIn('id="%s"' % ident, (self.site / page / "index.html").read_text(encoding="utf-8"), page)

    def test_the_csv_columns_are_documented_in_order(self):
        text = (ROOT / "docs/data-format.md").read_text(encoding="utf-8")
        section = text.split("### CSV columns\n", 1)[1].split("\n#", 1)[0]
        names = [line.split("|")[1] for line in section.splitlines() if line.startswith("| `")]
        self.assertEqual(re.findall(r"`([^`]+)`", "".join(names)), build.CSV_COLUMNS)

    def test_api_extreme_lifetime(self):
        with tempfile.TemporaryDirectory() as temp:
            dist = Path(temp)
            for name in ("manifest.json", "master.json"):
                (dist / name).write_bytes((self.out / name).read_bytes())
            lt = read_json(self.out / "LT.json")
            entry = next(e for e in lt["data"] if e["observable"]["kind"] == "lifetime")
            entry["observable"]["lifetime"].update(value=1e-180, unit="ns", uncertainties=[])
            jsonfmt.write(dist / "LT.json", lt)
            api.build_api(dist, dist / "api", read_json(self.repo / "site/config.json"))
            result = read_json(dist / "api/LT/entry" / (entry["datasetId"] + ".json"))["data"][0]["converted"]
            self.assertEqual(result["capture_rate_us-1"], 1e183)
            self.assertIsNone(result["capture_rate_us-1_unc"])

    def test_api(self):
        self.assertEqual(self.versions["default"], "latest")
        self.assertEqual(read_json(self.site / "api/versions.json"), self.versions)
        info = read_json(self.site / "api/latest/info.json")
        self.assertEqual(info["citation"], cite.citations(read_json(self.repo / "site/config.json"),
                                                          read_json(self.site / "data/latest/manifest.json")))
        self.assertEqual(info["files"], {"LT": "LT/index.json"})
        lt = self.site / "api/latest/LT"

        index = read_json(lt / "index.json")
        for element in index["elements"]:
            self.assertEqual(element["counts"], fixture_counts(lambda e: e["nuclide"]["element"] == element["element"]),
                             "%s: every code, as in the manifest" % element["element"])
            for item in [element] + element["nuclides"]:
                self.assertTrue((lt / item["file"]).is_file(), item["file"])
        si = next(e for e in index["elements"] if e["element"] == "Si")
        self.assertEqual(si["file"], "Si.json")
        self.assertIn("Si-nat.json", [n["file"] for n in si["nuclides"]])

        si28 = read_json(lt / "Si-28.json")
        self.assertEqual(si28["format"], "muND/api/LT/1")
        self.assertEqual(si28["selection"], {"nuclide": "Si-28", "element": "Si", "z": 14, "mass": 28, "isomer": 0,
                                             "entries": len(si28["data"])})
        self.assertEqual(si28["citation"], info["citation"], "every file says how to cite")
        entry = next(e for e in si28["data"] if e["datasetId"] == "e489422fdeb4")
        self.assertEqual((entry["converted"]["lifetime_ns"], entry["converted"]["huff_source"]), (743.9, "nuclide"))
        self.assertAlmostEqual(entry["converted"]["capture_rate_us-1"], 1 / 0.7439 - 0.9924 / 2.1969811, places=5)
        self.assertEqual({m["id"] for m in si28["meta"]}, {e["metaId"] for e in si28["data"]})

        one = read_json(lt / "entry/e489422fdeb4.json")
        self.assertEqual(one["data"][0]["datasetId"], "e489422fdeb4")
        self.assertTrue(one["citation"]["database"].endswith("explorer/?v=latest&z=14&id=e489422fdeb4."))
        self.assertIn("DOI:10.48550/arXiv.2501.05897", [b["id"] for b in one["bibliography"]])
        evaluated = read_json(lt / "evaluated.json")
        self.assertEqual(len(evaluated["data"]), COUNTS["EVAL"])
        self.assertEqual({e["datasetType"] for e in evaluated["data"]}, {"evaluated"})

    def test_meta_file_for_a_publication_without_entries(self):
        dist = Path(self.tmp.name) / "empty-dist"
        shutil.copytree(self.out, dist)
        lt = read_json(dist / "LT.json")
        meta = next(m for m in lt["meta"] if m.get("relatedBibIds"))
        lt["data"] = [e for e in lt["data"] if e["metaId"] != meta["id"]]
        jsonfmt.write(dist / "LT.json", lt)
        out = Path(self.tmp.name) / "empty-api"
        api.build_api(dist, out, read_json(self.repo / "site/config.json"))
        doc = read_json(out / "LT/meta" / (meta["id"] + ".json"))
        self.assertEqual(doc["data"], [])
        self.assertEqual(doc["meta"], [meta])
        self.assertEqual({r["id"] for r in doc["bibliography"]}, {meta["bibId"], *meta["relatedBibIds"]})

    def test_integral_mass_spellings_share_an_api_file(self):
        dist = Path(self.tmp.name) / "mass-dist"
        shutil.copytree(self.out, dist)
        lt = read_json(dist / "LT.json")
        entries = [e for e in lt["data"] if e["nuclide"] == {"element": "Si", "mass": 28, "isomer": 0}]
        entries[0]["nuclide"]["mass"] = 28.0
        jsonfmt.write(dist / "LT.json", lt)
        out = Path(self.tmp.name) / "mass-api"
        api.build_api(dist, out, read_json(self.repo / "site/config.json"))
        self.assertEqual([p.name for p in (out / "LT").glob("Si-28*.json")], ["Si-28.json"])
        self.assertEqual(len(read_json(out / "LT/Si-28.json")["data"]), len(entries))

    def test_stamps(self):
        """Every script and style sheet is referenced with the same stamp; the sources are not stamped; the documents load no data code."""
        stamps = set()
        specifier = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}/[^'"]+)['"]""")
        asset = re.compile(r"""\b(?:src|href)="([^"?]+\.(?:js|css)(?:\?[^"]*)?)\"""")
        for path in self.site.rglob("*"):
            if path.suffix not in (".js", ".html") or "data" in path.relative_to(self.site).parts[:1]:
                continue
            text = path.read_text(encoding="utf-8")
            for ref in specifier.findall(text) + (asset.findall(text) if path.suffix == ".html" else []):
                if not ref.startswith("http"):
                    self.assertRegex(ref, r"\.(js|css)\?v=[0-9a-f]{10}$", "%s in %s" % (ref, path.name))
                    stamps.add(ref.split("?v=")[1])
        self.assertEqual(len(stamps), 1)
        main = "site/assets/js/pages/main.js"
        source = (self.repo / main).read_text(encoding="utf-8")
        self.assertEqual(source, (ROOT / main).read_text(encoding="utf-8"), "the sources are not stamped")
        # each page loads only its own module, named after its folder
        pages = re.findall(r"""load: \(\) => import\(['"]\./([a-z]+\.js)['"]\)""", source)
        self.assertEqual(pages, ["home.js", "explorer.js", "downloads.js", "converter.js"])
        for page in pages:
            self.assertNotRegex(source, r"""\bfrom\s*['"]\./%s""" % re.escape(page))
        # the documents load no data code: main.js reaches it only through import()
        static = re.compile(r"""\bfrom\s*['"](\.{1,2}/[^'"]+\.js)['"]""")
        js = (ROOT / "site/assets/js").resolve()
        reached, todo = set(), [js / "pages/main.js"]
        while todo:
            path = todo.pop()
            for ref in static.findall(path.read_text(encoding="utf-8")):
                module = (path.parent / ref).resolve()
                if module not in reached:
                    reached.add(module)
                    todo.append(module)
        reached = {p.relative_to(js).as_posix() for p in reached}
        self.assertFalse(reached & {"pages/store.js", "pages/model.js", "core/database.js"}, sorted(reached))
        built = (self.site / "assets/js/pages/main.js").read_text(encoding="utf-8")
        self.assertEqual(re.findall(r"""load: \(\) => import\(['"]\./([a-z]+\.js)\?v=%s['"]\)""" % stamps.pop(), built), pages)

    def test_site_is_built_only_over_an_earlier_build(self):
        other = Path(self.tmp.name) / "other"
        other.mkdir()
        (other / "keep.txt").write_text("keep\n", encoding="utf-8")
        before = sorted(self.repo.rglob("*"))
        for out in (self.repo, self.repo.parent, other):
            with self.assertRaises(ValueError):
                site.build_site(self.repo, out)
        self.assertEqual(sorted(self.repo.rglob("*")), before, "the repository is untouched")
        self.assertEqual((other / "keep.txt").read_text(encoding="utf-8"), "keep\n")
        afile = Path(self.tmp.name) / "afile"
        afile.write_text("keep\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            site.build_site(self.repo, afile)
        self.assertEqual(afile.read_text(encoding="utf-8"), "keep\n")
        earlier = Path(self.tmp.name) / "earlier"
        (earlier / "api").mkdir(parents=True)
        (earlier / "api/versions.json").write_text("{}\n", encoding="utf-8")
        (earlier / "old.txt").write_text("old\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "not a site built by mund.py"):
            site.build_site(self.repo, earlier)
        self.assertEqual((earlier / "old.txt").read_bytes(), b"old\n")

        site.build_site(self.repo, other / "generated")
        generated = other / "generated"
        self.assertEqual(site.build_site(self.repo, generated), self.versions)
        for rel in ("notes.txt", "index.html"):
            path = generated / rel
            path.write_bytes(b"keep")
            with self.assertRaisesRegex(ValueError, "not a site built by mund.py"):
                site.build_site(self.repo, generated)
            self.assertEqual(path.read_bytes(), b"keep")
            path.unlink()

    def test_output_inside_a_copied_folder_is_refused(self):
        for rel in ("site", "schema", "tests/js", "tests/vectors"):
            out = self.repo / rel / "preview"
            with self.subTest(rel=rel), mock.patch.object(site, "_assemble", side_effect=AssertionError("assembly started")):
                with self.assertRaisesRegex(ValueError, "copied"):
                    site.build_site(self.repo, out)
            self.assertFalse(out.exists())

    def test_output_link_inside_a_copied_folder_is_refused(self):
        external = Path(self.tmp.name) / "empty"
        external.mkdir()
        out = self.repo / "site/assets/preview"
        out.symlink_to(external, target_is_directory=True)
        try:
            with mock.patch.object(site, "_assemble", side_effect=AssertionError("assembly started")):
                with self.assertRaises(ValueError):
                    site.build_site(self.repo, out)
        finally:
            out.unlink()

    def test_relative_output_from_inside_an_earlier_build(self):
        earlier = Path(self.tmp.name) / "inside"
        site.build_site(self.repo, earlier)
        cwd = os.getcwd()
        try:
            for out in (".", "../inside"):
                os.chdir(earlier)
                with self.subTest(out=out):
                    self.assertEqual(site.build_site(self.repo, out), self.versions)
                    os.chdir(self.tmp.name)
                    self.assertTrue((earlier / "api/versions.json").is_file())
                    self.assertEqual(list(earlier.parent.glob(".inside-*")), [], "no temporary folder is left")
        finally:
            os.chdir(cwd)

    def test_install_failure_restores_the_whole_site(self):
        out = Path(self.tmp.name) / "install"
        site.build_site(self.repo, out)
        before = ReleaseBuildTests.hashes(out)
        rename = Path.rename

        def fail_install(path, dest):
            if path.name == "site" and dest == out:
                raise OSError("install failed")
            return rename(path, dest)

        with mock.patch.object(Path, "rename", fail_install), self.assertRaisesRegex(OSError, "install failed"):
            site.build_site(self.repo, out)
        self.assertEqual(ReleaseBuildTests.hashes(out), before)
        self.assertEqual(list(out.parent.glob(".install-*")), [])

    def test_a_failed_build_leaves_the_earlier_build(self):
        earlier = Path(self.tmp.name) / "earlier-failed"
        site.build_site(self.repo, earlier)
        before = (earlier / "api/versions.json").read_bytes()
        path = next(p for p in sorted((self.repo / "data").rglob("*.json")) if '"unit": "ns"' in p.read_text(encoding="utf-8"))
        text = path.read_text(encoding="utf-8")
        path.write_text(text.replace('"unit": "ns"', '"unit": "nsX"', 1), encoding="utf-8")
        try:
            with self.assertRaises(ValueError):
                site.build_site(self.repo, earlier)
        finally:
            path.write_text(text, encoding="utf-8")
        self.assertEqual((earlier / "api/versions.json").read_bytes(), before, "the earlier build is kept")
        self.assertEqual(list(earlier.parent.glob(".earlier-failed-*")), [], "no temporary folder is left")
        self.assertEqual(site.build_site(self.repo, earlier), self.versions)


@needs_git
class DescribeTests(unittest.TestCase):
    """The version label of the working tree (docs/versioning.md), which names the latest data
    in versions.json, the manifests, the zip README and the citations."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = make_repository(Path(self.tmp.name) / "repo")

    def tearDown(self):
        self.tmp.cleanup()

    def version(self) -> str:
        return build.describe(self.repo)["version"]

    def test_invalid_version_text_and_release_like_tag_are_reported(self):
        (self.repo / "VERSION").write_text("preview\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "VERSION"):
            self.version()
        (self.repo / "VERSION").write_text("1.0.0\n", encoding="utf-8")
        commit_all(self.repo, "Test", "initial")
        git(self.repo, "tag", "v1-preview")
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "next")
        with self.assertRaisesRegex(ValueError, "v1-preview"):
            self.version()

    def test_untracked_data_mark_the_build_modified(self):
        path = next((self.repo / "data/LT/EVAL").glob("*.json"))
        contents = path.read_bytes()
        path.unlink()
        commit_all(self.repo, "Test", "initial")
        git(self.repo, "config", "status.showUntrackedFiles", "no")
        path.write_bytes(contents)
        for ignored in (False, True):
            with self.subTest(ignored=ignored):
                if ignored:
                    (self.repo / ".gitignore").write_text(path.name + "\n", encoding="utf-8")
                self.assertTrue(self.version().endswith(".modified"))

    def test_version_label(self):
        git(self.repo, "init", "-q", "-b", "main")
        self.assertEqual(build.describe(self.repo),
                         {"version": "0.0.1-dev", "commit": None, "date": None, "kind": "development"})
        commit_all(self.repo, "Test", "initial")
        dev = "0.0.1-dev+g" + git(self.repo, "rev-parse", "HEAD")[:7]
        info = build.describe(self.repo)
        self.assertEqual((info["version"], info["kind"]), (dev, "development"))

        # uncommitted changes: only a source of the version marks it modified
        for rel, suffix in (("docs/README.md", ""), ("data/master/constants.json", ".modified"),
                            ("site/assets/js/core/format.js", ".modified"), ("site/config.json", ".modified")):
            path = self.repo / rel
            text = path.read_text(encoding="utf-8")
            path.write_text(text + "\n", encoding="utf-8")
            self.assertEqual(self.version(), dev + suffix, rel)
            path.write_text(text, encoding="utf-8")

        git(self.repo, "tag", "v0.0.1")
        self.assertEqual(self.version(), "0.0.1")
        path = self.repo / "data/master/constants.json"
        path.write_text(path.read_text(encoding="utf-8") + "\n", encoding="utf-8")
        git(self.repo, "commit", "-q", "-am", "next")
        self.assertEqual(self.version(), "0.0.1+1.g" + git(self.repo, "rev-parse", "--short", "HEAD"))
        git(self.repo, "tag", "v9.9.9")          # a tag on a commit whose VERSION is 0.0.1
        with self.assertRaises(ValueError):
            build.describe(self.repo)


@needs_git
class ReleaseBuildTests(unittest.TestCase):
    """A major release is built once from its release commit, stored in releases/ and
    published as stored; later changes of data or tools do not touch it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = make_repository(Path(self.tmp.name) / "repo")
        (self.repo / "VERSION").write_text("1.0.0\n", encoding="utf-8")
        commit_all(self.repo, "Test", "Release 1.0.0")
        self.release = git(self.repo, "rev-parse", "HEAD")

    def tearDown(self):
        self.tmp.cleanup()

    def freeze(self):
        manifest = releases.freeze_release(self.repo, self.release)
        git(self.repo, "add", "releases")
        git(self.repo, "commit", "-q", "-m", "Freeze release 1.0.0")
        git(self.repo, "tag", "v1.0.0", self.release)
        return manifest

    @staticmethod
    def hashes(folder: Path) -> dict:
        return {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(folder.rglob("*")) if p.is_file()}

    def test_frozen_release_is_published_unchanged(self):
        manifest = self.freeze()
        self.assertEqual((manifest["label"], manifest["version"], manifest["kind"], manifest["commit"]),
                         ("v1", "1.0.0", "release", self.release))
        with zipfile.ZipFile(self.repo / "releases/v1/mund-v1.zip") as archive:
            self.assertIn(b"?v=v1#cite\n", archive.read("mund-v1/README.txt"))
        self.assertEqual(manifest["sources"]["VERSION"], hashlib.sha256(b"1.0.0\n").hexdigest())
        self.assertEqual(manifest["sources"]["site/config.json"],
                         hashlib.sha256((self.repo / "site/config.json").read_bytes()).hexdigest())
        self.assertEqual(releases.verify_release(self.repo, "v1"), {"errors": [], "warnings": []})
        frozen = self.hashes(self.repo / "releases" / "v1")

        # later: a correction, a new version and a change of the conversion code
        path = self.repo / "data/LT/EXP/Mizuno2025_4d2ed5c83736.json"
        text = path.read_text(encoding="utf-8")
        self.assertIn('"value": 743.9, "unit": "ns"', text)
        path.write_text(text.replace('"value": 743.9, "unit": "ns"', '"value": 744.9, "unit": "ns"'), encoding="utf-8")
        (self.repo / "VERSION").write_text("1.0.1\n", encoding="utf-8")
        git(self.repo, "commit", "-q", "-am", "Release 1.0.1")
        git(self.repo, "tag", "v1.0.1")      # not a major release: no folder of its own

        built = Path(self.tmp.name) / "site"
        versions = site.build_site(self.repo, built)
        self.assertEqual(versions["default"], "v1")
        self.assertEqual([(v["label"], v["kind"], v["version"]) for v in versions["versions"]],
                         [("v1", "release", "1.0.0"), ("latest", "development", "1.0.1")])
        self.assertFalse((built / "data" / "v1.0.1").exists())
        self.assertEqual(self.hashes(built / "data" / "v1"), frozen, "published byte for byte as frozen")

        def si28(label):
            agg = jsonfmt.loads((built / "data" / label / "LT.json").read_text(encoding="utf-8"))
            entry = next(e for e in agg["data"] if e["datasetId"] == "e489422fdeb4")
            return jsonfmt.number_text(entry["observable"]["lifetime"]["value"])

        self.assertEqual(si28("v1"), "743.9")
        self.assertEqual(si28("latest"), "744.9")

    def test_files_git_ignores_are_not_part_of_a_release(self):
        (self.repo / ".gitignore").write_text(".DS_Store\n", encoding="utf-8")
        self.freeze()
        frozen = self.hashes(self.repo / "releases" / "v1")
        for rel in (".DS_Store", "csv/.DS_Store"):
            (self.repo / "releases" / "v1" / rel).write_bytes(b"Finder")
        self.assertEqual(releases.verify_release(self.repo, "v1")["errors"], [])
        built = Path(self.tmp.name) / "site"
        site.build_site(self.repo, built)
        self.assertEqual(self.hashes(built / "data" / "v1"), frozen)
        (self.repo / "releases" / "v1" / "stray.txt").write_text("x", encoding="utf-8")
        self.assertIn("v1: stray.txt is not listed in the manifest", releases.verify_release(self.repo, "v1")["errors"])

    def test_only_major_versions_and_only_once(self):
        self.freeze()
        with self.assertRaises(ValueError):
            releases.freeze_release(self.repo, self.release)          # frozen already
        (self.repo / "VERSION").write_text("1.1.0\n", encoding="utf-8")
        git(self.repo, "commit", "-q", "-am", "Release 1.1.0")
        with self.assertRaises(ValueError):
            releases.freeze_release(self.repo, "HEAD")                # minor versions are not frozen

    def test_a_changed_frozen_file_is_refused(self):
        self.freeze()
        target = self.repo / "releases/v1/csv/LT.csv"
        target.write_text(target.read_text(encoding="utf-8") + "x\n", encoding="utf-8")
        self.assertTrue(any("differs from the manifest" in e for e in releases.verify_release(self.repo, "v1")["errors"]))
        with self.assertRaises(ValueError):
            site.build_site(self.repo, Path(self.tmp.name) / "site")

    def test_release_manifest_fields_sizes_and_paths(self):
        original = self.freeze()
        snapshot = Path(self.tmp.name) / "snapshot"
        folder = snapshot / "releases/v1"
        shutil.copytree(self.repo / "releases/v1", folder)
        path = folder / "manifest.json"

        def errors(manifest):
            jsonfmt.write(path, manifest)
            return releases.verify_release(snapshot, "v1")["errors"]

        for key in original:
            with self.subTest(missing=key):
                self.assertTrue(errors({k: v for k, v in original.items() if k != key}))
        for key in ("files", "archive"):
            manifest = json.loads(json.dumps(original))
            record = manifest[key][0] if key == "files" else manifest[key]
            record["bytes"] += 1
            with self.subTest(size=key):
                self.assertTrue(any("size" in e for e in errors(manifest)))
        record = original["files"][0]
        alias = folder / "alias"
        alias.symlink_to(record["path"])
        for rel in ("../v1/" + record["path"], str(folder / record["path"]), "alias"):
            with self.subTest(path=rel):
                self.assertTrue(any("path" in e for e in errors(dict(original, files=[
                    *original["files"], dict(record, path=rel)]))))
        self.assertTrue(errors([]))

    def test_unavailable_release_commit_still_checks_local_history_and_tag(self):
        manifest = self.freeze()
        manifest["commit"] = "0" * 40
        jsonfmt.write(self.repo / "releases/v1/manifest.json", manifest)
        git(self.repo, "commit", "-qam", "edit release")
        report = releases.verify_release(self.repo, "v1")
        self.assertTrue(any("not in this repository" in w for w in report["warnings"]))
        self.assertTrue(any("changed after it was frozen" in e for e in report["errors"]))
        self.assertTrue(any("not on the release commit" in e for e in report["errors"]))

    def test_a_frozen_release_changed_in_a_later_commit_is_refused(self):
        self.freeze()
        manifest_path = self.repo / "releases/v1/manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["date"] = "2000-01-01T00:00:00+00:00"          # consistent with its files, but changed
        jsonfmt.write(manifest_path, manifest)
        git(self.repo, "commit", "-q", "-am", "edit a frozen release")
        self.assertTrue(any("changed after it was frozen" in e for e in releases.verify_release(self.repo, "v1")["errors"]))

    def test_tag_on_another_commit_is_refused_and_a_missing_tag_is_reported(self):
        releases.freeze_release(self.repo, self.release)
        git(self.repo, "add", "releases")
        git(self.repo, "commit", "-q", "-m", "Freeze release 1.0.0")
        report = releases.verify_release(self.repo, "v1")
        self.assertEqual(report["errors"], [])
        self.assertTrue(any("tag v1.0.0 is missing" in w for w in report["warnings"]))
        git(self.repo, "tag", "v1.0.0", "HEAD")                         # the freeze commit, not the release commit
        self.assertTrue(any("not on the release commit" in e for e in releases.verify_release(self.repo, "v1")["errors"]))


if __name__ == "__main__":
    unittest.main()
