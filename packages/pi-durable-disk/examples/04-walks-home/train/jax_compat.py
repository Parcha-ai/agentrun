"""Brax 0.14.2 calls jax.device_put_replicated, which JAX 0.11 removed. Import this before Brax runs.

The replacement keeps the old contract: every leaf gets a leading axis of len(devices), one copy per device, which is
what Brax's pmap'd training state expects.
"""

import jax
import jax.numpy as jnp


def _device_put_replicated(x, devices):
  n = len(devices)
  return jax.tree.map(lambda a: jax.device_put(jnp.stack([jnp.asarray(a)] * n)), x)


if "device_put_replicated" not in vars(jax):
  try:
    jax.device_put_replicated  # noqa: B018 - present on older JAX
  except AttributeError:
    jax.device_put_replicated = _device_put_replicated
