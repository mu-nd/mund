import importlib.util
import json
import unittest

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from helpers import ROOT
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
        spec = importlib.util.spec_from_file_location("make_examples", TEMPLATES / "make_examples.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cls.examples = {path: json.loads(text) for path, text in module.generate().items()}

    def test_templates_are_json_schemas(self):
        self.assertEqual(sorted(self.templates), ["BR", "ES", "XR"])
        for schema in self.templates.values():
            Draft202012Validator.check_schema(schema)

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
