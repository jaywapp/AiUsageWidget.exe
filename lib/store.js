'use strict';

const fs = require('fs');
const path = require('path');
const { buildPricingResolver, costOf } = require('./pricing');

const HOUR = 3600 * 1000;

// ---------- 라인 파서 ----------

// Claude Code transcript 한 줄 → record | null
function parseClaudeLine(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || obj.type !== 'assistant' || !obj.message || !obj.message.usage || !obj.timestamp) return null;
  const u = obj.message.usage;
  const model = obj.message.model || 'unknown';
  if (model === '<synthetic>') return null;
  const ts = Date.parse(obj.timestamp);
  if (!Number.isFinite(ts)) return null;
  const msgId = obj.message.id || '';
  const reqId = obj.requestId || '';
  return {
    ts,
    source: 'claude',
    model,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    hash: msgId || reqId ? `${msgId}:${reqId}` : null,
  };
}

// Codex 세션 파일 전체 → { records, rateLimit }
// token_count 이벤트의 누적치(total_token_usage)를 직전 값과의 델타로 환산.
function parseCodexFile(content) {
  const records = [];
  let rateLimit = null;
  let currentModel = 'gpt-unknown';
  let prev = null; // 직전 누적치
  for (const line of content.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const p = obj && obj.payload;
    if (!p) continue;
    // turn_context는 top-level type으로 기록되고 payload에 model이 직접 들어 있다.
    if ((obj.type === 'turn_context' || p.type === 'turn_context') && p.model) {
      currentModel = p.model;
      continue;
    }
    if (p.type === 'token_count') {
      const info = p.info;
      if (info && info.total_token_usage) {
        const t = info.total_token_usage;
        const ts = Date.parse(obj.timestamp);
        if (Number.isFinite(ts)) {
          const cur = {
            input: t.input_tokens || 0,
            cached: t.cached_input_tokens || 0,
            output: t.output_tokens || 0,
          };
          let d;
          if (!prev || cur.input < prev.input || cur.output < prev.output) {
            d = cur; // 첫 이벤트 또는 카운터 리셋
          } else {
            d = {
              input: cur.input - prev.input,
              cached: Math.max(0, cur.cached - prev.cached),
              output: cur.output - prev.output,
            };
          }
          prev = cur;
          if (d.input > 0 || d.output > 0) {
            records.push({
              ts,
              source: 'codex',
              model: currentModel,
              input: Math.max(0, d.input - d.cached),
              output: d.output,
              cacheRead: d.cached,
              cacheWrite: 0,
              hash: null,
            });
          }
        }
      }
      if (p.rate_limits) {
        const ts = Date.parse(obj.timestamp);
        rateLimit = { capturedAt: Number.isFinite(ts) ? ts : Date.now(), ...p.rate_limits };
      }
    }
  }
  return { records, rateLimit };
}

function parseClaudeFile(content) {
  const records = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    const r = parseClaudeLine(line);
    if (r) records.push(r);
  }
  return { records, rateLimit: null };
}

// ---------- 디렉터리 스캔 ----------

function listFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

// ---------- 로컬 타임존 버킷 헬퍼 ----------

function localDateStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localMonthStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 주 시작(월요일)의 날짜 문자열
function localWeekStartStr(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 월=0
  d.setDate(d.getDate() - day);
  return localDateStr(d.getTime());
}

const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function addUsage(target, r) {
  target.input += r.input;
  target.output += r.output;
  target.cacheRead += r.cacheRead;
  target.cacheWrite += r.cacheWrite;
}

