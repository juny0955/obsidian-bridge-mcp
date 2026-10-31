import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReviewerVault } from './reviewer-vault.mjs';
import { hash, check, text } from './vault.mjs';

const operationId = value => {
  text(value, 'operation_id', 100);
  check(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value), 'Invalid operation_id');
  return value;
};
const safeRelative = value => {
  text(value, 'path', 500);
  check(!value.startsWith('/') && value.split('/').every(part => part && !part.startsWith('.') && !part.includes('\\') && !/[\x00-\x1f]/u.test(part)), 'Unsafe path');
  return value;
};
const safeRationale = value => {
  const rationale = text(value, 'rationale', 500).trim();
  check(!/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-proj-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/u.test(rationale), 'Possible credential in rationale');
  return rationale;
};
const frontmatter = content => {
  const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u);
  check(match, 'Missing frontmatter');
  check((match[2].match(/^status\s*:/gmu) ?? []).length === 1 && /^status: review$/mu.test(match[2]), 'Status must be exactly review');
  return match;
};
const bodyOf = content => { const front = frontmatter(content); return content.slice(front[0].length); };
const tokens = body => [
  ...(body.match(/<!-- (?:codex|hermes)-memory:[a-f0-9]{64} -->/gu) ?? []),
  ...(body.match(/\[\[[^\]\n]+\]\]/gu) ?? []),
  ...(body.match(/\bhttps?:\/\/[^\s)]+/gu) ?? []),
];

