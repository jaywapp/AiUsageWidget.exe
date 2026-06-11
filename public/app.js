'use strict';

const COLORS = {
  claude: '#d97757',
  codex: '#4f9cf9',
  donut: ['#d97757', '#4f9cf9', '#46c481', '#e4b54c', '#9b7ede', '#e0564f', '#5ad0c6', '#c0c5d4'],
};

let summary = null;
let sourceFilter = 'all'; // all | claude | codex
let period = 'daily';
let metric = 'tokens';
let periodChart = null;
let modelChart = null;

// ---------- 포맷터 ----------
function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtCost(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNum(n) { return n.toLocaleString('ko-KR'); }
function fmtDateTime(ts) {
  return new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function pick(v) {
  // v = {claude:{tokens,cost}, codex:{tokens,cost}}
  if (sourceFilter === 'all') {
    return { tokens: v.claude.tokens + v.codex.tokens, cost: v.claude.cost + v.codex.cost };
  }
  return v[sourceFilter];
}

// ---------- 렌더링 ----------
function renderKPI() {
  const map = [
    ['today', 'kpiToday', 'kpiTodayCost'],
    ['week', 'kpiWeek', 'kpiWeekCost'],
    ['month', 'kpiMonth', 'kpiMonthCost'],
    ['total', 'kpiTotal', 'kpiTotalCost'],
  ];
  for (const [key, valId, costId] of map) {
    const v = pick(summary.kpi[key]);
    document.getElementById(valId).textContent = fmtTokens(v.tokens) + ' 토큰';
    document.getElementById(costId).textContent = '환산 비용 ' + fmtCost(v.cost);
  }
}

function gaugeClass(pct, base) {
  if (pct >= 90) return 'gauge-fill danger';
  if (pct >= 70) return 'gauge-fill warn';
  return 'gauge-fill ' + base;
}

function renderPlan() {
  const c = summary.plan.claude;
  document.getElementById('claudePlanName').textContent = c.plan ? `${c.plan} 플랜` : '플랜 미확인';
  const bar5h = document.getElementById('claude5hBar');
  bar5h.style.width = c.pct5h.toFixed(1) + '%';
  bar5h.className = gaugeClass(c.pct5h, 'claude');
  document.getElementById('claude5hDetail').textContent =
    `${fmtTokens(c.last5hTokens)} / ${fmtTokens(c.limit5hTokens)} (${c.pct5h.toFixed(0)}%)`;
  const bar7d = document.getElementById('claude7dBar');
  bar7d.style.width = c.pct7d.toFixed(1) + '%';
  bar7d.className = gaugeClass(c.pct7d, 'claude');
  document.getElementById('claude7dDetail').textContent =
    `${fmtTokens(c.last7dTokens)} / ${fmtTokens(c.limit7dTokens)} (${c.pct7d.toFixed(0)}%)`;
  document.getElementById('claudeEstimateNote').textContent = c.limitIsEstimate
    ? '※ 공식 한도가 로그에 없어 과거 관측 최대 사용량을 한도로 가정한 추정치입니다. config.json에서 한도를 직접 지정할 수 있습니다.'
    : '한도: config.json 사용자 지정값';

  const x = summary.plan.codex;
  if (!x) {
    document.getElementById('codexPlanName').textContent = '데이터 없음';
    return;
  }
  document.getElementById('codexPlanName').textContent = x.plan ? `${x.plan} 플랜` : '플랜 미확인';
  if (x.primary) {
    const p = x.primary.usedPercent || 0;
    const bar = document.getElementById('codexPrimaryBar');
    bar.style.width = Math.min(100, p) + '%';
    bar.className = gaugeClass(p, 'codex');
    const reset = x.primary.resetsAt ? ` · ${fmtDateTime(x.primary.resetsAt)} 리셋` : '';
    document.getElementById('codexPrimaryDetail').textContent = `${p.toFixed(1)}% 사용${reset}`;
  }
  if (x.secondary) {
    const p = x.secondary.usedPercent || 0;
    const bar = document.getElementById('codexSecondaryBar');
    bar.style.width = Math.min(100, p) + '%';
    bar.className = gaugeClass(p, 'codex');
    const reset = x.secondary.resetsAt ? ` · ${fmtDateTime(x.secondary.resetsAt)} 리셋` : '';
    document.getElementById('codexSecondaryDetail').textContent = `${p.toFixed(1)}% 사용${reset}`;
  }
  document.getElementById('codexCaptureNote').textContent =
    `※ Codex CLI가 기록한 공식 한도 기준 (${fmtDateTime(x.capturedAt)} 측정)`;
}

function renderPeriodChart() {
  const series = summary[period];
  const labels = series.map((d) => {
    if (period === 'monthly') return d.key;
    if (period === 'weekly') return d.key.slice(5) + '주';
    return d.key.slice(5);
  });
  const val = (d, src) => (metric === 'tokens' ? d[src].tokens : d[src].cost);

  const datasets = [];
  if (sourceFilter === 'all' || sourceFilter === 'claude') {
    datasets.push({
      label: 'Claude', data: series.map((d) => val(d, 'claude')),
      backgroundColor: COLORS.claude, stack: 's', borderRadius: 3,
    });
  }
  if (sourceFilter === 'all' || sourceFilter === 'codex') {
    datasets.push({
      label: 'Codex', data: series.map((d) => val(d, 'codex')),
      backgroundColor: COLORS.codex, stack: 's', borderRadius: 3,
    });
  }

  const fmt = metric === 'tokens' ? fmtTokens : fmtCost;
  const cfg = {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: '#8b91a3' } },
        y: {
          stacked: true, grid: { color: '#2a2f3e' },
          ticks: { color: '#8b91a3', callback: (v) => fmt(v) },
        },
      },
      plugins: {
        legend: { labels: { color: '#e8eaf0' } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,
            footer: (items) => '합계: ' + fmt(items.reduce((s, i) => s + i.parsed.y, 0)),
          },
        },
      },
    },
  };

  if (periodChart) { periodChart.destroy(); }
  periodChart = new Chart(document.getElementById('periodChart'), cfg);
}

