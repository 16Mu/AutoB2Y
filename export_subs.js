// ================= 弹幕 → 字幕文件导出（SRT / VTT / ASS / XML）=================
(function () {
    const CUE_DEFAULT_SEC = 3;

    function pad(n, w) { return String(n).padStart(w || 2, '0'); }

    function fmtSrt(sec) {
        sec = Math.max(0, sec);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        const ms = Math.round((sec - Math.floor(sec)) * 1000);
        return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
    }

    function fmtVtt(sec) {
        return fmtSrt(sec).replace(',', '.');
    }

    function fmtAss(sec) {
        sec = Math.max(0, sec);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        const cs = Math.round((sec - Math.floor(sec)) * 100);
        return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
    }

    function hexToAssColor(hex) {
        let h = String(hex || '#ffffff').replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        if (!/^[0-9a-fA-F]{6}$/.test(h)) h = 'ffffff';
        const r = h.substr(0, 2), g = h.substr(2, 2), b = h.substr(4, 2);
        return `&H00${b}${g}${r}`.toUpperCase();
    }

    function escSrtText(t) { return String(t).replace(/\r?\n/g, ' ').trim(); }
    function escAssText(t) { return String(t).replace(/\r?\n/g, '\\N').replace(/\{/g, '(').replace(/\}/g, ')').trim(); }

    function normalize(comments, opts) {
        const dur = (opts && opts.duration) || 0;
        const cueSec = (opts && opts.cueSec) || CUE_DEFAULT_SEC;
        const list = (comments || [])
            .filter(c => c && typeof c.time === 'number' && isFinite(c.time) && c.text)
            .map(c => ({
                time: Math.max(0, c.time),
                text: String(c.text),
                color: c.color || '#ffffff'
            }))
            .sort((a, b) => a.time - b.time);
        return list.map(c => {
            let end = c.time + cueSec;
            if (dur > 0) end = Math.min(end, Math.max(c.time + 0.5, dur));
            return { ...c, end: end };
        });
    }

    function toSRT(comments, opts) {
        const list = normalize(comments, opts);
        return list.map((c, i) =>
            `${i + 1}\n${fmtSrt(c.time)} --> ${fmtSrt(c.end)}\n${escSrtText(c.text)}\n`
        ).join('\n');
    }

    function toVTT(comments, opts) {
        const list = normalize(comments, opts);
        const body = list.map(c =>
            `${fmtVtt(c.time)} --> ${fmtVtt(c.end)}\n${escSrtText(c.text)}\n`
        ).join('\n');
        return `WEBVTT\n\n${body}`;
    }

    function toASS(comments, opts) {
        const list = normalize(comments, opts);
        const fontSize = (opts && opts.fontSize) || 24;
        const header = [
            '[Script Info]',
            'Title: AutoB2Y Danmaku Export',
            'ScriptType: v4.00+',
            'WrapStyle: 0',
            'ScaledBorderAndShadow: yes',
            'PlayResX: 1920',
            'PlayResY: 1080',
            '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            `Style: Danmaku,Microsoft YaHei,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,7,30,30,60,1`,
            '',
            '[Events]',
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
        ].join('\n');

        const events = list.map(c => {
            const color = hexToAssColor(c.color);
            return `Dialogue: 0,${fmtAss(c.time)},${fmtAss(c.end)},Danmaku,,0,0,0,,{\\c${color}}${escAssText(c.text)}`;
        }).join('\n');

        return `${header}\n${events}\n`;
    }

    function download(filename, text, mime) {
        const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
    }

    function safeFileName(name, fallback) {
        const base = String(name || fallback || 'danmaku')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 80);
        return base || fallback || 'danmaku';
    }

    // 统一导出入口
    function exportComments(comments, opts) {
        opts = opts || {};
        const format = (opts.format || 'srt').toLowerCase();
        const base = safeFileName(opts.filename, 'danmaku');
        if (format === 'srt') download(`${base}.srt`, toSRT(comments, opts), 'application/x-subrip');
        else if (format === 'vtt') download(`${base}.vtt`, toVTT(comments, opts), 'text/vtt');
        else if (format === 'ass') download(`${base}.ass`, toASS(comments, opts), 'text/x-ssa');
        else if (format === 'xml') download(`${base}.xml`, opts.xmlStr || '', 'application/xml');
        else throw new Error('未知字幕格式: ' + format);
    }

    window.B2YExport = { exportComments, toSRT, toVTT, toASS, download, fmtSrt, fmtVtt };
})();
