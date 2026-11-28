import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { canSelfInstall, isNewer, latestPublishedVersion, RELEASES_REPO } from '../electron/updater.js';

test('comparação de versões', () => {
  assert.equal(isNewer('0.4.1', '0.4.0'), true);
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.4.0', '0.4.0'), false);
  assert.equal(isNewer('0.3.9', '0.4.0'), false);
});

test('quem instala sozinho', () => {
  assert.equal(canSelfInstall('win32', {}), true);
  assert.equal(canSelfInstall('linux', { APPIMAGE: '/x.AppImage' }), true);
  assert.equal(canSelfInstall('linux', {}), false);
  assert.equal(canSelfInstall('darwin', {}), false);
});

test('RELEASES_REPO é o mesmo de build.publish (o workflow também confere)', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const [p] = pkg.build.publish;
  assert.equal(RELEASES_REPO, `${p.owner}/${p.repo}`);
});

test('lê a última versão pelo redirecionamento de /releases/latest', async () => {
  const fake = (status, location) => async () => new Response(null, { status, headers: location ? { location } : {} });
  assert.equal(await latestPublishedVersion('x', { fetchImpl: fake(302, 'https://github.com/o/r/releases/tag/v0.4.1') }), '0.4.1');
  assert.equal(await latestPublishedVersion('x', { fetchImpl: fake(302, 'https://github.com/o/r/releases') }), null);
  assert.equal(await latestPublishedVersion('x', { fetchImpl: fake(404) }), null);
  await assert.rejects(latestPublishedVersion('x', { fetchImpl: fake(500) }), /500/);
});
