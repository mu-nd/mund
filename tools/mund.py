#!/usr/bin/env python3
"""muND command line tool: check and fix the data files, compute identifiers,
build the site, freeze releases and run the data entry tool.

python3 tools/mund.py -h lists the commands.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from mundlib import CODES, DEFINED_SUBLIBRARIES, ids  # noqa: E402
from mundlib import admin as admin_mod  # noqa: E402
from mundlib import releases, site  # noqa: E402
from mundlib.cite import is_bib_id  # noqa: E402
from mundlib.database import MASTER_DIR, MASTER_FORMATS, Database, fix_files  # noqa: E402


def cmd_validate(args) -> int:
    db = Database.load(args.root)
    issues = db.validate()
    for issue in issues:
        print(issue)
    errors = sum(1 for i in issues if i.level == "error")
    print("%d file(s), %d entries: %d error(s), %d warning(s)"
          % (len(db.files), sum(len(f.data) for f in db.files), errors, len(issues) - errors))
    return 1 if errors else 0


def cmd_fix(args) -> int:
    """Identifiers, canonical form and canonical file name of the given files (default: all)."""
    root = Path(args.root).resolve()
    changed = fix_files(root, [Path(p).resolve().relative_to(root).as_posix() for p in args.files] or None)
    for rel, target in changed:
        print("%s -> %s" % (rel, target) if target != rel else "fixed %s" % rel)
    print("%d file(s) changed" % len(changed))
    return 0


def cmd_id(args) -> int:
    if not is_bib_id(args.bib_id):
        raise ValueError("bibId must be DOI:<doi>, NSR:<keynumber> or muND:<name>, not %r" % args.bib_id)
    mid = ids.meta_id(args.sublibrary, args.code, args.bib_id, args.meta_key)
    print("MetaID  %s   <- %s" % (mid, ids.meta_source(args.sublibrary, args.code, args.bib_id, args.meta_key)))
    if args.element:
        did = ids.data_id(args.sublibrary, args.code, args.element, args.mass, mid, args.key)
        print("DataID  %s   <- %s" % (did, ids.data_source(args.sublibrary, args.code, args.element,
                                                             args.mass, mid, args.key)))
    return 0


def cmd_freeze(args) -> int:
    manifest = releases.freeze_release(Path(args.root), args.commit)
    print("froze %s (%s, commit %s) in %s/%s"
          % (manifest["label"], manifest["version"], manifest["commit"][:12], releases.RELEASES_DIR, manifest["label"]))
    return 0


def cmd_releases(args) -> int:
    failed = False
    root = Path(args.root)
    labels = releases.frozen_releases(root)
    for label in releases.tagged_major_releases(root):
        if label not in labels:
            print("error: missing frozen folder releases/%s" % label)
            failed = True
    for label in labels:
        report = releases.verify_release(root, label)
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
    versions = site.build_site(args.root, args.out)
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
    args.out = os.path.abspath(args.out)   # the build may move the folder a relative path names
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
    p.add_argument("bib_id", metavar="bibId", help="DOI:<DOI>, NSR:<keynumber> or muND:<name>")
    p.add_argument("--meta-key", default=None)
    p.add_argument("--element")
    p.add_argument("--mass", default="0")
    p.add_argument("--key", default=None)
    p.set_defaults(func=cmd_id)

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
    try:
        if args.command in ("fix", "releases"):
            master = Path(args.root) / MASTER_DIR
            if not any((master / name).is_file() for name in MASTER_FORMATS):
                raise ValueError("%s is not a muND database root (no master tables)" % args.root)
        return args.func(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
