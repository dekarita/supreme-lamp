// F52: exact Int64 byte arithmetic; convert to Number only AFTER subtraction
// or integer-ratio division. Decimal strings above 2^53-1 stay exact.
export function mirrorBytes(value: unknown): bigint {
  try {
    if (typeof value === "number" && !Number.isSafeInteger(value)) return 0n;
    const s = String(value ?? "0");
    if (!/^\d+$/.test(s)) return 0n;
    const n = BigInt(s);
    return n <= 9223372036854775807n ? n : 0n;
  } catch {
    return 0n;
  }
}

export function mirrorPercent(sent: unknown, size: unknown): number {
  const n = mirrorBytes(sent);
  const total = mirrorBytes(size);
  return total > 0n ? Math.min(100, Number((n * 1000n) / total) / 10) : 0;
}

export function mirrorTransfer(progress: Record<string, unknown>, live: boolean) {
  const sent = mirrorBytes(progress.bytesSent ?? progress.bytesDone);
  const size = mirrorBytes(progress.size ?? progress.bytesTotal);
  const window = mirrorBytes(progress.windowBytes);
  const seconds = Math.max(0, Number(progress.windowSeconds) || 0);
  const gap = Math.max(0, Math.floor(Number(progress.noBytesSeconds) || 0));
  const stalled = live && (window === 0n || seconds <= 0 || gap >= 60 || progress.stalled === true);
  const label = stalled ? "stalled (no bytes in " + gap + "s)" : "";
  const speed = live && !stalled && seconds > 0 ? Number(window) / seconds : 0;
  const remaining = size > sent ? size - sent : 0n;
  const eta = speed > 0 && window > 0n && !stalled ? Number(remaining) / speed : null;
  return { sent, size, window, seconds, gap, stalled, label, speed, eta };
}
