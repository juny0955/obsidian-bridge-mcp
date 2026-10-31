import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from './vault.mjs';
import { CuratorVault } from './curator-vault.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(vault);
  const put = (relative, content) => {
    const file = path.join(vault, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const config = { vault, stateDir, role: 'curator', enabled: true, allowMoves: true, allowOrganization: true, allowTrash: true, trashRetentionDays: 15 };
  return { root, vault, stateDir, config, put };
}

const sample = (status = 'review') => `---\ntype: knowledge\nstatus: ${status}\ncreated: 2020-01-01\nupdated: 2020-01-02\nsource: "original"\nrelated: ["[[other]]"]\n---\n\n# 원문\n\n검증된 고유 내용.\n<!-- hermes-memory:${'a'.repeat(64)} -->\n`;

function callServer(t, config, requests) {
  const configPath = path.join(config.stateDir, '..', 'curator.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const result = spawnSync(process.execPath, [new URL('./curator-server.mjs', import.meta.url).pathname], {
    cwd: config.vault, env: { ...process.env, OBSIDIAN_CURATOR_CONFIG: configPath },
    input: requests.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map(JSON.parse);
}

test('Curator MCP exposes management tools but never exposes permanent deletion', t => {
  const { config } = fixture(t);
  const replies = callServer(t, config, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  assert.equal(replies[0].result.serverInfo.name, 'obsidian_curator');
  const names = replies[1].result.tools.map(tool => tool.name);
  for (const name of ['get_context', 'list_review_notes', 'read_note', 'record_review', 'organize_note', 'merge_notes', 'trash_note', 'list_trash', 'restore_note', 'list_pending_deletions', 'prepare_deletion_requests', 'finalize_review']) assert.ok(names.includes(name), name);
  assert.ok(!names.some(name => /delete|approve|discord/iu.test(name)));
});

test('Curator rejects conflicting config variables and accepts the legacy Reviewer variable', t => {
  const { root, config } = fixture(t);
  const current = path.join(root, 'curator.json'), legacy = path.join(root, 'reviewer.json');
  fs.writeFileSync(current, JSON.stringify(config));
  fs.writeFileSync(legacy, JSON.stringify({ ...config, role: 'reviewer' }));
  const script = new URL('./curator-server.mjs', import.meta.url).pathname;
  const conflict = spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, OBSIDIAN_CURATOR_CONFIG: current, OBSIDIAN_REVIEWER_CONFIG: legacy }, input: '', encoding: 'utf8', timeout: 10000 });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /config paths conflict/iu);
  const fallback = spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, OBSIDIAN_REVIEWER_CONFIG: legacy }, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(JSON.parse(fallback.stdout).result.serverInfo.name, 'obsidian_curator');
});

test('review stage records evidence without changing note status or bytes', t => {
  const { config, put, vault, stateDir } = fixture(t);
  const relative = '00-Inbox/topic.md';
  const original = Buffer.from(sample());
  put(relative, original);
  const curator = new CuratorVault(config);
  const result = curator.recordReview({ operation_id: 'review-1', path: relative, expected_sha256: hash(original), rationale: '출처와 중복 확인' });
  assert.equal(result.status, 'reviewed');
  assert.deepEqual(fs.readFileSync(path.join(vault, relative)), original);
  const record = JSON.parse(fs.readFileSync(path.join(stateDir, 'curator/reviews', `review-1-${hash(relative)}.json`), 'utf8'));
  assert.equal(record.sha256, hash(original));
});

test('organize_note updates body while preserving frontmatter and writer markers', t => {
  const { config, put, vault } = fixture(t);
  const relative = '04-Knowledge/topic.md';
  const original = sample();
  put(relative, original);
  const curator = new CuratorVault(config);
  curator.recordReview({ operation_id: 'op-1', path: relative, expected_sha256: hash(original), rationale: '검토 완료' });
  const current = curator.vault.read(relative);
  const result = curator.organizeNote({ operation_id: 'op-1', path: relative, expected_sha256: current.sha256, new_body: '# 정리된 제목\n\n검증된 고유 내용.\n<!-- hermes-memory:' + 'a'.repeat(64) + ' -->\n', rationale: '제목과 구조를 정리' });
  const after = fs.readFileSync(path.join(vault, relative), 'utf8');
  assert.equal(result.status, 'organized');
  assert.ok(after.startsWith('---\ntype: knowledge\nstatus: review\ncreated: 2020-01-01\n'));
  assert.ok(after.includes('source: "original"'));
  assert.ok(after.includes('related: ["[[other]]"]'));
  assert.ok(after.includes('<!-- hermes-memory:' + 'a'.repeat(64) + ' -->'));
  assert.ok(after.includes('# 정리된 제목'));
  assert.ok(!after.includes('# 원문'));
});

