// Shared polling/render logic for the "info card" overlays (Horizontal
// Left/Right, Vertical, Info Box, Compact Cover) — everything that isn't
// specific to one overlay's HTML/CSS layout. Logo.html doesn't use this;
// its offline/visibility behavior is different enough (single image,
// no title/genre/publisher/session fields) that sharing it would cost more
// clarity than it saves.
//
// Usage: include this file, then call OverlayRuntime.start({...}) — see
// each overlay's own <script> block for its exact options.
(function (global) {
  // This page is only ever loaded via /forge-overlay/<token>/<file> (or
  // the old /forge-widget/<token>/<file> path, kept working for URLs
  // pasted before the widget->overlay rename), so the token that unlocked
  // the page itself is right there in the URL — reuse it for /status and
  // /settings, which require it too.
  function getOverlayToken() {
    const parts = window.location.pathname.split("/");
    const idx =
      parts.indexOf("forge-overlay") >= 0
        ? parts.indexOf("forge-overlay")
        : parts.indexOf("forge-widget");
    return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : "";
  }

  function smoothTextUpdate(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.opacity = 0;
    setTimeout(() => {
      el.innerText = text;
      el.style.opacity = 1;
    }, 500);
  }

  function applyCoverArt(elId, url) {
    const cover = document.getElementById(elId);
    if (!cover) return;
    cover.style.opacity = 0;
    setTimeout(() => {
      // Explicitly reset every background property, not just the image —
      // the offline fallback (if it ran first, e.g. StatusForge was slow
      // to report the first real game) sets a small fixed backgroundSize/
      // backgroundPosition/backgroundRepeat via inline style, which
      // otherwise silently overrides the CSS class's "cover" sizing
      // forever, shrinking every real cover into a letterboxed thumbnail.
      cover.style.backgroundSize = "cover";
      cover.style.backgroundPosition = "center";
      cover.style.backgroundRepeat = "no-repeat";
      if (url) {
        cover.style.backgroundImage = "url(" + url + ")";
        cover.style.backgroundColor = "#111";
      } else {
        cover.style.backgroundImage = "none";
        cover.style.backgroundColor = "#050505";
      }
      cover.style.opacity = 1;
    }, 500);
  }

  // opts:
  //   hasCover: boolean — whether this layout has a cover-art element
  //   offlineIcon: { size, position } — background-size/-position for the
  //     offline fallback icon (only used when hasCover is true)
  //   ids: override any of the default element ids
  //     { root: 'w', title: 't', released: 'r', genre: 'g',
  //       publisher: 'p', session: 's', cover: 'a' }
  function start(opts) {
    opts = opts || {};
    const ids = Object.assign(
      { root: "w", title: "t", released: "r", genre: "g", publisher: "p", session: "s", cover: "a" },
      opts.ids || {}
    );

    // The Overlay Generator's picker loads every overlay in an iframe with
    // ?preview=1 so users can see what each style looks like — that's a
    // style browser, not a live stream check, so it should never fade or
    // hide itself based on the real fade timer / idle state the way an
    // actual OBS source does.
    const preview = new URLSearchParams(window.location.search).get("preview") === "1";

    let lastGame = "";
    let sessionInterval;
    let titleShownAt = 0;
    let startTime = 0;
    let pollRate = 3000;

    if (preview) {
      const w0 = document.getElementById(ids.root);
      if (w0) w0.style.opacity = "1";
    }

    function updateTimer() {
      if (!startTime) return;
      const diff = Math.floor(Date.now() / 1000) - Math.floor(startTime);
      if (diff < 0) return;
      const h = String(Math.floor(diff / 3600)).padStart(2, "0");
      const m = String(Math.floor((diff % 3600) / 60)).padStart(2, "0");
      const s = String(diff % 60).padStart(2, "0");
      const el = document.getElementById(ids.session);
      if (el) el.innerText = h + ":" + m + ":" + s;
    }

    async function initializeOverlay() {
      try {
        const url =
          "http://127.0.0.1:53735/settings?nocache=" +
          new Date().getTime() +
          "&token=" +
          encodeURIComponent(getOverlayToken());
        const setRes = await fetch(url);
        const setJson = await setRes.json();
        pollRate = (setJson.overlay_poll_rate || 3) * 1000;
      } catch (e) {}
      setInterval(pollEngine, pollRate);
      pollEngine();
    }

    async function pollEngine() {
      try {
        const url =
          "http://127.0.0.1:53735/status?nocache=" +
          new Date().getTime() +
          "&token=" +
          encodeURIComponent(getOverlayToken());
        const res = await fetch(url);
        const data = await res.json();
        const w = document.getElementById(ids.root);

        if (data.is_playing) {
          startTime = data.start_time;
          if (!sessionInterval) sessionInterval = setInterval(updateTimer, 1000);

          if (data.game_title !== lastGame) {
            lastGame = data.game_title;
            titleShownAt = Date.now();

            smoothTextUpdate(ids.title, data.game_title);
            smoothTextUpdate(ids.released, data.release_date || "UNKNOWN");
            smoothTextUpdate(ids.genre, data.genre || "GAMING");
            smoothTextUpdate(ids.publisher, data.publisher || "INDIE / UNKNOWN");

            if (opts.hasCover) {
              applyCoverArt(ids.cover, data.cover_url || "");
            }
          }

          if (preview) {
            w.style.opacity = "1";
          } else if (data.fade_timer > 0) {
            // Re-checked every poll (not just on a title change) so a
            // Settings change to the fade timer takes effect right away
            // instead of waiting for the next game switch.
            const elapsed = (Date.now() - titleShownAt) / 1000;
            w.style.opacity = elapsed >= data.fade_timer ? "0" : "1";
          } else {
            w.style.opacity = "1";
          }
        } else if (!preview) {
          w.style.opacity = "0";
          lastGame = "";
          clearInterval(sessionInterval);
          sessionInterval = null;
        }
      } catch (e) {}
    }

    // Offline fallback — instant in preview mode so the picker never shows
    // a blank gap while waiting on the normal 1.5s delay.
    setTimeout(function () {
      if (!lastGame) {
        lastGame = "__offline__";
        const w = document.getElementById(ids.root);
        w.style.opacity = "1";
        document.getElementById(ids.title).innerText = "StatusForge";
        document.getElementById(ids.released).innerText = "-";
        document.getElementById(ids.genre).innerText = "OFFLINE";
        document.getElementById(ids.publisher).innerText = "ENGINE DISCONNECTED";
        if (opts.hasCover) {
          const cover = document.getElementById(ids.cover);
          const icon = opts.offlineIcon || { size: "224px 224px", position: "center 40%" };
          cover.style.backgroundImage = "url('icon.png')";
          cover.style.backgroundSize = icon.size;
          cover.style.backgroundRepeat = "no-repeat";
          cover.style.backgroundPosition = icon.position;
          cover.style.backgroundColor = "#1a1a2e";
        }
      }
    }, preview ? 0 : 1500);

    initializeOverlay();
  }

  global.OverlayRuntime = { start: start };
})(window);
