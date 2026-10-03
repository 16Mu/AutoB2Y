let currentUrl = "";
let danmakuEngine = null;
let rawComments = [];
let playerResizeObserver = null;

let config = {
    offset: 0,
    covMode: '100', // 25, 50, 75, 100, custom
    covCustom: 100,
    fontMode: '24', // 18, 24, 36, 48, custom
    fontCustom: 24,
    forceColor: false,
    customColor: '#ffffff',
    localBlockWords: []
};

// 本地持久化加载
chrome.storage.local.get(['b2yConfig', 'b2yCloudWords'], function(result) {
    if(result.b2yConfig) config = {...config, ...result.b2yConfig};

    // 一次性清理历史遗留键：旧版本把「云端屏蔽词」缓存在 b2yCloudWords 下，该功能已移除。
    // 正常情况下该键不存在，此处不会产生任何写入；清掉一次后即永不再触发。
    if(result.b2yCloudWords !== undefined) {
        chrome.storage.local.remove('b2yCloudWords');
    }
});

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

// ================= UI 注入与事件 =================
function injectPlayerButton() {
    if (document.getElementById('b2y-control-btn')) return;
    let rightControls = document.querySelector('.ytp-right-controls');
    if (!rightControls) return;

    let btn = document.createElement('button');
    btn.id = 'b2y-control-btn';
    btn.className = 'ytp-button';
    btn.title = 'B站弹幕设置';
    btn.innerHTML = `<svg height="100%" version="1.1" viewBox="0 0 36 36" width="100%"><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#fff" font-size="14" font-weight="bold">弹</text></svg>`;
    rightControls.insertBefore(btn, rightControls.firstChild);
    
    let panel = document.createElement('div');
    panel.id = 'b2y-settings-panel';
    panel.style.display = 'none';
    
    panel.innerHTML = `
        <div id="b2y-main-view">
            <div class="b2y-header">
                <span class="b2y-header-title"><svg class="b2y-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="7.5" width="19" height="12.5" rx="2.5"></rect><path d="M8.2 3.2 12 7.2l3.8-4"></path></svg>弹幕控制中心</span>
                <span id="b2y-status-badge" class="badge-wait">等待中</span>
            </div>
            
            <div id="b2y-rescue-box" style="display:none; margin-bottom:15px; padding:10px; background:rgba(220,53,69,0.2); border:1px solid #dc3545; border-radius:6px;">
                <div style="font-size:12px; color:#ffbaba; margin-bottom:6px;" id="b2y-rescue-msg">匹配失败，请手动矫正</div>
                <div class="b2y-stepper" style="width:100%; border-color:#dc3545;">
                    <input type="text" id="b2y-rescue-input" placeholder="输入真实 BV 号..." style="flex:1;">
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
                <label style="cursor:pointer; display:flex; align-items:center;">
                    <input type="checkbox" id="b2y-chk-color" style="margin-right:6px;"> 统一弹幕颜色
                </label>
                <input type="color" id="b2y-color-picker" value="${config.customColor}" class="b2y-color-input" title="点击选择弹幕颜色">
            </div>
            
            <button id="b2y-btn-manage-block" class="b2y-action-btn" style="margin-top:10px;">管理屏蔽词 (共 <span id="b2y-bw-count">0</span> 个) ➔</button>
            <div style="text-align:center; margin-top:12px;">
                <a href="#" id="b2y-btn-show-rescue" style="font-size:12px; color:#aaa; text-decoration:underline;">自动匹配错了？点此手动输入</a>
            </div>
        </div>

        <div id="b2y-block-view" style="display:none;">
            <div class="b2y-header">
                <button id="b2y-btn-back" class="b2y-icon-btn">⬅ 返回</button>
                <span>🛡️ 屏蔽词管理</span>
            </div>
            
            <div class="b2y-stepper" style="margin-bottom:10px;">
                <input type="text" id="b2y-new-block-input" placeholder="输入新屏蔽词..." style="flex:1;">
                <button id="b2y-add-block-btn" style="background:#00a1d6; color:white;">添加</button>
            </div>
            
            <div id="b2y-block-list-container"></div>
        </div>
    `;
    document.querySelector('#movie_player').appendChild(panel);

    btn.onclick = () => { 
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; 
        syncUIToData();
    };

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
    };
    sldCov.oninput = (e) => { covVal.innerText = e.target.value + '%'; };
    sldCov.onchange = (e) => { config.covCustom = e.target.value; saveConfig(); };

    let selFont = document.getElementById('b2y-sel-font');
    let sldFontWrap = document.getElementById('b2y-font-slider-wrap');
    let sldFont = document.getElementById('b2y-sld-font');
    let fontVal = document.getElementById('b2y-font-val');

    selFont.onchange = (e) => {
        config.fontMode = e.target.value;
        sldFontWrap.style.display = config.fontMode === 'custom' ? 'flex' : 'none';
        saveConfig();
    };
    sldFont.oninput = (e) => { fontVal.innerText = e.target.value + 'px'; };
    sldFont.onchange = (e) => { config.fontCustom = e.target.value; saveConfig(); };

    let chkColor = document.getElementById('b2y-chk-color');
    let colorPicker = document.getElementById('b2y-color-picker');
    chkColor.onchange = (e) => { config.forceColor = e.target.checked; saveConfig(); };
    colorPicker.onchange = (e) => { config.customColor = e.target.value; saveConfig(); };

    let mainView = document.getElementById('b2y-main-view');
    let blockView = document.getElementById('b2y-block-view');
    document.getElementById('b2y-btn-manage-block').onclick = () => { mainView.style.display = 'none'; blockView.style.display = 'block'; renderBlockList(); };
    document.getElementById('b2y-btn-back').onclick = () => { blockView.style.display = 'none'; mainView.style.display = 'block'; };

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

