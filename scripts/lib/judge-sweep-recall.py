#!/usr/bin/env python3
# scripts/eval-sweep-recall.shから呼ばれる決定的判定ロジック(issue #431)。
# 環境変数EXPECTED_FILE(expected.jsonのパス)・DETAIL_FILE(sweep出力detailを書き出したファイル)
# を読み、期待ファイルパスの部分文字列と期待キーワードのいずれか1つが両方detail内に
# 含まれていれば"true"を出力する。ファイル経由にしているのは、detail文字列がシェル引用符・
# バッククォート等を含んでも安全に受け渡すため。
#
# expectedFilePathContains は文字列または文字列の配列(issue #731)。配列なら「いずれか1つ」が
# 含まれていればパス一致とする。層をまたぐ欠陥（型定義とmapperの不一致等）は、エージェントが
# どちら側のファイルを指しても正しい検出であり、片側だけを正解にすると検出しているのに
# MISS になる（2026-09-05 実測: sweep-types が型定義側 src/types/eval-fixture-recall.ts を
# 指して報告したが、期待パスが repository.ts 固定だったため 0/1）。
import json
import os

expected_path = os.environ["EXPECTED_FILE"]
detail_path = os.environ["DETAIL_FILE"]

with open(expected_path) as f:
    expected = json.load(f)
with open(detail_path) as f:
    detail = f.read().lower()

paths = expected["expectedFilePathContains"]
if isinstance(paths, str):
    paths = [paths]

path_hit = any(p.lower() in detail for p in paths)
keyword_hit = any(k.lower() in detail for k in expected["expectedKeywords"])

print("true" if (path_hit and keyword_hit) else "false")
