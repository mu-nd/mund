import json
import re
import unittest

from helpers import ROOT
from mundlib.cite import BIB_ID_FORMS


class CitationMetadataTests(unittest.TestCase):
    """What the site cites (site/config.json `paper` and `data`) is what CITATION.cff says."""

    def setUp(self):
        self.config = json.loads((ROOT / "site/config.json").read_text(encoding="utf-8"))
        self.cff = (ROOT / "CITATION.cff").read_text(encoding="utf-8")

    def test_the_paper(self):
        preferred = self.cff[self.cff.index("preferred-citation:"):]
        authors = re.findall(r"\{family-names: ([^,]+), given-names: ([^}]+)\}", preferred)
        paper = self.config["paper"]
        self.assertEqual([(a["family"], a["given"]) for a in paper["authors"]], [(f.strip(), g.strip()) for f, g in authors])
        self.assertIn('title: "%s"' % paper["title"], preferred)
        self.assertIn("year: %d" % paper["year"], preferred)
        self.assertIn('url: "%s"' % paper["url"], preferred)
        self.assertIn('value: "arXiv:%s"' % paper["arxiv"], preferred)

    def test_the_database(self):
        head = self.cff[:self.cff.index("preferred-citation:")]
        self.assertIn('title: "%s"' % self.config["data"]["title"], head)
        self.assertIn('- name: "%s"' % self.config["data"]["author"], head)


class BibIdPatternTests(unittest.TestCase):
    """The bibId pattern of every schema is made of the forms in tools/mundlib/cite.py
    (the same check for cite.js: tests/js/suite.js)."""

    def test_every_schema_has_the_pattern_of_the_forms(self):
        pattern = r"^(%s)$" % "|".join("%s:%s" % form for form in BIB_ID_FORMS)
        lt, bibliography = (json.loads((ROOT / "schema" / "v1" / name).read_text(encoding="utf-8"))
                            for name in ("lt.schema.json", "bibliography.schema.json"))
        self.assertEqual([lt["$defs"]["bibId"]["pattern"],
                          bibliography["properties"]["references"]["items"]["properties"]["id"]["pattern"]],
                         [pattern, pattern])


if __name__ == "__main__":
    unittest.main()