test('organize_note rejects stale hashes and missing original unique content without changing source', t => {
  const { config, put, vault } = fixture(t);
  const relative = '04-Knowledge/topic.md';
  const original = sample();
  const file = put(relative, original);
  const curator = new CuratorVault(config);
  curator.recordReview({ operation_id: 'op-2', path: relative, expected_sha256: hash(original), rationale: '검토 완료' });
  assert.throws(() => curator.organizeNote({ operation_id: 'op-2', path: relative, expected_sha256: '0'.repeat(64), new_body: '# 변경\n\n내용', rationale: '정리' }), /changed|hash|SHA/iu);
  const current = curator.vault.read(relative);
  assert.throws(() => curator.organizeNote({ operation_id: 'op-2', path: relative, expected_sha256: current.sha256, new_body: '# 변경\n\n다른 내용', rationale: '정리' }), /preserv|marker|original/iu);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('merge_notes verifies both source hashes then trashes redundant source under 99-System/Trash', t => {
  const { config, put, vault } = fixture(t);
  const targetPath = '04-Knowledge/target.md';
  const sourcePath = '00-Inbox/source.md';
  const target = sample();
  const source = sample().replace('검증된 고유 내용.', '추가로 검증된 정보.');
  put(targetPath, target);
  put(sourcePath, source);
  const curator = new CuratorVault(config);
  curator.recordReview({ operation_id: 'merge-1', path: targetPath, expected_sha256: hash(target), rationale: '검토' });
  curator.recordReview({ operation_id: 'merge-1', path: sourcePath, expected_sha256: hash(source), rationale: '검토' });
  const result = curator.mergeNotes({ operation_id: 'merge-1', target_path: targetPath, target_sha256: hash(target), source_path: sourcePath, source_sha256: hash(source), merged_body: '# 통합 노트\n\n검증된 고유 내용.\n\n추가로 검증된 정보.\n<!-- hermes-memory:' + 'a'.repeat(64) + ' -->\n', rationale: '두 노트의 고유 내용을 통합' });
  assert.equal(result.status, 'merged');
  assert.deepEqual(curator.mergeNotes({ operation_id: 'merge-1', target_path: targetPath, target_sha256: hash(target), source_path: sourcePath, source_sha256: hash(source), merged_body: '# 통합 노트\n\n검증된 고유 내용.\n\n추가로 검증된 정보.\n<!-- hermes-memory:' + 'a'.repeat(64) + ' -->\n', rationale: '두 노트의 고유 내용을 통합' }), result);
  assert.equal(fs.existsSync(path.join(vault, sourcePath)), false);
  assert.ok(fs.existsSync(path.join(vault, '99-System/Trash/merge-1/source.md')));
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, '99-System/Trash/merge-1/manifest.json'), 'utf8'));
  assert.equal(manifest.original_path, sourcePath);
  assert.equal(manifest.sha256, hash(source));
  assert.ok(fs.readFileSync(path.join(vault, targetPath), 'utf8').includes('추가로 검증된 정보.'));
});

