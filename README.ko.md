# agy-handoff

**Google Antigravity에서 로컬 OpenAI Codex CLI와 Anthropic Claude Code CLI로 코드 리뷰, 디버깅, 교차 검증(Second Opinion)을 넘기고 결과를 받아오는 네이티브 플러그인입니다.**

[English README](./README.md)

`agy-handoff`는 외부 npm 의존성이 전혀 없는(Zero-dependency) 단일 플러그인으로, 다음 요소를 함께 제공합니다:

- **로컬 stdio MCP 서버** (`src/mcp-server.mjs`): Node.js 내장 모듈만으로 동작하므로 `npm install`이 필요 없고, 로컬에 로그인된 `codex` / `claude` 인증을 그대로 사용합니다.
- **5개 전용 스킬**: `handoff-review`, `handoff-delegate`, `handoff-cross-review`, `handoff-doctor`, `handoff-models` + 안전 기본값 규칙(`rules/AGENTS.md`).
- **2개 전용 서브에이전트** (`codex-handoff`, `claude-handoff`): Antigravity CLI의 `/agents` 및 `Alt+J`에서 Codex/Claude 작업을 독립 칸으로 분리해 진행 상황을 실시간으로 확인할 수 있습니다.
- **직접 실행 CLI & 실시간 모니터** (`src/cli.mjs`, `agy-handoff watch`): MCP 없이 터미널에서 단독 실행하거나 별도 창에서 진행 상황을 실시간 추적할 수 있습니다.

---

## 사전 요구사항

- **Google Antigravity** (`agy` CLI, Antigravity IDE 또는 Antigravity 2.0)
- **Node.js** `>= 18.18.0`
- 아래 CLI 중 **하나 이상** 설치 및 로그인:
  - **OpenAI Codex CLI** (`>= 0.160` 권장): `npm install -g @openai/codex && codex login`
  - **Anthropic Claude Code CLI** (`>= 2.1` 권장): `npm install -g @anthropic-ai/claude-code && claude`

> 두 CLI가 모두 설치되어 있지 않아도 동작합니다. 미설치 엔진은 자동으로 감지해 건너뛰고 설치 안내를 표시합니다.

---

## 설치 방법

### GitHub에서 바로 설치

```bash
agy plugin install https://github.com/CourageHW/agy-handoff
```

### 로컬 경로에서 검증 및 설치

```bash
git clone https://github.com/CourageHW/agy-handoff.git
agy plugin validate --strict ./agy-handoff
agy plugin install ./agy-handoff
agy plugin list
```

---

## 제공 MCP 도구

| 도구 | 설명 |
| :--- | :--- |
| `handoff_doctor` | Node.js 버전, `codex` / `claude` 설치 경로·버전·인증 상태를 점검합니다. |
| `handoff_review` | 미커밋 변경분, 기준 브랜치 diff, 특정 커밋, 커스텀 범위에 대해 읽기 전용 `standard` / `adversarial` 리뷰를 수행합니다. |
| `handoff_delegate` | 조사·디버깅·작업 위임을 실행합니다. 기본값은 `read-only`이며 파일 수정이 필요할 때만 `workspace-write`를 명시합니다. 세션 재개 및 백그라운드 실행 지원. |
| `handoff_cross_review` | Codex와 Claude Code를 병렬로 동시 호출해 독립적인 교차 리뷰 결과를 받아옵니다. |
| `handoff_config` | 전역 또는 명령어별(`review`, `delegate`, `cross-review`) Codex/Claude 기본 모델 및 추론 강도(`effort`)를 조회·변경·초기화합니다. |
| `handoff_job_status` | 백그라운드 잡 상태와 실시간 활동 이벤트(`recentEvents`, `waitSec`)를 조회하거나 최근 잡 목록을 조회합니다. |
| `handoff_job_result` | 백그라운드 잡의 실행 결과 및 메타데이터 조회. |
| `handoff_job_cancel` | 실행 중인 백그라운드 잡 취소. |

---

## 서브에이전트 및 실시간 모니터링

- **전용 서브에이전트 (`agents/`)**: `codex-handoff`, `claude-handoff`가 번들되어 있어 Antigravity CLI의 `/agents` 및 `Alt+J` 화면에 Codex/Claude 전용 서브에이전트 칸이 각각 생성되고, 진행 단계가 실시간으로 보고됩니다.
- **실시간 이벤트 스트리밍**: `codex exec --json` 및 `claude -p --output-format stream-json --verbose` 출력을 파싱해 `<jobId>.events.log`에 기록하고, `handoff_job_status`(`waitSec`, `sinceSeq`, `recentEvents`) 및 MCP `notifications/progress`로 노출합니다.
- **터미널 실시간 대시보드 (`watch`)**:
  ```bash
  node src/cli.mjs watch           # 실행 중인 모든 작업 실시간 모니터링
  node src/cli.mjs watch <jobId>   # 특정 작업 완료 시까지 실시간 추적
  node src/cli.mjs watch --once    # 현재 상태·최근 활동 한 번에 출력
  ```

