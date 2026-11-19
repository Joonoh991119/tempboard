---
description: "임시 화이트보드 사이트를 열고 초대 링크를 준다 (Open a temporary shared whiteboard and get invite links)"
argument-hint: "[보드 이름] [--ttl 12h] [--view-link] [--lan | --tunnel none]"
---
`tempboard` 스킬을 따른다. 인자: $ARGUMENTS

1. 인자에서 보드 이름(따옴표 밖 낱말 · 없으면 생략)과 옵션을 가른다. 만료를 말하지 않았으면 기본 `--ttl 12h`.
2. `python3 "${CLAUDE_PLUGIN_ROOT}/bin/tempboard" start --json [--title "<이름>"] [옵션]` 을 실행한다(처음 한 번은 화면 파일을 받느라 시간이 걸린다).
3. 나온 `links.edit`(같이 그리기) · `links.view`(보기 전용, 있으면) · 닫히는 시각을 사용자에게 그대로 보여 준다. 링크를 가진 사람은 누구나 들어올 수 있다는 것도 한 줄로 알린다.
