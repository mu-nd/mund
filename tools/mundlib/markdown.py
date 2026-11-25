"""Markdown to HTML for the documents in docs/, as far as they use it.

Read: ATX headings (``#`` .. ``######``), paragraphs, fenced code blocks, tables
(GitHub style; the alignment row is read and its marks are ignored), bullet
(``*`` ``+`` ``-``) and numbered lists whose items may continue on indented lines,
and inline code, links, ``**strong**`` and ``*emphasis*``.  Anything else is
shown as text.  Headings get the identifiers GitHub gives them, so that links
to ``file.md#section`` work on both.
"""
from __future__ import annotations

import html
import re
from typing import Callable, List, Optional, Tuple

_FENCE = re.compile(r"^(\s*)(`{3,})\s*([\w+-]*)\s*$")
_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_ITEM = re.compile(r"^( {0,3})([*+-]|\d{1,9}[.)])\s+(.*)$")
_TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")
_CODE_SPAN = re.compile(r"(`+)(.+?)\1")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_STRONG = re.compile(r"\*\*(?!\s)(.+?)(?<!\s)\*\*")
_EMPHASIS = re.compile(r"(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])")


def _is_table(line: str, nxt: Optional[str]) -> bool:
    """Whether a table starts at ``line``: a row followed by the alignment row ``nxt``."""
    return line.lstrip().startswith("|") and nxt is not None and bool(_TABLE_RULE.match(nxt))


def slug(text: str) -> str:
    """GitHub's identifier of a heading: lower case, punctuation removed, spaces as '-'."""
    text = re.sub(r"<[^>]+>", "", text).strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


