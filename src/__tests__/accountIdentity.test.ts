import { beforeEach, describe, expect, it } from 'vitest';
import * as auth from '../auth';
import * as state from '../state';

describe('cloud account identity', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores an explicit profile id for cloud-authenticated sessions', () => {
    const session = (auth as any).loginAccount({
      username: 'Seal Hero',
      profileId: 'google:sub-123',
      authProvider: 'google',
      email: 'seal@example.com',
    });

    expect(session.username).toBe('Seal Hero');
    expect(session.profileId).toBe('google:sub-123');
    expect(session.authProvider).toBe('google');
    expect(session.email).toBe('seal@example.com');
    expect((auth.getSession() as any)?.profileId).toBe('google:sub-123');
  });

  it('keeps a cloud save bound to profile id even when the display name changes', () => {
    (state as any).loadProfile('google:sub-123', 'Seal Hero');
    state.addCoins(42);

    (state as any).loadProfile('google:sub-123', 'Seal Legend');

    expect(state.getState().username).toBe('Seal Legend');
    expect(state.getState().totalCoins).toBe(42);
  });
});
