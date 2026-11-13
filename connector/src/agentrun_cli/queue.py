"""Atomic metadata observation checkpoints and bounded durable delivery."""

from datetime import datetime, timezone
import json
import os
import sqlite3
import time
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


Activity = Literal["unknown", "working", "idle", "waiting_input", "finished", "failed", "stopped"]


class Metadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    activity: Activity
    harness: Literal["claude", "codex"]


class Event(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str
    source_id: str
    external_session_id: str
    sequence: int = Field(gt=0)
    type: Literal["session_observed"] = "session_observed"
    occurred_at: str
    metadata: Metadata


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
          CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT OR IGNORE INTO counters VALUES ('dropped', 0);
        """)
        if "observed_at" not in {row[1] for row in self.db.execute("PRAGMA table_info(observations)")}:
            self.db.execute("ALTER TABLE observations ADD COLUMN observed_at REAL NOT NULL DEFAULT 0")
        if binding is not None:
            with self.db:
                previous = self.db.execute("SELECT value FROM settings WHERE name='destination'").fetchone()
                if previous is None or previous[0] != binding:
                    self.db.execute("DELETE FROM events")
                    self.db.execute("DELETE FROM observations")
                    self.db.execute("UPDATE counters SET value=0 WHERE name='dropped'")
                    self.db.execute("INSERT OR REPLACE INTO settings VALUES ('destination',?)", (binding,))

    def close(self):
        self.db.close()

    def observe(self, source_id, candidate):
        with self.db:
            now = time.time()
            previous = self.db.execute("SELECT activity, sequence, observed_at FROM observations WHERE session=?", (candidate.id,)).fetchone()
            if previous and previous[0] == candidate.activity and now - previous[2] < self.refresh_seconds:
                return
            sequence = previous[1] + 1 if previous else 1
            event = Event(event_id=str(uuid4()), source_id=source_id, external_session_id=candidate.id,
                          sequence=sequence, occurred_at=datetime.now(timezone.utc).isoformat(),
                          metadata=Metadata(activity=candidate.activity, harness=candidate.harness))
            self.db.execute("INSERT INTO events VALUES (?,?,?)", (event.event_id, source_id, event.model_dump_json()))
            self.db.execute("INSERT OR REPLACE INTO observations VALUES (?,?,?,?)", (candidate.id, candidate.activity, sequence, now))
            while True:
                count, size = self.db.execute("SELECT count(*), coalesce(sum(length(payload)),0) FROM events").fetchone()
                if count <= self.max_events and size <= self.max_bytes:
                    break
                self.db.execute("DELETE FROM events WHERE rowid=(SELECT min(rowid) FROM events)")
                self.db.execute("UPDATE counters SET value=value+1 WHERE name='dropped'")

    def batch(self):
        return [json.loads(row[0]) for row in self.db.execute("SELECT payload FROM events ORDER BY rowid LIMIT 50")]

    def acknowledge(self, identifiers):
        with self.db:
            self.db.executemany("DELETE FROM events WHERE id=?", [(identifier,) for identifier in identifiers])

    def retain_sources(self, sources):
        with self.db:
            identifiers = [row[0] for row in self.db.execute("SELECT id, source FROM events") if row[1] not in sources]
            self.db.executemany("DELETE FROM events WHERE id=?", [(identifier,) for identifier in identifiers])

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
