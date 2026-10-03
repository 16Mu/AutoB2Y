// 共享核心（评论抓取 / 视频解析等纯函数）—— content script 与本 worker 共用同一份代码
importScripts('yt_core.js');

// ================= 通用：带超时与指数退避的 fetch =================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, options = {}, opts = {}) {
    const retries = opts.retries !== undefined ? opts.retries : 3;
    const backoff = opts.backoff || [800, 1600, 3200];
    const timeout = opts.timeout || 8000;
    let lastErr = null;

    for (let i = 0; i <= retries; i++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) {
                lastErr = new Error('HTTP ' + res.status);
                lastErr.status = res.status;
                if (i < retries) { await sleep(backoff[Math.min(i, backoff.length - 1)]); continue; }
                throw lastErr;
            }
            return res;
        } catch (e) {
            clearTimeout(timer);
            lastErr = e;
            if (i < retries) { await sleep(backoff[Math.min(i, backoff.length - 1)]); continue; }
            throw lastErr;
        }
    }
    throw lastErr || new Error('fetch failed');
}

async function fetchJSONWithRetry(url, options, opts) {
    const res = await fetchWithRetry(url, options, opts);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (e) { throw new Error('JSON解析失败'); }
}

// 业务级重试：用于 HTTP 200 但业务 code 异常（如 B站 -412 风控）的场景
async function retryOp(fn, opts = {}) {
    const retries = opts.retries !== undefined ? opts.retries : 3;
    const backoff = opts.backoff || [1200, 2500, 5000];
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
        try { return await fn(); }
        catch (e) {
            lastErr = e;
            const retriable = e && (e.retriable !== false);
            if (i < retries && retriable) { await sleep(backoff[Math.min(i, backoff.length - 1)]); continue; }
            throw lastErr;
        }
    }
    throw lastErr;
}

function bilibiliError(code, message) {
    const err = new Error(message || ('API错误 ' + code));
    err.code = code;
    // -412 风控 / -509 限速 / 5xx 服务器错误 → 可重试；其余业务错误不重试
    err.retriable = (code === -412 || code === -509 || code === -500 || code === -504);
    return err;
}

// ================= 消息路由 =================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const reply = (p) => p.then(sendResponse).catch(e => sendResponse({ success: false, error: (e && e.message) || '后台处理异常' }));
    if (request.action === 'autoMatch') {
        reply(doAutoMatch(request.keyword, request.duration));
        return true;
    }
    if (request.action === 'manualMatch') {
        reply(doManualMatch(request.bvid, request.page || 1));
        return true;
    }
    if (request.action === 'findYoutube') {
        reply(findYoutubeVideo(request.bvid));
        return true;
    }
});

// ================= B站：搜索与弹幕拉取 =================
function timeToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = String(timeStr).split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
}