test('trash restore refuses an occupied original path and restores exact bytes when free', t => {
  const { config, put, vault } = fixture(t);
  const sourcePath = '00-Inbox/source.md';
  const original = sample();
  put(sourcePath, original);
  const curator = new CuratorVault(config);
  curator.recordReview({ operation_id: 'trash-1', path: sourcePath, expected_sha256: hash(original), rationale: '검토' });
  const moved = curator.trashNote({ operation_id: 'trash-1', path: sourcePath, expected_sha256: hash(original), rationale: '사용자 요청으로 보관' });
  assert.equal(moved.status, 'trashed');
  assert.deepEqual(curator.trashNote({ operation_id: 'trash-1', path: sourcePath, expected_sha256: hash(original), rationale: '사용자 요청으로 보관' }), moved);
  put(sourcePath, 'occupying content');
  assert.throws(() => curator.restoreNote({ operation_id: 'trash-1' }), /occupied|exists/iu);
  assert.equal(fs.existsSync(path.join(vault, sourcePath)), true);
  fs.unlinkSync(path.join(vault, sourcePath));
  const restored = curator.restoreNote({ operation_id: 'trash-1' });
  assert.equal(restored.status, 'restored');
  assert.deepEqual(curator.restoreNote({ operation_id: 'trash-1' }), restored);
  assert.deepEqual(fs.readFileSync(path.join(vault, sourcePath)), Buffer.from(original));
});

test('finalize_review requires recorded review, sets curated last, and is idempotent', t => {
  const { config, put, vault } = fixture(t);
  const relative = '04-Knowledge/final.md', original = sample();
  put(relative, original);
  const curator = new CuratorVault(config);
  assert.throws(() => curator.finalizeReview({ operation_id: 'final-1', path: relative, expected_sha256: hash(original) }), /Review stage/iu);
  curator.recordReview({ operation_id: 'final-1', path: relative, expected_sha256: hash(original), rationale: '출처와 내용 확인' });
  const first = curator.finalizeReview({ operation_id: 'final-1', path: relative, expected_sha256: hash(original) });
  assert.equal(first.status, 'curated');
  assert.match(fs.readFileSync(path.join(vault, relative), 'utf8'), /^---\ntype: knowledge\nstatus: curated/mu);
  assert.deepEqual(curator.finalizeReview({ operation_id: 'final-1', path: relative, expected_sha256: first.sha256 }), first);
});

test('finalize_review accepts the latest organized hash and preserves the completed body', t => {
  const { config, put, vault } = fixture(t);
  const relative = '04-Knowledge/organized.md', original = sample();
  put(relative, original);
  const curator = new CuratorVault(config);
  curator.recordReview({ operation_id: 'final-2', path: relative, expected_sha256: hash(original), rationale: '검토' });
  const updated = curator.organizeNote({ operation_id: 'final-2', path: relative, expected_sha256: hash(original), new_body: '# 재구성\n\n검증된 고유 내용.\n<!-- hermes-memory:' + 'a'.repeat(64) + ' -->\n', rationale: '제목을 다듬음' });
  const final = curator.finalizeReview({ operation_id: 'final-2', path: relative, expected_sha256: updated.sha256 });
  const content = fs.readFileSync(path.join(vault, relative), 'utf8');
  assert.match(content, /^status: curated/mu);
  assert.ok(content.includes('# 재구성'));
  assert.ok(content.includes('source: "original"'));
  assert.equal(final.status, 'curated');
});

test('finalize_review journal resumes after a failure before the atomic note write', t => {
  const { config, put, vault } = fixture(t);
  const relative = '04-Knowledge/recover-final.md', original = sample();
  put(relative, original);
  const curator = new CuratorVault(config, { now: () => new Date('2026-02-03T12:00:00.000Z') });
  curator.recordReview({ operation_id: 'final-recover', path: relative, expected_sha256: hash(original), rationale: '확인' });
  curator.atomicReplace = () => { throw new Error('fault injection'); };
  assert.throws(() => curator.finalizeReview({ operation_id: 'final-recover', path: relative, expected_sha256: hash(original) }), /fault injection/iu);
  assert.equal(fs.readFileSync(path.join(vault, relative), 'utf8'), original);
  const resumed = new CuratorVault(config, { now: () => new Date('2026-02-04T12:00:00.000Z') });
  const result = resumed.finalizeReview({ operation_id: 'final-recover', path: relative, expected_sha256: hash(original) });
  assert.equal(result.status, 'curated');
  assert.match(fs.readFileSync(path.join(vault, relative), 'utf8'), /^updated: 2026-02-03/mu);
});

