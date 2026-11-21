"""The extraction work area (tools/mundlib/extraction.py, extraction_ai.py): the checks of
every save, the approval, the publication gate of the tool's server and the AI run (with a
stand-in for the API client).  The example task is tests/vectors/extraction.json, which the
browser tests (tests/admin/extraction-suite.js) use too."""
import base64
import http.client
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from helpers import ROOT, make_repository, vectors
from mundlib import admin, extraction as ex, extraction_ai as ai, jsonfmt

VECTOR = vectors("extraction.json")
TASK = VECTOR["task"]
PDF = base64.b64decode(VECTOR["pdf"])
ELEMENTS = {"Al", "Si", "Ca", "Fe", "Ti", "Pb"}


def path(name: str) -> str:
    return ex.task_path(TASK, name)


def objs(files=None) -> dict:
    return {name: jsonfmt.loads(text) for name, text in (files or VECTOR["files"]).items()}


def text(obj) -> str:
    return ex.canonical_text(obj)


def errors(issues) -> list:
    return sorted((i.code, i.file.split("/")[-1], i.pointer) for i in issues if i.level == "error")


class WorkAreaTests(unittest.TestCase):
    """The checks of the files, without git."""

    def check(self, after, before=None, user="Carol", writer=None):
        before = dict(VECTOR["files"]) if before is None else before
        files = dict(before)
        files.update(after)
        return errors(ex.check_task(TASK, files, before, ELEMENTS, user, writer))

    def test_the_example_is_valid_and_approved(self):
        o = objs()
        self.assertEqual(self.check({}), [])
        self.assertEqual(ex.content_hash(o["task.json"], o["input-A.json"], o["input-B.json"], o["adjudication.json"]),
                         VECTOR["contentHash"])
        self.assertEqual(ex.approval_state(o["task.json"], o["input-A.json"], o["input-B.json"], o["adjudication.json"]),
                         "approved")
        for name, t in VECTOR["files"].items():
            self.assertEqual(text(jsonfmt.loads(t)), t, name)
        self.assertTrue(ex.is_work_file(path("input-A.json")))
        for other in ("extraction/%s/source.pdf" % TASK, "extraction/%s/notes.json" % TASK, "extraction/a/b/task.json",
                      "data/LT/EXP/x.json"):
            self.assertFalse(ex.is_work_file(other), other)

    def test_files_are_checked(self):
        a = objs()["input-A.json"]
        del a["submitted"]
        a["rows"].append(dict(a["rows"][0]))
        a["rows"].append({"id": "r9", "location": {"item": "Table 1"}, "nuclide": {"element": "Xx", "mass": 1},
                          "kind": "lifetime", "original": {}, "value": 1, "unit": "us-1", "uncertainties": []})
        before = dict(VECTOR["files"], **{"input-A.json": None, "adjudication.json": None})
        self.assertEqual(self.check({"input-A.json": text(a)}, before), [
            ("E_SCHEMA", "input-A.json", "/rows/5/unit"),
        ], "a unit that does not fit the quantity")
        a["rows"][5]["unit"] = "us"
        self.assertEqual(self.check({"input-A.json": text(a)}, before), [
            ("E_ELEMENT", "input-A.json", "/rows/5/nuclide/element"),
            ("E_ROW_ID", "input-A.json", "/rows/4/id"),
        ])
        self.assertEqual(self.check({"input-A.json": text(a).replace("\n  ", "\n ", 1)}, before)[0][0], "E_CANONICAL")
        # a row the extractor could not read: no nuclide, no value, marked 要確認
        a["rows"][4:] = [{"id": "r5", "location": {"item": "Table 1"}, "kind": "lifetime", "original": {},
                          "uncertainties": [], "needsCheck": "blurred"}]
        self.assertEqual(self.check({"input-A.json": text(a)}, before), [])
        del a["rows"][4]["needsCheck"]
        self.assertEqual([e[0] for e in self.check({"input-A.json": text(a)}, before)], ["E_SCHEMA"] * 3)

    def test_a_submitted_input_marks_every_source_item(self):
        a = objs()["input-A.json"]
        a["coverage"] = a["coverage"][:1]
        before = dict(VECTOR["files"], **{"input-A.json": None, "adjudication.json": None})
        self.assertEqual(self.check({"input-A.json": text(a)}, before),
                         [("E_COVERAGE_INCOMPLETE", "input-A.json", "/coverage")])
        del a["submitted"]
        self.assertEqual(self.check({"input-A.json": text(a)}, before), [], "while it is typed it may be incomplete")

    def test_the_comparison_waits_for_both_inputs(self):
        b = objs()["input-B.json"]
        del b["submitted"]
        before = dict(VECTOR["files"], **{"input-B.json": None, "adjudication.json": None})
        self.assertIn(("E_ADJUDICATION_EARLY", "adjudication.json", ""),
                      self.check({"input-B.json": text(b), "adjudication.json": VECTOR["files"]["adjudication.json"]}, before))

    def test_inputs_and_records_only_their_writers_change(self):
        a = objs()["input-A.json"]
        a["comment"] = "corrected afterwards"
        self.assertEqual(self.check({"input-A.json": text(a)}), [("E_INPUT_SUBMITTED", "input-A.json", "")],
                         "a submitted input is frozen")
        self.assertIn(("E_INPUT_SUBMITTED", "input-A.json", ""), self.check({"input-A.json": None}), "and cannot be deleted")
        before = dict(VECTOR["files"], **{"input-B.json": None, "adjudication.json": None})
        b = VECTOR["files"]["input-B.json"]
        self.assertEqual(self.check({"input-B.json": b}, before), [("E_AI_RECORD", "input-B.json", "/mode")],
                         "an AI input is not typed in")
        self.assertEqual(self.check({"input-B.json": b}, before, writer="ai"), [])
        assisted = objs()["input-B.json"]
        assisted.update(mode="assisted", extractor="Bob", aiDraft={"run": assisted.pop("run"), "coverage": [], "rows": []})
        del assisted["submitted"]
        self.assertEqual(self.check({"input-B.json": text(assisted)}, before),
                         [("E_AI_RECORD", "input-B.json", "/aiDraft")], "nor is an AI draft")
        task = objs()["task.json"]
        task["publications"] = [{"at": "2026-11-17T05:00:00Z", "by": "Carol", "contentHash": VECTOR["contentHash"],
                                 "path": "data/LT/EXP/x.json", "entries": []}]
        self.assertEqual(self.check({"task.json": text(task)}), [("E_PUBLICATION_RECORD", "task.json", "/publications")])
        self.assertEqual(self.check({"task.json": text(task)}, writer="publish"), [])
        task["source"]["version"] = "arXiv v1"
        self.assertEqual(self.check({"task.json": text(task)}, writer="publish"),
                         [("E_PUBLICATION_NOT_APPROVED", "task.json", "/publications")], "the source changed: not approved")

    def test_approval(self):
        o = objs()
        adj = o["adjudication.json"]
        unapproved = dict(VECTOR["files"], **{"adjudication.json": text({k: v for k, v in adj.items() if k != "approval"})})
        approved = VECTOR["files"]["adjudication.json"]
        self.assertEqual(self.check({"adjudication.json": approved}, unapproved, user="Carol"), [])
        self.assertEqual(self.check({"adjudication.json": approved}, unapproved, user="Mallory"),
                         [("E_APPROVAL_BY", "adjudication.json", "/approval/by")],
                         "an approval carries the name of the person saving it")
        wrong = jsonfmt.loads(approved)
        wrong["approval"]["contentHash"] = "0" * 64
        self.assertEqual(self.check({"adjudication.json": text(wrong)}, unapproved),
                         [("E_APPROVAL_HASH", "adjudication.json", "/approval/contentHash")])
        open_ = jsonfmt.loads(approved)
        del open_["coverage"]
        open_["approval"]["contentHash"] = ex.content_hash(o["task.json"], o["input-A.json"], o["input-B.json"], open_)
        self.assertEqual(self.check({"adjudication.json": text(open_)}, unapproved),
                         [("E_APPROVAL_INCOMPLETE", "adjudication.json", "/approval")],
                         "a source item marked differently is not decided")
        # a change after the approval is saved, and the approval no longer holds
        later = jsonfmt.loads(approved)
        later["rows"][1]["reason"] = "the table gives microseconds (checked twice)"
        self.assertEqual(self.check({"adjudication.json": text(later)}), [])
        self.assertEqual(ex.approval_state(o["task.json"], o["input-A.json"], o["input-B.json"], later), "stale")

    def test_adopted_rows_are_the_rows_of_the_inputs(self):
        adj = objs()["adjudication.json"]
        adj["rows"][0]["value"] = jsonfmt.loads("864.00")
        adj["rows"][1]["value"] = jsonfmt.loads("0.75660")
        adj["rows"][2]["a"] = "r4"
        del adj["approval"]
        self.assertEqual(self.check({"adjudication.json": text(adj)}), [
            ("E_ADJ_ADOPTED", "adjudication.json", "/rows/1"),
            ("E_ADJ_AGREED", "adjudication.json", "/rows/0"),
            ("E_ADJ_TWICE", "adjudication.json", ""),
        ])


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), "-c", "commit.gpgsign=false"] + list(args), check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()


