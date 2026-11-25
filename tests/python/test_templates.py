import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from helpers import ROOT, load_script
from mundlib.schema import SCHEMA_DIR, schema_for, validate

TEMPLATES = ROOT / "templates"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


class TemplateTests(unittest.TestCase):
    """The templates of XR, ES and BR: valid schemas, and the examples follow them."""

    @classmethod
    def setUpClass(cls):
        lt = load(SCHEMA_DIR / "lt.schema.json")                  # the templates use its parts
        cls.registry = Registry().with_resource(lt["$id"], Resource.from_contents(lt))
        cls.templates = {p.name.split(".")[0].upper(): load(p) for p in TEMPLATES.glob("*.schema.json")}
        generated = load_script(TEMPLATES / "make_examples.py").generate()
        cls.examples = {path: json.loads(text) for path, text in generated.items()}

    def test_templates_are_json_schemas(self):
        self.assertEqual(sorted(self.templates), ["BR", "ES", "XR"])
        for schema in self.templates.values():
            Draft202012Validator.check_schema(schema)

    def test_examples_refuse_database_output(self):
        generator = load_script(TEMPLATES / "make_examples.py")
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            bib = repo / "data/master/bibliography.json"
            bib.parent.mkdir(parents=True)
            bib.write_bytes(b"keep")
            with mock.patch.object(generator, "ROOT", repo):
                for out in (repo, repo / "data/examples"):
                    with self.subTest(out=out), self.assertRaises(SystemExit):
                        generator.main([out])
            self.assertEqual(bib.read_bytes(), b"keep")
            self.assertEqual(list((repo / "data").iterdir()), [bib.parent])

    def test_examples_follow_the_templates(self):
        covered = set()
        for path, doc in self.examples.items():
            if path == "data/master/bibliography.json":
                errors = validate(doc, schema_for(doc["format"]))
            else:
                covered.add(doc["sublibrary"])
                validator = Draft202012Validator(self.templates[doc["sublibrary"]], registry=self.registry)
                errors = [(e.json_path, e.message) for e in validator.iter_errors(doc)]
            self.assertEqual(errors, [], path)
        self.assertEqual(covered, set(self.templates))

    def test_a_template_refuses_what_it_does_not_describe(self):
        doc = next(d for p, d in sorted(self.examples.items()) if p.startswith("data/XR/"))
        doc = json.loads(json.dumps(doc))
        doc["data"][0]["observable"]["xray"]["energy"]["unit"] = "MeV"
        doc["data"][0]["nuclide"]["element"] = "Xx"
        validator = Draft202012Validator(self.templates["XR"], registry=self.registry)
        self.assertEqual(len(list(validator.iter_errors(doc))), 2)


if __name__ == "__main__":
    unittest.main()
