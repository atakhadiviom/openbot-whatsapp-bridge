#!/usr/bin/env node
// OpenBot personal WhatsApp bridge. Local only (127.0.0.1).
// GET  /health            -> connection state
// GET  /messages?since=ts -> incoming messages stored locally (newest last)
// POST /send {chatId,text,confirm:true} -> only when ENABLE_SEND=1

import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(here, 'session');
const STORE_FILE = path.join(here, 'messages.jsonl');
const PORT = Number(process.env.WA_BRIDGE_PORT || 8790);
const ENABLE_SEND = process.env.ENABLE_SEND === '1';
const logger = pino({ level: 'warn' });

mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
chmodSync(SESSION_DIR, 0o700);

let sock = null;
let state = 'starting';

function extractText(m) {
  return m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || null;
}

function storeMessage(msg) {
  const text = extractText(msg.message);
  const row = {
    id: msg.key.id,
    chatId: msg.key.remoteJid,
    fromMe: !!msg.key.fromMe,
    sender: msg.key.participant || msg.key.remoteJid,
    timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
    type: Object.keys(msg.message || {})[0] || 'unknown',
    text,
  };
  appendFileSync(STORE_FILE, JSON.stringify(row) + '\n', { mode: 0o600 });
}

async function connect() {
  const { state: auth, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth, logger, printQRInTerminal: false, markOnlineOnConnect: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    if (u.qr) {
      state = 'waiting_for_qr_scan';
      console.log('Scan this QR with WhatsApp > Linked devices:');
      qrcode.generate(u.qr, { small: true });
      // Latest pairing QR as a scannable PNG, rewritten on every refresh
      QRCode.toFile(path.join(import.meta.dirname, 'qr.png'), u.qr, { width: 480, margin: 4 }).catch((e) => console.log('qr png failed:', e.message));
    }
    if (u.connection === 'open') { state = 'connected'; console.log('WhatsApp connected.'); }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { state = 'logged_out'; console.log('Logged out. Delete session/ and restart to re-pair.'); return; }
      state = 'reconnecting';
      setTimeout(connect, 3000);
    }
  });
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) if (m.message) storeMessage(m);
  });
}

function readMessages(since) {
  if (!existsSync(STORE_FILE)) return [];
  return readFileSync(STORE_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((r) => r.timestamp > since);
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { state });
  if (req.method === 'GET' && url.pathname === '/messages') {
    return json(res, 200, readMessages(Number(url.searchParams.get('since') || 0)));
  }
  if (req.method === 'POST' && url.pathname === '/send') {
    if (!ENABLE_SEND) return json(res, 403, { error: 'sending disabled (set ENABLE_SEND=1)' });
    let raw = '';
    for await (const c of req) raw += c;
    const { chatId, text, confirm } = JSON.parse(raw || '{}');
    if (confirm !== true) return json(res, 400, { error: 'confirm:true required' });
    if (state !== 'connected') return json(res, 503, { error: `not connected (${state})` });
    const sent = await sock.sendMessage(chatId, { text });
    return json(res, 200, { id: sent?.key?.id });
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`bridge on http://127.0.0.1:${PORT}`));
connect().catch((e) => { state = 'error'; console.error(e.message); });