function totalTokens(u) {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

// ---------- 스토어 ----------

class UsageStore {
  constructor(opts = {}) {
    this.claudeDir = opts.claudeDir;
    this.codexDir = opts.codexDir;
    this.pricingResolver = buildPricingResolver(opts.pricingOverrides);
    this.config = opts.config || {};
    this.fileCache = new Map(); // path -> {mtimeMs, size, records, rateLimit, source}
    this.codexRateLimit = null;
    this.lastRefresh = 0;
  }

  refresh() {
    const seen = new Set();
    const scan = (dir, source, parser) => {
      if (!dir) return false;
      const files = listFiles(dir);
      for (const f of files) {
        seen.add(f);
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        const cached = this.fileCache.get(f);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
        let content;
        try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
        const parsed = parser(content);
        this.fileCache.set(f, {
          mtimeMs: st.mtimeMs, size: st.size, source,
          records: parsed.records, rateLimit: parsed.rateLimit,
        });
      }
      return files.length > 0;
    };

    const claudeAvailable = scan(this.claudeDir, 'claude', parseClaudeFile);
    const codexAvailable = scan(this.codexDir, 'codex', parseCodexFile);

    // 삭제된 파일 정리
    for (const key of this.fileCache.keys()) {
      if (!seen.has(key)) this.fileCache.delete(key);
    }

    // 최신 codex rate limit
    let latest = null;
    for (const entry of this.fileCache.values()) {
      if (entry.rateLimit && (!latest || entry.rateLimit.capturedAt > latest.capturedAt)) {
        latest = entry.rateLimit;
      }
    }
    this.codexRateLimit = latest;
    this.availability = { claude: claudeAvailable, codex: codexAvailable };
    this.lastRefresh = Date.now();
  }

  // 전역 중복 제거 후 전체 레코드 순회
  *records() {
    const dedup = new Set();
    for (const entry of this.fileCache.values()) {
      for (const r of entry.records) {
        if (r.hash) {
          if (dedup.has(r.hash)) continue;
          dedup.add(r.hash);
        }
        yield r;
      }
    }
  }

  buildSummary(now = Date.now()) {
    const models = new Map(); // `${source}|${model}` -> usage
    const fileCounts = { claude: 0, codex: 0 };
    for (const entry of this.fileCache.values()) fileCounts[entry.source]++;

    const costForModelUsage = (model, usage) => costOf(usage, this.pricingResolver(model));

    // 시간×소스×모델 버킷 — 모든 기간 집계와 비용 계산의 기반.
    const hourlyModel = new Map(); // hourEpoch|source|model -> usage
    for (const r of this.records()) {
      const hour = Math.floor(r.ts / HOUR) * HOUR;
      const key = `${hour}|${r.source}|${r.model}`;
      let u = hourlyModel.get(key);
      if (!u) { u = ZERO(); hourlyModel.set(key, u); }
      addUsage(u, r);

      const mk = `${r.source}|${r.model}`;
      let m = models.get(mk);
      if (!m) { m = ZERO(); models.set(mk, m); }
      addUsage(m, r);
    }

    // 기간 버킷 (일/주/월) — {key -> {claude:{tokens,cost}, codex:{tokens,cost}}}
    const daily = new Map(), weekly = new Map(), monthly = new Map();
    const bump = (map, key, source, tokens, cost) => {
      let v = map.get(key);
      if (!v) { v = { claude: { tokens: 0, cost: 0 }, codex: { tokens: 0, cost: 0 } }; map.set(key, v); }
      v[source].tokens += tokens;
      v[source].cost += cost;
    };

    // KPI 경계
    const todayKey = localDateStr(now);
    const weekKey = localWeekStartStr(now);
    const monthKey = localMonthStr(now);
    const kpi = {
      today: { claude: { tokens: 0, cost: 0 }, codex: { tokens: 0, cost: 0 } },
      week: { claude: { tokens: 0, cost: 0 }, codex: { tokens: 0, cost: 0 } },
      month: { claude: { tokens: 0, cost: 0 }, codex: { tokens: 0, cost: 0 } },
      total: { claude: { tokens: 0, cost: 0 }, codex: { tokens: 0, cost: 0 } },
    };

    // 소스별 시간 시리즈(롤링 윈도우 계산용): hourEpoch -> tokens (claude만 필요하지만 둘 다)
    const hourlyTokens = { claude: new Map(), codex: new Map() };
    const hourlyCost = { claude: new Map(), codex: new Map() };

    for (const [key, u] of hourlyModel) {
      const [hourStr, source, model] = key.split('|');
      const hour = Number(hourStr);
      const tokens = totalTokens(u);
      const cost = costForModelUsage(model, u);
      bump(daily, localDateStr(hour), source, tokens, cost);
      bump(weekly, localWeekStartStr(hour), source, tokens, cost);
      bump(monthly, localMonthStr(hour), source, tokens, cost);
      hourlyTokens[source].set(hour, (hourlyTokens[source].get(hour) || 0) + tokens);
      hourlyCost[source].set(hour, (hourlyCost[source].get(hour) || 0) + cost);

      if (localDateStr(hour) === todayKey) { kpi.today[source].tokens += tokens; kpi.today[source].cost += cost; }
      if (localWeekStartStr(hour) === weekKey) { kpi.week[source].tokens += tokens; kpi.week[source].cost += cost; }
      if (localMonthStr(hour) === monthKey) { kpi.month[source].tokens += tokens; kpi.month[source].cost += cost; }
      kpi.total[source].tokens += tokens;
      kpi.total[source].cost += cost;
    }

    // 일별 30일 / 주별 12주 / 월별 12개월 시리즈 생성 (빈 구간 0 채움)
    const dailySeries = [];
    for (let i = 29; i >= 0; i--) {
      const key = localDateStr(now - i * 24 * HOUR);
      const v = daily.get(key) || { claude: { tokens: 0, cost: 0 }, codex: { tokens: 0, cost: 0 } };
      dailySeries.push({ key, ...v });
    }
    const weeklySeries = [];
    {
      const cur = new Date(weekKey + 'T00:00:00');
      for (let i = 11; i >= 0; i--) {
        const d = new Date(cur);
        d.setDate(d.getDate() - i * 7);
        const key = localDateStr(d.getTime());
        const v = weekly.get(key) || { claude: { tokens: 0, cost: 0 }, codex: { tokens: 0, cost: 0 } };
        weeklySeries.push({ key, ...v });
      }
    }
    const monthlySeries = [];
    {
      const d = new Date(now);
      d.setDate(1); d.setHours(0, 0, 0, 0);
      for (let i = 11; i >= 0; i--) {
        const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
        const key = localMonthStr(m.getTime());
        const v = monthly.get(key) || { claude: { tokens: 0, cost: 0 }, codex: { tokens: 0, cost: 0 } };
        monthlySeries.push({ key, ...v });
      }
    }

    // 모델별 테이블
    const modelRows = [];
    for (const [key, u] of models) {
      const [source, model] = key.split('|');
      modelRows.push({
        source, model,
        input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
        tokens: totalTokens(u),
        cost: costForModelUsage(model, u),
      });
    }
    modelRows.sort((a, b) => b.cost - a.cost);

    // 롤링 윈도우 (Claude 추정 게이지)
    const rolling = (map, hours, endTs) => {
      let sum = 0;
      const endHour = Math.floor(endTs / HOUR) * HOUR;
      for (let h = endHour - (hours - 1) * HOUR; h <= endHour; h += HOUR) {
        sum += map.get(h) || 0;
      }
      return sum;
    };
    const rollingMax = (map, hours) => {
      let max = 0;
      for (const h of map.keys()) {
        const v = rolling(map, hours, h);
        if (v > max) max = v;
      }
      return max;
    };

    const claudeLast5h = rolling(hourlyTokens.claude, 5, now);
    const claudeLast7d = rolling(hourlyTokens.claude, 24 * 7, now);
    const claudeMax5h = Math.max(rollingMax(hourlyTokens.claude, 5), 1);
    const claudeMax7d = Math.max(rollingMax(hourlyTokens.claude, 24 * 7), 1);
    const cfgClaude = (this.config.claudePlan || {});
    const limit5h = cfgClaude.limit5hTokens || claudeMax5h;
    const limit7d = cfgClaude.limit7dTokens || claudeMax7d;

    const cr = this.codexRateLimit;

    return {
      generatedAt: now,
      sources: {
        claude: { available: !!(this.availability && this.availability.claude), files: fileCounts.claude },
        codex: { available: !!(this.availability && this.availability.codex), files: fileCounts.codex },
      },
      kpi,
      daily: dailySeries,
      weekly: weeklySeries,
      monthly: monthlySeries,
      models: modelRows,
      plan: {
        claude: {
          plan: cfgClaude.name || this.detectClaudePlan() || null,
          last5hTokens: claudeLast5h,
          limit5hTokens: limit5h,
          pct5h: Math.min(100, (claudeLast5h / limit5h) * 100),
          last7dTokens: claudeLast7d,
          limit7dTokens: limit7d,
          pct7d: Math.min(100, (claudeLast7d / limit7d) * 100),
          limitIsEstimate: !cfgClaude.limit5hTokens,
        },
        codex: cr ? {
          plan: cr.plan_type || null,
          primary: cr.primary ? {
            usedPercent: cr.primary.used_percent,
            windowMinutes: cr.primary.window_minutes,
            resetsAt: cr.primary.resets_at ? cr.primary.resets_at * 1000 : null,
          } : null,
          secondary: cr.secondary ? {
            usedPercent: cr.secondary.used_percent,
            windowMinutes: cr.secondary.window_minutes,
            resetsAt: cr.secondary.resets_at ? cr.secondary.resets_at * 1000 : null,
          } : null,
          capturedAt: cr.capturedAt,
        } : null,
      },
    };
  }

  detectClaudePlan() {
    try {
      const credPath = path.join(path.dirname(this.claudeDir), '.credentials.json');
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      const sub = cred && cred.claudeAiOauth && cred.claudeAiOauth.subscriptionType;
      return sub || null;
    } catch { return null; }
  }
}

module.exports = {
  UsageStore,
  parseClaudeLine,
  parseCodexFile,
  parseClaudeFile,
  localDateStr,
  localWeekStartStr,
  localMonthStr,
};
