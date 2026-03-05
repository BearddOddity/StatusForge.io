/* === Global & Setup === */
let lastGame = "";
let sessionInterval;
let widgetFadeTimer = null; 
let startTime = 0;
let pollRate = 3000;
let lastKnownPulse = 0;

// Widget (Pull poll rate from public status engine)
async function initializeWidget() {
    try {
        const url = 'http://127.0.0.1:5050/status?nocache=' + new Date().getTime();
        const setRes = await fetch(url);
        const setJson = await setRes.json();
        pollRate = (setJson.widget_poll_rate || 3) * 1000;
    } catch(e) {
        console.warn("Could not fetch poll rate, defaulting to 3s.");
    }
    setInterval(pollEngine, pollRate);
    pollEngine();
}

/* === WIDGET DISPLAY LOGIC === */
async function pollEngine() {
    try {
        const url = 'http://127.0.0.1:5050/status?nocache=' + new Date().getTime();
        const res = await fetch(url);
        const data = await res.json();
        const w = document.getElementById("w"); 

        if (data.is_playing) {
            startTime = data.start_time;
            if (!sessionInterval) sessionInterval = setInterval(updateTimer, 1000);
            
            // Re-animate and reset fade
            if (data.game_title !== lastGame) {
                lastGame = data.game_title;
                if (widgetFadeTimer) clearTimeout(widgetFadeTimer);
                w.style.opacity = "1";
                
                smoothTextUpdate("t", data.game_title); 
                smoothTextUpdate("r", data.release_date || "UNKNOWN");
                smoothTextUpdate("g", data.genre || "GAMING");
                
                let studioText = data.developer || "INDIE";
                if (data.publisher && data.publisher !== data.developer) studioText += ` / ${data.publisher}`;
                smoothTextUpdate("p", studioText); 
                
                applyCoverArt(data.cover_url || '');
                resetFadeTimer(w, data.fade_timer);
            }
            		
            if (data.last_pulse > lastKnownPulse) {
                lastKnownPulse = data.last_pulse;
                if (widgetFadeTimer) clearTimeout(widgetFadeTimer);
                w.style.opacity = "1";
                resetFadeTimer(w, data.fade_timer);
            }

        } else {
            w.style.opacity = "0"; 
            lastGame = "";
            clearInterval(sessionInterval);
            sessionInterval = null;
            if (widgetFadeTimer) clearTimeout(widgetFadeTimer);
        }
    } catch(e) {}
}

function resetFadeTimer(widgetElement, fadeTimerSettings) {
    if (fadeTimerSettings > 0) {
        widgetFadeTimer = setTimeout(() => {
            widgetElement.style.opacity = "0";
        }, fadeTimerSettings * 1000);
    }
}

function smoothTextUpdate(id, text) {
    const el = document.getElementById(id);
    if(!el) return;
    el.style.opacity = 0;
    setTimeout(() => { el.innerText = text; el.style.opacity = 1; }, 500); 
}

function applyCoverArt(url) {
    const cover = document.getElementById('a');
    if(!cover) return;
    cover.style.opacity = 0;
    setTimeout(() => {
        if(url) {
            cover.style.backgroundImage = `url('${url}')`;
            cover.style.backgroundColor = '#111';
        } else {
            cover.style.backgroundImage = 'none';
            cover.style.backgroundColor = '#050505'; 
        }
        cover.style.opacity = 1;
    }, 500);
}

function updateTimer() {
    if (!startTime) return;
    const diff = Math.floor(Date.now() / 1000) - Math.floor(startTime);
    if (diff < 0) return;
    const h = String(Math.floor(diff / 3600)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    const el = document.getElementById("s"); 
    if (el) el.innerText = `⏱️ ${h}:${m}:${s}`;
}

// Start polling
initializeWidget();