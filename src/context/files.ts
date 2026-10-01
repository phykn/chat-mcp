import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { Fault } from '../core/types.js';
import { maxBytes } from '../config.js';
import { maxInputLines } from '../core/text.js';

export function safePath(path: string) {
  const p = path.replaceAll('\\', '/');
  const normalized = p.split('/').filter(s => s && s !== '.').join('/') || '.';
  if (!p || isAbsolute(p) || /^[a-z]:/i.test(normalized) || p.split('/').some(s => s === '..') || p.includes('\0'))
    throw new Fault('INVALID_PATH', `Repository-relative file path required: ${path}`);
  return normalized;
}

export function exclusion(path: string): string | undefined {
  if (/(^|\/)(node_modules|vendor|dist|coverage|\.git|\.venv|\.chat-mcp)(\/|$)/i.test(path) || /^build(\/|$)/i.test(path)) return 'generated/dependency/internal';
  if (/^extension\/config\.js$|(^|\/)bridge-token$/i.test(path)) return 'local pairing credential';
  if (/(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(path) ||
      /\.(pem|p12|pfx|key|keystore)$/i.test(path)) return 'credential file';
  if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|exe|dll|woff2?|mp4|mp3|sqlite|db|lock|min\.js|map)$/i.test(path) || /(^|\/)package-lock\.json$/.test(path)) return 'binary/generated';
}

export function decode(bytes: Buffer) {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
}

export async function disk(root: string, path: string) {
  const full = resolve(root, path);
  try {
    if ((await lstat(full)).isSymbolicLink()) return undefined;
    const actual = await realpath(full), rel = relative(root, actual);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Fault('PATH_ESCAPE', `Path escapes repository: ${path}`);
    if (exclusion(rel.split(sep).join('/'))) return undefined;
    const stat = await lstat(actual);
    if (!stat.isFile()) return undefined;
    if (stat.size > maxBytes) throw new Fault('CONTEXT_TOO_LARGE', `File exceeds ${maxBytes} bytes: ${path}`,
      { bytes: stat.size, byte_limit: maxBytes - 100, line_limit: maxInputLines, files: [path], omitted: [] });
    return decode(await readFile(actual));
  } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
}
