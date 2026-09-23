import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const exec = promisify(execFile);
let self: Promise<string | undefined> | undefined;

export async function processIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid) {
    const identity = await (self ??= identify(pid));
    if (!identity) self = undefined;
    return identity;
  }
  return identify(pid);
}

async function identify(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') {
      const [stat, boot] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      // comm may contain spaces and parentheses; fields after its final ')' start at 3.
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return start ? `${boot.trim()}:${start}` : undefined;
    }
    const { stdout } = process.platform === 'win32'
      ? await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
      { windowsHide: true, timeout: 5_000 })
      : await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='],
        { timeout: 5_000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}
