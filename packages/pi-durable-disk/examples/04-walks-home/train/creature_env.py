"""Walk task for a sketched creature, on MJX (jax or warp implementation).

The body is the tab's MJCF, byte for byte (tab/src/mjcf.ts writes it; this file never edits it), so a policy trained
here runs on the model the tab simulates. Invariants the tab depends on:
- the policy observation is the mlp-v1 slice list in OBS_SPEC, built exactly as policy/obs.ts builds it;
- the action is in [-1, 1] and the actuators get stand_pose + action_scale * action;
- one policy step is ctrl_dt = 0.02 s of simulated time.
Rewards are a weighted sum of named terms (REWARD_TERMS); a universe differs from another only in its weights.
"""

from __future__ import annotations

import json
from typing import Any

import jax
import jax.numpy as jp
import mujoco
import numpy as np
from ml_collections import config_dict
from mujoco import mjx
from mujoco_playground._src import mjx_env

# The mlp-v1 observation, in order. Sizes for a body with nj joints.
OBS_SPEC = ("gravity", "ang_vel", "lin_vel", "joint_pos", "joint_vel", "prev_action", "command", "phase")


def obs_sizes(nj: int) -> list[tuple[str, int]]:
  size = {"gravity": 3, "ang_vel": 3, "lin_vel": 3, "joint_pos": nj, "joint_vel": nj, "prev_action": nj,
          "command": 1, "phase": 2}
  return [(name, size[name]) for name in OBS_SPEC]


# Every term a reward hypothesis may weight. Positive terms are rewards, the sign lives in the weight.
REWARD_TERMS = (
    "tracking_lin_vel",  # exp(-|v_xy(body) - (cmd, 0)|^2 / sigma)
    "tracking_yaw",  # exp(-w_z^2 / sigma): walk straight
    "lin_vel_z",  # v_z^2
    "ang_vel_xy",  # w_x^2 + w_y^2
    "orientation",  # |gravity_xy(body)|^2
    "base_height",  # max(0, target - z)^2: no belly crawling
    "torques",  # sum tau^2
    "action_rate",  # sum (a - a_prev)^2
    "energy",  # sum |qdot * tau|
    "pose",  # exp(-|q - stand|^2)
    "stand_still",  # sum |q - stand| while cmd == 0
    "dof_pos_limits",  # distance outside the soft joint limits
    "feet_air_time",  # air time at touchdown, while cmd > 0
    "feet_slip",  # foot speed^2 while in contact
    "feet_clearance",  # |foot_z - max_foot_height| * sqrt(foot speed)
    "feet_height",  # (swing peak / max_foot_height - 1)^2 at touchdown
    "trot_clock",  # fraction of feet whose contact matches a diagonal trot on the gait clock
    "alive",  # 1 per step
    "termination",  # 1 on the step that falls
)


def default_config() -> config_dict.ConfigDict:
  return config_dict.create(
      ctrl_dt=0.02,
      sim_dt=0.0,  # unused: the MJCF's timestep is the physics step
      episode_length=1000,
      action_scale=0.5,
      gait_hz=2.0,
      command_range=[0.0, 0.8],
      command_zero_prob=0.15,
      command_resample_s=5.0,
      soft_joint_pos_limit_factor=0.95,
      fall_up_z=0.0,  # terminate when the torso's up axis points below horizontal by this much
      noise_config=config_dict.create(
          level=1.0,
          scales=config_dict.create(joint_pos=0.03, joint_vel=1.0, gyro=0.2, gravity=0.05, linvel=0.1),
      ),
      reward_config=config_dict.create(
          scales=config_dict.create(
              tracking_lin_vel=1.5,
              tracking_yaw=0.5,
              lin_vel_z=-0.5,
              ang_vel_xy=-0.05,
              orientation=-5.0,
              base_height=-20.0,
              torques=-0.0002,
              action_rate=-0.01,
              energy=-0.001,
              pose=0.3,
              stand_still=-0.5,
              dof_pos_limits=-1.0,
              feet_air_time=0.5,
              feet_slip=-0.1,
              feet_clearance=0.0,
              feet_height=0.0,
              trot_clock=0.0,
              alive=0.0,
              termination=-1.0,
          ),
          tracking_sigma=0.25,
          max_foot_height=0.06,
          base_height_frac=0.75,
      ),
      pert_config=config_dict.create(
          enable=False,
          force=[0.0, 60.0],  # N, horizontal, on the torso: the tab's kick
          duration_s=0.1,
          wait_s=[1.0, 3.0],
      ),
      impl="jax",
      naconmax_per_env=12,
      njmax=72,
  )


