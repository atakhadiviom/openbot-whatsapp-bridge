#!/usr/bin/env node
// Answers the user's own WhatsApp self-chat. Only new messages sent from the self chat after start are answered.
// Needs the bridge running with ENABLE_SEND=1. Replies come from `claude -p` with no tools.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = `http://127.0.0.1:${process.env.WA_BRIDGE_PORT || 8790}`;
const SELF = process.env.SELF_CHAT_ID;
if (!SELF) { console.error('Set SELF_CHAT_ID to your own chat id (e.g. the id shown as fromMe in /messages).'); process.exit(1); }
const STATE_FILE = path.join(here, 'autoreply-state.json');
const LOG_FILE = path.join(here, 'autoreply.log');
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const SYSTEM = 'You are OpenBot, the user\'s personal assistant, replying in their own WhatsApp self-chat. Reply briefly in the language they wrote in. You have no tools and cannot take actions; if they ask for an action, say what you would need and that you cannot do it from WhatsApp yet.';

const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  : { lastTs: Math.floor(Date.now() / 1000), seen: [], sent: [] };

const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
const log = (msg) => appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);

function ask(text) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', MODEL, '--tools', '', '--system-prompt', SYSTEM];
    const child = spawn(CLAUDE, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim().slice(0, 1500));
      else reject(new Error(`claude exit ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.end(text);
  });
}

async function send(text) {
  const res = await fetch(`${BRIDGE}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: SELF, text, confirm: true }),
  });
  if (!res.ok) throw new Error(`send ${res.status}`);
  const { id } = await res.json();
  state.sent.push(id);
  state.sent = state.sent.slice(-200);
  return id;
}

async function tick() {
  const res = await fetch(`${BRIDGE}/messages?since=${state.lastTs}`);
  if (!res.ok) return;
  const msgs = await res.json();
  for (const m of msgs) {
    state.lastTs = Math.max(state.lastTs, m.timestamp);
    if (m.chatId !== SELF || !m.fromMe || !m.text) continue;
    if (state.sent.includes(m.id) || state.seen.includes(m.id)) continue;
    state.seen.push(m.id);
    state.seen = state.seen.slice(-500);
    try {
      const reply = await ask(m.text);
      const id = await send(reply);
      log(`replied to ${m.id} with ${id}`);
    } catch (e) {
      log(`failed on ${m.id}: ${e.message}`);
    }
    save();
  }
  save();
}

log(`started, watching ${SELF}`);
setInterval(() => tick().catch((e) => log(`poll error: ${e.message}`)), 4000);
