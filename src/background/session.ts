/* Unlock, lock, and auto-lock — the three places a worker restart would otherwise leak a key.
 *
 * AUTO-LOCK IS AN ALARM, NOT A TIMEOUT. `setTimeout` in a service worker is the classic MV3 bug:
 * the worker is killed thirty seconds after the last event, the timer goes with it, and the wallet
 * then stays unlocked forever because the thing that was going to lock it no longer exists. It
 * fails OPEN, which is the worst direction for a lock to fail in. `chrome.alarms` is stored by the
 * browser, survives the worker, and WAKES it to fire.
 *
 * AND IT IS ALSO A TIMESTAMP, because an alarm alone is not enough either. A laptop suspended for
 * an hour, a browser that throttles alarms in the background, a profile restored from a session —
 * in each case the alarm may fire late or not at all. So `expiresAt` is checked on every single
 * privileged read as well, and `requireUnlocked()` is the only way to reach the mnemonic. Belt and
 * braces, and the braces are the ones that hold: even with alarms entirely broken, the wallet
 * cannot be used past its deadline.
 */

import type { UnlockSession } from './storage.ts';
import { clearSessionKey, getLocal, getSession, setSession } from './storage.ts';
import { ProviderError, UNAUTHORIZED } from '../shared/errors.ts';

export const AUTO_LOCK_ALARM = 'cf-wallet-auto-lock';

export async function scheduleAutoLock(): Promise<void> {
  const { autoLockMinutes } = await getLocal('settings');
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  if (autoLockMinutes > 0) {
    // `delayInMinutes` has a one-minute floor in a packed extension, which is fine: the timestamp
    // check below is what enforces anything shorter, and the alarm is only the thing that makes the
    // lock happen without the user touching the wallet again.
    await chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: Math.max(autoLockMinutes, 0.5) });
  }
}

/** Push the deadline out. Called on every deliberate user action, never on a dapp's read. */
export async function touchSession(): Promise<void> {
  const unlock = await getSession('unlock');
  if (unlock === null) return;
  const { autoLockMinutes } = await getLocal('settings');
  await setSession('unlock', { ...unlock, expiresAt: Date.now() + autoLockMinutes * 60_000 });
  await scheduleAutoLock();
}

export async function beginSession(mnemonic: string, importedKeys: Record<string, string>): Promise<void> {
  const { autoLockMinutes } = await getLocal('settings');
  const session: UnlockSession = {
    mnemonic,
    expiresAt: Date.now() + autoLockMinutes * 60_000,
    importedKeys,
  };
  await setSession('unlock', session);
  await scheduleAutoLock();
}

export async function lock(): Promise<void> {
  await clearSessionKey('unlock');
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
}

/**
 * The unlocked session, or a refusal.
 *
 * EVERY path that needs a private key goes through here. There is no second way to reach
 * `session.unlock`, and the expiry is enforced on read rather than only on the alarm.
 */
export async function requireUnlocked(): Promise<UnlockSession> {
  const unlock = await getSession('unlock');
  if (unlock === null) {
    throw new ProviderError(UNAUTHORIZED, 'The wallet is locked. Open it and enter your password.');
  }
  if (Date.now() >= unlock.expiresAt) {
    await lock();
    throw new ProviderError(UNAUTHORIZED, 'The wallet locked itself after a period of inactivity. Open it and enter your password.');
  }
  return unlock;
}

/** Whether the wallet is unlocked, without throwing — for drawing the UI. */
export async function isUnlocked(): Promise<boolean> {
  const unlock = await getSession('unlock');
  return unlock !== null && Date.now() < unlock.expiresAt;
}
