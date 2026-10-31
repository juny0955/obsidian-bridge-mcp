import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureContext, clientId, validTurnIds } from './client.mjs';
import { turnKey } from './vault.mjs';

export function evaluate(config, event) {
  if (clientId(config) !== 'hermes' || !config.enabled) return {};
  if (!event || !['pre_llm_call', 'on_session_end'].includes(event.hook_event_name)) return {};
  const ids = { session_id: event.session_id, turn_id: event.extra?.turn_id };
  if (!validTurnIds(ids, 'hermes')) return {};
  if (event.hook_event_name === 'pre_llm_call') return { context: captureContext(config, ids) };

  const key = turnKey(ids, 'hermes');
  try {
    const state = JSON.parse(fs.readFileSync(path.join(config.stateDir, `${key}.json`), 'utf8'));
    if (state?.status === 'saved' || state?.status === 'skipped') return {};
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(path.join(config.stateDir, `${key}.missing.json`), JSON.stringify({
      status: 'missing', client: 'hermes', ...ids, at: new Date().toISOString(),
    }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return {};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = JSON.parse(fs.readFileSync(process.env.OBSIDIAN_BRAIN_CONFIG ?? new URL('./config.json', import.meta.url), 'utf8'));
    const event = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(`${JSON.stringify(evaluate(config, event))}\n`);
  } catch (error) {
    process.stderr.write(`Obsidian Hermes hook failed: ${error instanceof SyntaxError ? 'Invalid JSON' : error.message}\n`);
    process.exitCode = 1;
  }
}
