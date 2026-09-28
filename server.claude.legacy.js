// © 2026 Mathew. All rights reserved.
// PhoneBridge - control this PC's Claude Code from your iPhone over home WiFi.
// Zero dependencies. Node built-ins only.
//
//   node server.js
//
// Then open the printed http://192.168.x.x:8770 URL in Safari on your phone
// (must be on the same WiFi). Type the access key once, then chat.

const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.BRIDGE_PORT || 8770);
// The project/folder Claude operates in. Defaults to CURSOR_1 (parent of this file).
const PROJECT_DIR = process.env.BRIDGE_PROJECT || path.resolve(__dirname, '..');

// --- Access key (so only you can drive it, not anyone on the WiFi) -----------
const KEY_FILE = path.join(__dirname, '.access-key');
let ACCESS_KEY;
if (process.env.BRIDGE_KEY) {
  ACCESS_KEY = process.env.BRIDGE_KEY;
} else if (fs.existsSync(KEY_FILE)) {
  ACCESS_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
} else {
  ACCESS_KEY = crypto.randomBytes(4).toString('hex'); // 8 hex chars
  fs.writeFileSync(KEY_FILE, ACCESS_KEY);
}

// --- Session continuity ------------------------------------------------------
const SESSION_FILE = path.join(__dirname, '.session');
let sessionId = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : '';

// Only one Claude call at a time: overlapping messages would collide trying to
// resume the same conversation. Queue them so they run in the order they arrive.
let chain = Promise.resolve();
function runClaude(message) {
  const job = chain.then(() => runClaudeNow(message));
  chain = job.catch(() => {}); // keep the queue alive even if one call fails
  return job;
}

function runClaudeNow(message) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions'];
    if (sessionId) args.push('--resume', sessionId);

    // shell:true so Windows finds the `claude` shim; the prompt goes via stdin
    // (never the command line) so there's no quoting/injection to worry about.
    const child = spawn('claude', args, { cwd: PROJECT_DIR, shell: true });

    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); }, 5 * 60 * 1000);

    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, text: 'Failed to launch claude: ' + e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.session_id) { sessionId = j.session_id; fs.writeFileSync(SESSION_FILE, sessionId); }
        resolve({ ok: true, text: (j.result != null ? String(j.result) : JSON.stringify(j)) });
      } catch (_) {
        resolve({ ok: false, text: (out || err || 'No output from claude.').slice(0, 4000) });
      }
    });

    child.stdin.write(message);
    child.stdin.end();
  });
}

// --- HTTP --------------------------------------------------------------------
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    return send(res, 200, 'text/html; charset=utf-8', PAGE);
  }

  if (req.method === 'POST' && req.url === '/chat') {
    if ((req.headers['x-key'] || '') !== ACCESS_KEY) return send(res, 401, 'application/json', JSON.stringify({ error: 'bad key' }));
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let message = '';
      try { message = JSON.parse(body).message || ''; } catch (_) {}
      if (!message.trim()) return send(res, 400, 'application/json', JSON.stringify({ error: 'empty' }));
      const r = await runClaude(message);
      send(res, 200, 'application/json', JSON.stringify({ reply: r.text, ok: r.ok }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/reset') {
    if ((req.headers['x-key'] || '') !== ACCESS_KEY) return send(res, 401, 'application/json', JSON.stringify({ error: 'bad key' }));
    sessionId = '';
    try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
    return send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  }

  send(res, 404, 'text/plain', 'not found');
});

