#!/usr/bin/env python3
# scripts/eval-sweep-recall.shから呼ばれる決定的判定ロジック(issue #431)。
# 環境変数EXPECTED_FILE(expected.jsonのパス)・DETAIL_FILE(sweep出力detailを書き出したファイル)
# を読み、期待ファイルパスの部分文字列と期待キーワードのいずれか1つが両方detail内に
# 含まれていれば"true"を出力する。ファイル経由にしているのは、detail文字列がシェル引用符・
# バッククォート等を含んでも安全に受け渡すため。
import json
import os

expected_path = os.environ["EXPECTED_FILE"]
detail_path = os.environ["DETAIL_FILE"]

with open(expected_path) as f:
    expected = json.load(f)
with open(detail_path) as f:
    detail = f.read().lower()

path_hit = expected["expectedFilePathContains"].lower() in detail
keyword_hit = any(k.lower() in detail for k in expected["expectedKeywords"])

print("true" if (path_hit and keyword_hit) else "false")
