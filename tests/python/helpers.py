"""Shared set-up for the Python tests (run: python3 -m unittest discover -s tests/python)."""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE = ROOT / "tests" / "fixtures"     # the test database: its content never changes with the real data
sys.path.insert(0, str(ROOT / "tools"))


def vectors(name: str) -> dict:
    return json.loads((ROOT / "tests" / "vectors" / name).read_text(encoding="utf-8"))


def make_repository(target: Path) -> Path:
    """A copy of this repository in ``target`` whose data/ is the test database."""
    for part in ("tools", "schema", "site", "docs"):
        shutil.copytree(ROOT / part, target / part, ignore=shutil.ignore_patterns("__pycache__"))
    for part in ("js", "vectors"):
        shutil.copytree(ROOT / "tests" / part, target / "tests" / part)
    shutil.copytree(FIXTURE / "data", target / "data")
    (target / "VERSION").write_text("0.0.1\n", encoding="utf-8")
    return target
