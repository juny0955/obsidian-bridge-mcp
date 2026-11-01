# 실볼트 Curator 실행 Runbook

## 대상과 준비 상태

- Hermes 프로필 ID: `obsidiancuratorlive` (표시 이름과 혼동하지 않는다).
- 유일한 MCP: `obsidian_curator`; live config: `/home/ubuntu/.hermes/profiles/obsidiancuratorlive/config.curator-live.json`.
- 대상 볼트: `/home/ubuntu/vaults/Second-Brain`.
- Hermes 턴 종료 Writer 자동 캡처를 중지하라고 요구하지 않으며, Curator 전용 프로필에 Writer hooks를 추가하지 않는다. Writer와 Curator는 `/home/ubuntu/apps/obsidian-bridge-mcp/state`의 협력 경로 잠금으로 같은 파일의 충돌을 방지한다.
- Writer/Curator의 공유 잠금은 Obsidian 직접 편집, Sync 클라이언트, 다른 호스트 및 여러 단계의 참조 스캔을 보호하지 않는다.
- 백업은 볼트 외부 `/home/ubuntu/backups/obsidian-curator/live-ready/`에 두고, 실제 시작 전에 가장 최근의 검증 성공 백업인지 확인한다.
- 예약/cron은 만들거나 실행하지 않는다.

## 실행 전 점검

1. `hermes -p obsidiancuratorlive mcp test obsidian_curator`가 성공하고 13개 도구를 발견해야 한다.
2. 세션에서 `get_context`를 호출해 실제 경로가 `/home/ubuntu/vaults/Second-Brain`인지 확인한다.
3. 활성 Writer 설정이 Curator와 같은 볼트·`stateDir`인지 확인한다. Writer를 끄지 않는다.
4. 최근 백업의 `vault.tar.gz.sha256` 검사가 통과해야 한다. 백업 후 자동 캡처나 외부 편집이 있었다면 최신 백업을 다시 만든다.
5. 외부 편집·동기화 상태를 사전 확인하지 않는다. 각 쓰기 직전에 대상의 예상 SHA256과 현재 해시를 비교한다. 해시 불일치나 잠금 충돌이 생기면 해당 노트만 건너뛰고 최신 내용을 다시 읽어 검토한다. 오래된 payload는 재시도하지 않는다.
6. `move_note`, `merge_notes`, `trash_note`는 원본·대상 및 참조 검사 파일의 해시와 경로 상태를 확인한다. 충돌·해시 불일치·점유 경로가 있으면 해당 작업을 건너뛰고 원본을 보존한다. Writer 자동 캡처는 끄지 않는다. 해시 확인은 검사 사이의 동시 변경을 완전히 막지 못하므로 불완전한 상태는 자동 복구하지 않고 보고한다.
7. `stateDir`의 잠금 디렉터리가 남아 있어도 자동 삭제하지 않는다. 소유 프로세스·저널·백업을 조사하지 못하면 중단한다.

## 첫 실행 범위

명시적으로 처리를 시작하라는 요청이 있을 때만 첫 최대 3개를 처리한다. 모든 커서 페이지를 확인하고, `skipped` 항목은 건너뛰지 말고 보고한다. 후보별 최신 본문·SHA256, 출처, 중복, 링크를 검토하고, 충돌·불확실성·잠금 실패·해시 변경은 해당 노트만 보류한다. 오래된 payload를 재시도하지 않는다. 변경이 필요한 노트만 최소 수정하고 재독·의미 검증 후 `curated`로 마무리한다. 저널·시스템·템플릿·아카이브·숨김 파일은 변경하지 않는다. Writer 자동 캡처는 이 절차를 위해 중지하지 않는다.

휴지통은 `99-System/Trash`에서 15일 보관한다. 영구 삭제 도구는 없으며, Discord 승인 요청도 전송되지 않는다. 병합/휴지통은 별도 외부 쓰기 정지 확인이 없으면 수행하지 않는다.

## 다음 실행 때 사용할 요청문

```text
obsidian_curator 도구만 사용해 실볼트 Curator 처리를 시작해. 먼저 get_context로 대상 경로를 확인하고, 활성화된 작업 범위 안에서 review 후보를 최대 3개 처리해. 각 후보는 최신 SHA256으로 검토하고 매 변경 직전에 예상 해시를 현재 해시와 비교해. 해시 불일치나 잠금 충돌은 그 노트만 건너뛰고 오래된 payload를 재시도하지 마. Writer 자동 캡처는 유지해. 이동·통합·휴지통은 원본·대상·참조 스캔의 해시와 경로 상태를 검사하고, 충돌이면 원본을 보존한 채 해당 노트를 건너뛰어. 변경 후 다시 읽고 의미와 링크를 검증한 뒤에만 curated 처리해. 해시 검사만으로 검사 사이 동시 변경을 막을 수 없으니 불완전 상태는 자동 복구하지 말고 보고해. 영구 삭제, Discord 승인 주장, 예약 실행은 하지 마.
```

이 요청문은 준비 문서일 뿐이며 준비 단계에서 실행하지 않는다.
