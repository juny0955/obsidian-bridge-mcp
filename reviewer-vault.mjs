import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Vault, hash, day, check } from './vault.mjs';

export class ReviewerVault {
  constructor(config) {
    this.vault = new Vault({ ...config, client: 'hermes' });
    this.config = config;
  }
  moveReferences() {
    const found = [];
    const walk = relative => {
      const directory = path.join(this.vault.root, relative);
      if (!fs.existsSync(directory)) return;
      check(!fs.lstatSync(directory).isSymbolicLink(), 'Link scan unsafe: symbolic link');
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const child = relative ? `${relative}/${item.name}` : item.name;
        if (child === '99-System/Trash' || child.startsWith('99-System/Trash/')) continue;
        check(!item.isSymbolicLink(), 'Link scan unsafe: symbolic link');
        if (item.isDirectory()) walk(child);
        else if (item.isFile() && /\.(?:md|canvas)$/iu.test(item.name)) found.push(child);
      }
    };
    walk('');
    return found;
  }
  listReviewNotes() {
    return this.vault.notes().flatMap(path => {
      let note;
      try { note = this.vault.read(path); }
      catch { return []; } // An unreadable candidate must not block other review notes.
      const front = note.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
      if (!front || (front.match(/^status\s*:/gmu) ?? []).length !== 1 || !/^status: review$/mu.test(front)) return [];
      return [{ path, sha256: note.sha256, type: front.match(/^type: ([a-z]+)$/mu)?.[1] ?? null }];
    }).slice(0, 30);
  }
  listReviewNotesDetailed(cursor = '', limit = 30) {
    check(typeof cursor === 'string' && cursor.length <= 2048, 'Invalid review cursor');
    check(Number.isInteger(limit) && limit >= 1 && limit <= 30, 'Invalid review limit');
    const paths = this.vault.notes();
    const snapshot = hash(paths.map(notePath => {
      const stat = fs.statSync(path.join(this.vault.root, notePath), { bigint: true });
      return `${notePath}\0${stat.size}\0${stat.mtimeNs}\0${stat.ino}`;
    }).join('\0'));
    let offset = 0;
    if (cursor) {
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new Error('Invalid review cursor'); }
      check(decoded && decoded.version === 1 && Number.isInteger(decoded.offset) && decoded.offset >= 0, 'Invalid review cursor');
      check(decoded.snapshot === snapshot, 'Stale review cursor; restart from the first page');
      offset = decoded.offset;
    }
    const rows = paths.map(notePath => {
      try {
        const note = this.vault.read(notePath);
        const frontMatch = note.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
        if (!frontMatch) return { skipped: { path: notePath, reason: 'missing_or_invalid_frontmatter' } };
        const front = frontMatch[1], statuses = front.match(/^status\s*:/gmu) ?? [];
        if (statuses.length > 1) return { skipped: { path: notePath, reason: 'duplicate_status' } };
        if (!/^status: review$/mu.test(front)) return null;
        return { item: { path: notePath, sha256: note.sha256, type: front.match(/^type: ([a-z]+)$/mu)?.[1] ?? null } };
      } catch (error) { return { skipped: { path: notePath, reason: error.message.slice(0, 120) } }; }
    });
    const page = rows.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < rows.length;
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ version: 1, snapshot, offset: nextOffset })).toString('base64url') : null;
    return {
      items: page.flatMap(row => row?.item ? [row.item] : []),
      skipped: page.flatMap(row => row?.skipped ? [row.skipped] : []),
      total_reviewable: rows.filter(row => row?.item).length,
      offset, next_cursor: nextCursor, has_more: hasMore,
    };
  }
  completeReview(args) {
    check(args && typeof args === 'object' && !Array.isArray(args), 'Invalid review arguments');
    check(Object.keys(args).sort().join(',') === 'destination,expected_sha256,path,rationale', 'Invalid review arguments');
    check(typeof args.expected_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(args.expected_sha256), 'Invalid SHA256');
    check(typeof args.rationale === 'string' && args.rationale.trim().length >= 1 && args.rationale.length <= 500, 'Invalid rationale');
    check(this.config.enabled === true, 'Reviewer is disabled');
    const source = this.vault.target(args.path);
    const destination = this.vault.target(args.destination);
    check(/^(?:01-Journal|02-Projects|03-Areas|04-Knowledge|05-Resources)\//u.test(args.destination) &&
      path.posix.basename(args.path) === path.posix.basename(args.destination) &&
      (args.path !== args.destination || !args.path.startsWith('00-Inbox/')), 'Invalid destination');
    check(!args.path.startsWith('01-Journal/') || source === destination, 'Journal notes must stay in place');
    check(source === destination || this.config.allowMoves === true, 'Review moves disabled: require externally verified quiescence');
    const key = hash([args.path, args.expected_sha256, args.destination].join('\0'));
    const reviewerDir = path.join(this.config.stateDir, 'reviewer');
    fs.mkdirSync(reviewerDir, { recursive: true, mode: 0o700 });
    const record = path.join(reviewerDir, `${key}.json`);
    const backupDir = path.join(reviewerDir, 'backups');
    const locks = [...new Set([args.path, args.destination])].map(relative => path.join(this.config.stateDir, `${hash(relative)}.lock`)).sort();
    const acquired = [];
    let temp, createdDestination = false, removedSource = false, inPlaceWritten = false, content;
    try {
      for (const lock of locks) { fs.mkdirSync(lock, { mode: 0o700 }); acquired.push(lock); }
      if (fs.existsSync(record)) {
        const previous = JSON.parse(fs.readFileSync(record, 'utf8'));
        check(previous.rationale === args.rationale && previous.path === args.destination &&
          (source === destination || !fs.existsSync(source)) &&
          this.vault.read(args.destination).sha256 === previous.sha256 &&
          /^status: curated$/mu.test(this.vault.read(args.destination).content), 'Review record disagrees with note');
        return { status: 'curated', path: previous.path, sha256: previous.sha256 };
      }
      const before = this.vault.read(args.path);
      check(before.sha256 === args.expected_sha256, 'Note changed: read again');
      if (source !== destination) {
        check(!fs.existsSync(destination), 'Destination already exists');
        for (const relative of this.moveReferences()) {
          if (relative !== args.path && relative.endsWith('.md')) check(path.posix.basename(relative) !== path.posix.basename(args.path), 'Duplicate basename makes move unsafe');
          const content = this.readMoveReference(relative);
          if (relative.endsWith('.md')) check(!/^ {0,3}\[[^\]\r\n]+\]:[ \t]*\S/mu.test(content), 'Reference-style link makes move unsafe');
          check(!content.includes(args.path) && !content.includes(args.path.slice(0, -3)) &&
            !content.includes(encodeURI(args.path)) && !/!?\[[^\]\n]*\]\((?!https?:\/\/|mailto:|#)[^)]*\)/u.test(content),
          'Path or relative link makes move unsafe');
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
      }
      const front = before.content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u);
      check(front, 'Missing frontmatter');
      check((front[2].match(/^status\s*:/gmu) ?? []).length === 1 && /^status: review$/mu.test(front[2]), 'Status must be exactly review');
      check((front[2].match(/^updated:.*$/gmu) ?? []).length <= 1, 'Duplicate updated property');
      const newline = front[1].includes('\r\n') ? '\r\n' : '\n';
      let metadata = front[2].replace(/^status: review$/mu, 'status: curated');
      metadata = /^updated:.*$/mu.test(metadata) ? metadata.replace(/^updated:.*$/mu, `updated: ${day()}`) : `${metadata}${newline}updated: ${day()}`;
      content = front[1] + metadata + front[3] + before.content.slice(front[0].length);
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(backupDir, `${key}.md`), before.content, { flag: 'wx', mode: 0o600 });
      temp = `${destination}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
      if (source === destination) { fs.renameSync(temp, destination); temp = null; inPlaceWritten = true; }
      else { fs.linkSync(temp, destination); createdDestination = true; }
      const after = this.vault.read(args.destination);
      check(after.content === content, 'Review readback mismatch');
      if (source !== destination) {
        check(this.vault.read(args.path).sha256 === before.sha256, 'Source changed during review');
        fs.unlinkSync(source);
        removedSource = true;
      }
      const result = { status: 'curated', path: args.destination, sha256: after.sha256 };
      fs.writeFileSync(record, JSON.stringify({ ...result, rationale: args.rationale }), { flag: 'wx', mode: 0o600 });
      return result;
    } catch (error) {
      if (inPlaceWritten) {
        try {
          // Never overwrite an intervening edit. Restore only our exact output.
          if (hash(fs.readFileSync(source)) === hash(content)) {
            temp = `${source}.${randomUUID()}.tmp`;
            fs.writeFileSync(temp, fs.readFileSync(path.join(backupDir, `${key}.md`)), { flag: 'wx', mode: 0o600 });
            fs.renameSync(temp, source);
            temp = null;
            inPlaceWritten = false;
          }
        } catch { /* Keep the original error and the backup for manual recovery. */ }
      }
      if (createdDestination && !removedSource && fs.existsSync(source) && fs.existsSync(destination) &&
          fs.statSync(destination).ino === fs.statSync(temp).ino) fs.unlinkSync(destination);
      try {
        const errors = path.join(reviewerDir, 'errors');
        fs.mkdirSync(errors, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(errors, `${key}-${randomUUID()}.json`),
          JSON.stringify({ key, path: args.path, destination: args.destination, error: error.code ?? error.message, at: new Date().toISOString(), manualRecovery: removedSource || inPlaceWritten }),
          { flag: 'wx', mode: 0o600 });
      } catch { /* Preserve the original failure; backup remains available. */ }
      throw error;
    } finally {
      if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
      acquired.reverse().forEach(lock => fs.rmdirSync(lock));
    }
  }
  readMoveReference(relative) {
    const file = path.join(this.vault.root, relative);
    check(fs.statSync(file).size <= 300000, 'Link scan unsafe: file too large');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); }
    catch { throw new Error('Link scan unsafe: invalid UTF-8'); }
  }
}