async function biliSearch(keyword) {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}`;
    const data = await retryOp(async () => {
        const json = await fetchJSONWithRetry(url, {}, { retries: 1 });
        if (json.code !== 0) throw bilibiliError(json.code, json.message);
        if (!json.data || !json.data.result || json.data.result.length === 0) {
            const err = new Error('未搜索到B站原片');
            err.retriable = false;
            throw err;
        }
        return json;
    });
    return data.data.result;
}

async function doAutoMatch(keyword, ytDuration) {
    try {
        const results = await biliSearch(keyword);

        let bestMatch = results[0];
        let isPerfectMatch = false;
        for (let item of results) {
            let biliDuration = timeToSeconds(item.duration);
            if (Math.abs(biliDuration - ytDuration) <= 5) {
                bestMatch = item;
                isPerfectMatch = true;
                break;
            }
        }

        let bvid = bestMatch.bvid;
        let title = bestMatch.title.replace(/<[^>]+>/g, "");
        return await fetchAndParseDanmaku(bvid, title, isPerfectMatch, 1);
    } catch (e) {
        return { success: false, error: friendlyBiliError(e) };
    }
}

async function doManualMatch(bvid, page) {
    try {
        let meta = await getBiliVideoMeta(bvid);
        return await fetchAndParseDanmaku(bvid, meta.title, true, page || 1, meta);
    } catch (e) {
        return { success: false, error: friendlyBiliError(e) };
    }
}

function friendlyBiliError(e) {
    if (!e) return '未知错误';
    if (e.code === -412) return '触发风控拦截(-412)，已自动重试仍失败';
    if (e.code === -509) return '请求过于频繁(-509)，稍后再试';
    if (e.code === -404) return 'BV 号不存在或稿件已失效';
    if (e.code === 62002 || e.code === 62004) return '稿件不可见或已失效';
    if (e.name === 'AbortError') return '请求超时，网络波动';
    if (e.message && e.message.indexOf('HTTP') === 0) return '接口异常 (' + e.message + ')';
    if (e.message && e.message.indexOf('未搜索到') === 0) return e.message;
    if (typeof e.code === 'number' && e.code !== 0) return `B站接口错误: ${e.message || e.code}`;
    return '网络错误，已自动重试';
}

async function getBiliVideoMeta(bvid) {
    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
    const json = await retryOp(async () => {
        const j = await fetchJSONWithRetry(url, {}, { retries: 1 });
        if (j.code !== 0) throw bilibiliError(j.code, j.message);
        return j;
    });
    if (!json.data) throw bilibiliError(-1, '视频信息为空');
    return {
        bvid: json.data.bvid,
        title: json.data.title,
        duration: json.data.duration,
        mid: String(json.data.owner ? json.data.owner.mid : ''),
        pages: (json.data.pages || []).map(p => ({ page: p.page, cid: p.cid, duration: p.duration }))
    };
}

async function fetchAndParseDanmaku(bvid, title, isPerfectMatch, page, knownMeta) {
    try {
        const meta = knownMeta || await getBiliVideoMeta(bvid);
        const pageNo = parseInt(page, 10) || 1;
        let cid;
        if (meta.pages && meta.pages.length > 0) {
            const p = meta.pages.find(x => x.page === pageNo) || meta.pages[0];
            cid = p.cid;
        } else {
            const pageData = await retryOp(async () => {
                const j = await fetchJSONWithRetry(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {}, { retries: 1 });
                if (j.code !== 0) throw bilibiliError(j.code, j.message);
                return j;
            });
            cid = pageData.data[0].cid;
        }

        const xmlStr = await retryOp(async () => {
            const res = await fetchWithRetry(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {}, { retries: 2 });
            const text = await res.text();
            // 弹幕XML根节点为 <i>；拿不到根节点说明接口被拦截或返回了异常页
            if (text.indexOf('<i>') === -1) {
                const err = new Error('弹幕数据格式异常');
                err.retriable = true;
                throw err;
            }
            return text;
        });

        return {
            success: true,
            xmlStr: xmlStr,
            bilibiliTitle: title || meta.title,
            bvid: bvid,
            duration: meta.duration,
            isPerfectMatch: isPerfectMatch
        };
    } catch (e) {
        return { success: false, error: friendlyBiliError(e) };
    }
}

// ================= B站 → YouTube 直达具体视频 =================
const ASSOC_URL = 'https://raw.githubusercontent.com/ahaduoduoduo/bilibili-youtube-danmaku/main/channel-associations.json';
const ASSOC_CACHE_KEY = 'b2yAssocCache';
const ASSOC_TTL = 7 * 24 * 3600 * 1000;

async function loadChannelAssociations() {
    try {
        const cached = await chrome.storage.local.get(ASSOC_CACHE_KEY);
        const c = cached[ASSOC_CACHE_KEY];
        if (c && c.ts && (Date.now() - c.ts) < ASSOC_TTL && c.data) return c.data;
    } catch (e) { /* ignore */ }

    try {
        const json = await fetchJSONWithRetry(ASSOC_URL, {}, { retries: 2, timeout: 6000 });
        if (json && Array.isArray(json.channels)) {
            chrome.storage.local.set({ [ASSOC_CACHE_KEY]: { ts: Date.now(), data: json } });
            return json;
        }
    } catch (e) { /* 远程失败，回退到内置快照 */ }

    // 内置快照兜底（channel-associations.json 打包进扩展）
    try {
        const url = chrome.runtime.getURL('channel-associations.json');
        const res = await fetch(url);
        const json = await res.json();
        if (json && Array.isArray(json.channels)) return json;
    } catch (e) { /* ignore */ }
    return { channels: [] };
}

async function findYoutubeVideo(bvid) {
    let meta = null;
    try { meta = await getBiliVideoMeta(bvid); }
    catch (e) { return { success: false, error: friendlyBiliError(e) }; }

    const title = meta.title;
    const duration = meta.duration || 0;

    // 1) 关联库：反查该 UP 对应的 YouTube 频道
    let handle = null;
    try {
        const assoc = await loadChannelAssociations();
        const hit = assoc.channels.find(c => String(c.bilibiliUID) === String(meta.mid));
        if (hit && hit.youtubeChannelId) handle = String(hit.youtubeChannelId).replace(/^@/, '');
    } catch (e) { /* ignore */ }

    // 2) 频道内定向搜索
    if (handle) {
        try {
            const url = `https://www.youtube.com/@${encodeURIComponent(handle)}/search?query=${encodeURIComponent(title)}`;
            const videos = await searchYouTube(url);
            const best = pickBestVideo(videos, title, duration);
            if (best) return { success: true, url: `https://www.youtube.com/watch?v=${best.id}`, mode: 'channel', title: best.title };
        } catch (e) { /* 频道搜索失败 → 全站兜底 */ }
    }

    // 3) 全站搜索兜底：解析结果自动选片
    try {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(title)}`;
        const videos = await searchYouTube(url);
        const best = pickBestVideo(videos, title, duration);
        if (best) return { success: true, url: `https://www.youtube.com/watch?v=${best.id}`, mode: 'search', title: best.title };
    } catch (e) { /* ignore */ }

    // 4) 全部失败 → 打开搜索页（旧行为）
    return { success: true, url: `https://www.youtube.com/results?search_query=${encodeURIComponent(title)}`, mode: 'fallback', title: title };
}

