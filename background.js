chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'autoMatch') {
        doAutoMatch(request.keyword, request.duration).then(sendResponse);
        return true; 
    }
    if (request.action === 'manualMatch') {
        doManualMatch(request.bvid).then(sendResponse);
        return true;
    }
});

function timeToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
}

async function doAutoMatch(keyword, ytDuration) {
    try {
        let searchRes = await fetch(`https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}`);
        let searchData = await searchRes.json();
        
        if (searchData.code !== 0) return { success: false, error: searchData.code === -412 ? '触发风控拦截(-412)' : `API拒绝: ${searchData.message}` };
        if (!searchData.data || !searchData.data.result || searchData.data.result.length === 0) return { success: false, error: '未搜索到B站原片' };
        
        let results = searchData.data.result;
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
        return await fetchAndParseDanmaku(bvid, title, isPerfectMatch);
    } catch (e) { return { success: false, error: `网络错误` }; }
}

async function doManualMatch(bvid) {
    return await fetchAndParseDanmaku(bvid, "手动指定的视频", true);
}

async function fetchAndParseDanmaku(bvid, title, isPerfectMatch) {
    try {
        let pageRes = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`);
        let pageData = await pageRes.json();
        if (pageData.code !== 0) return { success: false, error: `获取分P失败` };
        
        let cid = pageData.data[0].cid;
        let dmRes = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`);
        let xmlStr = await dmRes.text();
        
        return { success: true, xmlStr: xmlStr, bilibiliTitle: title, bvid: bvid, isPerfectMatch: isPerfectMatch };
    } catch (e) { return { success: false, error: `拉取弹幕失败` }; }
}
