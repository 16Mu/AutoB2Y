
function injectBiliToYt() {
    if(document.getElementById('b2y-to-yt-btn')) return;
    
    let titleEl = document.querySelector('.video-title') || document.querySelector('.tit');
    if(!titleEl) return;

    let btn = document.createElement('a');
    btn.id = 'b2y-to-yt-btn';
    btn.innerHTML = '🌐 去 YouTube 找原片';
    btn.style.cssText = 'display:inline-block; margin-left:15px; font-size:14px; padding:4px 8px; background:#ff0000; color:white; border-radius:4px; text-decoration:none; vertical-align:middle; cursor:pointer;';
    btn.onclick = () => {
        let t = document.querySelector('.video-title')?.innerText || document.querySelector('.tit')?.innerText || document.title;
        window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(t)}`, '_blank');
    };
    titleEl.appendChild(btn);
}
setInterval(injectBiliToYt, 2000);