test('finalize_review reconciles an atomic note write completed before its audit update', t => {
  const { config, put, vault } = fixture(t);
  const relative = '04-Knowledge/reconcile-final.md', original = sample();
  put(relative, original);
  const curator = new CuratorVault(config, { now: () => new Date('2026-02-03T12:00:00.000Z') });
  curator.recordReview({ operation_id: 'final-reconcile', path: relative, expected_sha256: hash(original), rationale: '확인' });
  const write = curator.writeJsonReplace.bind(curator);
  let failOnce = true;
  curator.writeJsonReplace = (file, value) => {
    if (failOnce && value.stage === 'curated') { failOnce = false; throw new Error('audit write fault'); }
    return write(file, value);
  };
  assert.throws(() => curator.finalizeReview({ operation_id: 'final-reconcile', path: relative, expected_sha256: hash(original) }), /audit write fault/iu);
  const changed = curator.vault.read(relative);
  assert.match(changed.content, /^status: curated/mu);
  const resumed = new CuratorVault(config);
  assert.deepEqual(resumed.finalizeReview({ operation_id: 'final-reconcile', path: relative, expected_sha256: changed.sha256 }), { status: 'curated', path: relative, sha256: changed.sha256 });
});

test('mutation switches are fail-closed when omitted', t => {
  const { config, put, vault } = fixture(t);
  const relative = '04-Knowledge/locked.md', original = sample();
  put(relative, original);
  const curator = new CuratorVault({ ...config, allowOrganization: false, allowTrash: false });
  curator.recordReview({ operation_id: 'locked-1', path: relative, expected_sha256: hash(original), rationale: '검토' });
  assert.throws(() => curator.organizeNote({ operation_id: 'locked-1', path: relative, expected_sha256: hash(original), new_body: '# 변경', rationale: '정리' }), /disabled/iu);
  assert.equal(fs.readFileSync(path.join(vault, relative), 'utf8'), original);
  assert.throws(() => curator.trashNote({ operation_id: 'locked-1', path: relative, expected_sha256: hash(original), rationale: '휴지통' }), /disabled/iu);
});

test('merge defers on aliased heading wikilinks to the source and writes neither note', t => {
  const { config, put, vault } = fixture(t);
  const targetPath = '04-Knowledge/target.md', sourcePath = '00-Inbox/source.md';
  const target = sample(), source = sample().replace('검증된 고유 내용.', '출처 고유 내용.');
  put(targetPath, target); put(sourcePath, source);
  put('02-Projects/link.md', sample('curated') + '\n[[source#heading|별칭]]\n');
  const curator = new CuratorVault(config);
  for (const [pathName, content] of [[targetPath, target], [sourcePath, source]]) curator.recordReview({ operation_id: 'merge-link', path: pathName, expected_sha256: hash(content), rationale: '검토' });
  assert.throws(() => curator.mergeNotes({ operation_id: 'merge-link', target_path: targetPath, target_sha256: hash(target), source_path: sourcePath, source_sha256: hash(source), merged_body: '# 합침\n검증된 고유 내용.\n출처 고유 내용.\n<!-- hermes-memory:' + 'a'.repeat(64) + ' -->', rationale: '출처를 통합' }), /wikilink/u);
  assert.equal(fs.readFileSync(path.join(vault, targetPath), 'utf8'), target);
  assert.equal(fs.readFileSync(path.join(vault, sourcePath), 'utf8'), source);
});

test('review queue cursor visits every candidate and reports unreadable or ambiguous entries', t => {
  const { config, put } = fixture(t);
  for (let i = 0; i < 35; i++) put(`04-Knowledge/${String(i).padStart(2, '0')}.md`, sample());
  put('04-Knowledge/zzz-duplicate.md', sample().replace('status: review', 'status: review\nstatus: draft'));
  put('04-Knowledge/zzz-large.md', `---\ntype: knowledge\nstatus: review\n---\n${'x'.repeat(300001)}`);
  const curator = new CuratorVault(config);
  const first = curator.listReviewNotesDetailed();
  assert.equal(first.items.length, 30);
  assert.equal(first.has_more, true);
  const second = curator.listReviewNotesDetailed(first.next_cursor);
  assert.equal(second.items.length, 5);
  assert.equal(second.total_reviewable, 35);
  assert.equal(second.has_more, false);
  assert.equal(second.skipped.length, 2);
  assert.ok(second.skipped.some(item => item.reason === 'duplicate_status'));
  assert.ok(second.skipped.some(item => item.reason.includes('too large')));
  assert.equal(new Set([...first.items, ...second.items].map(item => item.path)).size, 35);
});

