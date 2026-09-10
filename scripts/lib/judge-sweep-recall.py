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
# expected.json の expectNoFinding: true は**陰性対照**。欠陥の無い fixture について
# エージェントが指摘を出さないことを成功とする（陽性だけを測ると「全部に指摘を出す」
# エージェントが満点を取れてしまう）。
#
# WHY(「指摘 0 件」では測れない、2026-09-10): 最初は「1 件も指摘していないこと」を成功にしたが、
#   sweep は**コードベース全体**を調べるので、無関係な実コードについて指摘を出すのが普通で、
#   同じ fixture が実行のたびに HIT と MISS を行き来した（実測: 2/2 → 1/2 → 2/2）。
#   **flaky な評価は読まれなくなるので、無いより悪い。**
#   判定を陽性と対称にする——「指摘を出していて、かつその指摘が**この fixture のパスとキーワード**に
#   結びついている」ときだけ過検出とする。他のファイルへの指摘は数えない。
#
#   限界: パスとキーワードの両方を含みつつ「問題ありません」と述べる書き方は、
#   過検出として数えてしまう（安全側）。逆に、パスを名指しせずに指摘した過検出は見逃す。
import json
import os
import re
import sys

FINDINGS_RE = re.compile(r"^\s*findings\s*[:：]\s*(\d+)", re.IGNORECASE | re.MULTILINE)
# 出力契約が定める「指摘が無い」ときの語。ここに無い言い回しは指摘ありとして扱う（安全側）
NO_FINDING_PHRASES = ("指摘なし", "指摘は なし", "指摘 なし")

# WHY(同じ指摘の中で照合する、2026-09-10・レビュー指摘 R11 の後段):
#   パスとキーワードを**本文のどこかにあるか**で見ていたので、
#   **別々の指摘に分散していても HIT** になった。Sweep はリポジトリ全体を掃くので
#   無関係な指摘が何件も並ぶのが普通で、この形の誤判定は起こりやすい。
#   例（期待が「repository.ts」＋「requireAuth」のとき）:
#       FINDINGS: 2
#       1. src/lib/foo/repository.ts — 型が合っていません
#       2. src/app/api/bar/route.ts — requireAuth が呼ばれていません
#   どちらの指摘もこの fixture の欠陥ではないのに、本文全体では両方の語が出るので true だった。
#
#   出力契約（sweep.js の STATUS_GUIDE）が定めているのは件数の行だけで、
#   **指摘の区切り方は決めていない**。だから書き方から推測して切るしかない——
#   行頭（インデントなし）の箇条書き・番号・見出しを「新しい指摘の始まり」とみなす。
#   **インデントされた箇条書きは切らない**（1 つの指摘が
#   「ファイル: …／問題: …」と入れ子で続く形が普通なので、切ると 1 件が分断されて
#   実際より recall が低く出る）。
NEW_FINDING_RE = re.compile(r"^(?:[-*•‣]|\d+[.)]|#{1,6}\s|\*\*\d+[.)])")


def _squash(text: str) -> str:
    return text.replace(" ", "").replace("　", "")


def reported_findings(detail: str) -> bool:
    """このdetailは「1件以上の指摘」を報告しているか。

    WHY(「指摘なし」を本文全体から探さない、2026-09-10): 最初は本文のどこかに
    「指摘なし」があれば 0 件と読んでいた。ところが sweep の報告は層ごとに並ぶことが多く、
    **「A 層は指摘なし」と書きながら B 層の欠陥を挙げる**のが普通の形なので、
    1 件でも指摘している報告を 0 件と読み違える（実測: JSON が返らず生出力へ落ちた回に
    陽性の case が MISS した）。判定に使うのは、まず契約の `FINDINGS: <件数>` の行。
    無い場合だけ、**最後の非空行**——総括が置かれる位置——に限って語を探す
    （1 行だけの回答なら最初の行と同じなので、そちらも自然に拾える）。

    限界: 指摘を挙げたあとに層ごとの「〜は指摘なし」で締める書き方は 0 件と読み違える。
    契約の `FINDINGS: <件数>` の行があればこの経路には入らないので、
    まずは**契約を守らせること**が防御の本体。
    """
    m = FINDINGS_RE.search(detail)
    if m:
        return int(m.group(1)) > 0
    lines = [line for line in detail.split("\n") if line.strip() != ""]
    if not lines:
        return False
    summary = _squash(lines[-1])
    if any(_squash(p) in summary for p in NO_FINDING_PHRASES):
        return False
    return True


