import unittest

from helpers import ROOT  # noqa: F401  (puts tools/ on the path)
from mundlib import api, markdown, pages


class MarkdownTests(unittest.TestCase):
    def test_blocks(self):
        body, title, headings = markdown.to_html(
            "# Title\n\nText *with* **marks** and `code <b>`.\nSecond line.\n\n"
            "## 1. Model (`meta`)\n\n"
            "* one\n  continued\n* two\n\n"
            "1. first\n2. second\n\n"
            "| a | b |\n|---|:---:|\n| `x | y` | [l](other.md#s) |\n\n"
            "```json\n{\"a\": 1}\n```\n")
        self.assertEqual(title, "Title")
        self.assertEqual(headings, [(1, "title", "Title"), (2, "1-model-meta", "1. Model (meta)")])
        self.assertIn("<p>Text <em>with</em> <strong>marks</strong> and <code>code &lt;b&gt;</code>.\nSecond line.</p>", body)
        self.assertIn("<ul><li>one\ncontinued</li><li>two</li></ul>", body)
        self.assertIn("<ol><li>first</li><li>second</li></ol>", body)
        self.assertIn("<td><code>x | y</code></td>", body, "| inside code does not split a cell")
        self.assertIn('<a href="other.md#s">l</a>', body)
        self.assertIn('<pre class="code"><code class="language-json">{"a": 1}</code></pre>', body)

    def test_a_numbered_list_continues_after_code(self):
        body, _, _ = markdown.to_html("1. one\n2. two\n\n   ```sh\n   cmd\n   ```\n\n3. three\n")
        self.assertIn('<ol><li>one</li><li>two</li></ol>', body)
        self.assertIn('<pre class="code"><code class="language-sh">cmd</code></pre>', body)
        self.assertIn('<ol start="3"><li>three</li></ol>', body)

    def test_heading_identifiers_are_unique(self):
        _, _, headings = markdown.to_html("## A\n\n## A\n")
        self.assertEqual([h[1] for h in headings], ["a", "a-1"])

    def test_the_documents_render(self):
        config = {"repository": "mu-nd/mund", "branch": "main", "siteUrl": "https://ribf.riken.jp/muon/"}
        for page in pages.DOCUMENTS:
            body, title = pages.render_document(ROOT, page, config)
            self.assertTrue(title, page)
            self.assertNotIn("](", body, "%s: a link was not read" % page)
            self.assertNotIn("```", body, page)


class PageTests(unittest.TestCase):
    CONFIG = {"repository": "mu-nd/mund", "branch": "main", "siteUrl": "https://ribf.riken.jp/muon/"}

    def test_page_html(self):
        template = ('<title>Muon Nuclear Data</title><body data-page=""><a class="brand" href="./">x</a><link href="assets/a.css">'
                    '<a href="https://x.org/">e</a><a href="#top">t</a><main id="main"><p>Loading</p></main>')
        text = pages.page_html(template, "docs/data-format", "<article>doc</article>", "Format")
        self.assertIn('<title>Format – Muon Nuclear Data</title>', text)
        self.assertIn('<body data-page="docs/data-format">', text)
        self.assertIn('class="brand" href="../../"', text)
        self.assertIn('href="../../assets/a.css"', text)
        self.assertIn('href="https://x.org/"', text)
        self.assertIn('href="#top"', text)
        self.assertIn("<main id=\"main\">\n<article>doc</article>\n</main>", text)
        self.assertEqual(pages.page_html(template, ""), template)

    def test_document_links(self):
        link = lambda href, page="docs/data-format": pages.document_link(href, page, self.CONFIG)  # noqa: E731
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


class ApiNameTests(unittest.TestCase):
    def test_nuclide_names(self):
        self.assertEqual(api.nuclide_name({"element": "Si", "mass": 28, "isomer": 0}), "Si-28")
        self.assertEqual(api.nuclide_name({"element": "Si", "mass": 0, "isomer": 0}), "Si-nat")
        self.assertEqual(api.nuclide_name({"element": "Ta", "mass": 180, "isomer": 1}), "Ta-180m1")

    def test_citation(self):
        # the same texts as the site (tests/js/suite-explorer.js, "cite: the project paper and the database")
        self.assertEqual([api.initials(g) for g in ("Yukinobu", "Jean-Pierre", "T. Y.")], ["Y.", "J.-P.", "T. Y."])
        names = ["Watanabe Yukinobu", "Niikura Megumi", "Abe Shinichiro", "Biswas Sayani", "Iwamoto Hiroki", "Hillier Adrian",
                 "Kawamura Naritoshi", "Kawase Shoichiro", "Matsuzaki Teiichiro", "Minato Futoshi", "Mizuno Rurie", "Tomono Dai",
                 "Yamaguchi Yuji"]
        authors = [{"family": n.split()[0], "given": n.split()[1]} for n in names]
        config = {
            "siteUrl": "https://ribf.riken.jp/muon/",
            "paper": {"title": "Muon Nuclear Data Development Project", "year": 2026, "arxiv": "2605.15539", "authors": authors[:3]},
            "data": {"title": "muND: Muon Nuclear Data", "author": "muND Project Team"},
        }
        release = {"label": "v1", "version": "1.0.0", "kind": "release", "commit": "abcdef1234", "date": "2026-11-16T10:00:00+09:00"}
        self.assertEqual(api.citations(config, release), {
            "paper": "Y. Watanabe, M. Niikura, and S. Abe, Muon Nuclear Data Development Project, arXiv:2605.15539 (2026).",
            "database": "muND Project Team, muND: Muon Nuclear Data, version 1.0.0 (2026), https://ribf.riken.jp/muon/explorer/?v=v1.",
        })
        config["paper"]["authors"] = authors
        dev = dict(release, label="latest", version="1.0.0+2.gabcdef1", kind="development")
        self.assertEqual(api.citations(config, dev), {
            "paper": "Y. Watanabe et al., Muon Nuclear Data Development Project, arXiv:2605.15539 (2026).",
            "database": "muND Project Team, muND: Muon Nuclear Data, development version 1.0.0+2.gabcdef1, commit abcdef1, "
                        "not a stable version (2026), https://ribf.riken.jp/muon/explorer/?v=latest.",
        })
        config["paper"]["authors"] = authors[:2]
        self.assertTrue(api.citations(config, release)["paper"].startswith("Y. Watanabe and M. Niikura, Muon"))
        self.assertEqual(api.citations({"data": config["data"]}, dict(release, date=None))["paper"], None)


if __name__ == "__main__":
    unittest.main()
