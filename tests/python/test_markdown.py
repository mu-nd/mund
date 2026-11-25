import unittest

from helpers import ROOT  # noqa: F401  (puts tools/ on the path)
from mundlib import markdown, site


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
        for page in site.DOCUMENTS:
            body, title = site.render_document(ROOT, page, config)
            self.assertTrue(title, page)
            self.assertNotIn("](", body, "%s: a link was not read" % page)
            self.assertNotIn("```", body, page)


if __name__ == "__main__":
    unittest.main()
