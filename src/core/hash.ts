import { createHash } from 'node:crypto';

export function hash(value: unknown): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) :
    v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
