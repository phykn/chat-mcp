import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const extensionFiles = ['manifest.json', 'background.js', 'page.js', 'popup.html', 'popup.js', 'content.js'];

export async function prepareExtension(root, dataDir, token) {
  const extensionDir = join(dataDir, 'extension');
  await mkdir(extensionDir, { recursive: true });
  const digest = createHash('sha256');
  for (const file of extensionFiles) {
    digest.update(await readFile(join(root, 'extension', file)));
    await cp(join(root, 'extension', file), join(extensionDir, file));
  }
  const revision = digest.digest('hex');
  const config = `export const token = ${JSON.stringify(token)};\nexport const revision = ${JSON.stringify(revision)};\n`;
  await writeFile(join(extensionDir, 'config.js'), config, { mode: 0o600 });
  // Keep an already-loaded extension from the old checkout usable during migration.
  const legacy = join(root, 'extension', 'config.js');
  try {
    if ((await readFile(legacy, 'utf8')).includes(`export const token = ${JSON.stringify(token)};`))
      await writeFile(legacy, config, { mode: 0o600 });
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { extensionDir, revision };
}
