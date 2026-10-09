import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBody, slice } from '../obs.ts';

const close = (a: number[], b: number[], eps = 1e-12) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} vs ${b}`));

test('identity quaternion leaves vectors alone', () => {
  close(toBody([1, 0, 0, 0], [1, 2, 3]), [1, 2, 3]);
});

test('torso pitched 90 degrees nose-down sees gravity along +x of the body', () => {
  // rotation about +y by +90 deg: body x axis points to world -z, so world down is body +x
  const h = Math.SQRT1_2;
  close(toBody([h, 0, h, 0], [0, 0, -1]), [1, 0, 0]);
});

test('yaw 90 degrees: world +x velocity is body -y', () => {
  const h = Math.SQRT1_2;
  close(toBody([h, 0, 0, h], [1, 0, 0]), [0, -1, 0]);
});

test('phase slice is sin/cos of the gait clock', () => {
  const s = { qpos: [0, 0, 0, 1, 0, 0, 0], qvel: [0, 0, 0, 0, 0, 0], prevAction: [], command: 0, time: 0.125, gaitHz: 2, standPose: [] };
  close(slice('phase', s), [1, 0]); // 2*pi*2*0.125 = pi/2
});
