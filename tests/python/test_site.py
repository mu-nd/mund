import unittest

from helpers import ROOT  # noqa: F401  (puts tools/ on the path)
from mundlib import site


class PageTests(unittest.TestCase):
    CONFIG = {"repository": "mu-nd/mund", "branch": "main", "siteUrl": "https://ribf.riken.jp/muon/"}

    def test_page_html(self):
        template = ('<title>Muon Nuclear Data</title><body data-page=""><a class="brand" href="./">x</a><link href="assets/a.css">'
                    '<a href="https://x.org/">e</a><a href="#top">t</a><main id="main"><p>Loading</p></main>')
        text = site.page_html(template, "docs/data-format", self.CONFIG, "<article>doc</article>", "Format")
        self.assertIn('<title>Format – Muon Nuclear Data</title>', text)
        self.assertIn('<body data-page="docs/data-format">', text)
        self.assertIn('class="brand" href="../../"', text)
        self.assertIn('href="../../assets/a.css"', text)
        self.assertIn('href="https://x.org/"', text)
        self.assertIn('href="#top"', text)
        self.assertIn("<main id=\"main\">\n<article>doc</article>\n</main>", text)

    def test_document_links(self):
        link = lambda href, page="docs/data-format": site.document_link(href, page, self.CONFIG)  # noqa: E731
        self.assertEqual(link("id-definition.md"), "../../docs/identifiers/")
        self.assertEqual(link("versioning.md#citing"), "../../docs/versions/#citing")
        self.assertEqual(link("README.md"), "../../docs/")
        self.assertEqual(link("api.md", "api"), "../api/")
        self.assertEqual(link("../schema/v1/lt.schema.json"), "../../schema/v1/lt.schema.json")
        self.assertEqual(link("../schema/v1"), "https://github.com/mu-nd/mund/tree/main/schema/v1")
        self.assertEqual(link("admin-guide.ja.md"), "https://github.com/mu-nd/mund/blob/main/docs/admin-guide.ja.md")
        self.assertEqual(link("https://ribf.riken.jp/muon/downloads/", "api"), "../downloads/")
        self.assertEqual(link("https://doi.org/10.1/x"), "https://doi.org/10.1/x")
        self.assertEqual(link("#section"), "#section")


if __name__ == "__main__":
    unittest.main()
