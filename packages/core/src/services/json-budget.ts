// Shared byte-budget helpers for bounded JSON reads (LF-131 unit: UTF-8 bytes of the JSON
// serialization). Internal to core; not exported from the barrel.

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Largest `end` in [start, value.length] such that `fits(value.slice(start, end))` holds,
 * found by binary search (fits must be monotone in the slice length). The end is stepped
 * back one position when it would split a UTF-16 surrogate pair, so a prefix never carries a
 * lone high surrogate.
 */
export function fitStringPrefix(value: string, start: number, fits: (slice: string) => boolean): number {
  let low = start, high = value.length;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (fits(value.slice(start, end))) low = end; else high = end - 1;
  }
  if (low < value.length && low > start && /[\uD800-\uDBFF]/.test(value[low - 1]!)) low--;
  return low;
}
