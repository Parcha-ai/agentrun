"""Atomic metadata observation checkpoints and bounded durable delivery."""

from datetime import datetime, timezone
import json
import os
import sqlite3
import time
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from .codex_usage import read_usage
from .session_labels import label


MAX_SEQUENCE = (1 << 53) - 1  # The receiver accepts JSON safe integers.
MAX_BATCH_BYTES = 60_000  # Leave room for the request envelope below the receiver's 64 KiB limit.


def checkpoint(value):
    if type(value) is not int or not 0 <= value <= MAX_SEQUENCE:
        raise ValueError("invalid_observation_checkpoint")
    return value


Activity = Literal["unknown", "working", "idle", "waiting_input", "finished", "failed", "stopped"]


class Metadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    activity: Activity
    harness: Literal["claude", "codex"]
    display_name: str | None = None
    project_name: str | None = None
    cli_learning: dict | None = None


class Event(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str
    source_id: str
    external_session_id: str
    sequence: int = Field(gt=0, le=MAX_SEQUENCE)
    type: Literal["session_observed"] = "session_observed"
    occurred_at: str
    metadata: Metadata
    usage: dict | None = None


class Queue:
    def __init__(self, directory, max_events=1000, max_bytes=1_000_000, refresh_seconds=60, binding=None):
        self.max_events, self.max_bytes, self.refresh_seconds = max_events, max_bytes, refresh_seconds
        path = directory / "queue.sqlite3"
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        path.chmod(0o600)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS observations (session TEXT PRIMARY KEY, activity TEXT NOT NULL, sequence INTEGER NOT NULL, observed_at REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS usage_checkpoints (session TEXT PRIMARY KEY, source TEXT NOT NULL, state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS metadata_labels (session TEXT PRIMARY KEY, labels TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT OR IGNORE INTO counters VALUES ('dropped', 0);
        """)
        if "observed_at" not in {row[1] for row in self.db.execute("PRAGMA table_info(observations)")}:
            self.db.execute("ALTER TABLE observations ADD COLUMN observed_at REAL NOT NULL DEFAULT 0")
        try:
            with self.db:
                # Take the SQLite writer lock before reading either watermark. Seed from
                # legacy session rows before a destination rebind may remove them.
                self.db.execute("INSERT OR IGNORE INTO counters VALUES ('sequence',0)")
                legacy = checkpoint(self.db.execute("SELECT coalesce(max(sequence),0) FROM observations").fetchone()[0])
                current = checkpoint(self.db.execute("SELECT value FROM counters WHERE name='sequence'").fetchone()[0])
                self.db.execute("UPDATE counters SET value=? WHERE name='sequence'", (max(current, legacy),))
                if binding is not None:
                    previous = self.db.execute("SELECT value FROM settings WHERE name='destination'").fetchone()
                    if previous is None or previous[0] != binding:
                        self.db.execute("DELETE FROM events")
                        self.db.execute("DELETE FROM observations")
                        self.db.execute("DELETE FROM usage_checkpoints")
                        self.db.execute("DELETE FROM metadata_labels")
                        self.db.execute("UPDATE counters SET value=0 WHERE name='dropped'")
                        self.db.execute("INSERT OR REPLACE INTO settings VALUES ('destination',?)", (binding,))
        except BaseException:
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def _enqueue(self, source_id, candidate, occurred_at, usage=None, labels=None, cli_learning=None, connector_id=None):
        allocated = self.db.execute("UPDATE counters SET value=value+1 WHERE name='sequence' AND typeof(value)='integer' AND value>=0 AND value<?", (MAX_SEQUENCE,))
        if allocated.rowcount != 1:
            held = self.db.execute("SELECT value FROM counters WHERE name='sequence'").fetchone()
            if held is None or checkpoint(held[0]) != MAX_SEQUENCE:
                raise ValueError("invalid_observation_checkpoint")
            raise ValueError("observation_sequence_exhausted")
        sequence = self.db.execute("SELECT value FROM counters WHERE name='sequence'").fetchone()[0]
        event = Event(event_id=str(uuid4()), source_id=source_id, external_session_id=candidate.id,
                      sequence=sequence, occurred_at=occurred_at,
                      metadata=Metadata(activity=candidate.activity, harness=candidate.harness, **(labels or {}),
                                        cli_learning=cli_learning.metadata(connector_id, source_id, candidate.id, sequence) if cli_learning else None), usage=usage)
        self.db.execute("INSERT INTO events VALUES (?,?,?)", (event.event_id, source_id, event.model_dump_json(exclude_none=True)))
        return sequence

    def observe(self, source_id, candidate, collect_usage=False, collect_labels=False, cli_learning=None, connector_id=None):
        labels = {}
        if collect_labels:
            for field in ('display_name', 'project_name'):
                value = label(getattr(candidate, field, None), project=field == 'project_name')
                if value is not None:
                    labels[field] = value
        signature_fields = {**labels, **({'cli_learning': cli_learning.signature()} if cli_learning else {})}
        signature = json.dumps(signature_fields, sort_keys=True) if signature_fields else ''
        with self.db:
            # Acquire the writer lock before reading counters or native checkpoints.
            # A crash cannot commit a cursor while losing its queued usage deltas.
            self.db.execute("UPDATE counters SET value=value WHERE name='sequence'")
            usage_events = []
            if collect_usage and candidate.harness == 'codex':
                saved = self.db.execute("SELECT state FROM usage_checkpoints WHERE session=?", (candidate.id,)).fetchone()
                state, usage_events = read_usage(candidate, json.loads(saved[0]) if saved else None)
                if state is not None:
                    self.db.execute("INSERT OR REPLACE INTO usage_checkpoints VALUES (?,?,?)", (candidate.id, source_id, json.dumps(state)))
                # Coalesce increments within each actual UTC day/model. Source dates
                # remain truthful without flooding the receiver after a busy interval.
                grouped = {}
                for event in usage_events:
                    day = datetime.fromisoformat(event['occurred_at'].replace('Z', '+00:00')).astimezone(timezone.utc).date().isoformat()
                    usage = event['usage']; key = (day, usage['model'], tuple(sorted(usage)))
                    if key not in grouped:
                        grouped[key] = {'occurred_at': event['occurred_at'], 'usage': dict(usage)}
                    else:
                        grouped[key]['occurred_at'] = event['occurred_at']
                        for counter in usage.keys() - {'model'}:
                            grouped[key]['usage'][counter] += usage[counter]
                for event in grouped.values():
                    if event['usage']['input_tokens'] + event['usage']['output_tokens'] > MAX_SEQUENCE:
                        self.db.execute("UPDATE counters SET value=value+1 WHERE name='dropped'")
                        continue
                    self._enqueue(source_id, candidate, event['occurred_at'], event['usage'], labels, cli_learning, connector_id)
            now = time.time()
            previous = self.db.execute("SELECT activity, sequence, observed_at FROM observations WHERE session=?", (candidate.id,)).fetchone()
            previous_labels = self.db.execute("SELECT labels FROM metadata_labels WHERE session=?", (candidate.id,)).fetchone()
            if not usage_events and previous and previous[0] == candidate.activity and (previous_labels[0] if previous_labels else '') == signature and now - previous[2] < self.refresh_seconds:
                return
            sequence = self._enqueue(source_id, candidate, datetime.now(timezone.utc).isoformat(), labels=labels,
                                     cli_learning=cli_learning, connector_id=connector_id)
            self.db.execute("INSERT OR REPLACE INTO observations VALUES (?,?,?,?)", (candidate.id, candidate.activity, sequence, now))
            self.db.execute("INSERT OR REPLACE INTO metadata_labels VALUES (?,?)", (candidate.id, signature))
            while True:
                count, size = self.db.execute("SELECT count(*), coalesce(sum(length(CAST(payload AS BLOB))),0) FROM events").fetchone()
                if count <= self.max_events and size <= self.max_bytes:
                    break
                self.db.execute("DELETE FROM events WHERE rowid=(SELECT min(rowid) FROM events)")
                self.db.execute("UPDATE counters SET value=value+1 WHERE name='dropped'")

    def batch(self):
        events, size = [], 2
        for row in self.db.execute("SELECT payload FROM events ORDER BY rowid LIMIT 50"):
            event = json.loads(row[0])
            # network.request uses json.dumps with ASCII escaping, so count that
            # representation rather than characters or the UTF-8 SQLite payload.
            event_size = len(json.dumps(event).encode('utf-8')) + (2 if events else 0)
            if size + event_size > MAX_BATCH_BYTES:
                break
            events.append(event)
            size += event_size
        return events

    def acknowledge(self, identifiers):
        with self.db:
            self.db.executemany("DELETE FROM events WHERE id=?", [(identifier,) for identifier in identifiers])

    def retain_sources(self, sources):
        with self.db:
            # Serialize with observation writes before reading the rows to remove. Consent
            # pruning never rewinds the durable global sequence checkpoint.
            self.db.execute("UPDATE counters SET value=value WHERE name='sequence'")
            removed_usage = [(session,) for session, source in self.db.execute("SELECT session,source FROM usage_checkpoints") if source not in sources]
            self.db.executemany("DELETE FROM usage_checkpoints WHERE session=?", removed_usage)
            removed = [(identifier, json.loads(payload)["external_session_id"])
                       for identifier, source, payload in self.db.execute("SELECT id, source, payload FROM events")
                       if source not in sources]
            self.db.executemany("DELETE FROM events WHERE id=?", [(identifier,) for identifier, _ in removed])
            # An unchanged activity must be a fresh observation if its old payload lost consent.
            self.db.executemany("DELETE FROM observations WHERE session=?", [(session,) for _, session in removed])
            self.db.executemany("DELETE FROM metadata_labels WHERE session=?", [(session,) for _, session in removed])

    def clear_pending(self):
        with self.db:
            self.db.execute("DELETE FROM events")
            self.db.execute("UPDATE observations SET observed_at=0")
    def count(self):
        return self.db.execute("SELECT count(*) FROM events").fetchone()[0]

    def dropped(self):
        return self.db.execute("SELECT value FROM counters WHERE name='dropped'").fetchone()[0]


def destination(state):
    return json.dumps([state.data["origin"], state.data["workspace_id"], state.data["connector_id"]])