test('review queue rejects a cursor after the vault note set changes', t => {
  const { config, put } = fixture(t);
  for (let i = 0; i < 31; i++) put(`04-Knowledge/${String(i).padStart(2, '0')}.md`, sample());
  const curator = new CuratorVault(config);
  const first = curator.listReviewNotesDetailed();
  put('04-Knowledge/new.md', sample());
  assert.throws(() => curator.listReviewNotesDetailed(first.next_cursor), /stale.*cursor/iu);
});

test('15-day expiry creates an approval request record but never permanently deletes', t => {
  const { config, put, vault, stateDir } = fixture(t);
  const sourcePath = '00-Inbox/old.md';
  const original = sample();
  put(sourcePath, original);
  let current = new Date('2026-01-15T23:59:59.999Z');
  const curator = new CuratorVault(config, { now: () => current });
  curator.recordReview({ operation_id: 'trash-old', path: sourcePath, expected_sha256: hash(original), rationale: '검토' });
  curator.trashNote({ operation_id: 'trash-old', path: sourcePath, expected_sha256: hash(original), rationale: '중복 통합' });
  const manifestPath = path.join(vault, '99-System/Trash/trash-old/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.moved_at = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(curator.listPendingDeletions().length, 0);
  current = new Date('2026-01-16T00:00:00.000Z');
  const expired = curator.listPendingDeletions();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].operation_id, 'trash-old');
  assert.equal(fs.existsSync(path.join(vault, '99-System/Trash/trash-old', path.basename(sourcePath))), true);
  assert.equal(fs.readdirSync(path.join(stateDir, 'curator')).includes('permanent-delete'), false);
  const requests = curator.prepareDeletionRequests();
  const retry = curator.prepareDeletionRequests();
  assert.equal(requests[0].request_id, `${'trash-old'}-${hash(original).slice(0, 16)}`);
  assert.equal(requests[0].discord_sent, false);
  assert.equal(requests[0].can_permanently_delete, false);
  assert.equal(retry[0].request_id, requests[0].request_id);
  assert.equal(retry[0].requested_at, requests[0].requested_at);
  const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(updatedManifest.approval_request.status, 'not_sent_discord_out_of_scope');
  assert.equal(fs.existsSync(path.join(vault, '99-System/Trash/trash-old', path.basename(sourcePath))), true);
});

test('move reviewed inbox note without changing bytes then finalize destination', t => {
  const { config, put, vault } = fixture(t);
  const source = '00-Inbox/topic.md', destination = '04-Knowledge/topic.md', original = sample(), op = 'move-happy';
  put(source, original); fs.mkdirSync(path.join(vault, '04-Knowledge'));
  const curator = new CuratorVault(config);
  curator.recordReview({ operation_id: op, path: source, expected_sha256: hash(original), rationale: '검토 완료' });
  const moved = curator.moveNote({ operation_id: op, path: source, destination, expected_sha256: hash(original), rationale: '지식으로 분류' });
  assert.deepEqual(moved, {status:'moved', operation_id:op, source_path:source, path:destination, sha256:hash(original)});
  assert.equal(fs.existsSync(path.join(vault, source)), false);
  assert.equal(fs.readFileSync(path.join(vault, destination), 'utf8'), original);
  const done = curator.finalizeReview({ operation_id: op, path: destination, expected_sha256: moved.sha256 });
  assert.equal(done.status, 'curated');
  assert.match(fs.readFileSync(path.join(vault, destination), 'utf8'), /^status: curated$/mu);
  assert.deepEqual(curator.moveNote({ operation_id: op, path: source, destination, expected_sha256: hash(original), rationale: '지식으로 분류' }), moved);
});

