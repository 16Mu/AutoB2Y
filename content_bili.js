// ================= 工具 =================
function getBiliBvid() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return m ? m[1] : null;
}
function getBiliPage() {
    const m = location.search.match(/[?&]p=(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
}
function getBiliTitleText() {
    const el = document.querySelector('.video-title') || document.querySelector('h1') || document.querySelector('.tit');
    const t = el ? (el.textContent || '').trim() : '';
    return t || document.title;
}

function sendToBkg(msg, cb, retries) {
    if (retries === undefined) retries = 2;
    let settled = false;
    const retry = () => {
        if (settled) return;
        if (retries > 0) setTimeout(() => sendToBkg(msg, cb, retries - 1), 900);
        else { settled = true; cb(null); }
    };
    try {
        chrome.runtime.sendMessage(msg, (resp) => {
            if (chrome.runtime.lastError) { retry(); return; }
            if (resp === undefined || resp === null) { retry(); return; }
            settled = true;
            cb(resp);
        });
    } catch (e) { retry(); }
}

// ================= 跳转 + 导出按钮注入 =================
function injectBiliActions() {
    const titleEl = document.querySelector('.video-title') || document.querySelector('h1.video-title');
    if (!titleEl) return;
    if (!getBiliBvid()) return;
    // 挂在标题同级（不放进 h1 内部，避免破坏标题的省略号/换行布局）
    const host = titleEl.parentElement || titleEl;

    let wrap = document.getElementById('b2y-bili-actions');
    if (!wrap || !wrap.isConnected || wrap.parentElement !== host) {
        wrap?.remove();
        wrap = document.createElement('span');
        wrap.id = 'b2y-bili-actions';
        wrap.className = 'b2y-bili-actions';
        if (titleEl.nextSibling) host.insertBefore(wrap, titleEl.nextSibling);
        else host.appendChild(wrap);
    }
    if (wrap.childElementCount === 0) buildActionButtons(wrap);
}

function buildActionButtons(wrap) {
    // —— 跳转 YouTube（直达具体视频，无 emoji、低干扰样式）——
    const jump = document.createElement('a');
    jump.id = 'b2y-to-yt-btn';
    jump.className = 'b2y-jump';
    jump.href = '#';
    const IDLE_TEXT = 'YouTube';
    jump.textContent = IDLE_TEXT;
    jump.title = '跳转到该视频的 YouTube 原片（找不到则搜索）';
    jump.onclick = (e) => {
        e.preventDefault();
        if (jump.classList.contains('b2y-busy')) return;
        const bvid = getBiliBvid();
        if (!bvid) return;
        jump.textContent = '查找中…';
        jump.classList.add('b2y-busy');
        sendToBkg({ action: 'findYoutube', bvid: bvid }, (resp) => {
            jump.classList.remove('b2y-busy');
            jump.textContent = IDLE_TEXT;
            if (!resp) {
                // 失败：不开新页，按钮变为「点击重试」，再点一次重来（与手动导出互不影响）
                jump.textContent = '点击重试';
                flashTitleHint('匹配失败：后台无响应，点击按钮重试');
                return;
            }
            if (!resp.success) {
                jump.textContent = '点击重试';
                flashTitleHint('匹配失败：' + (resp.error || '未知错误') + '，点击按钮重试');
                return;
            }
            if (resp.mode === 'channel') flashTitleHint('已定位（频道匹配）');
            else if (resp.mode === 'search') flashTitleHint('已定位（全站匹配）');
            else flashTitleHint('未定位到具体视频，已打开搜索页');
            window.open(resp.url, '_blank');
        });
    };

    // —— 导出字幕 ——
    const exp = document.createElement('a');
    exp.id = 'b2y-export-btn';
    exp.className = 'b2y-jump';
    exp.href = '#';
    exp.textContent = '导出字幕';
    exp.title = '把当前视频弹幕导出为字幕文件（剪映可导入 SRT）';
    exp.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleExportMenu(exp);
    };

    wrap.appendChild(jump);
    wrap.appendChild(exp);

    const hint = document.createElement('span');
    hint.id = 'b2y-bili-hint';
    hint.className = 'b2y-bili-hint';
    wrap.appendChild(hint);
}

let exportMenuEl = null;
function closeExportMenu() {
    if (exportMenuEl) { exportMenuEl.remove(); exportMenuEl = null; }
    document.removeEventListener('click', onDocClickCloseMenu, true);
}

function toggleExportMenu(anchor) {
    if (exportMenuEl) { closeExportMenu(); return; }
    const bvid = getBiliBvid();
    if (!bvid) return;

    exportMenuEl = document.createElement('div');
    exportMenuEl.className = 'b2y-menu';
    const holder = document.getElementById('b2y-bili-actions') || anchor.parentElement;
    const formats = [
        ['srt', 'SRT（剪映 / PR）'],
        ['vtt', 'VTT（Web 字幕）'],
        ['ass', 'ASS（保留弹幕颜色）'],
        ['xml', 'XML（B站原始弹幕）']
    ];
    formats.forEach(([fmt, label]) => {
        const item = document.createElement('div');
        item.className = 'b2y-menu-item';
        item.textContent = label;
        item.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeExportMenu();
            doExport(fmt, bvid);
        };
        exportMenuEl.appendChild(item);
    });
    holder.appendChild(exportMenuEl);
    setTimeout(() => document.addEventListener('click', onDocClickCloseMenu, true), 0);
}

function onDocClickCloseMenu(e) {
    const wrap = document.getElementById('b2y-bili-actions');
    if (!wrap || !wrap.contains(e.target)) closeExportMenu();
}

function doExport(fmt, bvid) {
    sendToBkg({ action: 'manualMatch', bvid: bvid, page: getBiliPage() }, (resp) => {
        if (!resp || !resp.success) {
            flashTitleHint('弹幕获取失败：' + (resp ? resp.error : '网络错误') + '，点击「导出字幕」重试');
            return;
        }
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(resp.xmlStr, 'text/xml');
        const list = [];
        xmlDoc.querySelectorAll('d').forEach(d => {
            const p = d.getAttribute('p');
            if (!p) return;
            const parts = p.split(',');
            list.push({
                time: parseFloat(parts[0]),
                text: d.textContent,
                color: '#' + parseInt(parts[3]).toString(16).padStart(6, '0')
            });
        });
        const base = (resp.bilibiliTitle || bvid) + (getBiliPage() > 1 ? `_P${getBiliPage()}` : '');

        if (fmt === 'xml') {
            B2YExport.exportComments(list, { format: 'xml', xmlStr: resp.xmlStr, filename: base });
            return;
        }
        if (list.length === 0) { flashTitleHint('该视频暂无弹幕'); return; }
        list.sort((a, b) => a.time - b.time);
        const duration = resp.duration || (list[list.length - 1].time + 5);
        B2YExport.exportComments(list, { format: fmt, duration: duration, cueSec: 3, filename: base });
    });
}

let hintTimer = null;
function flashTitleHint(text) {
    const el = document.getElementById('b2y-bili-hint');
    if (el) el.textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { const e = document.getElementById('b2y-bili-hint'); if (e) e.textContent = ''; }, 4000);
}

// ================= 轮询注入（兼容 B站 SPA 路由） =================
setInterval(injectBiliActions, 1000);
injectBiliActions();
