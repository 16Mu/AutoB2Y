# 更新日志 / Changelog

本项目遵循语义化版本号的补丁位递增：`v0.1.2` → `v0.1.3` → `v0.1.4`（每次 +0.0.1）。

---

## v0.1.4 (2026-10-04)

### 🔧 修复

- **商店语言识别**：`manifest.json` 的 `name` / `description` 由硬编码字符串改为 i18n 占位符 `__MSG_extensionName__` / `__MSG_extensionDescription__`，新增 `default_locale: zh_CN` 与 `_locales/zh_CN`、`_locales/en` 两份 `messages.json`。此前 Partner Center 因缺少语言消息引用而识别不出语言代号，商店一览只显示英语；按 Microsoft 官方文档修复后可被识别为「English (United States) + 中文(简体)」。
- 打包脚本 `build.py` 同步把 `_locales/` 目录打进扩展包。

### English

**v0.1.4** — Fixed store language detection: replaced the hardcoded manifest `name` / `description` with i18n placeholders (`__MSG_extensionName__` / `__MSG_extensionDescription__`), added `default_locale` and `_locales/{zh_CN,en}/messages.json`. Without these message references Partner Center could not detect the locale codes and the Store Listings tab only showed English (per the official Microsoft docs). The packaging script now includes `_locales/` in the zip.

---

## v0.1.3 (2026-10-04)

对比 GitHub 上的第一版 `v0.1.2`（manifest `0.1`）。

### 🆕 新增

- **三标签面板**：控制面板重构为「弹幕 / 导出 / 屏蔽词」三标签二级窗口，一屏只显示当前需要的内容，不再把所有控件堆在一起。
- **弹幕导出字幕**（新增 `export_subs.js`）：YouTube 面板与 B站 视频页均可一键把弹幕导出为 **SRT / VTT / ASS / XML**，可直接导入剪映、Premiere、达芬奇（ASS 保留弹幕原色）。
- **B站 直达 YouTube 原片**（新增 `yt_core.js`、`channel-associations.json`）：按「YouTube 频道 ↔ B站UP」关联库定向到该 UP 的频道内按标题+时长选片，直开具体视频；查不到时解析站内搜索结果，最后才退回搜索页。
- **网络容错重试**：B站 搜索 / 分P / 弹幕接口全部带超时 + 指数退避重试，风控响应 (-412) 与网络抖动不再直接导致失败。
- **SPA 路由免刷新**：监听 YouTube / B站 前端路由事件，切换视频后自动重新匹配、自动重建弹幕层。
- **失败一键重试**：匹配失败点「重新自动匹配」（旁边保留手动填 BV）；跳转失败按钮变「点击重试」；导出失败可再次点击——每个失败态都有重试入口。
- **区域实时预览**：拖动「弹幕占比」滑块时，播放器上实时叠加半透明粉色色带与百分比标签（B站弹幕区），松手 1.2 秒自动淡出。
- **统一弹幕颜色**：胶囊开关一键把全部弹幕改成同一颜色，开关与色块联动（关闭时色块置灰禁用，开启后点色块选色）。
- **匹配状态自愈**：匹配请求 12 秒无响应自动接管重发；页面卡在「等待中」超过 18 秒自动重启匹配（最多 3 次）；过期响应直接丢弃，不再出现旧请求覆盖新状态。
- **面板自动退出**：鼠标离开面板 4 秒后自动收起；播放器控制条自动隐藏时面板同步关闭（鼠标悬停在面板上不误关）。

### ✏️ 变更

- **状态徽章只在查找/出错时显示**：匹配成功后徽章自动隐藏，不再常驻标题栏；成功提示带弹幕条数，例如「已连接 (BV... · N 条)」。
- **面板 UI 现代化**：胶囊开关、色块选择器、标签页切换、行内关系提示；「弹」按钮文字在控制栏内居中。
- **manifest**：`version` 提升；`host_permissions` 增加 `www.youtube.com` 与 `raw.githubusercontent.com`；内容脚本匹配从 `watch*` 放宽到 YouTube / B站 全站页面并统一 `run_at: document_idle`；B站 页同样注入样式。
- **README 与截图**：全部重写为三标签新界面的说明，`images/` 更新为新版 UI 截图（效果展示 / 控制面板 / 导出 / 屏蔽词）。

### 🔧 修复

- 0 条弹幕时不再误报「已连接」。
- 匹配成功后徽章残留、旧请求覆盖新状态、页面卡死在「等待中」等问题由上述自愈机制修复。
- 弹幕引擎 `danmaku.min.js` 本地补丁：为单条弹幕增加可选的 `style.backgroundColor` 底色块（唯一改动，其余与上游一致）。

### English

**v0.1.3** — rebuilt the panel into a three-tab layout (Danmaku / Export / Blocklist); added danmaku subtitle export (SRT / VTT / ASS / XML) on both YouTube and Bilibili; added one-click jump from Bilibili to the exact YouTube source via the channel-association DB with search fallback; added network retries with timeout + exponential backoff (including -412 risk-control recovery); added SPA route reloading without page refresh; added one-click retry on every failure state; added live region preview (pink band); added a unified-danmaku-color capsule toggle; added match self-healing (12s takeover, 18s restart up to 3×, stale-response drop) and a transient status badge that hides after a successful match; panel auto-dismisses on 4s mouse-leave or when the player control bar hides. Manifest gains `www.youtube.com` + `raw.githubusercontent.com` host permissions; README and screenshots fully refreshed.
