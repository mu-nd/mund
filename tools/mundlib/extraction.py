"""Independent double extraction of values from a source, their comparison,
adjudication and approval, and the publication of approved values to
``data/`` (description: ``docs/extraction.ja.md``; the page is
``admin/js/extraction*.js``, which computes the same content hash).

The work area is outside the database::

    extraction/<task>/task.json          the source (bibId, version, SHA-256 and size of the PDF,
                                         its tables and figures) and where values are published
    extraction/<task>/input-A.json       first input   (human | ai | assisted)
    extraction/<task>/input-B.json       second input
    extraction/<task>/adjudication.json  adopted rows, rows not adopted, decisions on the
                                         source items, approval
    extraction/<task>/source.pdf         the PDF on this computer only (never saved: .gitignore)

What is enforced here, on every save of the data entry tool:

* the files follow their schemas (``schema/v1/extraction-*.schema.json``) and are canonical;
* a submitted input is never changed; an AI input or AI draft is written only by the AI run;
* the adjudication refers to rows of the inputs and adopts them unchanged (``agreed``: the
  rows of A and B are identical; ``A`` / ``B``: that row);
* an approval is recorded under the name of the person saving it and for the content saved;
* publication records are written only by the publication, which refuses results that are
  not approved or that changed after the approval.
"""
from __future__ import annotations

import base64
import binascii
import datetime
import hashlib
import json
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from . import CODE_OF, ids, jsonfmt
from . import schema as schema_mod
from .database import (Database, Issue, assign_ids, canonical_text as data_canonical_text, entry_hash,
                       expected_data_id, file_path)

WORK_DIR = "extraction"
PDF_NAME = "source.pdf"
MAX_PDF_BYTES = 64 * 1024 * 1024
FORMATS = {
    "task.json": "muND/extraction-task/1",
    "input-A.json": "muND/extraction-input/1",
    "input-B.json": "muND/extraction-input/1",
    "adjudication.json": "muND/extraction-adjudication/1",
}
FILES = tuple(FORMATS)
SCHEMA_FILES = {
    "muND/extraction-task/1": "extraction-task.schema.json",
    "muND/extraction-input/1": "extraction-input.schema.json",
    "muND/extraction-adjudication/1": "extraction-adjudication.schema.json",
}
SLOTS = ("A", "B")
TASK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
WORK_FILE_RE = re.compile(r"^%s/([A-Za-z0-9][A-Za-z0-9._-]*)/(task|input-A|input-B|adjudication)\.json$" % WORK_DIR)
# what a row says; the adjudication compares and adopts these members (not id, needsCheck, notes)
CONTENT_KEYS = ("location", "nuclide", "kind", "conditions", "original", "value", "unit", "uncertainties")
AGREED_COVERAGE = ("covered", "no-data")

_schemas: Dict[str, dict] = {}


class WorkError(Exception):
    """A refusal the page can explain (``code``), with the HTTP status of the tool's server."""

    def __init__(self, code: str, message: str, status: int = 409, **extra):
        super().__init__(message)
        self.code = code
        self.status = status
        self.extra = extra


# ---------------------------------------------------------------------------
# files
# ---------------------------------------------------------------------------

def is_work_file(path: str) -> bool:
    """A file of the work area the tool reads and saves."""
    return bool(WORK_FILE_RE.match(path))


def task_path(task_id: str, name: str) -> str:
    return "%s/%s/%s" % (WORK_DIR, task_id, name)


def input_name(slot: str) -> str:
    return "input-%s.json" % slot


def schema_of(fmt) -> Optional[dict]:
    name = SCHEMA_FILES.get(fmt) if isinstance(fmt, str) else None
    if name is None:
        return None
    if name not in _schemas:
        with open(schema_mod.SCHEMA_DIR / name, encoding="utf-8") as fh:
            _schemas[name] = json.load(fh)
    return _schemas[name]


def canonical_text(obj) -> str:
    """Members in schema order, empty optional members dropped, canonical layout."""
    schema = schema_of(obj.get("format")) if isinstance(obj, dict) else None
    return jsonfmt.dumps(schema_mod.normalize(obj, schema) if schema is not None else obj)


