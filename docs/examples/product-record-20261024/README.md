# 合成商品记录 Excel · 2026-10-24

这些文件由 `scripts/sample-product-export.ts` 生成，只使用虚构商户、商品和程序绘制的演示图片；不读取数据库、不连接网络、不使用真实参考 Excel。

- `商品记录-带全部图片.xlsx`：2 个商户、4 条记录、9 张图片，演示同货号独立记录、图片网格、未知值与显式 0。
- `商品记录-纯数据.xlsx`：同 4 条记录，无图片列。
- `商品记录-仅已核对.xlsx`：2 条已核对记录，无图片。
- `validation.json`：保存生成时的数值、公式缓存、ZIP CRC、图片数和源数据不变检查结果，以及各文件的大小与 SHA-256。

本机重新生成（默认输出到 Git 忽略的 `.data/outputs/product-record-20261024/`，不会覆盖本目录）：

```bash
node --import tsx scripts/sample-product-export.ts
```

这些文件仅作为备份和查看样例，不是订单或真实采购表。当前已完成自动化结构与数值检查，桌面 Excel/WPS 打开、编辑重算、微信真机打开与分享仍待人工验收。
