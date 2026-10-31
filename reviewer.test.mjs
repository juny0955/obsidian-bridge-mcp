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

test('complete review in place preserves all content except status and updated', t => {
  const { config, put } = fixture(t);
  const relative = '04-Knowledge/주제.md';
  put(relative, sample());
  const reviewer = new ReviewerVault(config);
  const result = reviewer.completeReview({ path: relative, destination: relative, expected_sha256: hash(sample()), rationale: '출처와 중복 확인' });
  const after = fs.readFileSync(path.join(config.vault, relative), 'utf8');
  assert.equal(after, sample().replace('status: review', 'status: curated').replace('updated: 2020-01-02', `updated: ${day()}`));
  assert.deepEqual(result, { status: 'curated', path: relative, sha256: hash(after) });
});

test('review candidates exclude ambiguous status frontmatter', t => {
  const { config, put } = fixture(t);
  put('04-Knowledge/중복.md', sample().replace('status: review', 'status: review\nstatus: draft'));
  assert.deepEqual(new ReviewerVault(config).listReviewNotes(), []);
});

test('review rejects stale hashes and invalid status without changing the source', t => {
  const { config, put } = fixture(t);
  const relative = '04-Knowledge/주제.md';
  const file = put(relative, sample());
  const reviewer = new ReviewerVault(config);
  const args = { path: relative, destination: relative, expected_sha256: hash(sample()), rationale: '확인함' };
  for (const invalid of [
    { expected_sha256: '0'.repeat(64) }, { rationale: '' }, { path: '99-System/AI/금지.md' },
    { destination: '00-Inbox/주제.md' }, { destination: '06-Archive/주제.md' },
    { destination: '04-Knowledge/../주제.md' }, { expected_sha256: 'XYZ' },
  ]) assert.throws(() => reviewer.completeReview({ ...args, ...invalid }));
  for (const status of ['draft', 'evergreen', 'curated', 'review\nstatus: review']) {
    const original = sample().replace('status: review', `status: ${status}`);
    fs.writeFileSync(file, original);
    assert.throws(() => reviewer.completeReview({ ...args, expected_sha256: hash(original) }), /Status/u);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('review retry is idempotent and rejects a divergent audit record', t => {
  const { config, put } = fixture(t);
  const relative = '04-Knowledge/주제.md';
  const file = put(relative, sample());
  const reviewer = new ReviewerVault(config);
  const args = { path: relative, destination: relative, expected_sha256: hash(sample()), rationale: '확인함' };
  const first = reviewer.completeReview(args);
  const mtime = fs.statSync(file).mtimeMs;
  assert.deepEqual(reviewer.completeReview(args), first);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  fs.appendFileSync(file, '\n수동 수정\n');
  assert.throws(() => reviewer.completeReview(args), /record disagrees/u);
});

test('review moves an Inbox note without changing its body or provenance', t => {
  const { config, put } = fixture(t);
  const source = '00-Inbox/주제.md', destination = '04-Knowledge/주제.md';
  put(source, sample());
  const reviewer = new ReviewerVault(config);
  const args = { path: source, destination, expected_sha256: hash(sample()), rationale: '출처와 중복 확인' };
  const result = reviewer.completeReview(args);
  const after = reviewer.vault.read(destination);
  assert.equal(fs.existsSync(path.join(config.vault, source)), false);
  assert.equal(after.content, sample().replace('status: review', 'status: curated').replace('updated: 2020-01-02', `updated: ${day()}`));
  assert.deepEqual(result, { status: 'curated', path: destination, sha256: after.sha256 });
  assert.deepEqual(reviewer.completeReview(args), result);
});

test('review move rejects an existing destination without changing either file', t => {
  const { config, put } = fixture(t);
  const source = '00-Inbox/주제.md', destination = '04-Knowledge/주제.md';
  put(source, sample());
  const existing = put(destination, sample('curated'));
  const args = { path: source, destination, expected_sha256: hash(sample()), rationale: '확인함' };
  assert.throws(() => new ReviewerVault(config).completeReview(args), /Destination already exists/u);
  assert.equal(fs.readFileSync(existing, 'utf8'), sample('curated'));
  assert.equal(fs.readFileSync(path.join(config.vault, source), 'utf8'), sample());
  const errorsDir = path.join(config.stateDir, 'reviewer/errors');
  assert.equal(fs.readdirSync(errorsDir).length, 1);
  assert.equal(fs.statSync(path.join(errorsDir, fs.readdirSync(errorsDir)[0])).mode & 0o777, 0o600);
});

test('review move defers path links, relative links and duplicate basenames', t => {
  for (const [relative, content] of [
    ['02-Projects/링크.md', sample() + '\n[[00-Inbox/주제]]\n'],
    ['03-Areas/링크.md', sample() + '\nrelated: ["[[00-Inbox/주제]]"]\n'],
    ['02-Projects/링크.md', sample() + '\n[문서](../00-Inbox/주제.md)\n'],
    ['05-Resources/주제.md', sample('curated')],
  ]) {
    const tRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-risk-'));
    t.after(() => fs.rmSync(tRoot, { recursive: true, force: true }));
    const vault = path.join(tRoot, 'vault');
    fs.mkdirSync(vault);
    const put = (name, data) => {
      const file = path.join(vault, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    };
    const source = '00-Inbox/주제.md', destination = '04-Knowledge/주제.md';
    put(source, sample());
    put(relative, content);
    const reviewer = new ReviewerVault({ vault, stateDir: path.join(tRoot, 'state'), enabled: true });
    assert.throws(() => reviewer.completeReview({ path: source, destination, expected_sha256: hash(sample()), rationale: '확인함' }), /link|basename/iu);
    assert.equal(fs.readFileSync(path.join(vault, source), 'utf8'), sample());
    assert.equal(fs.existsSync(path.join(vault, destination)), false);
  }
});
