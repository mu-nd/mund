"""Loading the ``data/`` tree and checking it.

Three layers of checks:

1. *Syntax*   - the file is JSON and written in the canonical layout.
2. *Schema*   - the file follows ``schema/v1/*.schema.json``.
3. *Semantic* - identifiers match their definition, identifiers are unique,
   references between data entries resolve, facilities exist ...

The semantic rules are mirrored in ``site/assets/js/core/checks.js`` so that
the admin UI reports the same problems before anything is committed.

Shape of a dataset file (see ``docs/data-format.md``)::

    {"format": "muND/LT/1", "sublibrary": "LT", "datasetType": "experiment",
     "meta": {"id": MetaID, "bibId": DOI, ...},
     "data": [{"datasetId": DataID,
               "nuclide": {"element": "Si", "mass": 28, "isomer": 0},
               "observable": {"kind": "lifetime",
                              "lifetime": {"value": 743.9, "unit": "ns",
                                           "uncertainties": [{"source": "total", "value": 5.0}]}}}]}
"""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Dict, Iterator, List, Optional

from . import DATASET_TYPES, DEFINED_SUBLIBRARIES, SUBLIBRARIES, ids, jsonfmt
from . import schema as schema_mod

DATA_DIR = "data"
MASTER_DIR = "data/master"
MASTER_FILES = ("facilities.json", "bibliography.json", "nuclides.json", "huff_factors.json",
                "constants.json")
MASTER_FORMATS = {
    "facilities.json": "muND/facilities/1",
    "bibliography.json": "muND/bibliography/1",
    "nuclides.json": "muND/nuclides/1",
    "huff_factors.json": "muND/huff-factors/1",
    "constants.json": "muND/constants/1",
}
FILE_LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]*$")
PLACEHOLDER_DOI_PREFIX = "10.1000/"


class Issue:
    """A problem found in the database."""

    def __init__(self, level: str, code: str, file: str, pointer: str, message: str):
        self.level = level        # "error" or "warning"
        self.code = code
        self.file = file
        self.pointer = pointer    # JSON pointer inside the file ('' = whole file)
        self.message = message

    def as_dict(self) -> dict:
        return {"level": self.level, "code": self.code, "file": self.file,
                "pointer": self.pointer, "message": self.message}

    def __str__(self) -> str:
        where = self.file + (" " + self.pointer if self.pointer else "")
        return "%-7s %-20s %s: %s" % (self.level.upper(), self.code, where, self.message)


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


class DatasetFile:
    def __init__(self, path: str, text: str):
        self.path = path          # posix path relative to the repository root
        self.text = text
        self.obj = None           # parsed content (lexeme preserving)
        self.parse_error: Optional[str] = None
        try:
            self.obj = jsonfmt.loads(text)
        except ValueError as exc:
            self.parse_error = str(exc)

    @property
    def meta(self) -> dict:
        return _dict(_dict(self.obj).get("meta"))

    @property
    def data(self) -> list:
        d = _dict(self.obj).get("data")
        return [r for r in d if isinstance(r, dict)] if isinstance(d, list) else []

    @property
    def code(self) -> Optional[str]:
        """EXP / TH / CUR / EVAL for the file's datasetType."""
        return dataset_code(_dict(self.obj))


# ---------------------------------------------------------------------------
# helpers shared with the JavaScript implementation
# ---------------------------------------------------------------------------

def dataset_code(obj: dict) -> Optional[str]:
    kind = obj.get("datasetType")
    return DATASET_TYPES.get(kind) if isinstance(kind, str) else None


def quantity(row: dict) -> Optional[dict]:
    """The value block of a data entry: ``observable[observable.kind]``."""
    obs = _dict(row.get("observable"))
    kind = obs.get("kind")
    block = obs.get(kind) if isinstance(kind, str) else None
    return block if isinstance(block, dict) else None


def ascii_label(text: str) -> str:
    """ASCII letters and digits of ``text`` (accents removed)."""
    folded = unicodedata.normalize("NFKD", str(text))
    return "".join(c for c in folded if c.isascii() and c.isalnum())


