import type { PatchRequest } from './types';

const fields = new Set(['state', 'read', 'laterUntil', 'tags', 'memo', 'genre']);
export const itemId = (value: string) => /^x:[0-9]{1,25}$/.test(value);
export function integerParam(value: string | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validPatch(value: unknown): value is PatchRequest {
  if (!object(value) || Object.keys(value).length !== 2 || !('changes' in value) || !('expectedRevision' in value)) return false;
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1 || !object(value.changes)) return false;
  const p = value.changes;
  if (!Object.keys(p).length || Object.keys(p).some(k => !fields.has(k))) return false;
  if ('state' in p && !['inbox', 'later', 'kept', 'done'].includes(p.state as string)) return false;
  if ('read' in p && typeof p.read !== 'boolean') return false;
  if ('memo' in p && (typeof p.memo !== 'string' || [...p.memo].length > 10000)) return false;
  if ('genre' in p && p.genre !== null && (typeof p.genre !== 'string' || [...p.genre].length > 100)) return false;
  if ('laterUntil' in p && p.laterUntil !== null && (typeof p.laterUntil !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(p.laterUntil) || !Number.isFinite(Date.parse(p.laterUntil)) ||
    new Date(p.laterUntil).toISOString().slice(0, 19) !== p.laterUntil.slice(0, 19))) return false;
  if ('tags' in p && (!Array.isArray(p.tags) || p.tags.length > 20 || new Set(p.tags).size !== p.tags.length ||
    p.tags.some(t => typeof t !== 'string' || !t.trim() || [...t].length > 40))) return false;
  return true;
}
