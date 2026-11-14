"""Minimal PEP 517 builder for a pure-Python, distribution with declared runtime dependencies."""

import base64
import csv
import hashlib
import io
from pathlib import Path
import tarfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def _project():
    return tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]


def _metadata():
    project = _project()
    metadata = f"Metadata-Version: 2.4\nName: {project['name']}\nVersion: {project['version']}\nSummary: {project['description']}\nRequires-Python: {project['requires-python']}\nLicense-Expression: Apache-2.0\nLicense-File: LICENSE\nLicense-File: NOTICE\n"
    metadata += "".join(f"Requires-Dist: {dependency}\n" for dependency in project.get("dependencies", []))
    for extra, dependencies in project.get("optional-dependencies", {}).items():
        metadata += f"Provides-Extra: {extra}\n"
        metadata += "".join(f"Requires-Dist: {dependency}; extra == '{extra}'\n" for dependency in dependencies)
    result = {
        "METADATA": metadata + "\n",
        "WHEEL": "Wheel-Version: 1.0\nGenerator: agentrun-stdlib\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        "licenses/LICENSE": (ROOT / "LICENSE").read_text(),
        "licenses/NOTICE": (ROOT / "NOTICE").read_text(),
        "PROVENANCE.md": (ROOT / "PROVENANCE.md").read_text(),
    }
    if project.get("scripts"):
        result["entry_points.txt"] = "[console_scripts]\n" + "".join(
            f"{name} = {value}\n" for name, value in project["scripts"].items()
        )
    return result


def get_requires_for_build_wheel(config_settings=None):
    return []


def get_requires_for_build_sdist(config_settings=None):
    return []


def prepare_metadata_for_build_wheel(metadata_directory, config_settings=None):
    project = _project()
    name = project["name"].replace("-", "_") + "-" + project["version"] + ".dist-info"
    destination = Path(metadata_directory) / name
    destination.mkdir(parents=True, exist_ok=True)
    for path, content in _metadata().items():
        (destination / path).parent.mkdir(parents=True, exist_ok=True)
        (destination / path).write_text(content)
    return name


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    project = _project()
    identity = project["name"].replace("-", "_") + "-" + project["version"]
    name = identity + "-py3-none-any.whl"
    Path(wheel_directory).mkdir(parents=True, exist_ok=True)
    files = {str(path.relative_to(ROOT / "src")): path.read_bytes() for path in sorted((ROOT / "src").rglob("*.py"))}
    files.update({identity + ".dist-info/" + path: content.encode() for path, content in _metadata().items()})
    rows = [
        (path, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("="), str(len(data)))
        for path, data in files.items()
    ]
    record = identity + ".dist-info/RECORD"
    stream = io.StringIO(newline="")
    csv.writer(stream).writerows([*rows, (record, "", "")])
    files[record] = stream.getvalue().encode()
    with zipfile.ZipFile(Path(wheel_directory) / name, "w", zipfile.ZIP_DEFLATED) as wheel:
        for path, data in files.items():
            wheel.writestr(path, data)
    return name


def build_sdist(sdist_directory, config_settings=None):
    project = _project()
    identity = project["name"] + "-" + project["version"]
    name = identity + ".tar.gz"
    Path(sdist_directory).mkdir(parents=True, exist_ok=True)
    with tarfile.open(Path(sdist_directory) / name, "w:gz") as archive:
        for path in sorted(ROOT.rglob("*")):
            relative = path.relative_to(ROOT)
            root_file = str(relative) in {"pyproject.toml", "README.md", "LICENSE", "NOTICE", "PROVENANCE.md"}
            source_file = relative.parts[0] in {"src", "build_support", "tests"} and relative.suffix == ".py" and not any(part.startswith(".") or part == "__pycache__" for part in relative.parts)
            if path.is_file() and not path.is_symlink() and (root_file or source_file):
                archive.add(path, arcname=str(Path(identity) / relative), recursive=False)
    return name
