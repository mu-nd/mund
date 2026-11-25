"""The frozen releases.

A released major version (``v1``, ``v2`` ..., git tags ``v1.0.0``, ``v2.0.0``)
is built once, when it is released (:func:`freeze_release`), and stored in
``releases/<label>/`` with a manifest of SHA-256 hashes; the site publishes
those files as they are after checking them (:func:`verify_release`).
"""
from __future__ import annotations

import io
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import List, Optional

from .build import SOURCE_PATTERNS, _git, _sha256, build_dist, read_version

RELEASES_DIR = "releases"
MAJOR_VERSION_RE = re.compile(r"^(\d+)\.0\.0$")


def source_hashes(root: Path) -> dict:
    """SHA-256 of every file a version is made from, by path."""
    root = Path(root)
    paths = {p.relative_to(root).as_posix() for pattern in SOURCE_PATTERNS for p in root.glob(pattern) if p.is_file()}
    return {rel: _sha256((root / rel).read_bytes()) for rel in sorted(paths)}


def release_label(version: str) -> Optional[str]:
    """``v1`` for ``1.0.0``; None for a version that is not published on its own (minor, patch)."""
    m = MAJOR_VERSION_RE.match(version)
    return "v%d" % int(m.group(1)) if m else None


def frozen_releases(root: Path) -> List[str]:
    """Labels of the frozen releases stored in the repository (``v1``, ``v2`` ...), oldest first."""
    found = [p.name for p in (Path(root) / RELEASES_DIR).glob("v*") if p.is_dir() and re.match(r"^v\d+$", p.name)]
    return sorted(found, key=lambda name: int(name[1:]))


def tagged_major_releases(root: Path) -> List[str]:
    """Major release labels tagged in the history of this checkout."""
    tags = _git(root, "tag", "--merged", "HEAD", "--list", "v*.0.0") or ""
    return [label for tag in tags.splitlines() if (label := release_label(tag[1:]))]


def _extract_commit(root: Path, commit: str, folder: str) -> None:
    archive = subprocess.run(["git", "-C", str(root), "archive", "--format=zip", commit],
                             check=True, stdout=subprocess.PIPE).stdout
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        zf.extractall(folder)


def freeze_release(root: Path, commit: str) -> dict:
    """Build the files of the major release made by ``commit`` once, into releases/vN/.

    The data, schemas and VERSION are taken from ``commit`` (not from the working
    tree); the manifest records that commit, the SHA-256 of every source file of
    it and of every file produced.  A frozen release is published as it is and
    never built again.
    """
    root = Path(root)
    commit = _git(root, "rev-parse", "--verify", "%s^{commit}" % commit)
    if not commit:
        raise ValueError("unknown commit")
    with tempfile.TemporaryDirectory() as tmp:
        _extract_commit(root, commit, tmp)
        version = read_version(Path(tmp))
        label = release_label(version)
        if label is None:
            raise ValueError("only major versions (N.0.0) are frozen; VERSION of %s is %s" % (commit[:12], version))
        out = root / RELEASES_DIR / label
        if out.exists():
            raise ValueError("%s is frozen already" % out.relative_to(root).as_posix())
        info = {"version": version, "commit": commit, "date": _git(root, "log", "-1", "--format=%cI", commit),
                "kind": "release", "sources": source_hashes(Path(tmp))}
        out.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=out.parent) as staging:
            folder = Path(staging) / label
            manifest = build_dist(Path(tmp), folder, label, info)
            folder.rename(out)
            return manifest


def _relative_path(name) -> bool:
    return (isinstance(name, str) and not any(c in name for c in ("\\", ":", "\0"))
            and all(part and not part.endswith((".", " ")) for part in name.split("/")))


