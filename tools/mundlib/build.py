"""The published files of one version of the data (``docs/data-format.md`` §6), and the version of the working tree."""
from __future__ import annotations

import hashlib
import io
import json
import re
import subprocess
import zipfile
from pathlib import Path
from typing import Optional, Union

from . import CODE_OF, SUBLIBRARIES, SUBLIBRARY_TITLES, jsonfmt
from .api import ROUND, rows, type_counts
from .cite import cite_text
from .convert import combined_uncertainty
from .database import MASTER_FORMATS, Database
from .schema import SCHEMA_FILES

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

# files whose content determines a version: the data, the schemas, the tools, the browser core and
# the site settings (the address and the licence written into the README of the archive)
SOURCE_PATTERNS = ("VERSION", "data/**/*.json", "schema/**/*.json", "tools/mund.py", "tools/mundlib/*.py",
                   "site/assets/js/core/*.js", "site/config.json")


def _git(root: Path, *args: str, raw: bool = False) -> Union[str, bytes, None]:
    """Output of a git command (stripped text, or the bytes with ``raw``); None when it fails."""
    try:
        out = subprocess.run(["git", "-C", str(root)] + list(args), check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.stdout if raw else out.stdout.decode("utf-8").strip()


_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


def read_version(root: Path) -> str:
    version = (Path(root) / "VERSION").read_text(encoding="utf-8").strip()
    if not _VERSION.fullmatch(version):
        raise ValueError("VERSION must be MAJOR.MINOR.PATCH, got %r" % version)
    return version


def describe(root: Path) -> dict:
    """Version, commit and date of the working tree (kind "development").

    ``1.2.0`` on a tag, ``1.2.0+3.g1a2b3c4`` three commits after it,
    ``0.0.1-dev+g1a2b3c4`` before the first tag; ``.modified`` is appended when
    any source of the version (:data:`SOURCE_PATTERNS`) has uncommitted changes.
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
    if m and not _VERSION.fullmatch(m.group(1)):
        raise ValueError("invalid release tag v%s: expected vMAJOR.MINOR.PATCH" % m.group(1))
    if m and int(m.group(2)) == 0:
        if m.group(1) != base:
            raise ValueError("tag v%s is on a commit whose VERSION is %s" % (m.group(1), base))
        info["version"] = base
    elif m:
        info["version"] = "%s+%s.g%s" % (m.group(1), m.group(2), m.group(3))
    else:
        info["version"] = "%s-dev+g%s" % (base, commit[:7])
    paths = dict.fromkeys(re.split(r"[*?\[]", p, 1)[0].rstrip("/") for p in SOURCE_PATTERNS)
    sources = [":(glob)" + pattern for pattern in SOURCE_PATTERNS]
    if (_git(root, "status", "--porcelain", "--untracked-files=all", "--", *paths)
            or _git(root, "ls-files", "--others", "--ignored", "--exclude-standard", "--", *sources)):
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
        for bib_id in [f.meta.get("bibId")] + list(f.meta.get("relatedBibIds") or []):
            ref = db.reference(bib_id)
            if ref is not None:
                bib[ref["id"]] = ref
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
    parts = [u for u in uncertainties or [] if isinstance(u, dict) and u.get("source") == source]
    if len(parts) == 1:
        return jsonfmt.number_text(parts[0]["value"])
    return _derived(combined_uncertainty(parts))


def _derived(x: Optional[float]) -> str:
    return "" if x is None else ROUND % x


def _csv_record(fields) -> str:
    """One CSV record ending in LF.  A field with a comma, a double quote, CR or LF is
    enclosed in double quotes, with each double quote inside it doubled."""
    texts = ("" if f is None else str(f) for f in fields)
    return ",".join('"%s"' % t.replace('"', '""') if re.search('[,"\r\n]', t) else t for t in texts) + "\n"


def csv_text(lt: dict, master: dict, dataset_type: Optional[str] = None) -> str:
    """The flat table of the LT data (one datasetType, or all), from LT.json and master.json."""
    metas = {m["id"]: m for m in lt["meta"]}
    out = [_csv_record(CSV_COLUMNS)]
    for e, z, reference, block, total, conv in rows(lt, master):
        if dataset_type and e["datasetType"] != dataset_type:
            continue
        meta = metas.get(e["metaId"], {})
        nuclide = e["nuclide"]
        uncertainties = block.get("uncertainties")
        conv = conv or {}
        line = {
            "datasetId": e["datasetId"], "datasetType": e["datasetType"],
            "element": nuclide["element"], "z": z, "mass": nuclide["mass"],
            "isomer": nuclide["isomer"], "observable": e["observable"]["kind"],
            "value": jsonfmt.number_text(block["value"]),
            # as written in the source, or the components added in quadrature
            "uncertainty": "" if total is None else (_component(uncertainties, "total") or _derived(total)),
            "uncertaintyStatistical": _component(uncertainties, "statistical"),
            "uncertaintySystematic": _component(uncertainties, "systematic"),
            "unit": block["unit"], "key": e.get("key", ""), "comment": e.get("comment", ""),
            "originalData": ";".join(o["datasetId"] for o in e.get("originalData", [])), "metaId": e["metaId"],
            "bibId": e["bibId"], "reference": cite_text(reference, e["bibId"]),
            "facility": meta.get("facility", ""), "method": meta.get("method", ""),
        }
        for k in DERIVED:
            line[k] = _derived(conv.get(k))
        line["huff_source"] = conv.get("huff_source", "")
        out.append(_csv_record(line[c] for c in CSV_COLUMNS))
    return "".join(out)


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
    lt = aggregate_lt(db, version)
    emit("LT.json", jsonfmt.dumps(lt))

    # the flat tables, made from the two files above
    counts = type_counts(lt["data"])
    emit("csv/LT.csv", csv_text(lt, master))
    for t, code in CODE_OF.items():
        if counts[code]:
            emit("csv/LT_%s.csv" % code, csv_text(lt, master, t))
    sublibraries = {sub: {"title": SUBLIBRARY_TITLES[sub], "status": "planned", "counts": {}}
                    for sub in SUBLIBRARIES}
    sublibraries["LT"].update(status="available", counts=counts)

    config = json.loads((root / "site" / "config.json").read_text(encoding="utf-8"))
    site_url = config.get("siteUrl", "")
    title = "muND - Muon Nuclear Data, version %s" % version
    readme = (
        "%s\n%s\n\n"
        "raw/         source files of the database as stored (JSON): one file per\n"
        "             publication, and the master tables in raw/master\n"
        "LT.json      all LT data merged into one file\n"
        "master.json  the master tables in one file\n"
        "csv/         flat tables; derived columns use the Huff factors and constants\n"
        "             in raw/master\n"
        "schema/      JSON Schemas describing the files in raw/\n\n"
        "Format: %sdocs/data-format/\n"
        "How to cite: %s?v=%s#cite\n"
        "Licence of the data: %s\n\n"
        "Commit: %s\nDate:   %s\n"
        % (title, "=" * len(title), site_url, site_url, label, config.get("dataLicence") or "not decided",
           info.get("commit") or "-", info.get("date") or "-"))
    zip_name = "mund-%s.zip" % label
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        def add(name: str, data: bytes):
            zi = zipfile.ZipInfo("mund-%s/%s" % (label, name), date_time=(1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.create_system = 3
            zi.external_attr = 0o644 << 16
            zf.writestr(zi, data)
        add("README.txt", readme.encode("utf-8"))
        for rel in sorted(files):
            add(rel, files[rel])
        for name in sorted(SCHEMA_FILES.values()):        # the formats of the files in raw/
            add("schema/v1/" + name, (root / "schema" / "v1" / name).read_bytes())
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
    if "sources" in info:
        manifest["sources"] = info["sources"]
    jsonfmt.write(out / "manifest.json", manifest)
    return manifest
