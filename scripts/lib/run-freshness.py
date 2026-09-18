"""「最後に全件を通したのはいつで、結果は何だったか」を記録から読み、必要なら警告文を出す。

WHY: 2026-09-07 に統合テストが 2 件、いつからか分からないほど前から赤いまま放置されていた。
     2026-09-08 には E2E が 1 日以上赤のまま誰にも見られていなかった（E-060）。
     どちらも「回したかどうか」ではなく「**この木で通したか**」を誰も記録していなかったのが原因。

WHY(1 か所に置く): 統合テストと E2E で同じ判定を 2 つ書くと、片方だけ直したときに
     もう片方が黙って古くなる。判定はここだけに置き、違うのは
     「何を見張るか（木）」「どう回すか（コマンド）」だけにする。

使い方:
    python3 run-freshness.py --log <path> --label <名前> --runner <コマンド> \\
        --tree <名前>=<現在のハッシュ> [--tree ...] [--changed-note <一文>]

出力: 警告文（1 行以上）。問題が無ければ何も出さない。
記録の 1 行は run-*-tests.sh が書く JSON で、木ごとに `<名前>Tree` と `<名前>Dirty` を持つ。
"""

import argparse
import json
import os
import sys


def parse_args(argv):
    p = argparse.ArgumentParser()
    p.add_argument("--log", required=True)
    p.add_argument("--label", required=True)
    p.add_argument("--runner", required=True)
    p.add_argument("--tree", action="append", default=[], metavar="NAME=HASH")
    # WHY(C-041、2026-09-09): HEAD の木だけでは**未コミットの変更**が見えない。
    #      「いまその場所がどう見えるか」のハッシュ（scripts/lib/worktree-hash.sh）を渡すと、
    #      記録に同じ値があるかで「この状態で全件を通したか」を判定できる。
    #      古い記録にはこの値が無いので、その場合は従来の判定へ落ちる（黙って通さない）。
    p.add_argument("--worktree", action="append", default=[], metavar="NAME=HASH")
    p.add_argument("--changed-note", default="")
    args = p.parse_args(argv)
    trees = []
    for spec in args.tree:
        if "=" not in spec:
            p.error(f"--tree は NAME=HASH の形で渡す: {spec}")
        name, _, value = spec.partition("=")
        trees.append((name, value))
    if not trees:
        p.error("--tree を 1 つ以上渡す")
    args.trees = trees
    worktrees = []
    for spec in args.worktree:
        if "=" not in spec:
            p.error(f"--worktree は NAME=HASH の形で渡す: {spec}")
        name, _, value = spec.partition("=")
        worktrees.append((name, value))
    args.worktrees = worktrees
    return args


def read_last(log_file):
    """記録の最後の 1 行を返す。読めなければ None"""
    last = None
    with open(log_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                last = json.loads(line)
            except json.JSONDecodeError:
                continue
    return last


def check(args):
    """警告文を返す。問題が無ければ空文字"""
    if not os.path.exists(args.log):
        return (
            f"{args.label}を通した記録が 1 件もありません。"
            f"`{args.runner}` で回すと結果が記録され、次から鮮度を見られます。"
        )

    last = read_last(args.log)
    if last is None:
        return (
            f"{args.label}の記録ファイルは在りますが、読める行がありません。"
            f"`{args.runner}` で回し直してください。"
        )

    when = last.get("at", "不明")
    if last.get("result") != "pass":
        return (
            f"直近の{args.label}は **失敗** のままです（{when}、branch {last.get('branch', '不明')}）。"
            f"`{args.runner}` で再現し、赤を残したまま先へ進めないでください。"
        )

    # WHY(いまの姿を先に見る・C-041): 未コミットの変更まで含めたハッシュが記録と違えば、
    #      **いまの状態では一度も全件を通していない**。単体だけ緑にして終える形をここで止める。
    #      記録にこの値が無い（この仕組みより前の記録）ときは、下の従来の判定へ落ちる。
    for name, value in getattr(args, "worktrees", []):
        recorded = last.get(f"{name}Worktree")
        if recorded is None:
            continue
        if recorded != value:
            return (
                f"いまの `{name}/` の状態では{args.label}を通していません"
                f"（直近に通したのは {when} の別の状態）。"
                f"**単体のテストだけを緑にして終えていないか確かめてください。**"
                f"`{args.runner}` を回してから作業を終えてください。"
            )

    # WHY(未コミットを先に見る): 未コミットの変更がある状態で通しても「その木で通した」証拠にならない。
    #      木のハッシュは HEAD のものなので、この場合ハッシュは一致してしまう
    for name, _ in args.trees:
        if last.get(f"{name}Dirty"):
            return (
                f"直近の{args.label}は通っていますが（{when}）、"
                f"未コミットの `{name}/` 変更がある状態での実行でした。"
                f"コミット後にもう一度 `{args.runner}` を回してください。"
            )

    changed = [name for name, value in args.trees if last.get(f"{name}Tree") != value]
    if changed:
        paths = "・".join(f"`{name}/`" for name in changed)
        note = f"{args.changed_note}" if args.changed_note else ""
        return (
            f"直近に{args.label}を通したとき（{when}）から {paths} の中身が変わっています。"
            f"{note}`{args.runner}` を回してから作業を終えてください。"
        )

    return ""


def main(argv):
    args = parse_args(argv)
    message = check(args)
    if message:
        print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