def read_texts(root, task_id: str) -> Dict[str, Optional[str]]:
    """{file name: text or None} of a task as stored on this computer."""
    folder = Path(root) / WORK_DIR / task_id
    return {name: (folder / name).read_text(encoding="utf-8") if (folder / name).is_file() else None
            for name in FILES}


def known_elements(root) -> set:
    path = Path(root) / "data" / "master" / "nuclides.json"
    try:
        elements = json.loads(path.read_text(encoding="utf-8")).get("elements")
    except (OSError, ValueError, AttributeError):
        return set()
    return set(elements) if isinstance(elements, list) else set()


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# content, coverage and the approved content hash (twin: admin/js/extraction.js)
# ---------------------------------------------------------------------------

def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value) -> list:
    return value if isinstance(value, list) else []


def sha256_of(value) -> str:
    """SHA-256 of the compact text of a value (sorted keys, numbers as written)."""
    return hashlib.sha256(jsonfmt.compact(value).encode("utf-8")).hexdigest()


def row_content(row: dict) -> dict:
    return {k: row[k] for k in CONTENT_KEYS if k in _dict(row)}


def same_content(x: dict, y: dict) -> bool:
    """Exactly the same content: equal members, numbers with the same written digits."""
    return jsonfmt.compact(row_content(x)) == jsonfmt.compact(row_content(y))


def content_hash(task: dict, a: dict, b: dict, adjudication: dict) -> str:
    """The hash an approval is bound to: source (with the SHA-256 of the PDF), target, both
    inputs as saved, and the adjudication without its approval."""
    task, adjudication = _dict(task), _dict(adjudication)
    content = {
        "task": task.get("id"),
        "source": task.get("source"),
        "target": task.get("target"),
        "inputs": {"A": sha256_of(a), "B": sha256_of(b)},
        "rows": _list(adjudication.get("rows")),
        "excluded": _list(adjudication.get("excluded")),
        "coverage": _list(adjudication.get("coverage")),
    }
    return sha256_of(content)


def coverage_items(task: dict, a: dict, b: dict) -> List[str]:
    """Labels of the source items: the task's, then those only the inputs name (in coverage or rows)."""
    labels: List[str] = []

    def add(label):
        if isinstance(label, str) and label and label not in labels:
            labels.append(label)

    for item in _list(_dict(_dict(task).get("source")).get("items")):
        add(_dict(item).get("label"))
    for inp in (a, b):
        for c in _list(_dict(inp).get("coverage")):
            add(_dict(c).get("item"))
    for inp in (a, b):
        for row in _list(_dict(inp).get("rows")):
            add(_dict(_dict(row).get("location")).get("item"))
    return labels


def coverage_status(inp: dict, label: str) -> Optional[str]:
    for c in _list(_dict(inp).get("coverage")):
        if _dict(c).get("item") == label:
            return c.get("status")
    return None


def is_submitted(inp) -> bool:
    return isinstance(inp, dict) and isinstance(inp.get("submitted"), dict)