test('incomplete move cannot be finalized using independently recorded destination review', t => {
  const { config, put, vault } = fixture(t), source = '00-Inbox/topic.md', destination = '04-Knowledge/topic.md', original = sample(), op = 'move-interrupted';
  put(source, original); fs.mkdirSync(path.join(vault, '04-Knowledge'));
  const curator = new CuratorVault(config), args = {operation_id:op, path:source, destination, expected_sha256:hash(original), rationale:'분류'};
  curator.recordReview({operation_id:op, path:source, expected_sha256:hash(original), rationale:'검토'});
  const write = curator.writeJsonReplace.bind(curator);
  curator.writeJsonReplace = (file, value) => { if (value.stage === 'destination_verified') throw new Error('injected'); return write(file, value); };
  assert.throws(() => curator.moveNote(args), /injected/u);
  assert.throws(() => curator.recordReview({operation_id:'other', path:destination, expected_sha256:hash(original), rationale:'검토'}), /move|journal/iu);
  assert.throws(() => curator.finalizeReview({operation_id:'other', path:destination, expected_sha256:hash(original)}), /move|journal/iu);
  assert.equal(fs.readFileSync(path.join(vault,destination),'utf8'), original);
});

test('interrupted verified destination retains copies and refuses automatic deletion', t => {
  const { config, put, vault } = fixture(t), source = '00-Inbox/topic.md', destination = '04-Knowledge/topic.md', original = sample(), op = 'move-fault';
  put(source, original); fs.mkdirSync(path.join(vault, '04-Knowledge'));
  const curator = new CuratorVault(config), args = {operation_id:op, path:source, destination, expected_sha256:hash(original), rationale:'분류'};
  curator.recordReview({operation_id:op, path:source, expected_sha256:hash(original), rationale:'검토'});
  const write = curator.writeJsonReplace.bind(curator);
  curator.writeJsonReplace = (file, value) => { write(file, value); if (value.stage === 'destination_verified') throw new Error('injected'); };
  assert.throws(() => curator.moveNote(args), /injected/u);
  curator.writeJsonReplace = write;
  assert.throws(() => curator.moveNote(args), /manual recovery/iu);
  assert.equal(fs.readFileSync(path.join(vault,source),'utf8'), original);
  assert.equal(fs.readFileSync(path.join(vault,destination),'utf8'), original);
  assert.equal(fs.readFileSync(path.join(config.stateDir,'curator/backups',op,`${hash(source)}-${hash(original)}.md`),'utf8'), original);
});


test('move and merge share an operation ID lock even with different paths', t => {
  const { config, put, vault } = fixture(t), source = '00-Inbox/topic.md', destination = '04-Knowledge/topic.md', original = sample(), op = 'same-op';
  put(source, original); fs.mkdirSync(path.join(vault, '04-Knowledge'));
  const curator = new CuratorVault(config);
  curator.recordReview({operation_id:op, path:source, expected_sha256:hash(original), rationale:'검토'});
  curator.withLocks([`\0operation:${op}`], () => {
    assert.throws(() => curator.moveNote({operation_id:op, path:source, destination, expected_sha256:hash(original), rationale:'분류'}), /modified/u);
    assert.throws(() => curator.mergeNotes({operation_id:op, source_path:'04-Knowledge/other.md', target_path:'04-Knowledge/target.md'}), /modified/u);
  });
  assert.equal(fs.readFileSync(path.join(vault, source), 'utf8'), original);
});


test('move link scan includes hidden uppercase Markdown and canvas', t => {
  for (const reference of ['.hidden/link.MD', 'Archive/ref.CANVAS']) {
    const {config, put, vault} = fixture(t), source = '00-Inbox/topic.md', destination = '04-Knowledge/topic.md', original = sample();
    put(source, original); put(reference, '[[topic]]'); fs.mkdirSync(path.join(vault, '04-Knowledge'));
    const c = new CuratorVault(config), op = 'link-check';
    c.recordReview({operation_id:op, path:source, expected_sha256:hash(original), rationale:'검토'});
    assert.throws(() => c.moveNote({operation_id:op, path:source, destination, expected_sha256:hash(original), rationale:'분류'}), /link scan/iu);
    assert.equal(fs.readFileSync(path.join(vault, source), 'utf8'), original);
  }
});
