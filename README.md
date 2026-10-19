# openbot-whatsapp-bridge

A small local bridge that links your own WhatsApp account (WhatsApp Web multi-device, via Baileys) and exposes it on `127.0.0.1` so a local agent can read messages and, with explicit confirmation, send them.

- **Read:** incoming and self-chat messages are appended to `messages.jsonl`.
- **Send:** off by default. Start with `ENABLE_SEND=1` and each request must include `"confirm": true`.
- **Self-chat auto-reply:** `autoreply.mjs` answers new messages you send to your own chat, using the `claude` CLI with no tools.

## Setup

```sh
npm install
npm start            # prints a QR code, writes qr.png
```

Scan `qr.png` with WhatsApp: Settings > Linked devices > Link a device. The QR refreshes about every 20 seconds.

## HTTP API (127.0.0.1:8790)

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{"state": "..."}` |
| GET | `/messages?since=<unix-seconds>` | stored messages, newest last |
| POST | `/send` | body `{"chatId","text","confirm":true}`, needs `ENABLE_SEND=1` |

## Self-chat auto-reply

```sh
ENABLE_SEND=1 npm start
SELF_CHAT_ID=<your own chat id> npm run autoreply
```

Find your chat id in `/messages` (the `chatId` of messages with `fromMe: true` in your self-chat). Replies use `CLAUDE_MODEL` (default `claude-haiku-5-5`) and the `CLAUDE_BIN` path if `claude` is not on `PATH`.

## Security and terms

- The session folder (`session/`) holds WhatsApp keys. Keep it private; it is git-ignored.
- Anything that can reach `127.0.0.1:8790` can read your messages. Do not expose the port.
- WhatsApp does not allow unofficial clients. Your number can be restricted or banned. Use at your own risk.
- Do not commit `messages.jsonl`, logs, or `qr.png`; they are git-ignored.
