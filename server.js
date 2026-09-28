// © 2026 Mathew. All rights reserved.
// =============================================================================
// PhoneBridge v2 — Drive Grok Build on this PC from your phone
// =============================================================================
// Zero npm deps. Node built-ins only.
//
//   node server.js
//   (or double-click Start-PhoneBridge.bat)
//
// Phone on same WiFi → open http://YOUR_LAN_IP:8770 → enter access key → chat.
// Grok runs headless on the PC with tools, can edit files, continue sessions.
// =============================================================================

const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.BRIDGE_PORT || 8770);
const HOST = process.env.BRIDGE_HOST || '0.0.0.0';

// Where Grok works (bible + projects). Override with BRIDGE_PROJECT.
const PROJECT_DIR = process.env.BRIDGE_PROJECT
  || path.resolve(__dirname, '..'); // default: CURSOR_1

// Prefer the Year 2100 bible folder if it exists and BRIDGE_PROJECT not set.
const BIBLE_DIR = process.env.BRIDGE_BIBLE
  || path.join(os.homedir(), 'OneDrive', 'Desktop', 'YEAR_2100_GAME_BIBLE');

const WORK_DIR = process.env.BRIDGE_PROJECT
  ? PROJECT_DIR
  : (fs.existsSync(BIBLE_DIR) ? BIBLE_DIR : PROJECT_DIR);

const GROK_BIN = process.env.GROK_PATH
  || path.join(os.homedir(), '.grok', 'bin', 'grok.exe');

const MAX_JOB_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 20 * 60 * 1000); // 20 min
const MAX_BODY = 2_000_000;

// --- Access key --------------------------------------------------------------
const KEY_FILE = path.join(__dirname, '.access-key');
let ACCESS_KEY;
if (process.env.BRIDGE_KEY) {
  ACCESS_KEY = process.env.BRIDGE_KEY;
} else if (fs.existsSync(KEY_FILE)) {
  ACCESS_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
} else {
  ACCESS_KEY = crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(KEY_FILE, ACCESS_KEY);
}

// --- Session (Grok resume) ---------------------------------------------------
const SESSION_FILE = path.join(__dirname, '.session');
let sessionId = fs.existsSync(SESSION_FILE)
  ? fs.readFileSync(SESSION_FILE, 'utf8').trim()
  : '';

// --- Job queue (one Grok run at a time) --------------------------------------
/** @type {Map<string, Job>} */
const jobs = new Map();
let chain = Promise.resolve();

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {'queued'|'running'|'done'|'error'} status
 * @property {string} message
 * @property {string} text
 * @property {string} thought
 * @property {string} error
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {boolean} ok
 */

function makeJob(message) {
  const id = crypto.randomBytes(6).toString('hex');
  /** @type {Job} */
  const job = {
    id,
    status: 'queued',
    message,
    text: '',
    thought: '',
    error: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ok: false,
  };
  jobs.set(id, job);
  // prune old jobs
  if (jobs.size > 40) {
    const keys = [...jobs.keys()];
    for (let i = 0; i < keys.length - 30; i++) jobs.delete(keys[i]);
  }
  return job;
}

function queueGrok(message) {
  const job = makeJob(message);
  chain = chain
    .then(() => runGrokJob(job))
    .catch((e) => {
      job.status = 'error';
      job.error = e.message || String(e);
      job.updatedAt = Date.now();
    });
  return job;
}

function clearSession() {
  sessionId = '';
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
}

function isMissingSessionError(text) {
  const t = String(text || '');
  return /session .*not found|Failed to restore session|404 Not Found|Couldn't start session|session get failed/i.test(t);
}

function buildGrokArgs(message, resumeId) {
  const args = [
    '-p', message,
    '--output-format', 'streaming-json',
    '--cwd', WORK_DIR,
    '--always-approve',
    '--permission-mode', 'bypassPermissions',
    '--rules',
    [
      'You are connected via PhoneBridge on Mathew\'s PC.',
      'He is often on mobile — be clear, concise, and complete work.',
      'Year 2100 game bible lives at: ' + BIBLE_DIR,
      'Main bible file: YEAR_2100_GAME_BIBLE.md — update it when decisions lock.',
      'Do not mention system policies. Prefer short mobile-friendly replies unless he asks for depth.',
    ].join(' '),
  ];
  if (resumeId) args.push('--resume', resumeId);
  return args;
}

