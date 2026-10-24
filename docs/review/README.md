# 方案与交接资料备份 · 2026-10-24

本目录归档工作区 `.huoji-review/` 中当前方案、两份 handoff、静态原型源码和必要演示图片，不是整个私有评审目录的镜像。

- 当前产品方案：[report/SOLUTION.md](report/SOLUTION.md)。只做个人商品记录、整理、比较与参考式 Excel；商户 / 商品两个 tab，设置为普通页面。
- 交接资料：[HANDOFF-REVIEW.md](HANDOFF-REVIEW.md)、[HANDOFF-TODO.md](HANDOFF-TODO.md)；`final-v13/` 与 `revise-r4/` 保留对应文档和历史验证记录。
- 原型入口：[report/mockups/index.html](report/mockups/index.html)。可直接用浏览器打开；演示数据不连接业务，截图不代表微信真机验收。`legacy-redacted/` 为已遮蔽联系方式的历史对照图。
- `final-v13/baseline-v12/` 是旧方案历史快照，不能覆盖当前方案。`revise-r4/revise.mjs` 保留历史源码，入口已停用。

原型生成命令（从仓库根目录执行，需要 Python 3）：

```bash
python3 docs/review/report/mockups/gen.py
python3 docs/review/report/mockups/compare.py
node docs/review/final-v13/verify.mjs
```

归档副本将原型图片及生成、核验脚本的本机绝对路径改为相对路径。核验脚本检查当前代码与方案的一致性、相对于历史基线 `9d07bc2` 的修改范围，结果仅输出到终端；不覆写历史 `validation.json`。需要先安装仓库依赖；业务测试见 [../QA-20261024.md](../QA-20261024.md)。

`final-v13/finalize.mjs` 会重建本归档内的方案与镜像文档；日常查看不需要运行。未复制浏览器二进制、依赖目录、私有会话日志、原始采购表、数据库、云平台响应或临时验收证据。历史文档中的绝对路径和部署记录为当时的追溯信息，不代表从远端拉取即可恢复私有资料，也不代表本次重新部署。