function syncUIToData() {
    document.getElementById('b2y-offset-input').value = config.offset;
    document.getElementById('b2y-offset-slider').value = config.offset;
    
    document.getElementById('b2y-chk-color').checked = config.forceColor;
    document.getElementById('b2y-color-picker').value = config.customColor;
    
    document.getElementById('b2y-sel-cov').value = config.covMode;
    document.getElementById('b2y-cov-slider-wrap').style.display = config.covMode === 'custom' ? 'flex' : 'none';
    document.getElementById('b2y-sld-cov').value = config.covCustom;
    document.getElementById('b2y-cov-val').innerText = config.covCustom + '%';

    document.getElementById('b2y-sel-font').value = config.fontMode;
    document.getElementById('b2y-font-slider-wrap').style.display = config.fontMode === 'custom' ? 'flex' : 'none';
    document.getElementById('b2y-sld-font').value = config.fontCustom;
    document.getElementById('b2y-font-val').innerText = config.fontCustom + 'px';
    
    document.getElementById('b2y-bw-count').innerText = config.localBlockWords.length;
}

function renderBlockList() {
    let container = document.getElementById('b2y-block-list-container');
    container.innerHTML = '';
    
    config.localBlockWords.forEach((w, idx) => {
        let tag = document.createElement('div');
        tag.className = 'b2y-tag b2y-tag-local';
        let label = document.createElement('span');
        label.innerText = w;
        tag.appendChild(label);
        let del = document.createElement('span');
        del.className = 'b2y-tag-del';
        del.innerText = '×';
        del.onclick = () => {
            config.localBlockWords.splice(idx, 1);
            saveConfig();
            renderBlockList();
        };
        tag.appendChild(del);
        container.appendChild(tag);
    });
    
    document.getElementById('b2y-bw-count').innerText = config.localBlockWords.length;
}

function setUIStatus(type, text) {
    let badge = document.getElementById('b2y-status-badge');
    let rescueBox = document.getElementById('b2y-rescue-box');
    let rescueMsg = document.getElementById('b2y-rescue-msg');
    
    if(!badge) return;
    badge.className = `badge-${type}`;
    
    if (type === 'success') {
        badge.innerText = `已连接 (${text})`;
        rescueBox.style.display = 'none';
    } else if (type === 'fail') {
        badge.innerText = '匹配异常';
        rescueMsg.innerText = `原因: ${text}`;
        rescueBox.style.display = 'block'; 
    } else {
        badge.innerText = text;
        rescueBox.style.display = 'none';
    }
}

// ================= 核心渲染逻辑 =================

