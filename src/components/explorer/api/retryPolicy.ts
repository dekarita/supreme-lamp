/**
 * F45 S3 — Explorer §8.2 retry gating, corrected against §5.2.
 *
 * The §8.2 sketch listed `NON_RETRYABLE_HTTP = {403, 413, 415}` and a
 * `maxAttempts` that only special-cased 403/413. Explorer §5.2 (and the F45
 * ledger) require 401 to fail fast too, and `maxAttempts` to agree with
 * `canRetry` for every fail-fast status. Both are fixed here: one table, one
 * source of truth, asserted by `fx-retry-policy.test.ts` over all phase × status
 * combinations.
 *
 * Transient-only: a phase outside `dns|tcp|tls|http` is never retried, whatever
 * the status. `encrypt`, `size`, `type`, `auth` and `parse` are terminal.
 */
import type { UploadPhase, UploadState } from '../data/schema';
import { isFailFastStatus } from './errors';

/** §8.2: the only phases a retry may follow. */
export const TRANSIENT_PHASES: readonly UploadPhase[] = ['dns', 'tcp', 'tls', 'http'];

/** §8.2: 5 total attempts (1 initial + 4 retries) for a transient failure. */
export const MAX_TRANSIENT_ATTEMPTS = 5;

/** Jittered exponential backoff, capped. Values are the S3 contract. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8000;
export const BACKOFF_FLOOR_MS = 100;
/** A hostile/buggy `Retry-After` must not park the queue for an hour. */
export const RETRY_AFTER_CAP_MS = 120000;

export interface BackoffDeps {
  /** Injectable so tests are deterministic. Must return [0, 1]. */
  random?: () => number;
}

export function isTransientPhase(phase: UploadPhase | null | undefined): boolean {
  return phase != null && TRANSIENT_PHASES.includes(phase);
}

/** Pure classification: may this (phase, httpStatus) pair ever be retried? */
export function canRetryFrom(phase: UploadPhase | null | undefined, httpStatus?: number | null): boolean {
  if (isFailFastStatus(httpStatus)) return false;
  return isTransientPhase(phase);
}

/** §8.2 `canRetry(state)` — classification only, exactly as sketched. */
export function canRetry(state: UploadState): boolean {
  if (state.status !== 'failed') return false;
  const lastError = state.lastError;
  if (!lastError) return false;
  return canRetryFrom(lastError.phase, lastError.httpStatus);
}

/** Total attempts allowed for a (phase, httpStatus) pair: fail-fast is 1. */
export function maxAttempts(phase: UploadPhase | null | undefined, httpStatus?: number | null): number {
  if (isFailFastStatus(httpStatus)) return 1;
  if (isTransientPhase(phase)) return MAX_TRANSIENT_ATTEMPTS;
  return 1;
}

/** `canRetry` plus the attempt budget — what the S7 queue should actually call. */
export function shouldRetryNow(state: UploadState): boolean {
  if (!canRetry(state) || !state.lastError) return false;
  return state.retries < maxAttempts(state.lastError.phase, state.lastError.httpStatus) - 1;
}

export function attemptsRemaining(state: UploadState): number {
  if (!state.lastError) return 0;
  return Math.max(0, maxAttempts(state.lastError.phase, state.lastError.httpStatus) - 1 - state.retries);
}

/**
 * Jittered exponential backoff. `retryAfterMs` (429/5xx `Retry-After`) is a
 * FLOOR, never a ceiling: the server's own hint always wins when it is longer.
 */
export function backoffDelayMs(attempt: number, retryAfterMs?: number | null, deps: BackoffDeps = {}): number {
  const random = deps.random ?? Math.random;
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** safeAttempt);
  const jittered = BACKOFF_FLOOR_MS + (cap - BACKOFF_FLOOR_MS) * clamp01(random());
  const floor = retryAfterMs == null ? 0 : Math.min(Math.max(0, retryAfterMs), RETRY_AFTER_CAP_MS);
  return Math.max(floor, Math.round(jittered));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}
