# VPS Hermes 설치 안내

Hermes가 매 턴 한국어 기록 지침을 받고, MCP로 유용한 지식을 기록하거나 건너뛰도록 구성합니다. 종료 시 미처리 여부를 확인하지만 대화를 차단하거나 재실행하지 않습니다.

## 준비 사항

- VPS에서 실행 가능한 Node.js 24와 이 저장소의 코드. 별도 npm 패키지는 필요 없습니다.
- Hermes의 stdio MCP, `hooks:` shell hook, `pre_llm_call` 및 `on_session_end` 지원.
- 두 이벤트의 stdin 페이로드에 실제 `session_id`와 `extra.turn_id`가 있어야 합니다. 식별자는 1~160자의 영문·숫자·`_`·`-`·`:`를 받습니다. Hermes의 `session:task:nonce` 턴 식별자를 변환하지 않고 사용합니다.
- Hermes 서비스 계정에서 읽고 쓸 수 있는 기존 VPS 볼트. 필요한 규칙 파일과 템플릿은 [README의 볼트 구조](README.md#볼트-구조)를 따릅니다.

이 기능은 Mac의 볼트를 VPS로 전송하지 않습니다. Mac과의 동기화, 원격 HTTP 서버, Hermes 본체 수정은 포함하지 않습니다. 구버전에서 이벤트나 실제 식별자를 제공하지 않으면 자동 기록을 사용할 수 없으며, 임의 식별자로 대체하지 않습니다.

등록 형식과 승인 정책은 [Hermes 공식 훅 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks), MCP 항목은 [공식 MCP 설정 문서](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)를 기준으로 합니다.

## 1. 브리지 설정

VPS의 저장소 폴더에서 실행하고 기존 설정은 보존하세요.

```sh
cp -n config.hermes.example.json config.hermes.json
command -v node
node --version
pwd -P
```

`config.hermes.json`의 경로를 실제 VPS의 절대 경로로 변경합니다. `~`와 환경 변수는 JSON 안에서 확장되지 않습니다.

```json
{
  "vault": "/srv/obsidian-vault",
  "stateDir": "/opt/Obsidian-Bridge/state",
  "client": "hermes",
  "enabled": false
}
```

`client`는 반드시 `hermes`로 지정하세요. 생략하면 Codex로 취급되므로 Hermes 어댑터는 동작하지 않습니다. `stateDir`는 동기화하는 볼트 밖에 두고, 같은 볼트를 쓰는 브리지 프로세스끼리는 같은 로컬 상태 폴더를 사용해야 파일 쓰기 잠금을 공유합니다. Codex의 기존 상태 키와 중복 방지 표시는 유지하고 Hermes 키와 표시는 구분합니다.

실행 스크립트는 심볼릭 링크를 거치지 않는 실제 절대 경로로 지정하세요.

## 2. Hermes 설정에 병합

[hermes.config.example.yaml](hermes.config.example.yaml)의 항목을 **실제로 실행하는 Hermes 프로필**의 `config.yaml`에 병합합니다. 기본 프로필은 `~/.hermes/config.yaml`이며 별도 `HERMES_HOME`을 쓰면 해당 프로필의 파일을 사용합니다.

- 기존 `mcp_servers`, `hooks`, 다른 이벤트·명령은 보존합니다. YAML 최상위 키를 중복 생성하거나 같은 훅을 두 번 등록하지 않습니다.
- 예제의 `/usr/bin/node`와 `/opt/Obsidian-Bridge`를 앞서 확인한 실제 경로로 바꿉니다.
- MCP `env`와 두 훅의 `/usr/bin/env OBSIDIAN_BRAIN_CONFIG="…"`가 **같은 설정 파일**을 가리키게 합니다.
- Hermes 훅 명령은 셸에서 실행되지 않으므로 `OBSIDIAN_BRAIN_CONFIG=… node …` 형태의 셸 변수 대입을 쓰지 않습니다. 예제의 `/usr/bin/env`와 경로 따옴표를 유지합니다.

Hermes 설정의 `mcp_servers.obsidian_brain.enabled: true`는 서버 연결을 켭니다. 브리지 JSON의 `enabled: false`는 기록과 기록 훅을 끕니다. 이 상태에서도 검색·읽기는 사용할 수 있습니다.

Hermes 지침은 매 턴 훅의 `context`에 포함됩니다. `global-instructions.md`의 Codex 전용 블록을 Hermes 전역 지침으로 설치할 필요는 없습니다. 볼트 내부 `AGENTS.md`는 `get_context`가 읽는 볼트 규칙으로 계속 필요합니다.

## 3. 훅 승인과 활성화

설정을 검토한 뒤 같은 프로필·서비스 계정으로 대화형 `hermes chat`을 실행하여 `pre_llm_call`, `on_session_end` 각각의 **정확한 명령 문자열**을 승인합니다. Gateway는 새 훅에 대한 승인 질문을 표시하지 않으므로 먼저 승인해야 합니다. 모든 훅을 자동 승인하는 설정은 필요하지 않습니다.

대화형 승인 없이 운영해야 한다면 공식 문서의 manual allowlisting 절차에 따라 해당 프로필의 `shell-hooks-allowlist.json`의 기존 `approvals` 배열에 두 `(event, command)` 항목만 병합합니다. 다른 승인은 보존하고 명령을 YAML과 정확히 맞추세요.

```sh
hermes hooks list
hermes hooks doctor
```

두 훅이 등록·승인되었는지 확인합니다. 이후 `config.hermes.json`의 `enabled`를 `true`로 바꾸고, 운영 방식에 맞춰 Hermes Gateway 서비스를 재시작합니다. MCP 프로세스는 시작할 때 설정을 읽으므로 반드시 다시 시작해야 합니다. 서비스 관리 명령은 VPS의 실제 서비스 이름과 관리자 구성에 따릅니다.

## 4. 검증

저장소의 자동 테스트는 실제 개인 볼트나 모델 호출 없이 임시 볼트에서 실행합니다.

```sh
node --test bridge.test.mjs hermes.test.mjs
```

훅 연결 규약만 점검하려면 다음 합성 페이로드를 실행합니다. 경로는 본인 VPS에 맞게 변경하세요. 이 명령은 Hermes의 실제 대화 성공을 검증하지 않으며, 출력된 합성 식별자를 실제 기록에 재사용하지 않습니다.

```sh
printf '%s\n' '{"hook_event_name":"pre_llm_call","session_id":"probe-session","extra":{"turn_id":"probe-session:probe-task:01234567"}}' |
  /usr/bin/env OBSIDIAN_BRAIN_CONFIG="/opt/Obsidian-Bridge/config.hermes.json" "/usr/bin/node" "/opt/Obsidian-Bridge/hermes-hook.mjs"
```

활성 상태에서는 실제 입력 식별자와 한국어 기록 규칙을 담은 `{"context":"…"}`가 출력됩니다. 비활성 상태나 누락·잘못된 식별자는 `{}`를 반환합니다.

실제 Gateway 대화에서는 다음을 확인하세요.

1. `get_context`, `search_notes`, `read_note`, `remember`, `skip_turn`의 다섯 MCP 도구가 노출되는지 확인합니다. Hermes가 표시하는 도구 이름에는 MCP 서버 접두사가 붙을 수 있습니다.
2. 비민감 테스트 지식을 기록하도록 요청하고 실제 노트, `source: "Hermes session …"`, 해당 턴의 완료 상태 JSON을 확인합니다.
3. 저장할 내용이 없는 턴에서는 `skip_turn` 후 완료 상태가 `skipped`인지 확인합니다.
4. 기존 노트에 추가했을 때 기존 내용·출처·생성일은 보존되고 `Hermes 추가 기록` 제목으로 새 정보만 추가되는지 확인합니다.

`stateDir/<해시>.json`의 `status`가 `saved` 또는 `skipped`이면 해당 턴은 완료입니다. 종료 훅이 미처리 턴을 발견하면 `stateDir/<해시>.missing.json`을 한 번만 생성합니다. 이 파일에는 `status`, `client`, `session_id`, `turn_id`, `at`만 들어가며 대화 원문은 저장하지 않습니다. 중단·실패 턴도 실제 식별자가 있으면 누락 여부를 확인합니다.

누락 파일은 발견 당시의 이력입니다. 나중에 기록을 완료하더라도 자동 삭제하지 않으므로 현재 상태는 같은 해시의 완료 JSON으로 확인하세요. 누락 파일을 `saved`나 `skipped`의 증거로 사용하지 않습니다. 대화 종료를 강제 차단하지 않으므로 매 턴 기록 성공을 보장하지는 않습니다.

로컬 검증 범위는 Node.js 테스트와 Hermes shell hook 페이로드 규약입니다. 이 저장소의 테스트 통과만으로 특정 VPS의 실제 Hermes 버전·Gateway·볼트 연결까지 검증되었다고 보지 않습니다.

## 중지와 제거

자동 기록을 중지하려면 브리지 JSON에서 `enabled: false`로 바꾸고 MCP가 다시 시작되도록 Gateway를 재시작합니다. 완전히 제거하려면 `obsidian_brain` MCP 항목과 두 이벤트의 해당 명령만 제거합니다. 다른 서버·훅·승인·기존 노트는 보존합니다.

## 문제 해결

| 증상 | 확인할 내용 |
| --- | --- |
| 도구가 안 보임 | 실제 프로필, 서버 `enabled`, Node.js 경로, 설정 파일과 볼트 접근 권한 |
| 훅이 `{}`만 반환함 | 브리지 `enabled`, `client: "hermes"`, 실제 `session_id`·`extra.turn_id`, 지원 이벤트 |
| Gateway에서 훅이 실행되지 않음 | 서비스 계정·프로필의 두 승인 항목과 `hermes hooks list` |
| 누락 파일 발생 | 같은 해시 완료 JSON, MCP 연결, 모델의 도구 호출 여부, 중단·오류 여부 |
| `Invalid client` 오류 | 소문자 `codex` 또는 `hermes`만 허용. `null`이나 오타는 기본값으로 처리하지 않음 |
| 훅 설정과 MCP의 결과가 다름 | 세 프로세스의 설정 경로 일치 여부와 MCP 재시작 여부 |
