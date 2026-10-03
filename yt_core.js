// ================= AutoB2Y YouTube 评论抓取核心（content script 与 background 共用）=================
(function (global) {
    'use strict';

    // ---- HTML 内平衡 JSON 提取 ----
    function extractBalancedJson(html, marker) {
        const start = html.indexOf(marker);
        if (start === -1) return null;
        let i = start + marker.length;
        while (i < html.length && html[i] !== '{') i++;
        if (i >= html.length) return null;
        let depth = 0, inStr = false, esc = false;
        for (let j = i; j < html.length; j++) {
            const ch = html[j];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) return html.substring(i, j + 1); }
        }
        return null;
    }

    // ---- 搜索结果里的视频（B站 → YouTube 选片用） ----
    function collectVideoRenderers(node, out) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const n of node) collectVideoRenderers(n, out); return; }

        const vr = node.videoRenderer;
        if (vr && vr.videoId) {
            out.push({
                id: vr.videoId,
                title: vr.title ? (vr.title.simpleText || (vr.title.runs || []).map(r => r.text).join('')) : '',
                length: vr.lengthText ? (vr.lengthText.simpleText || '') : ''
            });
        }
        const lv = node.lockupViewModel;
        if (lv && lv.contentId && lv.contentType === 'VIDEO') {
            let t = '', length = '';
            try { t = lv.metadata.lockupMetadataViewModel.title.content || ''; } catch (e) { /* ignore */ }
            try {
                const badges = lv.metadata.lockupMetadataViewModel.assetBadges || [];
                for (const b of badges) {
                    const txt = b.metadataLockupViewModel ? b.metadataLockupViewModel.title : (b.text || '');
                    if (typeof txt === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(txt)) { length = txt; break; }
                }
            } catch (e) { /* ignore */ }
            out.push({ id: lv.contentId, title: t, length: length });
        }

        for (const k in node) {
            if (k === 'videoRenderer' || k === 'lockupViewModel') continue;
            const v = node[k];
            if (v && typeof v === 'object') collectVideoRenderers(v, out);
        }
    }

    // ---- 评论文本解析 ----
    function parseCount(raw) {
        if (!raw) return 0;
        if (typeof raw === 'number') return raw;
        const s = String(raw).replace(/,/g, '').trim();
        const m = s.match(/^([\d.]+)\s*([KMB])?$/i);
        if (!m) return parseInt(s, 10) || 0;
        let n = parseFloat(m[1]) || 0;
        const unit = (m[2] || '').toUpperCase();
        if (unit === 'K') n *= 1000;
        else if (unit === 'M') n *= 1000000;
        else if (unit === 'B') n *= 1000000000;
        return Math.round(n);
    }

    function cleanCommentText(t) {
        return String(t || '').replace(/\s+/g, ' ').trim().substring(0, 120);
    }

    // 把各种文本形态（string / runs / content / simpleText）统一转成纯文本
    function textOf(x, depth) {
        if (x === null || x === undefined) return '';
        if (typeof x === 'string') return x;
        if (typeof x !== 'object') return '';
        if (depth > 4) return '';
        if (Array.isArray(x)) return x.map(v => textOf(v, depth + 1)).join('');
        if (x.runs) return x.runs.map(r => r.text || '').join('');
        if (x.simpleText) return x.simpleText;
        if (x.content !== undefined && x.content !== null) return textOf(x.content, depth + 1);
        if (x.text !== undefined && x.text !== null) return textOf(x.text, depth + 1);
        return '';
    }

    // 逐层解开评论的各种包裹（Renderer / ViewModel / EntityPayload / Thread）
    function unwrapComment(item) {
        let p = item;
        for (let i = 0; i < 6 && p && typeof p === 'object'; i++) {
            if (p.commentEntityPayload) { p = p.commentEntityPayload; continue; }
            if (p.payload) { p = p.payload.commentEntityPayload || p.payload; continue; }
            if (p.commentEntityRenderer) { p = p.commentEntityRenderer; continue; }
            if (p.commentEntityViewModel) { p = p.commentEntityViewModel; continue; }
            if (p.commentViewModel) { p = p.commentViewModel; continue; }
            if (p.commentRenderer) { p = p.commentRenderer; continue; }
            if (p.threadRenderer && p.threadRenderer.comment) { p = p.threadRenderer.comment; continue; }
            if (p.threadViewModel && p.threadViewModel.comment) { p = p.threadViewModel.comment; continue; }
            break;
        }
        return p;
    }

    function extractComment(item) {
        if (!item || typeof item !== 'object') return null;
        const p = unwrapComment(item);
        if (!p || typeof p !== 'object') return null;

        // 认出评论：正文必须是结构化字段（content 是对象 / message / contentText ...）
        // 或（裸 text 字符串 + 有 id/点赞/作者等元数据），避免把 author.displayName 之类误认成评论
        const hasMeta = p.toolbar || p.likeCount !== undefined || p.voteCount ||
            p.commentId !== undefined || p.cid !== undefined || p.entityKey !== undefined ||
            p.author || p.authorText;
        const structuredText = (p.content && typeof p.content === 'object') ||
            p.message !== undefined || p.contentText !== undefined ||
            p.snippet !== undefined || p.body !== undefined;
        const bareTextWithMeta = typeof p.text === 'string' && !!hasMeta;
        if (!structuredText && !bareTextWithMeta && !hasMeta) return null;

        let text = '';
        try {
            text = textOf(p.content, 0) || textOf(p.message, 0) || textOf(p.contentText, 0) ||
                textOf(p.snippet, 0) || textOf(p.body, 0) || textOf(p.text, 0);
        } catch (e) { /* ignore */ }
        if (!text) return null;

        let likes = 0;
        try {
            const t = p.toolbar || {};
            const raw = t.likeCountNotliked || t.likeCountLiked || t.likeCount || t.likeCountViewModel ||
                p.likeCount || p.likeCountNotliked ||
                (p.voteCount && (p.voteCount.simpleText || p.voteCount.content)) || '';
            likes = parseCount(raw);
        } catch (e) { likes = 0; }

        let author = '';
        try { author = textOf(p.author && (p.author.displayName || p.author.displayText), 0) || textOf(p.authorText, 0); } catch (e) { /* ignore */ }

        const id = p.cid || p.commentId || p.entityKey || text.substr(0, 40);
        return { id: id, text: cleanCommentText(text), likes: likes, author: String(author || '') };
    }

    // 递归收集整棵 response 里的评论（兼容 itemSectionRenderer / threadRenderer 各种包装）
    // 以正文为去重键：父 payload 与其子节点（content / runs 元素）会提取出同一段文本，只留一条
    function collectComments(node, out, seen) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const n of node) collectComments(n, out, seen); return; }
        const c = extractComment(node);
        if (c && c.text && !seen.has(c.text)) {
            seen.add(c.text);
            out.push(c);
        }
        for (const k in node) collectComments(node[k], out, seen);
    }

    // ---- continuation token 定位（兼容 renderer / ViewModel 两代结构） ----
    function pickToken(node) {
        if (!node || typeof node !== 'object') return null;
        if (node.continuationCommand && node.continuationCommand.token) return node.continuationCommand.token;
        if (node.nextContinuationData && node.nextContinuationData.token) return node.nextContinuationData.token;
        if (node.continuationEndpoint && node.continuationEndpoint.continuationCommand &&
            node.continuationEndpoint.continuationCommand.token) {
            return node.continuationEndpoint.continuationCommand.token;
        }
        return null;
    }

    function findTokenInNode(node) {
        if (!node || typeof node !== 'object') return null;
        if (Array.isArray(node)) {
            for (const n of node) { const t = findTokenInNode(n); if (t) return t; }
            return null;
        }
        const direct = pickToken(node);
        if (direct) return direct;
        const cir = node.continuationItemRenderer;
        if (cir) {
            const t = pickToken(cir);
            if (t) return t;
        }
        const civ = node.continuationItemViewModel;
        if (civ) {
            const t = findTokenInNode(civ);
            if (t) return t;
        }
        for (const k in node) {
            if (k === 'continuationItemRenderer' || k === 'continuationItemViewModel') continue;
            const t = findTokenInNode(node[k]);
            if (t) return t;
        }
        return null;
    }

    // 优先在评论面板子树里找 token（避免抓到别的面板的 continuation）
    function findCommentsTokenInJson(node) {
        if (!node || typeof node !== 'object') return null;
        if (Array.isArray(node)) {
            for (const n of node) { const t = findCommentsTokenInJson(n); if (t) return t; }
            return null;
        }
        const panelId = node.panelIdentifier || node.engagementPanelIdentifier;
        if (typeof panelId === 'string' && panelId.indexOf('comments-section') !== -1) {
            const t = findTokenInNode(node);
            if (t) return t;
        }
        for (const k in node) {
            const t = findCommentsTokenInJson(node[k]);
            if (t) return t;
        }
        return null;
    }

    function findCommentsTokenInHtml(html) {
        if (!html) return null;
        const panelIdx = html.indexOf('engagement-panel-comments-section');
        const searchFrom = panelIdx !== -1 ? panelIdx : 0;
        const seg = html.substr(searchFrom, 80000);
        const tm = seg.match(/"continuationCommand":\{"token":"([^"]+)"/) ||
            seg.match(/"nextContinuationData":\{"token":"([^"]+)"/);
        if (tm) return tm[1];
        if (panelIdx === -1) {
            const m2 = html.match(/"continuationCommand":\{"token":"([^"]+)"/) ||
                html.match(/"nextContinuationData":\{"token":"([^"]+)"/);
            if (m2) return m2[1];
        }
        return null;
    }

    function extractCfgFromHtml(html) {
        const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
        let context = null;
        const ctxStr = extractBalancedJson(html, '"INNERTUBE_CONTEXT":');
        if (ctxStr) { try { context = JSON.parse(ctxStr); } catch (e) { context = null; } }
        if (!context) {
            const v = (html.match(/"INNERTUBE_CONTEXT":(\{.*?\}),"[A-Z_]+":/) || [])[1];
            if (v) { try { context = JSON.parse(v); } catch (e) { context = null; } }
        }
        return { apiKey: apiKey, context: context };
    }

    // ---- InnerTube next 接口 ----
    async function postNext(base, apiKey, context, payload, fetchFn, timeout) {
        const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeout || 9000) : null;
        try {
            const res = await fetchFn(`${base}/youtubei/v1/next?key=${apiKey}&prettyPrint=false`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-youtube-client-name': '1',
                    'x-youtube-client-version': (context && context.client && context.client.clientVersion) || '2.20250101.00.00'
                },
                body: JSON.stringify(Object.assign({ context: context }, payload)),
                signal: controller ? controller.signal : undefined
            });
            if (!res.ok) { const e = new Error('HTTP ' + res.status); e.stage = '接口响应'; throw e; }
            const json = await res.json();
            if (json.error) { const e = new Error((json.error.message || '接口返回错误') + ' (' + (json.error.code || '') + ')'); e.stage = '接口响应'; throw e; }
            return json;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // 失败诊断：把响应结构摘要出来，便于发现 YouTube 改了哪些字段
    function describeJson(json) {
        try {
            const keys = Object.keys(json).slice(0, 15).join(',');
            let itemKeys = '';
            const eps = json.onResponseReceivedEndpoints || [];
            for (const ep of eps) {
                const lists = [];
                if (ep.reloadContinuationItemsCommand) lists.push(ep.reloadContinuationItemsCommand.continuationItems);
                if (ep.appendContinuationItemsCommand) lists.push(ep.appendContinuationItemsCommand.continuationItems);
                if (ep.reloadContinuationItemsViewModel) lists.push(ep.reloadContinuationItemsViewModel.contents);
                if (ep.appendContinuationItemsViewModel) lists.push(ep.appendContinuationItemsViewModel.contents);
                for (const l of lists) { if (l && l[0]) { itemKeys = Object.keys(l[0]).join(','); break; } }
                if (itemKeys) break;
            }
            if (!itemKeys && json.contents) itemKeys = 'contents:' + Object.keys(json.contents).slice(0, 5).join(',');
            if (!itemKeys) itemKeys = '(空)';
            const s = JSON.stringify(json);
            const known = ['commentEntityPayload', 'commentEntityViewModel', 'commentRenderer', 'commentEntityRenderer', 'commentViewModel', 'commentRendererViewModel'];
            const has = known.filter(k => s.indexOf('"' + k + '"') !== -1).join('|') || '无已知评论字段';
            return `顶层[${keys}] 首项[${itemKeys}] 字段[${has}]`;
        } catch (e) { return '诊断失败'; }
    }

    /**
     * 抓取 YouTube 评论（同源时自动带 cookie）
     * 双路径：① HTML 评论面板 token ② next{videoId} 换 token；任一路径拿到即成功
     * @param {Object} opts { videoId, maxCount=40, base='', fetch=fetch, html=可选预取HTML }
     * @returns { success, comments, stage, error, debug }
     */
    async function fetchComments(opts) {
        const videoId = opts.videoId;
        const maxCount = opts.maxCount || 40;
        const base = opts.base || '';
        const fetchFn = opts.fetch || fetch;
        let stage = 'watch页';

        try {
            let html = opts.html;
            if (!html) {
                const res = await fetchFn(`${base}/watch?v=${encodeURIComponent(videoId)}`, {
                    headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
                });
                if (!res.ok) { const e = new Error('HTTP ' + res.status); e.stage = 'watch页'; throw e; }
                html = await res.text();
            }

            stage = '接口配置';
            const cfg = extractCfgFromHtml(html);
            if (!cfg.apiKey || !cfg.context) {
                const e = new Error('页面里找不到 INNERTUBE_API_KEY / CONTEXT');
                e.stage = stage; throw e;
            }

            const comments = [];
            const seen = new Set();
            let pagesTotal = 0;
            let lastDebug = '';

            // 用一个 continuation token 拉取评论页（最多 5 页）
            async function fetchPagesByToken(token, name) {
                let cur = token;
                let dbg = '';
                while (cur && pagesTotal < 6 && comments.length < maxCount) {
                    stage = '接口响应';
                    const json = await postNext(base, cfg.apiKey, cfg.context, { continuation: cur }, fetchFn);
                    pagesTotal++;
                    YtCore._lastResponse = json;
                    YtCore._lastPath = name;
                    collectComments(json, comments, seen);
                    dbg = describeJson(json);
                    if (comments.length >= maxCount) break;
                    const nt = findTokenInNode(json);
                    if (!nt || nt === cur) break;
                    cur = nt;
                }
                return dbg;
            }

            stage = '评论入口';
            // 路径①：HTML 评论面板 token
            const htmlToken = findCommentsTokenInHtml(html);
            if (htmlToken) {
                try {
                    lastDebug = await fetchPagesByToken(htmlToken, 'HTML入口');
                } catch (e) {
                    // 该路径失败不放弃，继续试路径②
                    lastDebug = 'HTML路径失败: ' + ((e && e.message) || e);
                }
            }

            // 路径②：next{videoId} 让接口吐出评论面板 token（路径① 0 条时补试）
            if (comments.length === 0) {
                stage = '评论入口';
                const vp = await postNext(base, cfg.apiKey, cfg.context, { videoId: videoId }, fetchFn);
                YtCore._lastResponse = vp;
                const t2 = findCommentsTokenInJson(vp) || findTokenInNode(vp);
                if (t2) {
                    lastDebug = await fetchPagesByToken(t2, 'videoId入口');
                } else {
                    lastDebug = describeJson(vp);
                    // videoId 响应本身可能直接含评论
                    collectComments(vp, comments, seen);
                }
            }

            stage = '结构解析';
            if (comments.length === 0) {
                try { console.warn('[AutoB2Y] 评论0条，响应结构诊断:', lastDebug, YtCore._lastResponse); } catch (e) { /* ignore */ }
                const e = new Error('解析到 0 条（结构诊断: ' + lastDebug + '）');
                e.stage = stage; e.debug = lastDebug; throw e;
            }

            comments.sort((a, b) => b.likes - a.likes);
            return { success: true, comments: comments.slice(0, maxCount), stage: 'done', pages: pagesTotal, debug: lastDebug };
        } catch (err) {
            return {
                success: false,
                stage: (err && err.stage) || stage,
                error: (err && err.name === 'AbortError') ? '请求超时' : ((err && err.message) || '未知错误'),
                debug: (err && err.debug) || ''
            };
        }
    }

    global.YtCore = {
        extractBalancedJson: extractBalancedJson,
        collectVideoRenderers: collectVideoRenderers,
        collectComments: collectComments,
        extractComment: extractComment,
        parseCount: parseCount,
        cleanCommentText: cleanCommentText,
        extractCfgFromHtml: extractCfgFromHtml,
        findCommentsTokenInHtml: findCommentsTokenInHtml,
        findCommentsTokenInJson: findCommentsTokenInJson,
        findTokenInNode: findTokenInNode,
        postNext: postNext,
        fetchComments: fetchComments
    };
})(typeof self !== 'undefined' ? self : this);
