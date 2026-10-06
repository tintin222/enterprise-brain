/** Dates relative to the moment a demo source is read, so the demo company always looks current. */

export function dayOffset(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A moment `days` from now at a working hour (UTC), for things that happened in the past. */
export function momentAt(now: Date, days: number, hour = 9, minute = 0): Date {
  const date = new Date(now.getTime() + days * 86_400_000);
  date.setUTCHours(hour, minute, 0, 0);
  return date > now ? new Date(now.getTime() - 60_000) : date;
}

/** The value for the n-th reading: demo sources change a little each time they are read. */
export function byWave<T>(values: T | readonly T[], syncs: number): T {
  if (!Array.isArray(values)) return values as T;
  return values[Math.min(syncs, values.length - 1)] as T;
}

/** Items released by the n-th reading (wave 0 is there from the first). */
export function released<T extends { wave?: number }>(items: readonly T[], syncs: number): T[] {
  return items.filter((item) => (item.wave ?? 0) <= syncs);
}

/** Things released by a later reading happened "just now": minutes before it. */
export function waveMoment(now: Date, wave: number, days: number, index: number, hour?: number): Date {
  return wave > 0 ? new Date(now.getTime() - (index + 1) * 7 * 60_000) : momentAt(now, days, hour ?? 8 + (index % 9), (index * 13) % 60);
}