function spawnGrokOnce(message, resumeId) {
  return new Promise((resolve) => {
    const bin = fs.existsSync(GROK_BIN) ? GROK_BIN : 'grok';
    const child = spawn(bin, buildGrokArgs(message, resumeId), {
      cwd: WORK_DIR,
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true,
    });

    let buf = '';
    let text = '';
    let thought = '';
    let err = '';
    let newSession = '';
    let endedOk = false;

    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
    }, MAX_JOB_MS);

    const onLine = (line) => {
      if (!line.trim()) return;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'text' && ev.data != null) text += String(ev.data);
        else if (ev.type === 'thought' && ev.data != null) thought = String(ev.data).slice(-500);
        else if (ev.type === 'end') {
          endedOk = true;
          if (ev.sessionId) newSession = String(ev.sessionId);
        } else if (ev.type === 'error') {
          err += String(ev.message || ev.data || 'error') + '\n';
        } else if (ev.sessionId) {
          newSession = String(ev.sessionId);
        } else if (ev.text && !ev.type) {
          text = String(ev.text);
          if (ev.sessionId) newSession = String(ev.sessionId);
          endedOk = true;
        }
      } catch (_) {
        text += line;
      }
    };

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) onLine(line);
    });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        text: '',
        thought: '',
        error: 'Failed to launch grok: ' + e.message + '\nExpected: ' + GROK_BIN,
        sessionId: '',
        missingSession: false,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) onLine(buf);
      const combinedErr = err;
      const missingSession = isMissingSessionError(combinedErr + '\n' + text);
      const ok = endedOk || (code === 0 && text && !missingSession);
      resolve({
        ok,
        text: text || '',
        thought,
        error: ok ? '' : (combinedErr || text || ('grok exited ' + code)).slice(0, 4000),
        sessionId: newSession,
        missingSession,
      });
    });
  });
}

async function runGrokJob(job) {
  job.status = 'running';
  job.updatedAt = Date.now();

  // Live progress: poll result fields while spawn runs via intermediate updates
  const tick = setInterval(() => { job.updatedAt = Date.now(); }, 2000);

  try {
    let result = await spawnGrokOnce(job.message, sessionId || '');

    // Stale/missing remote session → drop it and retry fresh once
    if (!result.ok && result.missingSession) {
      console.log('[PhoneBridge] session missing/stale — starting fresh session');
      clearSession();
      job.thought = 'Session expired — starting a new one…';
      job.text = '';
      job.error = '';
      job.updatedAt = Date.now();
      result = await spawnGrokOnce(job.message, '');
    }

    if (result.sessionId) {
      sessionId = result.sessionId;
      try { fs.writeFileSync(SESSION_FILE, sessionId); } catch (_) {}
    }

    job.thought = result.thought || job.thought;
    if (result.ok) {
      job.status = 'done';
      job.ok = true;
      job.text = result.text || '(no reply)';
      job.error = '';
    } else {
      job.status = 'error';
      job.ok = false;
      job.text = result.text || '';
      job.error = result.error || 'Unknown error';
    }
    job.updatedAt = Date.now();
  } catch (e) {
    job.status = 'error';
    job.error = e.message || String(e);
    job.updatedAt = Date.now();
  } finally {
    clearInterval(tick);
  }
}