def reference_year(reference: Optional[dict]):
    parts = _dict(_dict(reference).get("published")).get("date-parts")
    try:
        return int(parts[0][0])
    except (TypeError, IndexError, ValueError):
        return None


def first_author(reference: Optional[dict]) -> str:
    authors = _dict(reference).get("author")
    if isinstance(authors, list) and authors and isinstance(authors[0], dict):
        return str(authors[0].get("family") or authors[0].get("name") or "")
    return ""


def file_label(meta: dict, reference: Optional[dict] = None) -> str:
    """Human readable part of a file name: ``Suzuki1987``.

    First author's family name + year when the bibliography knows the
    reference, otherwise the last part of the DOI.  The label is only a
    reading aid; the MetaID that follows it is what identifies the file.
    """
    family = ascii_label(first_author(reference))
    year = reference_year(reference)
    if family and year:
        return "%s%d" % (family, year)
    if family:
        return family
    tail = str(meta.get("bibId", "")).split("/")[-1]
    return ascii_label(tail) or "dataset"


def dataset_path(obj: dict, reference: Optional[dict] = None) -> str:
    """Canonical repository path of a dataset file."""
    meta = _dict(obj.get("meta"))
    return "%s/%s/%s/%s_%s.json" % (DATA_DIR, obj.get("sublibrary"), dataset_code(obj),
                                    file_label(meta, reference), meta.get("id"))


def is_placeholder_doi(doi: str) -> bool:
    return str(doi).lower().startswith(PLACEHOLDER_DOI_PREFIX)


def expected_meta_id(obj: dict) -> Optional[str]:
    meta = _dict(obj.get("meta"))
    code = dataset_code(obj)
    if not isinstance(meta.get("bibId"), str) or code is None:
        return None
    key = meta.get("key") if isinstance(meta.get("key"), str) else None
    return ids.meta_id(str(obj.get("sublibrary")), code, meta["bibId"], key)


def expected_data_id(obj: dict, row: dict, meta_id: str) -> Optional[str]:
    nuclide = _dict(row.get("nuclide"))
    mass = nuclide.get("mass")
    if not isinstance(nuclide.get("element"), str) or isinstance(mass, bool) \
            or not isinstance(mass, (int, float)):
        return None
    key = row.get("key") if isinstance(row.get("key"), str) else None
    return ids.data_id(str(obj.get("sublibrary")), dataset_code(obj), nuclide["element"], mass,
                       meta_id, key)


def assign_ids(obj: dict) -> dict:
    """(Re)compute ``meta.id`` and every ``data[].datasetId`` in place."""
    mid = expected_meta_id(obj)
    if mid is None:
        raise ValueError("datasetType and meta.bibId are needed to compute identifiers")
    obj["meta"]["id"] = mid
    for row in obj.get("data", []):
        did = expected_data_id(obj, row, mid)
        if did is None:
            raise ValueError("nuclide.element and nuclide.mass are needed to compute a datasetId")
        row["datasetId"] = did
    return obj


# ---------------------------------------------------------------------------
# the database
# ---------------------------------------------------------------------------

