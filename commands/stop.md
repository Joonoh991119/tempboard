---
description: "임시 화이트보드 사이트 닫기 — 링크가 끊기고 그림은 남는다 (Stop a tempboard site)"
argument-hint: "<id> | --all"
---
인자: $ARGUMENTS. 비어 있으면 먼저 `list` 로 열린 사이트를 보여 주고 어느 것을 닫을지 묻는다. 그 뒤 `python3 "${CLAUDE_PLUGIN_ROOT}/bin/tempboard" stop <id|--all>`.
그림까지 지우는 `delete` 는 사용자가 지우라고 분명히 말했을 때만 쓴다.