def adjudication_problems(task: dict, a: dict, b: dict, adj: dict) -> Tuple[List[tuple], List[tuple]]:
    """(integrity, open): problems as (pointer, code, message).

    integrity  wrong at any time: a reference to no row, a row used twice, an 'agreed' row
               whose inputs differ, an adopted row that is not the row of the input
    open       not decided yet: rows of an input and source items marked differently
               that the adjudication does not mention
    """
    integrity, open_items = [], []
    rows = {"a": {r.get("id"): r for r in _list(_dict(a).get("rows")) if isinstance(r, dict)},
            "b": {r.get("id"): r for r in _list(_dict(b).get("rows")) if isinstance(r, dict)}}
    used = {"a": {}, "b": {}}

    def refer(ptr, entry):
        found = {}
        for side in ("a", "b"):
            rid = entry.get(side)
            if rid is None:
                continue
            if rid not in rows[side]:
                integrity.append((ptr + "/" + side, "E_ADJ_REFERENCE",
                                  "input %s has no row %r" % (side.upper(), rid)))
                continue
            used[side][rid] = used[side].get(rid, 0) + 1
            found[side] = rows[side][rid]
        return found

    final_ids = set()
    for i, row in enumerate(_list(_dict(adj).get("rows"))):
        if not isinstance(row, dict):
            continue
        ptr = "/rows/%d" % i
        if row.get("id") in final_ids:
            integrity.append((ptr + "/id", "E_ADJ_ROW_ID", "row id %r is used twice" % row.get("id")))
        final_ids.add(row.get("id"))
        found = refer(ptr, row)
        adopted = row.get("adopted")
        if adopted == "agreed":
            ra, rb = found.get("a"), found.get("b")
            if ra is None or rb is None:
                integrity.append((ptr, "E_ADJ_AGREED", "an agreed row names a row of A and a row of B"))
            elif "needsCheck" in ra or "needsCheck" in rb or not same_content(ra, rb) or not same_content(ra, row):
                integrity.append((ptr, "E_ADJ_AGREED", "the rows of A and B are not identical (or are marked "
                                  "for checking): the row needs a decision"))
        elif adopted in ("A", "B"):
            source = found.get(adopted.lower())
            if source is None:
                integrity.append((ptr, "E_ADJ_ADOPTED", "the row adopted from %s names no row of %s"
                                  % (adopted, adopted)))
            elif not same_content(source, row):
                integrity.append((ptr, "E_ADJ_ADOPTED", "the row differs from row %r of input %s: a changed row "
                                  "is adopted as 'other'" % (source.get("id"), adopted)))
    for j, entry in enumerate(_list(_dict(adj).get("excluded"))):
        if not isinstance(entry, dict):
            continue
        if entry.get("a") is None and entry.get("b") is None:
            integrity.append(("/excluded/%d" % j, "E_ADJ_REFERENCE", "names no row"))
        refer("/excluded/%d" % j, entry)
    for side in ("a", "b"):
        for rid in rows[side]:
            count = used[side].get(rid, 0)
            if count > 1:
                integrity.append(("", "E_ADJ_TWICE", "row %r of input %s is decided %d times"
                                  % (rid, side.upper(), count)))
            elif count == 0:
                open_items.append(("", "OPEN_ROW", "row %r of input %s is not decided" % (rid, side.upper())))

    decided = {_dict(c).get("item") for c in _list(_dict(adj).get("coverage"))}
    for label in coverage_items(task, a, b):
        sa, sb = coverage_status(a, label), coverage_status(b, label)
        if not (sa == sb and sa in AGREED_COVERAGE) and label not in decided:
            open_items.append(("", "OPEN_ITEM", "source item %r is marked %s by A and %s by B"
                               % (label, sa or "nothing", sb or "nothing")))
    return integrity, open_items


def approval_state(task: dict, a: dict, b: dict, adj: dict) -> str:
    """'none' (not approved), 'approved', or 'stale' (changed after the approval)."""
    approval = _dict(adj).get("approval")
    if not isinstance(approval, dict):
        return "none"
    return "approved" if approval.get("contentHash") == content_hash(task, a, b, adj) else "stale"


# ---------------------------------------------------------------------------
# checks of a save
# ---------------------------------------------------------------------------

