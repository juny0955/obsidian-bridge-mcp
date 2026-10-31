# Obsidian Bridge

Codex와 Hermes에서 유용한 지식과 결정을 Obsidian 볼트에 기록하는 MCP 서버와 훅입니다. Node.js 기본 모듈만 사용하며, 별도의 npm 패키지 설치나 브리지 전용 API 키가 필요하지 않습니다.

에이전트가 노트의 규칙과 기존 내용을 확인한 뒤 새 노트를 만들거나 기존 노트에 내용을 추가합니다. Codex 훅은 누락 시 한 번 더 확인하도록 요청합니다. Hermes 훅은 매 턴 지침을 전달하고 종료 시 누락 여부만 기록하며 응답을 차단하지 않습니다. 모든 대화를 그대로 저장하는 기능은 아닙니다.

아래 설치 절차는 Codex용입니다. **VPS Hermes는 [Hermes 설치 안내](hermes-setup.md)**와 [YAML 병합 예제](hermes.config.example.yaml)를 사용하세요.

## 구성

| 파일 | 역할 |
| --- | --- |
| `server.mjs` | stdio 방식의 MCP 서버 |
| `vault.mjs` | 볼트 검색·읽기·생성·추가 및 턴 상태 관리 |
| `hook.mjs` | `UserPromptSubmit`·`Stop` 훅 처리 |
| `hermes-hook.mjs` | Hermes `pre_llm_call`·`on_session_end` 훅 처리 |
| `client.mjs` | 클라이언트 검증, 식별자 검사, 공통 기록 지침 |
| `bridge.test.mjs` | 파일 보존, 경로 제한, 중복·동시 저장 등의 테스트 |
| `hermes.test.mjs` | Hermes 페이로드, 상태 분리, subprocess 연동 테스트 |
| `config.example.json` | 로컬 설정을 만들기 위한 예제 |
| `config.hermes.example.json` | VPS Hermes용 비활성 기본 설정 |
| `config.curator.example.json` | 별도 Curator MCP의 비활성 기본 설정 |
| `curator-server.mjs` / `curator-vault.mjs` | 리뷰, 단계별 본문 정리, 통합, 복원 가능한 휴지통을 담당하는 Curator |
| `curator-policy.md` | Curator 역할·보존·삭제 승인 정책 |
| `curator.test.mjs` | Curator MCP의 안전성·워크플로 테스트 |
| `global-instructions.md` | Codex 지침 설치 안내와 복사용 지침 |
| `vault-rules/` | Codex·Hermes 공용 볼트 규칙의 배포 원본 |

## 준비 사항

- Node.js 24: 로컬 검증 환경은 v24.11.1입니다.
- 로컬 stdio MCP와 `UserPromptSubmit`·`Stop` 훅을 지원하는 Codex 실행 환경
- 해당 실행 환경에서 읽고 쓸 수 있는 Obsidian 볼트

현재 `hook.mjs`는 실행 파일 경로에 공백이 있거나 심볼릭 링크를 경유하면 정상 실행되지 않을 수 있습니다. 저장소는 공백 없는 실제 경로에 두고, 설정에도 링크를 거치지 않는 실제 경로를 사용하세요. macOS/Linux에서는 저장소 폴더에서 `pwd -P`로 실제 경로를 확인할 수 있습니다.

아래 설정 예시는 macOS/Linux 셸 기준입니다. Codex 홈은 기본값인 `~/.codex`를 사용합니다. `CODEX_HOME`을 별도로 설정했다면 해당 경로의 설정 파일을 사용하세요.

### 볼트 구조

`get_context`는 다음 규칙 파일과 템플릿 폴더를 읽습니다. 설치 전에 실제 문서를 준비해야 하며, 브리지가 자동 생성하지 않습니다.

```text
obsidian-vault/
├── AGENTS.md
├── 00-Inbox/
├── 01-Journal/
├── 02-Projects/
├── 03-Areas/
├── 04-Knowledge/
├── 05-Resources/
└── 99-System/
    ├── AI/
    │   ├── PROPERTY_SCHEMA.md
    │   └── NOTE_RULES.md
    └── Templates/
        └── Knowledge.md
```

