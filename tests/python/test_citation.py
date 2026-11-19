import json
import re
import unittest

from helpers import ROOT


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


if __name__ == "__main__":
    unittest.main()
