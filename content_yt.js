let currentUrl = "";
let danmakuEngine = null;
let sepDanmakuEngine = null;
let rawComments = [];
let lastXmlStr = "";
let lastBiliTitle = "";
let playerResizeObserver = null;
let matchInFlight = false;
let matchStartedAt = 0;      // 本次匹配请求发起时间（看门狗超时用）
let reqSeq = 0;              // 请求序号：过期响应直接丢弃
let rematchRequested = false; // 匹配进行中收到新请求 → 完成后补一轮
let badgeWaitSince = 0;      // 徽章进入等待态的时间（卡死自愈用）
let lastSuccessText = '';    // 最近一次成功徽章文本（超时后回滚显示）
let healCount = 0;           // 自愈重启次数上限
let autoRetryCount = 0;
let matchGen = 0;
let renderState = { main: 0, sep: 0 };

// 面板自动关闭：鼠标离开面板 / 控制条收起
let panelMouseIn = false;
let panelIdleTimer = null;

let config = {
    offset: 0,
    covMode: '100', // 25, 50, 75, 100, custom
    covCustom: 100,
    fontMode: '24', // 18, 24, 36, 48, custom
    fontCustom: 24,
    forceColor: false,
    customColor: '#ffffff',
    localBlockWords: [],
    cueSec: 3,
    ytComments: {
        enabled: false,
        mode: 'merge',       // merge = 融合 + 底色区分 | separate = 独立区域
        textColor: '#ffd54f',
        bgColor: '#000000',  // 配合 bgOpacity 使用
        bgOpacity: 0.6,
        separatePct: 30,
        maxCount: 40
    }
};

// 本地持久化加载
chrome.storage.local.get(['b2yConfig', 'b2yCloudWords'], function(result) {
    if (result.b2yConfig) {
        config = { ...config, ...result.b2yConfig };
        config.ytComments = { ...defaultsYt(), ...(result.b2yConfig.ytComments || {}) };
    }
    // 评论弹幕功能已移除：强制关闭（兼容旧配置残留）
    config.ytComments.enabled = false;

    // 一次性清理历史遗留键：旧版本把「云端屏蔽词」缓存在 b2yCloudWords 下，该功能已移除。
    if (result.b2yCloudWords !== undefined) {
        chrome.storage.local.remove('b2yCloudWords');
    }
});

function defaultsYt() {
    return {
        enabled: false,
        mode: 'merge',
        textColor: '#ffd54f',
        bgColor: '#000000',
        bgOpacity: 0.6,
        separatePct: 30,
        maxCount: 40
    };
}

function saveConfig() {
    chrome.storage.local.set({b2yConfig: config});
    reloadDanmaku();
}

function getActualCov() {
    return parseInt(config.covMode === 'custom' ? config.covCustom : config.covMode) || 100;
}
function getActualFont() {
    return parseInt(config.fontMode === 'custom' ? config.fontCustom : config.fontMode) || 24;
}

