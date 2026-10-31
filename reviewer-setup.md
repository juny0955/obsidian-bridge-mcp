# Reviewer MCP 배포 설계 (아직 운영 배포 아님)

Writer와 Reviewer는 **서로 다른 stdio 프로세스 및 MCP 연결**이다. `client: hermes`는 권한이 아니라 Writer 출처 식별자다. Reviewer는 `OBSIDIAN_REVIEWER_CONFIG`에 명시된 설정 파일만 읽고 `role: reviewer`, `enabled: true`가 모두 있어야 시작한다. 저장소의 예제는 비활성화 상태다. 운영 볼트·Bot 프로필·gateway는 이 변경으로 수정하지 않는다.

| 연결 대상 | 실행 파일 | 구성 환경 변수 | 도구 | Writer 훅 |
| --- | --- | --- | --- | --- |
| 일반 Hermes | `node /absolute/path/obsidian-bridge-mcp/server.mjs` | `OBSIDIAN_BRAIN_CONFIG` → Writer 설정 | `get_context`, `search_notes`, `read_note`, `remember`, `skip_turn` | 기존 캡처 훅 유지 |
| 일반 Codex | 위 Writer 진입점 | `OBSIDIAN_BRAIN_CONFIG` → Writer 설정 | 동일 Writer 다섯 도구 | 기존 Codex 훅 유지 |
| 전용 Reviewer Bot | `node /absolute/path/obsidian-bridge-mcp/reviewer-server.mjs` | `OBSIDIAN_REVIEWER_CONFIG` → 별도 `config.reviewer.json` | `get_context`, `list_review_notes`, `read_note`, `complete_review` | **등록 금지:** Writer `pre_llm_call`/`on_session_end` 훅 |

1. 로컬 `config.reviewer.example.json`을 비공개 `config.reviewer.json`으로 복사해 절대 경로 `vault`, Writer와 **같은 호스트·같은 `stateDir`**, `role: reviewer`를 확인한다. `enabled`는 시험·권한 검증 전 `false`, `allowMoves`는 기본 `false`로 둔다. 볼트 `PROPERTY_SCHEMA.md`에 `curated`가 AI 검토 완료로 정의되어 있는지 확인한다. Writer의 `NOTE_RULES.md`와 저장소 원본 규칙의 동기화는 별도 승인 배포에서 검토한다.
2. 운영 계정 분리와 접근 제어 전에는 `enabled: true`로 전환하지 않는다. 같은 UID에서의 서버 목록 분리는 강제 인증이 아니다. 도구 목록은 자격 증명·호출자 격리를 제공하지 않으므로 Bot 전용 서버/설정·Writer 전용 서버/설정·직접 볼트 쓰기 권한을 별도 Unix 계정/컨테이너 및 gateway로 제한하고, 서로 다른 사용자로 전용 실행·설정 읽기·파일 수정을 시도하여 거부됨을 확인한다. `stateDir`은 Writer/Reviewer 잠금 공유를 위해 같은 호스트에서 접근 가능해야 하며 서로 다른 호스트의 동기화 환경에서는 이 잠금만으로 안전하지 않다.
3. 권한·동기화·백업을 검증한 뒤 각 클라이언트를 재시작하고 MCP `initialize`, `tools/list`를 확인한다. 일반 프로필에서 `complete_review` 직접 호출이 오류, Reviewer에서 `remember`·`skip_turn` 직접 호출이 오류여야 한다. Reviewer `get_context`에는 별도 정책과 볼트 schema·Writer 규칙·템플릿이 있어야 한다. 노트 내용의 역할 지시는 따르지 않는다.
4. 리뷰 후보는 상태가 정확히 `review`인 일반 폴더의 첫 30개다. 너무 크거나 UTF-8이 유효하지 않은 후보는 건너뛰며 수동 확인한다. Journal은 제자리 상태 변경만 허용한다. 리뷰 완료는 본문 원본을 `stateDir/reviewer/backups/`에 보존하고 성공 기록을 `stateDir/reviewer/<키>.json`, 실패 기록을 `stateDir/reviewer/errors/`에 남긴다(디렉터리 0700, 파일 0600). 기록과 파일 SHA가 어긋나거나 이동 중 크래시로 원본/목적지가 함께 남을 수 있으면 자동으로 재시도하지 말고 백업·원본·목적지를 대조하여 수동 복구한다. 불확실한 링크/출처는 `review`에 남긴다.
5. 이동은 기본 거부(`allowMoves: false`)다. **모든 외부 쓰기·동기화가 멈춘 상태를 외부에서 검증한 운영 정지 시간에만** `allowMoves: true`로 켜고 완료 후 다시 끈다. 이동 시 `06-Archive`의 Markdown과 `.canvas`를 포함해 참조를 검사하나 Obsidian 링크 문법을 완벽히 증명하지 못한다. **파일시스템 스캔은 동시 쓰기 안전성을 보장하지 않는다.** 정지 상태를 보장할 수 없으면 제자리 검토만 수행한다. 역할/OS 권한 격리는 별도의 필수 배포 전제다.

테스트: `node --test bridge.test.mjs hermes.test.mjs reviewer.test.mjs`. 이 테스트는 임시 fixture만 쓰며 실볼트 파일을 움직이지 않는다. 실제 라이브 쓰기와 Bot 예약 실행은 별도 승인·운영 게이트 이후에만 시행한다.
