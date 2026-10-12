"""CPU checks for the dev runner's GPU placement: python -m unittest test_modal_run (from train/). Modal is replaced by a
fake at the adapter boundary (Sandbox.create and Sandbox.from_name), so no account or network is used.

What they pin: a sandbox placed after its attempt was abandoned is never returned as a later attempt's box, and is
terminated when it arrives; an attempt placed in time is returned with its own name.
"""

import sys
import threading
import time
import types
import unittest


class FakeSandbox:
  def __init__(self, name: str):
    self.name = name
    self.terminated = threading.Event()

  def terminate(self):
    self.terminated.set()


class NotFound(Exception):
  pass


created: list[FakeSandbox] = []
delays: dict[str, float] = {}


def fake_create(*_args, gpu, name, **_kw):
  time.sleep(delays.get(gpu, 0.0))
  sb = FakeSandbox(name)
  created.append(sb)
  return sb


def fake_from_name(_app, name):
  for sb in created:
    if sb.name == name:
      return sb
  raise NotFound(name)


modal = types.ModuleType("modal")
modal.Sandbox = types.SimpleNamespace(create=fake_create, from_name=fake_from_name)
modal.exception = types.ModuleType("modal.exception")
modal.exception.SandboxFilesystemNotFoundError = NotFound
sys.modules.setdefault("modal", modal)
sys.modules.setdefault("modal.exception", modal.exception)
image = types.ModuleType("modal_image")
image.REMOTE_TRAIN, image.training_image = "/opt/pda/train", lambda *a, **k: None
sys.modules.setdefault("modal_image", image)

import modal_run  # noqa: E402


class PlacementTest(unittest.TestCase):
  def setUp(self):
    created.clear()
    delays.clear()

  def test_a_late_box_is_terminated_never_returned_as_another_attempts(self):
    # H100 is placed at 0.3 s, during the L40S attempt (0.2-0.4 s); L40S at 0.7 s, after both were abandoned.
    delays.update({"H100": 0.3, "L40S": 0.5})
    with self.assertRaises(RuntimeError):
      modal_run.start(None, None, "H100,L40S", "run", modal_run.Ledger(None), 60, place_s=0.2)
    deadline = time.time() + 3
    while len(created) < 2 and time.time() < deadline:
      time.sleep(0.02)
    self.assertEqual(sorted(sb.name for sb in created), ["run-h100", "run-l40s"])
    for sb in created:
      self.assertTrue(sb.terminated.wait(2), sb.name)

  def test_a_box_placed_in_time_is_returned_with_its_own_name(self):
    delays.update({"H100": 0.3, "L40S": 0.0})
    sb, name, gpu = modal_run.start(None, None, "H100,L40S", "run", modal_run.Ledger(None), 60, place_s=0.2)
    self.assertEqual((sb.name, name, gpu), ("run-l40s", "run-l40s", "L40S"))
    self.assertFalse(sb.terminated.is_set())
    deadline = time.time() + 3
    while len(created) < 2 and time.time() < deadline:
      time.sleep(0.02)
    late = [b for b in created if b.name == "run-h100"]
    self.assertEqual(len(late), 1)
    self.assertTrue(late[0].terminated.wait(2), "the late H100 box is terminated")


if __name__ == "__main__":
  unittest.main()