const durableWrite = (file, bytes, mode = 0o600) => {
  const fd = fs.openSync(file, 'wx', mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const syncDirectory = directory => {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

export class CuratorVault extends ReviewerVault {
  constructor(config, { now = () => new Date() } = {}) {
    super({ ...config, client: 'hermes' });
    this.now = now;
    check(config.trashRetentionDays === undefined || config.trashRetentionDays === 15, 'Curator retention is fixed at 15 days');
    this.trashRetentionDays = 15;
    this.curatorRoot = path.join(this.config.stateDir, 'curator');
    if (fs.existsSync(this.curatorRoot)) check(!fs.lstatSync(this.curatorRoot).isSymbolicLink(), 'Curator state path is unsafe');
    else fs.mkdirSync(this.curatorRoot, { recursive: true, mode: 0o700 });
  }
  withLocks(paths, work) {
    const locks = [...new Set(paths)].map(relative => path.join(this.config.stateDir, `${hash(relative)}.lock`)).sort();
    const acquired = [];
    try {
      for (const lock of locks) {
        try { fs.mkdirSync(lock, { mode: 0o700 }); acquired.push(lock); }
        catch (error) { if (error.code === 'EEXIST') throw new Error('Note is being modified; reread and retry'); throw error; }
      }
      return work();
    } finally { acquired.reverse().forEach(lock => { try { fs.rmdirSync(lock); } catch { /* keep the primary operation error */ } }); }
  }
  isoNow() { return this.now().toISOString(); }
  reviewPath(op, relative) { return path.join(this.curatorRoot, 'reviews', `${op}-${hash(relative)}.json`); }
  operationPath(op) { return path.join(this.curatorRoot, 'operations', `${operationId(op)}.json`); }
  readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    durableWrite(temp, JSON.stringify(value, null, 2) + '\n');
    try { fs.linkSync(temp, file); syncDirectory(path.dirname(file)); } finally { fs.unlinkSync(temp); }
  }
  writeJsonReplace(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    durableWrite(temp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, file);
    syncDirectory(path.dirname(file));
  }
  trashRoot(create = false) {
    const systemDir = path.join(this.vault.root, '99-System');
    const trashDir = path.join(systemDir, 'Trash');
    for (const dir of [systemDir, trashDir]) {
      if (fs.existsSync(dir)) check(!fs.lstatSync(dir).isSymbolicLink() && fs.statSync(dir).isDirectory(), 'Trash path is unsafe');
      else if (create) { fs.mkdirSync(dir, { mode: 0o700 }); syncDirectory(path.dirname(dir)); }
      else return trashDir;
    }
    return trashDir;
  }
  trashEntry(op) {
    const dir = path.join(this.trashRoot(false), operationId(op));
    check(fs.existsSync(dir) && !fs.lstatSync(dir).isSymbolicLink(), 'Trash entry not found');
    const manifestPath = path.join(dir, 'manifest.json');
    check(fs.existsSync(manifestPath) && !fs.lstatSync(manifestPath).isSymbolicLink(), 'Trash manifest missing');
    const manifest = this.readJson(manifestPath);
    check(manifest.operation_id === op && typeof manifest.original_path === 'string', 'Invalid trash manifest');
    safeRelative(manifest.original_path);
    const file = path.join(dir, path.basename(manifest.original_path));
    check(fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).isFile(), 'Trash payload missing');
    check(hash(fs.readFileSync(file)) === manifest.sha256, 'Trash payload hash mismatch');
    return { dir, file, manifestPath, manifest };
  }
  assertNoPendingMove(relative) {
    const dir = path.join(this.curatorRoot, 'operations');
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      check(entry.isFile() && !entry.isSymbolicLink(), 'Move journal unsafe');
      let journal;
      try { journal = this.readJson(path.join(dir, entry.name)); } catch { throw new Error('Move journal unreadable; manual recovery required'); }
      check(journal && ['move', 'merge'].includes(journal.type) && typeof journal.stage === 'string', 'Move journal invalid; manual recovery required');
      if (journal.type === 'move') {
        check(typeof journal.destination === 'string' && ['prepared', 'destination_verified', 'source_removed', 'committed'].includes(journal.stage), 'Move journal invalid; manual recovery required');
        check(journal.destination !== relative || journal.stage === 'committed', 'Move journal not committed; manual recovery required');
      }
    }
  }
  recordReview(args) {
    const relative = safeRelative(args.path);
    return this.withLocks([relative], () => this.recordReviewLocked(args));
  }
  recordReviewLocked(args) {
    const op = operationId(args.operation_id), relative = safeRelative(args.path);
    const rationale = safeRationale(args.rationale);
    check(this.config.enabled === true && this.config.role === 'curator', 'Curator is disabled');
    this.assertNoPendingMove(relative);
    const note = this.vault.read(relative);
    check(note.sha256 === args.expected_sha256, 'Note changed: read again');
    frontmatter(note.content);
    const file = this.reviewPath(op, relative);
    const record = { operation_id: op, path: relative, sha256: note.sha256, rationale, reviewed_at: this.isoNow(), stage: 'reviewed' };
    if (fs.existsSync(file)) {
      const previous = this.readJson(file);
      check(previous.path === relative && previous.sha256 === note.sha256 && previous.rationale === rationale, 'Review operation conflicts with existing record');
      return { ...previous, status: 'reviewed' };
    }
    this.writeJson(file, record);
    return { ...record, status: 'reviewed' };
  }
  requireReview(op, relative, sha) {
    const file = this.reviewPath(op, relative);
    check(fs.existsSync(file), 'Review stage required before organization');
    const record = this.readJson(file);
    check(record.path === relative && (record.sha256 === sha || (['organized', 'finalizing', 'curated'].includes(record.stage) && (record.organized_sha256 === sha || record.curated_sha256 === sha))), 'Review evidence is stale');
    return { file, record };
  }
  backup(op, relative, bytes) {
    const dir = path.join(this.curatorRoot, 'backups', op);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${hash(relative)}-${hash(bytes)}.md`);
    if (!fs.existsSync(file)) { durableWrite(file, bytes); syncDirectory(dir); }
    else check(hash(fs.readFileSync(file)) === hash(bytes), 'Backup conflicts with existing operation');
    return file;
  }
  atomicReplace(relative, bytes, expectedSha) {
    const target = this.vault.target(relative);
    const before = this.vault.read(relative);
    check(before.sha256 === expectedSha, 'Note changed before write');
    const temp = `${target}.${randomUUID()}.tmp`;
    durableWrite(temp, bytes, fs.statSync(target).mode & 0o777);
    try {
      check(this.vault.read(relative).sha256 === expectedSha, 'Note changed during write');
      fs.renameSync(temp, target);
      syncDirectory(path.dirname(target));
      const after = this.vault.read(relative);
      check(hash(Buffer.from(after.content)) === after.sha256, 'Readback hash mismatch');
      return after;
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  organizeNote(args) {
    const relative = safeRelative(args.path);
    return this.withLocks([relative], () => this.organizeNoteLocked(args));
  }
  organizeNoteLocked(args) {
    const op = operationId(args.operation_id), relative = safeRelative(args.path);
    check(this.config.enabled === true && this.config.allowOrganization === true, 'Organization is disabled');
    const before = this.vault.read(relative);
    check(before.sha256 === args.expected_sha256, 'Note changed: read again');
    const evidence = this.requireReview(op, relative, before.sha256);
    const rationale = safeRationale(args.rationale);
    const front = frontmatter(before.content);
    check(front[2].split('\n').filter(line => line.startsWith('updated:')).length <= 1, 'Duplicate updated property');
    const newBody = text(args.new_body, 'new_body', 280000).replace(/^\r?\n/u, '');
    const oldBody = bodyOf(before.content), oldTokens = tokens(oldBody), nextTokens = tokens(newBody);
    for (const token of oldTokens) check(nextTokens.includes(token), `Cannot remove original link or provenance marker: ${token}`);
    check(nextTokens.filter(token => /memory:[a-f0-9]{64}/u.test(token)).length === oldTokens.filter(token => /memory:[a-f0-9]{64}/u.test(token)).length, 'Memory markers must be preserved exactly');
    const newline = front[1].includes('\r\n') ? '\r\n' : '\n';
    let metadata = front[2];
    metadata = /^updated:.*$/mu.test(metadata) ? metadata.replace(/^updated:.*$/mu, `updated: ${this.now().toISOString().slice(0, 10)}`) : `${metadata}${newline}updated: ${this.now().toISOString().slice(0, 10)}`;
    const bytes = Buffer.from(front[1] + metadata + front[3] + newline + newline + newBody.trim() + newline, 'utf8');
    this.backup(op, relative, fs.readFileSync(this.vault.target(relative)));
    const after = this.atomicReplace(relative, bytes, before.sha256);
    this.writeJsonReplace(evidence.file, { ...evidence.record, stage: 'organized', organization_rationale: rationale, organized_sha256: after.sha256, organized_at: this.isoNow() });
    return { status: 'organized', path: relative, sha256: after.sha256 };
  }
  assertMoveSafe(source) {
    const normalized = source.slice(0, -3).toLocaleLowerCase();
    const base = path.posix.basename(normalized);
    for (const reference of this.moveReferences()) {
      if (reference !== source && reference.toLocaleLowerCase().endsWith('.md') && path.posix.basename(reference, path.posix.extname(reference)).toLocaleLowerCase() === base) throw new Error('Link scan: duplicate basename; manual review required');
      const content = this.readMoveReference(reference);
      let decoded;
      try { decoded = decodeURIComponent(content); } catch { throw new Error('Link scan: ambiguous encoding'); }
      const lower = decoded.toLocaleLowerCase();
      check(!lower.includes(normalized), 'Link scan: path reference');
      check(!/^ {0,3}\[[^\]\r\n]+\]:[ \t]*\S/mu.test(decoded) && !/!?\[[^\]\r\n]*\]\((?!https?:\/\/|mailto:|#)[^)]*\)/iu.test(decoded), 'Link scan: unsupported relative link');
      for (const match of decoded.matchAll(/\[\[([^\]\r\n]+)\]\]/gu)) {
        const target = match[1].split('|', 1)[0].trim().split('#', 1)[0].split('^', 1)[0].replace(/\.md$/iu, '').toLocaleLowerCase();
        check(target !== base && target !== normalized, 'Link scan: wikilink reference');
      }
    }
  }
  moveNote(args) {
    const source = safeRelative(args.path), destination = safeRelative(args.destination);
    return this.withLocks([source, destination], () => this.moveNoteLocked(args));
  }
  moveNoteLocked(args) {
    const op = operationId(args.operation_id), source = safeRelative(args.path), destination = safeRelative(args.destination);
    const rationale = safeRationale(args.rationale), sha = args.expected_sha256;
    check(this.config.role === 'curator' && this.config.enabled === true && this.config.allowMoves === true, 'Moves disabled: require externally verified quiescence');
    check(typeof sha === 'string' && /^[a-f0-9]{64}$/u.test(sha), 'Invalid SHA256');
    check(/^00-Inbox\/.+\.md$/u.test(source) && /^(?:02-Projects|03-Areas|04-Knowledge|05-Resources)\/.+\.md$/u.test(destination) && path.posix.basename(source) === path.posix.basename(destination), 'Invalid move paths');
    const sourceFile = this.vault.target(source), destFile = this.vault.target(destination);
    check(fs.existsSync(path.dirname(destFile)) && fs.statSync(path.dirname(destFile)).isDirectory(), 'Destination parent missing');
    const file = this.operationPath(op), evidenceFile = this.reviewPath(op, destination);
    const operation = { type: 'move', operation_id: op, source_path: source, destination, source_sha256: sha, rationale };
    let journal = fs.existsSync(file) ? this.readJson(file) : null;
    if (journal) check(Object.entries(operation).every(([key, value]) => journal[key] === value) && ['prepared', 'destination_verified', 'source_removed', 'committed'].includes(journal.stage), 'Operation conflict or manual recovery required');
    const result = { status: 'moved', operation_id: op, source_path: source, path: destination, sha256: sha };
    const makeEvidence = () => {
      const original = this.requireReview(op, source, sha).record;
      return { ...original, path: destination, stage: 'organized', organized_sha256: sha, moved_from: source, move_operation_id: op };
    };
    const verifyEvidence = expected => {
      check(fs.existsSync(evidenceFile), 'Move evidence missing');
      const actual = this.readJson(evidenceFile);
      check(Object.entries(expected).every(([key, value]) => actual[key] === value), 'Move evidence conflict; manual recovery required');
    };
    if (journal && ['source_removed', 'committed'].includes(journal.stage)) {
      check(!fs.existsSync(sourceFile) && this.vault.read(destination).sha256 === sha, 'Move retry requires manual recovery');
      const expected = makeEvidence();
      if (journal.stage === 'source_removed' && !fs.existsSync(evidenceFile)) this.writeJson(evidenceFile, expected);
      verifyEvidence(expected);
      if (journal.stage === 'source_removed') this.writeJsonReplace(file, { ...operation, stage: 'committed' });
      return result;
    }
    check(!journal || journal.stage === 'prepared', 'Move interrupted; manual recovery required');
    check(!fs.existsSync(destFile), 'Destination occupied; manual recovery required');
    const note = this.vault.read(source);
    check(note.sha256 === sha, 'Source changed: read again');
    frontmatter(note.content);
    const evidence = makeEvidence();
    if (fs.existsSync(evidenceFile)) verifyEvidence(evidence);
    this.assertMoveSafe(source);
    const bytes = fs.readFileSync(sourceFile), stat = fs.statSync(sourceFile);
    check(hash(bytes) === sha, 'Source changed before backup');
    this.backup(op, source, bytes);
    if (!journal) { journal = { ...operation, stage: 'prepared' }; this.writeJson(file, journal); }
    durableWrite(destFile, bytes, stat.mode & 0o777); syncDirectory(path.dirname(destFile));
    check(this.vault.read(destination).sha256 === sha, 'Destination readback failed');
    this.writeJsonReplace(file, { ...operation, stage: 'destination_verified' });
    const latest = fs.statSync(sourceFile);
    check(latest.ino === stat.ino && latest.dev === stat.dev && this.vault.read(source).sha256 === sha, 'Source changed during move');
    fs.unlinkSync(sourceFile); syncDirectory(path.dirname(sourceFile));
    this.writeJsonReplace(file, { ...operation, stage: 'source_removed' });
    if (!fs.existsSync(evidenceFile)) this.writeJson(evidenceFile, evidence); else verifyEvidence(evidence);
    this.writeJsonReplace(file, { ...operation, stage: 'committed' });
    return result;
  }
  trashNote(args) {
    const relative = safeRelative(args.path);
    return this.withLocks([relative], () => this.trashNoteLocked(args));
  }
  trashNoteLocked({ operation_id, path: relative, expected_sha256, rationale, merged_into = null, merged_into_sha256 = null }) {
    const op = operationId(operation_id), cleanPath = safeRelative(relative);
    check(this.config.enabled === true && this.config.allowTrash === true, 'Trash moves are disabled');
    check(!cleanPath.startsWith('01-Journal/'), 'Journal notes cannot be trashed');
    const source = this.vault.target(cleanPath), reason = text(rationale, 'rationale', 500).trim();
    const existingDir = path.join(this.trashRoot(false), op);
    if (fs.existsSync(existingDir)) {
      const entry = this.trashEntry(op);
      check(entry.manifest.original_path === cleanPath && entry.manifest.sha256 === expected_sha256 && entry.manifest.merged_into === merged_into && entry.manifest.merged_into_sha256 === merged_into_sha256 && entry.manifest.rationale === reason, 'Trash operation conflicts with existing record');
      check(!fs.existsSync(source) && ['trash_verified', 'source_removed', 'trashed'].includes(entry.manifest.state), 'Incomplete trash operation requires manual recovery');
      const evidence = this.requireReview(op, cleanPath, expected_sha256);
      if (entry.manifest.state !== 'trashed') this.writeJsonReplace(entry.manifestPath, { ...entry.manifest, state: 'trashed' });
      if (evidence.record.stage !== 'trashed') this.writeJsonReplace(evidence.file, { ...evidence.record, stage: 'trashed', trash_operation_id: op, trashed_at: this.isoNow() });
      return { status: 'trashed', operation_id: op, original_path: cleanPath, sha256: expected_sha256 };
    }
    const note = this.vault.read(cleanPath);
    check(note.sha256 === expected_sha256, 'Note changed before trash move');
    frontmatter(note.content);
    const evidence = this.requireReview(op, cleanPath, expected_sha256);
    const entryDir = path.join(this.trashRoot(true), op);
    fs.mkdirSync(entryDir, { mode: 0o700 });
    syncDirectory(path.dirname(entryDir));
    const payload = path.join(entryDir, path.basename(cleanPath));
    this.backup(op, cleanPath, fs.readFileSync(source));
    const manifestPath = path.join(entryDir, 'manifest.json');
    const manifest = { operation_id: op, original_path: cleanPath, sha256: note.sha256, moved_at: this.isoNow(), rationale: reason, merged_into, merged_into_sha256, retention_days: this.trashRetentionDays, state: 'prepared' };
    this.writeJson(manifestPath, manifest);
    const sourceStat = fs.statSync(source);
    try {
      check(this.vault.read(cleanPath).sha256 === expected_sha256, 'Source changed before trash move');
      fs.linkSync(source, payload);
      syncDirectory(entryDir);
      check(hash(fs.readFileSync(payload)) === note.sha256, 'Trash readback hash mismatch');
      this.writeJsonReplace(manifestPath, { ...manifest, state: 'trash_verified' });
      const latestStat = fs.statSync(source);
      check(latestStat.ino === sourceStat.ino && latestStat.dev === sourceStat.dev && this.vault.read(cleanPath).sha256 === expected_sha256, 'Source changed during trash move');
      fs.unlinkSync(source);
      syncDirectory(path.dirname(source));
      this.writeJsonReplace(manifestPath, { ...manifest, state: 'source_removed' });
      this.writeJsonReplace(manifestPath, { ...manifest, state: 'trashed' });
      this.writeJsonReplace(evidence.file, { ...evidence.record, stage: 'trashed', trash_operation_id: op, trashed_at: this.isoNow() });
      return { status: 'trashed', operation_id: op, original_path: cleanPath, sha256: note.sha256 };
    } catch (error) {
      if (fs.existsSync(source) && fs.existsSync(payload) && hash(fs.readFileSync(source)) === hash(fs.readFileSync(payload))) fs.unlinkSync(payload);
      throw error;
    }
  }
  mergeNotes(args) {
    const targetPath = safeRelative(args.target_path), sourcePath = safeRelative(args.source_path);
    return this.withLocks([targetPath, sourcePath], () => this.mergeNotesLocked(args));
  }
  assertNoReferences(relative, retainedPath = null) {
    const normalized = relative.slice(0, -3).toLocaleLowerCase(), base = path.posix.basename(normalized);
    for (const reference of this.moveReferences()) {
      if (reference === relative || reference === retainedPath) continue;
      if (reference.endsWith('.md') && path.posix.basename(reference, '.md').toLocaleLowerCase() === base) throw new Error('Merge link scan found a duplicate basename; defer safely');
      const content = this.readMoveReference(reference);
      if (content.includes(relative) || content.includes(encodeURI(relative))) throw new Error('Merge link scan found a path reference; defer safely');
      if (reference.endsWith('.md') && (/^ {0,3}\[[^\]\r\n]+\]:[ \t]*\S/mu.test(content) || /!?\[[^\]\r\n]*\]\((?!https?:\/\/|mailto:|#)[^)]*\)/u.test(content))) throw new Error('Merge link scan found an unsupported relative Markdown link; defer safely');
      for (const match of content.matchAll(/\[\[([^\]\r\n]+)\]\]/gu)) {
        const target = match[1].split('|', 1)[0].trim().split('#', 1)[0].split('^', 1)[0].replace(/\.md$/iu, '').toLocaleLowerCase();
        if (target === normalized || target === base) throw new Error('Merge link scan found a wikilink to the source; defer safely');
      }
    }
  }
  mergeNotesLocked(args) {
    const op = operationId(args.operation_id);
    check(this.config.enabled === true && this.config.allowOrganization === true && this.config.allowTrash === true, 'Merge or trash is disabled');
    const targetPath = safeRelative(args.target_path), sourcePath = safeRelative(args.source_path);
    check(targetPath !== sourcePath && !targetPath.startsWith('01-Journal/') && !sourcePath.startsWith('01-Journal/'), 'Journal notes cannot be merged');
    const rationale = text(args.rationale, 'rationale', 500).trim(), mergedBody = text(args.merged_body, 'merged_body', 280000);
    const operationFile = this.operationPath(op);
    const operation = { operation_id: op, type: 'merge', target_path: targetPath, target_sha256: args.target_sha256, source_path: sourcePath, source_sha256: args.source_sha256, merged_body_sha256: hash(mergedBody), rationale };
    const sourceFile = this.vault.target(sourcePath);
    if (!fs.existsSync(sourceFile)) {
      check(fs.existsSync(operationFile), 'Merge source missing without a matching completion journal');
      const journal = this.readJson(operationFile);
      check(journal.stage === 'committed' && Object.entries(operation).every(([key, value]) => journal[key] === value), 'Merge retry conflicts with operation journal');
      const target = this.vault.read(targetPath), recordFile = this.reviewPath(op, targetPath);
      check(fs.existsSync(recordFile), 'Merge source missing without a matching completion record');
      const evidence = this.readJson(recordFile), entry = this.trashEntry(op);
      check(entry.manifest.original_path === sourcePath && entry.manifest.sha256 === args.source_sha256 && entry.manifest.merged_into === targetPath && entry.manifest.merged_into_sha256 === evidence.organized_sha256 && entry.manifest.rationale === rationale && entry.manifest.state === 'trashed' &&
        evidence.sha256 === args.target_sha256 && evidence.merge_source === sourcePath && evidence.merged_body_sha256 === hash(mergedBody) && ['organized', 'curated'].includes(evidence.stage) &&
        target.sha256 === (evidence.stage === 'curated' ? evidence.curated_sha256 : evidence.organized_sha256), 'Merge retry conflicts with current data');
      return { status: 'merged', target_path: targetPath, target_sha256: target.sha256, trash_operation_id: op };
    }
    const target = this.vault.read(targetPath), source = this.vault.read(sourcePath);
    check(target.sha256 === args.target_sha256 && source.sha256 === args.source_sha256, 'Note changed: read both notes again');
    this.requireReview(op, targetPath, target.sha256); this.requireReview(op, sourcePath, source.sha256);
    const targetFront = frontmatter(target.content), sourceFront = frontmatter(source.content);
    check(targetFront[2].split('\n').filter(line => line.startsWith('updated:')).length <= 1 && sourceFront[2].split('\n').filter(line => line.startsWith('updated:')).length <= 1, 'Duplicate updated property');
    const mergedTokens = tokens(mergedBody);
    for (const token of [...tokens(bodyOf(target.content)), ...tokens(bodyOf(source.content))]) check(mergedTokens.includes(token), `Merge omits original link or provenance marker: ${token}`);
    check(this.config.allowMoves === true, 'Merge moves disabled: require externally verified quiescence');
    this.assertNoReferences(sourcePath, targetPath);
    const prepared = { ...operation, stage: 'prepared', prepared_at: this.isoNow() };
    if (fs.existsSync(operationFile)) {
      const previous = this.readJson(operationFile);
      check(previous.stage === 'prepared' && Object.entries(operation).every(([key, value]) => previous[key] === value), 'Operation ID is already used or needs manual recovery');
    } else this.writeJson(operationFile, prepared);
    const updatedText = targetFront[1] + targetFront[2].replace(/^updated:.*$/mu, `updated: ${this.now().toISOString().slice(0, 10)}`) + targetFront[3] + '\n\n' + mergedBody.trim() + '\n';
    this.backup(op, targetPath, fs.readFileSync(this.vault.target(targetPath))); this.backup(op, sourcePath, fs.readFileSync(this.vault.target(sourcePath)));
    const updated = this.atomicReplace(targetPath, Buffer.from(updatedText), target.sha256);
    this.writeJsonReplace(operationFile, { ...prepared, stage: 'target_written', target_written_sha256: updated.sha256, target_written_at: this.isoNow() });
    try {
      const moved = this.trashNoteLocked({ operation_id: op, path: sourcePath, expected_sha256: source.sha256, rationale, merged_into: targetPath, merged_into_sha256: updated.sha256 });
      this.writeJsonReplace(operationFile, { ...prepared, stage: 'source_trashed', target_written_sha256: updated.sha256, trash_operation_id: moved.operation_id, source_trashed_at: this.isoNow() });
      const targetRecord = this.reviewPath(op, targetPath), evidence = this.readJson(targetRecord);
      this.writeJsonReplace(targetRecord, { ...evidence, stage: 'organized', organized_sha256: updated.sha256, merge_source: sourcePath, merged_body_sha256: hash(mergedBody), merged_at: this.isoNow() });
      this.writeJsonReplace(operationFile, { ...prepared, stage: 'committed', target_written_sha256: updated.sha256, trash_operation_id: moved.operation_id, committed_at: this.isoNow() });
      return { status: 'merged', target_path: targetPath, target_sha256: updated.sha256, trash_operation_id: moved.operation_id };
    } catch (error) {
      const errorDir = path.join(this.curatorRoot, 'errors'); fs.mkdirSync(errorDir, { recursive: true, mode: 0o700 });
      this.writeJson(path.join(errorDir, `${op}-${randomUUID()}.json`), { operation_id: op, target_path: targetPath, source_path: sourcePath, target_sha256: updated.sha256, source_sha256: source.sha256, stage: 'target_written_source_retained', error: error.message, at: this.isoNow() });
      throw error;
    }
  }
  listTrash() {
    const root = this.trashRoot(false); if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && !item.isSymbolicLink()).flatMap(item => {
      try {
        const { manifest } = this.trashEntry(item.name), moved = Date.parse(manifest.moved_at);
        if (!Number.isFinite(moved)) return [{ operation_id: item.name, state: 'blocked', reason: 'invalid_moved_at' }];
        return [{ operation_id: item.name, original_path: manifest.original_path, moved_at: manifest.moved_at, expires_at: new Date(moved + this.trashRetentionDays * 86400000).toISOString(), sha256: manifest.sha256, state: manifest.state }];
      } catch { return [{ operation_id: item.name, state: 'blocked', reason: 'invalid_trash_entry' }]; }
    }).sort((a, b) => a.operation_id.localeCompare(b.operation_id));
  }
  listPendingDeletions() {
    const now = this.now().getTime();
    return this.listTrash().filter(entry => entry.state === 'trashed' && Date.parse(entry.expires_at) <= now)
      .map(entry => ({ ...entry, request_id: `${entry.operation_id}-${entry.sha256.slice(0, 16)}`, approval_state: 'not_sent_discord_out_of_scope', can_permanently_delete: false }));
  }
  prepareDeletionRequests() {
    return this.listPendingDeletions().map(candidate => {
      const entry = this.trashEntry(candidate.operation_id);
      let request = entry.manifest.approval_request;
      if (request) check(request.request_id === candidate.request_id && request.sha256 === candidate.sha256 && request.status === 'not_sent_discord_out_of_scope', 'Approval request record conflicts; manual review required');
      else {
        request = { request_id: candidate.request_id, sha256: candidate.sha256, created_at: this.isoNow(), status: 'not_sent_discord_out_of_scope' };
        this.writeJsonReplace(entry.manifestPath, { ...entry.manifest, approval_request: request });
      }
      return { ...candidate, approval_state: request.status, requested_at: request.created_at, discord_sent: false, can_permanently_delete: false };
    });
  }
  restoreNote({ operation_id }) {
    const op = operationId(operation_id), relative = this.trashEntry(op).manifest.original_path;
    return this.withLocks([relative], () => this.restoreNoteLocked({ operation_id: op }));
  }
  restoreNoteLocked({ operation_id }) {
    const op = operationId(operation_id);
    check(this.config.enabled === true && this.config.allowTrash === true, 'Trash management is disabled');
    const entry = this.trashEntry(op), target = this.vault.target(entry.manifest.original_path);
    if (entry.manifest.state === 'restored' && fs.existsSync(target)) {
      check(hash(fs.readFileSync(target)) === entry.manifest.sha256, 'Restored path changed; automatic retry refused');
      return { status: 'restored', operation_id: op, path: entry.manifest.original_path, sha256: entry.manifest.sha256 };
    }
    check(!fs.existsSync(target), 'Original path is occupied; restore refused');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.restore`;
    durableWrite(temp, fs.readFileSync(entry.file));
    try {
      check(hash(fs.readFileSync(temp)) === entry.manifest.sha256, 'Restore copy hash mismatch'); fs.linkSync(temp, target);
      syncDirectory(path.dirname(target));
      check(hash(fs.readFileSync(target)) === entry.manifest.sha256, 'Restore readback hash mismatch'); fs.unlinkSync(temp);
      this.writeJsonReplace(entry.manifestPath, { ...entry.manifest, state: 'restored', restored_at: this.isoNow() });
      return { status: 'restored', operation_id: op, path: entry.manifest.original_path, sha256: entry.manifest.sha256 };
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  finalizeReview(args) {
    const relative = safeRelative(args.path);
    return this.withLocks([relative], () => this.finalizeReviewLocked(args));
  }
  finalizeReviewLocked(args) {
    const op = operationId(args.operation_id), relative = safeRelative(args.path);
    this.assertNoPendingMove(relative);
    const note = this.vault.read(relative);
    check(note.sha256 === args.expected_sha256, 'Note changed: read again');
    const { file, record } = this.requireReview(op, relative, note.sha256);
    const associatedOperation = this.operationPath(op);
    if (fs.existsSync(associatedOperation)) {
      const pending = this.readJson(associatedOperation);
      if (pending.type === 'move' && pending.destination === relative) check(record.move_operation_id === op && pending.stage === 'committed', 'Move journal not committed or evidence missing');
    }
    if (record.move_operation_id) {
      const journalFile = this.operationPath(op);
      check(record.move_operation_id === op && fs.existsSync(journalFile), 'Move completion journal missing');
      const journal = this.readJson(journalFile);
      check(journal.type === 'move' && journal.stage === 'committed' && journal.operation_id === op && journal.destination === relative && journal.source_path === record.moved_from && journal.source_sha256 === record.organized_sha256 && !fs.existsSync(this.vault.target(journal.source_path)), 'Move not committed; manual recovery required');
    }
    if (record.stage === 'curated' && /^status: curated$/mu.test(note.content)) return { status: 'curated', path: relative, sha256: note.sha256 };
    if (record.stage === 'finalizing' && /^status: curated$/mu.test(note.content)) {
      check(record.curated_sha256 === note.sha256, 'Finalizing record disagrees with curated note');
      const completed = { ...record, stage: 'curated', curated_at: record.finalizing_at };
      this.writeJsonReplace(file, completed);
      return { status: 'curated', path: relative, sha256: note.sha256 };
    }
    check(['reviewed', 'organized', 'finalizing'].includes(record.stage), 'Review stage is incomplete');
    const finalizingAt = record.finalizing_at ?? this.isoNow(), finalDate = finalizingAt.slice(0, 10);
    const front = frontmatter(note.content), newline = front[1].includes('\r\n') ? '\r\n' : '\n';
    let metadata = front[2].replace(/^status: review$/mu, 'status: curated');
    metadata = /^updated:.*$/mu.test(metadata) ? metadata.replace(/^updated:.*$/mu, `updated: ${finalDate}`) : `${metadata}${newline}updated: ${finalDate}`;
    const content = front[1] + metadata + front[3] + note.content.slice(front[0].length);
    const bytes = Buffer.from(content);
    this.backup(op, relative, fs.readFileSync(this.vault.target(relative)));
    const plannedSha = hash(bytes);
    if (record.stage === 'finalizing') check(record.curated_sha256 === plannedSha, 'Finalizing operation output changed');
    else this.writeJsonReplace(file, { ...record, stage: 'finalizing', curated_sha256: plannedSha, finalizing_at: finalizingAt });
    const after = this.atomicReplace(relative, bytes, note.sha256);
    this.writeJsonReplace(file, { ...record, stage: 'curated', curated_sha256: after.sha256, finalizing_at: finalizingAt, curated_at: finalizingAt });
    return { status: 'curated', path: relative, sha256: after.sha256 };
  }
}