- `AGENTS.md`: 볼트의 목적과 AI 작업 원칙
- `PROPERTY_SCHEMA.md`: 노트 속성, 허용 값, 날짜·태그 규칙
- `NOTE_RULES.md`: 분류·생성·추가·연결 규칙
- `Templates/`: 노트 유형별 Markdown 템플릿. 위의 `Knowledge.md`는 예시이며 폴더 안의 `.md` 파일을 모두 읽습니다.

Writer의 저장 위치와 생성·보완 판단은 볼트의 `99-System/AI/NOTE_RULES.md`가 단일 기준입니다. `AGENTS.md`와 클라이언트 지침은 이 문서를 참조합니다. `vault-rules/`는 Writer 규칙의 배포 원본입니다. 설치 시 기존 볼트 규칙을 백업·비교하고 필요한 변경을 승인받아 병합하세요. 기존 `PROPERTY_SCHEMA.md`와 템플릿은 유지합니다. 별도 Curator MCP는 아래 절차와 저장소의 `curator-policy.md`를 따르며, 실제 볼트 규칙은 별도 승인·배포 전까지 변경하지 않습니다.

검색과 노트 쓰기는 `00-Inbox`부터 `05-Resources`까지 위에 나열한 여섯 폴더로 제한됩니다. 없는 노트 폴더는 첫 저장 시 생성됩니다. 규칙·템플릿은 읽기 대상으로 사용하고, 이 도구로 수정하지 않습니다.

새 노트에는 `type`, `status: review`, `created`, `updated`, `tags`, `related`, `source` 속성을 자동으로 붙입니다. 허용하는 `type`은 `knowledge`, `project`, `decision`, `troubleshooting`, `thought`, `journal`, `goal`, `resource`, `area`, `meeting`입니다. 볼트 규칙을 이 형식과 맞춰 준비하세요. 날짜는 현재 구현에서 `Asia/Seoul` 기준입니다.

## Obsidian Curator MCP (옵션)

Curator는 Writer와 별도의 stdio 프로세스입니다. 전용 Obsidian Curator 봇에만 연결하고 Writer의 자동 기록 훅은 연결하지 마세요. 같은 OS 사용자로 실행하면 서버 도구 목록 분리만으로 직접 파일 접근까지 격리되지는 않습니다.

### 비활성 설정과 연결

```sh
cp -n config.curator.example.json config.curator.json
```

`config.curator.json`의 `vault`와 `stateDir`을 실제 절대 경로로 변경하세요. Writer와 잠금을 공유하도록 같은 호스트의 `stateDir`을 사용해야 합니다. 설정 예제는 `enabled`, `allowOrganization`, `allowMoves`, `allowTrash`를 모두 `false`로 둡니다. 실제 볼트에는 적용하지 말고 먼저 복제 볼트에서 검증하세요.

Hermes MCP 연결 예시는 다음과 같습니다. 경로를 실제 절대 경로로 바꾸고, 기존 연결과 다른 **전용 봇 프로필**에만 등록합니다.

```toml
[mcp_servers.obsidian_curator]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/obsidian-bridge-mcp/curator-server.mjs"]
startup_timeout_sec = 15
tool_timeout_sec = 60

[mcp_servers.obsidian_curator.env]
OBSIDIAN_CURATOR_CONFIG = "/absolute/path/to/obsidian-bridge-mcp/config.curator.json"
```

`OBSIDIAN_CURATOR_CONFIG`를 우선 사용합니다. 기존 Reviewer 연결을 옮기는 동안 `OBSIDIAN_REVIEWER_CONFIG`를 대신 사용할 수 있지만, 두 변수가 서로 다른 파일을 가리키면 시작이 거부됩니다. `reviewer-server.mjs`와 기존 `OBSIDIAN_REVIEWER_CONFIG` 이름은 호환 경로로 남아 있고, 구형 `complete_review` 쓰기 동작은 Curator 단계를 우회하지 못하도록 비활성화했습니다.

### 작업 흐름과 운영 제한

