// ==UserScript==
// @name         G-DASH 
// @namespace    https://github.com/hect0o
// @version      2.2.0
// @description  G-Dash dashboard for GeoFS — Discord login, live map, sessions, flight logbook
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

  // ════════════════════════════════════════════════════════════════════════════
  //  ✏️  CUSTOMIZATION
  // ════════════════════════════════════════════════════════════════════════════

  const DASHBOARD_NAME = 'G-Dash';

  const MAP_TILE_URL         = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const MAP_TILE_ATTRIBUTION = '© OpenStreetMap contributors';

  const TOGGLE_BUTTON_CONTENT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="26" height="26">
    <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
  </svg>`;

  const ACCENT_COLOR = '#00c8ff';

  // ════════════════════════════════════════════════════════════════════════════
  //  🔥  FIREBASE + APEX (Discord OAuth) — fill in before use
  // ════════════════════════════════════════════════════════════════════════════
  const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyAQW_h_WLvRJE96j4E827ISKedMfYCFpA4",
    authDomain:        "apex-airways-5a1a7.firebaseapp.com",
    projectId:         "apex-airways-5a1a7",
    storageBucket:     "apex-airways-5a1a7.firebasestorage.app",
    messagingSenderId: "145179688972",
    appId:             "1:145179688972:web:f40227971d9ab4fc17ee29"
  };

  const APEX_CONFIG = {
    discordClientId:      "1508516763300659420",
    // Must match Discord Developer Portal → OAuth2 → Redirects (host public/oauth/callback.html)
    discordRedirectUri:   "https://g-dash.pages.dev",
    sessionHeartbeatMs:   60_000,
    phaseDebounceMs:      3_000,
  };

  const APEX_STORAGE = {
    DISCORD_ID: 'apex_discord_id',
    REFRESH:    'apex_discord_refresh',
  };

  const COLLECTIONS = { PILOTS: 'pilots', SESSIONS: 'sessions' };
  const FLIGHT_PHASES = ['ground','taxi','takeoff','climb','cruise','descent','approach','landing','unknown'];

  // ════════════════════════════════════════════════════════════════════════════
  //  SETTINGS — persisted in localStorage
  // ════════════════════════════════════════════════════════════════════════════
  const SETTINGS_KEY = 'gdash_settings';
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
  }
  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
  let settings = loadSettings();
  if (!settings.keybind)       settings.keybind       = '`';
  if (!settings.fullscreen)    settings.fullscreen    = false;
  if (!settings.btnX)          settings.btnX          = null;
  if (!settings.btnY)          settings.btnY          = null;
  if (!settings.quarterScreen) settings.quarterScreen = false;
  if (settings.compactX === undefined) settings.compactX = null;
  if (settings.compactY === undefined) settings.compactY = null;

  // ════════════════════════════════════════════════════════════════════════════
  //  STATE
  // ════════════════════════════════════════════════════════════════════════════
  let map = null, planeMarker = null, flightPath = null;
  let flightPathCoords = [], activeTab = 'map', db = null;
  let flightStartTime = null, flightActive = false, totalFlightSecs = 0;
  let timerInterval = null, posInterval = null, currentFlightId = null;
  let allFlights = [], lastPosition = null;
  let totalDistNm = 0, maxAlt = 0, maxSpd = 0;
  let currentHeading = 0;
  let autoFlightEnabled = true;
  let groundPhaseCount = 0;
  let airbornePhaseCount = 0;
  let minTakeoffAlt = 500;
  let minLandingAltStop = 100;
  let autoStartThreshold = 5;
  let autoStopThreshold = 15;
  let flightStatus = 'idle';
  let isLoggingOut = false;

  /** @type {{ discordId: string, profile: object|null, username: string }|null} */
  let authUser = null;
  let firebaseAuth = null;
  let apexSessionId = null;
  let apexFlightPhase = 'ground';
  let apexPhaseDebounceTimer = null;
  let apexHeartbeatTimer = null;
  let apexPilotUnsub = null;
  let apexSessionUnsub = null;
  let lastPlaneSample = null;

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
    if (window.firebase?.auth && window.firebase?.firestore) return;
    const v = '10.14.1';
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-auth-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`);
  }

  function getDiscordId() {
    return authUser?.discordId || localStorage.getItem(APEX_STORAGE.DISCORD_ID) || null;
  }

  function getLinkedUid() {
    return firebaseAuth?.currentUser?.uid || null;
  }

  function isLoggedIn() {
    return !!getDiscordId() && !!getLinkedUid();
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
  //  G-Dash — AUTH + SESSION
  // ════════════════════════════════════════════════════════════════════════════
  function assertApexConfig() {
    const missing = [];
    if (!APEX_CONFIG.discordClientId || APEX_CONFIG.discordClientId.startsWith('YOUR_')) missing.push('discordClientId');
    if (!APEX_CONFIG.discordRedirectUri || APEX_CONFIG.discordRedirectUri.includes('your-project')) missing.push('discordRedirectUri');
    if (missing.length) console.warn('[Apex] Configure APEX_CONFIG:', missing.join(', '));
  }

  function base64UrlEncode(bytes) {
    let bin = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomPkceVerifier() {
    const a = new Uint8Array(32);
    crypto.getRandomValues(a);
    return base64UrlEncode(a);
  }

  async function pkceChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(hash));
  }

  function discordAvatarUrl(userId, avatarHash) {
    if (!avatarHash) return `https://cdn.discordapp.com/embed/avatars/${Number(userId) % 5}.png`;
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`;
  }

  function pilotFromDiscordUser(u) {
    return {
      discordId: u.id,
      username: u.username,
      globalName: u.global_name ?? null,
      discriminator: u.discriminator ?? null,
      avatarUrl: discordAvatarUrl(u.id, u.avatar),
    };
  }

  function inferFlightPhase(d, prev) {
    if (!d) return 'unknown';
    const alt = d.altFt;
    const spd = d.speedKts;
    const vspd = prev ? alt - prev.altFt : 0;

    if (alt < 80 && spd < 30) return 'ground';
    if (alt < 1200 && spd >= 20 && spd < 65 && Math.abs(vspd) < 35) return 'taxi';
    if (vspd > 120 && alt < 5000) return 'takeoff';
    if (vspd > 25 && alt >= 800) return 'climb';
    if (vspd < -25 && alt >= 800) return 'descent';
    if (alt >= 1800 && spd >= 70 && Math.abs(vspd) < 30) return 'cruise';
    if (vspd < -15 && alt < 2200 && alt > 250) return 'approach';
    if (alt < 450 && (vspd < -8 || spd < 90)) return 'landing';
    if (alt < 1000 && spd < 75) return 'taxi';
    if (spd >= 55) return 'cruise';
    return 'ground';
  }

  async function buildDiscordAuthUrl(state, codeChallenge) {
    const p = new URLSearchParams({
      client_id: APEX_CONFIG.discordClientId,
      redirect_uri: APEX_CONFIG.discordRedirectUri,
      response_type: 'code',
      scope: 'identify',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'none',
    });
    return `https://discord.com/api/oauth2/authorize?${p}`;
  }

  function requestDiscordCode() {
    return new Promise(async (resolve, reject) => {
      const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      const verifier = randomPkceVerifier();
      const challenge = await pkceChallenge(verifier);
      sessionStorage.setItem('apex_oauth_state', state);
      sessionStorage.setItem('apex_pkce_verifier', verifier);
      const authUrl = await buildDiscordAuthUrl(state, challenge);
      const popup = window.open(authUrl, 'apex_discord_oauth',
        `width=500,height=700,left=${(screen.width-500)/2},top=${(screen.height-700)/2}`);
      if (!popup) return reject(new Error('Popup blocked — allow popups for GeoFS'));

      const timeout = setTimeout(() => { cleanup(); reject(new Error('Discord login timed out')); }, 120000);
      const poll = setInterval(() => {
        if (popup.closed) { cleanup(); reject(new Error('Login window closed')); }
      }, 500);

      function cleanup() {
        clearTimeout(timeout); clearInterval(poll);
        window.removeEventListener('message', onMsg);
        try { popup.close(); } catch (_) {}
      }

      function onMsg(event) {
        let ok = event.origin === window.location.origin;
        try { if (!ok) ok = new URL(APEX_CONFIG.discordRedirectUri).origin === event.origin; } catch (_) {}
        if (!ok || !event.data || event.data.type !== 'APEX_DISCORD_OAUTH') return;
        cleanup();
        if (event.data.error) return reject(new Error(event.data.error));
        if (event.data.state !== sessionStorage.getItem('apex_oauth_state')) return reject(new Error('Invalid OAuth state'));
        sessionStorage.removeItem('apex_oauth_state');
        if (!event.data.code) return reject(new Error('Login cancelled'));
        resolve(event.data.code);
      }
      window.addEventListener('message', onMsg);
    });
  }

  /** Discord token exchange — client-side PKCE (no backend / authApiBase). */
  async function exchangeDiscordCodePkce(code) {
    const verifier = sessionStorage.getItem('apex_pkce_verifier');
    sessionStorage.removeItem('apex_pkce_verifier');
    if (!verifier) throw new Error('OAuth session expired — try again');

    const res = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: APEX_CONFIG.discordClientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: APEX_CONFIG.discordRedirectUri,
        code_verifier: verifier,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error_description || body.error || `Discord token error ${res.status}`);
    if (!body.access_token) throw new Error('No access token from Discord');
    return body;
  }

  async function refreshDiscordToken(refreshToken) {
    const res = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: APEX_CONFIG.discordClientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error_description || 'Discord refresh failed');
    if (body.refresh_token) localStorage.setItem(APEX_STORAGE.REFRESH, body.refresh_token);
    return body.access_token;
  }

  async function fetchDiscordUser(accessToken) {
    const res = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(user.message || 'Failed to load Discord profile');
    return user;
  }

  async function ensureFirebaseAnon() {
    if (firebaseAuth.currentUser) return firebaseAuth.currentUser;
    try {
      await firebaseAuth.signInAnonymously();
      return firebaseAuth.currentUser;
    } catch (err) {
      const code = err?.code || '';
      if (code === 'auth/configuration-not-found' || code === 'auth/operation-not-allowed') {
        throw new Error(
          'Firebase Anonymous sign-in is not enabled. Open Firebase Console → Authentication → Sign-in method → Anonymous → Enable. See apex-airways/FIREBASE_SETUP.md'
        );
      }
      throw err;
    }
  }

  async function savePilotProfile(pilot) {
    const id = pilot.discordId;
    await ensureFirebaseAnon();
    const uid = firebaseAuth.currentUser.uid;
    const ref = db.collection(COLLECTIONS.PILOTS).doc(id);
    const joinKey = 'apex_joined_' + id;
    const data = {
      discordId: id,
      username: pilot.username,
      globalName: pilot.globalName ?? null,
      avatarUrl: pilot.avatarUrl ?? null,
      discriminator: pilot.discriminator ?? null,
      linkedUid: uid,
      lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
      online: true,
    };
    if (!localStorage.getItem(joinKey)) {
      data.joinedAt = firebase.firestore.FieldValue.serverTimestamp();
      localStorage.setItem(joinKey, new Date().toISOString());
    }
    await ref.set(data, { merge: true });
    return data;
  }

  async function setPilotOffline(discordId) {
    if (!db || !discordId) return;
    try {
      console.log('[Apex] Setting pilot offline:', discordId);
      await db.collection(COLLECTIONS.PILOTS).doc(discordId).update({
        online: false,
        lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      console.log('[Apex] Pilot offline status set successfully');
    } catch (e) {
      console.error('[Apex] Failed to set pilot offline:', e);
    }
  }

  async function getPilotProfile(discordId) {
    try {
      const snap = await db.collection(COLLECTIONS.PILOTS).doc(discordId).get();
      return snap.exists ? snap.data() : null;
    } catch (e) {
      if (isPermissionError(e)) throw permissionHelpError(e);
      throw e;
    }
  }

  function isPermissionError(e) {
    const msg = String(e?.message || e?.code || e || '');
    return msg.includes('permission') || msg.includes('PERMISSION_DENIED') || e?.code === 'permission-denied';
  }

  function permissionHelpError(original) {
    const err = new Error(
      'Firestore blocked this action. In Firebase Console open project apex-airways-5a1a7 → Firestore → Rules, paste rules from apex-airways/firestore.rules, click Publish. Also enable Authentication → Anonymous.'
    );
    err.cause = original;
    return err;
  }

  function updateAuthUI() {
    const chip = document.getElementById('gfs-pilot-chip');
    const label = document.getElementById('gfs-pilot-label');
    const gate = document.getElementById('gfs-auth-gate');
    const tabs = document.getElementById('gfs-tabs');
    const content = document.getElementById('gfs-content');
    const loginBtn = document.getElementById('gfs-login-btn');
    const logoutBtn = document.getElementById('gfs-logout-btn');
    const dot = document.getElementById('gfs-dot');

    if (authUser) {
      const name = authUser.profile?.globalName || authUser.profile?.username || authUser.username || 'Pilot';
      if (chip) chip.textContent = name;
      if (label) label.textContent = 'SIGNED IN';
      if (gate) gate.style.display = 'none';
      if (tabs) tabs.style.pointerEvents = '';
      if (content) content.style.pointerEvents = '';
      if (loginBtn) loginBtn.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = '';
      if (dot) { dot.style.background = '#00ff88'; dot.title = 'Online'; }

      const av = document.getElementById('gfs-pilot-avatar');
      const pcId = document.querySelector('.pc-id');
      const piJoined = document.getElementById('pi-joined');
      if (pcId) pcId.textContent = name;
      if (av && authUser.profile?.avatarUrl) {
        av.innerHTML = `<img src="${authUser.profile.avatarUrl}" alt="" style="width:100%;height:100%;border-radius:10px;object-fit:cover"/>`;
      }
      if (piJoined && authUser.profile?.joinedAt) {
        const jd = authUser.profile.joinedAt.toDate ? authUser.profile.joinedAt.toDate() : new Date(authUser.profile.joinedAt);
        setText('pi-joined', jd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }));
      }
      setText('pi-discord-id', authUser.discordId);
    } else {
      if (chip) chip.textContent = 'Guest';
      if (label) label.textContent = 'NOT SIGNED IN';
      if (gate) gate.style.display = 'flex';
      if (loginBtn) loginBtn.style.display = '';
      if (logoutBtn) logoutBtn.style.display = 'none';
      if (dot) { dot.style.background = '#ff6666'; dot.title = 'Offline'; }
    }
    setText('gfs-phase', apexFlightPhase.toUpperCase());
  }

  function debouncePhaseWrite(fn, ms) {
    return function (phase) {
      if (apexPhaseDebounceTimer) clearTimeout(apexPhaseDebounceTimer);
      apexPhaseDebounceTimer = setTimeout(() => fn(phase), ms);
    };
  }

  let lastPersistedPhase = null;

  const persistFlightPhaseDb = debouncePhaseWrite(async (phase) => {
    if (!apexSessionId || !db || phase === lastPersistedPhase) return;
    lastPersistedPhase = phase;
    try {
      await db.collection(COLLECTIONS.SESSIONS).doc(apexSessionId).update({
        flightPhase: phase,
        lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) { console.warn('[Apex] phase write failed', e); }
  }, APEX_CONFIG.phaseDebounceMs);

  function displayFlightPhase(phase) {
    if (!FLIGHT_PHASES.includes(phase)) phase = 'unknown';
    apexFlightPhase = phase;
    const label = phase.toUpperCase();
    setText('gfs-phase', label);
    setText('h-phase', label);
  }

  function setFlightPhase(phase, persistToDb) {
    displayFlightPhase(phase);
    if (persistToDb !== false && apexSessionId) persistFlightPhaseDb(phase);
  }

  async function endStaleSessions(discordId) {
    const uid = getLinkedUid();
    if (!uid) return;
    let snap;
    try {
      snap = await db.collection(COLLECTIONS.SESSIONS)
        .where('pilotId', '==', discordId)
        .where('online', '==', true)
        .limit(5)
        .get();
    } catch (e) {
      console.warn('[Apex] endStaleSessions query', e);
      return;
    }
    if (snap.empty) return;
    const batch = db.batch();
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    snap.docs.forEach(d => batch.update(d.ref, { online: false, endedAt: ts, lastSeenAt: ts }));
    await batch.commit();
  }

  async function startApexSession() {
    const discordId = getDiscordId();
    const uid = getLinkedUid();
    if (!discordId || !uid || !db) throw new Error('Login required');
    if (apexSessionId) return apexSessionId;

    try {
      await endStaleSessions(discordId);
    } catch (e) {
      console.warn('[Apex] endStaleSessions skipped', e);
    }
    const ref = db.collection(COLLECTIONS.SESSIONS).doc();
    await ref.set({
      pilotId: discordId,
      linkedUid: uid,
      online: true,
      flightPhase: 'ground',
      startedAt: firebase.firestore.FieldValue.serverTimestamp(),
      endedAt: null,
      lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    apexSessionId = ref.id;
    lastPersistedPhase = null;
    displayFlightPhase('ground');

    // Set pilot online status when session starts
    try {
      await db.collection(COLLECTIONS.PILOTS).doc(discordId).update({
        online: true,
        lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn('[Apex] Failed to set pilot online status', e);
    }

    if (apexHeartbeatTimer) clearInterval(apexHeartbeatTimer);
    apexHeartbeatTimer = setInterval(async () => {
      if (!apexSessionId || !db || isLoggingOut) return;
      try {
        // Update both session and pilot online status in heartbeat
        await db.collection(COLLECTIONS.SESSIONS).doc(apexSessionId).update({
          lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        await db.collection(COLLECTIONS.PILOTS).doc(discordId).update({
          online: true,
          lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.warn('[Apex] Heartbeat update failed', e);
      }
    }, APEX_CONFIG.sessionHeartbeatMs);

    watchApexSession(apexSessionId);
    return apexSessionId;
  }

  async function endApexSession() {
    if (apexPhaseDebounceTimer) clearTimeout(apexPhaseDebounceTimer);
    if (apexHeartbeatTimer) { clearInterval(apexHeartbeatTimer); apexHeartbeatTimer = null; }

    if (!apexSessionId || !db) { apexSessionId = null; return; }

    try {
      await db.collection(COLLECTIONS.SESSIONS).doc(apexSessionId).update({
        online: false,
        flightPhase: apexFlightPhase,
        endedAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) { console.warn('[Apex] end session failed', e); }

    if (apexSessionUnsub) { apexSessionUnsub(); apexSessionUnsub = null; }
    apexSessionId = null;
    setText('gfs-phase', '—');
  }

  function watchApexPilot(discordId) {
    if (apexPilotUnsub) apexPilotUnsub();
    apexPilotUnsub = db.collection(COLLECTIONS.PILOTS).doc(discordId)
      .onSnapshot(snap => {
        if (!snap.exists || !authUser) return;
        authUser.profile = snap.data();
        updateAuthUI();
      }, err => console.warn('[Apex] pilot sync', err));
  }

  function watchApexSession(sessionId) {
    if (apexSessionUnsub) apexSessionUnsub();
    apexSessionUnsub = db.collection(COLLECTIONS.SESSIONS).doc(sessionId)
      .onSnapshot(snap => {
        if (!snap.exists) return;
        const d = snap.data();
        if (d.flightPhase) {
          apexFlightPhase = d.flightPhase;
          setText('gfs-phase', d.flightPhase.toUpperCase());
        }
      }, err => console.warn('[Apex] session sync', err));
  }

  async function restoreApexUser() {
    const discordId = localStorage.getItem(APEX_STORAGE.DISCORD_ID);
    if (!discordId) return null;

    await ensureFirebaseAnon();
    const profile = await getPilotProfile(discordId).catch(() => null);
    if (!profile) {
      localStorage.removeItem(APEX_STORAGE.DISCORD_ID);
      return null;
    }

    if (profile.linkedUid !== firebaseAuth.currentUser.uid) {
      try {
        await db.collection(COLLECTIONS.PILOTS).doc(discordId).set({
          linkedUid: firebaseAuth.currentUser.uid,
        }, { merge: true });
        profile.linkedUid = firebaseAuth.currentUser.uid;
      } catch (e) {
        console.warn('[Apex] relink pilot', e);
      }
    }

    // Set pilot online status when restoring user
    try {
      await db.collection(COLLECTIONS.PILOTS).doc(discordId).update({
        online: true,
        lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn('[Apex] Failed to set pilot online status on restore', e);
    }

    authUser = {
      discordId,
      username: profile.username || profile.globalName || 'Pilot',
      profile,
    };
    return authUser;
  }

  async function loginWithDiscord() {
    assertApexConfig();
    setText('gfs-auth-status', 'Opening Discord…');
    const code = await requestDiscordCode();
    setText('gfs-auth-status', 'Signing in…');

    const tokens = await exchangeDiscordCodePkce(code);
    if (tokens.refresh_token) localStorage.setItem(APEX_STORAGE.REFRESH, tokens.refresh_token);

    const discordUser = await fetchDiscordUser(tokens.access_token);
    const pilot = pilotFromDiscordUser(discordUser);

    await ensureFirebaseAnon();
    await savePilotProfile(pilot);
    localStorage.setItem(APEX_STORAGE.DISCORD_ID, pilot.discordId);

    const profile = await getPilotProfile(pilot.discordId);
    authUser = {
      discordId: pilot.discordId,
      username: pilot.username,
      profile,
    };
    updateAuthUI();
    watchApexPilot(pilot.discordId);
    try {
      await loadFlights();
    } catch (e) {
      console.error('[Apex] loadFlights', e);
      setText('gfs-auth-status', e.message || 'Could not load logbook');
      throw e;
    }
    setText('gfs-auth-status', '');
    console.log('[Apex] login OK | project:', FIREBASE_CONFIG.projectId, '| uid:', getLinkedUid(), '| discord:', pilot.discordId);
    return authUser;
  }

  async function logoutApex() {
    isLoggingOut = true;
    if (flightActive) await stopFlight();
    await endApexSession();
    // Clear heartbeat timer explicitly to prevent it from overriding offline status
    if (apexHeartbeatTimer) {
      clearInterval(apexHeartbeatTimer);
      apexHeartbeatTimer = null;
    }
    const id = getDiscordId();
    await setPilotOffline(id);
    if (apexPilotUnsub) { apexPilotUnsub(); apexPilotUnsub = null; }
    localStorage.removeItem(APEX_STORAGE.DISCORD_ID);
    localStorage.removeItem(APEX_STORAGE.REFRESH);
    await firebaseAuth.signOut();
    authUser = null;
    allFlights = [];
    renderLogbook();
    renderAllTime();
    updateAuthUI();
    isLoggingOut = false;
  }

  async function initApexAuth() {
    assertApexConfig();
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    firebaseAuth = firebase.auth();
    firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    db = firebase.firestore();

    try {
      const refresh = localStorage.getItem(APEX_STORAGE.REFRESH);
      const discordId = localStorage.getItem(APEX_STORAGE.DISCORD_ID);
      if (discordId && refresh) {
        await refreshDiscordToken(refresh).catch(() => {
          localStorage.removeItem(APEX_STORAGE.REFRESH);
        });
      }
      if (discordId) {
        if (!firebaseAuth.currentUser) await firebaseAuth.signInAnonymously();
        const restored = await restoreApexUser();
        if (restored) {
          updateAuthUI();
          watchApexPilot(restored.discordId);
          await loadFlights().catch(() => {});
          return restored;
        }
      }
    } catch (e) {
      console.warn('[Apex] auto-reconnect failed', e);
    }

    authUser = null;
    updateAuthUI();
    return null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  GEOFS DATA READER
  // ════════════════════════════════════════════════════════════════════════════
  function getPlaneData() {
    try {
      const ac = window.geofs?.aircraft?.instance;
      if (!ac) return null;
      const coords = ac.llaLocation;
      if (!coords || coords[0] == null) return null;

      const headingRaw = ac.animationValue?.heading ?? 0;
      // ✅ FIX: normalise to 0–360 so negatives like -108 display as 252
      const headingDeg = ((headingRaw % 360) + 360) % 360;

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
  function setText(id, val) {
    try { const el = document.getElementById(id); if (el) el.textContent = val; } catch {}
  }

  function updateAutoFlightStatus() {
    const statusEl = document.getElementById('auto-flight-status');
    if (!statusEl) return;

    let statusText = 'Automatic Flight Tracking Enabled';
    let statusColor = '#6da8c4';

    if (flightStatus === 'starting') {
      statusText = '⚡ Starting Flight...';
      statusColor = '#ffb800';
    } else if (flightStatus === 'stopping') {
      statusText = '⚡ Saving Flight...';
      statusColor = '#ffb800';
    } else if (flightActive) {
      statusText = '✈ Flight In Progress';
      statusColor = '#00ff88';
    } else if (airbornePhaseCount > 0) {
      statusText = `⏳ Preparing... (${airbornePhaseCount}/${autoStartThreshold})`;
      statusColor = '#ffb800';
    } else if (groundPhaseCount > 0 && flightActive) {
      statusText = `⏳ Landing... (${groundPhaseCount}/${autoStopThreshold})`;
      statusColor = '#ffb800';
    }

    statusEl.textContent = statusText;
    statusEl.style.color = statusColor;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STYLES
  // ════════════════════════════════════════════════════════════════════════════
  function injectStyles() {
    const A = ACCENT_COLOR;
    const style = document.createElement('style');
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600&display=swap');

      #gfs-btn {
        position:fixed; bottom:26px; right:26px; z-index:99999;
        width:54px; height:54px; border-radius:14px;
        background:#0b1a28; border:2px solid ${A}; color:${A};
        cursor:grab; display:flex; align-items:center; justify-content:center;
        box-shadow:0 0 18px ${A}55,0 6px 24px #00000088;
        transition:box-shadow .2s,border-color .2s; user-select:none;
      }
      #gfs-btn:hover { box-shadow:0 0 32px ${A}99,0 6px 30px #000000bb; }
      #gfs-btn.dragging { cursor:grabbing; opacity:.85; }

      #gfs-overlay {
        position:fixed; inset:0; z-index:99998;
        display:flex; align-items:center; justify-content:center;
        background:rgba(0,5,14,0.80); backdrop-filter:blur(8px);
        transition:background .3s ease, backdrop-filter .3s ease;
      }
      /* Compact mode — overlay becomes fully transparent & click-through */
      #gfs-overlay.compact-mode {
        background:transparent !important;
        backdrop-filter:none !important;
        pointer-events:none;
      }

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
        transition:width .3s ease, height .3s ease, max-width .3s ease, max-height .3s ease;
      }
      /* Compact portrait mode — tall phone-style panel over the game */
      #gfs-tablet.quarter-screen {
        position:fixed !important;
        width:min(92vw, 400px) !important;
        max-width:400px !important;
        min-width:300px !important;
        height:min(88vh, 860px) !important;
        max-height:88vh !important;
        min-height:520px !important;
        border-radius:22px;
        pointer-events:auto;
        cursor:default;
        z-index:99999;
      }
      #gfs-tablet.quarter-screen.tablet-dragging {
        cursor:grabbing !important;
        opacity:.92;
      }
      #gfs-tablet.quarter-screen #gfs-topbar {
        padding:10px 14px;
        gap:6px;
        cursor:grab;
        user-select:none;
        touch-action:none;
      }
      #gfs-tablet.quarter-screen #gfs-topbar.tablet-dragging {
        cursor:grabbing;
      }
      #gfs-map, #gfs-map .leaflet-container {
        pointer-events:auto !important;
        touch-action:none;
      }
      #gfs-tablet.quarter-screen #gfs-logo {
        font-size:11px;
        letter-spacing:2px;
      }
      #gfs-tablet.quarter-screen #gfs-pilot-label { display:none; }
      #gfs-tablet.quarter-screen #gfs-pilot-chip {
        font-size:9px;
        padding:3px 8px;
        max-width:88px;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
      }
      #gfs-tablet.quarter-screen #gfs-auth-btns button {
        padding:5px 8px;
        font-size:7px;
      }
      #gfs-tablet.quarter-screen #gfs-tabs {
        padding:0 10px;
        overflow-x:auto;
      }
      #gfs-tablet.quarter-screen .gfs-tab {
        padding:9px 14px;
        font-size:9px;
        letter-spacing:1.5px;
      }
      #gfs-tablet.quarter-screen #gfs-hud {
        top:10px; left:10px; right:10px;
        min-width:0; max-width:none; width:auto;
        padding:10px 12px;
      }
      #gfs-tablet.quarter-screen .hud-val { font-size:13px; }
      #gfs-tablet.quarter-screen #gfs-center {
        width:36px; height:36px; font-size:17px;
      }
      #gfs-tablet.quarter-screen #gfs-footer {
        padding:6px 14px;
        flex-wrap:wrap;
        gap:4px;
      }
      #gfs-tablet.quarter-screen #gfs-coords {
        font-size:10px;
        width:100%;
      }
      @keyframes gfs-pop {
        from{transform:translateY(38px) scale(.96);opacity:0}
        to{transform:none;opacity:1}
      }

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

      #gfs-auth-btns { display:flex; gap:8px; align-items:center; }
      #gfs-login-btn, #gfs-logout-btn {
        padding:6px 12px; border-radius:8px; cursor:pointer;
        font-family:'Orbitron',monospace; font-size:8px; font-weight:700; letter-spacing:1.5px;
        border:1.5px solid #1e3d58; background:transparent; color:#7fb3cc;
        transition:all .15s;
      }
      #gfs-login-btn { border-color:#5865F2; color:#aab4ff; }
      #gfs-login-btn:hover { background:#5865F222; }
      #gfs-logout-btn { border-color:rgba(255,80,80,.4); color:#ff8888; }
      #gfs-logout-btn:hover { background:rgba(255,80,80,.15); }

      #gfs-auth-gate {
        position:absolute; inset:0; z-index:700;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        background:rgba(4,9,18,.97); text-align:center; padding:32px;
      }
      #gfs-auth-gate h2 {
        font-family:'Orbitron',monospace; font-size:16px; color:${A};
        letter-spacing:3px; margin:0 0 12px;
      }
      #gfs-auth-gate p {
        font-size:13px; color:#7fb3cc; max-width:320px; line-height:1.7; margin:0 0 24px;
      }
      #gfs-discord-login {
        padding:12px 28px; border-radius:10px; border:none; cursor:pointer;
        background:#5865F2; color:#fff; font-family:'Orbitron',monospace;
        font-size:10px; font-weight:700; letter-spacing:2px;
        box-shadow:0 0 20px #5865F244;
      }
      #gfs-discord-login:hover { filter:brightness(1.1); }
      #gfs-auth-status { font-size:11px; color:#5a8aa8; margin-top:14px; min-height:18px; }

      #gfs-phase {
        font-family:'Orbitron',monospace; font-size:9px; font-weight:700;
        color:#ffb800; letter-spacing:2px; margin-left:12px;
      }

      #gfs-tabs {
        display:flex; background:#050e1a;
        border-bottom:1.5px solid #1e3d58;
        padding:0 20px; flex-shrink:0;
      }
      .gfs-tab {
        padding:11px 24px; cursor:pointer; user-select:none;
        font-family:'Orbitron',monospace; font-size:10px; font-weight:700; letter-spacing:2.5px;
        color:#4a7a9a; border-bottom:2.5px solid transparent;
        display:flex; align-items:center; gap:7px;
        transition:color .18s,border-color .18s;
      }
      .gfs-tab:hover{color:#a0d4e8;}
      .gfs-tab.active{color:${A};border-bottom-color:${A};}

      #gfs-content{flex:1;position:relative;overflow:hidden;}
      .gfs-panel{position:absolute;inset:0;display:none;}
      .gfs-panel.active{display:flex;flex-direction:column;}

      #gfs-map{width:100%;height:100%;}
      .leaflet-container{background:#0a1520 !important;}

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

      #gfs-center {
        position:absolute; bottom:16px; right:16px; z-index:500;
        width:40px; height:40px; border-radius:10px;
        background:rgba(4,9,18,.94); border:1.5px solid #1e3d58;
        color:${A}; font-size:20px; cursor:pointer;
        display:flex; align-items:center; justify-content:center;
        transition:border-color .18s,background .18s;
      }
      #gfs-center:hover{border-color:${A};background:${A}1c;}

      #gfs-stats-body {
        padding:18px 24px; overflow-y:auto; flex:1;
        scrollbar-width:thin; scrollbar-color:#1e3d58 transparent;
      }
      #gfs-stats-body::-webkit-scrollbar{width:4px;}
      #gfs-stats-body::-webkit-scrollbar-thumb{background:#1e3d58;border-radius:4px;}

      .sec {
        font-family:'Orbitron',monospace; font-size:9px; font-weight:700;
        letter-spacing:3px; color:#5a8aa8; text-transform:uppercase;
        margin:4px 0 14px; display:flex; align-items:center; gap:9px;
      }
      .sec::after{
        content:'';flex:1;height:1px;
        background:linear-gradient(90deg,#1e3d58 0%,transparent 100%);
      }

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
      .del-btn{
        background:none; border:1px solid rgba(255,80,80,.3);
        color:#ff8888; border-radius:5px; padding:3px 8px;
        font-size:11px; cursor:pointer; transition:all .15s;
        font-family:'Inter',sans-serif; font-weight:600;
      }
      .del-btn:hover{background:rgba(255,80,80,.18);border-color:#ff6666;color:#ffaaaa;}

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

      /* ── SETTINGS TAB ── */
      #gfs-settings-body {
        padding:22px 26px; overflow-y:auto; flex:1;
        scrollbar-width:thin; scrollbar-color:#1e3d58 transparent;
      }
      #gfs-settings-body::-webkit-scrollbar{width:4px;}
      #gfs-settings-body::-webkit-scrollbar-thumb{background:#1e3d58;border-radius:4px;}

      .setting-row {
        background:#091624; border:1.5px solid #1e3d58;
        border-radius:13px; padding:18px 20px; margin-bottom:14px;
        transition:border-color .2s;
      }
      .setting-row:hover{border-color:#2a5a78;}
      .setting-label {
        font-family:'Orbitron',monospace; font-size:10px; font-weight:700;
        color:${A}; letter-spacing:2px; text-transform:uppercase; margin-bottom:6px;
      }
      .setting-desc {
        font-size:12px; font-weight:500; color:#6da8c4; line-height:1.6; margin-bottom:14px;
      }

      #keybind-display {
        display:inline-flex; align-items:center; gap:10px;
      }
      #keybind-key {
        font-family:'Orbitron',monospace; font-size:14px; font-weight:700;
        color:${A}; background:${A}15; border:2px solid ${A}55;
        border-radius:8px; padding:6px 16px; min-width:60px; text-align:center;
        letter-spacing:2px;
      }
      #keybind-capture-btn {
        padding:7px 16px; border-radius:8px; border:1.5px solid #1e3d58;
        background:transparent; color:#7fb3cc; cursor:pointer;
        font-family:'Orbitron',monospace; font-size:9px; font-weight:700; letter-spacing:2px;
        transition:all .18s;
      }
      #keybind-capture-btn:hover{border-color:${A};color:${A};}
      #keybind-capture-btn.listening{border-color:#ffb800;color:#ffb800;animation:blink 1s infinite;}
      #keybind-status{font-size:11px;color:#4a7a9a;margin-top:6px;letter-spacing:.5px;}

      #btn-pos-reset {
        padding:8px 18px; border-radius:8px; border:1.5px solid #1e3d58;
        background:transparent; color:#7fb3cc; cursor:pointer;
        font-family:'Orbitron',monospace; font-size:9px; font-weight:700; letter-spacing:2px;
        transition:all .18s; margin-top:10px;
      }
      #btn-pos-reset:hover{border-color:${A};color:${A};}

      /* ── SIZE TOGGLE ── */
      #size-toggle {
        width:52px; height:28px; border-radius:14px;
        background:#0a1928; border:1.5px solid #1e3d58;
        cursor:pointer; position:relative;
        transition:background .25s, border-color .25s;
        flex-shrink:0;
      }
      #size-toggle-knob {
        position:absolute; top:4px; left:4px;
        width:18px; height:18px; border-radius:50%;
        background:#4a7a9a;
        transition:transform .25s, background .25s;
      }
      #size-mode-label {
        font-family:'Orbitron',monospace; font-size:10px;
        font-weight:700; color:#7fb3cc; letter-spacing:1.5px;
        min-width:68px;
      }

      /* ── FOOTER ── */
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
    if (settings.btnX !== null) {
      btn.style.left   = settings.btnX + 'px';
      btn.style.top    = settings.btnY + 'px';
      btn.style.right  = 'auto';
      btn.style.bottom = 'auto';
    }
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
            <span id="gfs-pilot-label">NOT SIGNED IN</span>
            <span id="gfs-pilot-chip">Guest</span>
            <div id="gfs-dot"></div>
          </div>
          <div id="gfs-auth-btns">
            <button id="gfs-login-btn" type="button">Discord</button>
            <button id="gfs-logout-btn" type="button" style="display:none">Logout</button>
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
          <div class="gfs-tab" data-tab="settings">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            SETTINGS
          </div>
        </div>

        <div id="gfs-content">

          <div id="gfs-auth-gate">
            <h2>◈ ${DASHBOARD_NAME}</h2>
            <p>Sign in with Discord to sync your pilot profile, live sessions, and flight logbook across devices.</p>
            <button id="gfs-discord-login" type="button">Login with Discord</button>
            <div id="gfs-auth-status"></div>
          </div>

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
                <div class="hud-row">
                  <span class="hud-lbl">Phase</span>
                  <span class="hud-val y" id="h-phase">—</span>
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
                  <div class="pc-id">—</div>
                  <div class="pc-sub">
                    Member since <span id="pi-joined">—</span><br>
                    Discord ID · <span id="pi-discord-id">—</span>
                  </div>
                </div>
              </div>

              <div class="sec">◈ Current Session</div>
              <div id="gfs-session">
                <div id="gfs-timer">00:00:00</div>
                <button class="gfs-btn btn-start" id="gfs-start" style="display:none">Depart</button>
                <button class="gfs-btn btn-land"  id="gfs-land" style="display:none" disabled>Land</button>
                <button class="gfs-btn" id="gfs-save-clear" style="background:linear-gradient(135deg,#f39c12,#f1c40f);color:#04110a;box-shadow:0 0 14px #f1c40f44;margin-top:8px;">Save & Clear</button>
                <div id="auto-flight-status" style="font-size:11px;color:#6da8c4;letter-spacing:1px;margin-top:8px;">Automatic Flight Tracking Enabled</div>
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

          <!-- SETTINGS PANEL -->
          <div class="gfs-panel" id="gfs-panel-settings">
            <div id="gfs-settings-body">

              <div class="sec">◈ Account</div>
              <div class="setting-row">
                <div class="setting-label">Discord Authentication</div>
                <div class="setting-desc">Login links your GeoFS logbook to your Discord account via G-Dash. Logout ends your active session.</div>
                <div style="display:flex;gap:10px;margin-top:8px;">
                  <button class="gfs-btn btn-start" id="gfs-settings-login" type="button" style="flex:1">Login</button>
                  <button class="gfs-btn btn-land" id="gfs-settings-logout" type="button" style="flex:1">Logout</button>
                </div>
              </div>

              <div class="sec">◈ Keyboard Shortcut</div>
              <div class="setting-row">
                <div class="setting-label">Open / Close Keybind</div>
                <div class="setting-desc">Press the button below then hit any key to set a new shortcut for opening and closing the dashboard.</div>
                <div id="keybind-display">
                  <div id="keybind-key">—</div>
                  <button id="keybind-capture-btn">Change Key</button>
                </div>
                <div id="keybind-status">Current key will show above</div>
              </div>

              <div class="sec">◈ Button Position</div>
              <div class="setting-row">
                <div class="setting-label">Draggable Toggle Button</div>
                <div class="setting-desc">The floating ✈ button can be dragged anywhere on screen. Its position is saved automatically. Click below to reset it to the default position.</div>
                <button id="btn-pos-reset">Reset to Default Position</button>
              </div>

              <div class="sec">◈ Dashboard Size</div>
              <div class="setting-row">
                <div class="setting-label">Size Mode</div>
                <div class="setting-desc">Compact mode removes the blurred backdrop and shows a tall portrait panel you can drag over the game.</div>
                <div style="display:flex;align-items:center;gap:14px;margin-top:4px;">
                  <span id="size-mode-label">NORMAL</span>
                  <div id="size-toggle">
                    <div id="size-toggle-knob"></div>
                  </div>
                </div>
              </div>

            </div>
          </div>

        </div>

        <div id="gfs-footer">
          <div id="gfs-coords">LAT  —  |  LON  —</div>
          <div style="display:flex;align-items:center;">
            <span id="gfs-phase">—</span>
            <span id="gfs-utc" style="margin-left:12px">G-DASH</span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(ov);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  HEADING TAPE
  // ════════════════════════════════════════════════════════════════════════════
  const TICK_PX = 20;

  function updateHeadingTape(heading) {
    const tape  = document.getElementById('hud-hdg-tape');
    const valEl = document.getElementById('hud-hdg-cur-val');
    const dirEl = document.getElementById('hud-hdg-dir');
    if (!tape) return;
    tape.style.transform = `translateX(${-(360 + heading) * TICK_PX}px)`;
    valEl.textContent = `${Math.round(heading).toString().padStart(3,'0')}°`;
    dirEl.textContent = compassDir(heading);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  MAP INIT
  // ════════════════════════════════════════════════════════════════════════════
  function initMap() {
    if (map) return;
    map = L.map('gfs-map', {
      center: [20, 0],
      zoom: 4,
      attributionControl: false,
      dragging: true,
      touchZoom: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
    });
    L.tileLayer(MAP_TILE_URL, { maxZoom:19, minZoom:2 }).addTo(map);

    const A = ACCENT_COLOR;
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
          <ellipse cx="0" cy="-2" rx="2.8" ry="14" fill="${A}" opacity=".95"/>
          <ellipse cx="0" cy="-15" rx="2" ry="4" fill="white" opacity=".9"/>
          <path d="M0,-3 L-11,8 L-9,10 L0,5 L9,10 L11,8 Z" fill="${A}" opacity=".85"/>
          <path d="M0,9 L-5,16 L-3.5,17 L0,13 L3.5,17 L5,16 Z" fill="${A}" opacity=".75"/>
          <ellipse cx="0" cy="-11" rx="1.4" ry="2.2" fill="#00ffff" opacity=".6"/>
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
      if (!d) {
        displayFlightPhase('unknown');
        return;
      }
      lastPosition = d;
      currentHeading = d.heading;

      document.getElementById('h-alt').textContent = `${d.altFt.toLocaleString()} ft`;
      document.getElementById('h-spd').textContent = `${d.speedKts} kts`;
      updateHeadingTape(d.heading);

      document.getElementById('gfs-coords').textContent =
        `LAT  ${d.lat.toFixed(5)}  |  LON  ${d.lon.toFixed(5)}`;

      planeMarker?.setLatLng([d.lat, d.lon]);
      rotatePlane(d.heading);

      const phase = inferFlightPhase(d, lastPlaneSample);
      lastPlaneSample = { altFt: d.altFt, speedKts: d.speedKts, lat: d.lat, lon: d.lon };
      displayFlightPhase(phase);
      if (apexSessionId) persistFlightPhaseDb(phase);

      // Automatic flight start/stop detection
      if (autoFlightEnabled && isLoggedIn()) {
        const airbornePhases = ['takeoff', 'climb', 'cruise', 'descent', 'approach', 'landing'];
        const isAirborne = airbornePhases.includes(phase);
        const isGround = phase === 'ground' || phase === 'taxi';

        if (isAirborne) {
          groundPhaseCount = 0;
          airbornePhaseCount++;
          // Auto-start flight after threshold consecutive airborne readings
          if (!flightActive && airbornePhaseCount >= autoStartThreshold && d.altFt >= minTakeoffAlt) {
            console.log('[Auto-Flight] Starting flight - detected takeoff at', d.altFt, 'ft');
            flightStatus = 'starting';
            startFlight().catch(e => {
              console.warn('[Auto-Flight] Start failed:', e);
              flightStatus = 'idle';
            });
          }
        } else if (isGround) {
          airbornePhaseCount = 0;
          groundPhaseCount++;
          // Auto-stop flight after threshold consecutive ground readings and low altitude
          if (flightActive && groundPhaseCount >= autoStopThreshold && d.altFt <= minLandingAltStop) {
            console.log('[Auto-Flight] Stopping flight - detected landing at', d.altFt, 'ft');
            flightStatus = 'stopping';
            stopFlight().catch(e => {
              console.warn('[Auto-Flight] Stop failed:', e);
              flightStatus = 'active';
            });
          }
        }

        // Update flight status display
        updateAutoFlightStatus();
      }

      if (flightActive) {
        if (flightPathCoords.length > 0) {
          const [pLat, pLon] = flightPathCoords[flightPathCoords.length - 1];
          totalDistNm += haversineNm(pLat, pLon, d.lat, d.lon);
        }
        flightPathCoords.push([d.lat, d.lon]);
        flightPath?.setLatLngs(flightPathCoords);
        if (d.altFt    > maxAlt) maxAlt = d.altFt;
        if (d.speedKts > maxSpd) maxSpd = d.speedKts;

        const pilotId = getDiscordId();
        if (currentFlightId && db && pilotId && flightPathCoords.length % 30 === 0) {
          db.collection('pilots').doc(pilotId)
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
  //  FIREBASE — FLIGHT LOGBOOK (requires Discord login)
  // ════════════════════════════════════════════════════════════════════════════
  async function loadFlights() {
    const pilotId = getDiscordId();
    if (!db || !pilotId) return;
    try {
      const snap = await db.collection('pilots').doc(pilotId)
        .collection('flights')
        .orderBy('startTime','desc').limit(25).get();
      allFlights = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      renderAllTime();
      renderLogbook();
    } catch (e) {
      console.error('[G-Dash] Load error:', e);
      if (isPermissionError(e)) throw permissionHelpError(e);
    }
  }

  function renderAllTime() {
    const totalSec  = allFlights.reduce((a,f) => a + (f.durationSeconds||0), 0);
    const totalDist = allFlights.reduce((a,f) => a + (f.distanceNm||0), 0);
    setText('at-flights', allFlights.length);
    setText('at-time',    hhmmss(totalSec));
    setText('at-dist',    totalDist.toFixed(1));
  }

  let pendingDeleteId = null;
  function showDeleteConfirm(flightId) {
    pendingDeleteId = flightId;
    document.getElementById('gfs-confirm-modal').style.display = 'flex';
  }
  function hideDeleteConfirm() {
    pendingDeleteId = null;
    document.getElementById('gfs-confirm-modal').style.display = 'none';
  }
  async function confirmDelete() {
    const pilotId = getDiscordId();
    if (!pendingDeleteId || !db || !pilotId) return hideDeleteConfirm();
    try {
      await db.collection('pilots').doc(pilotId)
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
    tbody.querySelectorAll('.del-btn').forEach(btn => {
      btn.addEventListener('click', () => showDeleteConfirm(btn.dataset.id));
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  FLIGHT SESSION
  // ════════════════════════════════════════════════════════════════════════════
  async function startFlight() {
    if (!isLoggedIn()) {
      alert('Login with Discord to start a flight.');
      return;
    }

    flightActive = true;
    flightStartTime = Date.now();
    totalFlightSecs = 0; totalDistNm = 0; maxAlt = 0; maxSpd = 0;
    flightPathCoords = []; flightPath?.setLatLngs([]);
    lastPlaneSample = null;
    groundPhaseCount = 0;
    airbornePhaseCount = 0;

    document.getElementById('gfs-start').disabled = true;
    document.getElementById('gfs-land').disabled  = false;
    document.getElementById('gfs-timer').classList.add('live');

    timerInterval = setInterval(() => {
      totalFlightSecs = Math.floor((Date.now() - flightStartTime) / 1000);
      setText('gfs-timer', hhmmss(totalFlightSecs));
    }, 1000);

    try {
      await startApexSession();
      flightStatus = 'active';
      updateAutoFlightStatus();
    } catch (e) {
      console.warn('[Apex] session start failed', e);
    }

    const pilotId = getDiscordId();
    if (db && pilotId) {
      try {
        const pos = getPlaneData();
        const ref = await db.collection('pilots').doc(pilotId)
          .collection('flights').add({
            startTime:firebase.firestore.FieldValue.serverTimestamp(),
            startLat:pos?.lat??null, startLon:pos?.lon??null,
            durationSeconds:0, distanceNm:0,
            maxAltitude:0, maxSpeed:0,
            status:'active', pilotId
          });
        currentFlightId = ref.id;
      } catch (e) { console.warn('[G-Dash] Create flight error:', e); }
    }
  }

  async function stopFlight() {
    if (!flightActive) return;

    const savedDuration = totalFlightSecs;
    flightActive = false;
    clearInterval(timerInterval);

    document.getElementById('gfs-start').disabled = false;
    document.getElementById('gfs-land').disabled  = true;
    document.getElementById('gfs-timer').classList.remove('live');
    setText('gfs-timer','00:00:00');
    totalFlightSecs = 0;
    groundPhaseCount = 0;
    airbornePhaseCount = 0;

    await endApexSession();

    const pilotId = getDiscordId();
    if (db && currentFlightId && pilotId) {
      try {
        await db.collection('pilots').doc(pilotId)
          .collection('flights').doc(currentFlightId).update({
            durationSeconds: savedDuration,
            distanceNm:      parseFloat(totalDistNm.toFixed(2)),
            maxAltitude:     maxAlt, maxSpeed:maxSpd,
            endTime:         firebase.firestore.FieldValue.serverTimestamp(),
            status:          'completed'
          });
      } catch (e) { console.warn('[G-Dash] Save flight error:', e); }
      currentFlightId = null;
    }
    await loadFlights();
    flightStatus = 'idle';
    updateAutoFlightStatus();
  }

  async function saveAndClearFlight() {
    if (!flightActive) {
      alert('No active flight to save.');
      return;
    }

    const savedDuration = totalFlightSecs;
    const savedDistNm = totalDistNm;
    const savedMaxAlt = maxAlt;
    const savedMaxSpd = maxSpd;

    const pilotId = getDiscordId();
    if (!db || !pilotId) {
      alert('Login required to save flight.');
      return;
    }

    try {
      // Save current flight data to Firebase
      const pos = getPlaneData();
      const ref = await db.collection('pilots').doc(pilotId)
        .collection('flights').add({
          startTime: firebase.firestore.FieldValue.serverTimestamp(),
          startLat: flightPathCoords.length > 0 ? flightPathCoords[0][0] : pos?.lat ?? null,
          startLon: flightPathCoords.length > 0 ? flightPathCoords[0][1] : pos?.lon ?? null,
          durationSeconds: savedDuration,
          distanceNm: parseFloat(savedDistNm.toFixed(2)),
          maxAltitude: savedMaxAlt,
          maxSpeed: savedMaxSpd,
          endTime: firebase.firestore.FieldValue.serverTimestamp(),
          status: 'completed',
          pilotId,
          manualSave: true
        });

      console.log('[G-Dash] Manual save successful:', ref.id);

      // Reset current flight data but keep automatic system running
      totalFlightSecs = 0;
      totalDistNm = 0;
      maxAlt = 0;
      maxSpd = 0;
      flightPathCoords = [];
      flightPath?.setLatLngs([]);
      flightStartTime = Date.now();

      // Update the current flight ID to the new saved flight
      currentFlightId = ref.id;

      // Reload flights to show the new entry
      await loadFlights();

      alert('Flight saved successfully! Automatic tracking continues.');
    } catch (e) {
      console.error('[G-Dash] Manual save error:', e);
      alert('Failed to save flight: ' + (e.message || 'Unknown error'));
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  SETTINGS UI
  // ════════════════════════════════════════════════════════════════════════════
  function updateSettingsUI() {
    const keyEl    = document.getElementById('keybind-key');
    const statusEl = document.getElementById('keybind-status');
    if (keyEl)    keyEl.textContent    = formatKey(settings.keybind);
    if (statusEl) statusEl.textContent = 'Press "Change Key" to set a new shortcut';
  }

  function formatKey(k) {
    if (!k) return '—';
    if (k === '`') return '` (backtick)';
    if (k === ' ') return 'Space';
    if (k.length === 1) return k.toUpperCase();
    return k;
  }

  let listeningForKey = false;
  function startKeyCapture() {
    listeningForKey = true;
    const btn    = document.getElementById('keybind-capture-btn');
    const status = document.getElementById('keybind-status');
    if (btn)    { btn.classList.add('listening'); btn.textContent = 'Press any key...'; }
    if (status) status.textContent = 'Listening — press any key now';
  }
  function stopKeyCapture(key) {
    listeningForKey = false;
    const btn    = document.getElementById('keybind-capture-btn');
    const keyEl  = document.getElementById('keybind-key');
    const status = document.getElementById('keybind-status');
    if (btn) { btn.classList.remove('listening'); btn.textContent = 'Change Key'; }
    if (key) {
      settings.keybind = key;
      saveSettings(settings);
      if (keyEl)  keyEl.textContent  = formatKey(key);
      if (status) status.textContent = 'Saved! New shortcut: ' + formatKey(key);
    } else {
      if (status) status.textContent = 'Cancelled';
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  SIZE TOGGLE  +  COMPACT DRAG
  // ════════════════════════════════════════════════════════════════════════════
  function initSizeToggle() {
    const toggle = document.getElementById('size-toggle');
    const knob   = document.getElementById('size-toggle-knob');
    const label  = document.getElementById('size-mode-label');
    const tablet = document.getElementById('gfs-tablet');
    const ov     = document.getElementById('gfs-overlay');
    if (!toggle) return;

    // ── draggable tablet (compact mode only) ────────────────────────────────
    let tDragged = false, tStartX, tStartY, tStartL, tStartT;

    function onTabletMouseMove(e) {
      const dx = e.clientX - tStartX;
      const dy = e.clientY - tStartY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) tDragged = true;
      if (!tDragged) return;
      let nl = tStartL + dx;
      let nt = tStartT + dy;
      nl = Math.max(0, Math.min(window.innerWidth  - tablet.offsetWidth,  nl));
      nt = Math.max(0, Math.min(window.innerHeight - tablet.offsetHeight, nt));
      tablet.style.left = nl + 'px';
      tablet.style.top  = nt + 'px';
    }

    function onTabletMouseUp() {
      tablet.classList.remove('tablet-dragging');
      document.getElementById('gfs-topbar')?.classList.remove('tablet-dragging');
      document.removeEventListener('mousemove', onTabletMouseMove);
      document.removeEventListener('mouseup',   onTabletMouseUp);
      if (tDragged) {
        const r = tablet.getBoundingClientRect();
        settings.compactX = r.left;
        settings.compactY = r.top;
        saveSettings(settings);
      }
    }

    const topbarDrag = document.getElementById('gfs-topbar');

    function attachTabletDrag() {
      if (topbarDrag) topbarDrag.addEventListener('mousedown', onTabletDragStart);
    }
    function detachTabletDrag() {
      if (topbarDrag) topbarDrag.removeEventListener('mousedown', onTabletDragStart);
    }

    function onTabletDragStart(e) {
      if (!settings.quarterScreen) return;
      if (e.target.closest('button, input, select, a, #gfs-close')) return;
      if (e.button !== 0) return;
      tDragged = false;
      tStartX  = e.clientX;
      tStartY  = e.clientY;
      const r  = tablet.getBoundingClientRect();
      tStartL  = r.left;
      tStartT  = r.top;
      topbarDrag?.classList.add('tablet-dragging');
      document.addEventListener('mousemove', onTabletMouseMove);
      document.addEventListener('mouseup',   onTabletMouseUp);
    }

    // ── apply size state ─────────────────────────────────────────────────────
    function applySize(quarter) {
      settings.quarterScreen = quarter;
      saveSettings(settings);

      if (quarter) {
        const panelW = Math.min(400, Math.round(window.innerWidth * 0.92));
        const cx = settings.compactX ?? Math.max(8, window.innerWidth - panelW - 16);
        const cy = settings.compactY ?? Math.round(window.innerHeight * 0.05);
        tablet.style.left = cx + 'px';
        tablet.style.top  = cy + 'px';

        tablet.classList.add('quarter-screen');
        ov.classList.add('compact-mode');
        attachTabletDrag();

        toggle.style.background  = ACCENT_COLOR + '33';
        toggle.style.borderColor = ACCENT_COLOR;
        knob.style.transform     = 'translateX(24px)';
        knob.style.background    = ACCENT_COLOR;
        label.textContent        = 'PORTRAIT';
        label.style.color        = ACCENT_COLOR;
      } else {
        tablet.classList.remove('quarter-screen');
        ov.classList.remove('compact-mode');
        // Reset inline position so the overlay flex-centre takes over again
        tablet.style.left = '';
        tablet.style.top  = '';
        detachTabletDrag();

        toggle.style.background  = '#0a1928';
        toggle.style.borderColor = '#1e3d58';
        knob.style.transform     = 'translateX(0)';
        knob.style.background    = '#4a7a9a';
        label.textContent        = 'NORMAL';
        label.style.color        = '#7fb3cc';
      }

      if (map) {
        setTimeout(() => {
          map.invalidateSize(true);
          if (map.dragging && settings.quarterScreen) map.dragging.enable();
        }, 80);
        setTimeout(() => map.invalidateSize(true), 350);
      }
    }

    toggle.addEventListener('click', () => applySize(!settings.quarterScreen));
    // Restore saved preference on load
    if (settings.quarterScreen) applySize(true);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  TAB SWITCHING
  // ════════════════════════════════════════════════════════════════════════════
  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.gfs-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.gfs-panel').forEach(p =>
      p.classList.toggle('active', p.id === `gfs-panel-${tab}`));
    if (tab === 'map' && map) setTimeout(() => map.invalidateSize(), 60);
    if (tab === 'stats')    loadFlights();
    if (tab === 'settings') updateSettingsUI();
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  DRAGGABLE BUTTON
  // ════════════════════════════════════════════════════════════════════════════
  function makeDraggable(el) {
    let startX, startY, startLeft, startTop, dragged = false;

    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      dragged   = false;
      startX    = e.clientX;
      startY    = e.clientY;
      const r   = el.getBoundingClientRect();
      startLeft = r.left;
      startTop  = r.top;
      el.classList.add('dragging');

      const onMove = e2 => {
        const dx = e2.clientX - startX;
        const dy = e2.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragged = true;
        if (!dragged) return;
        let newLeft = startLeft + dx;
        let newTop  = startTop  + dy;
        newLeft = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  newLeft));
        newTop  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, newTop));
        el.style.left   = newLeft + 'px';
        el.style.top    = newTop  + 'px';
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
      };

      const onUp = () => {
        el.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        if (dragged) {
          const r2 = el.getBoundingClientRect();
          settings.btnX = r2.left;
          settings.btnY = r2.top;
          saveSettings(settings);
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });

    el.addEventListener('click', e => { if (dragged) { dragged = false; e.stopImmediatePropagation(); } });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  CLOCK
  // ════════════════════════════════════════════════════════════════════════════
  function startClock() {
    setInterval(() => {
      setText('gfs-utc', 'UTC  ' + new Date().toUTCString().slice(17,22));
    }, 1000);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  MAIN INIT
  // ════════════════════════════════════════════════════════════════════════════
  function bindAuthButtons() {
    const doLogin = async () => {
      try {
        setText('gfs-auth-status', 'Connecting…');
        await loginWithDiscord();
      } catch (e) {
        setText('gfs-auth-status', e.message || 'Login failed');
        console.warn('[Apex] login', e);
      }
    };
    const doLogout = async () => {
      try { await logoutApex(); } catch (e) { console.warn('[Apex] logout', e); }
    };

    document.getElementById('gfs-discord-login')?.addEventListener('click', doLogin);
    document.getElementById('gfs-login-btn')?.addEventListener('click', doLogin);
    document.getElementById('gfs-settings-login')?.addEventListener('click', doLogin);
    document.getElementById('gfs-logout-btn')?.addEventListener('click', doLogout);
    document.getElementById('gfs-settings-logout')?.addEventListener('click', doLogout);
  }

  async function init() {
    await loadLeaflet();
    await loadFirebase();
    injectStyles();
    buildDOM();
    bindAuthButtons();
    updateAuthUI();

    const ov  = document.getElementById('gfs-overlay');
    const btn = document.getElementById('gfs-btn');

    function openDash() {
      ov.style.display = 'flex';
      if (!map) initMap();
      startPositionLoop();
      setTimeout(() => {
        if (map) {
          map.invalidateSize(true);
          if (map.dragging) map.dragging.enable();
        }
      }, 80);
      setTimeout(() => { if (map) map.invalidateSize(true); }, 350);
    }
    function closeDash() {
      ov.style.display = 'none';
    }

    btn.addEventListener('click', () => {
      if (ov.style.display !== 'flex') openDash(); else closeDash();
    });
    document.getElementById('gfs-close').addEventListener('click', closeDash);
    ov.addEventListener('click', e => {
      if (e.target.id === 'gfs-overlay') closeDash();
    });

    // Stop keyboard events leaking into GeoFS while overlay is open
    ['keydown','keyup','keypress'].forEach(ev => {
      ov.addEventListener(ev, e => e.stopPropagation(), true);
    });

    // Global keybind listener
    document.addEventListener('keydown', e => {
      if (listeningForKey) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') { stopKeyCapture(null); return; }
        stopKeyCapture(e.key);
        return;
      }
      if (ov.style.display !== 'flex' && e.key === settings.keybind) {
        e.preventDefault();
        openDash();
      }
    }, true);

    document.querySelectorAll('.gfs-tab').forEach(t =>
      t.addEventListener('click', () => switchTab(t.dataset.tab)));

    document.getElementById('gfs-start').addEventListener('click', () => startFlight().catch(console.warn));
    document.getElementById('gfs-land').addEventListener('click', () => stopFlight().catch(console.warn));
    document.getElementById('gfs-save-clear').addEventListener('click', () => saveAndClearFlight().catch(console.warn));

    document.getElementById('confirm-yes-btn').addEventListener('click', confirmDelete);
    document.getElementById('confirm-no-btn').addEventListener('click',  hideDeleteConfirm);

    document.getElementById('keybind-capture-btn').addEventListener('click', startKeyCapture);

    document.getElementById('btn-pos-reset').addEventListener('click', () => {
      settings.btnX = null; settings.btnY = null;
      saveSettings(settings);
      btn.style.left   = '';
      btn.style.top    = '';
      btn.style.right  = '26px';
      btn.style.bottom = '26px';
    });

    makeDraggable(btn);
    initSizeToggle();

    await initApexAuth();
    startClock();
    updateSettingsUI();

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'hidden' && apexSessionId && !flightActive) {
        isLoggingOut = true;
        await endApexSession().catch(() => {});
        const discordId = getDiscordId();
        if (discordId) await setPilotOffline(discordId);
        isLoggingOut = false;
      } else if (document.visibilityState === 'visible' && isLoggedIn() && !apexSessionId) {
        // Restore pilot online status when tab becomes visible
        const discordId = getDiscordId();
        if (discordId && db) {
          db.collection(COLLECTIONS.PILOTS).doc(discordId).update({
            online: true,
            lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
          }).catch(() => {});
        }
      }
    });
    window.addEventListener('pagehide', async () => {
      isLoggingOut = true;
      if (apexSessionId && !flightActive) {
        await endApexSession().catch(() => {});
      }
      const discordId = getDiscordId();
      if (discordId) await setPilotOffline(discordId);
    });

    const pilot = getDiscordId();
    console.log(`[G-Dash] Ready  |  ${pilot ? 'Pilot ' + pilot : 'Guest — login required'}  |  Key: ${formatKey(settings.keybind)}`);
  }

  const waitReady = setInterval(() => {
    if (document.readyState === 'complete') {
      clearInterval(waitReady);
      setTimeout(init, 2500);
    }
  }, 500);

})();