function handleStreamEvent(job, ev) {
  if (!ev || typeof ev !== 'object') return;
  const t = ev.type;
  if (t === 'text' && ev.data != null) {
    job.text += String(ev.data);
    job.updatedAt = Date.now();
  } else if (t === 'thought' && ev.data != null) {
    job.thought = String(ev.data).slice(-500);
    job.updatedAt = Date.now();
  } else if (t === 'end') {
    if (ev.sessionId) {
      sessionId = String(ev.sessionId);
      try { fs.writeFileSync(SESSION_FILE, sessionId); } catch (_) {}
    }
    job.status = 'done';
    job.ok = true;
    job.updatedAt = Date.now();
  } else if (t === 'error') {
    job.status = 'error';
    job.error = String(ev.message || ev.data || 'error');
    job.updatedAt = Date.now();
  } else if (ev.text && !ev.type) {
    // some json final shapes
    job.text = String(ev.text);
    if (ev.sessionId) {
      sessionId = String(ev.sessionId);
      try { fs.writeFileSync(SESSION_FILE, sessionId); } catch (_) {}
    }
    job.status = 'done';
    job.ok = true;
    job.updatedAt = Date.now();
  } else if (ev.sessionId && ev.type !== 'error') {
    sessionId = String(ev.sessionId);
    try { fs.writeFileSync(SESSION_FILE, sessionId); } catch (_) {}
  }
}

