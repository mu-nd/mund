"""The files under ``data/`` and their checks
(twin of ``site/assets/js/core/database.js``; shared cases in ``tests/vectors/cases.json``).

Three layers of checks:

1. *Syntax*   - the file is JSON, written in its canonical form.
2. *Schema*   - the file follows ``schema/v1/*.schema.json``.
3. *Semantic* - identifiers match their definition and are unique, references
   between entries resolve, facilities exist ...

A file of a sub-library (see ``docs/data-format.md``)::

    {"format": "muND/LT/1", "sublibrary": "LT", "datasetType": "experiment",
     "meta": {"id": MetaID, "bibId": DOI, ...},
     "data": [{"datasetId": DataID,
               "nuclide": {"element": "Si", "mass": 28, "isomer": 0},
               "observable": {"kind": "lifetime",
                              "lifetime": {"value": 743.9, "unit": "ns",
                                           "uncertainties": [{"source": "total", "value": 5.0}]}}}]}
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Dict, List, Optional

from . import CODE_OF, DEFINED_SUBLIBRARIES, SUBLIBRARIES, ids, jsonfmt
from . import schema as schema_mod
from .cite import file_label, is_placeholder_doi

DATA_DIR = "data"
MASTER_DIR = "data/master"
# master table -> its format
MASTER_FORMATS = {
    "facilities.json": "muND/facilities/1",
    "bibliography.json": "muND/bibliography/1",
    "nuclides.json": "muND/nuclides/1",
    "huff_factors.json": "muND/huff-factors/1",
    "constants.json": "muND/constants/1",
}
DATA_FILE_RE = re.compile(r"^%s/(%s)/.+\.json$" % (DATA_DIR, "|".join(SUBLIBRARIES)))
FILE_LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]*$")


class Issue:
    """A problem found in the database."""

    def __init__(self, level: str, code: str, file: str, pointer: str, message: str):
        self.level = level        # "error" or "warning"
        self.code = code
        self.file = file
        self.pointer = pointer    # JSON pointer inside the file ('' = whole file)
        self.message = message

    def __str__(self) -> str:
        where = self.file + (" " + self.pointer if self.pointer else "")
        return "%-7s %-20s %s: %s" % (self.level.upper(), self.code, where, self.message)


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def is_data_file_path(path: str) -> bool:
    """A file of a sub-library (not a master table)."""
    return bool(DATA_FILE_RE.match(path))


class DataFile:
    """One JSON file of the database, as text and parsed (numbers keep their digits)."""

    def __init__(self, path: str, text: str):
        self.path = path          # posix path relative to the repository root
        self.text = text
        self.obj = None
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
        return [e for e in d if isinstance(e, dict)] if isinstance(d, list) else []

    @property
    def code(self) -> Optional[str]:
        return file_code(_dict(self.obj))


def file_code(obj: dict) -> Optional[str]:
    """EXP / TH / CUR / EVAL for the datasetType of a file."""
    kind = obj.get("datasetType")
    return CODE_OF.get(kind) if isinstance(kind, str) else None


def file_path(obj: dict, reference: Optional[dict] = None) -> str:
    """Canonical path of a file: ``data/<sub-library>/<code>/<label>_<MetaID>.json``."""
    meta = _dict(obj.get("meta"))
    return "%s/%s/%s/%s_%s.json" % (DATA_DIR, obj.get("sublibrary"), file_code(obj),
                                    file_label(meta, reference), meta.get("id"))


def quantity(entry: dict) -> Optional[dict]:
    """The value block of an entry: ``observable[observable.kind]``."""
    obs = _dict(entry.get("observable"))
    kind = obs.get("kind")
    block = obs.get(kind) if isinstance(kind, str) else None
    return block if isinstance(block, dict) else None


def canonical_text(obj) -> str:
    """Members in schema order, empty optional members dropped, canonical layout."""
    schema = schema_mod.schema_for(_dict(obj).get("format"))
    return jsonfmt.dumps(schema_mod.normalize(obj, schema) if schema is not None else obj)


def entry_hash(entry: dict) -> str:
    """Content hash of an entry: 12 hex digits of SHA-256 over its nuclide and observable
    (values, units and uncertainties as written).  Derived entries record it for each of
    their original data, so that a later correction of an original shows."""
    content = {"nuclide": entry.get("nuclide") if isinstance(entry, dict) else None,
               "observable": entry.get("observable") if isinstance(entry, dict) else None}
    return hashlib.sha256(jsonfmt.compact(content).encode("utf-8")).hexdigest()[:12]


def expected_meta_id(obj: dict) -> Optional[str]:
    meta = _dict(obj.get("meta"))
    code = file_code(obj)
    if not isinstance(meta.get("bibId"), str) or code is None:
        return None
    key = meta.get("key") if isinstance(meta.get("key"), str) else None
    return ids.meta_id(str(obj.get("sublibrary")), code, meta["bibId"], key)


def expected_data_id(obj: dict, entry: dict, meta_id: str) -> Optional[str]:
    nuclide = _dict(entry.get("nuclide"))
    mass = nuclide.get("mass")
    if not isinstance(nuclide.get("element"), str) or isinstance(mass, bool) \
            or not isinstance(mass, (int, float)):
        return None
    key = entry.get("key") if isinstance(entry.get("key"), str) else None
    return ids.data_id(str(obj.get("sublibrary")), file_code(obj), nuclide["element"], mass,
                       meta_id, key)


def assign_ids(obj: dict) -> dict:
    """(Re)compute ``meta.id`` and the ``datasetId`` of every entry, in place.

    An entry without element or mass keeps what it has; validation reports it.
    """
    mid = expected_meta_id(obj)
    if mid is None:
        raise ValueError("datasetType and meta.bibId are needed to compute identifiers")
    obj["meta"]["id"] = mid
    for entry in obj.get("data", []):
        did = expected_data_id(obj, entry, mid) if isinstance(entry, dict) else None
        if did is not None:
            entry["datasetId"] = did
    return obj


class Database:
    def __init__(self):
        self.files: List[DataFile] = []           # files of the sub-libraries, sorted by path
        self.master: Dict[str, DataFile] = {}     # master tables by name
        self.unknown: List[str] = []              # other paths under data/
        self._references: Optional[Dict[str, dict]] = None
        self._tables: Optional[dict] = None

    # -- loading -----------------------------------------------------------
    @classmethod
    def load(cls, root) -> "Database":
        """Every ``*.json`` file under ``<root>/data``."""
        root = Path(root)
        texts = {p.relative_to(root).as_posix(): p.read_text(encoding="utf-8")
                 for p in (root / DATA_DIR).glob("**/*.json")}
        return cls.from_texts(texts)

    @classmethod
    def from_texts(cls, texts: Dict[str, str]) -> "Database":
        """A database made of ``{path: text}``."""
        db = cls()
        for path in sorted(texts):
            name = path[len(MASTER_DIR) + 1:] if path.startswith(MASTER_DIR + "/") else None
            if name in MASTER_FORMATS:
                db.master[name] = DataFile(path, texts[path])
            elif is_data_file_path(path):
                db.files.append(DataFile(path, texts[path]))
            else:
                db.unknown.append(path)
        return db

    # -- look-ups ------------------------------------------------------------
    def master_obj(self, name: str) -> dict:
        f = self.master.get(name)
        return f.obj if f is not None and isinstance(f.obj, dict) else {}

    def references(self) -> Dict[str, dict]:
        """Bibliography entries by normalised DOI."""
        if self._references is None:
            out: Dict[str, dict] = {}
            refs = self.master_obj("bibliography.json").get("references")
            for ref in refs if isinstance(refs, list) else []:
                if isinstance(ref, dict) and isinstance(ref.get("DOI"), str):
                    out.setdefault(ids.normalize_doi(ref["DOI"]), ref)
            self._references = out
        return self._references

    def reference(self, doi) -> Optional[dict]:
        return self.references().get(ids.normalize_doi(doi)) if isinstance(doi, str) else None

    def tables(self) -> dict:
        """Look-up tables of the nuclide and facility lists."""
        if self._tables is None:
            nuclides = self.master_obj("nuclides.json")
            elements = nuclides.get("elements") if isinstance(nuclides.get("elements"), list) else []
            ranges = nuclides.get("isotope_ranges") if isinstance(nuclides.get("isotope_ranges"), list) else []
            facilities = self.master_obj("facilities.json").get("facilities")
            self._tables = {
                "elements": elements,
                "z_of": {e: i + 1 for i, e in enumerate(elements)},
                "ranges": {r.get("z"): (r.get("a_min"), r.get("a_max")) for r in ranges if isinstance(r, dict)},
                "facilities": {f.get("abbr") for f in facilities if isinstance(f, dict)}
                if isinstance(facilities, list) else set(),
            }
        return self._tables

    def z_of(self, element) -> int:
        return self.tables()["z_of"].get(element, 0)

    # -- validation --------------------------------------------------------
    def validate(self) -> List[Issue]:
        issues: List[Issue] = []
        for name in MASTER_FORMATS:
            if name not in self.master:
                issues.append(Issue("error", "E_MASTER_MISSING", MASTER_DIR + "/" + name, "",
                                    "master table is missing"))
        for path in self.unknown:
            issues.append(Issue("error", "E_PATH", path, "",
                                "not part of the database: files belong in %s/<sub-library>/<code>/ "
                                "or are one of the master tables in %s/" % (DATA_DIR, MASTER_DIR)))
        for name, f in sorted(self.master.items()):
            issues.extend(self._check_master(name, f))
        for f in self.files:
            issues.extend(self._check_file(f))
        issues.extend(self._check_cross())
        return issues

    @staticmethod
    def _check_syntax(f: DataFile) -> List[Issue]:
        if f.parse_error:
            return [Issue("error", "E_JSON", f.path, "", "not valid JSON: " + f.parse_error)]
        if not isinstance(f.obj, dict):
            return [Issue("error", "E_JSON", f.path, "", "the top level must be an object")]
        return []

    @staticmethod
    def _check_schema(f: DataFile, schema: dict) -> List[Issue]:
        issues = [Issue("error", "E_SCHEMA", f.path, ptr, msg)
                  for ptr, msg in schema_mod.validate(jsonfmt.plain(f.obj), schema)]
        if canonical_text(f.obj) != f.text:
            issues.append(Issue("error", "E_CANONICAL", f.path, "",
                                "file is not in canonical form; run: python3 tools/mund.py fix"))
        return issues

    def _check_master(self, name: str, f: DataFile) -> List[Issue]:
        issues = self._check_syntax(f)
        if issues:
            return issues
        fmt = MASTER_FORMATS[name]
        if f.obj.get("format") != fmt:
            return [Issue("error", "E_FORMAT", f.path, "/format", "expected %r" % fmt)]
        issues = self._check_schema(f, schema_mod.schema_for(fmt))
        if name == "facilities.json":
            issues.extend(self._check_unique(f, "facilities", "abbr", "E_DUPLICATE_FACILITY",
                                             lambda v: v))
        if name == "bibliography.json":
            issues.extend(self._check_unique(f, "references", "DOI", "E_DUPLICATE_REFERENCE",
                                             ids.normalize_doi))
        if name == "constants.json":
            issues.extend(self._check_unique(f, "constants", "name", "E_DUPLICATE_CONSTANT", lambda v: v))
            issues.extend(self._check_constants(f))
        if name == "huff_factors.json":
            issues.extend(self._check_huff(f))
        return issues

    @staticmethod
    def _check_constants(f: DataFile) -> List[Issue]:
        """mu_plus_lifetime is required by the conversions: a positive value in ns."""
        items = f.obj.get("constants")
        found = [(i, c) for i, c in enumerate(items if isinstance(items, list) else [])
                 if isinstance(c, dict) and c.get("name") == "mu_plus_lifetime"]
        if not found:
            return [Issue("error", "E_CONSTANT_MISSING", f.path, "/constants",
                          "mu_plus_lifetime (lifetime of the free positive muon, in ns) is required")]
        issues = []
        for i, c in found:
            if isinstance(c.get("unit"), str) and c["unit"] != "ns":
                issues.append(Issue("error", "E_CONSTANT_UNIT", f.path, "/constants/%d/unit" % i,
                                    "mu_plus_lifetime is given in ns, not %r" % c["unit"]))
            value = c.get("value")
            if isinstance(value, (int, float)) and not isinstance(value, bool) and not value > 0:
                issues.append(Issue("error", "E_CONSTANT_VALUE", f.path, "/constants/%d/value" % i,
                                    "mu_plus_lifetime must be positive"))
        return issues

    @staticmethod
    def _check_huff(f: DataFile) -> List[Issue]:
        """One Huff factor per element and per nuclide."""
        issues = []
        for member, fields in (("by_element", ("z",)), ("by_nuclide", ("z", "a"))):
            seen = set()
            items = f.obj.get(member)
            for i, item in enumerate(items if isinstance(items, list) else []):
                key = tuple(item.get(k) for k in fields) if isinstance(item, dict) else ()
                if not key or not all(isinstance(k, int) and not isinstance(k, bool) for k in key):
                    continue
                if key in seen:
                    issues.append(Issue("error", "E_DUPLICATE_HUFF", f.path, "/%s/%d" % (member, i),
                                        "the Huff factor of %s is listed twice"
                                        % " ".join("%s=%d" % (k.upper(), v) for k, v in zip(fields, key))))
                seen.add(key)
        return issues

    @staticmethod
    def _check_unique(f: DataFile, member: str, key: str, code: str, norm) -> List[Issue]:
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

    def _check_file(self, f: DataFile) -> List[Issue]:
        issues = self._check_syntax(f)
        if issues:
            return issues
        sub = f.path.split("/")[1]
        if sub not in DEFINED_SUBLIBRARIES:
            return [Issue("error", "E_SUBLIBRARY_UNDEFINED", f.path, "",
                          "the data format of sub-library %s is not defined" % sub)]
        fmt = f.obj.get("format")
        schema = schema_mod.schema_for(fmt)
        if schema is None or not fmt.startswith("muND/%s/" % sub):
            return [Issue("error", "E_FORMAT", f.path, "/format",
                          "%r is not a format of sub-library %s" % (fmt, sub))]
        return self._check_schema(f, schema) + self._check_content(f)

    def _check_content(self, f: DataFile) -> List[Issue]:
        """Semantic checks that need only this file and the master tables."""
        obj, path, meta = f.obj, f.path, f.meta
        code = f.code
        issues: List[Issue] = []

        # location
        parts = path.split("/")
        if len(parts) != 4 or parts[1] != obj.get("sublibrary") or parts[2] != code:
            issues.append(Issue("error", "E_PATH", path, "",
                                "file must be stored in %s/%s/%s/" % (DATA_DIR, obj.get("sublibrary"), code)))
        else:
            suffix = "_%s.json" % meta.get("id")
            if not parts[3].endswith(suffix) or not FILE_LABEL_RE.match(parts[3][:-len(suffix)]):
                example = file_path(obj, self.reference(meta.get("bibId"))).split("/")[-1]
                issues.append(Issue("error", "E_PATH", path, "",
                                    "file name must be <label>_<MetaID>.json, e.g. %s" % example))

        # identifiers
        mid = expected_meta_id(obj)
        if mid is not None and meta.get("id") != mid:
            issues.append(Issue("error", "E_META_ID", path, "/meta/id",
                                "MetaID should be %s for this datasetType / bibId / key" % mid))
        ranges = self.tables()["ranges"]
        for i, entry in enumerate(f.data):
            if mid is not None:
                did = expected_data_id(obj, entry, mid)
                if did is not None and entry.get("datasetId") != did:
                    issues.append(Issue("error", "E_DATA_ID", path, "/data/%d/datasetId" % i,
                                        "datasetId should be %s for this element / mass / key" % did))

            # plausibility of the mass number
            nuclide = _dict(entry.get("nuclide"))
            mass = nuclide.get("mass")
            if isinstance(mass, int) and not isinstance(mass, bool) and mass > 0:
                rng = ranges.get(self.z_of(nuclide.get("element")))
                if rng and not (rng[0] - 8 <= mass <= rng[1] + 8):
                    issues.append(Issue("warning", "W_MASS_RANGE", path, "/data/%d/nuclide/mass" % i,
                                        "mass number %d is unusual for %s (known range %d-%d)"
                                        % (mass, nuclide.get("element"), rng[0], rng[1])))

            # at most one overall uncertainty
            block = quantity(entry)
            uncertainties = block.get("uncertainties") if block else None
            if isinstance(uncertainties, list) and \
                    sum(1 for u in uncertainties if _dict(u).get("source") == "total") > 1:
                issues.append(Issue("error", "E_UNCERTAINTY_TOTAL", path,
                                    "/data/%d/observable/%s/uncertainties" % (i, entry["observable"]["kind"]),
                                    "only one uncertainty may have the source 'total'"))

        # metadata
        facility = meta.get("facility")
        if isinstance(facility, str) and facility not in self.tables()["facilities"]:
            issues.append(Issue("error", "E_FACILITY", path, "/meta/facility",
                                "%r is not listed in %s/facilities.json" % (facility, MASTER_DIR)))
        bib_id = meta.get("bibId")
        if isinstance(bib_id, str) and not is_placeholder_doi(bib_id) and self.reference(bib_id) is None:
            issues.append(Issue("warning", "W_NO_REFERENCE", path, "/meta/bibId",
                                "no bibliographic information for %s in %s/bibliography.json"
                                % (bib_id, MASTER_DIR)))
        return issues

    def _check_cross(self) -> List[Issue]:
        """Identifiers that must be unique, and references between entries."""
        issues: List[Issue] = []
        files = [f for f in self.files if isinstance(f.obj, dict)]
        metas: Dict[str, str] = {}
        entries: Dict[str, dict] = {}     # datasetId -> where it is first used
        for f in files:
            mid = f.meta.get("id")
            if isinstance(mid, str):
                if mid in metas:
                    issues.append(Issue("error", "E_DUPLICATE_META", f.path, "/meta/id",
                                        "MetaID %s is also used by %s" % (mid, metas[mid])))
                else:
                    metas[mid] = f.path
            for i, entry in enumerate(f.data):
                did = entry.get("datasetId")
                if not isinstance(did, str):
                    continue
                first = entries.get(did)
                if first is not None:
                    issues.append(Issue("error", "E_DUPLICATE_ID", f.path, "/data/%d/datasetId" % i,
                                        "datasetId %s is also used in %s data[%d]: give the entries "
                                        "different keys" % (did, first["file"].path, first["index"])))
                else:
                    entries[did] = {"file": f, "index": i, "code": f.code,
                                    "sublibrary": f.obj.get("sublibrary"), "entry": entry}
        # earlier identifiers: each names exactly one entry and is nobody's current identifier
        legacy: Dict[str, str] = {}       # earlier id -> current datasetId
        for f in files:
            for i, entry in enumerate(f.data):
                lids = entry.get("legacyIds")
                for k, lid in enumerate(lids if isinstance(lids, list) else []):
                    if not isinstance(lid, str):
                        continue
                    ptr = "/data/%d/legacyIds/%d" % (i, k)
                    current = entries.get(lid)
                    if current is not None:
                        issues.append(Issue("error", "E_LEGACY_ID_CONFLICT", f.path, ptr,
                                            "%s is the current datasetId of %s data[%d]"
                                            % (lid, current["file"].path, current["index"])))
                    elif lid in legacy:
                        issues.append(Issue("error", "E_LEGACY_ID_CONFLICT", f.path, ptr,
                                            "%s is also an earlier identifier of %s" % (lid, legacy[lid])))
                    elif isinstance(entry.get("datasetId"), str):
                        legacy[lid] = entry["datasetId"]
        for f in files:
            for i, entry in enumerate(f.data):
                originals = entry.get("originalData")
                seen = set()
                for j, item in enumerate(originals if isinstance(originals, list) else []):
                    oid = item.get("datasetId") if isinstance(item, dict) else None
                    if not isinstance(oid, str):
                        continue                  # the schema reports it
                    ptr = "/data/%d/originalData/%d" % (i, j)
                    if oid in seen:
                        issues.append(Issue("error", "E_ORIGINAL_DUPLICATE", f.path, ptr,
                                            "original data %s is listed twice" % oid))
                        continue
                    seen.add(oid)
                    current = oid if oid in entries else legacy.get(oid)
                    target = entries.get(current) if current is not None else None
                    if target is None or target["sublibrary"] != f.obj.get("sublibrary"):
                        issues.append(Issue("error", "E_ORIGINAL_MISSING", f.path, ptr,
                                            "original data %s does not exist" % oid))
                    elif current == entry.get("datasetId"):
                        issues.append(Issue("error", "E_ORIGINAL_SELF", f.path, ptr,
                                            "an entry cannot be its own original data"))
                    elif f.code == "CUR" and target["code"] != "EXP":
                        issues.append(Issue("error", "E_ORIGINAL_NOT_EXP", f.path, ptr,
                                            "curated data must refer to experimental data; "
                                            "%s is %s" % (oid, target["code"])))
                    else:
                        if current != oid:
                            issues.append(Issue("warning", "W_ORIGINAL_LEGACY", f.path, ptr,
                                                "%s is an earlier identifier of %s: refer to %s"
                                                % (oid, current, current)))
                        now = entry_hash(target["entry"])
                        recorded = item.get("entryHash")
                        if isinstance(recorded, str) and recorded != now:
                            issues.append(Issue("warning", "W_ORIGINAL_CHANGED", f.path, ptr,
                                                "%s has changed since this entry was derived from it "
                                                "(entryHash %s, now %s): check this entry again, then "
                                                "record the new entryHash" % (current, recorded, now)))
        return issues
