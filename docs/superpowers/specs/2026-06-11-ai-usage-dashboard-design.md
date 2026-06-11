# AI Usage Dashboard — 설계 문서 (2026-06-11)

## 목적
현재 PC의 AI 토큰 사용량(Claude Code + Codex CLI)을 실시간으로 보여주는 로컬 대시보드.
사용자 요구: 일간/주간/월간/월별 사용량, 도구별(Claude/Codex)·LLM 모델별 사용량, 플랜 대비 잔여 사용량.

사용자가 자율 진행을 요청했으므로(브레인스토밍 Q&A 생략) 본 문서가 설계 확정본 역할을 한다.

## 데이터 소스 (확인 완료)
| 소스 | 경로 | 형식 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (558개 파일) | `type:"assistant"` 항목의 `message.usage` (input/output/cache_read/cache_creation), `message.model`, `timestamp`, `requestId`+`message.id` (중복 제거 키) |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | `payload.type:"token_count"` 이벤트 — `info.total_token_usage` (세션 누적), `rate_limits` (5h/주간 used_percent, plan_type, resets_at), `turn_context.model` (예: gpt-5.5) |
| Claude 플랜 | `~/.claude/.credentials.json` → `subscriptionType` (로컬에서만 읽음) | 선택적 |

## 접근 방식 (선택)
- **A. Zero-dependency Node 서버 + 정적 SPA (채택)** — Node 22 내장 http/fs만 사용, Chart.js CDN. 설치 단계 없음, 견고함.
- B. Next.js — 과한 의존성/빌드. 기각.
- C. Electron/Tauri — 단순 대시보드에 과함. 기각.

## 아키텍처
```
ai-usage-dashboard/
  server.js          # http 서버, /api/summary, /api/events(SSE), 정적 파일
  lib/store.js       # 파일 스캔/파싱/증분 캐시/중복 제거/시간별 집계
  lib/pricing.js     # 모델별 단가 + 비용 계산 (config로 오버라이드 가능)
  config.json        # 포트, 플랜 설정, 가격 오버라이드
  public/            # index.html, app.js, style.css (한국어 UI)
  test/store.test.js # node:test
```

### 파싱/집계
- 레코드: `{ts, source(claude|codex), model, input, output, cacheRead, cacheWrite}`
- 중복 제거: Claude는 `message.id:requestId` 해시 전역 Set (동일 응답이 여러 줄로 기록됨 — 실측 확인).
- Codex: `token_count`의 `total_token_usage`를 세션 내 직전 값과의 **델타**로 환산해 이벤트 시각에 귀속. 모델은 직전 `turn_context.model`.
- 증분 캐시: 파일별 `{mtime,size}` 기준. 변경된 파일만 재파싱, 해당 파일 기여분 교체.
- 집계: 시간(epoch hour)×source×model 버킷 롤업 → 일/주/월은 로컬 타임존(Asia/Seoul) 기준 파생.

### 플랜 잔여량
- **Codex**: 세션 로그의 `rate_limits` 최신값 그대로 사용 (5h primary %, 주간 secondary %, resets_at, plan_type) — 정확함.
- **Claude**: 공식 한도가 로그에 없음 → 최근 5시간/최근 7일 롤링 사용량을, 과거 관측 최대치(또는 config의 수동 한도)를 분모로 한 **추정 게이지**로 표시. UI에 "추정" 명시.

### 실시간
- `fs.watch` (재귀)로 두 디렉터리 감시 → 2초 디바운스 재집계 → SSE push. 60초 폴백 폴링.

### 비용 단가 ($/MTok, config로 오버라이드)
| 모델 | 입력 | 출력 | 캐시읽기 | 캐시쓰기 |
|---|---|---|---|---|
| claude-fable-5 | 10 | 50 | 1.0 | 12.5 |
| claude-opus-4.x | 5 | 25 | 0.5 | 6.25 |
| claude-sonnet-4.x | 3 | 15 | 0.3 | 3.75 |
| claude-haiku-4.x | 1 | 5 | 0.1 | 1.25 |
| gpt-5.x (codex) | 1.25 | 10 | 0.125 | — |

비용은 정액 구독 사용자에게는 "API 환산 가치" 참고 지표로 표기.

### 화면 구성 (한국어)
1. KPI 카드: 오늘 / 이번 주 / 이번 달 / 누적 (토큰 + 환산 비용)
2. 플랜 현황: Claude 5h·7일 게이지(추정), Codex 5h·주간 게이지(정확) + 리셋 시각
3. 차트: 일별 30일 스택바, 주별 12주, 월별 12개월(= "월별 사용량"), 모델별 도넛
4. 모델별 상세 테이블: 입력/출력/캐시/합계/비용
5. 소스 필터: 전체 / Claude / Codex. SSE로 자동 갱신.

### 에러 처리
- 손상된 JSONL 라인은 건너뜀(라인 단위 try/parse).
- 디렉터리 부재 시 해당 소스만 비활성 표시.

### 테스트
- node:test — Claude/Codex 픽스처 파싱, 중복 제거, 델타 계산, 버킷 집계, 비용 계산.
