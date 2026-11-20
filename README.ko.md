# agy-handoff

**agy-handoff**는 Google Antigravity (`agy` CLI, Antigravity IDE, Antigravity 2.0)에서 로컬 **OpenAI Codex CLI**와 **Anthropic Claude Code CLI**를 Zero-dependency stdio MCP 서버로 연결해 코드 리뷰, 디버깅, 병렬 교차 검증을 실행하는 네이티브 플러그인입니다.

별도 API 키 설정이나 `npm install` 없이 로컬에 로그인된 `codex` · `claude` 인증을 그대로 재사용하며, 기본 `read-only` 보안 모델, Antigravity `/agents`(`Alt+J`) 전용 서브에이전트 칸, 실시간 터미널 대시보드(`watch`), 작업 통계(`stats`)를 제공합니다.

## 핵심 강점

- **의존성 제로 (Zero-dependency)**: Node.js (`>= 18.18.0`) 내장 모듈만으로 동작해 설치 즉시 실행됩니다.
- **듀얼 엔진 병렬 교차 검증**: Codex 단독, Claude 단독, 또는 `handoff_cross_review`로 양쪽을 동시에 호출하고 한쪽이 없으면 자동 건너뜁니다(Fallback).
- **기본 읽기 전용 + 명시적 Opt-in 쓰기**: 리뷰는 항상 `read-only`, 위임도 기본 `read-only`이며 우회 플래그(`--dangerously-*`)는 절대 사용하지 않습니다.
- **서브에이전트 가시성 & 실시간 모니터링**: `/agents`(`Alt+J`) 전용 `codex-handoff` / `claude-handoff` 서브에이전트와 `node src/cli.mjs watch` / `stats` 제공.
- **CLI 버전·필수 플래그 사전 점검**: `handoff_doctor`가 버전(`Codex >= 0.160.0`, `Claude Code >= 2.1.259`)과 필수 옵션 지원 여부를 미리 검증합니다.

---

## 빠른 시작 (Quick Start)

### 1. 설치

```bash
agy plugin install https://github.com/CourageHW/agy-handoff
```

로컬 저장소에서 검증 후 설치하려면:

```bash
git clone https://github.com/CourageHW/agy-handoff.git
agy plugin validate --strict ./agy-handoff
agy plugin install ./agy-handoff
```

### 2. CLI 준비 상태 점검 (`doctor`)

```text
/agy-handoff:handoff-doctor
```

또는 터미널에서 직접 실행:

```bash
node src/cli.mjs doctor
```

### 3. 읽기 전용 코드 리뷰

```text
지금 uncommitted 변경사항을 Codex로 standard 리뷰해줘
```

```bash
node src/cli.mjs review --engine codex --style standard --scope uncommitted
```

### 4. 병렬 교차 리뷰 (`cross-review`)

```text
main 브랜치 대비 변경분을 Codex와 Claude Code로 adversarial 교차 리뷰해줘
```

```bash
node src/cli.mjs cross-review --style adversarial --scope base --base main
```

---

## 슬래시 명령 및 모니터링 (`Alt+J` / `watch` / `stats`)

- `/agy-handoff:handoff-doctor`: Node.js, 바이너리 경로·버전, 필수 플래그 호환성, 인증 상태, 기본 모델 점검
- `/agy-handoff:handoff-review`: `uncommitted`, `base`, `commit`, `custom` 대상 읽기 전용 리뷰 (`standard` / `adversarial`)
- `/agy-handoff:handoff-cross-review`: 두 엔진을 병렬 실행한 뒤 **Consensus Findings**, **Unique Findings**, **Conflicts / Trade-offs**, **Verified Findings**(실제 코드 대조 검증) 구조로 종합
- `/agy-handoff:handoff-delegate`: 조사·디버깅·작업 위임 (`read-only` 기본값, `workspace-write`는 명시적 승인 시에만 사용, `sessionId` 세션 재개 지원)
- `/agy-handoff:handoff-models`: 전역 또는 명령어별(`review`, `delegate`, `cross-review`) 기본 모델 및 추론 강도 설정