function checkVideoChange() {
    if (location.href !== currentUrl) {
        currentUrl = location.href;
        if (currentUrl.includes('/watch?v=')) {
            setUIStatus('wait', '正在检索...');
            setTimeout(startAutoMatch, 3500); 
        } else {
            if(danmakuEngine) danmakuEngine.hide();
        }
    }
}

function getYoutubeDuration() {
    let meta = document.querySelector('meta[itemprop="duration"]');
    if (meta) {
        let match = meta.getAttribute('content').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (match) return parseInt(match[1]||0)*3600 + parseInt(match[2]||0)*60 + parseInt(match[3]||0);
    }
    let video = document.querySelector('video');
    return video ? video.duration : 0;
}

function startAutoMatch() {
    let titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    if(!titleEl) return;
    let cleanTitle = titleEl.innerText.replace(/\[4K\]/gi, '').replace(/【.*?】/g, '').trim();
    chrome.runtime.sendMessage({ action: 'autoMatch', keyword: cleanTitle, duration: getYoutubeDuration() }, handleMatchResponse);
}

function forceMatch(bvid) {
    setUIStatus('wait', '手动拉取中...');
    chrome.runtime.sendMessage({ action: 'manualMatch', bvid: bvid }, handleMatchResponse);
}

function handleMatchResponse(response) {
    if (response && response.success) {
        setUIStatus('success', response.bvid);
        
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
        reloadDanmaku();
    } else {
        setUIStatus('fail', response ? response.error : '未知错误');
    }
}

function reloadDanmaku() {
    if (rawComments.length === 0) return;
    
    const comments = [];
    const blockWords = config.localBlockWords;
    
    const actualFont = getActualFont();
    const strokeW = Math.max(1, Math.round(actualFont / 12));
    
    rawComments.forEach(d => {
        if (blockWords.some(w => d.text.includes(w))) return;
        
        comments.push({
            text: d.text,
            time: d.time + config.offset, 
            style: { 
                font: `bold ${actualFont}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`, 
                fillStyle: config.forceColor ? config.customColor : d.color, 
                strokeStyle: 'rgba(0,0,0,0.85)',
                lineWidth: strokeW
            }
        });
    });

    const video = document.querySelector('video');
    const player = document.getElementById('movie_player');
    if (!video || !player) return;

    if (danmakuEngine) {
        danmakuEngine.destroy();
        document.getElementById('b2y-dm-container')?.remove();
    }

    const dmContainer = document.createElement('div');
    dmContainer.id = 'b2y-dm-container';
    
    dmContainer.style.cssText = `position:absolute; top:0; left:0; width:100%; pointer-events:none; z-index:40; overflow:hidden;`;
    player.appendChild(dmContainer);

    danmakuEngine = new Danmaku({
        container: dmContainer,
        media: video,
        comments: comments,
        engine: 'canvas'
    });
    
    if (playerResizeObserver) playerResizeObserver.disconnect();
    playerResizeObserver = new ResizeObserver((entries) => {
        if (danmakuEngine && entries.length > 0) {
            requestAnimationFrame(() => {
                const rect = entries[0].contentRect;
                const covRatio = getActualCov() / 100;
                dmContainer.style.height = (rect.height * covRatio) + 'px';
                danmakuEngine.resize();
            });
        }
    });
    playerResizeObserver.observe(player);
}

function injectJumpButton() {
    if (document.getElementById('b2y-jump-btn')) return;
    let titleContainer = document.querySelector('h1.ytd-watch-metadata');
    if (!titleContainer) return;
    
    let btn = document.createElement('a');
    btn.id = 'b2y-jump-btn';
    btn.innerHTML = '🚀 去 B站 搜索';
    btn.style.cssText = 'display:inline-block; margin-left:15px; font-size:1.4rem; padding:4px 8px; background:#00a1d6; color:white; border-radius:4px; text-decoration:none; vertical-align:middle;';
    btn.onclick = () => {
        let t = document.querySelector('h1.ytd-watch-metadata yt-formatted-string').innerText;
        window.open(`https://search.bilibili.com/all?keyword=${encodeURIComponent(t)}`, '_blank');
    };
    titleContainer.appendChild(btn);
}

setInterval(() => {
    injectPlayerButton();
    injectJumpButton();
    checkVideoChange();
}, 1000);
