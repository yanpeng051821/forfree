#!/bin/bash
# 把 cloudbase/migrations 下的迁移文件通过 tcb db execute 应用到云端 PostgreSQL。
# 迁移文件自带 BEGIN/COMMIT，必须整体一次性提交，不能拆分成多条语句。
#
# 用法：scripts/apply-migration.sh <迁移文件路径>
# 前置：tcb 已登录（tcb login），且已设置 TCB_ENV 或传入环境变量。
set -euo pipefail

FILE="${1:?usage: apply-migration.sh <migration.sql>}"
ENV_ID="${TCB_ENV:-yanpeng-d1giw89zv518e3f6e}"

[ -f "$FILE" ] || { echo "迁移文件不存在: $FILE" >&2; exit 1; }

echo "目标环境: $ENV_ID"
echo "迁移文件: $FILE"

# 迁移含中文与 $$ 引用，用文件读取避免 shell 转义问题。
SQL="$(cat "$FILE")"
tcb db execute --env-id "$ENV_ID" --sql "$SQL"