class FakeClient:
    """Stands in for anthropic.Anthropic(): client.beta.messages.stream(**request) as a context manager."""

    def __init__(self, answer, stop_reason="end_turn", model=ai.MODEL):
        self.requests = []
        message = SimpleNamespace(stop_reason=stop_reason, model=model, _request_id="req_test",
                                  content=[SimpleNamespace(type="text", text=json.dumps(answer))])
        test = self

        class Stream:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def get_final_message(self):
                return message

        def stream(**request):
            test.requests.append(request)
            return Stream()
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=stream))


def answer_row(**fields):
    row = {"page": "3", "item": "Table 1", "label": "", "element": "Al", "mass": 27, "kind": "lifetime",
           "conditions": "", "originalValue": "864.0", "originalUnit": "ns", "originalUncertainty": "± 1.0",
           "value": "864.0", "unit": "ns", "uncertainties": [{"source": "total", "value": "1.0"}],
           "needsCheck": "", "notes": ""}
    row.update(fields)
    return row


@unittest.skipIf(shutil.which("git") is None, "git is not available")
class ServerTests(unittest.TestCase):
    """The tool's server on a copy with a stand-in for GitHub: saves, the AI run and the publication."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        seed = make_repository(base / "seed")
        for name, t in VECTOR["files"].items():
            target = seed / path(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(t, encoding="utf-8")
        git(seed, "init", "-q", "-b", "main")
        git(seed, "-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "add", "-A")
        git(seed, "-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "commit", "-q", "-m", "initial")
        self.github = base / "github.git"
        subprocess.run(["git", "clone", "-q", "--bare", str(seed), str(self.github)], check=True)
        self.work = base / "work"
        subprocess.run(["git", "clone", "-q", str(self.github), str(self.work)], check=True)
        for key, value in (("user.name", "Carol"), ("user.email", "carol@example.invalid"), ("commit.gpgsign", "false")):
            git(self.work, "config", key, value)
        (self.work / path(ex.PDF_NAME)).write_bytes(PDF)
        self.repo = admin.LocalRepository(self.work)

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, name):
        return (self.work / path(name)).read_text(encoding="utf-8")

    def change(self, name, obj):
        old = (self.work / path(name))
        return {"path": path(name), "content": text(obj),
                "baseSha": admin.blob_sha(old.read_bytes()) if old.is_file() else None}

    def refused(self, fn, *args, **kwargs):
        with self.assertRaises(ex.WorkError) as caught:
            fn(*args, **kwargs)
        return caught.exception

    def test_the_tool_lists_and_saves_the_work_area_but_never_the_pdf(self):
        paths = [f["path"] for f in self.repo.files()]
        self.assertIn(path("task.json"), paths)
        self.assertNotIn(path(ex.PDF_NAME), paths)
        self.assertEqual(self.repo.read(path("task.json")), VECTOR["files"]["task.json"])
        with self.assertRaises(admin.AdminError):
            self.repo.save("PDF", [{"path": path(ex.PDF_NAME), "content": "x", "baseSha": None}])
        with self.assertRaises(admin.AdminError) as caught:
            a = objs()["input-A.json"]
            a["comment"] = "x"
            self.repo.save("Change A", [self.change("input-A.json", a)])
        self.assertEqual((caught.exception.code, caught.exception.extra["issues"][0]["code"]), ("invalid", "E_INPUT_SUBMITTED"))
        self.assertEqual(self.read("input-A.json"), VECTOR["files"]["input-A.json"])
        self.assertEqual(ex.pdf_info(self.repo, TASK), {"present": True, "sha256": ex.jsonfmt.loads(
            VECTOR["files"]["task.json"])["source"]["sha256"], "size": len(PDF)})

    def test_publication_writes_the_approved_rows_through_the_save(self):
        result = ex.publish(self.repo, {"task": TASK})
        self.assertTrue(result["sent"])
        data_path = result["path"]
        self.assertRegex(data_path, r"^data/LT/EXP/ExtractionExample_[0-9a-f]{12}\.json$")
        written = jsonfmt.loads((self.work / data_path).read_text(encoding="utf-8"))
        self.assertEqual(written["meta"]["facility"], "J-PARC (D1)")
        self.assertEqual([e["datasetId"] for e in written["data"]], result["datasetIds"])
        si = written["data"][1]["observable"]["lifetime"]
        self.assertEqual((jsonfmt.lexeme(si["value"]), si["unit"], jsonfmt.lexeme(si["uncertainties"][0]["value"])),
                         ("0.7566", "us", "0.0010"), "the adopted value as written")
        self.assertEqual(written["data"][2]["comment"], "value as in Table 1")
        task = jsonfmt.loads(self.read("task.json"))
        record = task["publications"][0]
        self.assertEqual((record["by"], record["contentHash"], record["path"]), ("Carol", VECTOR["contentHash"], data_path))
        self.assertEqual([e["datasetId"] for e in record["entries"]], result["datasetIds"])
        log = git(self.github, "log", "-1", "--format=%an|%s", "main")
        self.assertEqual(log, "Carol|Publish extraction Example2026 to LT/EXP ExtractionExample")
        self.assertEqual(git(self.github, "show", "main:" + data_path), (self.work / data_path).read_text(encoding="utf-8").rstrip("\n"))
        self.assertEqual([i for i in admin.Database.load(self.work).validate() if i.level == "error"], [])

        # publishing again the same approved content writes the same entries in place
        again = ex.publish(self.repo, {"task": TASK})
        self.assertEqual(again["datasetIds"], result["datasetIds"])
        self.assertEqual(len(jsonfmt.loads((self.work / data_path).read_text(encoding="utf-8"))["data"]), 4)
        # an entry changed in the dataset editor after the publication is not overwritten
        changed = (self.work / data_path).read_text(encoding="utf-8").replace('"value": 864.0', '"value": 864.5')
        self.repo.save("Correct Al", [{"path": data_path, "content": changed,
                                       "baseSha": admin.blob_sha((self.work / data_path).read_bytes())}])
        self.assertEqual(self.refused(ex.publish, self.repo, {"task": TASK}).code, "changed-since-publication")

    def test_the_stored_work_area_is_checked_as_well(self):
        """mund.py validate (and CI) check the work area as stored, not only the tool's saves."""
        self.assertEqual(ex.validate_work_area(self.work), [])
        result = ex.publish(self.repo, {"task": TASK})
        self.assertEqual(ex.validate_work_area(self.work), [], "published as approved")
        # an entry corrected in data/ afterwards is pointed out
        data_path = result["path"]
        changed = (self.work / data_path).read_text(encoding="utf-8").replace('"value": 864.0', '"value": 864.5')
        self.repo.save("Correct Al", [{"path": data_path, "content": changed,
                                       "baseSha": admin.blob_sha((self.work / data_path).read_bytes())}])
        self.assertEqual([i.code for i in ex.validate_work_area(self.work)], ["W_PUBLISHED_CHANGED"])
        # a task changed after its publication (by hand, past the tool) is pointed out; a stray file is an error
        adj = jsonfmt.loads(self.read("adjudication.json"))
        adj["rows"][2]["reason"] = "edited by hand"
        (self.work / path("adjudication.json")).write_text(text(adj), encoding="utf-8")
        (self.work / path("notes.txt")).write_text("x", encoding="utf-8")
        codes = sorted(i.code for i in ex.validate_work_area(self.work))
        self.assertIn("W_EXTRACTION_CHANGED", codes)
        self.assertIn("E_PATH", codes)

    def test_agreement_without_approval_is_not_published(self):
        adj = objs()["adjudication.json"]
        del adj["approval"]
        self.repo.save("Withdraw the approval", [self.change("adjudication.json", adj)])
        err = self.refused(ex.publish, self.repo, {"task": TASK})
        self.assertEqual((err.code, err.status), ("not-approved", 409))
        self.assertNotIn("publications", self.read("task.json"))
        self.assertEqual(list((self.work / "data/LT/EXP").glob("mundExtraction*")), [])

    def test_a_change_after_the_approval_needs_a_new_approval(self):
        adj = objs()["adjudication.json"]
        adj["rows"][2]["value"] = jsonfmt.loads("333.0")
        adj["rows"][2]["original"]["value"] = "333.0"
        self.repo.save("Correct Ca", [self.change("adjudication.json", adj)])     # saved: the approval stays as it was
        err = self.refused(ex.publish, self.repo, {"task": TASK})
        self.assertEqual(err.code, "approval-stale")
        self.assertEqual(list((self.work / "data/LT/EXP").glob("mundExtraction*")), [])
        # the server refuses an approval under another name, or for other content
        o = objs()
        bad = jsonfmt.loads(text(adj))
        bad["approval"] = {"by": "Mallory", "at": "2026-11-18T00:00:00Z",
                           "contentHash": ex.content_hash(o["task.json"], o["input-A.json"], o["input-B.json"], bad)}
        with self.assertRaises(admin.AdminError) as caught:
            self.repo.save("Approve", [self.change("adjudication.json", bad)])
        self.assertEqual([i["code"] for i in caught.exception.extra["issues"]], ["E_APPROVAL_BY"])
        bad["approval"]["by"] = "Carol"
        self.repo.save("Approve again", [self.change("adjudication.json", bad)])
        self.assertEqual(ex.publish(self.repo, {"task": TASK})["sent"], True)
        # hand-written publication records are refused
        task = jsonfmt.loads(self.read("task.json"))
        task["publications"][0]["contentHash"] = "0" * 64
        with self.assertRaises(admin.AdminError):
            self.repo.save("Forge", [self.change("task.json", task)])

    def test_ai_run_sees_the_pdf_and_the_items_only(self):
        # start again: B is to be filled by the AI
        self.repo.save("Remove B", [{"path": path("adjudication.json"), "content": None,
                                     "baseSha": admin.blob_sha(self.read("adjudication.json").encode())}])
        git(self.work, "rm", "-q", path("input-B.json"))
        git(self.work, "commit", "-q", "-m", "Remove B")
        answer = {"rows": [answer_row(),
                           answer_row(label="Si", element="Si", mass=0, value="0.7566", unit="us",
                                      originalValue="0.7566", originalUnit="μs",
                                      uncertainties=[{"source": "total", "value": "0.0010"}]),
                           answer_row(label="Ti", element="Ti", mass=-1, value="", unit="", uncertainties=[],
                                      needsCheck="mass number not legible")],
                  "coverage": [{"item": "Table 1", "status": "covered"}]}
        client = FakeClient(answer)
        available = {"available": True, "model": ai.MODEL, "promptVersion": ai.PROMPT_VERSION, "reason": None}
        with mock.patch.object(ai, "make_client", return_value=client), mock.patch.object(ai, "availability", return_value=available):
            result = ex.run_ai(self.repo, {"task": TASK, "slot": "B", "mode": "ai"}, ai)
        self.assertEqual((result["path"], result["rows"], result["sent"]), (path("input-B.json"), 3, True))
        request = client.requests[0]
        self.assertEqual((request["model"], request["fallbacks"]), ("claude-opus-5-5", "default"))
        document, prompt = request["messages"][0]["content"]
        self.assertEqual(base64.b64decode(document["source"]["data"]), PDF)
        self.assertIn("Table 2", prompt["text"])
        sent = json.dumps(request, ensure_ascii=False)
        for secret in ("Alice", "333", "206.0", "input-A"):
            self.assertNotIn(secret, sent, "the other input never reaches the AI")
        b = jsonfmt.loads(self.read("input-B.json"))
        self.assertEqual((b["mode"], b["run"]["model"], b["run"]["promptVersion"], "submitted" in b),
                         ("ai", ai.MODEL, ai.PROMPT_VERSION, True))
        self.assertEqual(jsonfmt.lexeme(b["rows"][1]["value"]), "0.7566")
        self.assertEqual(b["rows"][2]["needsCheck"], "mass number not legible; nuclide not readable (element 'Ti', mass -1); "
                         "value not readable; unit not readable or not one of ns, us")
        self.assertNotIn("nuclide", b["rows"][2], "not guessed")
        self.assertEqual(b["coverage"], [{"item": "Table 1", "status": "covered"}, {"item": "Table 2", "status": "needs-check"}],
                         "an item the AI did not mark stays open")
        self.assertEqual(self.refused(ex.run_ai, self.repo, {"task": TASK, "slot": "B"}, ai).code, "slot-taken")

    def test_ai_run_refusals(self):
        self.assertEqual(ai.availability({})["reason"], "no-key")
        self.assertEqual(ai.availability({"ANTHROPIC_API_KEY": "x"})["available"],
                         __import__("importlib").util.find_spec("anthropic") is not None)
        git(self.work, "rm", "-q", path("input-B.json"), path("adjudication.json"))
        git(self.work, "commit", "-q", "-m", "Remove B")
        unavailable = {"available": False, "model": ai.MODEL, "promptVersion": ai.PROMPT_VERSION, "reason": "no-key"}
        with mock.patch.object(ai, "availability", return_value=unavailable):
            self.assertEqual(self.refused(ex.run_ai, self.repo, {"task": TASK, "slot": "B"}, ai).code, "ai-unavailable")
        available = dict(unavailable, available=True, reason=None)
        with mock.patch.object(ai, "make_client", return_value=FakeClient({}, stop_reason="refusal")), \
                mock.patch.object(ai, "availability", return_value=available):
            err = self.refused(ex.run_ai, self.repo, {"task": TASK, "slot": "B"}, ai)
        self.assertEqual((err.code, err.extra["reason"]), ("ai-failed", "refused"))
        (self.work / path(ex.PDF_NAME)).write_bytes(PDF + b"changed")
        self.assertEqual(self.refused(ex.run_ai, self.repo, {"task": TASK, "slot": "B"}, ai).code, "pdf-mismatch")
        self.assertFalse((self.work / path("input-B.json")).exists())

    def test_http_routes(self):
        key = "test-key"
        httpd = admin.http.server.ThreadingHTTPServer(("127.0.0.1", 0), admin.make_handler(self.repo, ROOT, key))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        port = httpd.server_address[1]

        def request(method, url, body=None):
            conn = http.client.HTTPConnection("127.0.0.1", port)
            headers = {"Host": "127.0.0.1:%d" % port, "Cookie": "%s=%s" % (admin.COOKIE, key)}
            if body is not None:
                headers["Content-Type"] = "application/json"
            conn.request(method, url, json.dumps(body) if body is not None else None, headers)
            response = conn.getresponse()
            data = json.loads(response.read() or b"null")
            conn.close()
            return response.status, data
        try:
            with mock.patch.dict("os.environ", {}, clear=True):
                self.assertEqual(request("GET", "/api/extraction/ai")[1]["available"], False)
            status, info = request("POST", "/api/extraction/pdf", {"task": "New-1", "data": base64.b64encode(PDF).decode()})
            self.assertEqual((status, info["size"]), (200, len(PDF)))
            self.assertTrue((self.work / "extraction/New-1/source.pdf").is_file())
            self.assertEqual(request("GET", "/api/extraction/pdf?task=New-1")[1]["sha256"], info["sha256"])
            self.assertEqual(request("POST", "/api/extraction/pdf", {"task": "New-1", "data": "bm90IGEgcGRm"})[1]["code"], "not-pdf")
            self.assertEqual(request("POST", "/api/extraction/pdf", {"task": "../x", "data": ""})[0], 400)
            adj = objs()["adjudication.json"]
            del adj["approval"]
            self.repo.save("Withdraw", [self.change("adjudication.json", adj)])
            self.assertEqual(request("POST", "/api/extraction/publish", {"task": TASK}), (409, {
                "code": "not-approved", "message": "the adjudication is not approved"}))
            self.assertEqual(git(self.work, "status", "--porcelain", "--", "data"), "")
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
