"""The files under ``data/`` and their checks
(twin of ``site/assets/js/core/database.js``; shared cases: ``tests/vectors/cases.json``).

Three layers of checks (``docs/data-format.md`` §5)::

    1. syntax    the file is JSON and written in its canonical form
    2. schema    the file follows schema/v1/*.schema.json
    3. semantic  identifiers match their definition and are unique, references
                 resolve, facilities exist ...
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from . import CODE_OF, DEFINED_SUBLIBRARIES, SUBLIBRARIES, ids, jsonfmt
from . import schema as schema_mod
from .cite import bib_kind, file_label
from .jsonfmt import as_dict, is_int, is_number, objects

DATA_DIR = "data"
MASTER_DIR = "data/master"
# master table -> its format
MASTER_FORMATS = {
    "facilities.json": "muND/facilities/1",
    "bibliography.json": "muND/bibliography/1",
    "nuclides.json": "muND/nuclides/1",
    "huff_factors.json": "muND/huff-factors/1",
    "constants.json": "muND/constants/2",
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


def _check_mass(issues, path, pointer, z, mass):
    if is_int(z) and is_int(mass) and 0 < mass < z:
        issues.append(Issue("error", "E_MASS_BELOW_Z", path, pointer, "mass number is smaller than atomic number"))


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
        return as_dict(as_dict(self.obj).get("meta"))

    @property
    def data(self) -> list:
        return objects(as_dict(self.obj).get("data"))

    @property
    def code(self) -> Optional[str]:
        return file_code(as_dict(self.obj))


def file_code(obj: dict) -> Optional[str]:
    """EXP / TH / CUR / EVAL for the datasetType of a file."""
    kind = obj.get("datasetType")
    return CODE_OF.get(kind) if isinstance(kind, str) else None


def file_path(obj: dict, reference: Optional[dict] = None) -> str:
    """Canonical path of a file: ``data/<sub-library>/<code>/<label>_<MetaID>.json``."""
    meta = as_dict(obj.get("meta"))
    return "%s/%s/%s/%s_%s.json" % (DATA_DIR, obj.get("sublibrary"), file_code(obj),
                                    file_label(meta, reference), meta.get("id"))


def quantity(entry: dict) -> Optional[dict]:
    """The value block of an entry: ``observable[observable.kind]``."""
    obs = as_dict(entry.get("observable"))
    kind = obs.get("kind")
    block = obs.get(kind) if isinstance(kind, str) else None
    return block if isinstance(block, dict) else None


def entry_hash(entry: dict) -> str:
    """Content hash of an entry: 12 hex digits of SHA-256 over its nuclide and observable
    (values, units and uncertainties as written).  Derived entries record it for each of
    their original data, so that a later correction of an original shows."""
    content = {"nuclide": entry.get("nuclide") if isinstance(entry, dict) else None,
               "observable": entry.get("observable") if isinstance(entry, dict) else None}
    return hashlib.sha256(jsonfmt.compact(content).encode("utf-8")).hexdigest()[:12]


def expected_meta_id(obj: dict) -> Optional[str]:
    meta = as_dict(obj.get("meta"))
    code = file_code(obj)
    if not isinstance(meta.get("bibId"), str) or code is None:
        return None
    key = meta.get("key") if isinstance(meta.get("key"), str) else None
    return ids.meta_id(str(obj.get("sublibrary")), code, meta["bibId"], key)


def expected_data_id(obj: dict, entry: dict, meta_id: str) -> Optional[str]:
    nuclide = as_dict(entry.get("nuclide"))
    mass = nuclide.get("mass")
    if not isinstance(nuclide.get("element"), str) or not is_number(mass):
        return None
    key = entry.get("key") if isinstance(entry.get("key"), str) else None
    return ids.data_id(str(obj.get("sublibrary")), file_code(obj), nuclide["element"], mass,
                       meta_id, key)


def assign_ids(obj: dict) -> dict:
    """(Re)compute ``meta.id`` and the ``datasetId`` of every entry, in place.

    An entry without element or mass keeps what it has; validation reports it.
    """
    if not isinstance(obj, dict):
        raise ValueError("the top level is not an object")
    if not isinstance(obj.get("data"), list):
        raise ValueError("data must be an array")
    mid = expected_meta_id(obj)
    if mid is None:
        raise ValueError("datasetType and meta.bibId are needed to compute identifiers")
    obj["meta"]["id"] = mid
    for entry in obj["data"]:
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
        texts = {p.relative_to(root).as_posix(): p.read_bytes().decode("utf-8")
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
        """Bibliography entries by their normalised ``id`` (the bibId)."""
        if self._references is None:
            out: Dict[str, dict] = {}
            refs = self.master_obj("bibliography.json").get("references")
            for ref in refs if isinstance(refs, list) else []:
                if isinstance(ref, dict) and isinstance(ref.get("id"), str) and ref["id"]:
                    out.setdefault(ids.normalize_bib_id(ref["id"]), ref)
            self._references = out
        return self._references

    def reference(self, bib_id) -> Optional[dict]:
        return self.references().get(ids.normalize_bib_id(bib_id)) if isinstance(bib_id, str) else None

    def tables(self) -> dict:
        """Look-up tables of the nuclide and facility lists; items of the wrong type
        (which the schema check reports) are left out."""
        if self._tables is None:
            nuclides = self.master_obj("nuclides.json")
            elements = nuclides.get("elements") if isinstance(nuclides.get("elements"), list) else []
            self._tables = {
                "elements": elements,
                "z_of": {e: i + 1 for i, e in enumerate(elements) if isinstance(e, str)},
                "ranges": {r["z"]: (r["a_min"], r["a_max"]) for r in objects(nuclides.get("isotope_ranges"))
                           if all(is_number(r.get(k)) for k in ("z", "a_min", "a_max"))},
                "facilities": {f["abbr"]: f for f in objects(self.master_obj("facilities.json").get("facilities"))
                               if isinstance(f.get("abbr"), str)},
            }
        return self._tables

    def z_of(self, element) -> int:
        return self.tables()["z_of"].get(element, 0) if isinstance(element, str) else 0

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
                  for ptr, msg in schema_mod.validate(f.obj, schema)]
        if schema_mod.canonical_text(f.obj) != f.text:
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
            issues.extend(self._check_unique(f, "references", "id", "E_DUPLICATE_REFERENCE",
                                             ids.normalize_bib_id))
        if name == "nuclides.json":
            issues.extend(self._check_nuclides(f))
        if name == "huff_factors.json":
            issues.extend(self._check_huff(f))
        return issues

    @staticmethod
    def _check_nuclides(f: DataFile) -> List[Issue]:
        issues = []
        elements = f.obj.get("elements")
        expected = schema_mod.schema_for("muND/LT/1")["$defs"]["element"]["enum"]
        if isinstance(elements, list) and all(isinstance(e, str) for e in elements) and elements != expected:
            issues.append(Issue("error", "E_ELEMENT_ORDER", f.path, "/elements",
                                "list the LT element symbols in atomic number order"))
        for member in ("isotope_ranges", "monoisotopic"):
            seen = set()
            rows = f.obj.get(member)
            for i, row in enumerate(rows if isinstance(rows, list) else []):
                z = as_dict(row).get("z")
                if not is_int(z):
                    continue
                ptr = "/%s/%d/z" % (member, i)
                if z in seen:
                    issues.append(Issue("error", "E_DUPLICATE_Z", f.path, ptr, "atomic number listed twice"))
                if isinstance(elements, list) and z > len(elements):
                    issues.append(Issue("error", "E_UNKNOWN_Z", f.path, ptr, "atomic number outside the element table"))
                for field in (("a_min", "a_max") if member == "isotope_ranges" else ("a",)):
                    _check_mass(issues, f.path, "/%s/%d/%s" % (member, i, field), z, row.get(field))
                seen.add(z)
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
                if not key or not all(is_int(k) for k in key):
                    continue
                if member == "by_nuclide":
                    _check_mass(issues, f.path, "/by_nuclide/%d/a" % i, *key)
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
            nuclide = as_dict(entry.get("nuclide"))
            mass = nuclide.get("mass")
            if is_int(mass) and mass > 0:
                z = self.z_of(nuclide.get("element"))
                _check_mass(issues, path, "/data/%d/nuclide/mass" % i, z, mass)
                rng = ranges.get(z)
                if mass >= z and rng and not (rng[0] - 8 <= mass <= rng[1] + 8):
                    issues.append(Issue("warning", "W_MASS_RANGE", path, "/data/%d/nuclide/mass" % i,
                                        "mass number %d is unusual for %s (known range %d-%d)"
                                        % (mass, nuclide.get("element"), rng[0], rng[1])))

            # at most one overall uncertainty
            block = quantity(entry)
            uncertainties = block.get("uncertainties") if block else None
            if isinstance(uncertainties, list) and \
                    sum(1 for u in uncertainties if as_dict(u).get("source") == "total") > 1:
                issues.append(Issue("error", "E_UNCERTAINTY_TOTAL", path,
                                    "/data/%d/observable/%s/uncertainties" % (i, entry["observable"]["kind"]),
                                    "only one uncertainty may have the source 'total'"))

        # metadata
        facility = meta.get("facility")
        if isinstance(facility, str) and facility not in self.tables()["facilities"]:
            issues.append(Issue("error", "E_FACILITY", path, "/meta/facility",
                                "%r is not listed in %s/facilities.json" % (facility, MASTER_DIR)))
        bib_id = meta.get("bibId")
        # a DOI or an NSR keynumber has its bibliographic data in the bibliography; a muND key may have them
        if bib_kind(bib_id) in ("DOI", "NSR") and self.reference(bib_id) is None:
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
                                        "datasetId %s is also used in %s: give the entries different keys"
                                        % (did, first["file"].path)))
                else:
                    entries[did] = {"file": f, "code": f.code,
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
                                            "%s is the current datasetId of an entry in %s"
                                            % (lid, current["file"].path)))
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
                    current = oid if oid in entries else legacy.get(oid, oid)
                    if current in seen:
                        issues.append(Issue("error", "E_ORIGINAL_DUPLICATE", f.path, ptr,
                                            "original data %s is listed twice" % oid))
                        continue
                    seen.add(current)
                    target = entries.get(current)
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


def _id_changes(before: dict, after: dict) -> List[str]:
    """``meta.id OLD -> NEW`` and ``datasetId OLD -> NEW`` for each identifier that is there and differs."""
    pairs = [("meta.id", as_dict(before.get("meta")).get("id"), as_dict(after.get("meta")).get("id"))]
    if isinstance(before.get("data"), list):
        pairs += [("datasetId", as_dict(old).get("datasetId"), as_dict(new).get("datasetId"))
                  for old, new in zip(before["data"], after["data"])]
    return ["%s %s -> %s" % (name, old, new) for name, old, new in pairs if old not in (None, "") and old != new]


def fix_files(root, paths=None) -> List[Tuple[str, str]]:
    """Write files of the database with their missing identifiers filled in, in canonical
    form and under their canonical file name; returns ``(old path, new path)`` of each file written.

    ``paths`` are relative to ``root`` (default: every file).  All files are checked before
    any is written, and nothing is written when one of them cannot be fixed: it is not a JSON
    object, an identifier it has would change (the data entry tool makes that change and keeps
    the old identifier in ``legacyIds``), or its file name would be that of another file.
    """
    root = Path(root)
    db = Database.load(root)
    if paths is None:
        for folder in sorted((root / DATA_DIR).glob("*")):
            if folder.is_dir() and folder.name not in (*DEFINED_SUBLIBRARIES, "master"):
                raise ValueError("%s: undefined sub-library" % folder.relative_to(root))
        if db.unknown:
            raise ValueError("%s is not a file of the database" % db.unknown[0])
    files = {f.path: f for f in db.files + list(db.master.values())}
    plans: Dict[str, Tuple[str, bytes]] = {}      # target -> (source, encoded contents)
    owners = {rel.casefold(): rel for rel in files}
    for rel in sorted(files) if paths is None else dict.fromkeys(paths):
        f = files.get(rel)
        if f is None:
            raise ValueError("%s is not a file of the database" % rel)
        if f.parse_error is not None:
            raise ValueError("%s: not valid JSON: %s" % (rel, f.parse_error))
        if not isinstance(f.obj, dict):
            raise ValueError("%s: the top level is not an object" % rel)
        obj, target = f.obj, rel
        if is_data_file_path(rel):
            sub = rel.split("/")[1]
            fmt = obj.get("format")
            schema = schema_mod.schema_for(fmt)
            if sub not in DEFINED_SUBLIBRARIES or schema is None or not fmt.startswith("muND/%s/" % sub):
                raise ValueError("%s: undefined sub-library or format %r" % (rel, fmt))
            obj = schema_mod.normalize(obj, schema)
            if obj.get("sublibrary") != sub:
                raise ValueError("%s: expected sub-library %s" % (rel, sub))
            try:
                assign_ids(obj)
            except ValueError as exc:
                raise ValueError("%s: %s" % (rel, exc)) from None
            changes = _id_changes(f.obj, obj)
            if changes:
                more = " and %d more" % (len(changes) - 3) if len(changes) > 3 else ""
                raise ValueError("%s: identifiers would change (%s%s); make this change in the data entry "
                                 "tool, which keeps the old ID in legacyIds" % (rel, ", ".join(changes[:3]), more))
            target = file_path(obj, db.reference(obj["meta"].get("bibId")))
            allowed = root.resolve() / DATA_DIR / sub
            if any(not (root / path).resolve().is_relative_to(allowed) for path in (rel, target)):
                raise ValueError("%s: path outside %s" % (rel, allowed))
        text = schema_mod.canonical_text(obj)
        if text == f.text and target == rel:
            continue
        other = owners.get(target.casefold())
        if other is not None and other != rel:
            raise ValueError("%s: its file name would be %s, which another file has: %s" % (rel, target, other))
        owners[target.casefold()] = rel
        if target != rel and (root / target).exists() \
                and not (root / target).samefile(root / rel):
            raise ValueError("%s: its file name would be %s, which another file has (same MetaID?)" % (rel, target))
        if not os.access(root / rel, os.W_OK):
            raise PermissionError("%s is not writable" % rel)
        plans[target] = (rel, text.encode("utf-8"))
    if not plans:
        return []

    work = Path(tempfile.mkdtemp(prefix=".mund-fix-", dir=root))
    backups, installed, created_dirs = [], [], []
    try:
        for i, (target, (rel, content)) in enumerate(plans.items()):
            staged = work / str(i)
            staged.write_bytes(content)
            shutil.copymode(root / rel, staged)
            parent = (root / target).parent
            if not parent.exists():
                parent.mkdir()
                created_dirs.append(parent)
        for i, (target, (rel, _)) in enumerate(plans.items()):
            backup = work / ("%d.orig" % i)
            (root / rel).rename(backup)
            backups.append((backup, root / rel))
            (work / str(i)).replace(root / target)
            installed.append(root / target)
    except BaseException:
        for path in reversed(installed):
            path.unlink()
        for backup, original in reversed(backups):
            backup.rename(original)
        for folder in reversed(created_dirs):
            folder.rmdir()
        shutil.rmtree(work)
        raise
    shutil.rmtree(work)
    return [(rel, target) for target, (rel, _) in plans.items()]
