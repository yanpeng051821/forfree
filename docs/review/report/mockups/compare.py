#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「现状 vs 建议」对照图 HTML。左右各 375 宽，直接引用现成 PNG。"""
import os, subprocess
from html import escape

BASE = os.path.dirname(os.path.abspath(__file__))
CUR = os.path.join(BASE, "legacy-redacted")
MINE = os.path.join(BASE, "shots")

CSS = """
*{box-sizing:border-box;margin:0;padding:0}
html{background:#e9ece8}
body{width:812px;min-height:100vh;background:#eef1ee;color:#1f2a24;
  font-family:"Noto Sans CJK SC","PingFang SC",sans-serif;font-size:14px;line-height:1.4;
  padding:20px 20px 24px}
.head{margin:0 4px 14px}
.head h1{font-size:19px;font-weight:600}
.head p{font-size:12px;color:#4a574f;margin-top:4px;line-height:18px}
.head .k{color:#263b32;font-weight:600}
.row{display:flex;gap:22px;align-items:flex-start}
.row+.row{margin-top:18px}
.col{flex:0 0 375px;align-self:flex-start}
.cap{display:flex;align-items:center;gap:6px;margin-bottom:7px;height:22px}
.chip{height:20px;padding:0 7px;border-radius:6px;font-size:12px;font-weight:600;display:flex;align-items:center}
.chip.now{background:#e3e9e5;color:#4a574f}
.chip.new{background:#263b32;color:#fff}
.cap .t{font-size:12px;color:#5f6c64;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.shot{width:375px;border-radius:8px;overflow:hidden;border:1px solid #d7dfd9;background:#fff}
.shot img{display:block;width:375px;height:auto}
.arrow{align-self:center;color:#87928b;font-size:18px;padding-top:120px}
.legend{margin:16px 4px 0;font-size:11px;color:#5f6c64;line-height:18px}
.legend b{color:#263b32;font-weight:600}
"""

def col(img_path, kind, caption):
    cls = "now" if kind == "now" else "new"
    word = "现状" if kind == "now" else "建议"
    cap = caption
    for pre in ("现状 · ", "建议 · "):
        if cap.startswith(pre):
            cap = cap[len(pre):]
    image_url = escape(os.path.relpath(img_path, BASE).replace(os.sep, "/"), quote=True)
    return f'''<div class="col"><div class="cap"><span class="chip {cls}">{word}</span><span class="t">{cap}</span></div>
    <div class="shot"><img src="{image_url}"></div></div>'''

def page(title, sub, rows, legend):
    body = f'<div class="head"><h1>{title}</h1><p>{sub}</p></div>'
    for i, (a, b) in enumerate(rows):
        body += f'<div class="row">{a}{b}</div>'
    body += f'<div class="legend">{legend}</div>'
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{title}</title>
<style>{CSS}</style></head><body>{body}</body></html>'''

GROUPS = {
 "c1-field": dict(
   title="对照 1 · 商户：记录入口与草稿提示",
   sub="左：历史渲染（不是真机，联系方式已遮蔽）；右：正式方案 v1.3 两tab静态示意（右上角设置、按商户继续记录、发现本机修改）。",
   rows=[( col(CUR+"/01-projects-list.png","now","现状 · 看货：按任务分组，卡片信息密度低"),
           col(MINE+"/01-field-today.png","new","建议 · 商户 · 今天：右上角设置，可继续记录") )],
   legend="<b>建议稿的取舍：</b>日期与商户范围清楚，发现本机未保存修改；不增加采购批次或下单入口。静态示意不证明实际操作已实现。"),
 "c2-library": dict(
   title="对照 2 · 商品：范围、复看与直接导出",
   sub="左：历史商品渲染；右：日期/商户、可切紧凑列表、资料提示与导出。正式方案静态示意，不是现有实现。",
   rows=[( col(CUR+"/03-products-merchant.png","now","现状 · 商品（按商户+日期）：卡片 2 列，主操作浮在内容上"),
           col(MINE+"/05-library-list.png","new","建议 · 商品：跨日复看、自己整理、两件比较、导出 Excel") )],
   legend="<b>关键差异：</b>保留返回位置，范围清楚；整理是复看资料，不是采购审批。商品收藏不代表采购决定，大图视图仍保留。"),
 "c3-capture-export": dict(
   title="对照 3 · 现场录入与 Excel 范围",
   sub="左列：现状的录入页（约 18 个字段、两个悬浮圆钮、字段名混用英文 REF./QUANTITY）与导出页（只有格式和范围选项）。"
       "右列：正式方案的现场录入（系统相机、核心字段、文字保存按钮）与导出（日期、商户、缺项和十一列参考版式的局部缩略）。",
   rows=[( col(CUR+"/09-editor-new.png","now","现状 · 记录商品：长表单，保存按钮悬浮遮挡内容"),
           col(MINE+"/04-field-capture.png","new","建议 · 现场记录：核心字段在前，其余按需补充") ),
         ( col(CUR+"/14-export.png","now","现状 · 导出：格式/范围两组分段器，缺少文件内容说明"),
           col(MINE+"/08-export-picker.png","new","建议 · 商品 Excel：范围与缺项可见，不要求下单") )],
   legend="<b>验收：</b>内容不丢、当前商户准确、复看少翻页、Excel范围/字段/图片一致。缺项允许导出；不承诺未经真机验证的动作数或保存耗时。"),
}

def main():
    for k, v in GROUPS.items():
        html = page(v["title"], v["sub"], v["rows"], v["legend"])
        with open(os.path.join(BASE, k + ".html"), "w", encoding="utf-8") as f:
            f.write(html)
        print("wrote", k)

if __name__ == "__main__":
    main()
