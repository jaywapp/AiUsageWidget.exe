'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseClaudeLine, parseCodexFile, UsageStore } = require('../lib/store');
const { buildPricingResolver, costOf } = require('../lib/pricing');

test('parseClaudeLine: assistant usage 항목 파싱', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-10T21:21:33.354Z',
    requestId: 'req_1',
    message: {
      id: 'msg_1',
      model: 'claude-fable-5',
      usage: {
        input_tokens: 100, output_tokens: 50,
        cache_read_input_tokens: 1000, cache_creation_input_tokens: 200,
      },
    },
  });
  const r = parseClaudeLine(line);
  assert.ok(r);
  assert.strictEqual(r.source, 'claude');
  assert.strictEqual(r.model, 'claude-fable-5');
  assert.strictEqual(r.input, 100);
  assert.strictEqual(r.output, 50);
  assert.strictEqual(r.cacheRead, 1000);
  assert.strictEqual(r.cacheWrite, 200);
  assert.strictEqual(r.hash, 'msg_1:req_1');
});

test('parseClaudeLine: usage 없는 라인/깨진 JSON은 null', () => {
  assert.strictEqual(parseClaudeLine('{"type":"user"}'), null);
  assert.strictEqual(parseClaudeLine('not json'), null);
  assert.strictEqual(parseClaudeLine(JSON.stringify({
    type: 'assistant', timestamp: '2026-06-10T00:00:00Z',
    message: { model: '<synthetic>', usage: { input_tokens: 1 } },
  })), null);
});

test('parseCodexFile: 누적치 → 델타 환산 + 모델 추적 + rate limit', () => {
  const mk = (ts, payload) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload });
  const content = [
    mk('2026-06-01T10:00:00Z', { type: 'turn_context', model: 'gpt-5.5' }),
    mk('2026-06-01T10:01:00Z', {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 } },
      rate_limits: { plan_type: 'plus', primary: { used_percent: 5, window_minutes: 300, resets_at: 1780237040 } },
    }),
    mk('2026-06-01T10:05:00Z', {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 3000, cached_input_tokens: 2500, output_tokens: 300 } },
      rate_limits: { plan_type: 'plus', primary: { used_percent: 7, window_minutes: 300, resets_at: 1780237040 } },
    }),
  ].join('\n');
  const { records, rateLimit } = parseCodexFile(content);
  assert.strictEqual(records.length, 2);
  // 첫 이벤트: 누적치 그대로
  assert.strictEqual(records[0].model, 'gpt-5.5');
  assert.strictEqual(records[0].input, 200); // 1000 - 800 cached
  assert.strictEqual(records[0].cacheRead, 800);
  assert.strictEqual(records[0].output, 100);
  // 두 번째: 델타 (input 2000 중 cached 1700 → input 300)
  assert.strictEqual(records[1].input, 300);
  assert.strictEqual(records[1].cacheRead, 1700);
  assert.strictEqual(records[1].output, 200);
  // rate limit은 최신 값
  assert.strictEqual(rateLimit.primary.used_percent, 7);
  assert.strictEqual(rateLimit.plan_type, 'plus');
});

test('parseCodexFile: 카운터 리셋 시 누적치 재시작', () => {
  const mk = (ts, t) => JSON.stringify({
    timestamp: ts, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: t } },
  });
  const content = [
    mk('2026-06-01T10:00:00Z', { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 500 }),
    mk('2026-06-01T11:00:00Z', { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 }),
  ].join('\n');
  const { records } = parseCodexFile(content);
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[1].input, 100);
  assert.strictEqual(records[1].output, 10);
});

