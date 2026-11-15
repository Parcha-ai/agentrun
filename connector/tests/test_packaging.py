"""The installable CLI carries notices and never packages source-machine state."""
import importlib.util
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
import zipfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('agentrun_build_backend',ROOT/'build_support/backend.py')
backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend)

class Packaging(unittest.TestCase):
    def test_wheel_carries_license_notice_provenance_and_remote_entrypoint(self):
        with tempfile.TemporaryDirectory() as temp:
            name=backend.build_wheel(temp)
            with zipfile.ZipFile(Path(temp)/name) as wheel:
                prefix='agentrun_cli-0.1.11.dev0.dist-info/'
                self.assertIn('Apache License',wheel.read(prefix+'licenses/LICENSE').decode())
                self.assertIn('Parcha',wheel.read(prefix+'licenses/NOTICE').decode())
                self.assertIn('0.1.10',wheel.read(prefix+'PROVENANCE.md').decode())
                self.assertIn('agentrun = agentrun_cli.cli:main',wheel.read(prefix+'entry_points.txt').decode())
                self.assertIn('agentrun_cli/remote.py',wheel.namelist())
                self.assertFalse(any('/tests/' in item or '__pycache__' in item for item in wheel.namelist()))
    def test_sdist_excludes_private_states_venv_and_arbitrary_root_files(self):
        original=backend.ROOT
        with tempfile.TemporaryDirectory() as temp:
            source=Path(temp)/'source';shutil.copytree(ROOT,source,ignore=shutil.ignore_patterns('__pycache__'))
            for path in ('.agentrun/config.json','.venv/private.py','source-state/private.py','src/.hidden/private.py','private.json'):
                candidate=source/path;candidate.parent.mkdir(parents=True,exist_ok=True);candidate.write_text('synthetic-private-fixture')
            backend.ROOT=source
            try:
                name=backend.build_sdist(str(Path(temp)/'out'))
                with tarfile.open(Path(temp)/'out'/name) as archive:
                    names=archive.getnames()
                    self.assertTrue(any(item.endswith('/src/agentrun_cli/remote.py') for item in names))
                    self.assertFalse(any('private' in item or '.venv/' in item or '.agentrun/' in item for item in names))
            finally:backend.ROOT=original
