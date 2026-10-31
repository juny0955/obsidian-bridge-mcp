import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, day } from './vault.mjs';
import { ReviewerVault } from './reviewer-vault.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { vault: path.join(root, 'vault'), stateDir: path.join(root, 'state'), client: 'hermes', role: 'reviewer', enabled: true };
  fs.mkdirSync(config.vault);
  const put = (relative, content) => {
    const file = path.join(config.vault, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { root, config, put };
}
const sample = (status = 'review') => `---\ntype: knowledge\nstatus: ${status}\ncreated: 2020-01-01\nupdated: 2020-01-02\nsource: "original"\nrelated: ["[[other]]"]\n---\n\n# 원문\n\n검증.\n<!-- hermes-memory:${'a'.repeat(64)} -->\n`;

test('review candidates are global, sorted and frontmatter-only', t => {
  const { config, put } = fixture(t);
  const inbox = put('00-Inbox/가.md', sample());
  const knowledge = put('04-Knowledge/나.md', sample());
  put('01-Journal/다.md', sample('curated'));
  put('99-System/라.md', sample());
  put('02-Projects/마.md', '# body\nstatus: review\n');
  assert.deepEqual(new ReviewerVault(config).listReviewNotes(), [
    { path: '00-Inbox/가.md', sha256: hash(fs.readFileSync(inbox, 'utf8')), type: 'knowledge' },
    { path: '04-Knowledge/나.md', sha256: hash(fs.readFileSync(knowledge, 'utf8')), type: 'knowledge' },
  ]);
});
