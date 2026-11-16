#!/usr/bin/env python3
"""muND command line tool.

    python3 tools/mund.py validate          check every file under data/
    python3 tools/mund.py format            rewrite files in the canonical layout
    python3 tools/mund.py format --check    ... or only report files that would change
    python3 tools/mund.py ids FILE...       recompute the identifiers of dataset files
    python3 tools/mund.py id LT EXP 10.1103/PhysRevC.35.2212 [--element Si --mass 28]
    python3 tools/mund.py build             build the web site into _site/
    python3 tools/mund.py serve             build and serve it on http://localhost:8000

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

from mundlib import build as build_mod  # noqa: E402
from mundlib import ids, jsonfmt  # noqa: E402
from mundlib import schema as schema_mod  # noqa: E402
from mundlib.database import Database, assign_ids, dataset_path  # noqa: E402

DEFAULT_ROOT = HERE.parent


def cmd_validate(args) -> int:
    db = Database.load(args.root)
    issues = db.validate()
    errors = [i for i in issues if i.level == "error"]
    warnings = [i for i in issues if i.level == "warning"]
    for issue in issues:
        print(issue)
    points = sum(len(f.data) for f in db.files)
    print("%d file(s), %d data point(s): %d error(s), %d warning(s)"
          % (len(db.files), points, len(errors), len(warnings)))
    if errors or (args.strict and warnings):
        return 1
    return 0


def _canonical_text(db: Database, f) -> str:
    if f.obj is None:
        raise ValueError("%s: not valid JSON: %s" % (f.path, f.parse_error))
    fmt = f.obj.get("format") if isinstance(f.obj, dict) else None
    sch = db.schema_for(str(fmt))
    obj = schema_mod.normalize(f.obj, sch) if sch is not None else f.obj
    return jsonfmt.dumps(obj)


def cmd_format(args) -> int:
    db = Database.load(args.root)
    changed = 0
    for f in list(db.files) + list(db.master.values()):
        text = _canonical_text(db, f)
        if text != f.text:
            changed += 1
            print(("would reformat " if args.check else "reformatted ") + f.path)
            if not args.check:
                (Path(args.root) / f.path).write_text(text, encoding="utf-8")
    if not changed:
        print("all files are in canonical layout")
    return 1 if (args.check and changed) else 0


def cmd_ids(args) -> int:
    """Recompute identifiers and move files to their canonical name."""
    root = Path(args.root).resolve()
    db = Database(root)
    for name in args.files:
        path = Path(name).resolve()
        obj = jsonfmt.loads(path.read_text(encoding="utf-8"))
        assign_ids(obj)
        sch = db.schema_for(str(obj.get("format")))
        if sch is not None:
            obj = schema_mod.normalize(obj, sch)
        db.load_master()
        target = root / dataset_path(obj, db.reference(obj.get("meta", {}).get("bibId")))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(jsonfmt.dumps(obj), encoding="utf-8")
        if target != path:
            path.unlink()
        print("%s -> %s" % (name, target.relative_to(root).as_posix()))
    return 0


def cmd_id(args) -> int:
    mid = ids.meta_id(args.sublibrary, args.dataset, args.doi, args.meta_key)
    print("MetaID  %s   <- %s" % (mid, ids.meta_source(args.sublibrary, args.dataset, args.doi,
                                                         args.meta_key)))
    if args.element:
        did = ids.data_id(args.sublibrary, args.dataset, args.element, args.mass, mid, args.key)
        print("DataID  %s   <- %s" % (did, ids.data_source(args.sublibrary, args.dataset,
                                                             args.element, args.mass, mid, args.key)))
    return 0


def cmd_dist(args) -> int:
    manifest = build_mod.build_dist(args.root, args.out, args.label, args.version or None,
                                    args.commit or None, args.date or None, args.kind)
    print("built %s (%s) in %s" % (manifest["label"], manifest["version"], args.out))
    return 0


def cmd_build(args) -> int:
    versions = build_mod.build_site(args.root, args.out, releases=not args.no_releases)
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


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="muND database tools")
    parser.add_argument("--root", default=str(DEFAULT_ROOT), help="repository root")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("validate", help="check every file under data/")
    p.add_argument("--strict", action="store_true", help="treat warnings as errors")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("format", help="rewrite files in the canonical layout")
    p.add_argument("--check", action="store_true", help="only report, do not write")
    p.set_defaults(func=cmd_format)

    p = sub.add_parser("ids", help="recompute identifiers of dataset files")
    p.add_argument("files", nargs="+")
    p.set_defaults(func=cmd_ids)

    p = sub.add_parser("id", help="compute a MetaID (and a DataID)")
    p.add_argument("sublibrary")
    p.add_argument("dataset", choices=["EXP", "TH", "CUR", "EVAL"])
    p.add_argument("doi")
    p.add_argument("--meta-key", default=None)
    p.add_argument("--element")
    p.add_argument("--mass", default="0")
    p.add_argument("--key", default=None)
    p.set_defaults(func=cmd_id)

    p = sub.add_parser("dist", help="build the data files of one version")
    p.add_argument("--out", required=True)
    p.add_argument("--label", default="latest")
    p.add_argument("--version", default="")
    p.add_argument("--commit", default="")
    p.add_argument("--date", default="")
    p.add_argument("--kind", default="development")
    p.set_defaults(func=cmd_dist)

    for name, func, text in (("build", cmd_build, "build the web site"),
                             ("serve", cmd_serve, "build and serve the web site locally")):
        p = sub.add_parser(name, help=text)
        p.add_argument("--out", default=None, help="output directory (default: <root>/_site)")
        p.add_argument("--no-releases", action="store_true",
                       help="only build 'latest', skip released versions")
        if name == "serve":
            p.add_argument("--port", type=int, default=8000)
        p.set_defaults(func=func)

    args = parser.parse_args(argv)
    if getattr(args, "out", "x") is None:
        args.out = str(Path(args.root) / "_site")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