// 带重试的消息通道（MV3 service worker 唤醒失败时自动重发）
function sendToBackground(msg, cb, retries) {
    if (retries === undefined) retries = 2;
    let settled = false;
    const retry = () => {
        if (settled) return;
        if (retries > 0) { setTimeout(() => sendToBackground(msg, cb, retries - 1), 900); }
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

// ================= UI 注入与事件 =================
function injectPlayerButton() {
    if (document.getElementById('b2y-control-btn')) return;
    let rightControls = document.querySelector('.ytp-right-controls');
    if (!rightControls) return;
    if (!document.querySelector('#movie_player')) return;

    let btn = document.createElement('button');
    btn.id = 'b2y-control-btn';
    btn.className = 'ytp-button';
    btn.title = 'B站弹幕设置';
    btn.innerHTML = `<span class="b2y-btn-label" aria-hidden="true">弹</span>`;
    rightControls.insertBefore(btn, rightControls.firstChild);

    let panel = document.createElement('div');
    panel.id = 'b2y-settings-panel';
    panel.style.display = 'none';

    panel.innerHTML = `
        <div class="b2y-header">
            <span class="b2y-header-title"><svg class="b2y-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="7.5" width="19" height="12.5" rx="2.5"></rect><path d="M8.2 3.2 12 7.2l3.8-4"></path></svg>弹幕控制中心</span>
            <span id="b2y-status-badge" class="badge-wait" style="display:none;">等待中</span>
        </div>

        <div class="b2y-tabs">
            <button class="b2y-tab active" data-tab="dm">弹幕</button>
            <button class="b2y-tab" data-tab="exp">导出</button>
            <button class="b2y-tab" data-tab="blk">屏蔽词</button>
        </div>

        <div class="b2y-tab-body">
        <div class="b2y-tab-pane" data-pane="dm">
            <div id="b2y-rescue-box" style="display:none; margin-bottom:15px; padding:10px; background:rgba(220,53,69,0.2); border:1px solid #dc3545; border-radius:6px;">
                <div style="font-size:12px; color:#ffbaba; margin-bottom:6px;" id="b2y-rescue-msg">匹配失败，请手动矫正</div>
                <div style="display:flex; gap:6px; margin-bottom:8px;">
                    <button id="b2y-btn-retry-match" class="b2y-action-btn" style="flex:1; margin-top:0;">重新自动匹配</button>
                </div>
                <div class="b2y-stepper" style="width:100%; border-color:#dc3545;">
                    <input type="text" id="b2y-rescue-input" placeholder="输入 BV 号，分P 可加 ?p=2..." style="flex:1;">
                    <button id="b2y-rescue-btn" style="background:#dc3545; color:white; font-weight:bold;">同步</button>
                </div>
            </div>

            <div class="b2y-row" style="flex-direction: column; align-items: flex-start;">
                <div style="width: 100%; display: flex; justify-content: space-between; margin-bottom: 5px;">
                    <span>时间微调(s):</span>
                    <input type="number" id="b2y-offset-input" step="0.5" class="b2y-num-input" value="${config.offset}">
                </div>
                <input type="range" id="b2y-offset-slider" class="b2y-range" min="-30" max="30" step="0.5" value="${config.offset}">
            </div>

            <div class="b2y-row">
                <span>弹幕占比:</span>
                <select id="b2y-sel-cov" class="b2y-select">
                    <option value="25">1/4 屏幕</option>
                    <option value="50">半屏 (50%)</option>
                    <option value="75">3/4 屏幕</option>
                    <option value="100">全屏 (100%)</option>
                    <option value="custom">自定义 (滑块)...</option>
                </select>
            </div>
            <div id="b2y-cov-slider-wrap" class="b2y-slider-wrap" style="display:none;">
                <input type="range" id="b2y-sld-cov" class="b2y-range" min="10" max="100" value="${config.covCustom}">
                <span id="b2y-cov-val">${config.covCustom}%</span>
            </div>

            <div class="b2y-row">
                <span>字体大小:</span>
                <select id="b2y-sel-font" class="b2y-select">
                    <option value="18">小 (18px)</option>
                    <option value="24">中 (24px)</option>
                    <option value="36">大 (36px)</option>
                    <option value="48">特大 (48px)</option>
                    <option value="custom">自定义 (滑块)...</option>
                </select>
            </div>
            <div id="b2y-font-slider-wrap" class="b2y-slider-wrap" style="display:none;">
                <input type="range" id="b2y-sld-font" class="b2y-range" min="12" max="100" value="${config.fontCustom}">
                <span id="b2y-font-val">${config.fontCustom}px</span>
            </div>

            <div class="b2y-row" style="margin-top:15px;">
                <label class="b2y-switch" title="开启后所有弹幕统一使用右侧色块的颜色；关闭则保留 B站 原色">
                    <input type="checkbox" id="b2y-chk-color">
                    <span class="b2y-switch-track"><span class="b2y-switch-thumb"></span></span>
                    <span class="b2y-color-label">统一弹幕颜色</span>
                </label>
                <span id="b2y-color-swatch" class="b2y-color-swatch" title="弹幕的统一颜色（先打开左侧开关）">
                    <input type="color" id="b2y-color-picker" value="${config.customColor}" class="b2y-color-input">
                </span>
            </div>
            <div class="b2y-sub-hint">开关 = 是否统一；色块 = 统一后的弹幕颜色（关闭时色块置灰不可选）</div>

            <div style="text-align:center; margin-top:12px;">
                <a href="#" id="b2y-btn-show-rescue" style="font-size:12px; color:#aaa; text-decoration:underline;">自动匹配错了？点此手动输入</a>
            </div>
        </div>

        <div class="b2y-tab-pane" data-pane="exp" style="display:none;">
            <div class="b2y-export-row" style="margin-top:4px;">
                <button class="b2y-mini-btn" data-fmt="srt" title="SRT，剪映/PR 可直接导入">SRT</button>
                <button class="b2y-mini-btn" data-fmt="vtt" title="WebVTT">VTT</button>
                <button class="b2y-mini-btn" data-fmt="ass" title="ASS，保留弹幕颜色">ASS</button>
                <button class="b2y-mini-btn" data-fmt="xml" title="B站原始弹幕 XML">XML</button>
            </div>
            <div id="b2y-export-hint" style="font-size:11px; color:#888; margin-top:8px;">暂无弹幕</div>
            <div style="font-size:11px; color:#666; margin-top:8px; line-height:1.6;">SRT 可直接拖入剪映字幕轨道；XML 为 B站原始弹幕，兼容各类工具二次解析。</div>
        </div>

        <div class="b2y-tab-pane" data-pane="blk" style="display:none;">
            <div class="b2y-row" style="margin-bottom:8px;">
                <span>已屏蔽 <span id="b2y-bw-count">0</span> 个</span>
            </div>
            <div class="b2y-stepper" style="margin-bottom:10px;">
                <input type="text" id="b2y-new-block-input" placeholder="输入新屏蔽词..." style="flex:1;">
                <button id="b2y-add-block-btn" style="background:#00a1d6; color:white;">添加</button>
            </div>
            <div id="b2y-block-list-container"></div>
        </div>
        </div>
    `;
    document.querySelector('#movie_player').appendChild(panel);

    // ---- 面板开关（含自动关闭：鼠标离开 / 控制条收起） ----
    btn.onclick = () => { setPanelOpen(panel.style.display === 'none'); };

    // 鼠标在面板/按钮内 → 取消自动关闭；离开 → 倒计时关闭
    const armPanelIdleClose = () => {
        if (panelIdleTimer) clearTimeout(panelIdleTimer);
        panelIdleTimer = setTimeout(() => {
            if (panelMouseIn) return;
            setPanelOpen(false);
        }, 4000);
    };
    [panel, btn].forEach(el => {
        el.addEventListener('mouseenter', () => { panelMouseIn = true; if (panelIdleTimer) clearTimeout(panelIdleTimer); });
        el.addEventListener('mouseleave', () => { panelMouseIn = false; if (panel.style.display !== 'none') armPanelIdleClose(); });
    });

    // ---- 标签页（二级窗口）切换 ----
    panel.querySelectorAll('.b2y-tab').forEach(tab => {
        tab.onclick = () => {
            const name = tab.getAttribute('data-tab');
            panel.querySelectorAll('.b2y-tab').forEach(t => { t.classList.toggle('active', t === tab); });
            panel.querySelectorAll('.b2y-tab-pane').forEach(p => {
                p.style.display = p.getAttribute('data-pane') === name ? 'block' : 'none';
            });
            hideRegionPreview(true);
            if (name === 'blk') renderBlockList();
        };
    });

    let offInput = document.getElementById('b2y-offset-input');
    let offSlider = document.getElementById('b2y-offset-slider');
    offInput.onchange = (e) => {
        config.offset = parseFloat(e.target.value)||0;
        offSlider.value = config.offset;
        saveConfig();
    };
    offSlider.oninput = (e) => {
        config.offset = parseFloat(e.target.value);
        offInput.value = config.offset;
    };
    offSlider.onchange = (e) => { saveConfig(); };

    let selCov = document.getElementById('b2y-sel-cov');
    let sldCovWrap = document.getElementById('b2y-cov-slider-wrap');
    let sldCov = document.getElementById('b2y-sld-cov');
    let covVal = document.getElementById('b2y-cov-val');

    selCov.onchange = (e) => {
        config.covMode = e.target.value;
        sldCovWrap.style.display = config.covMode === 'custom' ? 'flex' : 'none';
        saveConfig();
        showRegionPreview();
    };
    sldCov.oninput = (e) => {
        covVal.textContent = e.target.value + '%';
        config.covCustom = e.target.value;
        showRegionPreview();
    };
    sldCov.onchange = (e) => { saveConfig(); };

    let selFont = document.getElementById('b2y-sel-font');
    let sldFontWrap = document.getElementById('b2y-font-slider-wrap');
    let sldFont = document.getElementById('b2y-sld-font');
    let fontVal = document.getElementById('b2y-font-val');

    selFont.onchange = (e) => {
        config.fontMode = e.target.value;
        sldFontWrap.style.display = config.fontMode === 'custom' ? 'flex' : 'none';
        saveConfig();
    };
    sldFont.oninput = (e) => { fontVal.textContent = e.target.value + 'px'; };
    sldFont.onchange = (e) => { config.fontCustom = e.target.value; saveConfig(); };

    let chkColor = document.getElementById('b2y-chk-color');
    let colorPicker = document.getElementById('b2y-color-picker');
    chkColor.onchange = (e) => { config.forceColor = e.target.checked; saveConfig(); applyColorRowState(); };
    colorPicker.onchange = (e) => { config.customColor = e.target.value; saveConfig(); };

    // 开关与色块的联动：关 → 色块置灰禁用（视觉上明确"由开关控制"）
    applyColorRowState();

    // ---- 导出字幕 ----
    panel.querySelectorAll('.b2y-mini-btn[data-fmt]').forEach(b => {
        b.onclick = () => exportDanmaku(b.getAttribute('data-fmt'));
    });

    // ---- 失败重试入口 ----
    document.getElementById('b2y-btn-retry-match').onclick = () => retryMatch();

    document.getElementById('b2y-add-block-btn').onclick = () => {
        let val = document.getElementById('b2y-new-block-input').value.trim();
        if(val && !config.localBlockWords.includes(val)) {
            config.localBlockWords.push(val);
            document.getElementById('b2y-new-block-input').value = '';
            saveConfig();
            renderBlockList();
        }
    };

    document.getElementById('b2y-btn-show-rescue').onclick = (e) => {
        e.preventDefault();
        document.getElementById('b2y-rescue-box').style.display = 'block';
    };
    document.getElementById('b2y-rescue-btn').onclick = () => {
        let val = document.getElementById('b2y-rescue-input').value.trim();
        if(val) forceMatch(val);
    };

    syncUIToData();
}

function setPanelOpen(open) {
    const panel = document.getElementById('b2y-settings-panel');
    if (!panel) return;
    const wasOpen = panel.style.display !== 'none';
    if (open === wasOpen) return;
    panel.style.display = open ? 'block' : 'none';
    if (open) { syncUIToData(); }
    else {
        hideRegionPreview(true);
        if (panelIdleTimer) { clearTimeout(panelIdleTimer); panelIdleTimer = null; }
    }
}

// YouTube 控制条自动收起时，同步收起面板
function autoCloseOnControlsHide() {
    const panel = document.getElementById('b2y-settings-panel');
    if (!panel || panel.style.display === 'none' || panelMouseIn) return;
    const player = document.getElementById('movie_player');
    if (!player) return;
    let hidden = player.classList.contains('ytp-autohide');
    if (!hidden) {
        const bottom = player.querySelector('.ytp-chrome-bottom');
        if (bottom) hidden = parseFloat(getComputedStyle(bottom).opacity || '1') < 0.05;
    }
    if (hidden) setPanelOpen(false);
}

// 色块跟随统一颜色开关：开启才可选，关闭则置灰
function applyColorRowState() {
    const picker = document.getElementById('b2y-color-picker');
    const swatch = document.getElementById('b2y-color-swatch');
    if (!picker || !swatch) return;
    picker.disabled = !config.forceColor;
    swatch.classList.toggle('is-off', !config.forceColor);
    swatch.title = config.forceColor ? '弹幕的统一颜色（点击选择）' : '先打开左侧「统一弹幕颜色」开关';
}

function syncUIToData() {
    if (!document.getElementById('b2y-offset-input')) return;
    document.getElementById('b2y-offset-input').value = config.offset;
    document.getElementById('b2y-offset-slider').value = config.offset;

    document.getElementById('b2y-chk-color').checked = config.forceColor;
    document.getElementById('b2y-color-picker').value = config.customColor;
    applyColorRowState();

    document.getElementById('b2y-sel-cov').value = config.covMode;
    document.getElementById('b2y-cov-slider-wrap').style.display = config.covMode === 'custom' ? 'flex' : 'none';
    document.getElementById('b2y-sld-cov').value = config.covCustom;
    document.getElementById('b2y-cov-val').textContent = config.covCustom + '%';

    document.getElementById('b2y-sel-font').value = config.fontMode;
    document.getElementById('b2y-font-slider-wrap').style.display = config.fontMode === 'custom' ? 'flex' : 'none';
    document.getElementById('b2y-sld-font').value = config.fontCustom;
    document.getElementById('b2y-font-val').textContent = config.fontCustom + 'px';

    document.getElementById('b2y-bw-count').textContent = config.localBlockWords.length;
}

function renderBlockList() {
    let container = document.getElementById('b2y-block-list-container');
    container.innerHTML = '';

    config.localBlockWords.forEach((w, idx) => {
        let tag = document.createElement('div');
        tag.className = 'b2y-tag b2y-tag-local';
        let label = document.createElement('span');
        label.textContent = w;
        tag.appendChild(label);
        let del = document.createElement('span');
        del.className = 'b2y-tag-del';
        del.textContent = '×';
        del.onclick = () => {
            config.localBlockWords.splice(idx, 1);
            saveConfig();
            renderBlockList();
        };
        tag.appendChild(del);
        container.appendChild(tag);
    });

    document.getElementById('b2y-bw-count').textContent = config.localBlockWords.length;
}

function setUIStatus(type, text) {
    let badge = document.getElementById('b2y-status-badge');
    let rescueBox = document.getElementById('b2y-rescue-box');
    let rescueMsg = document.getElementById('b2y-rescue-msg');

    if(!badge) return;
    badge.className = `badge-${type}`;
    badgeWaitSince = type === 'wait' ? Date.now() : 0;
    // 只在查找/出错时显示状态；成功完成后不再占着标题栏
    badge.style.display = type === 'success' ? 'none' : '';

    if (type === 'success') {
        badge.textContent = `已连接 (${text})`;
        rescueBox.style.display = 'none';
    } else if (type === 'fail') {
        badge.textContent = '匹配异常';
        rescueMsg.textContent = `原因: ${text}`;
        rescueBox.style.display = 'block';
    } else {
        // 弹幕已经在屏上时，等待态不再显示成"一无所有"的等待中
        const hasDm = rawComments.length > 0 && renderState.main > 0;
        badge.textContent = hasDm ? `弹幕已加载 · ${text}` : text;
        rescueBox.style.display = 'none';
    }
}

// 匹配失败后的手动重试（与手动输入 BV 互不影响）
function retryMatch() {
    matchInFlight = false;
    matchGen++;
    autoRetryCount = 0;
    rematchRequested = false;
    healCount = 0;
    const rescue = document.getElementById('b2y-rescue-box');
    if (rescue) rescue.style.display = 'none';
    startMatchWhenReady(0, matchGen);
}

// ================= 区域实时预览（弹幕占比） =================
let previewTimer = null;
function showRegionPreview() {
    const player = document.getElementById('movie_player');
    if (!player) return;
    let box = document.getElementById('b2y-region-preview');
    if (!box) {
        box = document.createElement('div');
        box.id = 'b2y-region-preview';
        box.innerHTML = '<div class="b2y-pv-band b2y-pv-main"><span></span></div>';
        player.appendChild(box);
    }
    const cov = getActualCov();
    const main = box.querySelector('.b2y-pv-main');
    main.style.height = cov + '%';
    main.querySelector('span').textContent = 'B站弹幕 ' + cov + '%';
    box.style.display = 'block';
    box.style.opacity = '1';
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => hideRegionPreview(), 1200);
}

function hideRegionPreview(now) {
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    const box = document.getElementById('b2y-region-preview');
    if (!box) return;
    if (now) { box.remove(); return; }
    box.style.opacity = '0';
    setTimeout(() => { const b = document.getElementById('b2y-region-preview'); if (b) b.remove(); }, 300);
}

// ================= 核心渲染逻辑 =================
function getVideoId() {
    const m = location.search.match(/[?&]v=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
}

function onNavigate() {
    if (location.href === currentUrl) return;
    currentUrl = location.href;
    hideRegionPreview(true);

    if (currentUrl.includes('/watch?v=')) {
        matchInFlight = false;
        autoRetryCount = 0;
        matchGen++;
        rematchRequested = false;
        healCount = 0;
        lastSuccessText = '';
        rawComments = [];
        lastXmlStr = '';
        if (danmakuEngine) { danmakuEngine.hide(); }
        if (sepDanmakuEngine) { sepDanmakuEngine.hide(); }
        setUIStatus('wait', '正在检索...');
        // 不做固定等待：轮询直到标题/时长就绪再匹配（修复跳转后不加载的问题）
        startMatchWhenReady(0, matchGen);
    } else {
        matchGen++;
        if (danmakuEngine) danmakuEngine.hide();
        if (sepDanmakuEngine) sepDanmakuEngine.hide();
    }
}

function startMatchWhenReady(attempt, gen) {
    if (gen !== matchGen) return;          // 页面已切换，废弃本轮轮询
    if (matchInFlight) {
        // 有请求在飞：未超时则登记"完成后补一轮"；超时则接管（防止永久卡死）
        if (Date.now() - matchStartedAt < 12000) { rematchRequested = true; return; }
        matchInFlight = false;
    }
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    const duration = getYoutubeDuration();
    if (!titleEl || !titleEl.textContent.trim() || !duration || duration <= 0) {
        if (attempt < 30) {           // 最多等 ~15s（每 500ms 一次）
            setTimeout(() => startMatchWhenReady(attempt + 1, gen), 500);
        } else {
            setUIStatus('fail', '页面元素加载超时，请刷新');
        }
        return;
    }
    matchInFlight = true;
    matchStartedAt = Date.now();
    setUIStatus('wait', '正在检索...');
    startAutoMatch();
}

function getYoutubeDuration() {
    let meta = document.querySelector('meta[itemprop="duration"]');
    if (meta) {
        let match = meta.getAttribute('content').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (match) return parseInt(match[1]||0)*3600 + parseInt(match[2]||0)*60 + parseInt(match[3]||0);
    }
    let video = document.querySelector('video');
    return video && isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

function startAutoMatch() {
    let titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    if(!titleEl) { matchInFlight = false; return; }
    let cleanTitle = titleEl.textContent.replace(/\[4K\]/gi, '').replace(/【.*?】/g, '').trim();
    const gen = matchGen;
    const req = ++reqSeq;
    sendToBackground({ action: 'autoMatch', keyword: cleanTitle, duration: getYoutubeDuration() },
        resp => handleMatchResponse(resp, gen, req));
}

function forceMatch(input) {
    const m = String(input).match(/(BV[0-9A-Za-z]+)/i);
    if (!m) { setUIStatus('fail', 'BV 号格式不正确'); return; }
    const p = String(input).match(/[?&]p=(\d+)/i);
    matchInFlight = true;
    matchStartedAt = Date.now();
    setUIStatus('wait', '手动拉取中...');
    const gen = matchGen;
    const req = ++reqSeq;
    sendToBackground({ action: 'manualMatch', bvid: m[1], page: p ? parseInt(p[1], 10) : 1 },
        resp => handleMatchResponse(resp, gen, req));
}

function handleMatchResponse(response, gen, req) {
    // 过期响应：页面已切换或已被新请求取代，直接丢弃（防止旧结果覆盖新状态）
    if (gen !== undefined && gen !== matchGen) return;
    if (req !== undefined && req !== reqSeq) return;

    matchInFlight = false;
    if (response && response.success) {
        autoRetryCount = 0;
        healCount = 0;
        lastXmlStr = response.xmlStr || '';
        lastBiliTitle = response.bilibiliTitle || '';

        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(response.xmlStr, "text/xml");
        rawComments = [];

        xmlDoc.querySelectorAll('d').forEach(d => {
            const p = d.getAttribute('p');
            if (p) {
                const parts = p.split(',');
                rawComments.push({
                    text: d.textContent,
                    time: parseFloat(parts[0]),
                    color: '#' + parseInt(parts[3]).toString(16).padStart(6, '0')
                });
            }
        });

        if (rawComments.length === 0) {
            // 匹配成功但一条弹幕都没有：不能装作"已连接"
            setUIStatus('fail', 'B站未返回弹幕（该视频可能没有弹幕）');
        } else {
            lastSuccessText = `${response.bvid} · ${rawComments.length} 条`;
            setUIStatus('success', lastSuccessText);
        }
        reloadDanmaku();
        updateExportHint();
    } else {
        const errText = response ? response.error : '未知错误';
        // 网络类失败自动再试一次（背景层已重试，这里兜底）
        if (!response || /网络|超时|波动|HTTP/.test(errText)) {
            if (autoRetryCount < 2) {
                autoRetryCount++;
                matchInFlight = true;
                matchStartedAt = Date.now();
                setUIStatus('wait', `重试中 (${autoRetryCount}/2)...`);
                setTimeout(() => startAutoMatch(), 2000);
                finishMatchCycle();
                return;
            }
        }
        setUIStatus('fail', errText);
    }
    finishMatchCycle();
}

// 单轮匹配结束：若有排队的新请求（匹配期间又触发了导航/手动操作），补跑一轮
function finishMatchCycle() {
    if (!rematchRequested) return;
    rematchRequested = false;
    startMatchWhenReady(0, matchGen);
}

function buildBiliComments(out, blockWords, actualFont, strokeW) {
    rawComments.forEach(d => {
        if (blockWords.some(w => d.text.includes(w))) return;
        out.push({
            text: d.text,
            time: d.time + config.offset,
            source: 'bili',
            style: {
                font: `bold ${actualFont}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`,
                fillStyle: config.forceColor ? config.customColor : d.color,
                strokeStyle: 'rgba(0,0,0,0.85)',
                lineWidth: strokeW
            }
        });
    });
}

function reloadDanmaku() {
    const video = document.querySelector('video');
    const player = document.getElementById('movie_player');
    if (!video || !player) return;

    const blockWords = config.localBlockWords;
    const actualFont = getActualFont();
    const strokeW = Math.max(1, Math.round(actualFont / 12));

    const comments = [];
    buildBiliComments(comments, blockWords, actualFont, strokeW);
    const ytComments = [];   // 评论弹幕功能已移除

    if (comments.length === 0 && ytComments.length === 0) return;

    const useSep = config.ytComments.enabled && config.ytComments.mode === 'separate' && ytComments.length > 0;
    const mainComments = useSep ? comments : comments.concat(ytComments);

    destroyEngines();

    renderState = { main: mainComments.length, sep: useSep ? ytComments.length : 0 };
    if (renderState.main === 0 && renderState.sep === 0) { updateExportHint(); return; }

    // 主弹幕层
    const dmContainer = document.createElement('div');
    dmContainer.id = 'b2y-dm-container';
    dmContainer.style.cssText = `position:absolute; top:0; left:0; width:100%; pointer-events:none; z-index:40; overflow:hidden;`;
    player.appendChild(dmContainer);

    if (mainComments.length > 0) {
        danmakuEngine = new Danmaku({
            container: dmContainer,
            media: video,
            comments: mainComments,
            engine: 'canvas'
        });
    }

    // 独立评论区（底部）
    if (useSep) {
        const sepContainer = document.createElement('div');
        sepContainer.id = 'b2y-dm-container-sep';
        sepContainer.style.cssText = `position:absolute; bottom:0; left:0; width:100%; pointer-events:none; z-index:41; overflow:hidden;`;
        player.appendChild(sepContainer);

        sepDanmakuEngine = new Danmaku({
            container: sepContainer,
            media: video,
            comments: ytComments,
            engine: 'canvas'
        });
    }

    applyContainerHeights(player);

    if (playerResizeObserver) playerResizeObserver.disconnect();
    playerResizeObserver = new ResizeObserver((entries) => {
        if (entries.length > 0) {
            requestAnimationFrame(() => applyContainerHeights(player));
        }
    });
    playerResizeObserver.observe(player);
}

function applyContainerHeights(player) {
    const rect = player.getBoundingClientRect();
    const main = document.getElementById('b2y-dm-container');
    const sep = document.getElementById('b2y-dm-container-sep');
    const covRatio = getActualCov() / 100;
    if (main) {
        const h = Math.round(rect.height * covRatio) + 'px';
        if (main.style.height !== h) {
            main.style.height = h;
            if (danmakuEngine) danmakuEngine.resize();
        }
    }
    if (sep) {
        const h = Math.round(rect.height * config.ytComments.separatePct / 100) + 'px';
        if (sep.style.height !== h) {
            sep.style.height = h;
            if (sepDanmakuEngine) sepDanmakuEngine.resize();
        }
    }
}

function destroyEngines() {
    if (danmakuEngine) { try { danmakuEngine.destroy(); } catch (e) {} danmakuEngine = null; }
    if (sepDanmakuEngine) { try { sepDanmakuEngine.destroy(); } catch (e) {} sepDanmakuEngine = null; }
    document.getElementById('b2y-dm-container')?.remove();
    document.getElementById('b2y-dm-container-sep')?.remove();
    renderState = { main: 0, sep: 0 };
}

// 播放器 DOM 被重建时原地恢复弹幕层（不重新拉取数据）
function ensureEngineIntact() {
    const player = document.getElementById('movie_player');
    if (!player) return;
    if (renderState.main === 0 && renderState.sep === 0) return;

    const main = document.getElementById('b2y-dm-container');
    const sep = document.getElementById('b2y-dm-container-sep');
    const brokenMain = renderState.main > 0 && (!main || !main.isConnected || !danmakuEngine);
    const brokenSep = renderState.sep > 0 && (!sep || !sep.isConnected || !sepDanmakuEngine);

    if (brokenMain || brokenSep) { reloadDanmaku(); return; }
    applyContainerHeights(player);
}

function updateExportHint(err) {
    const el = document.getElementById('b2y-export-hint');
    if (!el) return;
    const biliN = rawComments.length;
    if (err) { el.textContent = err; return; }
    if (biliN === 0) { el.textContent = '暂无弹幕'; return; }
    el.textContent = `B站 ${biliN} 条`;
}

// ================= 导出 =================
function exportDanmaku(fmt) {
    const list = [];
    rawComments.forEach(c => list.push({ time: c.time, text: c.text, color: c.color }));

    if (fmt === 'xml') {
        if (!lastXmlStr) { updateExportHint('暂无B站原始弹幕'); return; }
        B2YExport.exportComments(list, { format: 'xml', xmlStr: lastXmlStr, filename: lastBiliTitle || getVideoId() || 'danmaku' });
        return;
    }
    if (list.length === 0) { updateExportHint('暂无弹幕可导出'); return; }

    list.sort((a, b) => a.time - b.time);
    B2YExport.exportComments(list, {
        format: fmt,
        duration: getYoutubeDuration(),
        cueSec: config.cueSec || 3,
        filename: lastBiliTitle || document.title.replace(/\s*[-–]\s*YouTube$/, '') || 'danmaku'
    });
}

// ================= 跳转按钮（低调样式，无 emoji） =================
function injectJumpButton() {
    const titleContainer = document.querySelector('h1.ytd-watch-metadata');
    if (!titleContainer) return;
    let btn = document.getElementById('b2y-jump-btn');
    if (btn) return;
    btn = document.createElement('a');
    btn.id = 'b2y-jump-btn';
    btn.className = 'b2y-jump';
    btn.target = '_blank';
    btn.rel = 'noopener';
    btn.textContent = 'B站搜索';
    btn.title = '在哔哩哔哩搜索当前视频';
    btn.onclick = (e) => {
        e.preventDefault();
        const t = (document.querySelector('h1.ytd-watch-metadata yt-formatted-string') || {}).textContent || document.title;
        window.open(`https://search.bilibili.com/all?keyword=${encodeURIComponent(t)}`, '_blank');
    };
    titleContainer.appendChild(btn);
}

// ================= 启动与事件 =================
['yt-navigate-finish', 'yt-page-data-updated'].forEach(evt => {
    document.addEventListener(evt, () => { setTimeout(onNavigate, 60); }, true);
});
window.addEventListener('popstate', () => setTimeout(onNavigate, 60));
window.addEventListener('hashchange', () => setTimeout(onNavigate, 60));

// 卡死自愈：请求超时接管；状态停在"等待中"却没有任何数据 → 自动重启匹配（最多 3 次）
function healMatchIfNeeded() {
    if (!location.href.includes('/watch?v=')) return;

    if (matchInFlight) {
        if (Date.now() - matchStartedAt <= 15000) return;
        matchInFlight = false;   // 后台无响应：接管
        // 旧弹幕还在屏上 → 徽章回滚到成功态，别停在"等待中"
        if (rawComments.length > 0 && lastSuccessText) {
            setUIStatus('success', lastSuccessText);
            return;
        }
    }

    const badge = document.getElementById('b2y-status-badge');
    if (!badge || !badge.classList.contains('badge-wait')) return;
    if (rawComments.length > 0) return;
    if (badgeWaitSince <= 0 || Date.now() - badgeWaitSince < 18000) return;
    if (healCount >= 3) return;

    healCount++;
    matchGen++;
    rematchRequested = false;
    startMatchWhenReady(0, matchGen);
}

setInterval(() => {
    injectPlayerButton();
    injectJumpButton();
    onNavigate();
    ensureEngineIntact();
    healMatchIfNeeded();
    autoCloseOnControlsHide();
}, 1000);

// 首次进入
onNavigate();