def _parse(text):
    if text is None:
        return None
    try:
        obj = jsonfmt.loads(text)
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def check_task(task_id: str, after: Dict[str, Optional[str]], before: Dict[str, Optional[str]],
               elements: set = frozenset(), user: Optional[str] = None,
               writer: Optional[str] = None) -> List[Issue]:
    """Problems of the files of one task as they will be (``after``), and of the change from
    ``before``.  ``writer``: 'ai' for the AI run, 'publish' for the publication, else None."""
    issues: List[Issue] = []
    objs: Dict[str, dict] = {}

    def add(level, code, name, pointer, message):
        issues.append(Issue(level, code, task_path(task_id, name), pointer, message))

    if not TASK_ID_RE.match(task_id):
        add("error", "E_PATH", "task.json", "", "a task name consists of letters, digits, '.', '_' and '-'")
        return issues
    for name in FILES:
        text = after.get(name)
        if text is None:
            continue
        try:
            obj = jsonfmt.loads(text)
        except ValueError as exc:
            add("error", "E_JSON", name, "", "not valid JSON: %s" % exc)
            continue
        if not isinstance(obj, dict) or obj.get("format") != FORMATS[name]:
            add("error", "E_FORMAT", name, "/format", "expected %r" % FORMATS[name])
            continue
        problems = schema_mod.validate(jsonfmt.plain(obj), schema_of(FORMATS[name]))
        for ptr, msg in problems:
            add("error", "E_SCHEMA", name, ptr, msg)
        if canonical_text(obj) != text:
            add("error", "E_CANONICAL", name, "", "file is not in canonical form")
        if not problems:
            objs[name] = obj

    task = objs.get("task.json")
    a, b, adj = objs.get("input-A.json"), objs.get("input-B.json"), objs.get("adjudication.json")
    if after.get("task.json") is None and any(after.get(n) is not None for n in FILES[1:]):
        add("error", "E_TASK_MISSING", "task.json", "", "the task file is missing")
    if task is not None:
        if task["id"] != task_id:
            add("error", "E_TASK_ID", "task.json", "/id", "must be the name of the directory, %r" % task_id)
        labels = [i["label"] for i in task["source"].get("items", [])]
        for k, label in enumerate(labels):
            if label in labels[:k]:
                add("error", "E_ITEM_DUPLICATE", "task.json", "/source/items/%d/label" % k, "%r is listed twice" % label)

    for slot, inp in (("A", a), ("B", b)):
        if inp is None:
            continue
        name = input_name(slot)
        if inp["task"] != task_id:
            add("error", "E_TASK_ID", name, "/task", "must be %r" % task_id)
        if inp["slot"] != slot:
            add("error", "E_INPUT_SLOT", name, "/slot", "the file of input %s must say slot %r" % (slot, slot))
        seen = set()
        for k, row in enumerate(inp["rows"]):
            if row["id"] in seen:
                add("error", "E_ROW_ID", name, "/rows/%d/id" % k, "row id %r is used twice" % row["id"])
            seen.add(row["id"])
            element = _dict(row.get("nuclide")).get("element")
            if elements and element is not None and element not in elements:
                add("error", "E_ELEMENT", name, "/rows/%d/nuclide/element" % k, "%r is not an element symbol" % element)
        marked = [c["item"] for c in inp["coverage"]]
        for k, label in enumerate(marked):
            if label in marked[:k]:
                add("error", "E_COVERAGE_DUPLICATE", name, "/coverage/%d" % k, "%r is marked twice" % label)
        if task is not None:
            if inp["sourceSha256"] != task["source"]["sha256"]:
                add("error" if is_submitted(inp) else "warning", "E_SOURCE_MISMATCH", name, "/sourceSha256",
                    "made from another PDF than the one of the task (SHA-256 differs)")
            if is_submitted(inp):
                for item in task["source"].get("items", []):
                    if item["label"] not in marked:
                        add("error", "E_COVERAGE_INCOMPLETE", name, "/coverage",
                            "a submitted input marks every source item; %r is not marked" % item["label"])

    if adj is not None:
        if adj["task"] != task_id:
            add("error", "E_TASK_ID", "adjudication.json", "/task", "must be %r" % task_id)
        if not (is_submitted(a) and is_submitted(b)):
            add("error", "E_ADJUDICATION_EARLY", "adjudication.json", "",
                "the inputs are compared only after both are submitted")
        else:
            integrity, open_items = adjudication_problems(task, a, b, adj)
            for ptr, code, msg in integrity:
                add("error", code, "adjudication.json", ptr, msg)
            approval = adj.get("approval")
            old = _dict(_parse(before.get("adjudication.json"))).get("approval")
            if isinstance(approval, dict) and jsonfmt.compact(approval) != jsonfmt.compact(old if old is not None else {}):
                if not user or approval["by"] != user:
                    add("error", "E_APPROVAL_BY", "adjudication.json", "/approval/by",
                        "an approval is recorded under the name of the person who saves it (%s)" % (user or "unknown"))
                if open_items or integrity:
                    add("error", "E_APPROVAL_INCOMPLETE", "adjudication.json", "/approval",
                        "cannot be approved: %d point(s) are not decided" % (len(open_items) + len(integrity)))
                if task is not None and approval["contentHash"] != content_hash(task, a, b, adj):
                    add("error", "E_APPROVAL_HASH", "adjudication.json", "/approval/contentHash",
                        "does not match the content saved")

    # changes: what only the AI run and the publication may write, and frozen inputs
    for slot in SLOTS:
        name = input_name(slot)
        old_text, new_text = before.get(name), after.get(name)
        old, new = _parse(old_text), _parse(new_text)
        if old_text == new_text:
            continue
        if is_submitted(old):
            add("error", "E_INPUT_SUBMITTED", name, "", "a submitted input cannot be changed or deleted")
            continue
        if writer != "ai" and new is not None:
            if new.get("mode") == "ai":
                add("error", "E_AI_RECORD", name, "/mode", "an AI input is written only by the AI run")
            if jsonfmt.compact(_dict(old).get("aiDraft")) != jsonfmt.compact(new.get("aiDraft")):
                add("error", "E_AI_RECORD", name, "/aiDraft", "the AI draft is written only by the AI run")
    old_task, new_task = _parse(before.get("task.json")), _parse(after.get("task.json"))
    old_pubs = _list(_dict(old_task).get("publications"))
    new_pubs = _list(_dict(new_task).get("publications"))
    if jsonfmt.compact(old_pubs) != jsonfmt.compact(new_pubs):
        if writer != "publish":
            add("error", "E_PUBLICATION_RECORD", "task.json", "/publications",
                "publication records are written only by the publication")
        elif (new_pubs[:len(old_pubs)] != old_pubs or len(new_pubs) != len(old_pubs) + 1
              or task is None or a is None or b is None or adj is None
              or approval_state(task, a, b, adj) != "approved"
              or new_pubs[-1].get("contentHash") != content_hash(task, a, b, adj)):
            add("error", "E_PUBLICATION_NOT_APPROVED", "task.json", "/publications",
                "only approved content that has not changed since its approval is published")
    return issues


