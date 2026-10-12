"""CPU checks for the box warm-up: python -m unittest test_warm_box (from train/).

What they pin: a host counts as missed by the image's cache only for programs compiled during the warm-up (unpacked ones
keep the tarball's older times, and jax's access-time files are not programs), only those are carried into the cache the
runs read, the cache directory is train.py's own, and a cache tarball is replaced only by a complete one.
"""

import os
import tarfile
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

  def test_a_failed_save_keeps_the_previous_cache(self):
    with tempfile.TemporaryDirectory() as d:
      src, tarball = os.path.join(d, "cache"), os.path.join(d, "walk.tar.gz")
      open(tarball, "wb").write(b"GOOD")
      touch(os.path.join(src, "jax", "jit_a-cache"), time.time())
      unreadable = os.path.join(src, "jax", "jit_b-cache")
      touch(unreadable, time.time())
      os.chmod(unreadable, 0)  # tar cannot read it: it exits non-zero after writing part of the archive
      try:
        self.assertFalse(warm_box.save_cache(src, tarball))
      finally:
        os.chmod(unreadable, 0o644)
      self.assertEqual(open(tarball, "rb").read(), b"GOOD")
      self.assertFalse(os.path.exists(f"{tarball}.tmp"))
      self.assertFalse(warm_box.save_cache(os.path.join(d, "absent"), tarball))
      self.assertEqual(open(tarball, "rb").read(), b"GOOD")

  def test_a_good_save_replaces_the_cache(self):
    with tempfile.TemporaryDirectory() as d:
      src, tarball = os.path.join(d, "cache"), os.path.join(d, "walk.tar.gz")
      open(tarball, "wb").write(b"OLD")
      touch(os.path.join(src, "warp", "wp_mod", "mod.cubin"), time.time())
      self.assertTrue(warm_box.save_cache(src, tarball))
      import tarfile
      with tarfile.open(tarball) as tf:
        self.assertIn("warp/wp_mod/mod.cubin", tf.getnames())

  def test_the_cache_is_a_plain_tar(self):
    # Compiled programs do not compress (the image's 407 MB cache gzips to 407 MB) and gzip took 12 s on 8 cores; train.py
    # opens either kind.
    with tempfile.TemporaryDirectory() as d:
      src, tarball = os.path.join(d, "c"), os.path.join(d, "walk.tar.gz")
      os.makedirs(os.path.join(src, "jax"))
      open(os.path.join(src, "jax", "jit_x-cache"), "w").write("x")
      self.assertTrue(warm_box.save_cache(src, tarball))
      with tarfile.open(tarball, "r:") as tf:  # uncompressed, or this raises
        self.assertIn("jax/jit_x-cache", tf.getnames())

  def test_cache_dir_is_train_pys(self):
    # train.py: cache_dir = ~/.cache/pda-train/<tarball name up to the first dot>
    self.assertEqual(warm_box.cache_dir("/x/turn-left.tar.gz"),
                     os.path.join(os.path.expanduser("~"), ".cache", "pda-train", "turn-left"))


if __name__ == "__main__":
  unittest.main()
