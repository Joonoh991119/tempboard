#!/usr/bin/env bash
# 화면 빌드를 Release 자산으로 묶는다. 사용: scripts/release-dist.sh  → web/tempboard-dist.tar.gz
# 그 뒤: gh release create v<버전> web/tempboard-dist.tar.gz   (버전은 .claude-plugin/plugin.json 과 같게)
set -euo pipefail
cd "$(dirname "$0")/../web"
npm ci --no-audit --no-fund
npm run build
tar -czf tempboard-dist.tar.gz dist
ls -lh tempboard-dist.tar.gz