def _f32(x):
  return jp.asarray(x, dtype=jp.float32)


class CreatureWalk(mjx_env.MjxEnv):
  """Track a forward speed command on the tab's body."""

  def __init__(self, mjcf: str, body: dict[str, Any], config: config_dict.ConfigDict | None = None,
               num_envs: int = 1, config_overrides: dict[str, Any] | None = None):
    config = config or default_config()
    super().__init__(config, config_overrides)
    self._xml = mjcf
    self._body = body
    self._mj_model = mujoco.MjModel.from_xml_string(mjcf)
    # The physics step is the MJCF's (the tab steps the same model); the policy acts every ctrl_dt.
    self._sim_dt = float(self._mj_model.opt.timestep)
    if abs(self.n_substeps * self._sim_dt - self._config.ctrl_dt) > 1e-9:
      raise ValueError("ctrl_dt must be a whole number of physics steps")
    self._naconmax = int(self._config.naconmax_per_env) * max(int(num_envs), 1)
    self._mjx_model = mjx.put_model(self._mj_model, impl=self._config.impl)
    self._post_init()

  def _post_init(self) -> None:
    m = self._mj_model
    joints = list(self._body["jointNames"])
    for i, name in enumerate(joints):
      j = m.joint(name)
      if m.jnt_qposadr[j.id] != 7 + i or m.jnt_dofadr[j.id] != 6 + i:
        raise ValueError(f"joint {name} is not at qpos[{7 + i}]: the mlp-v1 joint order is broken")
      if m.actuator_trnid[i, 0] != j.id:
        raise ValueError(f"actuator {i} does not drive {name}")
    self._nj = len(joints)
    if m.nu != self._nj or m.nq != 7 + self._nj:
      raise ValueError(f"body has nu={m.nu}, nq={m.nq}; expected {self._nj} hinges after a free joint")
    self._stand = jp.array(self._body["standPose"], dtype=jp.float32)
    if mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_KEY, "home") >= 0:
      q0 = np.array(m.key("home").qpos)
    else:
      q0 = np.zeros(m.nq)
      q0[2] = self._body["standHeight"]
      q0[3] = 1.0
      q0[7:] = self._body["standPose"]
    self._init_q = jp.array(q0, dtype=jp.float32)
    lowers, uppers = m.jnt_range[1:].T
    mid, half = (lowers + uppers) / 2, (uppers - lowers) / 2
    f = self._config.soft_joint_pos_limit_factor
    self._soft_lowers = jp.array(mid - half * f)
    self._soft_uppers = jp.array(mid + half * f)
    self._ctrl_lo = jp.array(m.actuator_ctrlrange[:, 0])
    self._ctrl_hi = jp.array(m.actuator_ctrlrange[:, 1])
    self._torso = m.body("torso").id
    legs = list(self._body["legs"])
    self._feet = np.array([m.geom(f"{leg}_foot").id for leg in legs])
    self._foot_r = jp.array(m.geom_size[self._feet, 0])
    self._nfeet = len(legs)
    # Diagonal trot: leg k of pair p on side s is in phase group (p + s) % 2.
    self._trot_group = jp.array([((k // 2) + (k % 2)) % 2 for k in range(self._nfeet)])
    self._base_height_target = float(self._body["standHeight"]) * self._config.reward_config.base_height_frac
    self._mjcf_sha256 = None

  # ---- properties -------------------------------------------------------------------------------------------------

  @property
  def xml_path(self) -> str:
    return "<inline>"

  @property
  def action_size(self) -> int:
    return self._nj

  @property
  def mj_model(self) -> mujoco.MjModel:
    return self._mj_model

  @property
  def mjx_model(self) -> mjx.Model:
    return self._mjx_model

  @property
  def body(self) -> dict[str, Any]:
    return self._body

  # ---- state helpers ----------------------------------------------------------------------------------------------

  @staticmethod
  def to_body(quat: jax.Array, v: jax.Array) -> jax.Array:
    """R(quat)^T v, quat = (w, x, y, z); the same rotation policy/obs.ts toBody computes."""
    w, u = quat[0], -quat[1:4]
    c = jp.cross(u, v) + w * v
    return v + 2.0 * jp.cross(u, c)

  def _ground_height(self, xy: jax.Array) -> jax.Array:
    return jp.zeros(xy.shape[:-1])

  def _feet_state(self, data: mjx.Data):
    p = data.geom_xpos[self._feet]
    clearance = p[:, 2] - self._foot_r - self._ground_height(p[:, :2])
    contact = clearance < 0.005
    return p, clearance, contact

  def _raw_obs(self, data: mjx.Data, info: dict[str, Any]) -> dict[str, jax.Array]:
    quat = data.qpos[3:7]
    t = info["t"]
    a = 2.0 * jp.pi * self._config.gait_hz * t
    return {
        "gravity": self.to_body(quat, jp.array([0.0, 0.0, -1.0])),
        "ang_vel": data.qvel[3:6],
        "lin_vel": self.to_body(quat, data.qvel[0:3]),
        "joint_pos": data.qpos[7:] - self._stand,
        "joint_vel": data.qvel[6:],
        "prev_action": info["last_act"],
        "command": jp.reshape(info["command"], (1,)),
        "phase": jp.array([jp.sin(a), jp.cos(a)]),
    }

  def _get_obs(self, data: mjx.Data, info: dict[str, Any]) -> dict[str, jax.Array]:
    raw = self._raw_obs(data, info)
    sc = self._config.noise_config.scales
    lvl = self._config.noise_config.level
    noisy = dict(raw)
    for key, scale in (("gravity", sc.gravity), ("ang_vel", sc.gyro), ("lin_vel", sc.linvel),
                       ("joint_pos", sc.joint_pos), ("joint_vel", sc.joint_vel)):
      info["rng"], k = jax.random.split(info["rng"])
      noisy[key] = raw[key] + (2 * jax.random.uniform(k, raw[key].shape) - 1) * lvl * scale
    state = jp.concatenate([noisy[name] for name in OBS_SPEC])
    _, clearance, contact = self._feet_state(data)
    privileged = jp.concatenate([
        jp.concatenate([raw[name] for name in OBS_SPEC]),
        data.qpos[2:3],
        clearance,
        contact.astype(jp.float32),
        info["feet_air_time"],
        data.actuator_force,
        data.xfrc_applied[self._torso, :3] / 60.0,
    ])
    return {"state": state, "privileged_state": privileged}

  # ---- reset / step -----------------------------------------------------------------------------------------------

  def _sample_command(self, rng: jax.Array) -> jax.Array:
    k1, k2 = jax.random.split(rng)
    lo, hi = self._config.command_range
    cmd = jax.random.uniform(k1, minval=lo, maxval=hi)
    return jp.where(jax.random.uniform(k2) < self._config.command_zero_prob, 0.0, cmd)

  def _steps_until(self, rng: jax.Array, seconds: float) -> jax.Array:
    return jp.maximum(jp.round(jax.random.exponential(rng) * seconds / self.dt), 1).astype(jp.int32)

  def reset(self, rng: jax.Array) -> mjx_env.State:
    qpos = self._init_q
    rng, k1, k2, k3, k4 = jax.random.split(rng, 5)
    qpos = qpos.at[0:2].add(jax.random.uniform(k1, (2,), minval=-0.5, maxval=0.5))
    yaw = jax.random.uniform(k2, minval=-jp.pi, maxval=jp.pi)
    qpos = qpos.at[3:7].set(jp.array([jp.cos(yaw / 2), 0.0, 0.0, jp.sin(yaw / 2)]))
    qpos = qpos.at[7:].add(jax.random.uniform(k3, (self._nj,), minval=-0.1, maxval=0.1))
    qvel = jp.zeros(self._mj_model.nv).at[0:6].set(jax.random.uniform(k4, (6,), minval=-0.3, maxval=0.3))
    data = mjx_env.make_data(self._mj_model, qpos=qpos, qvel=qvel, ctrl=jp.clip(qpos[7:], self._ctrl_lo, self._ctrl_hi),
                             impl=self._mjx_model.impl.value, naconmax=self._naconmax, njmax=self._config.njmax)
    data = mjx.forward(self._mjx_model, data)

    rng, kc, kn, kp1, kp2 = jax.random.split(rng, 5)
    pc = self._config.pert_config
    info = {
        "rng": rng,
        "t": _f32(0.0),
        "command": self._sample_command(kc),
        "steps_until_next_cmd": self._steps_until(kn, self._config.command_resample_s),
        "last_act": jp.zeros(self._nj),
        "feet_air_time": jp.zeros(self._nfeet),
        "last_contact": jp.zeros(self._nfeet, dtype=bool),
        "swing_peak": jp.zeros(self._nfeet),
        "prev_feet_pos": data.geom_xpos[self._feet],
        "steps_until_next_pert": jp.round(jax.random.uniform(kp1, minval=pc.wait_s[0], maxval=pc.wait_s[1]) / self.dt).astype(jp.int32),
        "pert_steps_left": jp.zeros((), dtype=jp.int32),
        "pert_force": jp.zeros(3),
    }
    metrics = {f"reward/{k}": jp.zeros(()) for k in REWARD_TERMS}
    metrics["fwd_speed"] = jp.zeros(())
    obs = self._get_obs(data, info)
    reward, done = jp.zeros(2)
    return mjx_env.State(data, obs, reward, done, metrics, info)

  def _perturb(self, state: mjx_env.State) -> mjx_env.State:
    """The tab's kick: a horizontal force on the torso for duration_s, every wait_s."""
    pc = self._config.pert_config
    info = state.info
    info["rng"], k1, k2, k3 = jax.random.split(info["rng"], 4)
    start = info["steps_until_next_pert"] <= 0
    ang = jax.random.uniform(k1, minval=-jp.pi, maxval=jp.pi)
    mag = jax.random.uniform(k2, minval=pc.force[0], maxval=pc.force[1])
    new_force = jp.array([jp.cos(ang) * mag, jp.sin(ang) * mag, 0.0])
    duration = int(round(pc.duration_s / self.dt))
    info["pert_force"] = jp.where(start, new_force, info["pert_force"])
    info["pert_steps_left"] = jp.where(start, duration, info["pert_steps_left"])
    info["steps_until_next_pert"] = jp.where(
        start, jp.round(jax.random.uniform(k3, minval=pc.wait_s[0], maxval=pc.wait_s[1]) / self.dt).astype(jp.int32),
        info["steps_until_next_pert"] - 1)
    force = jp.where(info["pert_steps_left"] > 0, info["pert_force"], jp.zeros(3))
    info["pert_steps_left"] = jp.maximum(info["pert_steps_left"] - 1, 0)
    xfrc = state.data.xfrc_applied.at[self._torso, :3].set(force)
    return state.replace(data=state.data.replace(xfrc_applied=xfrc))

  def step(self, state: mjx_env.State, action: jax.Array) -> mjx_env.State:
    if self._config.pert_config.enable:
      state = self._perturb(state)
    info = state.info
    targets = jp.clip(self._stand + action * self._config.action_scale, self._ctrl_lo, self._ctrl_hi)
    data = mjx_env.step(self._mjx_model, state.data, targets, self.n_substeps)
    info["t"] = info["t"] + self.dt

    feet_pos, clearance, contact = self._feet_state(data)
    feet_vel = (feet_pos - info["prev_feet_pos"]) / self.dt
    contact_filt = contact | info["last_contact"]
    first_contact = (info["feet_air_time"] > 0.0) * contact_filt
    info["feet_air_time"] = info["feet_air_time"] + self.dt
    info["swing_peak"] = jp.maximum(info["swing_peak"], clearance)

    done = self._fell(data)
    terms = self._reward_terms(data, action, info, done, first_contact, contact, clearance, feet_vel)
    scales = self._config.reward_config.scales
    weighted = {k: v * scales[k] for k, v in terms.items()}
    reward = jp.clip(sum(weighted.values()) * self.dt, 0.0, 10000.0)

    info["last_act"] = action
    info["rng"], k1, k2 = jax.random.split(info["rng"], 3)
    info["steps_until_next_cmd"] = info["steps_until_next_cmd"] - 1
    resample = info["steps_until_next_cmd"] <= 0
    info["command"] = jp.where(resample, self._sample_command(k1), info["command"])
    info["steps_until_next_cmd"] = jp.where(resample, self._steps_until(k2, self._config.command_resample_s),
                                            info["steps_until_next_cmd"])
    info["feet_air_time"] = info["feet_air_time"] * ~contact
    info["last_contact"] = contact
    info["swing_peak"] = info["swing_peak"] * ~contact
    info["prev_feet_pos"] = feet_pos

    obs = self._get_obs(data, info)
    for k, v in weighted.items():
      state.metrics[f"reward/{k}"] = v
    state.metrics["fwd_speed"] = self.to_body(data.qpos[3:7], data.qvel[0:3])[0]
    return state.replace(data=data, obs=obs, reward=reward, done=done.astype(reward.dtype))

  def _fell(self, data: mjx.Data) -> jax.Array:
    up_z = -self.to_body(data.qpos[3:7], jp.array([0.0, 0.0, -1.0]))[2]
    return (up_z < self._config.fall_up_z) | ~jp.isfinite(data.qpos).all()

  def _reward_terms(self, data, action, info, done, first_contact, contact, clearance, feet_vel):
    rc = self._config.reward_config
    quat = data.qpos[3:7]
    v = self.to_body(quat, data.qvel[0:3])
    w = data.qvel[3:6]
    g = self.to_body(quat, jp.array([0.0, 0.0, -1.0]))
    q = data.qpos[7:]
    qd = data.qvel[6:]
    tau = data.actuator_force
    cmd = info["command"]
    moving = cmd > 0.01
    speed_xy = jp.linalg.norm(feet_vel[:, :2], axis=-1)
    air = jp.clip((info["feet_air_time"] - 0.1) * first_contact, max=0.4)
    phase = 2.0 * jp.pi * self._config.gait_hz * info["t"]
    # Group 0 stands while sin(phase) >= 0, group 1 while it is < 0.
    want_stance = jp.where(self._trot_group == 0, jp.sin(phase) >= 0, jp.sin(phase) < 0)
    peak_err = info["swing_peak"] / rc.max_foot_height - 1.0
    return {
        "tracking_lin_vel": jp.exp(-((v[0] - cmd) ** 2 + v[1] ** 2) / rc.tracking_sigma),
        "tracking_yaw": jp.exp(-(w[2] ** 2) / rc.tracking_sigma),
        "lin_vel_z": v[2] ** 2,
        "ang_vel_xy": jp.sum(w[:2] ** 2),
        "orientation": jp.sum(g[:2] ** 2),
        "base_height": jp.maximum(self._base_height_target - (data.qpos[2] - self._ground_height(data.qpos[0:2])), 0.0) ** 2,
        "torques": jp.sum(tau ** 2),
        "action_rate": jp.sum((action - info["last_act"]) ** 2),
        "energy": jp.sum(jp.abs(qd * tau)),
        "pose": jp.exp(-jp.sum((q - self._stand) ** 2)),
        "stand_still": jp.sum(jp.abs(q - self._stand)) * ~moving,
        "dof_pos_limits": jp.sum(jp.clip(self._soft_lowers - q, min=0.0) + jp.clip(q - self._soft_uppers, min=0.0)),
        "feet_air_time": jp.sum(air) * moving,
        "feet_slip": jp.sum(speed_xy ** 2 * contact) * moving,
        "feet_clearance": jp.sum(jp.abs(clearance - rc.max_foot_height) * jp.sqrt(speed_xy)) * moving,
        "feet_height": jp.sum(peak_err ** 2 * first_contact) * moving,
        "trot_clock": jp.mean((contact == want_stance).astype(jp.float32)) * moving,
        "alive": jp.ones(()),
        "termination": done.astype(jp.float32),
    }


def load_body(mjcf_path: str, body_path: str) -> tuple[str, dict[str, Any]]:
  with open(mjcf_path, "rb") as f:
    xml = f.read().decode("utf-8")
  with open(body_path) as f:
    body = json.load(f)
  return xml, body
