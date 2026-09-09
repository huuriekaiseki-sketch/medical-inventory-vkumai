#!/usr/bin/env python3
# scripts/eval-sweep-recall.shから呼ばれる決定的判定ロジック(issue #431)。
# 環境変数EXPECTED_FILE(expected.jsonのパス)・DETAIL_FILE(sweep出力detailを書き出したファイル)
# を読み、判定結果を "true"/"false" の 1 行で出力する。
# ファイル経由にしているのは、detail文字列がシェル引用符・バッククォート等を含んでも
# 安全に受け渡すため。
#
# expectedFilePathContains は文字列または文字列の配列(issue #731)。配列なら「いずれか1つ」が
# 含まれていればパス一致とする。層をまたぐ欠陥（型定義とmapperの不一致等）は、エージェントが
# どちら側のファイルを指しても正しい検出であり、片側だけを正解にすると検出しているのに
# MISS になる（2026-09-05 実測: sweep-types が型定義側 src/types/eval-fixture-recall.ts を
# 指して報告したが、期待パスが repository.ts 固定だったため 0/1）。
#
# WHY(「指摘なし」を成功と読まない、2026-09-10・レビュー指摘 R11):
#   判定が「期待パスの部分文字列 AND 期待キーワード」だけだったため、
#   **「route.ts を確認しましたが requireAuth も呼ばれており認証・認可に問題はありません」**
#   という**欠陥を見逃した回答**でも、パスとキーワードが本文に出てくるので true になった
#   （2026-09-10 実測: 陰性の回答・陽性の回答がどちらも true）。
#   recall を測っているつもりで「その語を口にしたか」を測っていたことになる。
#
#   そこで **指摘の有無そのもの**を先に判定する。sweep の出力契約
#   （.claude/workflows/lib/prompts/sweep.js の STATUS_GUIDE）は
#   1 行目に `FINDINGS: <件数>` を書くことを求めており、まずそれを読む。
#   書かれていない出力（旧い記録・指示に従わないモデル）は、同じ契約が定めている
#   「指摘が無ければ『指摘なし』と書く」という**契約された語**で判定する。
#   どちらも読めない場合は「指摘あり」とみなす（判定できないことを理由に
#   recall を下げると、判定の壊れがモデルの劣化に見えるため）。
#
# expected.json の expectNoFinding: true は**陰性対照**。欠陥の無い fixture に対して
# エージェントが何も指摘しないことを成功とする（陽性だけを測ると「全部に指摘を出す」
# エージェントが満点を取れてしまう）。
import json
import os
import re
import sys

FINDINGS_RE = re.compile(r"^\s*findings\s*[:：]\s*(\d+)", re.IGNORECASE | re.MULTILINE)
# 出力契約が定める「指摘が無い」ときの語。ここに無い言い回しは指摘ありとして扱う（安全側）
NO_FINDING_PHRASES = ("指摘なし", "指摘は なし", "指摘 なし")


def reported_findings(detail: str) -> bool:
    """このdetailは「1件以上の指摘」を報告しているか。"""
    m = FINDINGS_RE.search(detail)
    if m:
        return int(m.group(1)) > 0
    normalized = detail.replace(" ", "").replace("　", "")
    if any(p.replace(" ", "") in normalized for p in NO_FINDING_PHRASES):
        return False
    return True


def main() -> int:
    expected_path = os.environ["EXPECTED_FILE"]
    detail_path = os.environ["DETAIL_FILE"]

    with open(expected_path) as f:
        expected = json.load(f)
    with open(detail_path) as f:
        raw = f.read()
    detail = raw.lower()

    has_finding = reported_findings(raw)

    # 陰性対照: 欠陥が無い fixture。何も指摘しないことが正解
    if expected.get("expectNoFinding") is True:
        print("true" if not has_finding else "false")
        return 0

    paths = expected["expectedFilePathContains"]
    if isinstance(paths, str):
        paths = [paths]

    path_hit = any(p.lower() in detail for p in paths)
    keyword_hit = any(k.lower() in detail for k in expected["expectedKeywords"])

    print("true" if (has_finding and path_hit and keyword_hit) else "false")
    return 0


if __name__ == "__main__":
    sys.exit(main())