def findings_count(detail: str) -> int:
    """報告された指摘の件数。読めなければ -1（0 と区別する）。

    WHY(2026-09-10): 陰性対照は「その fixture への指摘」しか数えないので、
        **実コードへの誤指摘が 0 件として素通り**していた。
        Sweep は毎回リポジトリ全体を掃くので、この件数を残せば
        「素の木にどれだけ指摘を出すか」を追える。
        **本物か誤りかは分けない**（それは人が見る）。0 と「読めなかった」は混ぜない。
    """
    m = FINDINGS_RE.search(detail)
    if m:
        return int(m.group(1))
    lines = [line for line in detail.split("\n") if line.strip() != ""]
    if not lines:
        return -1
    summary = _squash(lines[-1])
    if any(_squash(p) in summary for p in NO_FINDING_PHRASES):
        return 0
    return -1


def finding_blocks(detail: str) -> list:
    """報告を「1 つの指摘」の単位へ切る。

    件数の行（`FINDINGS: N`）は指摘そのものではないので落とす。
    空行・行頭の箇条書き・番号・見出しで切り、**インデントされた行は切らない**。

    限界:
      - 契約が区切りを定めていないので、**書き方からの推測**である。
        1 つの指摘を空行で区切って書くモデルには分断される（MISS 側＝厳しい側へ倒れる）
      - 逆に、複数の指摘を改行なしで 1 段落に書くと 1 ブロックになる（甘い側）
      - この不確かさがあるので、**従来どおり本文全体で見た結果（loose）も併せて記録**し、
        判定の切り替えが後から効果を測れるようにしている（`--loose`）
    """
    blocks = []
    current = []
    for line in detail.split("\n"):
        if FINDINGS_RE.match(line):
            continue
        if line.strip() == "":
            if current:
                blocks.append("\n".join(current))
                current = []
            continue
        if current and NEW_FINDING_RE.match(line):
            blocks.append("\n".join(current))
            current = []
        current.append(line)
    if current:
        blocks.append("\n".join(current))
    return blocks


def matched_in_same_finding(detail_lower: str, paths: list, keywords: list) -> bool:
    """パスとキーワードが**同じ指摘の中に**そろっているか"""
    for block in finding_blocks(detail_lower):
        if any(p in block for p in paths) and any(k in block for k in keywords):
            return True
    return False


def main() -> int:
    # --count: 判定ではなく**報告された指摘の件数**を返す（読めなければ -1）
    if "--count" in sys.argv:
        with open(os.environ["DETAIL_FILE"]) as f:
            print(findings_count(f.read()))
        return 0

    expected_path = os.environ["EXPECTED_FILE"]
    detail_path = os.environ["DETAIL_FILE"]

    with open(expected_path) as f:
        expected = json.load(f)
    with open(detail_path) as f:
        raw = f.read()
    detail = raw.lower()

    has_finding = reported_findings(raw)

    paths = expected["expectedFilePathContains"]
    if isinstance(paths, str):
        paths = [paths]

    paths_lower = [p.lower() for p in paths]
    keywords_lower = [k.lower() for k in expected["expectedKeywords"]]

    # --loose: 本文全体で見る**従来の**判定（2026-09-10 まで唯一の判定だった）。
    #   切り替えの影響を後から測るために残してある。合否には使わない
    if "--loose" in sys.argv:
        loose = has_finding and any(p in detail for p in paths_lower) and any(k in detail for k in keywords_lower)
        if expected.get("expectNoFinding") is True:
            print("false" if loose else "true")
        else:
            print("true" if loose else "false")
        return 0

    # 「この fixture について指摘した」= 指摘があり、**1 つの指摘の中で**
    # パスとキーワードが結びついている（R11 の後段。分散していたら数えない）
    reported_about_fixture = has_finding and matched_in_same_finding(detail, paths_lower, keywords_lower)

    # 陰性対照: 欠陥が無い fixture。この fixture について指摘しないことが正解
    if expected.get("expectNoFinding") is True:
        print("false" if reported_about_fixture else "true")
        return 0

    print("true" if reported_about_fixture else "false")
    return 0


if __name__ == "__main__":
    sys.exit(main())
