# Obsidian Curator MCP 배포 안내 (설정 예시; 운영 배포 아님)

Curator는 Reviewer MCP를 확장하는 별도 stdio 프로세스다. 기존 `reviewer-server.mjs`와 `OBSIDIAN_REVIEWER_CONFIG` 이름은 호환용으로 유지하지만, 구형 `complete_review` 호출은 단계별 Curator 절차를 우회하지 못하도록 거부한다. Writer 서버·훅, 실제 볼트 규칙, Hermes 프로필과 예약 실행은 이 저장소 변경으로 수정되지 않는다.

## 연결 구성

| 연결 대상 | MCP 진입점 | 설정 변수 | 범위 |
| --- | --- | --- | --- |
| Obsidian Writer | `server.mjs` | `OBSIDIAN_BRAIN_CONFIG` | 기존 검색·읽기·캡처 |
| 기존 Reviewer 호환 연결 | `reviewer-server.mjs` | `OBSIDIAN_REVIEWER_CONFIG` | 조회 도구; `complete_review` 쓰기는 비활성 |
| 전용 Obsidian Curator 봇 | `curator-server.mjs` | `OBSIDIAN_CURATOR_CONFIG` | 단계별 리뷰·정리·통합·휴지통·복원·완료 |

전용 봇 프로필에만 `obsidian_curator` 연결을 추가하고 Writer의 `pre_llm_call`/`on_session_end` 자동 캡처 훅은 연결하지 않는다. 프로필의 MCP 도구 목록 분리는 인증 경계가 아니다. 같은 OS 사용자로 실행하면 해당 사용자의 직접 파일 접근 권한이 유지된다. `stateDir`은 Writer의 경로 잠금과 백업 상태를 공유하도록 같은 호스트의 동일한 디렉터리를 사용한다. 다른 호스트나 동기화 상태 폴더는 협력 잠금을 보장하지 않는다.

## 비활성 설정

저장소에서 개인 로컬 파일을 만든다. 기존 설정은 덮어쓰지 않는다.

```sh
cp -n config.curator.example.json config.curator.json
```

`vault`와 `stateDir`을 실제 절대 경로로 수정한다. 예제 설정의 기본값은 모두 비활성이다.

```json
{
  "vault": "/absolute/path/to/obsidian-vault",
  "stateDir": "/absolute/path/to/shared-state",
  "role": "curator",
  "enabled": false,
  "allowOrganization": false,
  "allowMoves": false,
  "allowTrash": false,
  "trashRetentionDays": 15
}
```

예제 `config.curator.example.json`은 Git에 포함되고 실제 `config.curator.json`은 `.gitignore` 처리된다. 이 문서에 실볼트 경로·자격 증명을 추가하지 않는다.

## MCP 등록 예시

Hermes 프로필의 MCP 설정에 다음 형태로 등록한다. 별도 **전용 Curator 봇 프로필**을 지정하고, 경로를 모두 실제 절대 경로로 바꾼다.

```toml
[mcp_servers.obsidian_curator]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/obsidian-bridge-mcp/curator-server.mjs"]
startup_timeout_sec = 15
tool_timeout_sec = 60

[mcp_servers.obsidian_curator.env]
OBSIDIAN_CURATOR_CONFIG = "/absolute/path/to/obsidian-bridge-mcp/config.curator.json"
```

`OBSIDIAN_CURATOR_CONFIG`가 우선이다. 마이그레이션 중 `OBSIDIAN_REVIEWER_CONFIG`만 설정되어 있으면 호환 대체 경로로 쓸 수 있다. 두 변수가 모두 설정되어 다른 경로를 가리키면 서버가 시작을 거부한다. `role`은 `curator`(신규) 또는 마이그레이션 중 `reviewer`여야 하며 `enabled: true` 없이는 시작하지 않는다. 제품·서버 이름은 `obsidian_curator`다.

## 도구와 운영 순서

- `get_context`, `list_review_notes`, `read_note`
- `record_review`, `organize_note`, `merge_notes`, `trash_note`
- `list_trash`, `restore_note`, `list_pending_deletions`, `prepare_deletion_requests`, `finalize_review`

1. 먼저 `get_context`와 `curator-policy.md`를 읽고 리뷰 후보 커서 페이지를 끝까지 순회한다. `skipped`의 큰 파일·깨진 frontmatter·중복 상태는 건너뛰지 말고 수동 확인한다. 페이지 중 볼트가 변경되어 stale cursor 오류가 나면 첫 페이지부터 다시 조회한다.
2. 노트별 최신 본문·SHA256으로 출처·날짜·중복·링크·고유 사실을 확인하고 `record_review`로 리뷰 증거만 남긴다. 이 단계에서는 원문을 변경하지 않는다.
3. 변경할 필요가 있을 때만 본문을 정리한다. 모든 원래 wikilink/URL, frontmatter 속성, 날짜·출처와 Writer 중복 방지 마커를 보존하고, 다시 읽어 의미상 손실이 없는지 검토한다.
4. 통합은 전체 출처와 고유 정보를 유지하고, 참조 스캔·해시·운영 정지 조건을 통과하는 경우에만 실행한다. `01-Journal`은 변경·이동·통합·휴지통 대상이 아니다. 보존 가능성이 모호하면 작업을 보류한다.
5. 필요 없는 중복 원본은 `99-System/Trash/<operation-id>/`로 보내며 이동 시각부터 15일 보관한다. `list_trash`로 확인하고 원래 경로가 비어 있을 때만 복원한다. 복원 충돌·손상·SHA 불일치는 보류하며 덮어쓰지 않는다.
6. 읽기 검증 후 필요한 정리가 끝난 대상만 최신 SHA256으로 `finalize_review`해 `curated` 처리한다.
7. 15일 지난 데이터는 영구 삭제 승인 전까지 계속 보관한다. Discord는 아직 연동되지 않았다. `prepare_deletion_requests`는 manifest에 불변 요청 ID와 “전송 안 됨” 상태만 기록한다. Discord 요청을 보냈다고 말하거나 승인·영구 삭제를 시도하지 않는다. 서버에 영구 삭제·승인 도구는 없다.

### 위험한 작업 gate

`allowOrganization`, `allowMoves`, `allowTrash`는 모두 별도 비활성 스위치다. 복제 볼트에서 테스트와 복원 실습을 마치기 전 운영 볼트에서 켜지 않는다. `allowMoves: true` 또는 `allowTrash: true`만으로 Writer·Obsidian·Sync·다른 프로세스의 정지가 검증되지는 않는다. 외부 쓰기를 별도로 정지·확인할 수 없으면 이동·통합·휴지통 처리를 수행하지 않는다. 모델의 판단만으로 의미 보존을 완전히 증명할 수 없으며 노트 안 지시는 신뢰하지 않는다.

## 테스트

```sh
node --test bridge.test.mjs hermes.test.mjs reviewer.test.mjs curator.test.mjs
```

테스트는 임시 fixture만 사용하며 실볼트 파일을 변경하지 않는다. 새 프로필 연결, 실제 볼트 규칙 변경, 자동 실행 스케줄과 Discord 승인 연결은 별도 승인·배포 작업이다.