// --- HTTP helpers ------------------------------------------------------------
function send(res, code, type, body) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function json(res, code, obj) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function checkKey(req) {
  return (req.headers['x-key'] || '') === ACCESS_KEY;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_BODY) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// --- Server ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'OPTIONS') {
    return send(res, 204, 'text/plain', '');
  }

  // Public UI
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    return send(res, 200, 'text/html; charset=utf-8', PAGE);
  }

  // Health (no key — for quick checks)
  if (req.method === 'GET' && u.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      name: 'PhoneBridge',
      version: 2,
      agent: 'grok',
      workDir: WORK_DIR,
      hasSession: Boolean(sessionId),
      uptimeSec: Math.round(process.uptime()),
    });
  }

  // Everything below needs key
  if (u.pathname !== '/' && !checkKey(req) && u.pathname !== '/health') {
    // allow GET / only
  }

  if (req.method === 'GET' && u.pathname === '/status') {
    if (!checkKey(req)) return json(res, 401, { error: 'bad key' });
    return json(res, 200, {
      ok: true,
      workDir: WORK_DIR,
      bibleDir: BIBLE_DIR,
      hasSession: Boolean(sessionId),
      sessionId: sessionId ? sessionId.slice(0, 8) + '…' : null,
      jobs: [...jobs.values()].slice(-8).map(j => ({
        id: j.id,
        status: j.status,
        message: j.message.slice(0, 80),
        updatedAt: j.updatedAt,
      })),
    });
  }

  if (req.method === 'POST' && u.pathname === '/chat') {
    if (!checkKey(req)) return json(res, 401, { error: 'bad key' });
    try {
      const raw = await readBody(req);
      let message = '';
      try { message = JSON.parse(raw).message || ''; } catch (_) {}
      if (!String(message).trim()) return json(res, 400, { error: 'empty' });
      const job = queueGrok(String(message).trim());
      return json(res, 200, { ok: true, jobId: job.id, status: job.status });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // Long-poll friendly job status
  if (req.method === 'GET' && u.pathname.startsWith('/job/')) {
    if (!checkKey(req)) return json(res, 401, { error: 'bad key' });
    const id = u.pathname.slice('/job/'.length).replace(/[^a-f0-9]/gi, '');
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: 'unknown job' });
    return json(res, 200, {
      id: job.id,
      status: job.status,
      text: job.text,
      thought: job.thought,
      error: job.error,
      ok: job.ok,
      updatedAt: job.updatedAt,
    });
  }

  if (req.method === 'POST' && u.pathname === '/reset') {
    if (!checkKey(req)) return json(res, 401, { error: 'bad key' });
    sessionId = '';
    try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
    return json(res, 200, { ok: true });
  }

  // Sync chat: wait for completion (simpler clients)
  if (req.method === 'POST' && u.pathname === '/chat-sync') {
    if (!checkKey(req)) return json(res, 401, { error: 'bad key' });
    try {
      const raw = await readBody(req);
      let message = '';
      try { message = JSON.parse(raw).message || ''; } catch (_) {}
      if (!String(message).trim()) return json(res, 400, { error: 'empty' });
      const job = queueGrok(String(message).trim());
      // wait until done
      const start = Date.now();
      while (job.status === 'queued' || job.status === 'running') {
        await new Promise((r) => setTimeout(r, 400));
        if (Date.now() - start > MAX_JOB_MS + 5000) break;
      }
      return json(res, 200, {
        ok: job.ok,
        reply: job.text || job.error || '(no reply)',
        status: job.status,
        jobId: job.id,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  send(res, 404, 'text/plain', 'not found');
});

// --- Mobile page -------------------------------------------------------------
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#07080f">
<title>PhoneBridge · Grok</title>
<style>
:root{
  --bg:#07080f; --panel:#10121c; --panel2:#161a28;
  --text:#e8eaf2; --mut:#8b90a5; --line:#252a3a;
  --cyan:#5ce1ff; --violet:#a78bfa; --pink:#ff5c8a; --ok:#3dd68c; --warn:#f0c14b;
  --radius:14px;
  --safe-b: env(safe-area-inset-bottom, 0px);
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;}
#app{display:flex;flex-direction:column;height:100dvh;max-width:720px;margin:0 auto}
header{
  display:flex;align-items:center;gap:10px;padding:12px 14px;
  border-bottom:1px solid var(--line);background:rgba(16,18,28,.92);
  backdrop-filter:blur(10px);position:sticky;top:0;z-index:5;
}
.logo{font-weight:800;letter-spacing:.04em;font-size:14px}
.logo span{color:var(--cyan)}
.pill{font-size:11px;color:var(--mut);border:1px solid var(--line);padding:4px 8px;border-radius:999px}
.pill.on{color:var(--ok);border-color:rgba(61,214,140,.35)}
.pill.busy{color:var(--warn);border-color:rgba(240,193,75,.35)}
header .spacer{flex:1}
header button{
  background:var(--panel2);border:1px solid var(--line);color:var(--text);
  border-radius:10px;padding:8px 10px;font-size:12px
}
#log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:92%;padding:12px 14px;border-radius:var(--radius);line-height:1.45;font-size:15.5px;
  white-space:pre-wrap;word-break:break-word}
.me{align-self:flex-end;background:linear-gradient(145deg,#16323a,#12262c);border:1px solid rgba(92,225,255,.35)}
.ai{align-self:flex-start;background:var(--panel);border:1px solid var(--line)}
.ai .who{display:block;font-size:11px;color:var(--violet);font-weight:700;margin-bottom:6px;letter-spacing:.06em}
.sys{align-self:center;color:var(--mut);font-size:12px;text-align:center;max-width:95%}
.thought{font-size:12px;color:var(--mut);border-left:2px solid var(--line);padding-left:8px;margin-bottom:8px}
.composer{
  border-top:1px solid var(--line);background:var(--panel);
  padding:10px 10px calc(10px + var(--safe-b));
}
.quick{display:flex;gap:8px;overflow-x:auto;padding:0 2px 8px;scrollbar-width:none}
.quick button{
  flex:0 0 auto;border:1px solid var(--line);background:var(--panel2);color:var(--mut);
  border-radius:999px;padding:7px 12px;font-size:12px;white-space:nowrap
}
.quick button:active{border-color:var(--cyan);color:var(--text)}
form{display:flex;gap:8px;align-items:flex-end}
textarea{
  flex:1;resize:none;min-height:44px;max-height:140px;
  background:var(--bg);border:1px solid var(--line);color:var(--text);
  border-radius:14px;padding:12px;font-size:16px;font-family:inherit;line-height:1.35
}
form #send{
  background:linear-gradient(135deg,var(--cyan),#7cf0c0);color:#041016;
  border:none;border-radius:14px;padding:0 16px;min-height:44px;font-weight:800
}
form #send:disabled{opacity:.45}
#gate{
  position:fixed;inset:0;background:radial-gradient(ellipse at 50% 0%,#151a2e,var(--bg) 60%);
  display:flex;flex-direction:column;justify-content:center;align-items:center;gap:14px;padding:28px;z-index:20
}
#gate h1{margin:0;font-size:22px;letter-spacing:.12em}
#gate p{margin:0;color:var(--mut);font-size:13px;text-align:center;max-width:280px}
#gate input{
  width:100%;max-width:300px;background:var(--panel);border:1px solid var(--cyan);
  color:var(--text);padding:14px;border-radius:12px;font-size:16px;text-align:center
}
#gate button{
  background:var(--pink);color:#16040a;border:none;padding:14px 22px;border-radius:12px;font-weight:800
}
.err{color:var(--pink)}
</style>
</head>
<body>
<div id="gate">
  <h1>PHONE<span style="color:var(--cyan)">BRIDGE</span></h1>
  <p>Talk to <b>Grok</b> on your PC while you're on the couch. Same WiFi. Access key from the PC terminal.</p>
  <input id="key" type="text" autocapitalize="off" autocomplete="off" autocorrect="off" placeholder="access key" enterkeyhint="go">
  <button id="connectBtn">CONNECT</button>
  <p id="gateErr" class="err" style="display:none"></p>
</div>

<div id="app" style="display:none">
  <header>
    <div class="logo">GROK <span>BRIDGE</span></div>
    <div id="state" class="pill">…</div>
    <div class="spacer"></div>
    <button type="button" id="statusBtn">status</button>
    <button type="button" id="resetBtn">new chat</button>
  </header>
  <div id="log"></div>
  <div class="composer">
    <div class="quick" id="quick">
      <button type="button" data-q="Continue the Year 2100 bible. Summarize where we left off in 5 bullets, then ask me the next decision.">bible status</button>
      <button type="button" data-q="Open and update YEAR_2100_GAME_BIBLE.md. Deep-dive Heartlight: write a richer zone entry (feel, landmarks, NPCs, quest hooks) and mark open questions for me.">Heartlight</button>
      <button type="button" data-q="List all Meridian / Grillonia zones from the bible and flag any names that still feel too close to Wizard101.">zone list</button>
      <button type="button" data-q="What should we lock next for Year 2100? Give 3 options with recommendations.">what's next</button>
    </div>
    <form id="f">
      <textarea id="t" rows="1" placeholder="Tell Grok what to do…" enterkeyhint="send"></textarea>
      <button id="send" type="submit">GO</button>
    </form>
  </div>
</div>

<script>
const $ = (s) => document.querySelector(s);
let KEY = localStorage.getItem('bridgeKey') || '';
let busy = false;

function setState(mode, label){
  const el = $('#state');
  el.className = 'pill' + (mode ? ' ' + mode : '');
  el.textContent = label;
}

function add(cls, txt, opts={}){
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  if (cls === 'ai') {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = 'GROK';
    d.appendChild(who);
    if (opts.thought) {
      const th = document.createElement('div');
      th.className = 'thought';
      th.textContent = opts.thought;
      d.appendChild(th);
    }
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = txt;
    d.appendChild(body);
  } else {
    d.textContent = txt;
  }
  $('#log').appendChild(d);
  $('#log').scrollTop = 1e9;
  return d;
}

function sys(t){
  const d = document.createElement('div');
  d.className = 'msg sys';
  d.textContent = t;
  $('#log').appendChild(d);
  $('#log').scrollTop = 1e9;
}

async function api(path, opts={}){
  const headers = Object.assign({'Content-Type':'application/json','x-key': KEY}, opts.headers||{});
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  if (r.status === 401) throw new Error('bad key');
  return r.json();
}

async function connect(){
  KEY = $('#key').value.trim() || KEY;
  if (!KEY) return;
  try {
    const h = await fetch('/health').then(r=>r.json());
    // validate key via status
    KEY && localStorage.setItem('bridgeKey', KEY);
    await api('/status');
    localStorage.setItem('bridgeKey', KEY);
    $('#gate').style.display = 'none';
    $('#app').style.display = 'flex';
    setState('on', 'online');
    sys('Connected · Grok on your PC · work dir ready');
    sys('Tip: leave the PC awake + PhoneBridge window open.');
  } catch (e) {
    $('#gateErr').style.display = 'block';
    $('#gateErr').textContent = e.message === 'bad key' ? 'Wrong access key' : ('Connect failed: ' + e.message);
    localStorage.removeItem('bridgeKey');
  }
}

$('#connectBtn').onclick = connect;
$('#key').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
if (KEY) { $('#key').value = KEY; connect(); }

$('#resetBtn').onclick = async () => {
  try {
    await api('/reset', { method:'POST', body:'{}' });
    sys('Fresh conversation (new Grok session next message)');
  } catch (e) { sys('Reset failed: ' + e.message); }
};

$('#statusBtn').onclick = async () => {
  try {
    const s = await api('/status');
    sys('Work: ' + s.workDir + (s.hasSession ? ' · session yes' : ' · new session'));
  } catch (e) { sys('Status failed: ' + e.message); }
};

document.querySelectorAll('#quick button').forEach(b => {
  b.onclick = () => {
    $('#t').value = b.getAttribute('data-q');
    $('#t').dispatchEvent(new Event('input'));
    $('#t').focus();
  };
});

const t = $('#t');
t.addEventListener('input', () => {
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 140) + 'px';
});

