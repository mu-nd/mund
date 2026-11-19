"""The published data files and the static web site.

Output layout (``_site/`` by default)::

    index.html, db/, assets/            the web site (copied from site/)
    explorer/, docs/, api/ ...          one folder per page (pages.py)
    api/<label>/...                     JSON files for programs (api.py)
    schema/v1/*.schema.json             JSON Schemas
    tests/                              the browser test page (tests/js, tests/vectors)
    data/versions.json                  the versions below
    data/<label>/manifest.json          what this version contains
    data/<label>/LT.json                all LT data in one file
    data/<label>/master.json            facilities, nuclides, Huff factors, constants
    data/<label>/csv/LT*.csv            flat tables including converted quantities
    data/<label>/raw/...                the source files exactly as stored in git
    data/<label>/mund-<label>.zip       README.txt, the files above except the manifest, and the schemas

``<label>`` is ``latest`` for the current state of the repository and ``v1``,
``v2`` ... for the released major versions (git tags ``v1.0.0``, ``v2.0.0``).
A released version is built once, when it is released (:func:`freeze_release`),
and stored in ``releases/<label>/`` with a manifest of SHA-256 hashes; the site
publishes those files as they are after checking them (:func:`verify_release`).
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
import tempfile
import zipfile
from pathlib import Path
from typing import List, Optional

from . import CODE_OF, SUBLIBRARIES, SUBLIBRARY_TITLES, jsonfmt
from .api import build_api
from .cite import cite_text
from .convert import Physics, combined_uncertainty
from .database import MASTER_FORMATS, Database, quantity
from .pages import write_pages
from .schema import SCHEMA_DIR, SCHEMA_FILES

MAJOR_VERSION_RE = re.compile(r"^(\d+)\.0\.0$")
CSV_COLUMNS = [
    "datasetId", "datasetType", "element", "z", "mass", "isomer", "observable", "value",
    "uncertainty", "uncertaintyStatistical", "uncertaintySystematic", "unit", "key", "comment",
    "originalData", "metaId", "bibId", "reference", "facility", "method",
    "lifetime_ns", "lifetime_ns_unc", "capture_rate_us-1", "capture_rate_us-1_unc",
    "capture_probability_pct", "capture_probability_pct_unc", "huff_factor", "huff_source",
]
DERIVED = CSV_COLUMNS[CSV_COLUMNS.index("lifetime_ns"):CSV_COLUMNS.index("huff_source")]


# ---------------------------------------------------------------------------
# version of the working tree
# ---------------------------------------------------------------------------

def _git(root: Path, *args: str) -> Optional[str]:
    try:
        out = subprocess.run(["git", "-C", str(root)] + list(args), check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return out.stdout.decode("utf-8").strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def read_version(root: Path) -> str:
    return (Path(root) / "VERSION").read_text(encoding="utf-8").strip()


def describe(root: Path) -> dict:
    """Version, commit and date of the working tree (kind "development").

    ``1.2.0`` on a tag, ``1.2.0+3.g1a2b3c4`` three commits after it,
    ``0.0.1-dev+g1a2b3c4`` before the first tag; ``.modified`` is appended when
    data/ or schema/ have uncommitted changes.
    """
    base = read_version(root)
    info = {"version": base + "-dev", "commit": None, "date": None, "kind": "development"}
    commit = _git(root, "rev-parse", "HEAD")
    if not commit:
        return info
    info["commit"] = commit
    info["date"] = _git(root, "log", "-1", "--format=%cI")
    desc = _git(root, "describe", "--tags", "--long", "--match", "v[0-9]*")
    m = re.match(r"^v(.+)-(\d+)-g([0-9a-f]+)$", desc or "")
    if m and int(m.group(2)) == 0:
        if m.group(1) != base:
            raise ValueError("tag v%s is on a commit whose VERSION is %s" % (m.group(1), base))
        info["version"] = base
    elif m:
        info["version"] = "%s+%s.g%s" % (m.group(1), m.group(2), m.group(3))
    else:
        info["version"] = "%s-dev+g%s" % (base, commit[:7])
    if _git(root, "status", "--porcelain", "--", "data", "schema"):
        info["version"] += ".modified"
    return info


# ---------------------------------------------------------------------------
# the LT data of one version
# ---------------------------------------------------------------------------

def aggregate_lt(db: Database, version: str) -> dict:
    """All LT files merged into one document; every entry is self-contained:
    datasetId, datasetType, metaId and bibId next to its own members."""
    metas, entries, bib = [], [], {}
    for f in db.files:
        obj = f.obj
        if not isinstance(obj, dict) or obj.get("sublibrary") != "LT":
            continue
        meta = {"id": f.meta.get("id"), "datasetType": obj.get("datasetType"),
                "file": f.path[len("data/"):]}
        meta.update({k: v for k, v in f.meta.items() if k != "id"})
        metas.append(meta)
        ref = db.reference(f.meta.get("bibId"))
        if ref is not None:
            bib[ref["DOI"]] = ref
        for entry in f.data:
            out = {"datasetId": entry.get("datasetId"), "datasetType": obj.get("datasetType"),
                   "metaId": f.meta.get("id"), "bibId": f.meta.get("bibId")}
            out.update({k: v for k, v in entry.items() if k != "datasetId"})
            entries.append(out)
    order = {t: i for i, t in enumerate(CODE_OF)}

    def sort_key(e):
        n = e.get("nuclide") or {}
        return (db.z_of(n.get("element")), n.get("mass", 0), n.get("isomer", 0),
                order.get(e["datasetType"], 9), e["datasetId"])

    entries.sort(key=sort_key)
    metas.sort(key=lambda m: (order.get(m["datasetType"], 9), m["file"]))
    return {"format": "muND/dist/LT/1", "sublibrary": "LT", "version": version,
            "bibliography": [bib[k] for k in sorted(bib, key=str.upper)],
            "meta": metas, "data": entries}


def _component(uncertainties, source: str) -> str:
    for u in uncertainties or []:
        if isinstance(u, dict) and u.get("source") == source:
            return jsonfmt.lexeme(u["value"])
    return ""


def _derived(x: Optional[float]) -> str:
    return "" if x is None else "%.6g" % x


def csv_text(agg: dict, db: Database, physics: Physics, dataset_type: Optional[str] = None) -> str:
    """The flat table of the LT data (one datasetType, or all)."""
    metas = {m["id"]: m for m in agg["meta"]}
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for e in agg["data"]:
        if dataset_type and e["datasetType"] != dataset_type:
            continue
        meta = metas.get(e["metaId"], {})
        nuclide = e["nuclide"]
        block = quantity(e)
        kind = e["observable"]["kind"]
        uncertainties = block["uncertainties"]
        total = combined_uncertainty(uncertainties)
        z = db.z_of(nuclide["element"])
        conv = physics.convert(z, nuclide["mass"], kind, block["value"], total, block["unit"]) or {}
        line = {
            "datasetId": e["datasetId"], "datasetType": e["datasetType"],
            "element": nuclide["element"], "z": z, "mass": nuclide["mass"],
            "isomer": nuclide["isomer"], "observable": kind,
            "value": jsonfmt.lexeme(block["value"]),
            # as written in the source, or the components added in quadrature
            "uncertainty": "" if total is None else (_component(uncertainties, "total") or _derived(total)),
            "uncertaintyStatistical": _component(uncertainties, "statistical"),
            "uncertaintySystematic": _component(uncertainties, "systematic"),
            "unit": block["unit"], "key": e.get("key", ""), "comment": e.get("comment", ""),
            "originalData": ";".join(o["datasetId"] for o in e.get("originalData", [])), "metaId": e["metaId"],
            "bibId": e["bibId"], "reference": cite_text(db.reference(e["bibId"]), e["bibId"]),
            "facility": meta.get("facility", ""), "method": meta.get("method", ""),
        }
        for k in DERIVED:
            line[k] = _derived(conv.get(k))
        line["huff_source"] = conv.get("huff_source", "")
        writer.writerow([line[c] for c in CSV_COLUMNS])
    return buf.getvalue()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_dist(root, out, label: str = "latest", info: Optional[dict] = None) -> dict:
    """Write one version of the data to ``out`` and return its manifest.

    ``info`` holds version, commit, date and kind ("release" or "development");
    by default it describes the working tree of ``root``.
    """
    root, out = Path(root), Path(out)
    db = Database.load(root)
    errors = [i for i in db.validate() if i.level == "error"]
    if errors:
        raise ValueError("cannot build: %d validation error(s):\n%s"
                         % (len(errors), "\n".join(str(i) for i in errors)))
    info = info or describe(root)
    version = info["version"]
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
    for f in list(db.files) + [db.master[n] for n in MASTER_FORMATS]:
        emit("raw/" + f.path[len("data/"):], f.text)

    # the master tables in one file (the bibliography is part of LT.json)
    master = {"format": "muND/dist/master/1", "version": version}
    for name in MASTER_FORMATS:
        if name != "bibliography.json":
            obj = dict(db.master_obj(name))
            obj.pop("format", None)
            master[name[:-len(".json")]] = obj
    emit("master.json", jsonfmt.dumps(master))

    physics = Physics(db.master_obj("huff_factors.json"), db.master_obj("constants.json"))
    agg = aggregate_lt(db, version)
    counts = {code: sum(1 for e in agg["data"] if e["datasetType"] == t) for t, code in CODE_OF.items()}
    emit("LT.json", jsonfmt.dumps(agg))
    emit("csv/LT.csv", csv_text(agg, db, physics))
    for t, code in CODE_OF.items():
        if counts[code]:
            emit("csv/LT_%s.csv" % code, csv_text(agg, db, physics, t))
    sublibraries = {sub: {"title": SUBLIBRARY_TITLES[sub], "status": "planned", "counts": {}}
                    for sub in SUBLIBRARIES}
    sublibraries["LT"].update(status="available", counts=counts)

    readme = (
        "muND - Muon Nuclear Data, version %s\n"
        "=====================================\n\n"
        "raw/         source files of the database (JSON, one file per publication)\n"
        "LT.json      all LT data merged into one file\n"
        "master.json  the master tables in one file\n"
        "csv/         flat tables; derived columns use the Huff factors and constants\n"
        "             in raw/master\n"
        "schema/      JSON Schemas describing the files in raw/\n\n"
        "Commit: %s\nDate:   %s\n" % (version, info.get("commit") or "-", info.get("date") or "-"))
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
        for name in sorted(set(SCHEMA_FILES.values())):        # the formats of the files in raw/
            own = root / "schema" / "v1" / name
            add("schema/v1/" + name, (own if own.is_file() else SCHEMA_DIR / name).read_bytes())
    (out / zip_name).write_bytes(buf.getvalue())

    manifest = {
        "format": "muND/manifest/1",
        "label": label,
        "version": version,
        "kind": info["kind"],
        "commit": info.get("commit"),
        "date": info.get("date"),
        "sublibraries": sublibraries,
        "archive": {"path": zip_name, "bytes": len(buf.getvalue()), "sha256": _sha256(buf.getvalue())},
        "files": [{"path": rel, "bytes": len(files[rel]), "sha256": _sha256(files[rel])}
                  for rel in sorted(files)],
    }
    for key in ("sources", "builder"):
        if key in info:
            manifest[key] = info[key]
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                                       encoding="utf-8")
    return manifest


# ---------------------------------------------------------------------------
# the web site
# ---------------------------------------------------------------------------

RELEASES_DIR = "releases"
# files whose content determines a version: the data, the schemas, the tools and the browser core
SOURCE_PATTERNS = ("VERSION", "data/**/*.json", "schema/**/*.json", "tools/mund.py", "tools/mundlib/*.py",
                   "site/assets/js/core/*.js")
TOOL_FILES = ("mund.py", "mundlib/__init__.py", "mundlib/build.py", "mundlib/convert.py", "mundlib/database.py",
              "mundlib/ids.py", "mundlib/jsonfmt.py", "mundlib/schema.py", "mundlib/cite.py")


def source_hashes(root: Path) -> dict:
    """SHA-256 of every file a version is made from, by path."""
    root = Path(root)
    paths = sorted({p for pattern in SOURCE_PATTERNS for p in root.glob(pattern) if p.is_file()})
    return {p.relative_to(root).as_posix(): _sha256(p.read_bytes()) for p in paths}


def builder_hashes() -> dict:
    """SHA-256 of the tools and schemas that are running now (they build a frozen release)."""
    tools = Path(__file__).resolve().parent.parent
    out = {"tools/" + rel: _sha256((tools / rel).read_bytes()) for rel in TOOL_FILES if (tools / rel).is_file()}
    for path in sorted((tools.parent / "schema").glob("**/*.json")):
        out[path.relative_to(tools.parent).as_posix()] = _sha256(path.read_bytes())
    return out


def release_label(version: str) -> Optional[str]:
    """``v1`` for ``1.0.0``; None for a version that is not published on its own (minor, patch)."""
    m = MAJOR_VERSION_RE.match(version)
    return "v%d" % int(m.group(1)) if m else None


def frozen_releases(root: Path) -> List[str]:
    """Labels of the frozen releases stored in the repository (``v1``, ``v2`` ...), oldest first."""
    found = [p.name for p in (Path(root) / RELEASES_DIR).glob("v*") if p.is_dir() and re.match(r"^v\d+$", p.name)]
    return sorted(found, key=lambda name: int(name[1:]))


def freeze_release(root: Path, commit: str) -> dict:
    """Build the files of the major release made by ``commit`` once, into releases/vN/.

    The data, schemas and VERSION are taken from ``commit`` (not from the working
    tree); the manifest records that commit, the SHA-256 of every source file of
    it, of the tools that built it, and of every file produced.  A frozen release
    is published as it is and never built again.
    """
    root = Path(root)
    commit = _git(root, "rev-parse", "--verify", "%s^{commit}" % commit)
    if not commit:
        raise ValueError("unknown commit")
    with tempfile.TemporaryDirectory() as tmp:
        archive = subprocess.run(["git", "-C", str(root), "archive", "--format=zip", commit],
                                 check=True, stdout=subprocess.PIPE).stdout
        with zipfile.ZipFile(io.BytesIO(archive)) as zf:
            zf.extractall(tmp)            # zipfile keeps every member inside tmp
        version = read_version(Path(tmp))
        label = release_label(version)
        if label is None:
            raise ValueError("only major versions (N.0.0) are frozen; VERSION of %s is %s" % (commit[:12], version))
        out = root / RELEASES_DIR / label
        if out.exists():
            raise ValueError("%s is frozen already" % out.relative_to(root).as_posix())
        info = {"version": version, "commit": commit, "date": _git(root, "log", "-1", "--format=%cI", commit),
                "kind": "release", "sources": source_hashes(Path(tmp)), "builder": builder_hashes()}
        return build_dist(Path(tmp), out, label, info)


def verify_release(root: Path, label: str) -> dict:
    """Check a frozen release: its files against its manifest and, where the
    history is available, its sources against its commit and its tag.

    Returns {"errors": [...], "warnings": [...]}.
    """
    root = Path(root)
    folder = root / RELEASES_DIR / label
    errors, warnings = [], []
    try:
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return {"errors": ["%s: no readable manifest.json (%s)" % (label, exc)], "warnings": []}
    version = manifest.get("version", "")
    if manifest.get("label") != label or manifest.get("kind") != "release" or release_label(version) != label:
        errors.append("%s: the manifest describes %s %s" % (label, manifest.get("kind"), version))
    listed = {f["path"]: f["sha256"] for f in manifest.get("files", [])}
    archive = manifest.get("archive") or {}
    if archive.get("path"):
        listed[archive["path"]] = archive.get("sha256")
    present = {p.relative_to(folder).as_posix() for p in folder.rglob("*") if p.is_file()} - {"manifest.json"}
    for rel in sorted(present - set(listed)):
        errors.append("%s: %s is not listed in the manifest" % (label, rel))
    for rel, digest in sorted(listed.items()):
        path = folder / rel
        if not path.is_file():
            errors.append("%s: %s is missing" % (label, rel))
        elif _sha256(path.read_bytes()) != digest:
            errors.append("%s: %s differs from the manifest" % (label, rel))
    commit = manifest.get("commit") or ""
    if _git(root, "rev-parse", "--verify", "--quiet", "%s^{commit}" % commit) != commit:
        warnings.append("%s: commit %s is not in this repository's history" % (label, commit[:12] or "-"))
        return {"errors": errors, "warnings": warnings}
    for rel, digest in sorted((manifest.get("sources") or {}).items()):
        data = subprocess.run(["git", "-C", str(root), "show", "%s:%s" % (commit, rel)],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
        if _sha256(data) != digest:
            errors.append("%s: source %s differs from commit %s" % (label, rel, commit[:12]))
    changes = (_git(root, "log", "--format=%H", "--", "%s/%s" % (RELEASES_DIR, label)) or "").split()
    if len(changes) > 1:
        errors.append("%s: changed after it was frozen (%d commits touch it)" % (label, len(changes)))
    tagged = _git(root, "rev-parse", "--verify", "--quiet", "refs/tags/v%s^{commit}" % version)
    if not tagged:
        warnings.append("%s: tag v%s is missing (it belongs on commit %s)" % (label, version, commit[:12]))
    elif tagged != commit:
        errors.append("%s: tag v%s is on %s, not on the release commit %s" % (label, version, tagged[:12], commit[:12]))
    return {"errors": errors, "warnings": warnings}


_IMPORT_RE = re.compile(r"""(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}/[^'"?]+\.js)\2""")
_ASSET_RE = re.compile(r"""\b(src|href)="((?!https?:|//|#)[^"?]+\.(?:js|css))\"""")


def stamp_assets(out: Path) -> str:
    """Make the address of every script and style sheet change with its content.

    Browsers and web servers cache files for a while.  A short hash of all
    scripts and style sheets is appended to every reference
    (``./ids.js`` -> ``./ids.js?v=1a2b3c4d5e``), in the pages and in the
    ``import`` statements, so that a page always loads the code it was built
    with.  Only the built site is changed; the sources in ``site/`` stay as they are.
    """
    files = sorted(p for p in out.rglob("*") if p.is_file() and p.suffix in (".js", ".css", ".html")
                   and "data" not in p.relative_to(out).parts[:1])
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(out).as_posix().encode("utf-8"))
        digest.update(path.read_bytes())
    stamp = digest.hexdigest()[:10]

    def imports(text: str) -> str:
        return _IMPORT_RE.sub(lambda m: "%s%s%s?v=%s%s" % (m.group(1), m.group(2), m.group(3), stamp, m.group(2)), text)

    for path in files:
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".html":
            new = imports(_ASSET_RE.sub(lambda m: '%s="%s?v=%s"' % (m.group(1), m.group(2), stamp), text))
        elif path.suffix == ".js":
            new = imports(text)
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
    config = json.loads((root / "site" / "config.json").read_text(encoding="utf-8"))
    write_pages(root, out, config)
    shutil.copytree(root / "schema", out / "schema")
    shutil.copytree(root / "tests" / "js", out / "tests", ignore=shutil.ignore_patterns("*.mjs"))
    shutil.copytree(root / "tests" / "vectors", out / "tests" / "vectors")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    stamp_assets(out)

    data = out / "data"
    manifests = [build_dist(root, data / "latest", "latest")]
    for label in frozen_releases(root) if releases else []:
        report = verify_release(root, label)
        for warning in report["warnings"]:
            print("warning: " + warning, file=sys.stderr)
        if report["errors"]:
            raise ValueError("frozen release %s cannot be published:\n%s" % (label, "\n".join(report["errors"])))
        shutil.copytree(root / RELEASES_DIR / label, data / label)      # published exactly as frozen
        manifests.append(json.loads((data / label / "manifest.json").read_text(encoding="utf-8")))
    released = [m for m in manifests if m["kind"] == "release"]

    def listing(m):
        return {key: m[key] for key in ("label", "version", "kind", "commit", "date")}

    versions = {
        "format": "muND/versions/1",
        "default": released[-1]["label"] if released else "latest",
        "versions": [listing(m) for m in reversed(released)] + [listing(manifests[0])],
    }
    (data / "versions.json").write_text(json.dumps(versions, indent=2) + "\n", encoding="utf-8")
    (out / "api").mkdir(exist_ok=True)
    (out / "api" / "versions.json").write_text(json.dumps(versions, indent=2) + "\n", encoding="utf-8")
    for m in manifests:
        build_api(data / m["label"], out / "api" / m["label"], config)
    return versions
