"""The static web site.

Output layout (``_site/`` by default)::

    db/, assets/                        the web site (copied from site/)
    index.html, explorer/, docs/ ...    the pages, made from site/index.html
    api/versions.json                   the versions below
    api/<label>/...                     JSON files for programs (api.py)
    schema/v1/*.schema.json             JSON Schemas
    tests/                              the browser test page (tests/js, tests/vectors)
    data/<label>/...                    the files of one version (build.py)

``<label>`` is ``latest`` for the current state of the repository and ``v1``,
``v2`` ... for the released major versions, published as they were frozen
(releases.py).

Every page is a folder with an ``index.html`` (``explorer/index.html`` ...),
so that its address is ``<site>/explorer/``.  All pages, Home included, are
made from ``site/index.html``: the same header and footer, with the relative
addresses of scripts, style sheets and links adjusted to the depth of the
folder, the page marked in the menu and the repository of site/config.json in
the GitHub link.  The documents of ``docs/`` (Markdown) are rendered into their
pages here; the scripts fill in the other pages (assets/js/pages/main.js).
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import posixpath
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Optional, Tuple

from . import jsonfmt, markdown
from .api import VERSION_KEYS, build_api
from .build import build_dist
from .releases import RELEASES_DIR, frozen_releases, verify_release

# pages filled in by the scripts: page -> its name in <title> (Home: the site name alone)
PAGES = {"": None, "explorer": "Explorer", "downloads": "Downloads", "tools/converter": "Converter"}

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
_TITLE = re.compile(r"<title>(.*?)</title>", re.S)
_NAV = re.compile(r'<nav class="site-nav".*?</nav>', re.S)
_SOURCE = re.compile(r'(\bid="source" href=")[^"]*"')


def _up(page: str) -> str:
    """The way from the folder ``page`` up to Home: one '../' per level."""
    return "../" * (page.count("/") + 1) if page else ""


def _menu_entry(page: str) -> str:
    """The entry of the menu a page belongs to: the documents and the converter are under Docs."""
    return "docs" if page.startswith("docs/") or page == "tools/converter" else page


def _github(config: dict, kind: str, path: str) -> str:
    """Address of ``path`` of the repository on GitHub (``kind`` 'blob' for a file, 'tree' for a folder)."""
    return "https://github.com/%s/%s/%s/%s" % (config["repository"], kind, config.get("branch", "main"), path)


def page_html(template: str, page: str, config: dict, main: Optional[str] = None, title: Optional[str] = None) -> str:
    """The template ``template`` (site/index.html) made into the page in the folder
    ``page`` ('' is Home): the menu marks the entry of the page (aria-current), the
    GitHub link names config["repository"], relative addresses get one '../' per
    level, <body data-page> names the page (the scripts read it), ``main`` replaces
    the content of <main> and ``title`` names the page in <title>, before the site
    name of the template."""
    up = _up(page)
    entry = '<a href="%s">' % (_menu_entry(page) + "/" if page else "./")
    current = entry[:-1] + ' aria-current="page">'

    def move(m):
        target = m.group(2)
        if target in ("./", ""):
            target = up or "./"
        else:
            target = up + target
        return '%s="%s"' % (m.group(1), target)

    text = _NAV.sub(lambda m: m.group(0).replace(entry, current, 1), template, count=1)
    text = _SOURCE.sub(lambda m: '%shttps://github.com/%s"' % (m.group(1), config["repository"]), text, count=1)
    text = _RELATIVE.sub(move, text) if up else text
    text = text.replace('<body data-page="">', '<body data-page="%s">' % page, 1)
    if main is not None:
        text = _MAIN.sub(lambda m: m.group(1) + "\n" + main + "\n" + m.group(3), text, count=1)
    if title:
        text = _TITLE.sub(lambda m: "<title>%s – %s</title>" % (html.escape(title), m.group(1)), text, count=1)
    return text


def document_link(href: str, page: str, config: dict) -> str:
    """Where a link of a document in docs/ points to on the page ``page``:
    another document -> its page; a published schema -> the file on the site;
    any other file of the repository -> GitHub; addresses of the site itself
    (config["siteUrl"]) -> relative."""
    up = _up(page)
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
    return _github(config, kind, name + frag)


def render_document(root: Path, page: str, config: dict) -> Tuple[str, str]:
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
    source = _github(config, "blob", "docs/" + DOCUMENTS[page])
    foot = '<p class="doc-source small muted">This page is made from <a href="%s">docs/%s</a> in the repository.</p>' % (
        source, DOCUMENTS[page])
    return '<article class="doc prose">\n%s\n%s</article>' % (body, foot), title


def write_pages(root: Path, out: Path, config: dict) -> None:
    """Write the page of every folder of PAGES and DOCUMENTS, Home included, from out/index.html."""
    out = Path(out)
    template = (out / "index.html").read_text(encoding="utf-8")
    for page in list(PAGES) + list(DOCUMENTS):
        main, title = render_document(root, page, config) if page in DOCUMENTS else (None, PAGES[page])
        target = out / page / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(page_html(template, page, config, main, title).encode("utf-8"))


_IMPORT_RE = re.compile(r"""(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}/[^'"?]+\.js)\2""")
_ASSET_RE = re.compile(r"""\b(src|href)="((?!https?:|//|#)[^"?]+\.(?:js|css))\"""")


def stamp_assets(out: Path) -> None:
    """Make the address of every script and style sheet change with its content.

    Browsers and web servers cache files for a while.  A short hash of all
    scripts and style sheets is appended to every reference
    (``./ids.js`` -> ``./ids.js?v=1a2b3c4d5e``), in the pages and in the
    ``import`` statements, so that a page always loads the code it was built
    with.  Only the built site is changed; the sources in ``site/`` stay as they are.
    """
    files = sorted((p for p in out.rglob("*") if p.is_file() and p.suffix in (".js", ".css", ".html")),
                   key=lambda p: p.as_posix())
    digest = hashlib.sha256()
    for path in files:
        if path.suffix != ".html":
            digest.update(path.relative_to(out).as_posix().encode("utf-8"))
            digest.update(path.read_bytes())
    stamp = digest.hexdigest()[:10]

    def imports(text: str) -> str:
        return _IMPORT_RE.sub(lambda m: "%s%s%s?v=%s%s" % (m.group(1), m.group(2), m.group(3), stamp, m.group(2)), text)

    for path in files:
        if path.suffix == ".css":
            continue
        text = path.read_text(encoding="utf-8")
        new = imports(text)
        if path.suffix == ".html":
            new = _ASSET_RE.sub(lambda m: '%s="%s?v=%s"' % (m.group(1), m.group(2), stamp), new)
        if new != text:
            path.write_bytes(new.encode("utf-8"))


_BUILD_STAMP = ".mund-build"


def _build_digest(folder: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(folder.rglob("*"), key=lambda p: p.as_posix()):
        rel = path.relative_to(folder).as_posix()
        if rel == _BUILD_STAMP:
            continue
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError("unexpected file in build: %s" % rel)
        digest.update(rel.encode("utf-8") + b"\0")
        digest.update(b"D" if path.is_dir() else b"F" + hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def _check_out(out: Path, root: Path) -> None:
    """Refuse an output folder that holds the repository, is a file, or holds anything else than an earlier build."""
    target, repo = out.resolve(), root.resolve()
    if target == repo or target in repo.parents:
        raise ValueError("%s holds the repository; choose a new or empty folder" % out)
    staging_parent = out.parent.resolve()
    for rel in ("site", "schema", "tests/js", "tests/vectors"):
        source = (repo / rel).resolve()
        if source.exists() and any(p.exists() and p.samefile(source) for p in (target, staging_parent, *staging_parent.parents)):
            raise ValueError("%s is inside a copied folder; choose another output folder" % out)
    if out.exists() and not out.is_dir():
        raise ValueError("%s is a file; choose a new or empty folder" % out)
    if out.is_dir() and any(out.iterdir()):
        stamp = out / _BUILD_STAMP
        try:
            if not out.is_symlink() and not stamp.is_symlink() and stamp.is_file():
                if stamp.read_bytes() == _build_digest(out).encode("ascii"):
                    return
        except (OSError, ValueError):
            pass
        raise ValueError("%s is not empty and is not a site built by mund.py; choose a new or empty folder" % out)


def build_site(root, out) -> dict:
    """Assemble the complete static site in ``out`` (a new or empty folder or an earlier build).

    The site is built in a temporary folder beside ``out`` and replaces ``out``
    only when the build succeeds.  Both paths are made absolute first: the
    working folder may be the earlier build, which is moved aside.
    """
    root, out = Path(os.path.abspath(root)), Path(os.path.abspath(out))
    _check_out(out, root)
    out.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".%s-" % out.name, dir=out.parent))
    try:
        staged = work / "site"
        versions = _assemble(root, staged)
        (staged / _BUILD_STAMP).write_bytes(_build_digest(staged).encode("ascii"))
        _check_out(out, root)
        previous = work / "previous"
        if out.exists():
            out.rename(previous)
        try:
            staged.rename(out)
        except BaseException:
            if previous.exists():
                previous.rename(out)
            raise
    except BaseException:
        if not (work / "previous").exists():
            shutil.rmtree(work, ignore_errors=True)
        raise
    shutil.rmtree(work)
    return versions


def _assemble(root: Path, out: Path) -> dict:
    """Write the site into the new folder ``out``."""
    shutil.copytree(root / "site", out)
    config = json.loads((root / "site" / "config.json").read_text(encoding="utf-8"))
    write_pages(root, out, config)
    shutil.copytree(root / "schema", out / "schema")
    shutil.copytree(root / "tests" / "js", out / "tests", ignore=shutil.ignore_patterns("*.mjs"))
    shutil.copytree(root / "tests" / "vectors", out / "tests" / "vectors")
    stamp_assets(out)

    data = out / "data"
    manifests = [build_dist(root, data / "latest", "latest")]
    for label in frozen_releases(root):
        report = verify_release(root, label)
        for warning in report["warnings"]:
            print("warning: " + warning, file=sys.stderr)
        if report["errors"]:
            raise ValueError("frozen release %s cannot be published:\n%s" % (label, "\n".join(report["errors"])))
        folder = root / RELEASES_DIR / label
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        paths = ["manifest.json"] + [f["path"] for f in manifest["files"]]
        if (manifest.get("archive") or {}).get("path"):
            paths.append(manifest["archive"]["path"])
        for rel in paths:
            (data / label / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(folder / rel, data / label / rel)      # published exactly as frozen
        manifests.append(manifest)
    released = [m for m in manifests if m["kind"] == "release"]

    def listing(m):
        return {key: m[key] for key in VERSION_KEYS}

    versions = {
        "format": "muND/versions/1",
        "default": released[-1]["label"] if released else "latest",
        "versions": [listing(m) for m in reversed(released)] + [listing(manifests[0])],
    }
    jsonfmt.write(out / "api" / "versions.json", versions)
    for m in manifests:
        build_api(data / m["label"], out / "api" / m["label"], config)
    return versions