function filteredModels() {
  return summary.models.filter((m) => sourceFilter === 'all' || m.source === sourceFilter);
}

function renderModelChart() {
  const rows = filteredModels();
  const top = rows.slice(0, 7);
  const rest = rows.slice(7);
  const labels = top.map((m) => m.model);
  const data = top.map((m) => m.cost);
  if (rest.length) {
    labels.push('기타');
    data.push(rest.reduce((s, m) => s + m.cost, 0));
  }
  const cfg = {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: COLORS.donut, borderColor: '#181b24', borderWidth: 2 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#e8eaf0', boxWidth: 12 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtCost(ctx.parsed)}` } },
      },
    },
  };
  if (modelChart) modelChart.destroy();
  modelChart = new Chart(document.getElementById('modelChart'), cfg);
}

function renderModelTable() {
  const tbody = document.querySelector('#modelTable tbody');
  tbody.innerHTML = '';
  for (const m of filteredModels()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${m.model}</td>
      <td><span class="badge ${m.source}">${m.source === 'claude' ? 'Claude' : 'Codex'}</span></td>
      <td class="num">${fmtNum(m.input)}</td>
      <td class="num">${fmtNum(m.output)}</td>
      <td class="num">${fmtNum(m.cacheRead)}</td>
      <td class="num">${fmtNum(m.cacheWrite)}</td>
      <td class="num">${fmtNum(m.tokens)}</td>
      <td class="num">${fmtCost(m.cost)}</td>`;
    tbody.appendChild(tr);
  }
}

function renderAll() {
  if (!summary) return;
  renderKPI();
  renderPlan();
  renderPeriodChart();
  renderModelChart();
  renderModelTable();
  document.getElementById('updatedAt').textContent =
    '갱신: ' + new Date(summary.generatedAt).toLocaleTimeString('ko-KR');
}

// ---------- 데이터 로드 ----------
async function load() {
  try {
    const res = await fetch('/api/summary');
    summary = await res.json();
    renderAll();
  } catch (e) {
    document.getElementById('status').textContent = '서버 연결 실패';
  }
}

// ---------- 이벤트 ----------
function bindSeg(id, onPick) {
  document.getElementById(id).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    for (const b of e.currentTarget.querySelectorAll('button')) b.classList.remove('active');
    btn.classList.add('active');
    onPick(btn.dataset);
  });
}

bindSeg('sourceFilter', (d) => { sourceFilter = d.source; renderAll(); });
bindSeg('periodTabs', (d) => { period = d.period; renderPeriodChart(); });
bindSeg('metricTabs', (d) => { metric = d.metric; renderPeriodChart(); });

// SSE 실시간 갱신
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    const s = document.getElementById('status');
    s.textContent = '실시간 연결됨';
    s.classList.add('live');
  };
  es.onmessage = () => load();
  es.onerror = () => {
    const s = document.getElementById('status');
    s.textContent = '재연결 중…';
    s.classList.remove('live');
  };
}

load();
connectSSE();