test('pricing: 모델 매칭 및 비용 계산', () => {
  const resolve = buildPricingResolver();
  const fable = resolve('claude-fable-5');
  assert.strictEqual(fable.input, 10);
  assert.strictEqual(fable.output, 50);
  const cost = costOf({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, fable);
  assert.strictEqual(cost, 10);
  const gpt = resolve('gpt-5.5');
  assert.strictEqual(gpt.input, 1.25);
  const override = buildPricingResolver({ 'gpt-5.5': { input: 2, output: 8 } });
  assert.strictEqual(override('gpt-5.5').input, 2);
});

test('UsageStore: 전역 중복 제거 + 집계 + KPI', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
  const claudeDir = path.join(tmp, '.claude', 'projects', 'p1');
  const codexDir = path.join(tmp, '.codex', 'sessions');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });

  const now = Date.now();
  const iso = new Date(now).toISOString();
  const claudeEntry = (id, output) => JSON.stringify({
    type: 'assistant', timestamp: iso, requestId: 'req_' + id,
    message: {
      id: 'msg_' + id, model: 'claude-fable-5',
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  // 같은 메시지가 두 번 기록(스트리밍 중복) + 다른 메시지 1개
  fs.writeFileSync(path.join(claudeDir, 'a.jsonl'),
    [claudeEntry('1', 100), claudeEntry('1', 100), claudeEntry('2', 50)].join('\n'));

  fs.writeFileSync(path.join(codexDir, 'r.jsonl'), [
    JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'turn_context', model: 'gpt-5.5' } }),
    JSON.stringify({
      timestamp: iso, type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 } },
        rate_limits: { plan_type: 'plus', primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1780237040 }, secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1780697901 } },
      },
    }),
  ].join('\n'));

  const store = new UsageStore({ claudeDir: path.join(tmp, '.claude', 'projects'), codexDir });
  store.refresh();
  const s = store.buildSummary(now);

  // 중복 제거: claude 토큰 = (10+100) + (10+50) = 170
  assert.strictEqual(s.kpi.total.claude.tokens, 170);
  assert.strictEqual(s.kpi.total.codex.tokens, 1200);
  assert.strictEqual(s.kpi.today.claude.tokens, 170);

  // 모델별
  const fableRow = s.models.find((m) => m.model === 'claude-fable-5');
  assert.strictEqual(fableRow.output, 150);
  const gptRow = s.models.find((m) => m.model === 'gpt-5.5');
  assert.strictEqual(gptRow.input, 1000);

  // Codex 플랜
  assert.strictEqual(s.plan.codex.plan, 'plus');
  assert.strictEqual(s.plan.codex.primary.usedPercent, 12.5);
  assert.strictEqual(s.plan.codex.secondary.windowMinutes, 10080);

  // Claude 추정 게이지: 한도 미설정 → 관측 최대치 기준 100%
  assert.strictEqual(s.plan.claude.limitIsEstimate, true);
  assert.ok(s.plan.claude.pct5h > 0);

  // 시리즈 길이
  assert.strictEqual(s.daily.length, 30);
  assert.strictEqual(s.weekly.length, 12);
  assert.strictEqual(s.monthly.length, 12);
  assert.strictEqual(s.daily[29].key, s.daily[29].key.slice(0, 10));
  assert.strictEqual(s.daily[29].claude.tokens, 170);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('UsageStore: 증분 캐시 — 파일 변경 시에만 재파싱', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test2-'));
  const claudeDir = path.join(tmp, 'projects', 'p');
  fs.mkdirSync(claudeDir, { recursive: true });
  const f = path.join(claudeDir, 'a.jsonl');
  const iso = new Date().toISOString();
  const entry = (id) => JSON.stringify({
    type: 'assistant', timestamp: iso, requestId: 'r' + id,
    message: { id: 'm' + id, model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 } },
  });
  fs.writeFileSync(f, entry('1'));
  const store = new UsageStore({ claudeDir: path.join(tmp, 'projects'), codexDir: null });
  store.refresh();
  assert.strictEqual(store.buildSummary().kpi.total.claude.tokens, 2);
  // 파일에 추가
  fs.appendFileSync(f, '\n' + entry('2'));
  store.refresh();
  assert.strictEqual(store.buildSummary().kpi.total.claude.tokens, 4);
  fs.rmSync(tmp, { recursive: true, force: true });
});