Antigravity CLI에서 `codex-handoff` / `claude-handoff` 서브에이전트를 통해 실행하면 `/agents`(`Alt+J`) 패널에서 `handoff_job_status`(`waitSec`, `sinceSeq`)를 통해 실시간 진행 단계를 확인할 수 있습니다. *(참고: 서브에이전트 상단 헤더 옆에는 래퍼 모델 `flash`가 표시되며, 실제 외부 모델·effort는 Role 라벨과 시작 로그에 표시됩니다.)*

별도 터미널 탭이나 tmux 창에서는 아래 명령으로 모니터링 및 통계를 조회할 수 있습니다:

```bash
node src/cli.mjs watch           # 실행 중·최근 작업 실시간 대시보드
node src/cli.mjs watch <jobId>   # 특정 작업 완료까지 추적
node src/cli.mjs watch --once    # 1회 스냅샷 출력
node src/cli.mjs stats           # 작업 횟수, 성공률, 엔진 비율, CLI 보고 토큰·비용 통계
```

> `stats` 및 `handoff_job_status({ includeStats: true })`는 디스크에 보관된 잡 메타데이터 중 실제 CLI가 출력한 비용·토큰 값만 집계하며, 미보고 수치를 임의로 추정하지 않습니다.

---

## 기본 모델 설정

별도 지정 시 기본값은 다음과 같습니다:

- **Codex**: `gpt-6.2-sol` (`effort: "high"`)
- **Claude Code**: `claude-opus-5-5` (`effort: "high"`)

`/agy-handoff:handoff-models` 또는 CLI로 전역·명령어별 기본값을 변경할 수 있습니다:

```bash
node src/cli.mjs models show
node src/cli.mjs models set review codex gpt-6.2-sol xhigh
node src/cli.mjs models set cross-review --codex-model gpt-6.2-sol --codex-effort high --claude-model opus5.5 --claude-effort high
node src/cli.mjs models set delegate claude cli-default
node src/cli.mjs models reset all
```

`cli-default` 지정 시 모델/강도 인자를 생략해 `~/.codex/config.toml` 또는 `~/.claude/settings.json` 기본 설정을 따릅니다. 설정 파일 경로는 `~/.config/agy-handoff/config.json` (Windows는 `%APPDATA%\agy-handoff\config.json`)입니다.

---

## 샌드박스 및 권한 모델 비교

| 모드 | OpenAI Codex (`codex`) | Anthropic Claude Code (`claude`) |
| :--- | :--- | :--- |
| **`read-only`** *(기본값)* | `-s read-only` (네이티브 `review`/`resume` 포함 `sandbox_mode="read-only"`). OS 수준의 읽기 전용 샌드박스 강제. | `--permission-mode dontAsk --restricted --strict-mcp-config --permission-prompts none --tools Read,Grep,Glob,Bash` + 읽기 전용 `git` 허용 및 `Edit`/`Write`/`NotebookEdit`/쓰기성 `git` 옵션(`--output*`, `--ext-diff*`, `--textconv*`) 차단. |
| **`workspace-write`** *(명시적 승인 시)* | `-s workspace-write` (`cwd` 범위 OS 쓰기 샌드박스 + 네트워크 제한). | `--permission-mode acceptEdits --restricted --strict-mcp-config --tools Read,Edit,Write,Grep,Glob,Bash` + `Bash(sudo *)`, `Bash(git push*)` 차단. 기본 파일 도구(`Read`/`Edit`/`Write`/`Grep`/`Glob`)는 `cwd` 내부로 제한되지만, **`Bash` 자체는 OS 파일시스템/네트워크 샌드박스가 적용되지 않음**. |

---

## OS 및 CLI 호환성

