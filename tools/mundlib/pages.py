"""The pages of the web site.

Every page is a folder with an ``index.html`` (``explorer/index.html`` ...),
so that its address is ``<site>/explorer/``.  All pages are made from
``site/index.html``, the Home page: the same header and footer, with the
relative addresses of scripts, style sheets and links adjusted to the depth of
the folder.  The documents of ``docs/`` (Markdown) are rendered into their
pages here; the scripts fill in the other pages (assets/js/explorer/main.js).
"""
from __future__ import annotations

import html
import posixpath
import re
from pathlib import Path
from typing import Optional

from . import markdown

# pages filled in by the scripts
PAGES = ("explorer", "downloads", "tools/converter")

# pages made from a document: page -> file in docs/
DOCUMENTS = {
    "docs": "README.md",
    "docs/data-format": "data-format.md",
    "docs/identifiers": "id-definition.md",
    "docs/versions": "versioning.md",
    "api": "api.md",
}
_PAGE_OF = {"docs/" + name: page for page, name in DOCUMENTS.items()}

_RELATIVE = re.compile(r"""\b(href|src)="(?![a-z][a-z0-9+.-]*:|//|#|/)([^"]*)\"""")
_MAIN = re.compile(r"(<main\b[^>]*>)(.*?)(</main>)", re.S)
_TITLE = re.compile(r"<title>.*?</title>", re.S)
SITE_NAME = "Muon Nuclear Data"


def page_html(template: str, page: str, main: Optional[str] = None, title: Optional[str] = None) -> str:
    """The Home page ``template`` moved to the folder ``page`` ('' is Home itself):
    relative addresses get one '../' per level, <body data-page> names the page
    (the scripts read it), ``main`` replaces the content of <main> and ``title``
    names the page in <title>."""
    up = "../" * (page.count("/") + 1) if page else ""

    def move(m):
        target = m.group(2)
        if target in ("./", ""):
            target = up or "./"
        else:
            target = up + target
        return '%s="%s"' % (m.group(1), target)

    text = _RELATIVE.sub(move, template) if up else template
    text = text.replace('<body data-page="">', '<body data-page="%s">' % page, 1)
    if main is not None:
        text = _MAIN.sub(lambda m: m.group(1) + "\n" + main + "\n" + m.group(3), text, count=1)
    if title:
        text = _TITLE.sub("<title>%s – %s</title>" % (html.escape(title), SITE_NAME), text, count=1)
    return text


def document_link(href: str, page: str, config: dict) -> str:
    """Where a link of a document in docs/ points to on the page ``page``:
    another document -> its page; a published schema -> the file on the site;
    any other file of the repository -> GitHub; addresses of the site itself
    (config["siteUrl"]) -> relative."""
    up = "../" * (page.count("/") + 1) if page else ""
    site = config.get("siteUrl") or ""
    if site and href.startswith(site):
        return up + href[len(site):] or "./"
    if re.match(r"^[a-z][a-z0-9+.-]*:|^#|^/", href):
        return href
    path, _, frag = href.partition("#")
    name = posixpath.normpath(posixpath.join("docs", path))
    frag = "#" + frag if frag else ""
    target = _PAGE_OF.get(name)
    if target is not None:
        return up + target + "/" + frag
    if name.startswith("schema/") and name.endswith(".json"):
        return up + name + frag
    kind = "blob" if posixpath.splitext(name)[1] else "tree"
    return "https://github.com/%s/%s/%s/%s%s" % (config["repository"], kind, config.get("branch", "main"), name, frag)


def render_document(root: Path, page: str, config: dict) -> tuple:
    """(HTML, title) of the document shown on ``page``."""
    text = (Path(root) / "docs" / DOCUMENTS[page]).read_text(encoding="utf-8")
    body, title, headings = markdown.to_html(text, lambda href: document_link(href, page, config))
    sections = [(ident, text) for level, ident, text in headings if level == 2]
    toc = ""
    if len(sections) > 3:      # a contents box only for longer documents
        toc = '<nav class="doc-toc" aria-label="Contents"><ul>%s</ul></nav>' % "".join(
            '<li><a href="#%s">%s</a></li>' % (ident, html.escape(text)) for ident, text in sections)
    if toc and "</h1>" in body:
        body = body.replace("</h1>", "</h1>\n" + toc, 1)
    elif toc:
        body = toc + "\n" + body
    source = "https://github.com/%s/blob/%s/docs/%s" % (config["repository"], config.get("branch", "main"), DOCUMENTS[page])
    foot = '<p class="doc-source small muted">This page is made from <a href="%s">docs/%s</a> in the repository.</p>' % (
        source, DOCUMENTS[page])
    return '<article class="doc prose">\n%s\n%s</article>' % (body, foot), title


def write_pages(root: Path, out: Path, config: dict) -> list:
    """Write the page of every folder of PAGES and DOCUMENTS next to out/index.html."""
    out = Path(out)
    template = (out / "index.html").read_text(encoding="utf-8")
    written = []
    for page in PAGES:
        target = out / page / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(page_html(template, page), encoding="utf-8")
        written.append(page)
    for page in DOCUMENTS:
        body, title = render_document(root, page, config)
        target = out / page / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(page_html(template, page, body, title), encoding="utf-8")
        written.append(page)
    return written