def validate_work_area(root) -> List[Issue]:
    """The work area as it is stored (``mund.py validate``; CI): every task's files, and whether
    what was published from a task still is what was approved and what is in data/."""
    root = Path(root)
    base = root / WORK_DIR
    issues: List[Issue] = []
    if not base.is_dir():
        return issues
    elements = known_elements(root)
    allowed = set(FILES) | {PDF_NAME}
    for path in sorted(base.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if path.is_file() and not (is_work_file(rel) or (path.name == PDF_NAME and path.parent.parent == base)):
            issues.append(Issue("error", "E_PATH", rel, "", "only %s are kept in a task folder" % ", ".join(sorted(allowed))))
    db = None
    for folder in sorted(p for p in base.iterdir() if p.is_dir()):
        texts = read_texts(root, folder.name)
        issues.extend(check_task(folder.name, texts, texts, elements))
        task = _parse(texts.get("task.json"))
        pubs = _list(_dict(task).get("publications"))
        if not pubs:
            continue
        a, b = _parse(texts.get("input-A.json")), _parse(texts.get("input-B.json"))
        adj = _parse(texts.get("adjudication.json"))
        where = task_path(folder.name, "task.json")
        if None in (a, b, adj) or pubs[-1].get("contentHash") != content_hash(task, a, b, adj):
            issues.append(Issue("warning", "W_EXTRACTION_CHANGED", where, "/publications",
                                "the task changed after its last publication: approve it again and publish"))
        db = db or Database.load(root)
        current = {}
        for f in db.files:
            for e in f.data:
                if isinstance(e.get("datasetId"), str):
                    current[(f.path, e["datasetId"])] = e
        for k, entry in enumerate(_list(_dict(pubs[-1]).get("entries"))):
            found = current.get((pubs[-1].get("path"), _dict(entry).get("datasetId")))
            ptr = "/publications/%d/entries/%d" % (len(pubs) - 1, k)
            if found is None:
                issues.append(Issue("warning", "W_PUBLISHED_MISSING", where, ptr,
                                    "%s published from this task is not in %s" % (entry.get("datasetId"), pubs[-1].get("path"))))
            elif entry_hash(found) != entry.get("entryHash"):
                issues.append(Issue("warning", "W_PUBLISHED_CHANGED", where, ptr,
                                    "%s was changed in data/ after its publication from this task" % entry.get("datasetId")))
    return issues


def check_save(root, changes: List[dict], user: Optional[str], writer: Optional[str] = None) -> List[Issue]:
    """Problems of the tasks a save changes (``changes``: [{path, content}], content None = deleted)."""
    touched: Dict[str, Dict[str, Optional[str]]] = {}
    for change in changes:
        m = WORK_FILE_RE.match(str(change.get("path")))
        if m:
            touched.setdefault(m.group(1), {})[m.group(2) + ".json"] = change.get("content")
    issues: List[Issue] = []
    elements = known_elements(root) if touched else set()
    for task_id, changed in sorted(touched.items()):
        before = read_texts(root, task_id)
        after = dict(before)
        after.update(changed)
        issues.extend(check_task(task_id, after, before, elements, user, writer))
    return issues


# ---------------------------------------------------------------------------
# the tool's server: PDF, AI run, publication
# ---------------------------------------------------------------------------

def _task_id(body: dict) -> str:
    task_id = str(body.get("task", ""))
    if not TASK_ID_RE.match(task_id):
        raise WorkError("bad-request", "a task name consists of letters, digits, '.', '_' and '-'", 400)
    return task_id


def _user(repo) -> Optional[str]:
    return repo._out("config", "user.name")


def _saved_task(root, task_id: str) -> Tuple[Dict[str, Optional[str]], Dict[str, dict]]:
    """The saved files of a task, refused when they are not valid."""
    texts = read_texts(root, task_id)
    if texts["task.json"] is None:
        raise WorkError("task-not-saved", "the task %s is not saved" % task_id)
    errors = [i for i in check_task(task_id, texts, texts, known_elements(root)) if i.level == "error"]
    if errors:
        raise WorkError("invalid", "the files of the task are not valid", 422,
                        issues=[{"level": i.level, "code": i.code, "file": i.file, "pointer": i.pointer,
                                 "message": i.message} for i in errors])
    return texts, {name: jsonfmt.loads(text) for name, text in texts.items() if text is not None}


def pdf_info(repo, task_id: str) -> dict:
    """Whether the PDF of a task is on this computer, with its SHA-256 and size."""
    path = repo.root / WORK_DIR / task_id / PDF_NAME
    if not TASK_ID_RE.match(task_id) or not path.is_file():
        return {"present": False}
    data = path.read_bytes()
    return {"present": True, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


def store_pdf(repo, body: dict) -> dict:
    """Keep the PDF of a task on this computer (extraction/<task>/source.pdf, never saved) and
    return its SHA-256 and size."""
    task_id = _task_id(body)
    try:
        data = base64.b64decode(str(body.get("data", "")), validate=True)
    except (binascii.Error, ValueError):
        raise WorkError("bad-request", "the file is not base64", 400)
    if not data.startswith(b"%PDF-"):
        raise WorkError("not-pdf", "the file is not a PDF", 400)
    if len(data) > MAX_PDF_BYTES:
        raise WorkError("too-large", "the PDF is larger than %d MB" % (MAX_PDF_BYTES // 2 ** 20), 400)
    folder = repo.root / WORK_DIR / task_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / PDF_NAME).write_bytes(data)
    return {"present": True, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


def run_ai(repo, body: dict, ai) -> dict:
    """Let the AI read the PDF of a task and save the result as input A or B.

    mode 'ai': the AI's rows, submitted at once.  mode 'assisted': the AI draft is kept in
    aiDraft and copied to the rows, which the extractor then corrects and submits.  The AI
    receives the PDF and the list of source items of the task - never the other input.
    """
    task_id = _task_id(body)
    slot, mode = body.get("slot"), body.get("mode", "ai")
    if slot not in SLOTS or mode not in ("ai", "assisted"):
        raise WorkError("bad-request", "slot is A or B, mode is ai or assisted", 400)
    texts, objs = _saved_task(repo.root, task_id)
    task = objs["task.json"]
    if texts[input_name(slot)] is not None:
        raise WorkError("slot-taken", "input %s exists already" % slot)
    extractor = str(body.get("extractor") or _user(repo) or "").strip()
    if mode == "assisted" and not extractor:
        raise WorkError("bad-request", "an assisted input names the person who corrects it", 400)
    path = repo.root / WORK_DIR / task_id / PDF_NAME
    if not path.is_file():
        raise WorkError("pdf-missing", "the PDF of the task is not on this computer")
    pdf = path.read_bytes()
    if hashlib.sha256(pdf).hexdigest() != task["source"]["sha256"]:
        raise WorkError("pdf-mismatch", "the PDF on this computer is not the one of the task (SHA-256 differs)")
    availability = ai.availability()
    if not availability["available"]:
        raise WorkError("ai-unavailable", "AI extraction is not available: %s" % availability["reason"], 503)
    try:
        result = ai.extract(pdf, task, known_elements(repo.root), ai.make_client())
    except ai.ExtractionError as err:
        raise WorkError("ai-failed", "the AI run failed (%s): %s" % (err.code, err), 502, reason=err.code)
    except Exception as err:                 # e.g. a client that cannot be set up
        raise WorkError("ai-failed", "the AI run failed: %s" % err, 502, reason="failed")
    obj = {"format": FORMATS[input_name(slot)], "task": task_id, "slot": slot, "mode": mode,
           "sourceSha256": task["source"]["sha256"]}
    if mode == "ai":
        obj.update(run=result["run"], coverage=result["coverage"], rows=result["rows"],
                   submitted={"at": result["run"]["at"]})
    else:
        obj.update(extractor=extractor,
                   aiDraft={"run": result["run"], "coverage": result["coverage"], "rows": result["rows"]},
                   coverage=jsonfmt.loads(jsonfmt.compact(result["coverage"])),
                   rows=jsonfmt.loads(jsonfmt.compact(result["rows"])))
    change = {"path": task_path(task_id, input_name(slot)), "content": canonical_text(obj), "baseSha": None}
    saved = repo.save("Add extraction %s input %s (%s)" % (task_id, slot, "AI" if mode == "ai" else "AI draft"),
                      [change], writer="ai")
    return dict(saved, path=change["path"], rows=len(result["rows"]))


def _entry(row: dict, kind: str) -> dict:
    block = {"value": row["value"], "unit": row["unit"], "uncertainties": [dict(u) for u in row["uncertainties"]]}
    entry = {"nuclide": {"element": row["nuclide"]["element"], "mass": row["nuclide"]["mass"], "isomer": 0},
             "observable": {"kind": kind, kind: block}}
    if row.get("conditions"):
        entry["key"] = row["conditions"]
    if row.get("comment"):
        entry["comment"] = row["comment"]
    return entry


def publication_plan(root, task_id: str, user: Optional[str]) -> dict:
    """The changes that publish the approved rows of a task: its data file and the publication
    record in task.json.  Refused (WorkError) unless the saved adjudication is approved and
    has not changed since."""
    texts, objs = _saved_task(root, task_id)
    task, a, b, adj = (objs.get(n) for n in FILES)
    if not (is_submitted(a) and is_submitted(b)):
        raise WorkError("not-submitted", "both inputs must be submitted, compared and approved first")
    if adj is None or not isinstance(adj.get("approval"), dict):
        raise WorkError("not-approved", "the adjudication is not approved")
    integrity, open_items = adjudication_problems(task, a, b, adj)
    if integrity or open_items:
        raise WorkError("not-approved", "the adjudication has points that are not decided")
    approved = content_hash(task, a, b, adj)
    if adj["approval"]["contentHash"] != approved:
        raise WorkError("approval-stale", "the result changed after it was approved: it must be checked and "
                        "approved again")
    if not adj["rows"]:
        raise WorkError("nothing", "no rows were adopted")
    if not user:
        raise WorkError("identity", "the tool does not know who is publishing; run `pixi run login` once", 400)

    target = task["target"]
    code = CODE_OF[target["datasetType"]]
    bib_id = task["source"]["bibId"]
    mid = ids.meta_id("LT", code, bib_id, target.get("key"))
    db = Database.load(root)
    existing = next((f for f in db.files if isinstance(f.obj, dict) and f.code == code
                     and f.meta.get("id") == mid), None)
    if existing is not None:
        doc, path = existing.obj, existing.path
    else:
        meta = {"id": mid, "bibId": bib_id}
        if target.get("key"):
            meta["key"] = target["key"]
        if target.get("facility"):
            meta["facility"] = target["facility"]
        doc = {"format": "muND/LT/1", "sublibrary": "LT", "datasetType": target["datasetType"], "meta": meta, "data": []}
        path = file_path(doc, db.reference(bib_id))
        if (Path(root) / path).exists():
            raise WorkError("exists", "%s exists but has another MetaID" % path)

    entries = []
    for row in adj["rows"]:
        entry = _entry(row, row["kind"])
        entry["datasetId"] = expected_data_id(doc, entry, mid)
        entries.append(entry)
    new_ids = [e["datasetId"] for e in entries]
    twice = sorted({i for i in new_ids if new_ids.count(i) > 1})
    if twice:
        raise WorkError("duplicate", "several rows give the same data entry (%s): give them different "
                        "conditions" % ", ".join(twice))
    published: Dict[str, str] = {}               # datasetId -> entryHash as last published from this task
    for pub in _list(task.get("publications")):
        if pub.get("path") == path:
            for e in pub["entries"]:
                published[e["datasetId"]] = e["entryHash"]
    position = {e.get("datasetId"): k for k, e in enumerate(_list(doc.get("data"))) if isinstance(e, dict)}
    for entry in entries:
        did = entry["datasetId"]
        if did not in position:
            doc["data"].append(entry)
            continue
        current = doc["data"][position[did]]
        if did not in published:
            raise WorkError("exists", "%s already holds the entry %s (same nuclide and conditions), which was not "
                            "published from this task" % (path, did))
        if entry_hash(current) != published[did]:
            raise WorkError("changed-since-publication", "the entry %s was changed in %s after it was published "
                            "from this task" % (did, path))
        if current.get("legacyIds"):
            entry["legacyIds"] = current["legacyIds"]
        doc["data"][position[did]] = entry
    left = sorted(did for did in published if did in position and did not in new_ids)
    if left:
        raise WorkError("left-over", "entries published from this task before are not in the approved result "
                        "(%s): delete them in the dataset editor first" % ", ".join(left))
    assign_ids(doc)
    data_text = data_canonical_text(doc)
    record = {"at": now(), "by": user, "contentHash": approved, "path": path,
              "entries": [{"datasetId": e["datasetId"], "entryHash": entry_hash(e)} for e in entries]}
    task["publications"] = _list(task.get("publications")) + [record]
    target_file = Path(root) / path
    blob = (lambda data: hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest())
    changes = [
        {"path": path, "content": data_text,
         "baseSha": blob(target_file.read_bytes()) if target_file.is_file() else None},
        {"path": task_path(task_id, "task.json"), "content": canonical_text(task),
         "baseSha": blob(texts["task.json"].encode("utf-8"))},
    ]
    label = path.split("/")[-1].rsplit("_", 1)[0]
    return {"changes": changes, "path": path, "datasetIds": new_ids, "contentHash": approved,
            "message": "Publish extraction %s to LT/%s %s" % (task_id, code, label)}


def publish(repo, body: dict) -> dict:
    """Publish the approved rows of a task through the save of the tool (checks, record, send)."""
    task_id = _task_id(body)
    with repo.lock:
        repo._sync()                                 # decide on the newest saved state
        plan = publication_plan(repo.root, task_id, _user(repo))
    saved = repo.save(plan["message"], plan["changes"], writer="publish")
    return dict(saved, path=plan["path"], datasetIds=plan["datasetIds"], contentHash=plan["contentHash"])


def api(repo, method: str, name: str, query: dict, body: dict, ai):
    """The routes /api/extraction/<name> of the tool's server."""
    if (method, name) == ("GET", "ai"):
        return ai.availability()
    if (method, name) == ("GET", "pdf"):
        return pdf_info(repo, str(query.get("task", [""])[0]))
    if (method, name) == ("POST", "pdf"):
        return store_pdf(repo, body)
    if (method, name) == ("POST", "ai-run"):
        return run_ai(repo, body, ai)
    if (method, name) == ("POST", "publish"):
        return publish(repo, body)
    raise WorkError("not-found", "no such API: %s extraction/%s" % (method, name), 404)
