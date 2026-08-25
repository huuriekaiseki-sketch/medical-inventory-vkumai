---
name: e2e-runner
description: E2Eテストとスクリーンショットを生成・実行する。
  「E2Eを書いて」「画面の動作確認をして」のときに使う。
allowed-tools: Read, Write, Bash(npx playwright *), Bash(${CLAUDE_SKILL_DIR}/screenshot.sh *)
---

1. 仕様書の📸マークと撮影ポイントを対応させる
2. Playwright でテストを生成し e2e/ に置く
3. ${CLAUDE_SKILL_DIR}/screenshot.sh <url> <name> で全画面を撮影し screenshots/ に保存する
（screenshot.sh はこのスキルフォルダに同梱。`${CLAUDE_SKILL_DIR}` は実行時にスキルフォルダの
絶対パスへ展開され、frontmatterの`allowed-tools`の許可ルールと同じ文字列になるため
確認プロンプトなしで実行できる）