class Database:
    def __init__(self, root):
        self.root = Path(root)
        self.files: List[DatasetFile] = []
        self.master: Dict[str, DatasetFile] = {}
        self._schemas: Dict[str, dict] = {}
        self._references: Optional[Dict[str, dict]] = None

    # -- loading -----------------------------------------------------------
    @classmethod
    def load(cls, root) -> "Database":
        db = cls(root)
        data = db.root / DATA_DIR
        for sub in SUBLIBRARIES:
            for path in sorted((data / sub).glob("**/*.json")) if (data / sub).is_dir() else []:
                rel = path.relative_to(db.root).as_posix()
                db.files.append(DatasetFile(rel, path.read_text(encoding="utf-8")))
        db.files.sort(key=lambda f: f.path)
        db.load_master()
        return db

    def load_master(self) -> None:
        for name in MASTER_FILES:
            path = self.root / MASTER_DIR / name
            if path.is_file():
                rel = path.relative_to(self.root).as_posix()
                self.master[name] = DatasetFile(rel, path.read_text(encoding="utf-8"))
        self._references = None

    @classmethod
    def from_texts(cls, root, texts: Dict[str, str]) -> "Database":
        """A database made of the given ``{path: text}`` files.

        Master tables come from ``root`` unless ``texts`` contains them.
        """
        db = cls(root)
        db.load_master()
        for path in sorted(texts):
            if path.startswith(MASTER_DIR + "/"):
                db.master[path[len(MASTER_DIR) + 1:]] = DatasetFile(path, texts[path])
            else:
                db.files.append(DatasetFile(path, texts[path]))
        db._references = None
        return db

    def schema_for(self, fmt: str) -> Optional[dict]:
        name = schema_mod.SCHEMA_FILES.get(fmt)
        if name is None:
            return None
        if name not in self._schemas:
            self._schemas[name] = schema_mod.load_schema(self.root, name)
        return self._schemas[name]

    def master_obj(self, name: str) -> dict:
        f = self.master.get(name)
        return f.obj if f is not None and isinstance(f.obj, dict) else {}

    def facility_abbrs(self) -> set:
        return {f.get("abbr") for f in self.master_obj("facilities.json").get("facilities", [])
                if isinstance(f, dict)}

    def references(self) -> Dict[str, dict]:
        """Bibliography entries by normalised DOI."""
        if self._references is None:
            out: Dict[str, dict] = {}
            refs = self.master_obj("bibliography.json").get("references", [])
            for ref in refs if isinstance(refs, list) else []:
                if isinstance(ref, dict) and isinstance(ref.get("DOI"), str):
                    out.setdefault(ids.normalize_doi(ref["DOI"]), ref)
            self._references = out
        return self._references

    def reference(self, doi) -> Optional[dict]:
        return self.references().get(ids.normalize_doi(doi)) if isinstance(doi, str) else None

    def elements(self) -> List[str]:
        return list(self.master_obj("nuclides.json").get("elements", []))

    def z_of(self, element) -> int:
        try:
            return self.elements().index(element) + 1
        except ValueError:
            return 0

    def isotope_range(self, z: int):
        for r in self.master_obj("nuclides.json").get("isotope_ranges", []):
            if r.get("z") == z:
                return r.get("a_min"), r.get("a_max")
        return None

    # -- flat view ---------------------------------------------------------
    def rows(self, sublibrary: Optional[str] = None) -> Iterator[dict]:
        """Every data entry with its dataset code, metadata and file."""
        for f in self.files:
            if not isinstance(f.obj, dict):
                continue
            if sublibrary and f.obj.get("sublibrary") != sublibrary:
                continue
            for row in f.data:
                yield {"file": f, "dataset": f.code, "meta": f.meta, "row": row}

    # -- validation --------------------------------------------------------
    def validate(self) -> List[Issue]:
        issues: List[Issue] = []
        for name in MASTER_FILES:
            if name not in self.master:
                issues.append(Issue("error", "E_MASTER_MISSING", MASTER_DIR + "/" + name, "",
                                    "master file is missing"))
        for name in MASTER_FILES:
            if name in self.master:
                issues.extend(self._check_master(name, self.master[name]))
        for f in self.files:
            issues.extend(self._check_file(f))
        issues.extend(self._check_cross())
        return issues

    def _check_syntax(self, f: DatasetFile) -> List[Issue]:
        if f.parse_error:
            return [Issue("error", "E_JSON", f.path, "", "not valid JSON: " + f.parse_error)]
        if not isinstance(f.obj, dict):
            return [Issue("error", "E_JSON", f.path, "", "the top level must be an object")]
        return []

    def _check_canonical(self, f: DatasetFile, normalized) -> List[Issue]:
        if jsonfmt.dumps(normalized) != f.text:
            return [Issue("error", "E_CANONICAL", f.path, "",
                          "file is not in canonical layout; run: python3 tools/mund.py format")]
        return []

    def _check_master(self, name: str, f: DatasetFile) -> List[Issue]:
        issues = self._check_syntax(f)
        if issues:
            return issues
        fmt = MASTER_FORMATS[name]
        if f.obj.get("format") != fmt:
            issues.append(Issue("error", "E_FORMAT", f.path, "/format", "expected %r" % fmt))
        sch = self.schema_for(fmt)
        normalized = f.obj
        if sch is not None:
            for ptr, keyword, msg in schema_mod.validate(jsonfmt.plain(f.obj), sch):
                issues.append(Issue("error", "E_SCHEMA", f.path, ptr, msg))
            normalized = schema_mod.normalize(f.obj, sch)
        issues.extend(self._check_canonical(f, normalized))
        if name == "facilities.json":
            issues.extend(self._check_unique(f, "facilities", "abbr", "E_DUPLICATE_FACILITY",
                                             lambda v: v))
        if name == "bibliography.json":
            issues.extend(self._check_unique(f, "references", "DOI", "E_DUPLICATE_REFERENCE",
                                             ids.normalize_doi))
        return issues

    @staticmethod
    def _check_unique(f: DatasetFile, member: str, key: str, code: str, norm) -> List[Issue]:
        issues, seen = [], set()
        items = f.obj.get(member)
        for i, item in enumerate(items if isinstance(items, list) else []):
            value = item.get(key) if isinstance(item, dict) else None
            if not isinstance(value, str):
                continue
            if norm(value) in seen:
                issues.append(Issue("error", code, f.path, "/%s/%d/%s" % (member, i, key),
                                    "%r is listed twice" % value))
            seen.add(norm(value))
        return issues

    def _check_file(self, f: DatasetFile) -> List[Issue]:
        issues = self._check_syntax(f)
        if issues:
            return issues
        obj = f.obj
        parts = f.path.split("/")
        sub = parts[1] if len(parts) > 1 else ""
        if sub not in DEFINED_SUBLIBRARIES:
            return [Issue("error", "E_SUBLIBRARY_UNDEFINED", f.path, "",
                          "the data format of sub-library %s is not defined yet" % sub)]
        sch = self.schema_for(str(obj.get("format")))
        if sch is None:
            return [Issue("error", "E_FORMAT", f.path, "/format",
                          "unknown format %r" % (obj.get("format"),))]
        for ptr, keyword, msg in schema_mod.validate(jsonfmt.plain(obj), sch):
            issues.append(Issue("error", "E_SCHEMA", f.path, ptr, msg))
        issues.extend(self._check_canonical(f, schema_mod.normalize(obj, sch)))
        issues.extend(check_dataset(obj, f.path, self))
        return issues

    def _check_cross(self) -> List[Issue]:
        issues: List[Issue] = []
        metas: Dict[str, str] = {}
        data_ids: Dict[str, dict] = {}
        for f in self.files:
            if not isinstance(f.obj, dict):
                continue
            mid = f.meta.get("id")
            if isinstance(mid, str):
                if mid in metas:
                    issues.append(Issue("error", "E_DUPLICATE_META", f.path, "/meta/id",
                                        "MetaID %s is also used by %s" % (mid, metas[mid])))
                else:
                    metas[mid] = f.path
            for i, row in enumerate(f.data):
                did = row.get("datasetId")
                if not isinstance(did, str):
                    continue
                if did in data_ids and data_ids[did]["file"] is not f:
                    issues.append(Issue("error", "E_DUPLICATE_ID", f.path, "/data/%d/datasetId" % i,
                                        "datasetId %s is also used in %s"
                                        % (did, data_ids[did]["file"].path)))
                data_ids.setdefault(did, {"file": f, "dataset": f.code,
                                          "sublibrary": f.obj.get("sublibrary")})
        for f in self.files:
            if not isinstance(f.obj, dict):
                continue
            for i, row in enumerate(f.data):
                originals = row.get("originalData")
                if not isinstance(originals, list):
                    continue
                for j, oid in enumerate(originals):
                    ptr = "/data/%d/originalData/%d" % (i, j)
                    target = data_ids.get(oid) if isinstance(oid, str) else None
                    if target is None or target["sublibrary"] != f.obj.get("sublibrary"):
                        issues.append(Issue("error", "E_ORIGINAL_MISSING", f.path, ptr,
                                            "original data %s does not exist" % oid))
                    elif oid == row.get("datasetId"):
                        issues.append(Issue("error", "E_ORIGINAL_SELF", f.path, ptr,
                                            "a data entry cannot be its own original data"))
                    elif f.code == "CUR" and target["dataset"] != "EXP":
                        issues.append(Issue("error", "E_ORIGINAL_NOT_EXP", f.path, ptr,
                                            "curated data must refer to experimental data; "
                                            "%s is %s" % (oid, target["dataset"])))
        return issues