1. `get_context`로 볼트 규칙·스키마·템플릿과 Curator 정책을 읽고 `list_review_notes`의 커서 페이지를 모두 순회합니다. `skipped` 항목은 수동 확인하고 임의로 건너뛰지 않습니다.
2. `read_note`로 최신 본문과 SHA256을 확인하고, 출처·날짜·고유 사실·실제 중복을 리뷰한 후 `record_review`를 호출합니다. 이것만으로 `status`는 바뀌지 않습니다.
3. 필요한 경우에만 `organize_note`, `merge_notes`, `trash_note`를 사용합니다. 해시가 바뀌거나 링크·동기화가 모호하면 작업을 보류합니다. `99-System/Trash/<operation-id>/`로 이동된 원본은 복구할 수 있고, `restore_note`는 원래 경로가 비어 있을 때만 복원합니다.
4. 변경 또는 정리가 모두 끝난 노트만 최신 SHA256으로 `finalize_review`를 호출해 `curated`로 표시합니다.
5. 휴지통은 15일 보관합니다. `list_pending_deletions`와 `prepare_deletion_requests`는 만료 대기 항목과 불변 요청 ID를 확인·기록할 뿐, Discord로 전송하지 않습니다. Discord 연동은 범위 밖이며 이 서버에는 승인·영구 삭제 기능이 없으므로 만료 항목도 계속 보존합니다.

`allowMoves`와 `allowTrash`를 켜도 운영 정지가 자동 검증되는 것은 아닙니다. Writer, Obsidian, 동기화 및 다른 프로세스의 쓰기가 실제로 중단된 상태를 별도로 확인할 수 없으면 이동·통합·휴지통 작업을 하지 마세요. 구체적인 복구·보존 불변식은 [`curator-policy.md`](curator-policy.md)와 [`reviewer-setup.md`](reviewer-setup.md)를 확인하세요. 이 문서는 설정 예시이며 이 변경으로 실볼트 규칙이나 실행 프로필은 수정되지 않습니다.

## 설치

### 1. 로컬 설정 만들기

저장소를 내려받은 폴더에서 실행합니다. 기존 설정이 있으면 덮어쓰지 않습니다.

```sh
cp -n config.example.json config.json
```

`config.json`의 값을 실제 환경에 맞게 변경합니다.

| 항목 | 설명 |
| --- | --- |
| `vault` | 이미 존재하는 Obsidian 볼트의 절대 경로 |
| `stateDir` | 턴 처리 상태를 보관할 폴더의 절대 경로. 없으면 자동 생성 |
| `enabled` | 자동 기록을 사용하려면 `true`. 예제 기본값은 `false` |
| `client` | `codex` 또는 `hermes`. 생략하면 기존과 동일하게 `codex`; 다른 값은 오류 |

경로에는 실제 절대 경로를 입력하세요. JSON 안의 `~`나 `$HOME`은 자동으로 확장되지 않습니다. `stateDir`는 개인 노트와 섞이지 않도록 저장소의 `state/`를 권장합니다.

서버와 훅은 기본적으로 각 스크립트 옆의 `config.json`을 읽습니다. 다른 파일을 사용하려면 두 프로세스 모두에 동일한 `OBSIDIAN_BRAIN_CONFIG` 절대 경로를 전달해야 합니다.

### 2. MCP 서버 연결

Node.js 실행 파일의 절대 경로를 확인합니다.

```sh
command -v node
```

Codex의 `~/.codex/config.toml`에 다음 항목을 추가합니다. 예제의 경로를 실제 경로로 바꾸고, 같은 이름의 설정이 이미 있으면 기존 항목을 수정하세요.

```toml
[mcp_servers.obsidian_brain]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/Obsidian-Bridge/server.mjs"]
startup_timeout_sec = 15
tool_timeout_sec = 30
```

`OBSIDIAN_BRAIN_CONFIG`를 사용할 때는 위 서버 항목에 다음 설정도 추가합니다.

```toml
[mcp_servers.obsidian_brain.env]
OBSIDIAN_BRAIN_CONFIG = "/absolute/path/to/custom-config.json"
```

