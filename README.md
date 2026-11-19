# tempboard

**링크 하나로 누구와든 같이 그리는 임시 화이트보드 — Claude Code 플러그인.**
A Claude Code plugin that spins up a temporary, link-shared collaborative whiteboard. One command, one invite link, auto-expires.

```
/tempboard:open 회의 메모 --ttl 2h --view-link

tempboard 1119-1843-fb4f — running · 11/19 20:43 에 닫힘
  같이 그리기  https://xxxx.trycloudflare.com/?k=…#b=…
  보기 전용    https://xxxx.trycloudflare.com/?k=…#b=…
```

- **Excalidraw 기반** 큰 도구막대(선택 · 펜 · 지우개 · 글 · LaTeX 수식 · 레이저 · 화면 이동), 한글 글꼴(Noto Sans KR · Gaegu)
- **실시간 동기화** — WebSocket(안 되면 롱폴링), 커서 · 이름표, 각자 자기 작업만 실행취소, 서버가 꺼졌다 켜져도 그림 손실 없음
- **초대 키** — 편집 링크 · 보기 전용 링크. 키 없는 접근은 403. 링크로 들어오면 키는 쿠키로 바뀌고 주소에서 지워진다
- **임시** — Cloudflare quick tunnel(계정 불필요)로 공개 주소, 정한 시간(기본 12h)이 지나면 저절로 닫힘. 그림은 로컬에 남고 `.excalidraw` 로 꺼낼 수 있음
- 서버는 Python 표준 라이브러리만 씀

## 설치 / Install

```
/plugin marketplace add Joonoh991119/tempboard
/plugin install tempboard@tempboard
```

필요한 것: Python 3.10+, [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`brew install cloudflared`). 화면 파일은 처음 실행 때 GitHub Release 에서 받는다(실패하면 Node.js 로 직접 빌드).

## 쓰기 / Usage

| Claude Code | CLI (`bin/tempboard`) | |
|---|---|---|
| `/tempboard:open [이름] [--ttl 3h] [--view-link]` | `tempboard start …` | 새 사이트 + 초대 링크 |
| `/tempboard:list [id]` | `tempboard list` · `links <id>` | 목록 · 링크 다시 |
| `/tempboard:stop <id>` | `tempboard stop <id>\|--all` | 닫기(그림은 남음) |
| `/tempboard:export <id>` | `tempboard export <id>` | `.excalidraw` 로 |
| 말로: "화이트보드 열어서 링크 줘" | | 스킬 `tempboard` |

옵션: `--ttl 30m|3h|2d|0`(0 = 닫을 때까지) · `--view-link` · `--lan`(같은 와이파이만) · `--tunnel none`(이 컴퓨터만).
자료 위치: `~/.tempboard/sites/<id>/` (`TEMPBOARD_HOME` 으로 바꿈). `state.json` 에 초대 키가 있어 권한 0600.

## 보안 메모 / Security notes

- 링크(키)를 가진 사람은 누구나 들어온다. 편집 링크는 그리기 · 보드 만들기가 되고, 보기 링크로 온 사람에게는 편집 키를 주지 않는다.
- 서버는 127.0.0.1 에만 묶이고 터널이 바깥과 잇는다(`--lan` 일 때만 0.0.0.0). 쓰기 요청은 `X-Whiteboard` 머리를 요구(CSRF), CSP `script-src 'self'`.
- 노트북이 잠들면 사이트도 멈춘다. 터널이 다시 열리면 주소가 바뀔 수 있다(`tempboard links <id>`).
- quick tunnel 은 Cloudflare 의 시험용 서비스라 가용성 보장이 없다. 오래 쓸 팀 보드라면 이름 있는 터널이나 자체 서버 뒤에 `server/server.py --trust-header` 로 붙인다.

## 개발 / Development

```bash
cd web && npm ci && npm run build && npm test     # 화면 + JS 시험
python3 tests/test_server.py                      # 서버 시험
python3 server/server.py --data /tmp/tb --edit-key dev   # → http://127.0.0.1:8790/?k=dev
scripts/release-dist.sh && gh release create v0.1.0 web/tempboard-dist.tar.gz   # 배포
```

`server/server.py` 의 HTTP API(보드 · 요소 병합 · WebSocket · 롱폴링 · 파일)는 서버 머리말과 코드 주석에 있다. 병합 규칙은 Excalidraw 와 같다(version 큰 쪽, 같으면 versionNonce 작은 쪽).

Originally built as the team whiteboard for a research-competition wiki; extracted and generalized here.

## License

MIT. Excalidraw (MIT), MathJax (Apache-2.0), font subsets (SIL OFL 1.1).
