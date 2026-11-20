import { describe, expect, it } from 'vitest';
import { backendSdkLabel, backendSdkOf } from './backendSdk';

describe('backend source identity', () => {
  it.each(['openclaw', 'capy', 'Atlas 工作流', 'eve', 'codex-sdk'])('keeps external platform %s as display data', platform => {
    const sdk = backendSdkOf({ sdk: { runtime: 'external', platform } });
    expect(sdk).toEqual({ runtime: 'external', platform });
    expect(backendSdkLabel(sdk!)).toBe(platform);
  });

  it.each([undefined, null, 42, '', ' ', ' padded ', 'line\nbreak', '\u007f', '\ud800', 'a'.repeat(81)])('keeps external ownership when the platform label is unreadable: %j', platform => {
    expect(backendSdkOf({ sdk: { runtime: 'external', platform } })).toEqual({ runtime: 'external', platform: 'External platform' });
  });

  it('keeps known SDK identity independent of a platform label', () => {
    expect(backendSdkOf({ sdk: { runtime: 'eve' } })).toEqual({ runtime: 'eve' });
    expect(backendSdkOf({ sdk: { runtime: 'eve', platform: 'other' } })).toBeUndefined();
    expect(backendSdkOf({ sdk: { runtime: 'openclaw' } })).toBeUndefined();
  });

  it('counts Unicode characters rather than UTF-16 code units in a label', () => {
    const platform = '🦋'.repeat(80);
    expect(backendSdkOf({ sdk: { runtime: 'external', platform } })).toEqual({ runtime: 'external', platform });
  });

  it('keeps a redacted external run external when replacement expands its accepted label', () => {
    const platform = '🚀'.repeat(72) + '[redacted]';
    expect(backendSdkOf({ sdk: { runtime: 'external', platform } })).toEqual({ runtime: 'external', platform: 'External platform' });
  });
});
