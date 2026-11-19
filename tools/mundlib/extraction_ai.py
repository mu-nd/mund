"""AI extraction of values from the PDF of a source, run by the tool's server on this
computer (docs/extraction.ja.md).

The model reads the PDF and the list of source items of the task - nothing else; in
particular it never sees the other input.  The API key comes from the environment of the
server process (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN), never from the page.  The SDK
(the ``anthropic`` package) is optional: ``pixi run -e ai admin`` provides it; without it,
or without a key, the page shows AI extraction as unavailable.

The model is asked for strings, which are turned into the rows of an input here.  Anything
it cannot read with certainty it leaves empty and describes; such rows are marked 要確認
(needsCheck), as are values that are not plain numbers or units that do not fit.
"""
from __future__ import annotations

import base64
import importlib.util
import os
import re
from typing import List, Optional

from . import jsonfmt

MODEL = "claude-opus-5-5"
PROMPT_VERSION = "mund-lt-extraction/1"
KEY_VARIABLES = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")
# a request carries at most 32 MB; base64 makes the PDF a third larger
MAX_PDF_BYTES = 24 * 1024 * 1024
MAX_TOKENS = 64000

UNITS = {"lifetime": ("ns", "us"), "capture_rate": ("us-1", "ms-1", "s-1"), "capture_probability": ("%",)}
NUMBER_RE = re.compile(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$")
KEY_RE = re.compile(r"^[^\s|]([^|]*[^\s|])?$")

_text = {"type": "string"}
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "rows": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "page": _text, "item": _text, "label": _text,
                    "element": _text,
                    "mass": {"type": "integer"},
                    "kind": {"type": "string", "enum": ["lifetime", "capture_rate", "capture_probability"]},
                    "conditions": _text,
                    "originalValue": _text, "originalUnit": _text, "originalUncertainty": _text,
                    "value": _text,
                    "unit": {"type": "string", "enum": ["ns", "us", "us-1", "ms-1", "s-1", "%", ""]},
                    "uncertainties": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "source": {"type": "string", "enum": ["total", "statistical", "systematic", "other"]},
                                "value": _text,
                            },
                            "required": ["source", "value"],
                            "additionalProperties": False,
                        },
                    },
                    "needsCheck": _text,
                    "notes": _text,
                },
                "required": ["page", "item", "label", "element", "mass", "kind", "conditions", "originalValue",
                             "originalUnit", "originalUncertainty", "value", "unit", "uncertainties", "needsCheck",
                             "notes"],
                "additionalProperties": False,
            },
        },
        "coverage": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "item": _text,
                    "status": {"type": "string", "enum": ["covered", "no-data", "needs-check"]},
                },
                "required": ["item", "status"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["rows", "coverage"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """\
You transcribe numerical values from a scientific publication (the attached PDF) for muND, a \
database of muonic-atom lifetimes and nuclear muon capture rates. Your transcription is one of \
two independent extractions of the same source; a person compares them afterwards, so an honest \
"cannot read this" is worth more than a plausible guess.

Report every value of these quantities that the document itself prints:
- lifetime: total lifetime of the muonic atom (negative muon), unit ns or us (microsecond);
- capture_rate: total nuclear muon capture rate, unit us-1, ms-1 or s-1;
- capture_probability: fraction of muons captured by the nucleus, unit %.
Do not report values the document only quotes from other work unless it presents them as its \
own results; mention such cases in notes instead.

For each value give one row:
- page, item, label: where it is printed - the page, the table / figure / passage as the document \
names it ("Table 2", "Fig. 3", "text"), and the row or label within it.
- element, mass: the element symbol and the mass number. mass 0 means a target of natural isotopic \
composition; use it only when the document says the target is natural (or gives an element without \
isotope for a natural target).
- conditions: a short label that distinguishes several values of the same nuclide and quantity \
(target form, phase ...), empty when there is only one.
- originalValue, originalUnit, originalUncertainty: the notation exactly as printed, characters only \
(e.g. "0.880", "μs", "± 0.005", "743.9(50)", "4.6 × 10^5", "s^-1"). No sentences.
- value: the same number with exactly the digits printed - never compute, convert, round or \
complete a value. A printed power of ten may be written in exponent notation ("4.6 × 10^5" -> \
"4.6e5"; 460 in a column headed 10^3 s^-1 -> "460e3" with unit s-1).
- unit: the printed unit in ASCII: ns, us, us-1, ms-1, s-1 or %.
- uncertainties: symmetric one-standard-deviation uncertainties in the unit of the value, with the \
digits printed: source total for a single uncertainty, statistical and systematic when they are \
given separately. Digits in parentheses denote the uncertainty of the last digits \
("743.9(50)" -> "5.0"). Leave the list empty when none is given.
- needsCheck: empty when everything of the row was read with certainty. Otherwise describe what is \
uncertain (blurred scan, ambiguous unit, asymmetric or relative uncertainty, unit not in the list, \
unclear element or mass number ...) and leave the affected field empty (mass -1). Never guess.
- notes: optional, a few words of your own. Do not copy sentences of the document.

coverage: for every source item listed by the user, say whether it holds values of these \
quantities (covered), holds none (no-data), or could not be decided (needs-check). Add items the \
list misses that hold such values.\
"""


class ExtractionError(Exception):
    """The AI run failed; ``code``: refused | truncated | output | auth | rate-limit | offline | api | failed."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def availability(environ=None) -> dict:
    """Whether AI extraction can run here: a key in the environment and the SDK installed."""
    env = os.environ if environ is None else environ
    info = {"available": False, "model": MODEL, "promptVersion": PROMPT_VERSION, "reason": None}
    if not any(env.get(name) for name in KEY_VARIABLES):
        info["reason"] = "no-key"
    elif importlib.util.find_spec("anthropic") is None:
        info["reason"] = "no-package"
    else:
        info["available"] = True
    return info


def make_client():
    """The Claude API client; imported here because the package is optional."""
    import anthropic
    return anthropic.Anthropic()


def build_request(pdf: bytes, task: dict) -> dict:
    """The request for one source: the PDF and the list of its items, nothing else."""
    if len(pdf) > MAX_PDF_BYTES:
        raise ExtractionError("failed", "the PDF is larger than %d MB, the limit of one request"
                              % (MAX_PDF_BYTES // 2 ** 20))
    items = task.get("source", {}).get("items", [])
    listed = "\n".join("- %s%s" % (i["label"], " (page %s)" % i["page"] if i.get("page") else "") for i in items)
    text = ("Source items to mark in coverage:\n%s\n\nTranscribe the values as instructed." % listed if listed
            else "No source items are listed: add every table, figure or passage that holds values to coverage. "
                 "Transcribe the values as instructed.")
    return {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "betas": ["server-side-fallback-2026-07-01"],
        "fallbacks": "default",
        "output_config": {"effort": "high", "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        "messages": [{"role": "user", "content": [
            {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                            "data": base64.standard_b64encode(pdf).decode("ascii")}},
            {"type": "text", "text": text},
        ]}],
    }


def _classify(err: Exception) -> str:
    try:
        import anthropic
    except ImportError:
        return "failed"
    if isinstance(err, anthropic.AuthenticationError):
        return "auth"
    if isinstance(err, anthropic.RateLimitError):
        return "rate-limit"
    if isinstance(err, anthropic.APIConnectionError):
        return "offline"
    if isinstance(err, anthropic.APIStatusError):
        return "api"
    return "failed"


def _number(text: str):
    """A number that keeps its written digits, or None."""
    t = str(text).strip()
    return jsonfmt.loads(t) if NUMBER_RE.match(t) else None


def to_rows(output: dict, elements: set, labels: List[str]) -> tuple:
    """(rows, coverage) of an input from the model's answer."""
    rows = []
    for n, r in enumerate(output.get("rows") or [], 1):
        problems = [r["needsCheck"].strip()] if r.get("needsCheck", "").strip() else []
        row = {"id": "r%d" % n, "location": {}, "kind": r["kind"], "original": {}, "uncertainties": []}
        for key in ("page", "item", "label"):
            if r.get(key, "").strip():
                row["location"][key] = r[key].strip()
        if "item" not in row["location"]:
            row["location"]["item"] = "unknown"
            problems.append("table or figure not given")
        element, mass = r.get("element", "").strip(), r.get("mass")
        if element in elements and isinstance(mass, int) and 0 <= mass <= 300:
            row["nuclide"] = {"element": element, "mass": mass}
        else:
            problems.append("nuclide not readable (element %r, mass %r)" % (element, mass))
        conditions = r.get("conditions", "").strip()
        if conditions and KEY_RE.match(conditions):
            row["conditions"] = conditions
        elif conditions:
            problems.append("conditions %r cannot be a key" % conditions)
        for key, name in (("originalValue", "value"), ("originalUnit", "unit"), ("originalUncertainty", "uncertainty")):
            if r.get(key, "").strip():
                row["original"][name] = r[key].strip()
        value = _number(r.get("value", ""))
        if value is not None:
            row["value"] = value
        else:
            problems.append("value not readable")
        if r.get("unit") in UNITS[r["kind"]]:
            row["unit"] = r["unit"]
        else:
            problems.append("unit not readable or not one of %s" % ", ".join(UNITS[r["kind"]]))
        for u in r.get("uncertainties") or []:
            number = _number(u.get("value", ""))
            if number is not None and number >= 0:
                row["uncertainties"].append({"source": u["source"], "value": number})
            else:
                problems.append("uncertainty (%s) not readable" % u.get("source"))
        if r.get("notes", "").strip():
            row["notes"] = r["notes"].strip()
        if problems:
            row["needsCheck"] = "; ".join(dict.fromkeys(problems))
        rows.append(row)
    coverage, seen = [], set()
    for c in output.get("coverage") or []:
        item = str(c.get("item", "")).strip()
        if item and item not in seen and c.get("status") in ("covered", "no-data", "needs-check"):
            coverage.append({"item": item, "status": c["status"]})
            seen.add(item)
    for label in labels:                      # an item the model did not mark is open, not "no data"
        if label not in seen:
            coverage.append({"item": label, "status": "needs-check"})
    return rows, coverage


def extract(pdf: bytes, task: dict, elements: set, client, at: Optional[str] = None) -> dict:
    """Run the model on the PDF: {"run": ..., "rows": [...], "coverage": [...]}."""
    from .extraction import now
    request = build_request(pdf, task)
    try:
        with client.beta.messages.stream(**request) as stream:
            message = stream.get_final_message()
    except Exception as err:          # the SDK's errors, sorted by _classify
        raise ExtractionError(_classify(err), str(err)) from err
    if message.stop_reason == "refusal":
        raise ExtractionError("refused", "the model declined the request")
    if message.stop_reason == "max_tokens":
        raise ExtractionError("truncated", "the answer was cut off at %d tokens" % MAX_TOKENS)
    text = next((b.text for b in message.content if getattr(b, "type", None) == "text"), None)
    try:
        output = jsonfmt.loads(text) if text is not None else None
    except ValueError:
        output = None
    if not isinstance(output, dict):
        raise ExtractionError("output", "the answer is not the requested JSON")
    labels = [i["label"] for i in task.get("source", {}).get("items", [])]
    rows, coverage = to_rows(output, elements, labels)
    run = {"model": str(message.model), "promptVersion": PROMPT_VERSION, "at": at or now()}
    if run["model"] != MODEL:
        run["requestedModel"] = MODEL
    request_id = getattr(message, "_request_id", None)
    if request_id:
        run["requestId"] = str(request_id)
    return {"run": run, "rows": rows, "coverage": coverage}
