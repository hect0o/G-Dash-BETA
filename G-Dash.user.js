// ==UserScript==
// @name         G-Dash
// @namespace    https://github.com/hect0o
// @version      1.0.0
// @description  Tablet-style dashboard for GeoFS — live map, flight logbook, multi-pilot support
// @author       hecto.oooo
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/hect0o/G-Dash-BETA/refs/heads/main/G-Dash.user.js
// @updateURL    https://raw.githubusercontent.com/hect0o/G-Dash-BETA/refs/heads/main/G-Dash.user.js
// @run-at       document-idle

// ==/UserScript==

(function () {
  'use strict';


  const DASHBOARD_NAME = 'G-Dash';

  const MAP_TILE_URL         = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const MAP_TILE_ATTRIBUTION = '© OpenStreetMap contributors';

  // Toggle button — SVG, emoji, or '<img src="URL">'
  const TOGGLE_BUTTON_CONTENT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="26" height="26">
    <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
  </svg>`;

  // Accent color: #00c8ff cyan | #00ff88 green | #ff9500 amber | #c084fc purple
  const ACCENT_COLOR = '#00c8ff';

  // ════════════════════════════════════════════════════════════════════════════
  //  🔥  FIREBASE CONFIG
  // ════════════════════════════════════════════════════════════════════════════
  const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyCEpPgpxeBunGfGCrLBl9NkIdSJ4yEGrlQ",
    authDomain:        "geo-fs-dashboard.firebaseapp.com",
    projectId:         "geo-fs-dashboard",
    storageBucket:     "geo-fs-dashboard.firebasestorage.app",
    messagingSenderId: "803779500111",
    appId:             "1:803779500111:web:9a535352aea51c6c68b23a"
  };

  // ════════════════════════════════════════════════════════════════════════════
  //  PILOT ID — unique per browser, auto-generated on first run
  // ════════════════════════════════════════════════════════════════════════════
  function getPilotId() {
    const KEY = 'gfs_pilot_id';
    let id = localStorage.getItem(KEY);
    if (!id) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let s = '';
      for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
      id = 'PILOT-' + s;
      localStorage.setItem(KEY, id);
    }
    return id;
  }
  function getPilotJoinDate() {
    const KEY = 'gfs_pilot_joined';
    let d = localStorage.getItem(KEY);
    if (!d) { d = new Date().toISOString(); localStorage.setItem(KEY, d); }
    return d;
  }

  const PILOT_ID  = getPilotId();
  const JOIN_DATE = getPilotJoinDate();

  // ════════════════════════════════════════════════════════════════════════════
  //  STATE
  // ════════════════════════════════════════════════════════════════════════════
  let map = null, planeMarker = null, flightPath = null;
  let flightPathCoords = [], activeTab = 'map', db = null;
  let flightStartTime = null, flightActive = false, totalFlightSecs = 0;
  let timerInterval = null, posInterval = null, currentFlightId = null;
  let allFlights = [], lastPosition = null;
  let totalDistNm = 0, maxAlt = 0, maxSpd = 0;
  let currentHeading = 0; // track heading separately for reliable rotation

  // ════════════════════════════════════════════════════════════════════════════
  //  LIBRARY LOADERS
  // ════════════════════════════════════════════════════════════════════════════
  function loadScript(src) {
    return new Promise(res => {
      const s = document.createElement('script');
      s.src = src; s.onload = res;
      document.head.appendChild(s);
    });
  }
  async function loadFirebase() {
    if (window.firebase?.firestore) return;
    await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
    await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js');
  }
  async function loadLeaflet() {
    if (window.L) return;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  GEOFS DATA READER
  //  Confirmed via console scan: ac.animationValue.heading is ALREADY in
  //  degrees 0-360 clockwise from North. No conversion needed.
  // ════════════════════════════════════════════════════════════════════════════
  function getPlaneData() {
    try {
      const ac = window.geofs?.aircraft?.instance;
      if (!ac) return null;
      const coords = ac.llaLocation;
      if (!coords || coords[0] == null) return null;

      // heading is in degrees 0-360, directly usable
      const headingDeg = ac.animationValue?.heading ?? 0;

      const speedKts = ac.animationValue?.kias != null
        ? ac.animationValue.kias
        : (ac.groundSpeed ? ac.groundSpeed * 1.94384 : 0);

      return {
        lat:      coords[0],
        lon:      coords[1],
        altFt:    coords[2] ? parseFloat((coords[2] * 3.28084).toFixed(0)) : 0,
        speedKts: parseFloat(speedKts.toFixed(1)),
        heading:  parseFloat(headingDeg.toFixed(1))
      };
    } catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ════════════════════════════════════════════════════════════════════════════
  function haversineNm(la1, lo1, la2, lo2) {
    const R = 3440.065, r = Math.PI / 180;
    const dLat = (la2-la1)*r, dLon = (lo2-lo1)*r;
    const a = Math.sin(dLat/2)**2 + Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  function hhmmss(sec) {
    const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
      + '  ' + d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  }
  function compassDir(deg) {
    const dirs = ['N','NE','E','SE','S','SW','W','NW'];
    return dirs[Math.round(deg / 45) % 8];
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STYLES
  // ════════════════════════════════════════════════════════════════════════════
  function injectStyles() {
    const A = ACCENT_COLOR;
    const style = document.createElement('style');
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600&display=swap');

      /* ── Floating toggle button ── */
      #gfs-btn {
        position:fixed; bottom:26px; right:26px; z-index:99999;
        width:54px; height:54px; border-radius:14px;
        background:#0b1a28; border:2px solid ${A}; color:${A};
        cursor:pointer; display:flex; align-items:center; justify-content:center;
        box-shadow:0 0 18px ${A}55,0 6px 24px #00000088;
        transition:transform .2s,box-shadow .2s;
      }
      #gfs-btn:hover { transform:scale(1.09); box-shadow:0 0 32px ${A}99,0 6px 30px #000000bb; }

      /* ── Backdrop ── */
      #gfs-overlay {
        position:fixed; inset:0; z-index:99998;
        display:flex; align-items:center; justify-content:center;
        background:rgba(0,5,14,0.80); backdrop-filter:blur(8px);
      }

      /* ── Tablet ── */
      #gfs-tablet {
        width:56vw; max-width:920px; min-width:590px;
        height:80vh; max-height:790px; min-height:510px;
        background:#07101c; border-radius:26px;
        border:2px solid #1e3d58;
        box-shadow:0 0 0 5px #0a1928,0 0 0 7px #1e3d58,
                   0 36px 100px #000000e8,0 0 80px ${A}0e;
        display:flex; flex-direction:column; overflow:hidden;
        font-family:'Inter',sans-serif;
        animation:gfs-pop .32s cubic-bezier(.22,1,.36,1);
      }
      @keyframes gfs-pop {
        from{transform:translateY(38px) scale(.96);opacity:0}
        to{transform:none;opacity:1}
      }

      /* ── Top bar ── */
      #gfs-topbar {
        display:flex; align-items:center; justify-content:space-between;
        padding:12px 22px; background:#06101b;
        border-bottom:1.5px solid #1e3d58; flex-shrink:0; gap:10px;
      }
      #gfs-logo {
        display:flex; align-items:center; gap:9px;
        font-family:'Orbitron',monospace; font-weight:900;
        font-size:13px; letter-spacing:3px; color:${A};
        white-space:nowrap;
      }
      #gfs-pilot-badge {
        flex:1; display:flex; align-items:center;
        justify-content:center; gap:9px;
      }
      #gfs-pilot-label {
        font-size:12px; font-weight:500; color:#7fb3cc; letter-spacing:1px;
      }
      #gfs-pilot-chip {
        font-family:'Orbitron',monospace; font-size:11px; font-weight:700;
        color:${A}; letter-spacing:2px;
        background:${A}1c; border:1px solid ${A}55;
        padding:4px 12px; border-radius:7px;
      }
      #gfs-dot {
        width:8px; height:8px; border-radius:50%;
        background:#00ff88; box-shadow:0 0 9px #00ff88;
        animation:blink 2.2s ease infinite;
      }
      @keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
      #gfs-close {
        width:30px; height:30px; border-radius:8px; cursor:pointer;
        background:rgba(255,65,65,.1); border:1.5px solid rgba(255,65,65,.3);
        color:#ff7777; font-size:15px;
        display:flex; align-items:center; justify-content:center;
        transition:background .15s,border-color .15s;
      }
      #gfs-close:hover{background:rgba(255,65,65,.28);border-color:#ff6666;}

      /* ── Tabs ── */
      #gfs-tabs {
        display:flex; background:#050e1a;
        border-bottom:1.5px solid #1e3d58;
        padding:0 20px; flex-shrink:0;
      }
      .gfs-tab {
        padding:11px 30px; cursor:pointer; user-select:none;
        font-family:'Orbitron',monospace; font-size:10px; font-weight:700; letter-spacing:2.5px;
        color:#4a7a9a; border-bottom:2.5px solid transparent;
        display:flex; align-items:center; gap:7px;
        transition:color .18s,border-color .18s;
      }
      .gfs-tab:hover{color:#a0d4e8;}
      .gfs-tab.active{color:${A};border-bottom-color:${A};}

      /* ── Panels ── */
      #gfs-content{flex:1;position:relative;overflow:hidden;}
      .gfs-panel{position:absolute;inset:0;display:none;}
      .gfs-panel.active{display:flex;flex-direction:column;}

      /* ── Map ── */
      #gfs-map{width:100%;height:100%;}
      .leaflet-container{background:#0a1520 !important;}

      /* ── HUD ── */
      #gfs-hud {
        position:absolute; top:14px; left:14px; z-index:500;
        background:rgba(4,9,18,.94); border:1.5px solid #1e3d58;
        border-radius:13px; padding:14px 18px; min-width:210px;
        backdrop-filter:blur(8px); box-shadow:0 8px 30px #000000cc;
      }
      .hud-title {
        font-family:'Orbitron',monospace; font-size:9px; font-weight:700;
        letter-spacing:3px; color:#5a8aa8; margin-bottom:12px;
        text-transform:uppercase;
      }
      .hud-row {
        display:flex; justify-content:space-between;
        align-items:center; gap:14px; margin-bottom:8px;
      }
      .hud-lbl {
        font-size:12px; font-weight:600; color:#7fb3cc; letter-spacing:.5px;
      }
      .hud-val {
        font-family:'Orbitron',monospace; font-size:15px;
        font-weight:700; letter-spacing:.5px; color:${A};
      }
      .hud-val.g{color:#00ff88;}
      .hud-val.y{color:#ffb800;}

      /* Heading compass strip */
      #hud-hdg-wrap {
        margin-top:10px; padding-top:10px;
        border-top:1px solid #1e3d58;
        display:flex; align-items:center; gap:8px;
      }
      #hud-hdg-compass {
        flex:1; background:#0a1928; border-radius:6px;
        height:22px; overflow:hidden; position:relative;
        border:1px solid #1e3d58;
      }
      #hud-hdg-tape {
        position:absolute; top:0; left:0;
        height:100%; white-space:nowrap;
        font-family:'Orbitron',monospace; font-size:8px; font-weight:700;
        color:#5a8aa8; display:flex; align-items:center;
        transition:transform .3s ease;
      }
      .hdg-tick {
        display:inline-flex; flex-direction:column;
        align-items:center; width:20px; flex-shrink:0;
        font-size:7px; color:#4a7a9a; padding-top:2px;
      }
      .hdg-tick.major { color:#aad0e8; font-size:8px; }
      .hdg-tick-line {
        width:1px; height:6px; background:#1e3d58; margin-bottom:2px;
      }
      .hdg-tick.major .hdg-tick-line { background:#3a6a88; height:9px; }
      #hud-hdg-cursor {
        position:absolute; top:0; left:50%; transform:translateX(-50%);
        width:2px; height:100%; background:${A}; opacity:.9;
        box-shadow:0 0 5px ${A};
      }
      #hud-hdg-cur-val {
        font-family:'Orbitron',monospace; font-size:13px; font-weight:700;
        color:${A}; min-width:52px; text-align:right; letter-spacing:.5px;
      }
      #hud-hdg-dir {
        font-family:'Orbitron',monospace; font-size:11px;
        font-weight:700; color:#ffb800; min-width:24px;
      }

      /* ── Center button ── */
      #gfs-center {
        position:absolute; bottom:16px; right:16px; z-index:500;
        width:40px; height:40px; border-radius:10px;
        background:rgba(4,9,18,.94); border:1.5px solid #1e3d58;
        color:${A}; font-size:20px; cursor:pointer;
        display:flex; align-items:center; justify-content:center;
        transition:border-color .18s,background .18s;
      }
      #gfs-center:hover{border-color:${A};background:${A}1c;}

      /* ── Stats scroll area ── */
      #gfs-stats-body {
        padding:18px 24px; overflow-y:auto; flex:1;
        scrollbar-width:thin; scrollbar-color:#1e3d58 transparent;
      }
      #gfs-stats-body::-webkit-scrollbar{width:4px;}
      #gfs-stats-body::-webkit-scrollbar-thumb{background:#1e3d58;border-radius:4px;}

      /* Section titles */
      .sec {
        font-family:'Orbitron',monospace; font-size:9px; font-weight:700;
        letter-spacing:3px; color:#5a8aa8; text-transform:uppercase;
        margin:4px 0 14px; display:flex; align-items:center; gap:9px;
      }
      .sec::after{
        content:'';flex:1;height:1px;
        background:linear-gradient(90deg,#1e3d58 0%,transparent 100%);
      }

      /* Pilot card */
      #gfs-pilot-card {
        display:flex; align-items:center; gap:18px;
        background:#091624; border:1.5px solid #1e3d58;
        border-radius:13px; padding:15px 18px; margin-bottom:20px;
      }
      #gfs-pilot-avatar {
        width:48px; height:48px; border-radius:12px;
        background:${A}1a; border:2px solid ${A}55;
        display:flex; align-items:center; justify-content:center;
        font-size:24px; flex-shrink:0;
      }
      .pc-id {
        font-family:'Orbitron',monospace; font-size:15px;
        font-weight:700; color:${A}; letter-spacing:2.5px; margin-bottom:5px;
      }
      .pc-sub {
        font-size:12px; font-weight:500; color:#6da8c4; letter-spacing:.4px; line-height:1.9;
      }
      .pc-sub span{color:#a0d0e4; font-weight:600;}

      /* Session row */
      #gfs-session {
        display:flex; align-items:center; gap:14px;
        background:${A}08; border:1.5px solid #1e3d58;
        border-radius:13px; padding:15px 20px; margin-bottom:20px;
      }
      #gfs-timer {
        font-family:'Orbitron',monospace; font-size:32px;
        font-weight:700; color:${A}; letter-spacing:3px; flex:1;
        transition:color .3s,text-shadow .3s;
      }
      #gfs-timer.live{color:#00ff88;text-shadow:0 0 18px #00ff8855;}

      /* Action buttons */
      .gfs-btn {
        padding:10px 22px; border-radius:9px; border:none; cursor:pointer;
        font-family:'Orbitron',monospace; font-size:10px;
        letter-spacing:2px; text-transform:uppercase; transition:all .18s;
        font-weight:700;
      }
      .btn-start{
        background:linear-gradient(135deg,#00a844,#00ff88);
        color:#04110a; box-shadow:0 0 14px #00ff8844;
      }
      .btn-start:hover{box-shadow:0 0 26px #00ff8877;transform:scale(1.05);}
      .btn-land{
        background:linear-gradient(135deg,#c0392b,#e74c3c);
        color:#fff; box-shadow:0 0 14px #e74c3c44;
      }
      .btn-land:hover{box-shadow:0 0 26px #e74c3c77;transform:scale(1.05);}
      .gfs-btn:disabled{opacity:.3;cursor:not-allowed;transform:none !important;box-shadow:none !important;}

      /* Stat cards */
      .s-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin-bottom:22px;}
      .s-card{
        background:#091624; border:1.5px solid #1e3d58;
        border-radius:13px; padding:14px 16px; transition:border-color .2s;
      }
      .s-card:hover{border-color:#3a6a88;}
      .s-lbl{
        font-size:11px; font-weight:600; color:#6da8c4; letter-spacing:.8px;
        text-transform:uppercase; margin-bottom:7px;
      }
      .s-val{
        font-family:'Orbitron',monospace; font-size:20px;
        font-weight:700; color:${A}; line-height:1;
      }
      .s-unit{font-size:11px;font-weight:500;color:#6da8c4;letter-spacing:.5px;margin-top:5px;}

      /* Log table */
      #gfs-log-tbl{width:100%;border-collapse:collapse;}
      #gfs-log-tbl th{
        font-family:'Orbitron',monospace; font-size:8.5px; font-weight:700;
        letter-spacing:2px; color:#6da8c4; text-align:left;
        padding:9px 10px; border-bottom:1.5px solid #1e3d58; text-transform:uppercase;
      }
      #gfs-log-tbl td{
        padding:10px 10px; border-bottom:1px solid #0e1f30;
        color:#c0dce8; vertical-align:middle; font-size:12px; font-weight:500;
      }
      #gfs-log-tbl tr:hover td{background:${A}08;}
      .td-dur{font-family:'Orbitron',monospace;font-size:12.5px;color:${A};font-weight:700;}
      .td-date{color:#6da8c4;font-size:11px;}
      .td-num{color:#4a7a9a;font-size:11px;}
      .bdg{
        display:inline-block;padding:3px 9px;border-radius:5px;
        font-size:10px;letter-spacing:.5px;
        font-family:'Orbitron',monospace;font-weight:700;
      }
      .bdg-c{background:${A}18;color:${A};border:1px solid ${A}44;}
      .bdg-g{background:#00ff8818;color:#00ff88;border:1px solid #00ff8844;}

      /* Delete button in table */
      .del-btn{
        background:none; border:1px solid rgba(255,80,80,.3);
        color:#ff8888; border-radius:5px; padding:3px 8px;
        font-size:11px; cursor:pointer; transition:all .15s;
        font-family:'Inter',sans-serif; font-weight:600;
      }
      .del-btn:hover{background:rgba(255,80,80,.18);border-color:#ff6666;color:#ffaaaa;}

      /* Confirm delete modal */
      #gfs-confirm-modal {
        position:absolute; inset:0; z-index:600;
        display:none; align-items:center; justify-content:center;
        background:rgba(0,5,14,.75); backdrop-filter:blur(6px);
      }
      #gfs-confirm-box {
        background:#091624; border:1.5px solid #1e3d58;
        border-radius:16px; padding:28px 32px; max-width:320px; width:90%;
        text-align:center; box-shadow:0 20px 60px #000000cc;
      }
      #gfs-confirm-box h3 {
        font-family:'Orbitron',monospace; font-size:13px; font-weight:700;
        color:#ff8888; letter-spacing:2px; margin:0 0 10px;
      }
      #gfs-confirm-box p {
        font-size:13px; font-weight:500; color:#a0c8dc; margin:0 0 22px; line-height:1.6;
      }
      #gfs-confirm-box .confirm-actions{display:flex;gap:10px;justify-content:center;}
      .confirm-yes{
        padding:9px 24px; border-radius:8px; border:none; cursor:pointer;
        background:linear-gradient(135deg,#c0392b,#e74c3c);
        color:#fff; font-family:'Orbitron',monospace;
        font-size:9px; font-weight:700; letter-spacing:2px;
      }
      .confirm-no{
        padding:9px 24px; border-radius:8px; cursor:pointer;
        background:transparent; border:1.5px solid #1e3d58;
        color:#7fb3cc; font-family:'Orbitron',monospace;
        font-size:9px; font-weight:700; letter-spacing:2px;
      }

      #gfs-empty{
        text-align:center;padding:32px 0;
        color:#5a8aa8;font-size:13px;font-weight:500;
        letter-spacing:1px;line-height:2.2;
      }
      #gfs-empty strong{
        display:block;font-size:14px;font-weight:700;
        color:#8ab8d0;margin-bottom:6px;letter-spacing:1.5px;
      }

      /* Footer */
      #gfs-footer{
        display:flex;align-items:center;justify-content:space-between;
        padding:7px 22px;background:#050e1a;
        border-top:1px solid #1e3d58;flex-shrink:0;
      }
      #gfs-coords{font-size:11px;font-weight:500;color:#4a7a9a;letter-spacing:.8px;}
      #gfs-utc{font-family:'Orbitron',monospace;font-size:10px;color:#2a5a7a;letter-spacing:2px;}
    `;
    document.head.appendChild(style);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  BUILD DOM
  // ════════════════════════════════════════════════════════════════════════════
  function buildHeadingTape() {
    // Build a wide tape: 0–360 degrees, each tick = 20px wide
    // We'll render 0-359 twice (0-719) so we can loop seamlessly
    let html = '';
    for (let i = 0; i < 720; i++) {
      const deg = i % 360;
      const isMajor = deg % 30 === 0;
      const label = isMajor
        ? (deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : deg === 270 ? 'W' : String(deg))
        : '';
      html += `<span class="hdg-tick${isMajor?' major':''}">
        <span class="hdg-tick-line"></span>${label}
      </span>`;
    }
    return html;
  }

  function buildDOM() {
    const btn = document.createElement('button');
    btn.id = 'gfs-btn'; btn.title = 'Open G-Dash';
    btn.innerHTML = TOGGLE_BUTTON_CONTENT;
    document.body.appendChild(btn);

    const ov = document.createElement('div');
    ov.id = 'gfs-overlay'; ov.style.display = 'none';
    ov.innerHTML = `
      <div id="gfs-tablet">

        <div id="gfs-topbar">
          <div id="gfs-logo">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
            </svg>
            ${DASHBOARD_NAME}
          </div>
          <div id="gfs-pilot-badge">
            <span id="gfs-pilot-label">PILOT ID</span>
            <span id="gfs-pilot-chip">${PILOT_ID}</span>
            <div id="gfs-dot"></div>
          </div>
          <button id="gfs-close">✕</button>
        </div>

        <div id="gfs-tabs">
          <div class="gfs-tab active" data-tab="map">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
              <line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/>
            </svg>
            LIVE MAP
          </div>
          <div class="gfs-tab" data-tab="stats">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="20" x2="18" y2="10"/>
              <line x1="12" y1="20" x2="12" y2="4"/>
              <line x1="6" y1="20" x2="6" y2="14"/>
            </svg>
            LOGBOOK
          </div>
        </div>

        <div id="gfs-content">

          <!-- MAP PANEL -->
          <div class="gfs-panel active" id="gfs-panel-map">
            <div style="flex:1;position:relative;overflow:hidden;">
              <div id="gfs-map"></div>
              <div id="gfs-hud">
                <div class="hud-title">◈ Live Instruments</div>
                <div class="hud-row">
                  <span class="hud-lbl">Altitude</span>
                  <span class="hud-val" id="h-alt">— ft</span>
                </div>
                <div class="hud-row">
                  <span class="hud-lbl">Airspeed</span>
                  <span class="hud-val g" id="h-spd">— kts</span>
                </div>
                <div id="hud-hdg-wrap">
                  <div id="hud-hdg-compass">
                    <div id="hud-hdg-tape">${buildHeadingTape()}</div>
                    <div id="hud-hdg-cursor"></div>
                  </div>
                  <div id="hud-hdg-cur-val">—°</div>
                  <div id="hud-hdg-dir">—</div>
                </div>
              </div>
              <button id="gfs-center" title="Center on aircraft">✈</button>
            </div>
          </div>

          <!-- LOGBOOK PANEL -->
          <div class="gfs-panel" id="gfs-panel-stats">
            <div id="gfs-stats-body">

              <div class="sec">◈ Pilot Profile</div>
              <div id="gfs-pilot-card">
                <div id="gfs-pilot-avatar">✈</div>
                <div>
                  <div class="pc-id">${PILOT_ID}</div>
                  <div class="pc-sub">
                    Member since <span id="pi-joined">—</span><br>
                    Unique device ID · Saved to this browser
                  </div>
                </div>
              </div>

              <div class="sec">◈ Current Session</div>
              <div id="gfs-session">
                <div id="gfs-timer">00:00:00</div>
                <button class="gfs-btn btn-start" id="gfs-start">Depart</button>
                <button class="gfs-btn btn-land"  id="gfs-land" disabled>Land</button>
              </div>

              <div class="sec">◈ This Flight</div>
              <div class="s-grid">
                <div class="s-card">
                  <div class="s-lbl">Distance</div>
                  <div class="s-val" id="sf-dist">0.0</div>
                  <div class="s-unit">Nautical Miles</div>
                </div>
                <div class="s-card">
                  <div class="s-lbl">Max Altitude</div>
                  <div class="s-val" id="sf-alt">0</div>
                  <div class="s-unit">Feet</div>
                </div>
                <div class="s-card">
                  <div class="s-lbl">Max Speed</div>
                  <div class="s-val" id="sf-spd">0</div>
                  <div class="s-unit">Knots</div>
                </div>
              </div>

              <div class="sec">◈ All-Time Totals</div>
              <div class="s-grid">
                <div class="s-card">
                  <div class="s-lbl">Flights Logged</div>
                  <div class="s-val" id="at-flights">—</div>
                  <div class="s-unit">Flights</div>
                </div>
                <div class="s-card">
                  <div class="s-lbl">Total Air Time</div>
                  <div class="s-val" id="at-time" style="font-size:15px">—</div>
                  <div class="s-unit">HH : MM : SS</div>
                </div>
                <div class="s-card">
                  <div class="s-lbl">Total Distance</div>
                  <div class="s-val" id="at-dist">—</div>
                  <div class="s-unit">Nautical Miles</div>
                </div>
              </div>

              <div class="sec">◈ Flight Logbook</div>
              <div id="gfs-empty">
                <strong>No Flights Logged Yet</strong>
                Press Depart above to start tracking your flight
              </div>
              <table id="gfs-log-tbl" style="display:none">
                <thead><tr>
                  <th>#</th><th>Date &amp; Time</th><th>Duration</th>
                  <th>Distance</th><th>Max Alt</th><th>Max Spd</th><th></th>
                </tr></thead>
                <tbody id="gfs-log-body"></tbody>
              </table>

            </div>

            <!-- Delete confirm modal (inside stats panel) -->
            <div id="gfs-confirm-modal">
              <div id="gfs-confirm-box">
                <h3>⚠ Delete Flight?</h3>
                <p>This flight log will be permanently removed from your logbook.</p>
                <div class="confirm-actions">
                  <button class="confirm-yes" id="confirm-yes-btn">Delete</button>
                  <button class="confirm-no"  id="confirm-no-btn">Cancel</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div id="gfs-footer">
          <div id="gfs-coords">LAT  —  |  LON  —</div>
          <div id="gfs-utc">G-DASH</div>
        </div>
      </div>
    `;
    document.body.appendChild(ov);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  HEADING TAPE UPDATE
  //  Each degree = 20px. The tape is 720 ticks (0-359 repeated twice).
  //  We offset by half the tape width (360*20 = 7200px) to start at center,
  //  then subtract heading * 20px to scroll the right degree to center.
  // ════════════════════════════════════════════════════════════════════════════
  const TICK_PX = 20; // pixels per degree on the tape

  function updateHeadingTape(heading) {
    const tape = document.getElementById('hud-hdg-tape');
    const valEl = document.getElementById('hud-hdg-cur-val');
    const dirEl = document.getElementById('hud-hdg-dir');
    if (!tape) return;

    // Center the tape: offset = -(heading * TICK_PX) + (compass width / 2 - tick width / 2)
    // We shift by -heading ticks from the start of the second loop (360 ticks in)
    const offset = -(360 + heading) * TICK_PX;
    tape.style.transform = `translateX(${offset}px)`;

    valEl.textContent = `${Math.round(heading).toString().padStart(3,'0')}°`;
    dirEl.textContent = compassDir(heading);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  MAP INIT  — real detailed plane icon, rotation via CSS transform
  // ════════════════════════════════════════════════════════════════════════════
  function initMap() {
    if (map) return;
    map = L.map('gfs-map', { center:[20,0], zoom:4, attributionControl:false });
    L.tileLayer(MAP_TILE_URL, { maxZoom:19, minZoom:2 }).addTo(map);

    const A = ACCENT_COLOR;

    // Detailed top-down plane SVG — nose pointing UP (North = 0°)
    // Rotation is applied via CSS transform on the container div, not the SVG,
    // so Leaflet's positioning is unaffected.
    const iconHtml = `
      <div id="plane-container" style="
        width:40px;height:40px;
        display:flex;align-items:center;justify-content:center;
        transform:rotate(0deg);
        transform-origin:center center;
        transition:transform 0.4s ease;
        filter:drop-shadow(0 0 5px ${A}aa);
      ">
        <svg viewBox="-12 -20 24 40" width="40" height="40" xmlns="http://www.w3.org/2000/svg">
          <!-- Fuselage -->
          <ellipse cx="0" cy="-2" rx="2.8" ry="14" fill="${A}" opacity=".95"/>
          <!-- Nose cone -->
          <ellipse cx="0" cy="-15" rx="2" ry="4" fill="white" opacity=".9"/>
          <!-- Wings -->
          <path d="M0,-3 L-11,8 L-9,10 L0,5 L9,10 L11,8 Z" fill="${A}" opacity=".85"/>
          <!-- Tail fins -->
          <path d="M0,9 L-5,16 L-3.5,17 L0,13 L3.5,17 L5,16 Z" fill="${A}" opacity=".75"/>
          <!-- Cockpit window -->
          <ellipse cx="0" cy="-11" rx="1.4" ry="2.2" fill="#00ffff" opacity=".6"/>
          <!-- Engine pods -->
          <ellipse cx="-6.5" cy="4" rx="1.4" ry="3.5" fill="${A}" opacity=".7"/>
          <ellipse cx="6.5"  cy="4" rx="1.4" ry="3.5" fill="${A}" opacity=".7"/>
        </svg>
      </div>`;

    planeMarker = L.marker([20,0], {
      icon: L.divIcon({
        html: iconHtml,
        iconSize:   [40, 40],
        iconAnchor: [20, 20],
        className:  ''
      })
    }).addTo(map);

    flightPath = L.polyline([], {
      color:A, weight:2.5, opacity:.5, dashArray:'7,5'
    }).addTo(map);

    document.getElementById('gfs-center').addEventListener('click', () => {
      if (lastPosition) map.setView([lastPosition.lat, lastPosition.lon], Math.max(map.getZoom(), 8));
    });
  }

  // Rotate the plane icon container via CSS transform
  function rotatePlane(heading) {
    const el = planeMarker?.getElement();
    if (!el) return;
    const container = el.querySelector('#plane-container');
    if (container) container.style.transform = `rotate(${heading}deg)`;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  POSITION LOOP
  // ════════════════════════════════════════════════════════════════════════════
  function startPositionLoop() {
    if (posInterval) return;
    posInterval = setInterval(() => {
      const d = getPlaneData();
      if (!d) return;
      lastPosition = d;
      currentHeading = d.heading;

      // HUD
      document.getElementById('h-alt').textContent = `${d.altFt.toLocaleString()} ft`;
      document.getElementById('h-spd').textContent = `${d.speedKts} kts`;
      updateHeadingTape(d.heading);

      // Footer
      document.getElementById('gfs-coords').textContent =
        `LAT  ${d.lat.toFixed(5)}  |  LON  ${d.lon.toFixed(5)}`;

      // Map
      planeMarker?.setLatLng([d.lat, d.lon]);
      rotatePlane(d.heading);

      // Flight tracking
      if (flightActive) {
        if (flightPathCoords.length > 0) {
          const [pLat, pLon] = flightPathCoords[flightPathCoords.length - 1];
          totalDistNm += haversineNm(pLat, pLon, d.lat, d.lon);
        }
        flightPathCoords.push([d.lat, d.lon]);
        flightPath?.setLatLngs(flightPathCoords);
        if (d.altFt    > maxAlt) maxAlt = d.altFt;
        if (d.speedKts > maxSpd) maxSpd = d.speedKts;

        document.getElementById('sf-dist').textContent = totalDistNm.toFixed(1);
        document.getElementById('sf-alt').textContent  = maxAlt.toLocaleString();
        document.getElementById('sf-spd').textContent  = maxSpd.toFixed(0);

        if (currentFlightId && db && flightPathCoords.length % 30 === 0) {
          db.collection('pilots').doc(PILOT_ID)
            .collection('flights').doc(currentFlightId).update({
              lastLat:d.lat, lastLon:d.lon,
              maxAltitude:maxAlt, maxSpeed:maxSpd,
              distanceNm:parseFloat(totalDistNm.toFixed(2)),
              updatedAt:firebase.firestore.FieldValue.serverTimestamp()
            }).catch(()=>{});
        }
      }
    }, 1000);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  FIREBASE
  // ════════════════════════════════════════════════════════════════════════════
  async function initFirebase() {
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      const pilotRef  = db.collection('pilots').doc(PILOT_ID);
      const pilotSnap = await pilotRef.get();
      if (!pilotSnap.exists) {
        await pilotRef.set({
          pilotId: PILOT_ID,
          joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
          joinedLocal: JOIN_DATE
        });
      }
      await loadFlights();
    } catch (e) { console.error('[G-Dash] Firebase error:', e); }
  }

  async function loadFlights() {
    if (!db) return;
    try {
      const snap = await db.collection('pilots').doc(PILOT_ID)
        .collection('flights')
        .orderBy('startTime','desc').limit(25).get();
      allFlights = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      renderAllTime();
      renderLogbook();
    } catch (e) { console.warn('[G-Dash] Load error:', e); }
  }

  function renderAllTime() {
    const totalSec  = allFlights.reduce((a,f) => a + (f.durationSeconds||0), 0);
    const totalDist = allFlights.reduce((a,f) => a + (f.distanceNm||0), 0);
    document.getElementById('at-flights').textContent = allFlights.length;
    document.getElementById('at-time').textContent    = hhmmss(totalSec);
    document.getElementById('at-dist').textContent    = totalDist.toFixed(1);
  }

  // ── Delete flow ─────────────────────────────────────────────────────────────
  let pendingDeleteId = null;

  function showDeleteConfirm(flightId) {
    pendingDeleteId = flightId;
    const modal = document.getElementById('gfs-confirm-modal');
    modal.style.display = 'flex';
  }
  function hideDeleteConfirm() {
    pendingDeleteId = null;
    document.getElementById('gfs-confirm-modal').style.display = 'none';
  }
  async function confirmDelete() {
    if (!pendingDeleteId || !db) return hideDeleteConfirm();
    try {
      await db.collection('pilots').doc(PILOT_ID)
        .collection('flights').doc(pendingDeleteId).delete();
    } catch (e) { console.warn('[G-Dash] Delete error:', e); }
    hideDeleteConfirm();
    await loadFlights();
  }

  function renderLogbook() {
    const empty = document.getElementById('gfs-empty');
    const tbl   = document.getElementById('gfs-log-tbl');
    const tbody = document.getElementById('gfs-log-body');
    if (!allFlights.length) {
      empty.style.display = 'block'; tbl.style.display = 'none'; return;
    }
    empty.style.display = 'none'; tbl.style.display = 'table';
    tbody.innerHTML = allFlights.map((f, i) => `
      <tr>
        <td class="td-num">${allFlights.length - i}</td>
        <td class="td-date">${fmtDate(f.startTime)}</td>
        <td class="td-dur">${hhmmss(f.durationSeconds||0)}</td>
        <td><span class="bdg bdg-c">${(f.distanceNm||0).toFixed(1)} nm</span></td>
        <td style="color:#c0dce8">${(f.maxAltitude||0).toLocaleString()} ft</td>
        <td><span class="bdg bdg-g">${(f.maxSpeed||0).toFixed(0)} kts</span></td>
        <td><button class="del-btn" data-id="${f.id}">✕ Del</button></td>
      </tr>
    `).join('');

    // Attach delete listeners
    tbody.querySelectorAll('.del-btn').forEach(btn => {
      btn.addEventListener('click', () => showDeleteConfirm(btn.dataset.id));
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  FLIGHT SESSION
  // ════════════════════════════════════════════════════════════════════════════
  async function startFlight() {
    flightActive = true;
    flightStartTime = Date.now();
    totalFlightSecs = 0; totalDistNm = 0; maxAlt = 0; maxSpd = 0;
    flightPathCoords = []; flightPath?.setLatLngs([]);

    // Reset stat cards
    document.getElementById('sf-dist').textContent = '0.0';
    document.getElementById('sf-alt').textContent  = '0';
    document.getElementById('sf-spd').textContent  = '0';

    document.getElementById('gfs-start').disabled = true;
    document.getElementById('gfs-land').disabled  = false;
    document.getElementById('gfs-timer').classList.add('live');

    timerInterval = setInterval(() => {
      totalFlightSecs = Math.floor((Date.now() - flightStartTime) / 1000);
      document.getElementById('gfs-timer').textContent = hhmmss(totalFlightSecs);
    }, 1000);

    if (db) {
      try {
        const pos = getPlaneData();
        const ref = await db.collection('pilots').doc(PILOT_ID)
          .collection('flights').add({
            startTime:firebase.firestore.FieldValue.serverTimestamp(),
            startLat:pos?.lat??null, startLon:pos?.lon??null,
            durationSeconds:0, distanceNm:0,
            maxAltitude:0, maxSpeed:0,
            status:'active', pilotId:PILOT_ID
          });
        currentFlightId = ref.id;
      } catch (e) { console.warn('[G-Dash] Create flight error:', e); }
    }
  }

  async function stopFlight() {
    flightActive = false;
    clearInterval(timerInterval);

    document.getElementById('gfs-start').disabled = false;
    document.getElementById('gfs-land').disabled  = true;
    document.getElementById('gfs-timer').classList.remove('live');

    // ── Reset timer to 00:00:00 ──────────────────────────────────────────────
    document.getElementById('gfs-timer').textContent = '00:00:00';
    totalFlightSecs = 0;

    if (db && currentFlightId) {
      try {
        await db.collection('pilots').doc(PILOT_ID)
          .collection('flights').doc(currentFlightId).update({
            durationSeconds: totalFlightSecs,
            distanceNm:      parseFloat(totalDistNm.toFixed(2)),
            maxAltitude:     maxAlt, maxSpeed:maxSpd,
            endTime:         firebase.firestore.FieldValue.serverTimestamp(),
            status:          'completed'
          });
      } catch (e) { console.warn('[G-Dash] Save flight error:', e); }
      currentFlightId = null;
    }
    await loadFlights();
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  UI WIRING
  // ════════════════════════════════════════════════════════════════════════════
  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.gfs-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.gfs-panel').forEach(p =>
      p.classList.toggle('active', p.id === `gfs-panel-${tab}`));
    if (tab === 'map' && map) setTimeout(() => map.invalidateSize(), 60);
    if (tab === 'stats') loadFlights();
  }

  function startClock() {
    setInterval(() => {
      const now = new Date();
      document.getElementById('gfs-utc').textContent =
        `UTC  ${now.toUTCString().slice(17,22)}`;
    }, 1000);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  MAIN INIT
  // ════════════════════════════════════════════════════════════════════════════
  async function init() {
    await loadLeaflet();
    await loadFirebase();
    injectStyles();
    buildDOM();

    // Join date
    try {
      const d = new Date(JOIN_DATE);
      document.getElementById('pi-joined').textContent =
        d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
    } catch {}

    // Events
    document.getElementById('gfs-btn').addEventListener('click', () => {
      const ov = document.getElementById('gfs-overlay');
      const opening = ov.style.display !== 'flex';
      ov.style.display = opening ? 'flex' : 'none';
      if (opening) { initMap(); startPositionLoop(); }
    });
    document.getElementById('gfs-close').addEventListener('click', () => {
      document.getElementById('gfs-overlay').style.display = 'none';
    });
    document.getElementById('gfs-overlay').addEventListener('click', e => {
      if (e.target.id === 'gfs-overlay')
        document.getElementById('gfs-overlay').style.display = 'none';
    });
    document.querySelectorAll('.gfs-tab').forEach(t =>
      t.addEventListener('click', () => switchTab(t.dataset.tab)));

    document.getElementById('gfs-start').addEventListener('click', startFlight);
    document.getElementById('gfs-land').addEventListener('click',  stopFlight);

    // Delete confirm modal buttons
    document.getElementById('confirm-yes-btn').addEventListener('click', confirmDelete);
    document.getElementById('confirm-no-btn').addEventListener('click',  hideDeleteConfirm);

    await initFirebase();
    startClock();
    console.log(`[G-Dash] ✅ Ready  |  Pilot: ${PILOT_ID}`);
  }

  const waitReady = setInterval(() => {
    if (document.readyState === 'complete') {
      clearInterval(waitReady);
      setTimeout(init, 2500);
    }
  }, 500);

})();
