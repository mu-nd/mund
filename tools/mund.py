#!/usr/bin/env python3
"""muND command line tool.

    python3 tools/mund.py admin             the data entry tool on this computer (--practice: a throw-away copy)
    python3 tools/mund.py login             log in to GitHub once (needs gh; with pixi: pixi run login)
    python3 tools/mund.py validate          check the files under data/ and the work area extraction/
    python3 tools/mund.py fix [FILE...]     identifiers, canonical form and file name (default: all files)
    python3 tools/mund.py id LT EXP 10.1103/PhysRevC.35.2212 [--element Si --mass 28]
    python3 tools/mund.py build [--out DIR] build the web site into _site/
    python3 tools/mund.py serve             build it and serve it on http://localhost:8000
    python3 tools/mund.py dist --out DIR    the data files of the working tree (as data/latest/)
    python3 tools/mund.py freeze COMMIT     store the files of the major release made by COMMIT in releases/
    python3 tools/mund.py releases          check the frozen releases (files, sources, tags)

Requires Python 3.9+ and the ``jsonschema`` package (pip install -r requirements.txt).
"""
from __future__ import annotations

import argparse
import functools
import http.server
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from mundlib import CODES, DEFINED_SUBLIBRARIES, ids  # noqa: E402
from mundlib import admin as admin_mod  # noqa: E402
from mundlib import build as build_mod  # noqa: E402
from mundlib import extraction as extraction_mod  # noqa: E402
from mundlib.database import Database, assign_ids, canonical_text, file_path  # noqa: E402


def cmd_validate(args) -> int:
    db = Database.load(args.root)
    issues = db.validate() + extraction_mod.validate_work_area(args.root)
    for issue in issues:
        print(issue)
    errors = sum(1 for i in issues if i.level == "error")
    print("%d file(s), %d entries: %d error(s), %d warning(s)"
          % (len(db.files), sum(len(f.data) for f in db.files), errors, len(issues) - errors))
    return 1 if errors else 0


def cmd_fix(args) -> int:
    """Identifiers, canonical form and canonical file name of the given files (default: all)."""
    root = Path(args.root).resolve()
    db = Database.load(root)
    files = {f.path: f for f in list(db.files) + list(db.master.values())}
    paths = [Path(p).resolve().relative_to(root).as_posix() for p in args.files] or sorted(files)
    changed = 0
    for rel in paths:
        f = files.get(rel)
        if f is None:
            raise SystemExit("%s is not a file of the database" % rel)
        if f.obj is None:
            raise SystemExit("%s: not valid JSON: %s" % (rel, f.parse_error))
        target = rel
        if f in db.files:
            assign_ids(f.obj)
            target = file_path(f.obj, db.reference(f.meta.get("bibId")))
        text = canonical_text(f.obj)
        if text == f.text and target == rel:
            continue
        (root / target).parent.mkdir(parents=True, exist_ok=True)
        (root / target).write_text(text, encoding="utf-8")
        if target != rel:
            (root / rel).unlink()
        print("%s -> %s" % (rel, target) if target != rel else "fixed %s" % rel)
        changed += 1
    print("%d file(s) changed" % changed)
    return 0


def cmd_id(args) -> int:
    mid = ids.meta_id(args.sublibrary, args.code, args.doi, args.meta_key)
    print("MetaID  %s   <- %s" % (mid, ids.meta_source(args.sublibrary, args.code, args.doi, args.meta_key)))
    if args.element:
        did = ids.data_id(args.sublibrary, args.code, args.element, args.mass, mid, args.key)
        print("DataID  %s   <- %s" % (did, ids.data_source(args.sublibrary, args.code, args.element,
                                                             args.mass, mid, args.key)))
    return 0


def cmd_dist(args) -> int:
    manifest = build_mod.build_dist(args.root, args.out, args.label)
    print("built %s (%s) in %s" % (manifest["label"], manifest["version"], args.out))
    return 0


