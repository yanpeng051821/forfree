#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v1.3正式方案静态示意；文件名历史保留，两tab/普通设置，演示不连接业务。"""
import os
from html import escape

BASE = os.path.dirname(os.path.abspath(__file__))
ASSETS = "../../render/assets/img"


def icon(name):
    shapes = {
        "camera": '<path d="M3 7h4l2-3h6l2 3h4v13H3Z"/><circle cx="12" cy="13" r="4"/>',
        "shop": '<path d="M4 10v11h16V10M3 10l2-7h14l2 7ZM9 21v-7h6v7"/>',
        "grid": '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
        "user": '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
        "back": '<path d="m15 4-8 8 8 8"/>',
        "plus": '<path d="M12 4v16M4 12h16"/>',
        "search": '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
        "heart": '<path d="M12 21 3 12a5.5 5.5 0 0 1 9-7 5.5 5.5 0 0 1 9 7Z"/>',
        "chev": '<path d="m9 5 7 7-7 7"/>',
    }
    return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">%s</svg>' % shapes[name]


def link(label, target=None, kind="secondary"):
    if target:
        return '<a class="btn %s" href="%s.html">%s</a>' % (kind, target, label)
    return '<button class="btn %s" type="button" data-demo>%s</button>' % (kind, label)


def photo(name, alt="虚构示例商品"):
    return '<img src="%s/%s" alt="%s">' % (ASSETS, name, alt)


def tag(label, tone="neutral"):
    return '<span class="tag %s">%s</span>' % (tone, label)


def tabs(active):
    items = [("field", "shop", "商户", "01-field-today"),
             ("library", "grid", "商品", "05-library-list")]
    return '<nav class="tabbar" aria-label="主导航">' + "".join(
        '<a class="tab %s" href="%s.html">%s<span>%s</span></a>' %
        ("on" if key == active else "", href, icon(ic), label)
        for key, ic, label, href in items) + '</nav>'


def header(title, back=None):
    b = '<a class="back" aria-label="返回" href="%s.html">%s</a>' % (back, icon("back")) if back else '<span class="back spacer"></span>'
    return '<header class="navbar">%s<h1>%s</h1><span class="capsule" aria-hidden="true"><span class="capsule-dots">•••</span><span class="capsule-sep"></span><span class="capsule-ring"></span></span></header>' % (b, title)


def page(title, body, active="library", footer="", back=None):
    css = open(os.path.join(BASE, "mock.css"), encoding="utf-8").read()
    is_main = back is None and active in ("field", "library")
    if is_main:
        body = '<div class="settings-entry">'+link("设置", "me")+'</div>' + body
    return '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>货记 · %s · 设计示意</title>
<style>%s</style></head><body><main class="screen">
<aside class="demo">静态示意 · 不连接业务 · 数据虚构</aside>
<div class="statusbar" aria-hidden="true"><b>9:41</b><span>▮▮▮　▰</span></div>
%s<div class="content">%s</div>%s%s<div class="homebar"></div>
</main><div class="toast" role="status" hidden></div>
<script>document.querySelectorAll('[data-demo]').forEach(el=>el.addEventListener('click',()=>{const t=document.querySelector('.toast');t.textContent='静态示意：不会保存或分享数据，不代表小程序验收';t.hidden=false;setTimeout(()=>t.hidden=true,2500);}));</script>
</body></html>''' % (title, css, header(title, back), body,
                    '<footer class="actions">'+footer+'</footer>' if footer else "", tabs(active) if is_main else "")


def product(name, image, price, no, detail, status=""):
    return '''<article class="product"><a class="product-photo" href="04-field-capture.html">%s</a>
