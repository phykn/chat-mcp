import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectAsk, collectReview, safePath } from '../src/context/collect.js';

function git(root: string, ...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); }
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'chat-mcp-git-'));
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, 'demo.py'), 'def add(a,b):\n    return a + b\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base'); return root;
}
test('staged context uses index while working tree uses disk', async () => {
  const root = await repo();
  await writeFile(join(root, 'demo.py'), 'INDEX_VERSION\n'); git(root, 'add', '.');
  await writeFile(join(root, 'demo.py'), 'DISK_VERSION\n');
  const staged = await collectReview({ repo_path: root, scope: 'staged' });
  assert.match(staged.prompt, /1: INDEX_VERSION/); assert.doesNotMatch(staged.prompt, /DISK_VERSION/);
  assert.match((await collectReview({ repo_path: root, scope: 'working_tree' })).prompt, /1: DISK_VERSION/);
});
test('branch context uses committed HEAD, not index or disk', async () => {
  const root = await repo(); const base = git(root, 'rev-parse', 'HEAD').trim();
  await writeFile(join(root, 'demo.py'), 'COMMIT_VERSION\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'change');
  await writeFile(join(root, 'demo.py'), 'DISK_VERSION\n'); git(root, 'add', '.');
  const m = await collectReview({ repo_path: root, scope: 'branch', base_ref: base });
  assert.match(m.prompt, /1: COMMIT_VERSION/); assert.doesNotMatch(m.prompt, /DISK_VERSION/);
});
test('rename, deletion, unicode untracked and credential exclusions', async () => {
  const root = await repo();
  await rename(join(root, 'demo.py'), join(root, 'new.py'));
  await writeFile(join(root, '새 파일.txt'), '한국어\n');
  await writeFile(join(root, '.env'), 'SECRET=never-send');
  await writeFile(join(root, 'blob.dat'), Buffer.from([0, 255, 1]));
  const m = await collectReview({ repo_path: root, scope: 'working_tree' });
  assert.match(m.prompt, /FILE DELETED/); assert.match(m.prompt, /1: 한국어/);
  assert.deepEqual(m.files, ['demo.py', 'new.py', '새 파일.txt']);
  assert.doesNotMatch(m.prompt, /never-send/); assert.equal(m.omitted.length, 2);
});
test('invalid base and unborn HEAD never fall back', async () => {
  const root = await repo();
  await assert.rejects(collectReview({ repo_path: root, scope: 'branch', base_ref: '--bad' }), (e: any) => e.code === 'GIT_ERROR');
  const empty = await mkdtemp(join(tmpdir(), 'chat-mcp-empty-')); git(empty, 'init', '-q');
  await assert.rejects(collectReview({ repo_path: empty, scope: 'working_tree' }), (e: any) => e.code === 'GIT_ERROR');
});
test('explicit paths stay inside root; oversized inputs return an error', async () => {
  const root = await repo();
  await assert.rejects(collectAsk({ prompt: 'read', repo_path: root, context_paths: ['../escape'] }), (e: any) => e.code === 'INVALID_PATH');
  await writeFile(join(root, 'large.txt'), 'x'.repeat(50_000));
  await assert.rejects(collectAsk({ prompt: 'read', repo_path: root, context_paths: ['large.txt'] }), (e: any) => e.code === 'CONTEXT_TOO_LARGE');
});
test('path filters are literal, never git pathspec injection', async () => {
  const root = await repo();
  await writeFile(join(root, 'demo.py'), 'changed\n');
  await assert.rejects(collectReview({ repo_path: root, scope: 'working_tree', paths: [':(glob)**'] }), (e: any) => e.code === 'NO_REVIEWABLE_CHANGES');
});
test('ask context reports omissions and missing files explicitly', async () => {
  const root = await repo();
  const m = await collectAsk({ prompt: 'read', repo_path: root, context_paths: ['demo.py', '.env', 'extension/config.js'] });
  assert.match(m.prompt, /1: def add/); assert.equal(m.omitted[0].path, '.env');
  assert.equal(m.omitted[1].path, 'extension/config.js');
  await assert.rejects(collectAsk({ prompt: 'read', repo_path: root, context_paths: ['missing'] }), (e: any) => e.code === 'FILE_NOT_FOUND');
});

test('a clean repository can be reviewed without inventing a diff', async () => {
  const root = await repo();
  await writeFile(join(root, 'screenshot.jpg'), Buffer.from([0, 1, 2]));
  for (const paths of [undefined, ['demo.py']]) {
    const material = await collectReview({ repo_path: root, scope: 'working_tree', paths, question: 'Review structure.' });
    assert.deepEqual(material.files, ['demo.py']);
    assert.match(material.prompt, /CURRENT FILE \(no diff\)/);
    assert.match(material.prompt, /1: def add/);
  }
});

test('selected folders include unchanged code alongside changes without widening staged reviews', async () => {
  const root = await repo();
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'stable.ts'), 'UNCHANGED_SOURCE');
  await writeFile(join(root, 'src', 'changed.ts'), 'BEFORE');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'source');
  await writeFile(join(root, 'src', 'changed.ts'), 'AFTER');
  git(root, 'add', '.');
  const current = await collectReview({ repo_path: root, scope: 'working_tree', paths: ['src'] });
  assert.deepEqual(current.files, ['src/changed.ts', 'src/stable.ts']);
  assert.match(current.prompt, /UNCHANGED_SOURCE/);
  assert.match(current.prompt, /DIFF "src\/changed.ts"/);
  const staged = await collectReview({ repo_path: root, scope: 'staged', paths: ['src'] });
  assert.deepEqual(staged.files, ['src/changed.ts']);
});

test('dot segments cannot bypass pairing credential exclusions', async () => {
  const root = await repo();
  await mkdir(join(root, 'extension'));
  await writeFile(join(root, 'extension', 'config.js'), 'PAIRING_CREDENTIAL_FIXTURE');
  const m = await collectAsk({ prompt: 'read', repo_path: root,
    context_paths: ['././extension/config.js', 'extension/./config.js'] });
  assert.deepEqual(m.files, []);
  assert.equal(m.omitted.length, 2);
  assert.doesNotMatch(m.prompt, /PAIRING_CREDENTIAL_FIXTURE/);
});

test('review path filters accept dot segments and the repository root', async () => {
  const root = await repo();
  await writeFile(join(root, 'demo.py'), 'changed\n');
  for (const path of ['.', './', '././demo.py']) {
    assert.deepEqual((await collectReview({ repo_path: root, scope: 'working_tree', paths: [path] })).files, ['demo.py']);
  }
});

test('normalization cannot turn a relative path into a Windows drive path', () => {
  for (const path of ['././C:/tmp/file', './C:relative', '.\\.\\D:\\file', '//server/share', '../escape']) {
    assert.throws(() => safePath(path), (e: any) => e.code === 'INVALID_PATH');
  }
});

test('a source package named build is reviewed instead of classified as build output', async () => {
  const root = await repo();
  await mkdir(join(root, 'src', 'build'), { recursive: true });
  await writeFile(join(root, 'src', 'build', 'trainer.py'), 'SOURCE_TRAINER');
  const material = await collectReview({ repo_path: root, scope: 'working_tree', paths: ['src/build'] });
  assert.deepEqual(material.files, ['src/build/trainer.py']);
  assert.match(material.prompt, /SOURCE_TRAINER/);
});