설정 형식은 [OpenAI 공식 MCP 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)를 참고하세요.

### 3. 자동 기록 지침 설치

[global-instructions.md](global-instructions.md)의 설치 안내를 읽고, 자동 기록을 사용할 범위를 선택해 **복사용 지침 블록만** 해당 `AGENTS.md`에 추가합니다. 기존 내용은 보존하세요.

이 파일을 저장소에 두는 것만으로는 Codex 전역 지침에 적용되지 않습니다.

### 4. 훅 연결

`~/.codex/hooks.json`에 아래 설정을 추가합니다. 파일이 이미 있다면 기존 `hooks` 객체와 이벤트 배열에 병합하세요. 기존 훅을 지우거나 같은 훅을 중복 등록하지 마세요.

두 `command`의 Node.js·스크립트 경로를 모두 실제 절대 경로로 바꾸고 따옴표를 유지하세요. 저장소 경로에는 공백을 사용하지 마세요.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/absolute/path/to/node\" \"/absolute/path/to/Obsidian-Bridge/hook.mjs\"",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/absolute/path/to/node\" \"/absolute/path/to/Obsidian-Bridge/hook.mjs\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

커스텀 설정 파일을 쓴다면 각 훅의 `command` 앞에도 `OBSIDIAN_BRAIN_CONFIG=\"/absolute/path/to/custom-config.json\" `를 붙입니다. MCP의 `env` 설정은 별도로 실행되는 훅에 자동 적용되지 않습니다.

