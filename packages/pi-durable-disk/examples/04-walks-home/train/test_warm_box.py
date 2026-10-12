"""CPU checks for the box warm-up: python -m unittest test_warm_box (from train/).

What they pin: a host counts as missed by the image's cache only for programs compiled during the warm-up (unpacked ones
keep the tarball's older times, and jax's access-time files are not programs), only those are carried into the cache the
runs read, and the cache directory is train.py's own.
"""

import os
import tempfile
import time
import unittest

import warm_box


def touch(path: str, when: float) -> None:
  os.makedirs(os.path.dirname(path), exist_ok=True)
  open(path, "w").write(path)
  os.utime(path, (when, when))


class WarmBoxTest(unittest.TestCase):
  def test_counts_only_programs_compiled_here(self):
    with tempfile.TemporaryDirectory() as d:
      now = time.time()
      touch(os.path.join(d, "jit_step-aaa-cache"), now - 3600)  # unpacked from the image's tarball
      touch(os.path.join(d, "jit_step-bbb-cache"), now + 1)  # compiled during the warm-up
      touch(os.path.join(d, "jit_step-aaa-atime"), now + 1)  # a hit records its access time
      self.assertEqual(warm_box.new_programs(d, now), 1)
      self.assertEqual(warm_box.new_programs(os.path.join(d, "absent"), now), 0)

  def test_carries_only_new_files(self):
    with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as dst:
      now = time.time()
      touch(os.path.join(src, "jax", "jit_old-cache"), now - 3600)
      touch(os.path.join(src, "jax", "autotune", "fusion-1"), now + 1)
      touch(os.path.join(src, "warp", "wp_mod", "mod.cubin"), now + 1)
      warm_box.copy_new(src, dst, now)
      self.assertFalse(os.path.exists(os.path.join(dst, "jax", "jit_old-cache")))
      self.assertTrue(os.path.exists(os.path.join(dst, "jax", "autotune", "fusion-1")))
      self.assertTrue(os.path.exists(os.path.join(dst, "warp", "wp_mod", "mod.cubin")))

  def test_cache_dir_is_train_pys(self):
    # train.py: cache_dir = ~/.cache/pda-train/<tarball name up to the first dot>
    self.assertEqual(warm_box.cache_dir("/x/turn-left.tar.gz"),
                     os.path.join(os.path.expanduser("~"), ".cache", "pda-train", "turn-left"))


if __name__ == "__main__":
  unittest.main()
