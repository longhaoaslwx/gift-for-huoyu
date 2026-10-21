# gift-for-huoyu

给 Vtuber **火羽ひのめ**（B站 UID 2094031249）的静态纪念站：把她在 B 站 6 年的
2165 条公开动态做成可以拨的「月牌轮盘」，配统计、图集、影像与全文检索。

纯静态，无后端、无数据库。`site/` 是可以直接托管的全部内容。

## 目录

```
site/                     静态站点（代码 + 数据 + 图片），直接托管这个目录即可
  index.html              六个视图：动态环 / 统计 / 图集 / 影像 / 录制舞台 / 全文
  assets/app.js           交互（轮盘拨转、信笺、灯箱、检索）
  assets/style.css        全部样式
  assets/data/            posts.json（2165 条动态）· meta.json · guards.json
  assets/images/media/    动态附图（480w 列表 / 1080w 灯箱，414 张）

bili_dynamic_crawler.py   采集：B站动态清单 + 逐条详情，WBI 签名、限速、断点续跑
translate_dynamics.py     翻译：ja→zh 机翻 + 术语占位符 + 正则矫正（只补缺失）
build_site_data.py        构建：原始数据 → site/assets/data/（含媒体拷贝与去重）
apply_fixes.py            回写人工确认过的译文（translation/fixes.json）
mark_ai_translations.py   给 AI 译文打统一标注，产出 translation/ai_notice.json

translation/
  ja2zh.json              译文库 {动态ID: 中文}（AI 机翻，见下方免责说明）
  fixes.json              人工确认的译文修正表 —— 本项目唯一的「人工真值」
  ai_notice.json          AI 翻译标注总清单（范围 / 数量 / 位置 / 检索方式）

.github/workflows/
  daily-update.yml        北京时间每天 0:30 自动抓新数据 → 补译 → 重建 → 提交
```

## 每日更新

`.github/workflows/daily-update.yml` 在 UTC 16:30（= 北京时间 0:30）跑一次：

1. `bili_dynamic_crawler.py` 抓最新动态（原始缓存存在 Actions Cache，只抓增量）；
2. `translate_dynamics.py` 只补新增条目的译文，`apply_fixes.py` 盖回人工修正；
3. `build_site_data.py` 重建 `site/assets/data/` 并同步新增附图到 `media/`；
4. 有变化才提交（提交者 `github-actions[bot]`）。

也可在 Actions 页手动 `Run workflow` 立刻补一次。

## 本地复现

```bash
python bili_dynamic_crawler.py --pace 1.5   # 抓全部动态（首次较慢，支持断点续跑）
python translate_dynamics.py                # 机翻（已有译文跳过）
python apply_fixes.py                       # 回写人工修正
python build_site_data.py                   # 生成站点数据
python -m http.server 8899 --directory site # http://127.0.0.1:8899
```

只需要 Python 3.10+，无第三方依赖。

## 关于中文译文

站内 2162 条中文译文是 **AI 机器翻译**（Google ja→zh + 术语表），未经人工逐条校对，
含义可能不准确，仅作阅读辅助，请以日文原文为准。全项目统一检索标记 `AI-TRANS`：

```bash
grep -rn 'AI-TRANS' .
```

人工确认过的条目记在 `translation/fixes.json`，详见 `translation/ja2zh.README.md`。

## 数据来源

内容全部来自 B 站公开的 UP 主动态与投稿信息，仅作粉丝向纪念与展示，不商用。