// 从 HTML 中提取以 marker 开头的平衡 JSON 对象（实现见 yt_core.js）
const extractBalancedJson = (html, marker) => YtCore.extractBalancedJson(html, marker);

async function searchYouTube(pageUrl) {
    const res = await fetchWithRetry(pageUrl, {
        headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
    }, { retries: 2, timeout: 9000 });
    const html = await res.text();

    let data = null;
    const jsonStr = extractBalancedJson(html, 'var ytInitialData =');
    if (jsonStr) { try { data = JSON.parse(jsonStr); } catch (e) { data = null; } }
    if (!data) {
        const marker2 = 'window["ytInitialData"] =';
        const js2 = extractBalancedJson(html, marker2);
        if (js2) { try { data = JSON.parse(js2); } catch (e) { data = null; } }
    }
    if (!data) { const err = new Error('解析YouTube结果失败'); err.retriable = true; throw err; }

    const out = [];
    YtCore.collectVideoRenderers(data, out);
    const seen = new Set();
    return out.filter(v => { if (!v.id || seen.has(v.id)) return false; seen.add(v.id); return true; });
}

function normalizeTitle(s) {
    return String(s || '')
        .replace(/【.*?】/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/[（(].*?[)）]/g, '')
        .replace(/HDR|HD|4K|8K|60fps|字幕|中字|中文|双语|官方|正版|CC/gi, '')
        .replace(/[\s\p{P}\p{S}]/gu, '')
        .toLowerCase();
}

function bigramDice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const grams = new Map();
    for (let i = 0; i < a.length - 1; i++) {
        const g = a.substr(i, 2);
        grams.set(g, (grams.get(g) || 0) + 1);
    }
    let hits = 0, total = 0;
    for (let i = 0; i < b.length - 1; i++) {
        const g = b.substr(i, 2);
        total++;
        const c = grams.get(g) || 0;
        if (c > 0) { hits++; grams.set(g, c - 1); }
    }
    const sizeA = Math.max(0, a.length - 1);
    const sizeB = Math.max(0, b.length - 1);
    if (sizeA + sizeB === 0) return 0;
    return (2 * hits) / (sizeA + sizeB);
}

function pickBestVideo(videos, title, duration) {
    if (!videos || videos.length === 0) return null;
    const target = normalizeTitle(title);
    let best = null, bestScore = 0;

    for (const v of videos) {
        const cand = normalizeTitle(v.title);
        let sim = bigramDice(target, cand);
        if (target && cand && (target.indexOf(cand) !== -1 || cand.indexOf(target) !== -1)) {
            sim = Math.max(sim, 0.75);
        }
        const candDur = timeToSeconds(v.length);
        let durScore = 0.5;
        if (duration > 0 && candDur > 0) {
            const diff = Math.abs(candDur - duration);
            durScore = diff <= 8 ? 1 : (diff <= 30 ? 0.6 : 0.15);
        }
        const score = sim * 0.65 + durScore * 0.35;
        if (sim >= 0.4 && score > bestScore) { bestScore = score; best = v; }
    }
    if (best) return best;
    // 标题相似度都不达标时，若时长吻合则选时长吻合的
    if (duration > 0) {
        const durMatch = videos.find(v => {
            const d = timeToSeconds(v.length);
            return d > 0 && Math.abs(d - duration) <= 5;
        });
        if (durMatch) return durMatch;
    }
    return null;
}
