#!/usr/bin/env bash
# 受守卫保护的提交（T-79）。
#
# 存在意义只有一条：**守卫红 ⇒ 不执行 commit**。
# 手工跑守卫时最容易犯的错，是把断言写在 `||` 分支里只打印一句警告 —— 那样
# `set -e` 被"处理掉"了，提交照旧发生 ✗（PO 2026-10-10 手工跑守卫时就是这么栽的，
# 所以 T-79 要求"阻断必须真的阻断"，并且要有测试证明「守卫红时 git log 不增长」）。
#
# 用法:
#   bash scripts/guarded-commit.sh -m "提交信息"            # 正常提交
#   bash scripts/guarded-commit.sh -F /path/to/message.txt  # 从文件读提交信息
#   GUARD_BUILD_CMD='make dist' bash scripts/guarded-commit.sh -m "..."   # 换构建命令
#
# 退出码: 守卫的退出码原样透传（2 写入 / 3 构建失败 / 4 不一致）；提交失败 = git 的退出码。

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 守卫与提交的对象是**你当前所在的仓库**（不是这个脚本自己住的那个）——
# 否则在别的仓库里调用它，会去守/去提交 kit 自己 ✗（T-79 的测试就抓到过这一点）。
repo="${GUARD_REPO:-$(git -C "${GUARD_CWD:-$PWD}" rev-parse --show-toplevel)}"

echo "== 提交前守卫（T-79）=="
# 守卫的退出码**必须**原样决定去留：set -e + 直接调用 ⇒ 非零即中止，
# 后面的 git commit 根本不会被执行。
node "$here/precommit-guard.mjs" --cwd "$repo" --build-cmd "${GUARD_BUILD_CMD:-npm run build}" --settle-ms "${GUARD_SETTLE_MS:-5000}"

echo "== 守卫通过，执行提交 =="
exec git -C "$repo" commit "$@"
