"""Durable observation sequence allocation survives destination and transaction boundaries."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
from types import SimpleNamespace
import unittest

from agentrun_cli.queue import Queue

MAX_WIRE_SEQUENCE = (1 << 53) - 1

def candidate(name='session', activity='working'):
    return SimpleNamespace(id=name, activity=activity, harness='claude')


class SequenceCheckpoints(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def test_returning_destination_advances_sequence_without_retaining_its_payloads(self):
        q = Queue(self.directory, binding='A', refresh_seconds=0)
        q.observe('source', candidate()); first = q.batch()[0]
        q.acknowledge([first['event_id']]); q.observe('source', candidate(activity='idle'))
        stale = q.batch()[0]; q.clear_pending(); q.close()
        q = Queue(self.directory, binding='B', refresh_seconds=0)
        self.assertEqual(q.batch(), [])
        q.observe('source', candidate()); middle = q.batch()[0]; q.close()
        q = Queue(self.directory, binding='A', refresh_seconds=0)
        self.addCleanup(q.close)
        self.assertEqual(q.batch(), [], 'neither destination receives another destination\'s backlog')
        q.observe('source', candidate(activity='waiting_input')); returned = q.batch()[0]
        self.assertGreater(returned['sequence'], stale['sequence'], 'the retained A receiver must accept the first return update')
        self.assertGreater(returned['sequence'], middle['sequence'])
        self.assertNotIn(returned['event_id'], [first['event_id'], stale['event_id'], middle['event_id']])

    def test_legacy_maximum_is_seeded_before_destination_purge_and_survives_restart(self):
        db = sqlite3.connect(self.directory / 'queue.sqlite3')
        db.executescript("CREATE TABLE observations(session TEXT PRIMARY KEY, activity TEXT NOT NULL, sequence INTEGER NOT NULL); INSERT INTO observations VALUES('old-one','working',17),('old-two','idle',5);")
        db.close()
        q = Queue(self.directory, binding='new', refresh_seconds=0)
        q.observe('source', candidate()); event = q.batch()[0]
        self.assertEqual(event['sequence'], 18)
        q.acknowledge([event['event_id']]); q.close()
        q = Queue(self.directory, binding='new', refresh_seconds=0)
        self.addCleanup(q.close); q.observe('source', candidate(activity='idle'))
        self.assertEqual(q.batch()[0]['sequence'], 19)

    def test_failed_event_write_rolls_back_checkpoint_and_observation_together(self):
        q = Queue(self.directory, binding='A', refresh_seconds=0)
        self.addCleanup(q.close); q.observe('source', candidate())
        q.acknowledge([q.batch()[0]['event_id']])
        q.db.execute("CREATE TEMP TRIGGER stop_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'fixture write failed'); END")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'fixture write failed'):
            q.observe('source', candidate(activity='idle'))
        self.assertEqual(q.batch(), [])
        self.assertEqual(q.db.execute('SELECT activity,sequence FROM observations').fetchone(), ('working', 1))
        q.db.execute('DROP TRIGGER stop_event'); q.observe('source', candidate(activity='idle'))
        self.assertEqual(q.batch()[0]['sequence'], 2)

    def test_existing_checkpoint_never_rewinds_and_known_legacy_rows_can_advance_it(self):
        q = Queue(self.directory, binding='A', refresh_seconds=0)
        q.observe('source', candidate()); q.clear_pending()
        q.db.execute("INSERT OR REPLACE INTO counters VALUES('sequence',100)")
        q.db.execute("UPDATE observations SET sequence=150"); q.db.commit(); q.close()
        q = Queue(self.directory, binding='B', refresh_seconds=0)
        self.addCleanup(q.close); q.observe('source', candidate())
        self.assertEqual(q.batch()[0]['sequence'], 151)

    def test_concurrent_writers_allocate_distinct_durable_sequences(self):
        Queue(self.directory, binding='A').close()
        barrier = threading.Barrier(4)
        def write(index):
            q = Queue(self.directory, binding='A')
            try:
                barrier.wait(timeout=5); q.observe('source', candidate('session-' + str(index)))
            finally: q.close()
        with ThreadPoolExecutor(max_workers=4) as pool: list(pool.map(write, range(4)))
        q = Queue(self.directory, binding='A'); self.addCleanup(q.close)
        self.assertEqual(sorted(event['sequence'] for event in q.batch()), [1, 2, 3, 4])

    def test_exhausted_wire_sequence_refuses_instead_of_rewinding(self):
        q = Queue(self.directory, binding='A'); self.addCleanup(q.close)
        q.db.execute("INSERT OR REPLACE INTO counters VALUES('sequence',?)", (MAX_WIRE_SEQUENCE,)); q.db.commit()
        with self.assertRaisesRegex(ValueError, 'observation_sequence_exhausted'):
            q.observe('source', candidate())
        self.assertEqual(q.batch(), [])

    def test_corrupt_checkpoint_refuses_rebind_without_discarding_pending_data(self):
        for index, value in enumerate([-1, 1.5, 'corrupt', MAX_WIRE_SEQUENCE + 1]):
            with self.subTest(value=value):
                directory = self.directory / str(index); directory.mkdir()
                q = Queue(directory, binding='A'); q.observe('source', candidate()); q.close()
                db = sqlite3.connect(directory / 'queue.sqlite3')
                db.execute("INSERT OR REPLACE INTO counters VALUES('sequence',?)", (value,)); db.commit()
                before = (db.execute('SELECT * FROM events').fetchall(), db.execute('SELECT * FROM observations').fetchall(), db.execute('SELECT * FROM settings').fetchall()); db.close()
                opened = None
                try:
                    with self.assertRaisesRegex(ValueError, 'invalid_observation_checkpoint'):
                        opened = Queue(directory, binding='B')
                finally:
                    if opened: opened.close()
                db = sqlite3.connect(directory / 'queue.sqlite3')
                try:
                    self.assertEqual((db.execute('SELECT * FROM events').fetchall(), db.execute('SELECT * FROM observations').fetchall(), db.execute('SELECT * FROM settings').fetchall()), before)
                finally: db.close()

    def test_last_safe_integer_is_delivered_then_exhaustion_preserves_pending_event(self):
        q = Queue(self.directory, binding='A', refresh_seconds=0); self.addCleanup(q.close)
        q.db.execute("INSERT OR REPLACE INTO counters VALUES('sequence',?)", (MAX_WIRE_SEQUENCE - 1,)); q.db.commit()
        q.observe('source', candidate()); event = q.batch()[0]
        self.assertEqual(event['sequence'], MAX_WIRE_SEQUENCE)
        with self.assertRaisesRegex(ValueError, 'observation_sequence_exhausted'):
            q.observe('source', candidate(activity='idle'))
        self.assertEqual(q.batch(), [event])
