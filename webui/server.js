'use strict';

// Minimal WhatsApp-like web UI for whalibmob.
// Pure Node (no npm deps beyond whalibmob itself). Run:  node webui/server.js
// Then open http://localhost:8088 in a browser (or the phone's browser in Termux).

const http = require('http');
const fs   = require('fs');
const path = require('path');

const wa = require('..');
const { WhalibmobClient, defaultBaseDir, sessionDirFor, listSessions } = wa;

const PORT     = parseInt(process.env.WEBUI_PORT, 10) || 8088;
const BASE_DIR = process.env.WA_SESSION_DIR || defaultBaseDir();

// number -> live client                number -> array of SSE response streams
const clients = new Map();
const streams = new Map();

function pushEvent(number, type, data) {
  const list = streams.get(number) || [];
  const line = 'data: ' + JSON.stringify({ type, data }) + '\n\n';
  for (const res of list) { try { res.write(line); } catch (_) {} }
}

function jidToNumber(jid) { return String(jid || '').split(/[:@]/)[0]; }

async function getClient(number) {
  if (clients.has(number)) return clients.get(number);
  const dir = sessionDirFor(BASE_DIR, number);
  const client = new WhalibmobClient({ sessionDir: BASE_DIR, messageStore: true });

  client.on('message', (m) => {
    // m shape varies; normalise the fields the UI needs.
    const from = m.from || m.chat || m.participant || m.key && m.key.remoteJid;
    const text = (m.text != null ? m.text
               : m.body != null ? m.body
               : m.message && (m.message.conversation || (m.message.extendedTextMessage||{}).text)) || '';
    pushEvent(number, 'message', {
      chat: jidToNumber(from), from: String(from || ''), text,
      fromMe: !!m.fromMe, ts: m.ts || Date.now(), id: m.id || ''
    });
  });
  client.on('connected', () => pushEvent(number, 'status', { state: 'connected' }));
  client.on('disconnected', () => pushEvent(number, 'status', { state: 'disconnected' }));

  clients.set(number, client);
  await client.connect(number);
  return client;
}

// ─── tiny helpers ────────────────────────────────────────────────────────────
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 80 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  try {
    // ── static UI ──
    if (p === '/' || p === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }

    // ── list the numbers whose session folders exist ──
    if (p === '/api/sessions' && req.method === 'GET') {
      let nums = [];
      try { nums = listSessions(BASE_DIR).map(s => (typeof s === 'string' ? s : s.phoneNumber || s.number)); }
      catch (_) {}
      return send(res, 200, { base: BASE_DIR, numbers: nums, connected: [...clients.keys()] });
    }

    // ── upload a session folder: { number, files:[{name, b64}] } ──
    if (p === '/api/upload' && req.method === 'POST') {
      const body = await readBody(req);
      const number = String(body.number || '').replace(/\D/g, '');
      if (!number || !Array.isArray(body.files)) return send(res, 400, { error: 'number and files required' });
      const dir = sessionDirFor(BASE_DIR, number);
      fs.mkdirSync(dir, { recursive: true });
      let written = 0;
      for (const f of body.files) {
        if (!f || !f.name) continue;
        const safe = path.basename(String(f.name));          // no path traversal
        fs.writeFileSync(path.join(dir, safe), Buffer.from(String(f.b64 || ''), 'base64'));
        written++;
      }
      return send(res, 200, { ok: true, number, written, dir });
    }

    // ── connect a number ──
    if (p === '/api/connect' && req.method === 'POST') {
      const { number } = await readBody(req);
      const n = String(number || '').replace(/\D/g, '');
      if (!n) return send(res, 400, { error: 'number required' });
      await getClient(n);
      return send(res, 200, { ok: true, number: n });
    }

    // ── send a text message ──
    if (p === '/api/send' && req.method === 'POST') {
      const { number, to, text } = await readBody(req);
      const n = String(number || '').replace(/\D/g, '');
      const dest = String(to || '').replace(/\D/g, '');
      if (!n || !dest || !text) return send(res, 400, { error: 'number, to, text required' });
      const client = await getClient(n);
      const jid = dest + '@s.whatsapp.net';
      const r = await client.sendText(jid, String(text));
      pushEvent(n, 'message', { chat: dest, from: n, text: String(text), fromMe: true, ts: Date.now(), id: (r && r.id) || '' });
      return send(res, 200, { ok: true, id: (r && r.id) || null });
    }

    // ── live event stream (SSE) for a number ──
    if (p === '/api/events' && req.method === 'GET') {
      const n = String(u.searchParams.get('number') || '').replace(/\D/g, '');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('retry: 3000\n\n');
      if (!streams.has(n)) streams.set(n, []);
      streams.get(n).push(res);
      req.on('close', () => {
        const list = streams.get(n) || [];
        const i = list.indexOf(res); if (i >= 0) list.splice(i, 1);
      });
      return;
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  process.stdout.write('\n  whalibmob Web UI  →  http://localhost:' + PORT + '\n');
  process.stdout.write('  sessions base: ' + BASE_DIR + '\n\n');
});
