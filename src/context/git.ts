import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Fault } from '../core/types.js';
import { maxBytes } from '../config.js';
import { maxInputLines } from '../core/text.js';
import { decode } from './files.js';

const exec = promisify(execFile);
async function run(repo: string, args: string[]) {
  try {
    const result = await exec('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: repo, encoding: 'buffer', maxBuffer: 2_000_000, timeout: 15_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, windowsHide: true,
    });
    return result.stdout;
  } catch (e: any) {
    throw new Fault(e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'CONTEXT_TOO_LARGE' : 'GIT_ERROR',
      'Git collection failed; verify repository, HEAD and base_ref. No review scope was changed.');
  }
}

export async function git(repo: string, args: string[]) {
  return (await run(repo, args)).toString('utf8');
}

export async function gitFile(root: string, path: string, ref: string | undefined, files: string[]) {
  const entry = ref
    ? await git(root, ['ls-tree', '-z', ref, '--', `:(literal)${path}`])
    : await git(root, ['ls-files', '--stage', '-z', '--', `:(literal)${path}`]);
  if (!ref && entry && (entry.split('\0').filter(Boolean).length !== 1 || !/^[0-9]+ [a-f0-9]+ 0\t/.test(entry)))
    throw new Fault('UNMERGED_PATH', `Resolve index conflicts before review: ${path}`);
  if (!entry) return null;
  if (!entry.startsWith('100644 ') && !entry.startsWith('100755 ')) return undefined;
  const blob = ref ? entry.split(' ')[2].split('\t')[0] : entry.split(' ')[1];
  const size = Number((await git(root, ['cat-file', '-s', blob])).trim());
  if (size > maxBytes) throw new Fault('CONTEXT_TOO_LARGE', `File exceeds limit: ${path}`,
    { bytes: size, byte_limit: maxBytes - 100, line_limit: maxInputLines, files, omitted: [] });
  const bytes = await run(root, ['cat-file', 'blob', blob]);
  // Validate UTF-8 without stripping a BOM from committed source.
  return decode(bytes) === undefined ? undefined : bytes.toString('utf8');
}

export async function isIgnored(root: string, path: string) {
  try {
    await exec('git', ['check-ignore', '-q', '--', path], { cwd: root, windowsHide: true,
      timeout: 15_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    return true;
  } catch (e: any) {
    if (e.code === 1) return false;
    throw new Fault('GIT_ERROR', 'Git ignore check failed; no review scope was changed.');
  }
}
