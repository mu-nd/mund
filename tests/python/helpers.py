"""Shared set-up for the Python tests (run: python3 -m unittest discover -s tests/python)."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE = ROOT / "tests" / "fixtures"     # the test database: its content never changes with the real data
sys.path.insert(0, str(ROOT / "tools"))

# Settings for every git command the tests and the data entry tool run.  Git may start its automatic
# maintenance in the background after a commit (once there are 100 loose objects) and repack the
# objects while they are being cloned, so it is off; commits and tags are not signed.
GIT_SETTINGS = {"maintenance.auto": "false", "gc.auto": "0", "commit.gpgsign": "false", "tag.gpgsign": "false"}
os.environ["GIT_CONFIG_COUNT"] = str(len(GIT_SETTINGS))
for number, (key, value) in enumerate(GIT_SETTINGS.items()):
    os.environ.update({"GIT_CONFIG_KEY_%d" % number: key, "GIT_CONFIG_VALUE_%d" % number: value})

needs_git = unittest.skipIf(shutil.which("git") is None, "git is not available")


def vectors(name: str) -> dict:
    return json.loads((ROOT / "tests" / "vectors" / name).read_text(encoding="utf-8"))


def load_script(path: Path):
    """The Python file ``path`` as a module."""
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_repository(target: Path) -> Path:
    """A copy of this repository in ``target`` whose data/ is the test database."""
    for part in ("tools", "schema", "site", "docs"):
        shutil.copytree(ROOT / part, target / part, ignore=shutil.ignore_patterns("__pycache__"))
    for part in ("js", "vectors"):
        shutil.copytree(ROOT / "tests" / part, target / "tests" / part)
    shutil.copytree(FIXTURE / "data", target / "data")
    (target / "VERSION").write_text("0.0.1\n", encoding="utf-8")
    return target


def git(repo: Path, *args: str) -> str:
    """The output of ``git -C repo ARGS``."""
    return subprocess.run(["git", "-C", str(repo)] + list(args), check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()


def set_user(repo: Path, name: str) -> None:
    git(repo, "config", "user.name", name)
    git(repo, "config", "user.email", "%s@example.invalid" % name.lower())


def commit_all(repo: Path, user: str, message: str) -> Path:
    """Make ``repo`` a git repository on main in which ``user`` commits all its files."""
    git(repo, "init", "-q", "-b", "main")
    set_user(repo, user)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)
    return repo


def remote_and_clones(base: Path, *users: str):
    """A stand-in for GitHub (a bare repository of make_repository) and one copy of it per user:
    (the bare repository, [the copies in the order of ``users``])."""
    github = base / "github.git"
    git(base, "clone", "-q", "--bare", str(commit_all(make_repository(base / "seed"), "Seed", "initial")), str(github))
    clones = []
    for user in users:
        clone = base / user.lower()
        git(base, "clone", "-q", str(github), str(clone))
        set_user(clone, user)
        clones.append(clone)
    return github, clones
