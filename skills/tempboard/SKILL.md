---
name: tempboard
description: 임시 공유 화이트보드 사이트를 열고 · 닫고 · 꺼내는 절차. 사용자가 "화이트보드 열어 줘", "같이 그릴 보드 링크", "회의 중에 그림 같이 그리자", "보드 링크 보내 줄 수 있게", "share a whiteboard", "temporary whiteboard link" 라고 하면 이 스킬을 쓴다. /tempboard:open · list · stop · export.
---

# tempboard

링크 하나로 누구와든 같이 그리는 임시 사이트. 사이트 하나 = 이 컴퓨터의 작은 서버 + Cloudflare 임시 터널(계정 불필요, `*.trycloudflare.com`) + 초대 키 + 만료 시각.

CLI: `python3 "${CLAUDE_PLUGIN_ROOT}/bin/tempboard" <명령>` (아래 `tb`).

| 하려는 일 | 명령 |
|---|---|
| 열기 | `tb start --json [--title 이름] [--ttl 12h] [--view-link] [--lan] [--tunnel none]` |
| 목록 · 링크 다시 | `tb list` · `tb links <id>` |
| 닫기 | `tb stop <id>` · `tb stop --all` |
| 꺼내기 | `tb export <id> [--out DIR]` → `.excalidraw` |
| 지우기 | `tb delete <id> --yes` — 사용자가 분명히 요청했을 때만 |

## 규칙

- **열기 전에 확인할 것은 없다** — 사용자가 열어 달라고 했으면 바로 연다. 다만 링크를 가진 사람은 누구나 들어온다는 것(편집 링크 = 그리기 가능, 보기 링크 = 보기만)을 링크와 함께 한 줄로 알린다.
- 기본 만료 12시간. "오늘만" → 남은 시간에 맞춰, "회의 한 시간" → `--ttl 90m` 처럼 여유를 둔다. `--ttl 0` 은 사용자가 무기한을 원할 때만.
- 링크를 남에게 보내는 일(메일 · 메신저)은 하지 않는다 — 링크를 사용자에게 주고 사용자가 보낸다.
- 외부 공개가 싫다는 말이 있으면 `--lan`(같은 와이파이) 또는 `--tunnel none`(이 컴퓨터만).
- 노트북이 잠들거나 꺼지면 사이트도 멈춘다. 그림은 `~/.tempboard/sites/<id>/data` 에 남는다(만료 · 종료 뒤에도). 터널이 다시 열리면 주소가 바뀔 수 있다 — `tb links <id>` 로 새 링크를 준다.
- `cloudflared` 가 없다는 오류면 설치 방법(`brew install cloudflared`)을 알려 주고, 설치는 사용자의 동의를 받은 뒤에 한다.
- 처음 실행 때 화면 파일(약 30 MB)을 GitHub Release 에서 받는다. 막히면 Node.js 로 직접 빌드한다(자동).