def check_dataset(obj: dict, path: str, db: Database) -> List[Issue]:
    """Semantic checks that need only this file and the master tables."""
    issues: List[Issue] = []
    meta = _dict(obj.get("meta"))
    rows = obj.get("data") if isinstance(obj.get("data"), list) else []
    code = dataset_code(obj)

    # location of the file
    parts = path.split("/")
    if len(parts) != 4 or parts[0] != DATA_DIR or parts[1] != obj.get("sublibrary") \
            or parts[2] != code:
        issues.append(Issue("error", "E_PATH", path, "",
                            "file must be stored in %s/%s/%s/"
                            % (DATA_DIR, obj.get("sublibrary"), code)))
    else:
        name = parts[3]
        suffix = "_%s.json" % meta.get("id")
        if not name.endswith(suffix) or not FILE_LABEL_RE.match(name[:-len(suffix)]):
            example = dataset_path(obj, db.reference(meta.get("bibId"))).split("/")[-1]
            issues.append(Issue("error", "E_PATH", path, "",
                                "file name must be <label>_<MetaID>.json, e.g. %s" % example))

    # identifiers
    mid = expected_meta_id(obj)
    if mid is not None and meta.get("id") != mid:
        issues.append(Issue("error", "E_META_ID", path, "/meta/id",
                            "MetaID should be %s for this datasetType / bibId / key" % mid))
    seen: Dict[str, int] = {}
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        if mid is not None:
            did = expected_data_id(obj, row, mid)
            if did is not None and row.get("datasetId") != did:
                issues.append(Issue("error", "E_DATA_ID", path, "/data/%d/datasetId" % i,
                                    "datasetId should be %s for this element / mass / key" % did))
        rid = row.get("datasetId")
        if isinstance(rid, str):
            if rid in seen:
                issues.append(Issue("error", "E_DUPLICATE_ID", path, "/data/%d/datasetId" % i,
                                    "same datasetId as data[%d]: give the entries different keys"
                                    % seen[rid]))
            else:
                seen[rid] = i

        # plausibility of the mass number
        nuclide = _dict(row.get("nuclide"))
        el, mass = nuclide.get("element"), nuclide.get("mass")
        if isinstance(el, str) and isinstance(mass, (int, float)) and not isinstance(mass, bool) \
                and float(mass).is_integer() and mass > 0:
            mass = int(mass)
            z = db.z_of(el)
            rng = db.isotope_range(z) if z else None
            if rng and not (rng[0] - 8 <= mass <= rng[1] + 8):
                issues.append(Issue("warning", "W_MASS_RANGE", path, "/data/%d/nuclide/mass" % i,
                                    "mass number %d is unusual for %s (known range %d-%d)"
                                    % (mass, el, rng[0], rng[1])))

        # at most one overall uncertainty
        block = quantity(row)
        uncertainties = block.get("uncertainties") if block else None
        if isinstance(uncertainties, list):
            totals = [u for u in uncertainties if isinstance(u, dict) and u.get("source") == "total"]
            if len(totals) > 1:
                kind = row["observable"]["kind"]
                issues.append(Issue("error", "E_UNCERTAINTY_TOTAL", path,
                                    "/data/%d/observable/%s/uncertainties" % (i, kind),
                                    "only one uncertainty may have the source 'total'"))

    # metadata
    facility = meta.get("facility")
    if isinstance(facility, str) and facility not in db.facility_abbrs():
        issues.append(Issue("error", "E_FACILITY", path, "/meta/facility",
                            "%r is not listed in %s/facilities.json" % (facility, MASTER_DIR)))
    if isinstance(meta.get("bibId"), str) and db.reference(meta["bibId"]) is None:
        issues.append(Issue("warning", "W_NO_REFERENCE", path, "/meta/bibId",
                            "no bibliographic information for %s in %s/bibliography.json"
                            % (meta["bibId"], MASTER_DIR)))
    return issues