def verify_release(root: Path, label: str) -> dict:
    """Check a frozen release: its files against its manifest and, where the
    history is available, its sources against its commit and its tag.
    Files git ignores (such as .DS_Store) are not part of the release.

    Returns {"errors": [...], "warnings": [...]}.
    """
    root = Path(root)
    folder = root / RELEASES_DIR / label
    errors, warnings = [], []
    manifest_path = folder / "manifest.json"
    if (not re.fullmatch(r"v[0-9]+", label) or folder.parent.is_symlink()
            or folder.is_symlink() or manifest_path.is_symlink()):
        return {"errors": ["%s: invalid release path" % label], "warnings": []}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return {"errors": ["%s: no readable manifest.json (%s)" % (label, exc)], "warnings": []}
    if not isinstance(manifest, dict):
        return {"errors": ["%s: manifest must be an object" % label], "warnings": []}
    version = manifest.get("version")
    if (manifest.get("format") != "muND/manifest/1" or manifest.get("label") != label
            or manifest.get("kind") != "release" or not isinstance(version, str) or release_label(version) != label):
        errors.append("%s: invalid release manifest header" % label)
    for key, kind in (("date", str), ("sublibraries", dict), ("files", list), ("sources", dict)):
        if not isinstance(manifest.get(key), kind) or not manifest[key]:
            errors.append("%s: missing or invalid %s" % (label, key))

    archive = manifest.get("archive")
    if not isinstance(archive, dict) or archive.get("path") != "mund-%s.zip" % label:
        errors.append("%s: missing or invalid archive" % label)
    files = manifest.get("files")
    listed = {}
    for record in (files if isinstance(files, list) else []) + [archive]:
        rel = record.get("path") if isinstance(record, dict) else None
        if not _relative_path(rel) or rel in listed or rel == "manifest.json":
            errors.append("%s: invalid or duplicate file path %r" % (label, rel))
            continue
        listed[rel] = record
    for rel in ("master.json", "LT.json", "csv/LT.csv"):
        if rel not in listed:
            errors.append("%s: %s is required" % (label, rel))

    present = set()
    for path in folder.rglob("*"):
        if path.is_symlink():
            errors.append("%s: invalid symlink path %s" % (label, path.relative_to(folder)))
        elif path.is_file() and path != manifest_path:
            present.add(path.relative_to(folder).as_posix())
    prefix = "%s/%s/" % (RELEASES_DIR, label)
    ignored = _git(root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", prefix) or ""
    present -= {p[len(prefix):] for p in ignored.split("\0") if p.startswith(prefix)}
    for rel in sorted(present - set(listed)):
        errors.append("%s: %s is not listed in the manifest" % (label, rel))
    for rel, record in sorted(listed.items()):
        if rel not in present:
            errors.append("%s: %s is missing" % (label, rel))
            continue
        data = (folder / rel).read_bytes()
        if type(record.get("bytes")) is not int or len(data) != record["bytes"]:
            errors.append("%s: %s size differs from the manifest" % (label, rel))
        if _sha256(data) != record.get("sha256"):
            errors.append("%s: %s differs from the manifest" % (label, rel))

    sources = manifest.get("sources")
    if isinstance(sources, dict):
        for rel, digest in sources.items():
            if not _relative_path(rel) or not isinstance(digest, str) or not re.fullmatch("[0-9a-f]{64}", digest):
                errors.append("%s: invalid source record %r" % (label, rel))
    commit = manifest.get("commit")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", commit):
        errors.append("%s: missing or invalid release commit" % label)
        commit = ""
    elif _git(root, "rev-parse", "--verify", "--quiet", "%s^{commit}" % commit) != commit:
        warnings.append("%s: commit %s is not in this repository's history" % (label, commit[:12]))
    elif isinstance(sources, dict):
        with tempfile.TemporaryDirectory() as tmp:
            _extract_commit(root, commit, tmp)
            expected = source_hashes(Path(tmp))
        for rel in sorted(expected.keys() | sources.keys()):
            if rel not in expected or sources.get(rel) != expected[rel]:
                errors.append("%s: source %s differs from commit %s" % (label, rel, commit[:12]))

    history = _git(root, "log", "--format=%H", "--", prefix)
    if history is not None:
        changes = history.split()
        if not changes:
            errors.append("%s: frozen folder has no introducing commit" % label)
        elif len(changes) > 1:
            errors.append("%s: changed after it was frozen (%d commits touch it)" % (label, len(changes)))
        if _git(root, "status", "--porcelain", "--", prefix + "manifest.json"):
            errors.append("%s: frozen manifest has uncommitted changes" % label)
    tagged = None
    if isinstance(version, str) and release_label(version) == label:
        tagged = _git(root, "rev-parse", "--verify", "--quiet", "refs/tags/v%s^{commit}" % version)
    if not tagged:
        warnings.append("%s: tag v%s is missing (it belongs on commit %s)" % (label, version, commit[:12]))
    elif tagged != commit:
        errors.append("%s: tag v%s is on %s, not on the release commit %s" % (label, version, tagged[:12], commit[:12]))
    return {"errors": errors, "warnings": warnings}