def cmd_freeze(args) -> int:
    manifest = build_mod.freeze_release(Path(args.root), args.commit)
    print("froze %s (%s, commit %s) in %s/%s"
          % (manifest["label"], manifest["version"], manifest["commit"][:12], build_mod.RELEASES_DIR, manifest["label"]))
    return 0


def cmd_releases(args) -> int:
    failed = False
    labels = build_mod.frozen_releases(Path(args.root))
    for label in labels:
        report = build_mod.verify_release(Path(args.root), label)
        for text in report["errors"]:
            print("error: " + text)
        for text in report["warnings"]:
            print("warning: " + text)
        failed = failed or bool(report["errors"])
        print("%s: %s" % (label, "not valid" if report["errors"] else "ok"))
    if not labels:
        print("no frozen releases")
    return 1 if failed else 0


def cmd_build(args) -> int:
    versions = build_mod.build_site(args.root, args.out)
    for v in versions["versions"]:
        print("  %-8s %s" % (v["label"], v["version"]))
    print("site written to %s (default version: %s)" % (args.out, versions["default"]))
    return 0


class _Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *a):  # keep the console quiet
        pass


def cmd_serve(args) -> int:
    cmd_build(args)
    handler = functools.partial(_Handler, directory=str(args.out))
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as httpd:
        print("serving http://localhost:%d/  (Ctrl+C to stop)" % args.port)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


def cmd_admin(args) -> int:
    admin_mod.serve(args.root, port=args.port, practice=args.practice, open_browser=not args.no_browser)
    return 0


def cmd_login(args) -> int:
    return admin_mod.login(args.root, with_token=args.with_token)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="muND database tools")
    parser.add_argument("--root", default=str(HERE.parent), help="repository root")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("admin", help="the data entry tool on this computer")
    p.add_argument("--practice", action="store_true", help="work on a throw-away copy")
    p.add_argument("--port", type=int, default=admin_mod.DEFAULT_PORT,
                   help="port on 127.0.0.1 (default: %d)" % admin_mod.DEFAULT_PORT)
    p.add_argument("--no-browser", action="store_true", help="do not open the browser")
    p.set_defaults(func=cmd_admin)

    p = sub.add_parser("login", help="log in to GitHub once (needs gh)")
    p.add_argument("--with-token", action="store_true",
                   help="read a personal access token from standard input instead of logging in in the browser")
    p.set_defaults(func=cmd_login)

    sub.add_parser("validate", help="check the files under data/").set_defaults(func=cmd_validate)

    p = sub.add_parser("fix", help="identifiers, canonical form and file name")
    p.add_argument("files", nargs="*", help="files to fix (default: all)")
    p.set_defaults(func=cmd_fix)

    p = sub.add_parser("id", help="compute a MetaID (and a DataID)")
    p.add_argument("sublibrary", choices=DEFINED_SUBLIBRARIES)
    p.add_argument("code", choices=CODES)
    p.add_argument("doi")
    p.add_argument("--meta-key", default=None)
    p.add_argument("--element")
    p.add_argument("--mass", default="0")
    p.add_argument("--key", default=None)
    p.set_defaults(func=cmd_id)

    p = sub.add_parser("dist", help="the data files of the working tree")
    p.add_argument("--out", required=True)
    p.add_argument("--label", default="latest")
    p.set_defaults(func=cmd_dist)

    p = sub.add_parser("freeze", help="store the files of a major release in releases/")
    p.add_argument("commit", help="the release commit (the one that set VERSION to N.0.0)")
    p.set_defaults(func=cmd_freeze)

    sub.add_parser("releases", help="check the frozen releases").set_defaults(func=cmd_releases)

    for name, func, text in (("build", cmd_build, "build the web site"),
                             ("serve", cmd_serve, "build and serve the web site locally")):
        p = sub.add_parser(name, help=text)
        p.add_argument("--out", help="output directory (default: <root>/_site)")
        if name == "serve":
            p.add_argument("--port", type=int, default=8000)
        p.set_defaults(func=func)

    args = parser.parse_args(argv)
    if args.command in ("build", "serve") and args.out is None:
        args.out = str(Path(args.root) / "_site")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
