import fs from 'node:fs';
import path from 'node:path';
import { turnKey } from './vault.mjs';

export function evaluate(config, event) {
  if (!config.enabled || !event.session_id || !event.turn_id) return {};
  const key = turnKey(event);
  const context = `Obsidian automatic capture is enabled for this local Codex turn. session_id=${event.session_id}; turn_id=${event.turn_id}. Before your final answer, use obsidian_brain MCP tools to save only useful new knowledge/decisions/verified fixes in Korean following get_context rules; search existing notes first and append rather than duplicating. Otherwise call skip_turn. Never store raw chat, secrets or sensitive personal content without explicit authorization. If tools are unavailable, do not retry indefinitely or claim a save.`;
  if (event.hook_event_name === 'UserPromptSubmit') return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
  if (event.hook_event_name !== 'Stop') return {};
  const state = path.join(config.stateDir, `${key}.json`);
  if (fs.existsSync(state)) return {};
  const reminder = path.join(config.stateDir, `${key}.reminded`);
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(reminder) || event.stop_hook_active) return { systemMessage: 'Obsidian auto-save did not complete for this turn. The conversation can continue; no save is claimed.' };
  try { fs.writeFileSync(reminder, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return {}; throw error; }
  return { decision: 'block', reason: `${context} This is the single automatic save reminder for this turn. Perform the save or skip check now, then finish without repeating your previous answer. Do not start a new Codex process.` };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const config = JSON.parse(fs.readFileSync(process.env.OBSIDIAN_BRAIN_CONFIG ?? new URL('./config.json', import.meta.url), 'utf8'));
    const event = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(evaluate(config, event)));
  } catch (error) {
    process.stderr.write(`Obsidian hook failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
