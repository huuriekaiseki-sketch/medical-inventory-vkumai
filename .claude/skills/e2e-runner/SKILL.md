---
name: e2e-runner
description: E2Eテストとスクリーンショットを生成・実行する。
  「E2Eを書いて」「画面の動作確認をして」のときに使う。
allowed-tools: Read, Write, Bash
---

1. 仕様書の📸マークと撮影ポイントを対応させる
2. Playwright でテストを生成し e2e/ に置く
3. ./screenshot.sh で全画面を撮影し screenshots/ に保存する
（screenshot.sh はこのスキルフォルダに同梱）