<a class="product-info" href="04-field-capture.html"><h3>%s</h3><p>货号 %s</p><p>%s</p><div class="product-meta"><b class="price">%s</b>%s</div></a>
<button class="favorite" type="button" data-demo aria-label="收藏%s">%s</button></article>''' % (
        photo(image, name), name, no, detail, price, status, name, icon("heart"))


def field_today():
    rows = ""
    for name, count, image, sub in [
        ("示例百货甲", 4, "cup-a.jpg", "虚构摊位 A-01 · 15:02"),
        ("示例文具乙", 5, "pens.png", "虚构摊位 B-02 · 14:31"),
        ("示例家居丙", 3, "basket.jpg", "虚构摊位 C-03 · 13:50"),
    ]:
        rows += '<article class="visit">%s<a href="03-merchant-profile.html"><h3>%s</h3><p>%s</p><span>%s 件商品记录</span></a><a class="camera-btn" href="04-field-capture.html" aria-label="记录%s商品">%s</a></article>' % (
            photo(image), name, sub, count, name, icon("camera"))
    body = '<section class="intro"><div class="row"><h2>10月24日 周六</h2>'+tag("今天")+'</div><p>3 家商户 · 12 件商品</p></section>'
    body += '<div class="notice warn"><span>有 1 条本机未保存修改</span><a href="04-field-capture.html">继续填写 ›</a></div>'
    body += '<div class="section-title"><h2>今天去过的商户</h2><button data-demo>换日期</button></div><section class="visits">'+rows+'</section><p class="help">从商户进入记录，保存并继续沿用这家店。</p>'
    return page("商户", body, "field", link(icon("plus")+"选择或新增商户", "02-shop-entry", "primary"))


def shop_entry():
    body = '<section class="intro"><h2>选择商户</h2><p>复用商户页已有商户或新增弹层，不建商户档案。</p></section>'
    body += '<div class="section-title"><h2>已有商户</h2></div><a class="merchant-match" href="04-field-capture.html">'+photo("cup-a.jpg")+'<div><h3>示例百货甲</h3><p>虚构摊位 A-01</p><p>上次记录 10月19日 · 4 件</p></div>'+icon("chev")+'</a>'
    body += '<section class="section"><h2>新增商户</h2><label class="field block"><span>名称 / 摊位标识 · 必填</span><input placeholder="例如：示例百货甲 A-01"></label><label class="field block"><span>市场 / 位置 · 选填</span><input placeholder="保留现场写法"></label><label class="field block"><span>联系方式 · 选填</span><input placeholder="可稍后补充"></label><p class="help">名称/摊位沿用一个输入，不自动改写历史商户。</p></section>'
    return page("选择商户", body, "field", link("新增并记录", "04-field-capture", "primary"), "01-field-today")


def merchant_profile():
    body = '<section class="intro"><h2>示例百货甲</h2><p>虚构摊位 A-01 · 联系方式已存</p><div class="row gap">'+tag("10月19日—24日")+tag("4 件记录")+'</div></section><div class="section-title"><h2>这家店的商品</h2><button data-demo>日期范围</button></div>'
    body += product("陶瓷杯 350ml", "cup-a.jpg", "¥6.80", "DEMO-A01", "每箱 48 件 · 0.060 m³", tag("已核对", "ok"))
    body += product("粗陶咖啡杯", "cup-b.jpg", "¥8.50", "DEMO-A02", "每箱 36 件 · 0.059 m³")
    body += product("条纹陶瓷碗", "bowl.png", "价格未填", "DEMO-A03", "包装待补", tag("缺价格", "warn"))
    body += '<p class="help">显示前 3 件，共 4 件；同商户跨日查看，同货号记录不自动合并。</p>'
    return page("商户商品", body, "field", link("导出这家店", "08-export-picker")+link(icon("camera")+"继续记录", "04-field-capture", "primary"), "01-field-today")


def field_capture():
    body = '<div class="context"><span>当前商户</span><b>示例百货甲</b></div><section class="section photo-section"><div class="photos">'
    body += photo("cup-a.jpg", "陶瓷杯全景")+photo("glaze.jpg", "陶瓷杯细节")+'<button class="add-photo" data-demo aria-label="打开系统相机">'+icon("camera")+'<span>拍照</span></button></div><div class="photo-tools">'+link("从相册补图")+link("调整照片")+'</div></section>'
    body += '<section class="section"><label class="field block"><span>现场描述</span><textarea rows="2">陶瓷杯，350ml，6.8元一个，每箱48个。</textarea></label><div class="row"><p class="help">保留原话，未知不猜。</p>'+link("AI 整理")+'</div></section>'
    body += '<section class="section"><label class="field"><span>名称</span><input value="陶瓷杯 350ml" placeholder="可稍后补"></label><div class="form-grid"><label class="field block"><span>单价 · CNY</span><input value="6.80" inputmode="decimal"></label><label class="field block"><span>货号</span><input value="DEMO-A01"></label></div><label class="field"><span>颜色</span><input value="米白色"></label><label class="field block"><span>商品说明 / 表格备注</span><textarea rows="2" placeholder="会带入商品表的备注列"></textarea></label>'
    body += '<details><summary>规格与包装 <span>按需展开，记住偏好</span></summary><div class="form-grid"><label class="field block"><span>每箱数量</span><input value="48" inputmode="numeric"></label><label class="field block"><span>起订量 · 件</span><input placeholder="未知留空" inputmode="numeric"></label></div><div class="form-grid"><label class="field block"><span>箱数 · 选填</span><input placeholder="未知留空" inputmode="numeric"></label><label class="field block"><span>记录数量 · 件</span><input placeholder="未填则按箱数计算" inputmode="numeric"></label></div><label class="field block"><span>外箱尺寸 · 含单位</span><input value="50 × 40 × 30 cm"></label><label class="field block"><span>单箱体积 · m³</span><input value="0.060" inputmode="decimal"></label><label class="field block"><span>条码 · 选填</span><input placeholder="保留原始条码，包括前导零"></label><p class="help">未知不猜；手填数量优先，MOQ 不作为记录数量。</p></details><p class="help">有名称、货号、照片或描述之一即可记录，缺价格与包装不拦保存。</p></section>'
    return page("记录商品", body, "field", link("保存返回")+link("保存并继续", None, "primary"), "03-merchant-profile")


def library_list():
    body = '<section class="filters"><div class="row"><button class="filter" data-demo>10月19日—24日</button><button class="filter" data-demo>全部商户</button></div><label class="search">'+icon("search")+'<input aria-label="搜索商品" placeholder="在当前日期/商户范围内搜索"></label><div class="row"><button class="filter active" data-demo>全部</button><button class="filter" data-demo>待核对</button><button class="filter" data-demo>已核对</button><button class="filter" data-demo>缺价格</button></div></section>'
    body += '<div class="section-title"><h2>商品记录 · 共 12 件</h2><button data-demo>紧凑 / 大图</button></div>'
    body += product("陶瓷杯 350ml", "cup-a.jpg", "¥6.80", "DEMO-A01", "百货甲 · 每箱 48 件", tag("已核对", "ok"))
    body += product("粗陶咖啡杯", "cup-b.jpg", "¥8.50", "DEMO-A02", "百货甲 · 每箱 36 件")
    body += product("彩色中性笔", "pens.png", "¥1.20", "DEMO-B01", "文具乙 · 每箱数待补", tag("待核对"))
    body += product("方格便签本", "sticky.png", "¥2.80", "DEMO-B02", "文具乙 · 每箱 120 件")
    body += product("编织收纳篮", "basket.jpg", "价格未填", "DEMO-C01", "家居丙 · 包装待补", tag("缺价格", "warn"))
    body += product("帆布手提袋", "tote.png", "¥7.20", "DEMO-C02", "家居丙 · 每箱 80 件")
    body += '<p class="help">点商品补资料，返回保留位置。本图为紧凑状态；首次默认保留大图。</p>'
    return page("商品", body, footer=link("比较", "07-compare")+link("导出 Excel", "08-export-picker", "primary"))


def review_queue():
    body = '<section class="intro"><div class="row"><h2>补充当前商品</h2>'+tag("待核对")+'</div><p>示例文具乙 · 记录日 10月24日</p></section><section class="review-photo">'+photo("pens.png", "彩色中性笔")+'</section>'
    body += '<section class="section"><label class="field"><span>名称</span><input value="彩色中性笔"></label><div class="form-grid"><label class="field block"><span>单价 · CNY</span><input value="1.20" inputmode="decimal"></label><label class="field block"><span>货号</span><input value="DEMO-B01"></label></div><details open><summary>规格与包装</summary><label class="field"><span>每箱数量</span><input placeholder="待询问，未知留空"></label><label class="field"><span>单箱体积</span><input placeholder="未知留空"></label></details><div class="row"><p class="help">需要时 AI 只补明确空值。</p>'+link("AI 整理")+'</div><p class="help">复用现有编辑页；保存后返回原列表位置，不另建整理队列。缺项不阻断。</p><div class="row"><span class="help">资料已核对 · 不代表购买</span>'+link("标记已核对")+'</div></section>'
    return page("补充资料", body, footer=link("返回")+link("保存修改", None, "primary"), back="05-library-list")


def compare():
    body = '<section class="intro"><h2>已选 2 件商品</h2><p>浅蓝标出不同项。</p></section><section class="compare-grid"><div>'+photo("cup-a.jpg", "陶瓷杯甲")+'<h3>陶瓷杯 350ml</h3><p>示例百货甲</p></div><div>'+photo("cup-b.jpg", "陶瓷杯乙")+'<h3>粗陶杯 220ml</h3><p>示例百货甲</p></div></section>'
    body += '<section class="compare-table"><div class="compare-row labels"><span>项目</span><b>记录甲</b><b>记录乙</b></div><div class="compare-row different"><span>单价 / 元·件</span><b>6.80</b><b>8.50</b></div><div class="compare-row different"><span>每箱数量</span><b>48</b><b>36</b></div><div class="compare-row different"><span>容量 / ml</span><b>350</b><b>220</b></div><div class="compare-row"><span>币种</span><b>CNY</b><b>CNY</b></div><div class="compare-row"><span>起订量</span><b>未知</b><b>未知</b></div></section><p class="help">浅蓝标记不同项；规格不同不自动判定哪件更划算。</p>'
    return page("比较商品", body, footer=link("换比较对象")+link("返回商品", "05-library-list", "primary"), back="05-library-list")


def export_picker():
    body = '<section class="section"><div class="row"><h2>商品表</h2>'+tag("参考 Excel 格式")+'</div><div class="seg"><button data-demo>单日</button><button class="active" data-demo>日期范围</button></div><label class="field block"><span>起止日期</span><input value="2026-10-19 — 2026-10-24" aria-label="导出日期范围"></label>'
    body += '<div class="setting"><span>商户</span><button data-demo>全部 3 家 ›</button></div><div class="setting"><span>记录</span><button data-demo>全部已保存 · 12 件 ›</button></div><div class="setting"><span>照片</span><button data-demo>带图 · 每件全部照片 ›</button></div><p class="help">本机草稿、回收站记录不在文件中。搜索/待核对/缺价格筛选不带入 Excel，实际件数以本页为准。</p></section>'
    body += '<div class="notice warn"><span>1 件缺价格、2 件缺体积；仍可导出，相关完整合计留空。</span></div><section class="section"><div class="row"><h2>版式预览 · 百货甲</h2><button data-demo>Excel 格式</button></div><div class="paper"><div class="paper-title"><b>示例公司 · 商品资料表</b><span>10月19日—24日</span></div>'
    body += '<table><thead><tr><th>货号 / 图片</th><th>箱数</th><th>每箱</th><th>单价</th><th>金额</th></tr></thead><tbody><tr><td>DEMO-A01'+photo("cup-a.jpg", "杯子预览")+'</td><td>10</td><td>48</td><td>6.80</td><td>3264.00</td></tr><tr><td>DEMO-A02'+photo("cup-b.jpg", "咖啡杯预览")+'</td><td>5</td><td>36</td><td>8.50</td><td>1530.00</td></tr></tbody></table><p class="paper-total">示例小计 · 15 箱 · CNY 4794.00</p><p class="paper-note">只展示 2 条与部分列的缩略图。实际带图商品表保留参考 A:K 十一列。</p></div><details><summary>参考十一列与模板原文</summary><p class="help">货号、箱数、每箱数量、数量、价格、金额、备注、图片、单箱体积、总体积、条码。</p><p class="help">公司表头/付款条款/唛头/包装要求沿用已保存模板原文；本例未设置。</p></details><p class="help">生成后显示打开/分享与生成时间；同条件返回复用文件，需要最新记录时重新生成。</p></section>'
    return page("导出 Excel", body, footer=link("生成 Excel", None, "primary"), back="05-library-list")


def me():
    body = '<section class="intro"><h2>采购员 · 示例账号</h2><p>自己的商品、偏好和格式设置</p></section><section class="menu">'
    body += ''.join('<button data-demo>%s<span>›</span></button>' % s for s in ["个人资料", "收藏", "本机草稿", "Excel 格式", "使用帮助"])
    return page("设置", body+'</section><p class="help">从商户 / 商品右上角进入，返回原页面。设置不是第三个 tab，不增加采购管理入口。</p>', active=None, back="05-library-list")


SCREENS = {
    "01-field-today": field_today,
    "02-shop-entry": shop_entry,
    "03-merchant-profile": merchant_profile,
    "04-field-capture": field_capture,
    "05-library-list": library_list,
    "06-review-queue": review_queue,
    "07-compare": compare,
    "08-export-picker": export_picker,
    "me": me,
}
LABELS = ["商户 · 今天", "选择商户（弹层）", "商户商品", "记录商品", "商品列表", "补充资料（复用编辑页）", "比较商品", "导出 Excel"]


def main():
    with open(os.path.join(BASE, "style_v12.css"), encoding="utf-8") as source:
        css = source.read()
    with open(os.path.join(BASE, "mock.css"), "w", encoding="utf-8") as output:
        output.write(css)
    for name, render in SCREENS.items():
        with open(os.path.join(BASE, name+".html"), "w", encoding="utf-8") as f:
            f.write(render())
        print("wrote", name+".html")
    cards = "".join('<a class="gallery-card" href="%s.html"><img src="shots/%s.png" alt="%s界面示意"><b>%s</b></a>' %
                    (name, name, escape(label), label) for name, label in zip(list(SCREENS)[:8], LABELS))
    html = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>货记 · 商品记录与整理设计</title><style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#f5f7f5;color:#1f2a24;font:14px/1.6 sans-serif}h1{font-size:24px;margin:0}p{max-width:780px}a{color:#263b32}nav{margin:16px 0}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:20px;max-width:1200px}.gallery-card{display:block;padding:12px;background:#fff;border:1px solid #e3e9e5;border-radius:8px;text-decoration:none}.gallery-card img{width:100%;height:auto;display:block;margin-bottom:8px}.gallery-card b{font-size:16px}</style></head><body>
<h1>货记 · 商品记录与整理</h1><p>正式方案 v1.3：选商户 → 记录商品 → 商品列表复看/比较 → 导出商品 Excel。商户 / 商品两个 tab，右上角进入普通设置页，不增加下单流程或整理队列。八张图为现有页面/弹层的状态，不新增八条路由。第一批代码已本地实施；本演示仍是静态图，数据虚构，不保存数据，不代表微信功能验收。</p>
<nav><a href="../SOLUTION.md">正式方案 v1.3</a> · <a href="../REPORT.md">评审证据</a> · <a href="../INDUSTRY.md">行业背景与边界</a> · <a href="../design.json">设计规格 v1.3</a> · <a href="me.html">设置示意</a> · <a href="c1-field.html">商户对照</a> · <a href="c2-library.html">商品对照</a> · <a href="c3-capture-export.html">录入/导出对照</a></nav><div class="gallery">GALLERY_CONTENT</div></body></html>'''.replace("GALLERY_CONTENT", cards)
    with open(os.path.join(BASE, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print("wrote index.html")


if __name__ == "__main__":
    main()