const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Zarya Bridge</title>
<style>
  :root{--bg:#0a0a12;--panel:#12121f;--neon:#00f0ff;--pink:#ff2d7e;--text:#d8f8ff;--mut:#5a6b75}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font-family:ui-monospace,Menlo,Consolas,monospace}
  #app{display:flex;flex-direction:column;height:100dvh}
  header{padding:12px 14px;border-bottom:1px solid #1f2b33;display:flex;align-items:center;gap:8px}
  header b{color:var(--neon);letter-spacing:2px}
  header .dot{width:9px;height:9px;border-radius:50%;background:var(--pink);box-shadow:0 0 8px var(--pink)}
  header button{margin-left:auto;background:none;border:1px solid #2a3a44;color:var(--mut);border-radius:6px;padding:5px 9px;font-size:12px}
  #log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
  .msg{max-width:88%;padding:10px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word;line-height:1.4;font-size:15px}
  .me{align-self:flex-end;background:linear-gradient(135deg,#1a3a44,#163039);border:1px solid var(--neon)}
  .ai{align-self:flex-start;background:var(--panel);border:1px solid #2a1d2b}
  .ai b{color:var(--pink)}
  .sys{align-self:center;color:var(--mut);font-size:12px}
  form{display:flex;gap:8px;padding:10px;border-top:1px solid #1f2b33;background:var(--panel)}
  textarea{flex:1;resize:none;background:#0a0a12;border:1px solid #2a3a44;color:var(--text);border-radius:10px;padding:10px;font-size:16px;font-family:inherit;max-height:120px}
  form button{background:var(--neon);color:#021016;border:none;border-radius:10px;padding:0 16px;font-weight:700}
  form button:disabled{opacity:.4}
  #gate{position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;justify-content:center;align-items:center;gap:14px;padding:24px}
  #gate input{background:#0a0a12;border:1px solid var(--neon);color:var(--text);padding:12px;border-radius:10px;font-size:16px;width:100%;max-width:280px;text-align:center}
  #gate button{background:var(--pink);color:#150109;border:none;padding:12px 20px;border-radius:10px;font-weight:700}
</style></head><body>
<div id="gate">
  <div style="color:#00f0ff;letter-spacing:3px;font-weight:700">ZARYA // BRIDGE</div>
  <div style="color:#5a6b75;font-size:13px">enter access key</div>
  <input id="key" type="text" autocapitalize="off" autocorrect="off" inputmode="text" placeholder="key">
  <button onclick="saveKey()">CONNECT</button>
</div>
<div id="app" style="display:none">
  <header><span class="dot"></span><b>ZARYA</b><span style="color:#5a6b75;font-size:12px">bridge</span>
    <button onclick="reset()">new chat</button></header>
  <div id="log"></div>
  <form id="f"><textarea id="t" rows="1" placeholder="tell me what to do..." enterkeyhint="send"></textarea>
    <button id="send">GO</button></form>
</div>
<script>
let KEY = localStorage.getItem('bridgeKey') || '';
const $ = s => document.querySelector(s);
function saveKey(){ KEY = $('#key').value.trim(); if(!KEY) return; localStorage.setItem('bridgeKey',KEY); show(); }
function show(){ $('#gate').style.display='none'; $('#app').style.display='flex'; sys('connected to your PC'); }
if(KEY) show();
function add(cls,txt){ const d=document.createElement('div'); d.className='msg '+cls; d.textContent=txt; $('#log').appendChild(d); $('#log').scrollTop=1e9; return d; }
function sys(t){ const d=document.createElement('div'); d.className='msg sys'; d.textContent=t; $('#log').appendChild(d); $('#log').scrollTop=1e9; }
async function reset(){ await fetch('/reset',{method:'POST',headers:{'x-key':KEY}}); sys('started a fresh conversation'); }
const t=$('#t');
t.addEventListener('input',()=>{ t.style.height='auto'; t.style.height=Math.min(t.scrollHeight,120)+'px'; });
$('#f').addEventListener('submit', async e=>{
  e.preventDefault();
  const m=t.value.trim(); if(!m) return;
  t.value=''; t.style.height='auto'; add('me',m);
  $('#send').disabled=true;
  const wait=add('ai','...thinking');
  try{
    const r=await fetch('/chat',{method:'POST',headers:{'Content-Type':'application/json','x-key':KEY},body:JSON.stringify({message:m})});
    if(r.status===401){ wait.textContent='access key rejected'; localStorage.removeItem('bridgeKey'); return; }
    const j=await r.json();
    wait.textContent=j.reply||'(no reply)';
  }catch(err){ wait.textContent='connection error: '+err.message; }
  finally{ $('#send').disabled=false; }
});
</script></body></html>`;

// --- Boot --------------------------------------------------------------------
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) for (const i of ifs[name]) {
    if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  // Prefer typical home-LAN ranges first.
  return out.sort((a) => (/^192\.168\.|^10\.|^172\./.test(a) ? -1 : 1));
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('\n  ===== ZARYA PHONE BRIDGE =====');
  console.log('  Project folder : ' + PROJECT_DIR);
  console.log('  Access key     : ' + ACCESS_KEY + '   (type this on your phone, once)');
  console.log('\n  Open this in Safari on your iPhone (same WiFi):');
  if (ips.length) ips.forEach(ip => console.log('     http://' + ip + ':' + PORT));
  else console.log('     (no LAN IP found - check WiFi) http://localhost:' + PORT);
  console.log('\n  Leave this window open. Ctrl+C to stop.\n');
});
