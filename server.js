'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { UsageStore } = require('./lib/store');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}

const PORT = process.env.PORT || config.port || 4789;
const CLAUDE_DIR = config.claudeDir || path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = config.codexDir || path.join(os.homedir(), '.codex', 'sessions');

const store = new UsageStore({
  claudeDir: fs.existsSync(CLAUDE_DIR) ? CLAUDE_DIR : null,
  codexDir: fs.existsSync(CODEX_DIR) ? CODEX_DIR : null,
  pricingOverrides: config.pricingOverrides,
  config,
});

console.log('[usage-dashboard] 초기 스캔 중...');
const t0 = Date.now();
store.refresh();
console.log(`[usage-dashboard] 초기 스캔 완료 (${Date.now() - t0}ms)`);

// ---------- SSE 클라이언트 ----------
const sseClients = new Set();

function broadcast() {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify({ type: 'refresh', at: Date.now() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

// ---------- 파일 감시 (디바운스 재집계) ----------
let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    try {
      store.refresh();
      broadcast();
    } catch (e) {
      console.error('[usage-dashboard] refresh 실패:', e.message);
    }
  }, 2000);
}

for (const dir of [CLAUDE_DIR, CODEX_DIR]) {
  if (!fs.existsSync(dir)) continue;
  try {
    fs.watch(dir, { recursive: true }, () => scheduleRefresh());
    console.log(`[usage-dashboard] 감시 중: ${dir}`);
  } catch (e) {
    console.warn(`[usage-dashboard] 감시 실패 (${dir}): ${e.message}`);
  }
}
// 폴백 폴링 (60초)
setInterval(scheduleRefresh, 60_000).unref();

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/summary') {
    let body;
    try {
      body = JSON.stringify(store.buildSummary());
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 30_000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[usage-dashboard] http://localhost:${PORT}`);
});
