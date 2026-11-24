"""Candidate discovery does bounded state IO without caching consent or opaque IDs."""
import multiprocessing
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agentrun_cli.adapters import candidates
from agentrun_cli.state import State


def rows(start, end):
    return [{'id': f'native-{n}', 'cwd': f'/fixture/project-{n % 3}', 'status': {'type': 'idle'}}
            for n in range(start, end)]


def concurrent_candidates(directory, barrier, results, start, end):
    state = State(directory)
    barrier.wait()
    found = candidates(state, 'codex', rows(start, end))
    results.put({row.native_id: (row.id, row.project_id) for row in found})


class CandidateBatchTests(unittest.TestCase):
    def test_known_candidates_read_state_once_without_writing_or_refreshing_consent(self):
        for observing in (False, True):
            with self.subTest(observing=observing), tempfile.TemporaryDirectory() as directory:
                state = State(directory)
                original = candidates(state, 'codex', rows(0, 100))
                state.data.update(observing=True, credential='old-credential', selections_revision=1)
                state.save()
                newer = State(directory)
                newer.complete_connection({'observing': False, 'credential': 'new-credential', 'selections_revision': 2})
                epoch = state.heartbeat_epoch()
                selected = [{'harness': 'codex', 'mode': 'harness', 'include_future_sessions': True}] if observing else None
                with patch.object(state, '_read', wraps=state._read) as read, patch.object(state, '_save', wraps=state._save) as save:
                    found = candidates(state, 'codex', rows(0, 100), selections=selected)
                self.assertEqual([(row.id, row.project_id) for row in found], [(row.id, row.project_id) for row in original])
                self.assertEqual(read.call_count, 1, 'one candidate pass must not reparse the entire map per session')
                self.assertEqual(save.call_count, 0, 'known IDs do not need a durable write')
                self.assertEqual(state.heartbeat_epoch(), epoch, 'reading canonical IDs is not new observation consent')
                action_called = []
                self.assertFalse(state.apply_connection_epoch(epoch, lambda latest: action_called.append(True)))
                self.assertEqual(action_called, [])
                self.assertEqual(state.data['credential'], 'new-credential')
                self.assertFalse(state.data['observing'])

    def test_new_candidates_are_persisted_together_before_their_ids_are_returned(self):
        with tempfile.TemporaryDirectory() as directory:
            state = State(directory)
            with patch.object(state, '_read', wraps=state._read) as read, patch.object(state, '_save', wraps=state._save) as save:
                found = candidates(state, 'codex', rows(0, 100))
            self.assertEqual(read.call_count, 1)
            self.assertEqual(save.call_count, 1, 'new sessions and projects should share one atomic durable publication')
            persisted = State(directory).data
            self.assertEqual(len(found), 100)
            for row in found:
                self.assertEqual(persisted['identities']['codex:' + row.native_id], row.id)
                self.assertIn(row.project_id, persisted['projects'].values())

    def test_concurrent_candidate_passes_share_ids_and_preserve_each_others_new_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = multiprocessing.get_context('fork')
            barrier, results = ctx.Barrier(2), ctx.Queue()
            processes = [ctx.Process(target=concurrent_candidates, args=(directory, barrier, results, start, end))
                         for start, end in [(0, 100), (50, 150)]]
            for process in processes:
                process.start()
            try:
                first, second = [results.get(timeout=5) for _ in processes]
                for native in first.keys() & second.keys():
                    self.assertEqual(first[native], second[native])
                saved = State(directory).data
                self.assertEqual(len(saved['identities']), 150)
                self.assertEqual(len(saved['projects']), 3)
                for native, (identity, project) in {**first, **second}.items():
                    self.assertEqual(saved['identities']['codex:' + native], identity)
                    self.assertIn(project, saved['projects'].values())
            finally:
                for process in processes:
                    process.join(timeout=5)
                    if process.is_alive():
                        process.kill(); process.join()
                results.close(); results.join_thread()

    def test_capacity_preserves_known_candidates_and_only_allocates_available_slots(self):
        with tempfile.TemporaryDirectory() as directory:
            state = State(directory)
            state.data['identities'] = {f'codex:native-{n}': f'opaque-{n}' for n in range(4095)}
            state._save()
            diagnostic = {}
            found = candidates(state, 'codex', rows(4094, 4097), diagnostic=diagnostic)
            self.assertEqual([row.native_id for row in found], ['native-4094', 'native-4095'])
            self.assertEqual(found[0].id, 'opaque-4094')
            self.assertEqual(diagnostic, {'status': 'partial', 'reason': 'candidate_limit'})
            self.assertEqual(len(State(directory).data['identities']), 4096)

    def test_known_candidates_still_validate_current_config_permissions_and_symlinks(self):
        for unsafe in ('permissions', 'symlink'):
            with self.subTest(unsafe=unsafe), tempfile.TemporaryDirectory() as directory:
                state = State(directory)
                candidates(state, 'codex', rows(0, 2))
                original = state.path.read_bytes()
                if unsafe == 'permissions':
                    state.path.chmod(0o644)
                else:
                    target = Path(directory) / 'original.json'
                    state.path.rename(target)
                    state.path.symlink_to(target)
                with self.assertRaises((ValueError, OSError)):
                    candidates(state, 'codex', rows(0, 2))
                self.assertEqual(state.path.read_bytes(), original)
                if unsafe == 'symlink':
                    self.assertTrue(state.path.is_symlink())
