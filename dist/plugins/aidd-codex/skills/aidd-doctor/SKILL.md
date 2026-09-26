---
name: aidd-doctor
description: AIDD Codex プラグインの hook、信頼状態、実行系、project hook との重複を診断する。
---

# AIDD Codex doctor

作業対象リポジトリで `bash <このスキルのプラグインルート>/scripts/aidd-codex-doctor.sh` を実行する。
このスキルがあるディレクトリからプラグインルートへは `../..`。実行時に `PLUGIN_ROOT` を渡す必要はない。

出力は行ごとに読む。`hook` は同梱の有無、`信頼状態` は Codex による hook の信頼状態、`実行系` はコマンドと gh 認証、`参照` は Git のローカル情報、`二重登録` は project hook との重複を示す。`判定しない` は必要条件の欠落を示す。`実行前提あり` は hook の発火や保護を保証しない。信頼状態が「不明」なら Codex 上で別途確認する。
