"""Build the distributable files and assemble the static web site.

Output layout (``_site/`` by default)::

    index.html, admin/, assets/ ...     the web application (copied from site/)
    schema/v1/*.schema.json             JSON Schemas
    tests/                              browser self-test page
    data/versions.json                  list of the versions below
    data/<label>/manifest.json          what this version contains
    data/<label>/LT.json                all LT data in one file (used by the explorer)
    data/<label>/master.json            facilities, nuclides, Huff factors, constants
    data/<label>/csv/LT*.csv            flat tables including converted quantities
    data/<label>/raw/...                the source files exactly as stored in git
    data/<label>/mund-<label>.zip       everything above in one archive

``<label>`` is ``latest`` for the current state of the repository and ``v1``,
``v2`` ... for the released major versions (git tags ``v1.0.0``, ``v2.0.0``).
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import List, Optional

from . import (DATASETS, DATASET_TITLES, DATASET_TYPES, DEFINED_SUBLIBRARIES, SUBLIBRARIES,
               SUBLIBRARY_TITLES, jsonfmt)
from .convert import Physics, combined_uncertainty
from .database import MASTER_FILES, Database, first_author, quantity, reference_year

RELEASE_TAG_RE = re.compile(r"^v(\d+)\.0\.0$")
CSV_COLUMNS = [
    "datasetId", "datasetType", "element", "z", "mass", "isomer", "observable", "value",
    "uncertainty", "uncertaintyStatistical", "uncertaintySystematic", "unit", "key", "comment",
    "originalData", "metaId", "bibId", "reference", "facility", "method",
    "lifetime_ns", "lifetime_ns_unc", "capture_rate_us-1", "capture_rate_us-1_unc",
    "capture_probability_pct", "capture_probability_pct_unc", "huff_factor",
]
DERIVED = CSV_COLUMNS[CSV_COLUMNS.index("lifetime_ns"):]


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def _first(value) -> str:
    """First element of a Crossref list member such as ``title``."""
    if isinstance(value, list):
        return str(value[0]) if value else ""
    return str(value or "")


def cite_label(reference: Optional[dict], bib_id: str = "") -> str:
    """'Suzuki1987' style label."""
    family = first_author(reference)
    year = reference_year(reference)
    if family and year:
        return "%s%s" % (family, year)
    return family or str(bib_id)


def cite_text(reference: Optional[dict], bib_id: str = "") -> str:
    """'Suzuki et al., Phys. Rev. C 35, 2212 (1987)' from a bibliography entry."""
    ref = reference or {}
    authors = [a for a in ref.get("author") or [] if isinstance(a, dict)]
    if not authors:
        return _first(ref.get("title")) or str(bib_id)
    name = lambda a: str(a.get("family") or a.get("name") or "")
    who = name(authors[0])
    if len(authors) == 2:
        who += " and " + name(authors[1])
    elif len(authors) > 2:
        who += " et al."
    journal = _first(ref.get("short-container-title")) or _first(ref.get("container-title"))
    parts = [p for p in [journal, ref.get("volume")] if p]
    text = who
    if parts:
        text += ", " + " ".join(parts)
    pages = ref.get("article-number") or ref.get("page")
    if pages:
        text += ", " + re.split(r"[-\u2013]", str(pages))[0]
    year = reference_year(ref)
    if year:
        text += " (%s)" % year
    return text


def _fmt_derived(x: Optional[float]) -> str:
    return "" if x is None else "%.6g" % x


def _git(root: Path, *args: str) -> Optional[str]:
    try:
        out = subprocess.run(["git", "-C", str(root)] + list(args), check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return out.stdout.decode("utf-8").strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def read_version(root: Path) -> str:
    path = Path(root) / "VERSION"
    return path.read_text(encoding="utf-8").strip() if path.is_file() else "0.0.0"


def describe(root: Path) -> dict:
    """Version of the working tree: tag, commits since the tag, commit id."""
    base = read_version(root)
    info = {"version": base + "-dev", "commit": None, "date": None}
    commit = _git(root, "rev-parse", "HEAD")
    if not commit:
        return info
    info["commit"] = commit
    info["date"] = _git(root, "log", "-1", "--format=%cI")
    desc = _git(root, "describe", "--tags", "--long", "--match", "v[0-9]*")
    m = re.match(r"^v(.+)-(\d+)-g([0-9a-f]+)$", desc or "")
    if m and int(m.group(2)) == 0:
        info["version"] = m.group(1)
    elif m:
        info["version"] = "%s+%s.g%s" % (m.group(1), m.group(2), m.group(3))
    else:
        info["version"] = "%s-dev+g%s" % (base, commit[:7])
    if _git(root, "status", "--porcelain", "--", "data", "schema"):
        info["version"] += ".modified"
    return info


# ---------------------------------------------------------------------------
# one version of the data
# ---------------------------------------------------------------------------

def aggregate(db: Database, sublibrary: str, version: str) -> dict:
    """All files of a sub-library merged into one document.

    Every data entry is self-contained: datasetId, datasetType, nuclide,
    observable, bibId and the identifier of its metadata record.
    """
    metas, rows, bib = [], [], {}
    for f in db.files:
        obj = f.obj
        if not isinstance(obj, dict) or obj.get("sublibrary") != sublibrary:
            continue
        meta = {"id": f.meta.get("id"), "datasetType": obj.get("datasetType"),
                "file": f.path[len("data/"):]}
        meta.update({k: v for k, v in f.meta.items() if k != "id"})
        metas.append(meta)
        ref = db.reference(f.meta.get("bibId"))
        if ref is not None:
            bib[ref["DOI"]] = ref
        for row in f.data:
            entry = {"datasetId": row.get("datasetId"), "datasetType": obj.get("datasetType"),
                     "metaId": f.meta.get("id"), "bibId": f.meta.get("bibId")}
            entry.update({k: v for k, v in row.items() if k != "datasetId"})
            rows.append(entry)
    order = {d: i for i, d in enumerate(("experiment", "theory", "curated", "evaluated"))}

    def sort_key(r):
        n = r.get("nuclide") or {}
        return (db.z_of(n.get("element")), n.get("mass", 0), n.get("isomer", 0),
                order.get(r["datasetType"], 9), r["datasetId"])

    rows.sort(key=sort_key)
    metas.sort(key=lambda m: (order.get(m["datasetType"], 9), m["file"]))
    return {"format": "muND/dist/%s/1" % sublibrary, "sublibrary": sublibrary, "version": version,
            "bibliography": [bib[k] for k in sorted(bib, key=str.upper)],
            "meta": metas, "data": rows}


def _component(uncertainties, source: str) -> str:
    for u in uncertainties or []:
        if isinstance(u, dict) and u.get("source") == source:
            return jsonfmt.lexeme(u["value"])
    return ""


def csv_text(agg: dict, db: Database, physics: Physics, dataset_type: Optional[str] = None) -> str:
    metas = {m["id"]: m for m in agg["meta"]}
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for r in agg["data"]:
        if dataset_type and r["datasetType"] != dataset_type:
            continue
        meta = metas.get(r["metaId"], {})
        nuclide = r.get("nuclide") or {}
        block = quantity(r) or {}
        kind = (r.get("observable") or {}).get("kind")
        uncertainties = block.get("uncertainties") or []
        total = combined_uncertainty(uncertainties)
        z = db.z_of(nuclide.get("element"))
        conv = physics.convert(z, nuclide.get("mass", 0), kind, block.get("value"), total,
                               block.get("unit")) or {}
        if total is None:
            total_text = ""
        elif _component(uncertainties, "total"):
            total_text = _component(uncertainties, "total")      # as written in the source
        else:
            total_text = "%.6g" % total                            # combined in quadrature
        line = {
            "datasetId": r["datasetId"], "datasetType": r["datasetType"],
            "element": nuclide.get("element"), "z": z, "mass": nuclide.get("mass"),
            "isomer": nuclide.get("isomer", 0), "observable": kind,
            "value": jsonfmt.lexeme(block["value"]) if "value" in block else "",
            "uncertainty": total_text,
            "uncertaintyStatistical": _component(uncertainties, "statistical"),
            "uncertaintySystematic": _component(uncertainties, "systematic"),
            "unit": block.get("unit"), "key": r.get("key", ""), "comment": r.get("comment", ""),
            "originalData": ";".join(r.get("originalData", [])), "metaId": r["metaId"],
            "bibId": r.get("bibId", ""), "reference": cite_text(db.reference(r.get("bibId")), r.get("bibId", "")),
            "facility": meta.get("facility", ""), "method": meta.get("method", ""),
        }
        for k in DERIVED:
            line[k] = _fmt_derived(conv.get(k))
        writer.writerow([line[c] for c in CSV_COLUMNS])
    return buf.getvalue()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_dist(root, out, label: str = "latest", version: Optional[str] = None,
               commit: Optional[str] = None, date: Optional[str] = None,
               kind: str = "development") -> dict:
    """Write one version of the data to ``out`` and return its manifest."""
    root, out = Path(root), Path(out)
    db = Database.load(root)
    errors = [i for i in db.validate() if i.level == "error"]
    if errors:
        raise SystemExit("cannot build: %d validation error(s); run 'tools/mund.py validate'"
                         % len(errors))
    if version is None:
        info = describe(root)
        version, commit, date = info["version"], info["commit"], info["date"]
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    files = {}

    def emit(rel: str, text: str):
        data = text.encode("utf-8")
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files[rel] = data

    # source files, exactly as stored
    for f in list(db.files) + [db.master[n] for n in MASTER_FILES if n in db.master]:
        emit("raw/" + f.path[len("data/"):], f.text)

    master = {"format": "muND/dist/master/1", "version": version}
    for name in MASTER_FILES:
        obj = dict(db.master_obj(name))
        obj.pop("format", None)
        master[name[:-len(".json")]] = obj
    emit("master.json", jsonfmt.dumps(master))

    physics = Physics(db.master_obj("huff_factors.json"), db.master_obj("constants.json"))
    sublibraries = {}
    for sub in SUBLIBRARIES:
        entry = {"title": SUBLIBRARY_TITLES[sub], "status": "planned", "counts": {}}
        if sub in DEFINED_SUBLIBRARIES:
            agg = aggregate(db, sub, version)
            entry["status"] = "available"
            entry["counts"] = {code: sum(1 for r in agg["data"] if r["datasetType"] == name)
                               for name, code in DATASET_TYPES.items()}
            entry["references"] = len(agg["meta"])
            emit("%s.json" % sub, jsonfmt.dumps(agg))
            emit("csv/%s.csv" % sub, csv_text(agg, db, physics))
            for name, code in DATASET_TYPES.items():
                if entry["counts"][code]:
                    emit("csv/%s_%s.csv" % (sub, code), csv_text(agg, db, physics, name))
        sublibraries[sub] = entry

    schema_dir = root / "schema"
    readme = (
        "muND - Muon Nuclear Data, version %s\n"
        "=====================================\n\n"
        "raw/      source files of the database (JSON, one file per publication)\n"
        "LT.json   all LT data merged into one file\n"
        "csv/      flat tables; derived columns use the Huff factors and constants\n"
        "          in raw/master\n"
        "schema/   JSON Schemas describing the files in raw/\n\n"
        "Commit: %s\nDate:   %s\n" % (version, commit or "-", date or "-"))
    zip_name = "mund-%s.zip" % label
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        def add(name: str, data: bytes):
            zi = zipfile.ZipInfo("mund-%s/%s" % (label, name), date_time=(1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            zf.writestr(zi, data)
        add("README.txt", readme.encode("utf-8"))
        for rel in sorted(files):
            add(rel, files[rel])
        for path in sorted(schema_dir.glob("**/*.json")):
            add("schema/" + path.relative_to(schema_dir).as_posix(), path.read_bytes())
    (out / zip_name).write_bytes(buf.getvalue())

    manifest = {
        "format": "muND/manifest/1",
        "label": label,
        "version": version,
        "kind": kind,
        "commit": commit,
        "date": date,
        "datasets": {d: DATASET_TITLES[d] for d in DATASETS},
        "sublibraries": sublibraries,
        "archive": {"path": zip_name, "bytes": len(buf.getvalue())},
        "files": [{"path": rel, "bytes": len(files[rel]), "sha256": _sha256(files[rel])}
                  for rel in sorted(files)],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                                       encoding="utf-8")
    return manifest


# ---------------------------------------------------------------------------
# the web site
# ---------------------------------------------------------------------------

def release_tags(root: Path) -> List[dict]:
    """Tags that mark a major release (``v1.0.0``, ``v2.0.0`` ...), oldest first."""
    out = []
    listing = _git(root, "tag", "--list", "v*") or ""
    for tag in listing.splitlines():
        m = RELEASE_TAG_RE.match(tag.strip())
        if m:
            out.append({"tag": tag.strip(), "major": int(m.group(1))})
    return sorted(out, key=lambda t: t["major"])


def _build_release(root: Path, tag: dict, out: Path) -> Optional[dict]:
    """Build a released version with the tools of that release."""
    name = tag["tag"]
    commit = _git(root, "rev-list", "-n", "1", name)
    date = _git(root, "log", "-1", "--format=%cI", name)
    with tempfile.TemporaryDirectory() as tmp:
        try:
            archive = subprocess.run(["git", "-C", str(root), "archive", "--format=tar", name],
                                     check=True, stdout=subprocess.PIPE).stdout
        except (OSError, subprocess.CalledProcessError):
            return None
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            try:
                tar.extractall(tmp, filter="data")     # refuse links and paths outside tmp
            except TypeError:                           # Python older than 3.9.17 has no filter
                tar.extractall(tmp)
        label = "v%d" % tag["major"]
        # This command line is a contract with every released version of
        # tools/mund.py: keep "--root DIR dist --out ... --kind ..." working.
        cmd = [sys.executable, str(Path(tmp) / "tools" / "mund.py"), "--root", tmp, "dist",
               "--out", str(out / label), "--label", label,
               "--version", name[1:], "--commit", commit or "", "--date", date or "",
               "--kind", "release"]
        subprocess.run(cmd, check=True)
    return json.loads((out / label / "manifest.json").read_text(encoding="utf-8"))


_IMPORT_RE = re.compile(r"""(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}/[^'"?]+\.js)\2""")
_ASSET_RE = re.compile(r"""\b(src|href)="((?!https?:|//|#)[^"?]+\.(?:js|css))\"""")


def stamp_assets(out: Path) -> str:
    """Make the address of every script and style sheet change with its content.

    Browsers and GitHub Pages cache files for a while.  Without this, a visitor
    could run scripts of the previous deployment next to new ones.  A short
    hash of all scripts and style sheets is appended to every reference
    (``./ids.js`` -> ``./ids.js?v=1a2b3c4d5e``), in the pages and in the
    ``import`` statements, so that a new page always loads the matching code.
    Only the built site is changed; the sources in ``site/`` stay as they are.
    """
    files = sorted(p for p in out.rglob("*") if p.is_file() and p.suffix in (".js", ".mjs", ".css", ".html")
                   and "data" not in p.relative_to(out).parts[:1])
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(out).as_posix().encode("utf-8"))
        digest.update(path.read_bytes())
    stamp = digest.hexdigest()[:10]
    for path in files:
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".html":
            new = _ASSET_RE.sub(lambda m: '%s="%s?v=%s"' % (m.group(1), m.group(2), stamp), text)
            new = _IMPORT_RE.sub(lambda m: "%s%s%s?v=%s%s" % (m.group(1), m.group(2), m.group(3), stamp, m.group(2)), new)
        elif path.suffix in (".js", ".mjs"):
            new = _IMPORT_RE.sub(lambda m: "%s%s%s?v=%s%s" % (m.group(1), m.group(2), m.group(3), stamp, m.group(2)), text)
        else:
            continue
        if new != text:
            path.write_text(new, encoding="utf-8")
    return stamp


def build_site(root, out, releases: bool = True) -> dict:
    """Assemble the complete static site in ``out``."""
    root, out = Path(root), Path(out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(root / "site", out)
    shutil.copytree(root / "schema", out / "schema")
    tests = out / "tests"
    shutil.copytree(root / "tests" / "js", tests)
    shutil.copytree(root / "tests" / "vectors", tests / "vectors")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    stamp_assets(out)

    data = out / "data"
    manifests = [build_dist(root, data / "latest", "latest")]
    if releases:
        for tag in release_tags(root):
            m = _build_release(root, tag, data)
            if m:
                manifests.append(m)
    released = [m for m in manifests if m["kind"] == "release"]
    versions = {
        "format": "muND/versions/1",
        "default": released[-1]["label"] if released else "latest",
        "versions": [{"label": m["label"], "version": m["version"], "kind": m["kind"],
                      "commit": m["commit"], "date": m["date"]}
                     for m in reversed(released)] + [
                    {"label": m["label"], "version": m["version"], "kind": m["kind"],
                     "commit": m["commit"], "date": m["date"]}
                    for m in manifests if m["kind"] != "release"],
    }
    (data / "versions.json").write_text(json.dumps(versions, indent=2) + "\n", encoding="utf-8")
    return versions