Codex가 훅 검토를 요구하면 CLI의 `/hooks`에서 정의를 확인하고 신뢰하도록 설정하세요. 훅 탐색과 신뢰 절차는 [OpenAI 공식 훅 문서](https://learn.chatgpt.com/docs/hooks)를 참고하세요.

### 5. 활성화와 확인

자동 기록의 범위와 볼트 경로를 확인한 뒤 `config.json`의 `enabled`를 `true`로 바꾸고 Codex를 재시작하거나 새 세션을 엽니다. 서버가 시작할 때 설정을 읽으므로 설정 변경 후에는 MCP 서버도 다시 시작해야 합니다.

1. `obsidian_brain`에 아래 다섯 도구가 표시되는지 확인합니다.
2. Codex에 `get_context`로 볼트 규칙을 읽도록 요청합니다.
3. 기존 노트를 검색해 연결을 확인합니다.
4. 저장할 가치가 있는 비민감 정보를 기록하도록 요청하고, 실제 노트에 반영됐는지 확인합니다.

| 도구 | 역할 |
| --- | --- |
| `get_context` | 볼트 규칙과 템플릿 읽기 |
| `search_notes` | 공백으로 구분한 검색어를 모두 포함하는 노트 검색 |
| `read_note` | 노트 내용과 SHA256 읽기 |
| `remember` | 새 노트 생성 또는 기존 노트에 내용 추가 |
| `skip_turn` | 기록할 내용이 없는 턴을 건너뛰기로 처리 |

`remember`와 `skip_turn`은 훅이 전달한 실제 `session_id`·`turn_id`가 필요합니다. 식별자를 제공하지 않는 실행 환경에서는 자동 기록을 사용할 수 없습니다.

## 테스트

저장소 폴더에서 실행합니다. 테스트는 임시 볼트를 사용하며 개인 `config.json`이나 실제 볼트가 필요하지 않습니다.

```sh
node --test bridge.test.mjs hermes.test.mjs reviewer.test.mjs curator.test.mjs
```

## Claude Code 호환성

Claude Code도 [로컬 stdio MCP 서버 연결](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server)을 지원하므로 `server.mjs`의 검색·읽기 도구를 재사용할 수 있는 구조입니다. 다만 실제 Claude Code 클라이언트 연결은 아직 검증하지 않았습니다.

자동 기록 어댑터는 Codex와 Hermes용으로 구현되어 있습니다. Codex용 `hook.mjs`는 `session_id`와 `turn_id`를 요구하지만, Claude Code의 [UserPromptSubmit·Stop 훅](https://code.claude.com/docs/en/hooks)은 같은 `turn_id` 입력을 보장하지 않으며 공통 입력에 `prompt_id`를 제공합니다. Claude Code 자동 기록을 지원하려면 실제 프롬프트 식별자를 일관되게 변환하고 전달하는 별도 어댑터가 필요합니다. 훅 등록 위치도 `~/.claude/settings.json` 또는 프로젝트의 `.claude/settings.json`으로 달라집니다.

지침은 Claude Code의 [CLAUDE.md와 AGENTS.md 로딩 규칙](https://code.claude.com/docs/en/memory)을 따라 별도로 설치해야 합니다. 현재 복사용 지침과 Codex 설정 예제를 그대로 적용하는 것만으로 Claude Code 자동 기록이 활성화되지는 않습니다.

## 기록 범위와 제한

- 이 브리지 자체는 별도 외부 API를 호출하지 않고 실행 호스트의 파일을 처리합니다. MCP로 읽은 내용은 연결된 에이전트의 문맥에 전달되므로 해당 제품과 모델 제공자의 데이터 처리 정책이 적용됩니다.
- 비밀 정보와 허용하지 않은 민감 정보는 기록하지 않도록 지침을 적용합니다. 코드의 자격 증명 패턴 검사는 일부 형식만 탐지하며 모든 민감 정보를 판별하지는 못합니다.
- 기존 노트에 추가하려면 `read_note`가 반환한 최신 SHA256이 필요합니다. 내용이 바뀌면 다시 읽어야 하며, 기존 파일의 생성 덮어쓰기는 거부합니다.
- 동일 본문은 줄바꿈 형식과 앞뒤 공백만 정규화한 SHA256으로 비교합니다. create는 검색 대상 전체, append는 대상 노트의 본문·기존 추가 기록 블록을 비교합니다. 동일 기록은 노트와 `updated`를 바꾸지 않고 `{status: "saved", path: "기존 경로"}`를 반환합니다. 코드 내부 공백과 표현이 다른 문장은 동일시하지 않으며 의미상 중복 판단은 Writer가 담당합니다.
- 서로 다른 내용의 파일명 충돌은 오류입니다. 자동으로 append하거나 경로를 바꾸지 않습니다. 같은 상태 폴더를 공유하는 프로세스의 동시 쓰기는 경로·본문 잠금으로 제한하며, 경합 오류가 나면 검색·읽기 후 재시도합니다. 서로 다른 호스트·상태 폴더 사이의 동기화 충돌을 막는 분산 잠금은 아닙니다.
- `enabled: false`는 `remember`와 자동 기록 훅을 비활성화합니다. 검색·읽기 도구는 계속 사용 가능합니다. 연결을 완전히 끄려면 MCP 등록과 훅, 설치한 지침 블록도 제거하세요.
- 자동 기록은 설정한 Codex 또는 Hermes 환경에 적용됩니다. 다른 기기나 일반 ChatGPT까지 자동 적용되지 않습니다.

## 문제 해결

| 증상 | 확인할 내용 |
| --- | --- |
| 서버가 시작되지 않음 | Node.js·스크립트 절대 경로, `config.json` JSON 문법, 볼트 경로 존재 여부 |
| `get_context` 실패 | 볼트의 규칙 파일 3개와 `99-System/Templates/` 폴더 존재 여부 |
| 기록되지 않음 | `enabled`, 훅 등록·신뢰 상태, 실제 세션·턴 식별자 전달 여부 |
| `Note changed` 오류 | 최신 노트를 다시 읽고 반환된 SHA256으로 추가 |
| `Existing note has no frontmatter` 오류 | 기존 노트의 YAML frontmatter를 수동 검토 |

## GitHub에 포함하지 않는 파일

`config.json`, `config.hermes.json`, `state/`, `backups/`는 개인 경로, 실행 상태, 로컬 설정 백업을 담으므로 `.gitignore`로 제외합니다. 배포에는 `config.example.json` 또는 `config.hermes.example.json`을 사용하고, 실제 볼트와 개인 에이전트 설정 파일은 업로드하지 마세요.
