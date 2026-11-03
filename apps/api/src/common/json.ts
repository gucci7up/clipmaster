/** Serializa BigInt (tamaños en bytes) como number para JSON. */
export function toJSONSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}