| OS | 최소 요구 버전 | 검증 기준 환경 | CI 매트릭스 |
| :--- | :--- | :--- | :--- |
| **Linux** (Ubuntu) | Node `>= 18.18.0`, Codex `>= 0.160.0`, Claude Code `>= 2.1.259` | Node `22.22.1`, Codex `0.171.0`, Claude `2.1.325` | Node `18`, `20`, `22` |
| **macOS** | Node `>= 18.18.0`, Codex `>= 0.160.0`, Claude Code `>= 2.1.259` | CI 검증 (`macos-latest`) | Node `18`, `20`, `22` |
| **Windows** | Node `>= 18.18.0`, Codex `>= 0.160.0`, Claude Code `>= 2.1.259` | CI 검증 (`windows-latest`) | Node `18`, `20`, `22` |

> **Claude Code `>= 2.1.259`가 필요한 이유**: 무인 읽기 전용 실행 시 권한 프롬프트 멈춤과 외부 설정 유입을 차단하기 위해 `--restricted` (`2.1.248` 추가) 및 `--permission-prompts none` (`2.1.259` 추가)을 사용합니다.

---

## 유사 프로젝트와의 비교

| 프로젝트 | 호출 방향 | 주요 역할 | 차이점 |
| :--- | :--- | :--- | :--- |
| **`agy-handoff`** | **Antigravity → Codex & Claude Code** | 듀얼 엔진 MCP, 서브에이전트, 스킬, `watch`/`stats` | Antigravity 안에서 Codex와 Claude Code를 함께 호출·병렬 교차 리뷰하고 실시간 진행 상태를 확인하는 데 초점. Zero-dependency. |
| **`codex-plugin-cc`** | Claude Code → Codex | OpenAI 공식 Claude Code용 Codex 플러그인 | Claude Code 중심 환경에 적합하며, Antigravity에서 Claude+Codex 양쪽을 오케스트레이션하는 목적과는 다름. |
| **`cc-suite`** | 워크스페이스 규칙·스킬 동기화 | `AGENTS.md` 및 `.agents/skills/` 공유 | MCP 실행기라기보다 멀티 CLI 환경 간 규칙/스킬 동기화 도구이므로 `agy-handoff`와 상호 보완적임. |

---

## 개발 및 테스트

```bash
npm test                        # 단위 테스트 + Mock MCP E2E 테스트 (CI 자동 실행)
agy plugin validate --strict .  # Antigravity 플러그인 엄격 검증
node src/cli.mjs doctor         # 로컬 CLI 버전 및 필수 플래그 점검
npm run test:live               # 실제 로그인된 Codex/Claude CLI 대상 로컬 E2E 검증 (선택)
```

---

## 트러블슈팅 및 알려진 제한사항

- **`unknown option: --restricted` / `--permission-prompts` 오류**: 설치된 Claude Code CLI가 `2.1.259` 미만입니다. `claude update` (또는 `npm install -g @anthropic-ai/claude-code@latest`) 후 `node src/cli.mjs doctor`로 확인하세요.
- **비표준 경로 바이너리**: `AGY_HANDOFF_CODEX_BIN` 또는 `AGY_HANDOFF_CLAUDE_BIN` 환경 변수로 경로를 직접 지정할 수 있습니다.
- **Claude `workspace-write`의 Bash 주의**: `--restricted`로 파일 도구는 `cwd` 내부에 격리되지만 `Bash`는 OS 샌드박스를 거치지 않으므로, 단순 조사·리뷰에는 반드시 `read-only`를 유지하세요.
- **강제 종료 시 고아 프로세스**: 타임아웃/취소 시 POSIX 프로세스 그룹 및 Windows `taskkill /PID ... /T /F`로 자식 트리를 종료하며, 서버 비정상 종료 후 남은 `running` 잡은 재조회 시 `failed`로 정리됩니다. 단, 외부 프로세스가 OS에서 완전히 분리한 손자 프로세스는 수동 정리가 필요할 수 있습니다.

## 라이선스

[MIT](./LICENSE) · [Changelog](./CHANGELOG.md) · [English README](./README.md)