$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const m = t.value.trim();
  if (!m) return;
  t.value = '';
  t.style.height = 'auto';
  add('me', m);
  busy = true;
  $('#send').disabled = true;
  setState('busy', 'working…');
  const bubble = add('ai', '…queued');
  const bodyEl = bubble.querySelector('.body');
  try {
    const start = await api('/chat', { method:'POST', body: JSON.stringify({ message: m }) });
    const jobId = start.jobId;
    bodyEl.textContent = '…running on PC';
    // poll
    let guard = 0;
    while (guard++ < 3000) {
      await new Promise(r => setTimeout(r, 700));
      const j = await api('/job/' + jobId);
      if (j.thought) {
        let th = bubble.querySelector('.thought');
        if (!th) {
          th = document.createElement('div');
          th.className = 'thought';
          bubble.insertBefore(th, bodyEl);
        }
        th.textContent = j.thought;
      }
      if (j.text) bodyEl.textContent = j.text;
      if (j.status === 'done' || j.status === 'error') {
        if (j.status === 'error') bodyEl.textContent = j.error || j.text || 'error';
        if (!bodyEl.textContent) bodyEl.textContent = '(no reply)';
        break;
      }
    }
    setState('on', 'online');
  } catch (err) {
    bodyEl.textContent = 'Error: ' + err.message;
    if (err.message === 'bad key') {
      localStorage.removeItem('bridgeKey');
      setTimeout(() => location.reload(), 800);
    }
    setState('', 'error');
  } finally {
    busy = false;
    $('#send').disabled = false;
    $('#log').scrollTop = 1e9;
  }
});
</script>
</body>
</html>`;

// --- Boot --------------------------------------------------------------------
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out.sort((a) => (/^192\.168\.|^10\.|^172\./.test(a) ? -1 : 1));
}

server.listen(PORT, HOST, () => {
  const ips = lanIPs();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║     PHONEBRIDGE v2  ·  GROK ON YOUR PC       ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('  Work folder   : ' + WORK_DIR);
  console.log('  Bible folder  : ' + BIBLE_DIR + (fs.existsSync(BIBLE_DIR) ? ' (found)' : ' (missing)'));
  console.log('  Grok binary   : ' + (fs.existsSync(GROK_BIN) ? GROK_BIN : 'grok (PATH)'));
  console.log('  Access key    : ' + ACCESS_KEY);
  console.log('');
  console.log('  On your phone (same WiFi), open:');
  if (ips.length) ips.forEach((ip) => console.log('     http://' + ip + ':' + PORT));
  else console.log('     http://localhost:' + PORT);
  console.log('');
  console.log('  Leave this window open. Keep PC awake.');
  console.log('  Ctrl+C to stop.\n');
});