class _Renderer:
    def __init__(self, link: Callable[[str], str]):
        self.link = link
        self.ids: dict = {}
        self.headings: List[Tuple[int, str, str]] = []

    # -- inline ---------------------------------------------------------------
    def inline(self, text: str) -> str:
        codes: List[str] = []

        def keep(m):
            codes.append("<code>%s</code>" % html.escape(m.group(2).strip(), quote=False))
            return "\x00%d\x00" % (len(codes) - 1)

        text = html.escape(_CODE_SPAN.sub(keep, text), quote=False)
        text = _LINK.sub(lambda m: '<a href="%s">%s</a>' % (
            html.escape(self.link(html.unescape(m.group(2)))), m.group(1)), text)
        text = _STRONG.sub(r"<strong>\1</strong>", text)
        text = _EMPHASIS.sub(r"<em>\1</em>", text)
        return re.sub("\x00(\\d+)\x00", lambda m: codes[int(m.group(1))], text)

    def plain(self, text: str) -> str:
        """Text of a heading without markup (for identifiers and titles)."""
        return html.unescape(re.sub(r"<[^>]+>", "", self.inline(text)))

    # -- blocks ---------------------------------------------------------------
    def heading(self, level: int, text: str) -> str:
        plain = self.plain(text)
        base = slug(plain)
        n = self.ids.get(base, 0)
        self.ids[base] = n + 1
        ident = base if n == 0 else "%s-%d" % (base, n)
        self.headings.append((level, ident, plain))
        return '<h%d id="%s">%s</h%d>' % (level, ident, self.inline(text), level)

    @staticmethod
    def cells(line: str) -> List[str]:
        """The cells of a table row; '|' inside code spans and '\\|' do not separate."""
        line = line.strip()
        if line.startswith("|"):
            line = line[1:]
        if line.endswith("|") and not line.endswith("\\|"):
            line = line[:-1]
        out, cur, ticks, i = [], "", 0, 0
        while i < len(line):
            c = line[i]
            if c == "\\" and i + 1 < len(line) and line[i + 1] == "|":
                cur += "|"
                i += 2
                continue
            if c == "`":
                run = len(line[i:]) - len(line[i:].lstrip("`"))
                ticks = 0 if ticks == run else (run if ticks == 0 else ticks)
                cur += "`" * run
                i += run
                continue
            if c == "|" and ticks == 0:
                out.append(cur.strip())
                cur = ""
            else:
                cur += c
            i += 1
        out.append(cur.strip())
        return out

    def table(self, rows: List[str]) -> str:
        head = self.cells(rows[0])
        body = [self.cells(r) for r in rows[2:]]
        out = ['<div class="table-wrap"><table class="data">', "<thead><tr>"]
        out += ["<th>%s</th>" % self.inline(c) for c in head]
        out.append("</tr></thead><tbody>")
        for r in body:
            r = (r + [""] * len(head))[:len(head)]
            out.append("<tr>%s</tr>" % "".join("<td>%s</td>" % self.inline(c) for c in r))
        out.append("</tbody></table></div>")
        return "".join(out)

    def render(self, text: str) -> str:
        lines = text.replace("\r\n", "\n").split("\n")
        out: List[str] = []
        i, n = 0, len(lines)

        def starts_block(line: str, nxt: Optional[str]) -> bool:
            return bool(_FENCE.match(line) or _HEADING.match(line) or _ITEM.match(line)) or _is_table(line, nxt)

        while i < n:
            line = lines[i]
            nxt = lines[i + 1] if i + 1 < n else None
            if not line.strip():
                i += 1
                continue
            m = _FENCE.match(line)
            if m:
                indent, fence, lang = len(m.group(1)), m.group(2), m.group(3)
                code, i = [], i + 1
                while i < n and not (lines[i].strip().startswith(fence) and not lines[i].strip().strip("`")):
                    code.append(lines[i][indent:] if lines[i][:indent].strip() == "" else lines[i])
                    i += 1
                i += 1
                cls = ' class="language-%s"' % lang if lang else ""
                out.append('<pre class="code"><code%s>%s</code></pre>' % (cls, html.escape("\n".join(code), quote=False)))
                continue
            m = _HEADING.match(line)
            if m:
                out.append(self.heading(len(m.group(1)), m.group(2)))
                i += 1
                continue
            if _is_table(line, nxt):
                rows = [line, nxt]
                i += 2
                while i < n and lines[i].lstrip().startswith("|"):
                    rows.append(lines[i])
                    i += 1
                out.append(self.table(rows))
                continue
            m = _ITEM.match(line)
            if m:
                ordered = m.group(2)[0].isdigit()
                # a numbered list that goes on after a code block starts at its own number
                start = int(m.group(2)[:-1]) if ordered else 1
                items: List[List[str]] = []
                while i < n:
                    m = _ITEM.match(lines[i])
                    if m and m.group(2)[0].isdigit() == ordered:
                        items.append([m.group(3)])
                        i += 1
                    elif lines[i].strip() and lines[i][:1] in (" ", "\t") and items:
                        items[-1].append(lines[i].strip())
                        i += 1
                    elif not lines[i].strip():
                        # a blank line ends the list unless the next item follows
                        j = i
                        while j < n and not lines[j].strip():
                            j += 1
                        m = _ITEM.match(lines[j]) if j < n else None
                        if m and m.group(2)[0].isdigit() == ordered:
                            i = j
                        else:
                            break
                    else:
                        break
                tag = "ol" if ordered else "ul"
                attrs = ' start="%d"' % start if start != 1 else ""
                out.append("<%s%s>%s</%s>" % (tag, attrs, "".join("<li>%s</li>" % self.inline("\n".join(it)) for it in items), tag))
                continue
            para = [line.strip()]
            i += 1
            while i < n and lines[i].strip() and not starts_block(lines[i], lines[i + 1] if i + 1 < n else None):
                para.append(lines[i].strip())
                i += 1
            out.append("<p>%s</p>" % self.inline("\n".join(para)))
        return "\n".join(out)


def to_html(text: str, link: Callable[[str], str] = lambda href: href) -> Tuple[str, str, List[Tuple[int, str, str]]]:
    """HTML of a Markdown document, its title (the first heading) and its
    headings as (level, identifier, text).  ``link`` maps every link target."""
    r = _Renderer(link)
    body = r.render(text)
    title = r.headings[0][2] if r.headings else ""
    return body, title, r.headings