---

## 기본 모델 및 명령어별 설정

별도 모델/추론 강도를 지정하지 않으면 내장 기본값이 적용됩니다:

- **Codex**: `gpt-6.2-sol` (`effort: "high"`)
- **Claude Code**: `claude-opus-5-5` (`effort: "high"`)

Antigravity 터미널에서 슬래시 명령이나 CLI로 전역 또는 명령어별(`review`, `delegate`, `cross-review`) 기본값을 손쉽게 바꿀 수 있습니다:

- 대화형 설정: `/agy-handoff:handoff-models`
- 한 줄 바로 설정: `/agy-handoff:handoff-models review codex gpt-6.2-sol xhigh`
- CLI:
  ```bash
  node src/cli.mjs models show
  node src/cli.mjs models set review codex gpt-6.2-sol xhigh
  node src/cli.mjs models set cross-review --codex-model gpt-6.2-sol --codex-effort high --claude-model opus5.5 --claude-effort high
  node src/cli.mjs models set delegate claude cli-default   # 로컬 CLI 자체 기본 설정 사용
  node src/cli.mjs models reset all
  ```

---

## Antigravity에서의 사용 예시

- *"handoff doctor로 Codex랑 Claude Code 준비됐는지 확인해줘"*
- *"지금 uncommitted 변경사항을 Codex로 adversarial 리뷰 돌려줘"*
- *"`main` 브랜치 대비 변경분을 Codex랑 Claude Code로 교차 리뷰해줘"*
- *"테스트 실패 원인 조사를 Codex한테 백그라운드 read-only로 넘겨줘"*
- *"/agy-handoff:handoff-models"*

---

## 환경 변수 (선택)

| 변수명 | 설명 |
| :--- | :--- |
| `AGY_HANDOFF_CODEX_BIN` | `codex` 바이너리가 기본 `PATH` 밖에 있을 때 직접 경로 지정 |
| `AGY_HANDOFF_CLAUDE_BIN` | `claude` 바이너리가 기본 `PATH` 밖에 있을 때 직접 경로 지정 |
| `AGY_HANDOFF_CONFIG` | 모델 기본값 설정 JSON 파일 경로 직접 지정 (기본: `~/.config/agy-handoff/config.json`, Windows는 `%APPDATA%\agy-handoff\config.json`) |
| `AGY_HANDOFF_JOBS_DIR` | 백그라운드 잡 로그 및 실시간 이벤트 타임라인 저장 디렉터리 직접 지정 (`watch`는 Antigravity의 `plugin_data/agy-handoff/jobs`를 자동 감지) |

---

## 안전 설계

- **읽기 전용 기본값**: 리뷰는 항상 읽기 전용이며, 위임(`handoff_delegate`)도 기본 `read-only`로 동작합니다.
  - **Codex**: `exec`, `exec resume`, 네이티브 `review` 모든 경로에 `sandbox_mode="read-only"`를 명시적으로 강제하며, Git 저장소 외부의 `custom` 리뷰/위임에는 `--skip-git-repo-check`를 자동 적용합니다.
  - **Claude Code**: `--permission-mode dontAsk --restricted --strict-mcp-config --tools Read,Grep,Glob,Bash`와 함께 `Edit`/`Write`/`NotebookEdit` 및 파일 쓰기·외부 드라이버 실행 git 옵션(`--output*`, `--ext-diff*`, `--textconv*`)을 `--disallowedTools`로 차단합니다. (단, `read-only`는 파일 수정 금지 모드이며 읽기 범위 자체를 `cwd`로 격리하지는 않습니다.)
- **명시적 쓰기 허용(`workspace-write`) 및 주의사항**: 위험한 우회 옵션(`--dangerously-bypass-approvals-and-sandbox` / `--dangerously-skip-permissions`)은 노출하지 않습니다. **주의**: Codex `-s workspace-write`와 달리 Claude Code의 `workspace-write`는 OS 파일시스템/네트워크 샌드박스 없이 일반 `Bash` 실행 권한을 부여합니다.
- **셸 인젝션 차단**: 절대 경로로 검증된 바이너리를 `shell: false`로 직접 실행(Windows npm `.cmd` 심은 Node로 직접 구동)하고 프롬프트는 `stdin`으로 전달합니다.
- **출력 크기 제한, 프로세스 트리 정리 및 격리 저장소**: 스트림 캡처 상한 및 UTF-8 문자 경계 절단, 타임아웃/취소 시 하위 프로세스 트리 전체 종료, 사용자 전용 권한(`0700`/`0600`) 백그라운드 잡 저장소를 적용합니다.

---

## 테스트 및 검증

```bash
npm test
agy plugin validate --strict .
node src/cli.mjs doctor
```

---

## 라이선스

[MIT](./LICENSE)
