# gift-for-huoyu

给 Vtuber **火羽ひのめ**（B站 UID 2094031249）的静态纪念站：把她在 B 站 6 年的
2165 条公开动态做成可以拨的「月牌轮盘」，配统计、图集、影像与全文检索。

纯静态，无后端、无数据库。`site/` 是可以直接托管的全部内容。

在线预览：**https://longhaoaslwx.github.io/gift-for-huoyu/**

## 目录

```
site/                     静态站点（代码 + 数据 + 图片），直接托管这个目录即可
  index.html              六个视图：动态环 / 统计 / 图集 / 影像 / 录制舞台 / 全文
  assets/app.js           交互（轮盘拨转、信笺、灯箱、检索）
  assets/style.css        全部样式
  assets/data/            posts.json（2165 条动态）· meta.json · guards.json
  assets/images/media/    动态附图（480w 列表 / 1080w 灯箱，414 张）

data/                     全量基线数据（每日更新的起点，不入库的其余部分见 .gitignore）
  bilibili/2094031249/dynamics/all.json       2165 条全量动态
  bilibili/2094031249/raw/detail_cache.json   详情缓存（历史动态的 id 兜底来源）

bili_dynamic_crawler.py   采集：B站动态清单 + 逐条详情，WBI 签名、限速、断点续跑
translate_dynamics.py     翻译：ja→zh 机翻 + 术语占位符 + 正则矫正（只补缺失）
build_site_data.py        构建：原始数据 → site/assets/data/（含媒体拷贝与去重）
apply_fixes.py            回写人工确认过的译文（translation/fixes.json）
mark_ai_translations.py   给 AI 译文打统一标注，产出 translation/ai_notice.json
sync_translations.py      全刷后对比新旧 all.json，定向重译正文有变化的条目
fetch_media_thumbs.py     抓取新增动态配图（480w/1080w 两档 WebP，只补缺失）
fetch_covers.py           抓取新增视频封面缩略图（只补缺失）

translation/
  ja2zh.json              译文库 {动态ID: 中文}（AI 机翻，见下方免责说明）
  fixes.json              人工确认的译文修正表 —— 本项目唯一的「人工真值」
  ai_notice.json          AI 翻译标注总清单（范围 / 数量 / 位置 / 检索方式）

.github/workflows/
  daily-update.yml        北京时间每天 0:30 自动抓新数据 → 补译 → 重建 → 提交
  monthly-refresh.yml     北京时间每月 1 号 14:00 全量重抓详情，刷新历史互动数据
  deploy-pages.yml        把 site/ 发布到 GitHub Pages（根路径，不经 Jekyll）
```

## 每日更新

`.github/workflows/daily-update.yml` 在 UTC 16:30（= 北京时间 0:30）跑一次：

1. `bili_dynamic_crawler.py` 抓最新动态——**全量基线数据已随仓库提交**
   （`data/bilibili/2094031249/dynamics/all.json` + `raw/detail_cache.json`），
   只抓新增条目；B 站列表接口对境外 IP 只放行近期约 600 条，历史部分由基线
   与构建阶段的存量合并保住，数据只增不减；
2. `translate_dynamics.py` 只补新增条目的译文，`apply_fixes.py` 盖回人工修正；
3. `fetch_media_thumbs.py` / `fetch_covers.py` 补齐新增配图与视频封面；
4. `build_site_data.py` 重建 `site/assets/data/`，`mark_ai_translations.py` 同步标注统计；
5. 有变化才提交（提交者 `github-actions[bot]`），基线数据增量一并入库。

也可在 Actions 页手动 `Run workflow` 立刻补一次。

## 互动数据的刷新机制

两类数据更新频率不同，机制也不同：

- **新动态 + 近期约 600 条的点赞**：每日更新自动搞定。列表接口每次都会
  重新拉取并带回最新点赞，`build_records` 优先用它刷新缓存旧值，
  所以点赞榜、月度/年度点赞曲线每天自动变。
- **历史条目的点赞/评论/转发**：列表接口不返回这些字段，只有重抓全部
  详情才能刷新。由 `monthly-refresh.yml` 在**北京时间每月 1 号 14:00**
  自动全刷一次（约 1.5 小时，pace 2.0 降低风控概率）；想立刻刷就进
  Actions → 「每日更新动态数据」→ Run workflow → 勾选
  **refresh_stats** → 运行，同样全程在线上完成，不需要本地操作。
- 全刷后少数老动态的正文可能因接口返回差异而变化，
  `sync_translations.py` 会自动对比新旧数据并定向重译这些条目。

## 站点部署

Pages 源设置为 **GitHub Actions**（Settings → Pages → Source），
由 `.github/workflows/deploy-pages.yml` 把 `site/` 原样发布到根路径：

- 本地推代码到 `main` → 自动重新部署；
- 每日数据更新提交后，经 `workflow_run` 触发自动重新部署
  （机器人推送不触发 push 事件，必须这样接）；
- 也可手动 `Run workflow` 补一次。

不经 Jekyll、不复制文件，`https://longhaoaslwx.github.io/gift-for-huoyu/` 直接就是站点首页。

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
