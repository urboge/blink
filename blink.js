// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SUPABASE_URL      = 'https://gkrfiyalbjbgkjevmpod.supabase.co';
const SUPABASE_KEY      = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrcmZpeWFsYmpiZ2tqZXZtcG9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MjA0OTksImV4cCI6MjA5NzE5NjQ5OX0.TXLwbzyyPcjJCGNnDKdHhA_4t1J4MD5FZHxQapEz4gY';
const TABLE             = 'messages';
const POLL_INTERVAL     = 3000;
const SERVER_LIMIT      = 500;
const MAX_IMAGE_BYTES   = 100 * 1024;
const MAX_STICKER_BYTES = 20 * 1024;
const MAX_AVATAR_BYTES  = 8 * 1024;
const IMAGE_EXPIRY_MS   = 30 * 24 * 60 * 60 * 1000;

// ─── STATE ────────────────────────────────────────────────────────────────────
let myUsername       = '';
let myAvatar         = '';
let avatars          = {};
let notificationsOn  = true;
let contacts         = [];
let chats            = {};
let groups           = [];
let activeCode       = null;
let replyTarget      = null; // the message currently being replied to, if any
let activeType       = 'dm';
let stickerData      = [];
let activeStickerCat = 'favourites';
let favStickers      = [];
let customStickers   = [];
let stories          = {};
let myStory          = null;
let storyViewerQueue = [];
let storyViewerIdx   = 0;
let storyTimer       = null;
let editMode         = false;
let selectedContacts = new Set();

// Device identity / sync
let myDeviceId       = '';
let lastSyncCheckin  = 0;
const DEVICE_CHECKIN_INTERVAL = 60 * 1000;

// Blink camera / snap state
let cameraStream      = null;
let usingFrontCamera  = true;
let capturedSnapData  = null; // base64 of the captured photo, pre-send
let snapSelectedRecipients = new Set();
let streaks           = {}; // { contactCode: { count, lastSentDate, lastReceivedDate } }
const SNAP_VIEW_SECONDS = 5;
const MAX_SNAP_BYTES = 150 * 1024; // one-time Blink photos, slightly larger than chat images since they're ephemeral

// Voice recording state
let mediaRecorder     = null;
let recordedChunks    = [];
let recordingStartTime = null;
let recordingTimerInt = null;
let recordedBlob      = null;
let recordedDuration  = 0;
let recordingStream   = null;
let voicePreviewAudio = null;
const MAX_VOICE_SECONDS = 60;
const MAX_FILE_BYTES = 500 * 1024; // 500KB cap for generic files

const REACTIONS     = ['👍','❤️','😂','😮','😢','🔥'];
const AVATAR_COLORS = ['av-blue','av-purple','av-pink','av-green','av-orange','av-teal'];
const isMobile      = () => window.innerWidth <= 640;

// ─── LOCALSTORAGE ─────────────────────────────────────────────────────────────
function ls(key, val) {
  if (val === undefined) return localStorage.getItem(key);
  localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
}
function saveContacts()       { ls('contacts',       JSON.stringify(contacts)); }
function saveChats()          { ls('chats',          JSON.stringify(chats)); }
function saveGroups()         { ls('groups',         JSON.stringify(groups)); }
function saveFavStickers()    { ls('favStickers',    JSON.stringify(favStickers)); }
function saveCustomStickers() { ls('customStickers', JSON.stringify(customStickers)); }
function saveAvatars()        { ls('avatars',        JSON.stringify(avatars)); }
function saveStories()        { ls('stories',        JSON.stringify(stories)); }
function saveMyStory()        { ls('myStory',        JSON.stringify(myStory)); }
function saveStreaks()        { ls('streaks',        JSON.stringify(streaks)); }

const STORY_EXPIRY_MS = 24 * 60 * 60 * 1000;
const MAX_STORY_BYTES = 120 * 1024;

function validateUsername(name) {
  return /^[a-zA-Z0-9_]{1,24}$/.test(name);
}

// ─── IMAGE EXPIRY ─────────────────────────────────────────────────────────────
function cleanExpiredImages() {
  const expiry = Date.now() - IMAGE_EXPIRY_MS;
  let changed = false;
  Object.keys(chats).forEach(code => {
    if (!chats[code]) return;
    chats[code] = chats[code].map(m => {
      if (m.type === 'image' && m.text?.startsWith('data:') && m.time < expiry) {
        changed = true;
        return { ...m, text: null, expired: true };
      }
      return m;
    });
  });
  if (changed) saveChats();
}

// ─── IMAGE COMPRESSION ────────────────────────────────────────────────────────
async function compressImage(file, maxBytes = MAX_IMAGE_BYTES, maxDim = 1200, startQ = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else       { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      let quality = startQ;
      const tryCompress = () => {
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error('Compression failed')); return; }
          if (blob.size <= maxBytes || quality <= 0.05) {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.readAsDataURL(blob);
          } else { quality = Math.max(0.05, quality - 0.1); tryCompress(); }
        }, 'image/jpeg', quality);
      };
      tryCompress();
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ─── USERNAME REGISTRY ────────────────────────────────────────────────────────
async function isUsernameTaken(username) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/usernames?username=eq.${encodeURIComponent(username)}&select=username`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return rows.length > 0;
  } catch(e) { return false; }
}
async function registerUsername(username) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/usernames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ username })
    });
  } catch(e) {}
}
async function releaseUsername(username) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/usernames?username=eq.${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
  } catch(e) {}
}

// ─── DEVICE IDENTITY ───────────────────────────────────────────────────────────
function getOrCreateDeviceId() {
  let id = ls('myDeviceId');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    ls('myDeviceId', id);
  }
  return id;
}

async function registerDevice() {
  if (!myUsername || !myDeviceId) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        device_id: myDeviceId, username: myUsername,
        device_label: guessDeviceLabel(), last_seen: new Date().toISOString()
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('registerDevice failed:', res.status, errText);
    }
  } catch(e) { console.error('registerDevice exception:', e); }
}

async function checkinDevice() {
  if (!myUsername || !myDeviceId) return;
  if (Date.now() - lastSyncCheckin < DEVICE_CHECKIN_INTERVAL) return;
  lastSyncCheckin = Date.now();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/devices?device_id=eq.${myDeviceId}&select=force_signed_out`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    if (res.ok) {
      const rows = await res.json();
      if (rows[0]?.force_signed_out) {
        // Admin forced this specific device out — wipe local data and
        // return to the welcome screen, same as a normal "remove device."
        localStorage.clear();
        window.location.reload();
        return;
      }
    }
    await fetch(`${SUPABASE_URL}/rest/v1/devices?device_id=eq.${myDeviceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ last_seen: new Date().toISOString() })
    });
  } catch(e) {}
}

function guessDeviceLabel() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return isMobile() ? 'Android Phone' : 'Android Tablet';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Device';
}

async function getMyOtherDevices() {
  if (!myUsername) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/devices?username=eq.${encodeURIComponent(myUsername)}&device_id=neq.${myDeviceId}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch(e) { return []; }
}

// Fetches ALL devices for this account (including this one), ordered oldest
// first. The oldest is treated as the "primary" device — the one that
// originally created the account, before any others were linked.
async function getAllMyDevices() {
  if (!myUsername) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/devices?username=eq.${encodeURIComponent(myUsername)}&select=*&order=created_at.asc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch(e) { return []; }
}

function isPrimaryDevice(allDevices) {
  if (!allDevices.length) return true; // only device, or lookup failed — treat as primary
  return allDevices[0].device_id === myDeviceId;
}

// Removes ANOTHER device's row from the devices table (used by the primary
// device to kick a secondary off the account) and notifies that device so it
// can wipe its own local data and return to the welcome screen.
async function removeOtherDevice(deviceId) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/devices?device_id=eq.${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    await pushToSupabase(myUsername, '', 'device_removed', { targetDeviceId: deviceId });
    deviceListCache.delete(myUsername); // force fresh lookup next send
  } catch(e) {}
}

// Removes only THIS device's row from the devices table. Used when a
// secondary device "leaves" the account without destroying the shared
// username, since other devices may still be actively using it.
async function unregisterThisDevice() {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/devices?device_id=eq.${myDeviceId}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
  } catch(e) {}
}

// ─── DEVICE LINKING (new device joins existing account) ───────────────────────
function generateLinkCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendLinkRequest(targetUsername, requestingDeviceId) {
  // Requesting device has no username yet — sends "from" as its deviceId
  await pushRaw(requestingDeviceId, targetUsername, requestingDeviceId, 'link_request');
}

async function respondToLinkRequest(targetUsername, requestingDeviceId) {
  // This device (the existing, logged-in one) generates a code and stores it server-side
  const code = generateLinkCode();
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/link_requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ target_username: myUsername, requesting_device_id: requestingDeviceId, code })
    });
  } catch(e) {}
  return code;
}

async function submitLinkCode(targetUsername, requestingDeviceId, enteredCode) {
  // Requesting device sends the code back to be verified by the EXISTING device.
  await pushRaw(requestingDeviceId, targetUsername, JSON.stringify({ requestingDeviceId, code: enteredCode }), 'link_confirm');
}

async function verifyAndApproveLinkConfirm(requestingDeviceId, submittedCode) {
  // Runs on the EXISTING device. Looks up the real pending code server-side.
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/link_requests?requesting_device_id=eq.${encodeURIComponent(requestingDeviceId)}&target_username=eq.${encodeURIComponent(myUsername)}&order=created_at.desc&limit=1&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    if (!rows.length) return false;
    const req = rows[0];

    const expired = new Date(req.expires_at) < new Date();
    if (expired) return false;

    if (req.attempts >= 5) return false; // rate limit

    if (req.code !== submittedCode) {
      await fetch(`${SUPABASE_URL}/rest/v1/link_requests?id=eq.${req.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ attempts: req.attempts + 1 })
      });
      return false;
    }

    await pushRaw(myUsername, requestingDeviceId, JSON.stringify({ username: myUsername }), 'link_approved');
    await fetch(`${SUPABASE_URL}/rest/v1/link_requests?id=eq.${req.id}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    return true;
  } catch(e) { return false; }
}

function showLinkApprovalUI(requestingDeviceId, code) {
  // Shown on the EXISTING, already-logged-in device as a special non-chat banner
  document.getElementById('link-approval-code').textContent = code;
  document.getElementById('link-approval-overlay').classList.add('open');
  clearTimeout(window._linkApprovalTimeout);
  window._linkApprovalTimeout = setTimeout(() => {
    document.getElementById('link-approval-overlay').classList.remove('open');
  }, 5 * 60 * 1000);
}

// ─── LINKING POLL LOOP (used on welcome screen, before myUsername exists) ─────
let linkingPollInterval = null;

function startLinkingPoll(onMessage) {
  stopLinkingPoll();
  linkingPollInterval = setInterval(async () => {
    const rows = await pollRaw(myDeviceId);
    if (!rows.length) return;
    const ids = rows.map(r => r.id);
    rows.forEach(r => onMessage(r));
    await deleteMessageIds(ids);
  }, 2500);
}
function stopLinkingPoll() {
  if (linkingPollInterval) { clearInterval(linkingPollInterval); linkingPollInterval = null; }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function fetchAppConfig() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_config?select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    if (!res.ok) return {};
    const rows = await res.json();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  } catch(e) { return {}; }
}

function showMaintenanceScreen() {
  document.body.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:12px;text-align:center;padding:0 20px;font-family:-apple-system,sans-serif;color:#fff;background:#000;">
      <div style="font-size:40px;">🛠️</div>
      <h1 style="font-size:20px;">Blink is under maintenance</h1>
      <p style="color:#8e8e93;font-size:14px;max-width:320px;">We'll be back shortly. Thanks for your patience.</p>
    </div>`;
}

function showBroadcastBanner(message) {
  if (!message) return;
  const banner = document.createElement('div');
  banner.id = 'broadcast-banner';
  banner.style.cssText = `
    position: relative; z-index: 50; flex-shrink: 0;
    background: #2563eb; color: #fff; font-size: 13px; font-weight: 600;
    text-align: center; padding: 9px 36px; line-height: 1.4;
  `;
  banner.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: #fff; opacity: 0.8;
    font-size: 14px; cursor: pointer; padding: 4px;
  `;
  closeBtn.addEventListener('click', () => banner.remove());
  banner.appendChild(closeBtn);

  // Insert as a real element ABOVE the app, in normal document flow, so it
  // pushes the sidebar/chat area down instead of floating on top of them.
  document.body.insertBefore(banner, document.body.firstChild);
}

async function isUsernameBlacklisted(username) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/username_blacklist?username=eq.${encodeURIComponent(username)}&select=username,expires_at`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    if (!rows.length) return false;
    const entry = rows[0];
    // No expiry = permanent ban. If an expiry exists and has already
    // passed, treat it as no longer blocked.
    if (entry.expires_at && new Date(entry.expires_at) < new Date()) return false;
    return true;
  } catch(e) { return false; }
}

function showBlockedScreen() {
  document.body.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:12px;text-align:center;padding:0 20px;font-family:-apple-system,sans-serif;color:#fff;background:#000;">
      <div style="font-size:40px;">🚫</div>
      <h1 style="font-size:20px;">This account can't access Blink</h1>
      <p style="color:#8e8e93;font-size:14px;max-width:320px;">If you believe this is a mistake, contact support.</p>
    </div>`;
}

// ─── CLIENT ERROR LOGGING ───────────────────────────────────────────────────────
// Best-effort reporting of real runtime errors so they're visible in the
// admin dashboard instead of silently failing in someone's browser with no
// way for you to ever find out.
async function logClientError(message, stack, context) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/client_errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ username: myUsername || null, message: String(message).slice(0, 500), stack: stack ? String(stack).slice(0, 2000) : null, context: context || null })
    });
  } catch(e) { /* never let error logging itself throw */ }
}

window.addEventListener('error', (e) => {
  logClientError(e.message, e.error?.stack, 'window.onerror');
});
window.addEventListener('unhandledrejection', (e) => {
  logClientError(e.reason?.message || String(e.reason), e.reason?.stack, 'unhandledrejection');
});

async function checkScheduledBroadcasts() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/scheduled_broadcasts?shown=eq.false&show_at=lte.${new Date().toISOString()}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return;
    const rows = await res.json();
    if (!rows.length) return;
    // Show the most recent due broadcast, mark all due ones as shown so they
    // don't repeat for this or other users once their time has passed.
    showBroadcastBanner(rows[rows.length - 1].message);
    const ids = rows.map(r => r.id);
    fetch(`${SUPABASE_URL}/rest/v1/scheduled_broadcasts?id=in.(${ids.join(',')})`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ shown: true })
    }).catch(() => {});
  } catch(e) {}
}

async function init() {
  // Safety net: force-remove splash from layout once its fade-out finishes,
  // regardless of CSS animation timing — guarantees it never blocks clicks.
  setTimeout(() => {
    const splashEl = document.getElementById('splash');
    if (splashEl) splashEl.style.display = 'none';
  }, 2200);

  // Check admin-controlled app config before doing anything else.
  const config = await fetchAppConfig();
  if (config.maintenance_mode === 'true') { showMaintenanceScreen(); return; }
  if (config.broadcast_message) showBroadcastBanner(config.broadcast_message);
  window._signupsDisabled = config.disable_signups === 'true';
  checkScheduledBroadcasts();

  myUsername = ls('myUsername') || '';
  myDeviceId = getOrCreateDeviceId();
  const oldCode = ls('myCode');
  if (oldCode && !myUsername) ls('myCode', '');

  // If this device already has an account, make sure it hasn't since been
  // blocked — checked every time the app loads, not just at signup.
  if (myUsername && await isUsernameBlacklisted(myUsername)) {
    showBlockedScreen();
    return;
  }

  const appEl = document.getElementById('app');
  appEl.style.animation = 'none';
  appEl.style.opacity = '1';

  if (!myUsername) {
    document.getElementById('welcome-screen').style.display = 'flex';
    startLinkingPoll(handleLinkingPollMessage);
    return;
  }
  startApp();
}

// Handles messages received on the welcome screen, before an account exists.
// Only one message type matters here: link_approved.
function handleLinkingPollMessage(r) {
  if (r.type === 'link_approved') {
    try {
      const { username } = JSON.parse(r.text);
      completeLinking(username);
    } catch(e) {}
  }
}

async function completeLinking(username) {
  stopLinkingPoll();
  myUsername = username;
  ls('myUsername', myUsername);
  document.getElementById('link-modal').classList.remove('open');
  document.getElementById('welcome-screen').style.display = 'none';
  toast('Connected as @' + username);
  await registerDevice();
  startApp();
}

async function startApp() {
  document.getElementById('my-username-display').textContent = myUsername;
  contacts       = JSON.parse(ls('contacts')       || '[]');
  chats          = JSON.parse(ls('chats')          || '{}');
  groups         = JSON.parse(ls('groups')         || '[]');
  favStickers    = JSON.parse(ls('favStickers')    || '[]');
  customStickers = JSON.parse(ls('customStickers') || '[]');
  avatars        = JSON.parse(ls('avatars')        || '{}');
  myAvatar       = ls('myAvatar') || '';
  stories        = JSON.parse(ls('stories')        || '{}');
  myStory        = JSON.parse(ls('myStory')        || 'null');
  streaks        = JSON.parse(ls('streaks')        || '{}');
  notificationsOn = ls('notificationsOn') !== 'false';
  updateMyAvatarUI();
  cleanExpiredImages();
  cleanExpiredStories();
  renderContacts();
  await loadStickers();
  await registerDevice();
  if (SUPABASE_URL && SUPABASE_KEY) {
    setInterval(pollMessages, POLL_INTERVAL);
    setInterval(checkinDevice, DEVICE_CHECKIN_INTERVAL);
    checkinDevice();
    maybeAutoSync();
  }
  const lastChat = ls('lastChat');
  const lastType = ls('lastType') || 'dm';
  if (lastChat) {
    if (lastType === 'group' && groups.find(g => g.id === lastChat)) openGroup(lastChat);
    else if (lastType === 'dm' && contacts.find(c => c.code === lastChat)) openChat(lastChat);
  }
}

// ─── SET USERNAME ─────────────────────────────────────────────────────────────
async function setUsername(newUsername, isFirstTime = false) {
  const oldUsername = myUsername;
  myUsername = newUsername;
  ls('myUsername', myUsername);
  document.getElementById('my-username-display').textContent = myUsername;
  if (!isFirstTime && oldUsername) {
    const payload = JSON.stringify({ oldCode: oldUsername, newCode: newUsername, username: newUsername });
    const promises = contacts.map(c => pushToSupabase(c.code, payload, 'code_change'));
    await Promise.all(promises);
    contacts.forEach(c => addSystemMessage(c.code, `You changed your username to ${newUsername}`));
    groups.forEach(g => addSystemMessage(g.id, `You changed your username to ${newUsername}`));
  }
}

// ─── AVATAR ───────────────────────────────────────────────────────────────────
function avatarColor(code) {
  let n = 0; for (const c of (code||'x')) n += c.charCodeAt(0);
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}
function avatarLetter(name) { return (name||'?').trim()[0].toUpperCase(); }
function getAvatar(username) { return username === myUsername ? myAvatar : (avatars[username] || ''); }

function renderAvatarEl(el, username, name, size = 44) {
  const pic = getAvatar(username);
  if (pic) {
    el.innerHTML = `<img src="${pic}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block;">`;
    el.className = el.className.replace(/av-\S+/g, '').trim() + ' avatar-img';
  } else {
    el.innerHTML = avatarLetter(name || username);
    el.className = el.className.replace('avatar-img','').trim();
    if (!el.className.includes('av-')) el.className += ' ' + avatarColor(username);
  }
}

function updateMyAvatarUI() {
  const el = document.getElementById('my-avatar-preview');
  if (!el) return;
  if (myAvatar) {
    el.innerHTML = `<img src="${myAvatar}" style="width:52px;height:52px;border-radius:50%;object-fit:cover;display:block;">`;
  } else {
    el.textContent = avatarLetter(myUsername);
    el.className = 'avatar settings-avatar ' + avatarColor(myUsername);
  }
}

async function setProfilePicture(file) {
  try {
    const base64 = await compressImage(file, MAX_AVATAR_BYTES, 80, 0.7);
    myAvatar = base64;
    ls('myAvatar', myAvatar);
    updateMyAvatarUI();
    const payload = JSON.stringify({ username: myUsername, avatar: base64 });
    contacts.forEach(c => pushToSupabase(c.code, payload, 'avatar_update'));
    toast('Profile picture updated');
    if (activeCode && activeType === 'dm') {
      renderAvatarEl(document.getElementById('chat-avatar'), myUsername, myUsername, 44);
    }
    renderContacts(document.getElementById('search').value);
  } catch(e) { toast('Failed to set profile picture'); }
}

function removeProfilePicture() {
  myAvatar = '';
  ls('myAvatar', '');
  updateMyAvatarUI();
  const payload = JSON.stringify({ username: myUsername, avatar: '' });
  contacts.forEach(c => pushToSupabase(c.code, payload, 'avatar_update'));
  toast('Profile picture removed');
  renderContacts(document.getElementById('search').value);
}

function groupAvatarSVG(colorClass) {
  return `<svg class="group-avatar-svg" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
    <circle cx="22" cy="22" r="22" class="${colorClass}" fill="currentColor"/>
    <circle cx="16" cy="18" r="5" fill="rgba(255,255,255,0.9)"/>
    <circle cx="28" cy="18" r="5" fill="rgba(255,255,255,0.9)"/>
    <path d="M6 36c0-5 4-8 10-8h12c6 0 10 3 10 8" stroke="rgba(255,255,255,0.9)" stroke-width="2" stroke-linecap="round" fill="none"/>
  </svg>`;
}

// ─── STORY EDITOR ─────────────────────────────────────────────────────────────
let editorImg        = null;
let editorElements   = [];
let editorDragging   = null;
let editorActiveColor = '#ffffff';
let editorBgOn        = false;
let editorEditingText = null;

function openStoryEditor(file) {
  const reader = new FileReader();
  reader.onload = e => {
    editorImg = new Image();
    editorImg.onload = () => {
      editorElements = [];
      document.getElementById('story-editor').classList.add('open');
      renderEditorCanvas();
    };
    editorImg.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function closeStoryEditor() {
  document.getElementById('story-editor').classList.remove('open');
  editorImg = null;
  editorElements = [];
  document.getElementById('story-editor-overlay').innerHTML = '';
}

function getEditorCanvas() { return document.getElementById('story-editor-canvas'); }

function renderEditorCanvas() {
  const canvas = getEditorCanvas();
  const wrap = document.getElementById('story-editor-canvas-wrap');
  const w = wrap.clientWidth, h = wrap.clientHeight;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  if (editorImg) {
    const imgRatio = editorImg.width / editorImg.height;
    const boxRatio = w / h;
    let dw, dh, dx, dy;
    if (imgRatio > boxRatio) { dh = h; dw = h * imgRatio; dx = (w - dw) / 2; dy = 0; }
    else { dw = w; dh = w / imgRatio; dx = 0; dy = (h - dh) / 2; }
    ctx.drawImage(editorImg, dx, dy, dw, dh);
  }
  renderEditorOverlay();
}

function renderEditorOverlay() {
  const overlay = document.getElementById('story-editor-overlay');
  overlay.innerHTML = '';
  editorElements.forEach((el, idx) => {
    const div = document.createElement('div');
    div.className = 'editor-element';
    div.style.left = el.x + 'px';
    div.style.top  = el.y + 'px';
    div.style.transform = `translate(-50%,-50%) scale(${el.scale||1}) rotate(${el.rotation||0}deg)`;
    div.dataset.idx = idx;

    if (el.type === 'text') {
      div.innerHTML = `<span class="editor-text-el ${el.bg?'with-bg':''}" style="color:${el.color}; ${el.bg?`background:${elTextBgColor(el.color)}`:''}">${escHtml(el.text)}</span>`;
      div.addEventListener('dblclick', () => editTextElement(idx));
    } else if (el.type === 'sticker') {
      div.innerHTML = `<img src="${el.url}" class="editor-sticker-el">`;
    }
    makeDraggable(div, el);
    overlay.appendChild(div);
  });
}

function elTextBgColor(color) {
  return color === '#ffffff' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)';
}

function makeDraggable(div, el) {
  let startX, startY, origX, origY, moved = false;
  const onStart = (clientX, clientY) => { startX = clientX; startY = clientY; origX = el.x; origY = el.y; moved = false; };
  const onMove = (clientX, clientY) => {
    const dx = clientX - startX, dy = clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    el.x = origX + dx; el.y = origY + dy;
    div.style.left = el.x + 'px'; div.style.top  = el.y + 'px';
  };
  div.addEventListener('mousedown', e => { e.stopPropagation(); onStart(e.clientX, e.clientY);
    const mm = ev => onMove(ev.clientX, ev.clientY);
    const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
    document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
  });
  div.addEventListener('touchstart', e => { e.stopPropagation(); const t = e.touches[0]; onStart(t.clientX, t.clientY); }, { passive: true });
  div.addEventListener('touchmove', e => { const t = e.touches[0]; onMove(t.clientX, t.clientY); }, { passive: true });
}

function addTextElement() {
  const text = document.getElementById('story-text-input').value.trim();
  if (!text) { closeTextPanel(); return; }
  if (editorEditingText !== null) {
    editorElements[editorEditingText].text = text;
    editorElements[editorEditingText].color = editorActiveColor;
    editorElements[editorEditingText].bg = editorBgOn;
  } else {
    const wrap = document.getElementById('story-editor-canvas-wrap');
    editorElements.push({ type: 'text', text, color: editorActiveColor, bg: editorBgOn, x: wrap.clientWidth/2, y: wrap.clientHeight/2, scale: 1, rotation: 0 });
  }
  closeTextPanel();
  renderEditorOverlay();
}

function editTextElement(idx) {
  const el = editorElements[idx];
  editorEditingText = idx;
  document.getElementById('story-text-input').value = el.text;
  editorActiveColor = el.color;
  editorBgOn = el.bg;
  document.querySelectorAll('.story-text-color').forEach(b => b.classList.toggle('active', b.dataset.color === el.color));
  document.getElementById('story-text-bg-toggle').classList.toggle('active', el.bg);
  document.getElementById('story-text-panel').classList.add('open');
  document.getElementById('story-text-input').focus();
}

function closeTextPanel() {
  document.getElementById('story-text-panel').classList.remove('open');
  document.getElementById('story-text-input').value = '';
  editorEditingText = null;
  editorBgOn = false;
  document.getElementById('story-text-bg-toggle').classList.remove('active');
}

function openStickerPanelForStory() {
  document.getElementById('story-sticker-panel').classList.add('open');
  buildStoryStickerTabs();
  renderStoryStickerGrid('favourites');
}
function closeStickerPanelForStory() { document.getElementById('story-sticker-panel').classList.remove('open'); }

function buildStoryStickerTabs() {
  const tabs = document.getElementById('story-sticker-tabs');
  tabs.innerHTML = '';
  [{ id:'favourites', name:'⭐' }, { id:'custom', name:'🖼' }, ...stickerData].forEach(cat => {
    const tab = document.createElement('div');
    tab.className = 'sticker-tab';
    tab.textContent = cat.name;
    tab.addEventListener('click', () => {
      document.querySelectorAll('#story-sticker-tabs .sticker-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      renderStoryStickerGrid(cat.id);
    });
    tabs.appendChild(tab);
  });
}

function renderStoryStickerGrid(catId) {
  const grid = document.getElementById('story-sticker-grid');
  grid.innerHTML = '';
  const stickers = catId==='favourites'?favStickers:catId==='custom'?customStickers:(stickerData.find(c=>c.id===catId)?.stickers||[]);
  stickers.forEach(s => {
    const item = document.createElement('div');
    item.className = 'sticker-item';
    item.innerHTML = `<img src="${s.url}" alt="${s.name}">`;
    item.addEventListener('click', () => {
      const wrap = document.getElementById('story-editor-canvas-wrap');
      editorElements.push({ type:'sticker', url:s.url, x: wrap.clientWidth/2, y: wrap.clientHeight/2, scale:1, rotation:0 });
      closeStickerPanelForStory();
      renderEditorOverlay();
    });
    grid.appendChild(item);
  });
}

async function flattenAndPost() {
  const postBtn = document.getElementById('story-editor-post-btn');
  postBtn.disabled = true;
  postBtn.textContent = 'Posting...';

  try {
    const canvas = getEditorCanvas();
    const ctx = canvas.getContext('2d');
    renderEditorCanvas();

    for (const el of editorElements) {
      ctx.save();
      ctx.translate(el.x, el.y);
      ctx.rotate((el.rotation||0) * Math.PI/180);
      ctx.scale(el.scale||1, el.scale||1);

      if (el.type === 'text') {
        ctx.font = '600 28px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const metrics = ctx.measureText(el.text);
        const padX = 16, padY = 8;
        if (el.bg) {
          ctx.fillStyle = elTextBgColor(el.color);
          const bw = metrics.width + padX*2, bh = 28 + padY*2;
          roundRect(ctx, -bw/2, -bh/2, bw, bh, 10);
          ctx.fill();
        }
        ctx.fillStyle = el.color;
        ctx.fillText(el.text, 0, 0);
      } else if (el.type === 'sticker') {
        await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => { ctx.drawImage(img, -50, -50, 100, 100); resolve(); };
          img.onerror = () => resolve();
          img.src = el.url;
        });
      }
      ctx.restore();
    }

    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    } catch (e) {
      throw new Error('Canvas export blocked: ' + e.message);
    }
    if (!dataUrl || dataUrl === 'data:,') throw new Error('Canvas export produced empty result');

    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], 'story.jpg', { type: 'image/jpeg' });
    closeStoryEditor();
    toast('Posting story...');
    await postStory(file);
  } catch (err) {
    console.error('Story post failed:', err);
    toast('Failed to post story: ' + (err.message || 'unknown error'));
  } finally {
    postBtn.disabled = false;
    postBtn.textContent = 'Post';
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

// ─── VOICE RECORDING ──────────────────────────────────────────────────────────
async function startRecording() {
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch(e) {
    toast('Microphone access denied');
    return false;
  }

  recordedChunks = [];
  let mimeType = 'audio/webm;codecs=opus';
  if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'audio/webm';
  if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';

  try {
    mediaRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType, audioBitsPerSecond: 16000 } : {});
  } catch(e) {
    mediaRecorder = new MediaRecorder(recordingStream);
  }

  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.start();
  recordingStartTime = Date.now();

  showRecordingUI();
  recordingTimerInt = setInterval(updateRecordingTime, 200);
  return true;
}

function updateRecordingTime() {
  const elapsed = (Date.now() - recordingStartTime) / 1000;
  document.getElementById('recording-time').textContent = formatDuration(elapsed);
  if (elapsed >= MAX_VOICE_SECONDS) stopRecording(true);
}

function stopRecording(keep = true) {
  if (!mediaRecorder) return;
  clearInterval(recordingTimerInt);

  const finalize = () => {
    recordingStream?.getTracks().forEach(t => t.stop());
    recordingStream = null;
    hideRecordingUI();

    if (keep && recordedChunks.length) {
      recordedDuration = (Date.now() - recordingStartTime) / 1000;
      if (recordedDuration < 0.6) { toast('Too short'); recordedBlob = null; resetMicButton(); return; }
      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      recordedBlob = new Blob(recordedChunks, { type: mimeType });
      showVoicePreview();
    } else {
      resetMicButton();
    }
    mediaRecorder = null;
  };

  if (mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = finalize;
    mediaRecorder.stop();
  } else {
    finalize();
  }
}

function showRecordingUI() {
  document.getElementById('msg-input-wrap').style.display = 'none';
  document.getElementById('voice-preview').classList.remove('show');
  document.getElementById('recording-ui').classList.add('show');
  document.getElementById('mic-btn').classList.add('recording');
  document.getElementById('send-btn').style.display = 'none';
}

function hideRecordingUI() {
  document.getElementById('recording-ui').classList.remove('show');
  document.getElementById('recording-time').textContent = '0:00';
  document.getElementById('mic-btn').classList.remove('recording');
}

function showVoicePreview() {
  document.getElementById('voice-preview').classList.add('show');
  document.getElementById('voice-preview-time').textContent = formatDuration(recordedDuration);
  document.getElementById('voice-preview-fill').style.width = '0%';
  document.getElementById('mic-btn').style.display = 'none';
  document.getElementById('send-btn').style.display = 'flex';
  document.getElementById('send-btn').disabled = false;
}

function hideVoicePreview() {
  document.getElementById('voice-preview').classList.remove('show');
  document.getElementById('msg-input-wrap').style.display = 'flex';
  recordedBlob = null;
  recordedDuration = 0;
  if (voicePreviewAudio) { voicePreviewAudio.pause(); voicePreviewAudio = null; }
  resetMicButton();
  document.getElementById('send-btn').disabled = !document.getElementById('msg-input').value.trim();
}

function resetMicButton() {
  document.getElementById('msg-input-wrap').style.display = 'flex';
  document.getElementById('mic-btn').style.display = document.getElementById('msg-input').value.trim() ? 'none' : 'flex';
  document.getElementById('send-btn').style.display = document.getElementById('msg-input').value.trim() ? 'flex' : 'none';
}

function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function blobToBase64(blob) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function sendVoiceMessage() {
  if (!recordedBlob || !activeCode) return;
  const base64 = await blobToBase64(recordedBlob);
  const sizeKB = Math.round((base64.length * 3/4) / 1024);
  const msgId = generateMsgId();
  const msg = { msgId, text: base64, time: Date.now(), sent: true, read: true, type: 'voice', duration: recordedDuration };

  if (activeType === 'group') {
    await sendGroupMessage(base64, 'voice', { msgId, duration: recordedDuration });
  } else {
    addMessageToChat(activeCode, msg);
    await pushToSupabase(activeCode, base64, 'voice', { msgId, duration: recordedDuration });
  }
  trackMessageSent('voice');

  hideVoicePreview();
  toast(`Voice sent · ${sizeKB}KB`);
}


// ─── BLINK CAMERA / SNAP ENGINE ─────────────────────────────────────────────────

let replyLockedRecipient = null; // when set, sending a snap skips the picker and goes straight to this contact

async function openBlinkCamera() {
  replyLockedRecipient = null;
  document.getElementById('blink-camera-reply-label').style.display = 'none';
  document.getElementById('blink-camera-overlay').classList.add('open');
  await startCameraStream();
}

async function openBlinkCameraForReply(contactCode) {
  replyLockedRecipient = contactCode;
  const contact = contacts.find(c => c.code === contactCode);
  const label = document.getElementById('blink-camera-reply-label');
  label.textContent = `Replying to ${contact?.name || contactCode}`;
  label.style.display = 'block';
  document.getElementById('blink-camera-overlay').classList.add('open');
  await startCameraStream(usingFrontCamera ? 'user' : 'environment');
}

async function startCameraStream(facingMode = 'user') {
  stopCameraStream();
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false
    });
    const video = document.getElementById('blink-camera-video');
    video.srcObject = cameraStream;
    video.classList.toggle('back-camera', facingMode === 'environment');
  } catch(e) {
    toast('Camera access denied or unavailable');
    closeBlinkCamera();
  }
}

function stopCameraStream() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
}

function closeBlinkCamera() {
  stopCameraStream();
  document.getElementById('blink-camera-overlay').classList.remove('open');
  document.getElementById('blink-camera-video').style.display = 'block';
  document.getElementById('blink-camera-preview').style.display = 'none';
  document.getElementById('blink-camera-bottom').style.display = 'flex';
  document.getElementById('blink-camera-preview-bottom').classList.remove('show');
  document.getElementById('blink-camera-reply-label').style.display = 'none';
  capturedSnapData = null;
  replyLockedRecipient = null;
}

async function flipCamera() {
  usingFrontCamera = !usingFrontCamera;
  await startCameraStream(usingFrontCamera ? 'user' : 'environment');
}

function captureSnapPhoto() {
  const video = document.getElementById('blink-camera-video');
  const canvas = document.getElementById('blink-camera-canvas');
  const srcW = video.videoWidth, srcH = video.videoHeight;

  // Always output a vertical 9:16 photo, regardless of whether the camera's
  // native feed is landscape (laptops/webcams) or portrait (phones).
  const targetRatio = 9 / 16; // width / height
  let cropW, cropH;
  if (srcW / srcH > targetRatio) {
    // Source is wider than target — crop the sides
    cropH = srcH;
    cropW = srcH * targetRatio;
  } else {
    // Source is taller/narrower than target — crop top/bottom
    cropW = srcW;
    cropH = srcW / targetRatio;
  }
  const cropX = (srcW - cropW) / 2;
  const cropY = (srcH - cropH) / 2;

  // Render at a fixed portrait resolution for consistent output size
  const outW = 1080, outH = 1920;
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');

  if (usingFrontCamera) {
    // Mirror to match what the user sees in the preview
    ctx.translate(outW, 0); ctx.scale(-1, 1);
  }
  ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, outW, outH);

  canvas.toBlob(async blob => {
    if (!blob) { toast('Capture failed'); return; }
    const file = new File([blob], 'snap.jpg', { type: 'image/jpeg' });
    try {
      capturedSnapData = await compressImage(file, MAX_SNAP_BYTES, 1080, 0.85);
      showSnapPreview(capturedSnapData);
    } catch(e) { toast('Failed to process photo'); }
  }, 'image/jpeg', 0.92);
}

function showSnapPreview(dataUrl) {
  stopCameraStream();
  const video = document.getElementById('blink-camera-video');
  const preview = document.getElementById('blink-camera-preview');
  video.style.display = 'none';
  preview.src = dataUrl;
  preview.style.display = 'block';
  document.getElementById('blink-camera-bottom').style.display = 'none';
  document.getElementById('blink-camera-preview-bottom').classList.add('show');
}

async function retakeSnap() {
  capturedSnapData = null;
  document.getElementById('blink-camera-preview').style.display = 'none';
  document.getElementById('blink-camera-video').style.display = 'block';
  document.getElementById('blink-camera-bottom').style.display = 'flex';
  document.getElementById('blink-camera-preview-bottom').classList.remove('show');
  await startCameraStream(usingFrontCamera ? 'user' : 'environment');
}

function openSnapSendToPicker() {
  if (!capturedSnapData) return;

  // Replying to a specific snap — skip the picker entirely, send straight back.
  if (replyLockedRecipient) {
    sendSnapToRecipients([replyLockedRecipient]);
    return;
  }

  snapSelectedRecipients.clear();
  const list = document.getElementById('snap-sendto-list');
  list.innerHTML = '';
  if (!contacts.length) {
    list.innerHTML = '<div style="color:#8e8e93;font-size:13px;padding:8px 0">Add contacts first</div>';
  } else {
    contacts.forEach(c => {
      const streak = streaks[c.code];
      const row = document.createElement('div');
      row.className = 'snap-recipient-row';
      row.innerHTML = `
        <div class="snap-recipient-checkbox"></div>
        <div class="avatar ${getAvatar(c.code) ? 'avatar-img' : avatarColor(c.code)}" style="width:32px;height:32px;font-size:13px">${getAvatar(c.code) ? `<img src="${getAvatar(c.code)}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">` : avatarLetter(c.name)}</div>
        <div class="snap-recipient-name">${escHtml(c.name)}</div>
        ${streak && streak.count > 0 ? `<div class="snap-streak">🔥${streak.count}</div>` : ''}
      `;
      row.addEventListener('click', () => {
        if (snapSelectedRecipients.has(c.code)) snapSelectedRecipients.delete(c.code);
        else snapSelectedRecipients.add(c.code);
        row.classList.toggle('selected');
        row.querySelector('.snap-recipient-checkbox').classList.toggle('checked');
        document.getElementById('snap-sendto-confirm').disabled = snapSelectedRecipients.size === 0;
      });
      list.appendChild(row);
    });
  }
  document.getElementById('snap-sendto-confirm').disabled = true;
  document.getElementById('snap-sendto-modal').classList.add('open');
}

async function sendSnapToSelected() {
  if (!capturedSnapData || !snapSelectedRecipients.size) return;
  await sendSnapToRecipients([...snapSelectedRecipients]);
}

async function sendSnapToRecipients(recipients) {
  if (!capturedSnapData || !recipients.length) return;
  const btn = document.getElementById('snap-sendto-confirm');
  const wasPickerOpen = document.getElementById('snap-sendto-modal').classList.contains('open');
  if (wasPickerOpen) { btn.disabled = true; btn.textContent = 'Sending...'; }
  else { toast('Sending Blink...'); }

  for (const code of recipients) {
    const snapId = 'snap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const msgId = generateMsgId();
    const msg = { msgId, snapId, text: capturedSnapData, time: Date.now(), sent: true, read: true, type: 'snap', opened: false, viewedByRecipient: false };
    addMessageToChat(code, msg);
    await pushToSupabase(code, capturedSnapData, 'snap', { msgId, snapId });
    recordSnapSentFor(code);
  }
  trackMessageSent('snap');

  if (wasPickerOpen) {
    btn.disabled = false; btn.textContent = 'Send';
    document.getElementById('snap-sendto-modal').classList.remove('open');
  }
  replyLockedRecipient = null;
  closeBlinkCamera();
  toast(`Sent to ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}`);
}

// ─── STREAKS ──────────────────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().slice(0, 10); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }

function recordSnapSentFor(code) {
  if (!streaks[code]) streaks[code] = { count: 0, lastSentDate: null, lastReceivedDate: null };
  streaks[code].lastSentDate = todayStr();
  evaluateStreak(code);
  saveStreaks();
}

function recordSnapReceivedFrom(code) {
  if (!streaks[code]) streaks[code] = { count: 0, lastSentDate: null, lastReceivedDate: null };
  streaks[code].lastReceivedDate = todayStr();
  evaluateStreak(code);
  saveStreaks();
}

// A streak day completes once BOTH sides have sent a snap on the same day.
// If a full day passes without both sides snapping, the streak resets.
function evaluateStreak(code) {
  const s = streaks[code];
  if (!s) return;
  const today = todayStr();
  const yesterday = yesterdayStr();

  const bothToday = s.lastSentDate === today && s.lastReceivedDate === today;
  if (bothToday && s.lastCountedDate !== today) {
    // Only increment once per day, and only if the streak wasn't already broken
    const wasActiveYesterday = s.lastCountedDate === yesterday;
    s.count = (wasActiveYesterday || s.count === 0) ? (s.count + 1 || 1) : 1;
    s.lastCountedDate = today;
  } else if (s.lastCountedDate && s.lastCountedDate !== today && s.lastCountedDate !== yesterday) {
    // More than a day has passed since the streak last advanced — broken
    s.count = 0;
    s.lastCountedDate = null;
  }
}

function openSnapViewerByMessage(chatCode, msg) {
  if (!msg || msg.type !== 'snap' || msg.opened) return;

  document.getElementById('snap-viewer-img').src = msg.text;
  document.getElementById('snap-viewer').classList.add('open');

  const fill = document.getElementById('snap-viewer-progress-fill');
  fill.style.transition = 'none';
  fill.style.width = '0%';
  requestAnimationFrame(() => {
    fill.style.transition = `width ${SNAP_VIEW_SECONDS}s linear`;
    fill.style.width = '100%';
  });

  // Notify sender that this specific snap was opened (only for received snaps)
  if (!msg.sent) {
    pushToSupabase(chatCode, '', 'snap_opened', { snapId: msg.snapId });
  }

  let closed = false;
  const closeAndWipe = () => {
    if (closed) return;
    closed = true;
    document.getElementById('snap-viewer').classList.remove('open');
    document.getElementById('snap-viewer-img').src = '';
    // Genuinely delete the image data — replace with a permanent placeholder
    msg.text = '';
    msg.opened = true;
    saveChats();
    if (activeCode === chatCode) renderMessages(chatCode, activeType);
  };

  clearTimeout(window._snapViewTimer);
  window._snapViewTimer = setTimeout(closeAndWipe, SNAP_VIEW_SECONDS * 1000);

  document.getElementById('snap-viewer-tap-area').onclick = () => {
    clearTimeout(window._snapViewTimer);
    closeAndWipe();
  };

  // Reply — closes the snap immediately and opens the Blink camera with this
  // contact pre-selected as the only recipient, so the user can fire back a
  // snap reply in one motion and keep the streak going.
  document.getElementById('snap-viewer-reply-btn').onclick = e => {
    e.stopPropagation();
    clearTimeout(window._snapViewTimer);
    closeAndWipe();
    openBlinkCameraForReply(chatCode);
  };
}

// ─── STORIES ──────────────────────────────────────────────────────────────────
function cleanExpiredStories() {
  const expiry = Date.now() - STORY_EXPIRY_MS;
  let changed = false;
  Object.keys(stories).forEach(u => {
    if (stories[u] && stories[u].time < expiry) { delete stories[u]; changed = true; }
  });
  if (myStory && myStory.time < expiry) { myStory = null; ls('myStory', ''); }
  if (changed) saveStories();
}

function renderStoriesBar() {
  const myAv = document.getElementById('my-story-avatar');
  if (!myAv) return;
  renderAvatarEl(myAv, myUsername, myUsername, 50);
  const myRing = document.querySelector('#my-story-circle .story-ring');
  const myBadge = document.querySelector('#my-story-circle .story-add-badge');
  if (myStory) { myRing.classList.remove('no-story'); myBadge.style.display = 'none'; }
  else { myRing.classList.add('no-story'); myBadge.style.display = 'flex'; }

  const list = document.getElementById('stories-list');
  list.innerHTML = '';
  const activeStories = contacts.map(c => ({ contact: c, story: stories[c.code] })).filter(s => s.story);

  activeStories.forEach(({ contact, story }) => {
    const viewed = story.viewedByMe;
    const div = document.createElement('div');
    div.className = 'story-circle';
    div.innerHTML = `
      <div class="story-ring ${viewed ? 'viewed' : ''}">
        <div class="story-avatar-wrap">${getAvatar(contact.code) ? `<img src="${getAvatar(contact.code)}">` : `<div class="avatar ${avatarColor(contact.code)}" style="width:100%;height:100%;font-size:18px;">${avatarLetter(contact.name)}</div>`}</div>
      </div>
      <span class="story-label">${escHtml(contact.name)}</span>`;
    div.addEventListener('click', () => openStoryViewer(contact.code));
    list.appendChild(div);
  });
}

async function postStory(file) {
  try {
    const base64 = await compressImage(file, MAX_STORY_BYTES, 1080, 0.75);
    myStory = { url: base64, time: Date.now(), viewers: [] };
    saveMyStory();
    renderStoriesBar();
    contacts.forEach(c => pushToSupabase(c.code, base64, 'story'));
    toast('Story posted');
  } catch(e) { toast('Failed to post story'); }
}

function removeMyStory() {
  myStory = null;
  ls('myStory', '');
  renderStoriesBar();
  contacts.forEach(c => pushToSupabase(c.code, '', 'story_delete'));
  toast('Story removed');
}

function openStoryViewer(username) {
  const isMine = username === myUsername;
  const story = isMine ? myStory : stories[username];
  if (!story) return;

  const viewer = document.getElementById('story-viewer');
  const contact = contacts.find(c => c.code === username);
  const name = isMine ? 'Your Story' : (contact?.name || username);

  const av = document.getElementById('story-viewer-avatar');
  renderAvatarEl(av, username, name, 34);
  document.getElementById('story-viewer-name').textContent = name;
  document.getElementById('story-viewer-time').textContent = formatTime(story.time);
  document.getElementById('story-viewer-img').src = story.url;
  viewer.classList.add('open');

  if (!isMine) {
    story.viewedByMe = true;
    saveStories();
    renderStoriesBar();
    pushToSupabase(username, myUsername, 'story_view');
  }

  const viewersList = document.getElementById('story-viewers-list');
  const deleteBtn = document.getElementById('story-viewer-delete');
  if (isMine) {
    deleteBtn.style.display = 'flex';
    if (story.viewers?.length) {
      viewersList.textContent = '👁 Viewed by ' + story.viewers.join(', ');
      viewersList.style.display = 'block';
    } else { viewersList.style.display = 'none'; }
  } else {
    deleteBtn.style.display = 'none';
    viewersList.style.display = 'none';
  }

  const fill = document.getElementById('story-progress-fill');
  fill.style.transition = 'none';
  fill.style.width = '0%';
  requestAnimationFrame(() => { fill.style.transition = 'width 5s linear'; fill.style.width = '100%'; });
  clearTimeout(storyTimer);
  storyTimer = setTimeout(closeStoryViewer, 5000);
}

function closeStoryViewer() {
  clearTimeout(storyTimer);
  document.getElementById('story-viewer').classList.remove('open');
  document.getElementById('story-viewer-img').src = '';
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

function showNotification(senderName, text, chatCode, chatType) {
  if (!notificationsOn) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.hasFocus() && chatCode === activeCode) return;
  let preview = text;
  if (text?.startsWith('data:audio')) preview = '🎤 Voice message';
  else if (text?.startsWith('data:')) preview = '🖼 Image';
  else if (text?.startsWith('{') && text?.includes('"data":"data:')) preview = '📎 File';
  else if (text?.length > 60) preview = text.slice(0, 60) + '…';
  const n = new Notification(`Blink — ${senderName}`, {
    body: preview || 'New message',
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%232563eb"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    silent: false
  });
  n.onclick = () => { window.focus(); if (chatType==='group') openGroup(chatCode); else openChat(chatCode); n.close(); };
  setTimeout(() => n.close(), 5000);
}

function updateNotificationToggleUI() {
  const toggle = document.getElementById('notif-toggle');
  if (!toggle) return;
  const supported = 'Notification' in window;
  const denied    = Notification.permission === 'denied';
  toggle.checked  = notificationsOn && supported && !denied;
  toggle.disabled = !supported || denied;
  const hint = document.getElementById('notif-hint');
  if (hint) {
    if (!supported) hint.textContent = 'Not supported in this browser';
    else if (denied) hint.textContent = 'Blocked by browser — check site settings';
    else hint.textContent = notificationsOn ? 'On' : 'Off';
  }
}

// ─── SYNC ENGINE ────────────────────────────────────────────────────────────────
// Lightweight chat-fingerprint based sync. Each chat is represented by a short
// hash of its last message older than 24h. Devices compare fingerprints first;
// only mismatched chats trigger an actual message exchange.

async function hashString(str) {
  try {
    const enc = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    const arr = Array.from(new Uint8Array(buf));
    return arr.map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 12);
  } catch(e) {
    // Fallback simple hash if crypto.subtle unavailable
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
    return Math.abs(h).toString(16).padStart(12, '0');
  }
}

async function getChatFingerprint(chatId) {
  const msgs = chats[chatId] || [];
  const cutoff = Date.now() - 24*60*60*1000;
  const eligible = msgs.filter(m => m.time < cutoff && m.type !== 'system' && m.text !== '__read__' && m.text !== '');
  if (!eligible.length) return null;
  const last = eligible[eligible.length - 1];
  const raw = `${last.time}|${last.sent ? myUsername : (last.senderCode||chatId)}|${(last.text||'').slice(0,200)}`;
  return await hashString(raw);
}

async function buildSyncManifest() {
  const chatIds = Object.keys(chats);
  const chatFingerprints = {};
  for (const id of chatIds) {
    const fp = await getChatFingerprint(id);
    if (fp) chatFingerprints[id] = { fp, count: (chats[id]||[]).length };
  }
  const contactManifest = contacts.map(c => ({ code: c.code, name: c.name, lastModified: c.lastModified || 0 }));
  const stickerIds = customStickers.map(s => s.id);
  // Lightweight avatar fingerprint: just a hash of the data URL so we can tell
  // if the other device has a different (or missing) picture without sending
  // the actual image in the manifest.
  const myAvatarHash = myAvatar ? await hashString(myAvatar) : null;
  const contactAvatarHashes = {};
  for (const code of Object.keys(avatars)) {
    if (avatars[code]) contactAvatarHashes[code] = await hashString(avatars[code]);
  }
  return {
    chatFingerprints, contacts: contactManifest, stickerIds, deviceId: myDeviceId,
    myAvatarHash, contactAvatarHashes
  };
}

async function requestSync(manual = false) {
  const others = await getMyOtherDevices();
  if (!others.length) {
    if (manual) toast('No other devices found for this account');
    return;
  }
  const manifest = await buildSyncManifest();
  const payload = JSON.stringify(manifest);
  for (const dev of others) {
    await pushToSupabase(myUsername, payload, 'sync_request', { targetDeviceId: dev.device_id });
  }
  if (manual) toast(`Sync requested from ${others.length} device${others.length>1?'s':''}`);
}

// Instantly push a single contact change to other devices, instead of waiting
// for a full manual/auto sync. Used right after adding, renaming, or removing
// a contact so other devices reflect it without needing the Sync button.
async function pushContactUpdateToDevices(contact, removed = false) {
  const others = await getMyOtherDevices();
  if (!others.length) return;
  const payload = JSON.stringify({ contact, removed });
  for (const dev of others) {
    await pushToSupabase(myUsername, payload, 'contact_sync', { targetDeviceId: dev.device_id });
  }
}

async function maybeAutoSync() {
  const lastOpen = parseInt(ls('lastAppOpen') || '0', 10);
  ls('lastAppOpen', String(Date.now()));
  const TWO_DAYS = 2*24*60*60*1000;
  if (lastOpen && (Date.now() - lastOpen) > TWO_DAYS) {
    requestSync(false);
  }
}

// Called when this device receives someone else's sync_request manifest
async function handleSyncRequest(remoteManifest, fromDeviceId) {
  const myManifest = await buildSyncManifest();
  const response = { fromDeviceId: myDeviceId, chats: {}, contactsToSend: [], contactsNeeded: [], stickersToSend: [], avatarsToSend: {} };

  // Compare chats
  const allChatIds = new Set([...Object.keys(myManifest.chatFingerprints), ...Object.keys(remoteManifest.chatFingerprints)]);
  for (const chatId of allChatIds) {
    const mine = myManifest.chatFingerprints[chatId];
    const theirs = remoteManifest.chatFingerprints[chatId];
    if (!theirs || (mine && mine.fp !== theirs.fp)) {
      // They're missing this chat or it differs — send my full chat content
      response.chats[chatId] = chats[chatId] || [];
    }
    if (mine && theirs && mine.fp === theirs.fp) continue; // in sync, skip
  }

  // Compare contacts — send mine if newer, note which of theirs I might be missing
  const myContactMap = Object.fromEntries(myManifest.contacts.map(c => [c.code, c]));
  const theirContactMap = Object.fromEntries((remoteManifest.contacts||[]).map(c => [c.code, c]));
  for (const c of myManifest.contacts) {
    const theirVersion = theirContactMap[c.code];
    if (!theirVersion || (c.lastModified||0) > (theirVersion.lastModified||0)) {
      response.contactsToSend.push(contacts.find(x => x.code === c.code));
    }
  }
  for (const code of Object.keys(theirContactMap)) {
    if (!myContactMap[code]) response.contactsNeeded.push(code);
  }

  // Stickers — send any custom sticker they don't have
  const theirStickerIds = new Set(remoteManifest.stickerIds || []);
  response.stickersToSend = customStickers.filter(s => !theirStickerIds.has(s.id));

  // Avatars — my own profile picture: send it if they don't have the same hash
  if (myAvatar && myManifest.myAvatarHash !== remoteManifest.myAvatarHash) {
    response.avatarsToSend[myUsername] = myAvatar;
  }
  // Avatars I have stored for contacts: send any where my hash differs from theirs
  const theirContactAvatarHashes = remoteManifest.contactAvatarHashes || {};
  for (const code of Object.keys(avatars)) {
    if (!avatars[code]) continue;
    const myHash = myManifest.contactAvatarHashes[code];
    if (myHash && myHash !== theirContactAvatarHashes[code]) {
      response.avatarsToSend[code] = avatars[code];
    }
  }

  await pushToSupabase(myUsername, JSON.stringify(response), 'sync_response', { targetDeviceId: fromDeviceId });
}

// Called when this device receives a sync_response with actual data to merge
function applySyncResponse(response) {
  let changed = false;

  // Merge chats — union + dedupe by (time + sender + text)
  Object.entries(response.chats || {}).forEach(([chatId, remoteMsgs]) => {
    if (!chats[chatId]) chats[chatId] = [];
    const existingKeys = new Set(chats[chatId].map(m => `${m.time}|${m.text}|${m.sent}`));
    remoteMsgs.forEach(rm => {
      const key = `${rm.time}|${rm.text}|${!rm.sent}`; // flip sent/received perspective
      const mirrored = { ...rm, sent: !rm.sent }; // what they sent, I received (or vice versa)
      const directKey = `${rm.time}|${rm.text}|${rm.sent}`;
      if (!existingKeys.has(directKey) && !existingKeys.has(key)) {
        chats[chatId].push(rm);
        existingKeys.add(directKey);
        changed = true;
      }
    });
    chats[chatId].sort((a,b) => a.time - b.time);
  });

  // Merge contacts
  (response.contactsToSend || []).forEach(rc => {
    if (!rc) return;
    const existing = contacts.find(c => c.code === rc.code);
    if (!existing) { contacts.push(rc); changed = true; }
    else if ((rc.lastModified||0) > (existing.lastModified||0)) {
      Object.assign(existing, rc); changed = true;
    }
  });

  // Merge stickers
  (response.stickersToSend || []).forEach(s => {
    if (!customStickers.find(cs => cs.id === s.id)) { customStickers.push(s); changed = true; }
  });

  // Merge avatars — for my own username, update myAvatar; for everyone else,
  // store it in the avatars map keyed by their username.
  Object.entries(response.avatarsToSend || {}).forEach(([code, avatarData]) => {
    if (code === myUsername) {
      if (avatarData !== myAvatar) { myAvatar = avatarData; ls('myAvatar', myAvatar); updateMyAvatarUI(); changed = true; }
    } else {
      if (avatars[code] !== avatarData) { avatars[code] = avatarData; changed = true; }
    }
  });

  if (changed) {
    saveChats(); saveContacts(); saveCustomStickers(); saveAvatars();
    renderContacts(document.getElementById('search')?.value || '');
    if (activeCode && chats[activeCode]) renderMessages(activeCode, activeType);
    toast('Synced with your other device');
  }
}


function showChat() {
  if (!isMobile()) return;
  document.getElementById('sidebar').classList.add('hidden-mobile');
  document.getElementById('chat-area').classList.add('visible-mobile');
}
function showSidebar() {
  if (!isMobile()) return;
  document.getElementById('sidebar').classList.remove('hidden-mobile');
  document.getElementById('chat-area').classList.remove('visible-mobile');
  activeCode = null;
  document.getElementById('empty-state').style.display = 'flex';
  document.getElementById('chat-main').style.display = 'none';
}

// ─── CONTACTS + GROUPS RENDER ─────────────────────────────────────────────────
function renderContacts(filter = '') {
  renderStoriesBar();
  const list = document.getElementById('contacts-list');
  list.innerHTML = '';
  const items = [];
  contacts.filter(c => c.name.toLowerCase().includes(filter.toLowerCase())).forEach(c => {
    const msgs = chats[c.code] || [];
    const last = msgs[msgs.length - 1];
    items.push({ type: 'dm', data: c, last, unread: msgs.filter(m => !m.sent && !m.read).length });
  });
  groups.filter(g => g.name.toLowerCase().includes(filter.toLowerCase())).forEach(g => {
    const msgs = chats[g.id] || [];
    const last = msgs[msgs.length - 1];
    items.push({ type: 'group', data: g, last, unread: msgs.filter(m => !m.sent && !m.read).length });
  });
  items.sort((a, b) => (b.last?.time || 0) - (a.last?.time || 0));
  if (!items.length) {
    list.innerHTML = `<div style="text-align:center;color:#8e8e93;font-size:14px;padding:24px 16px;">No contacts yet</div>`;
    return;
  }
  items.forEach(({ type, data, last, unread }) => {
    const id = type === 'dm' ? data.code : data.id;
    const isActive   = id === activeCode && !editMode;
    const isSelected = selectedContacts.has(id);
    let preview = 'No messages yet';
    if (last) {
      if (last.type === 'system') preview = last.text;
      else if (last.type === 'sticker') preview = '🎭 Sticker';
      else if (last.type === 'image')   preview = '🖼 Image';
      else if (last.type === 'voice')   preview = '🎤 Voice message';
      else if (last.type === 'file')    preview = '📎 File';
      else if (last.type === 'snap')    preview = last.opened ? '📸 Opened' : (last.sent ? '📸 Blink sent' : '📸 New Blink!');
      else if (last.type === 'group_invite') preview = '👥 Group invite';
      else preview = (last.sent ? 'You: ' : (last.senderName ? last.senderName + ': ' : '')) + last.text;
    }
    const streakInfo = type === 'dm' ? streaks[data.code] : null;
    const streakHtml = (streakInfo && streakInfo.count > 0) ? `<div class="contact-streak">🔥 ${streakInfo.count}</div>` : '';
    const div = document.createElement('div');
    div.className = 'contact-item' + (isActive ? ' active' : '') + (isSelected ? ' selected' : '');
    const avatarHtml = type === 'group'
      ? `<div class="avatar group-avatar">${groupAvatarSVG(avatarColor(data.id))}</div>`
      : `<div class="avatar ${getAvatar(data.code) ? 'avatar-img' : avatarColor(data.code)}">${getAvatar(data.code) ? `<img src="${getAvatar(data.code)}" style="width:44px;height:44px;border-radius:50%;object-fit:cover;display:block;">` : avatarLetter(data.name)}</div>`;
    if (editMode) {
      div.innerHTML = `<div class="select-circle ${isSelected?'checked':''}"></div>${avatarHtml}<div class="contact-info"><div class="contact-name">${escHtml(data.name)}</div><div class="contact-preview">${escHtml(preview)}</div></div>`;
      div.addEventListener('click', () => toggleSelectContact(id));
    } else {
      div.innerHTML = `${avatarHtml}<div class="contact-info"><div class="contact-name">${escHtml(data.name)}</div><div class="contact-preview">${escHtml(preview)}</div></div><div class="contact-meta">${last?`<div class="contact-time">${formatTime(last.time)}</div>`:''}${streakHtml} ${unread>0?`<div class="unread-badge">${unread}</div>`:''}</div>`;
      div.addEventListener('click', () => type === 'group' ? openGroup(data.id) : openChat(data.code));
    }
    list.appendChild(div);
  });
}

// ─── EDIT MODE ────────────────────────────────────────────────────────────────
function toggleEditMode() {
  editMode = !editMode;
  selectedContacts.clear();
  document.getElementById('edit-btn').classList.toggle('active', editMode);
  document.getElementById('edit-action-bar').classList.toggle('open', editMode);
  document.getElementById('my-code-bar').style.display = editMode ? 'none' : '';
  renderContacts(document.getElementById('search').value);
  updateEditActions();
}
function toggleSelectContact(id) {
  if (selectedContacts.has(id)) selectedContacts.delete(id);
  else selectedContacts.add(id);
  renderContacts(document.getElementById('search').value);
  updateEditActions();
}
function updateEditActions() {
  const n = selectedContacts.size;
  const singleDM = n === 1 && contacts.find(c => c.code === [...selectedContacts][0]);
  document.getElementById('edit-mark-read').disabled = n === 0;
  document.getElementById('edit-rename').disabled    = !singleDM;
  document.getElementById('edit-delete').disabled    = n === 0;
}

// ─── OPEN DM ──────────────────────────────────────────────────────────────────
function openChat(code) {
  activeCode = code; activeType = 'dm';
  const contact = contacts.find(c => c.code === code);
  if (!contact) return;
  if (chats[code]) { chats[code].forEach(m => { if (!m.sent) m.read = true; }); saveChats(); }
  const av = document.getElementById('chat-avatar');
  av.className = 'avatar ' + avatarColor(code);
  av.innerHTML = avatarLetter(contact.name);
  renderAvatarEl(av, code, contact.name, 44);
  document.getElementById('chat-header-name').textContent = contact.name;
  document.getElementById('chat-header-code').textContent = '@' + code;
  document.getElementById('chat-header-sub').style.display = 'none';
  document.getElementById('empty-state').style.display = 'none';
  const cm = document.getElementById('chat-main');
  cm.style.display = 'flex'; cm.style.flex = '1';
  cm.style.flexDirection = 'column'; cm.style.overflow = 'hidden';
  ls('lastChat', code); ls('lastType', 'dm');
  renderMessages(code, 'dm');
  renderContacts(document.getElementById('search').value);
  showChat();

  if (contacts.find(c => c.code === code)) {
    pushToSupabase(code, '__read__', 'read_receipt');
  }
}

// ─── OPEN GROUP ───────────────────────────────────────────────────────────────
function openGroup(groupId) {
  activeCode = groupId; activeType = 'group';
  const group = groups.find(g => g.id === groupId);
  if (!group) return;
  if (chats[groupId]) { chats[groupId].forEach(m => { if (!m.sent) m.read = true; }); saveChats(); }
  const av = document.getElementById('chat-avatar');
  av.className = 'avatar group-avatar';
  av.innerHTML = groupAvatarSVG(avatarColor(groupId));
  document.getElementById('chat-header-name').textContent = group.name;
  document.getElementById('chat-header-code').textContent = group.id;
  const sub = document.getElementById('chat-header-sub');
  sub.style.display = 'block';
  sub.textContent = group.members.map(m => m.name).join(', ');
  document.getElementById('empty-state').style.display = 'none';
  const cm = document.getElementById('chat-main');
  cm.style.display = 'flex'; cm.style.flex = '1';
  cm.style.flexDirection = 'column'; cm.style.overflow = 'hidden';
  ls('lastChat', groupId); ls('lastType', 'group');
  renderMessages(groupId, 'group');
  renderContacts(document.getElementById('search').value);
  showChat();
}

// ─── RENDER MESSAGES ──────────────────────────────────────────────────────────
function renderMessages(code, type = 'dm') {
  const wrap = document.getElementById('messages-wrap');
  wrap.innerHTML = '';
  const msgs = (chats[code] || []).filter(m => m.text !== '__read__' && (m.text !== '' || m.type === 'snap'));
  let lastDate = null;
  msgs.forEach((m, msgIdx) => {
    const d = new Date(m.time);
    if (d.toDateString() !== lastDate) {
      const sep = document.createElement('div');
      sep.className = 'msg-time';
      sep.textContent = formatDateLabel(d);
      wrap.appendChild(sep);
      lastDate = d.toDateString();
    }
    if (m.type === 'system') {
      const sys = document.createElement('div');
      sys.className = 'system-msg';
      sys.textContent = m.text;
      wrap.appendChild(sys);
      return;
    }
    if (m.type === 'group_invite') {
      const card = document.createElement('div');
      card.className = 'invite-card';
      const alreadyJoined = groups.find(g => g.id === m.groupId);
      card.innerHTML = `<div class="invite-icon">👥</div><div class="invite-info"><div class="invite-title">${escHtml(m.groupName)}</div><div class="invite-sub">Group invite from ${escHtml(m.invitedByName)}</div></div>${alreadyJoined?`<div class="invite-joined">Joined</div>`:`<button class="invite-btn">Join</button>`}`;
      if (!alreadyJoined) card.querySelector('.invite-btn').addEventListener('click', () => joinGroup(m));
      wrap.appendChild(card);
      return;
    }
    const row   = document.createElement('div');
    row.className = 'msg-row ' + (m.sent ? 'sent' : 'received');
    const bwrap = document.createElement('div');
    bwrap.className = 'bubble-wrap';
    if (type === 'group' && !m.sent && m.senderName) {
      const nameLabel = document.createElement('div');
      nameLabel.className = 'sender-name';
      nameLabel.textContent = m.senderName;
      nameLabel.style.color = `hsl(${hashColor(m.senderCode||'')}, 65%, 55%)`;
      bwrap.appendChild(nameLabel);
    }
    if (m.replyTo) {
      const quote = document.createElement('div');
      quote.className = 'reply-quote';
      const quoteAuthor = m.replyTo.quotedSender === myUsername ? 'You' : (m.replyTo.senderName || contacts.find(c=>c.code===m.replyTo.quotedSender)?.name || m.replyTo.quotedSender || code);
      quote.innerHTML = `<div class="reply-quote-author">${escHtml(quoteAuthor)}</div><div class="reply-quote-text">${escHtml(replyPreviewText(m.replyTo))}</div>`;
      quote.addEventListener('click', () => scrollToMessage(code, m.replyTo.msgId));
      bwrap.appendChild(quote);
    }
    const bubble = document.createElement('div');
    if (m.type === 'file') {
      bubble.className = 'bubble file-bubble';
      try {
        const fileData = JSON.parse(m.text);
        const sizeKB = Math.round(fileData.size / 1024);
        bubble.innerHTML = `
          <div class="file-icon-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </div>
          <div class="file-info">
            <div class="file-name">${escHtml(fileData.name)}</div>
            <div class="file-size">${sizeKB}KB</div>
          </div>`;
        bubble.addEventListener('click', () => {
          const a = document.createElement('a');
          a.href = fileData.data;
          a.download = fileData.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
        });
      } catch(e) {
        bubble.innerHTML = '<span style="font-size:13px;opacity:0.6">📎 File unavailable</span>';
      }
    } else if (m.type === 'snap') {
      const camIconSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
      if (m.sent) {
        // For a snap I sent: show whether the recipient has viewed it yet.
        bubble.className = 'bubble snap-bubble' + (m.viewedByRecipient ? ' opened' : '');
        bubble.innerHTML = m.viewedByRecipient
          ? `${camIconSvg}<span>Opened</span>`
          : `${camIconSvg}<span>Delivered</span>`;
      } else if (m.opened) {
        // A snap I received and already viewed — image data is gone, just show the state.
        bubble.className = 'bubble snap-bubble opened';
        bubble.innerHTML = `${camIconSvg}<span>Opened</span>`;
      } else {
        bubble.className = 'bubble snap-bubble';
        bubble.innerHTML = `${camIconSvg}<span>Tap to view</span>`;
        bubble.addEventListener('click', () => openSnapViewerByMessage(code, m));
      }
    } else if (m.type === 'voice') {
      bubble.className = 'bubble voice-bubble';
      const barsHtml = Array.from({length: 24}).map((_, i) => `<span style="height:${8 + Math.random()*14}px"></span>`).join('');
      bubble.innerHTML = `
        <button class="voice-play-btn">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <div class="voice-wave-bar">${barsHtml}</div>
        <span class="voice-duration">${formatDuration(m.duration || 0)}</span>`;
      setupVoicePlayback(bubble, m.text, m.duration || 0);
    } else if (m.type === 'sticker') {
      bubble.className = 'bubble sticker-bubble';
      bubble.innerHTML = `<img src="${m.text}" alt="sticker">`;
      // Tap a received sticker to show a small menu
      if (!m.sent) {
        bubble.style.cursor = 'pointer';
        bubble.addEventListener('click', e => {
          e.stopPropagation();
          showStickerMenu(bubble, bwrap, m.text);
        });
      }
    } else if (m.type === 'image') {
      if (m.expired || !m.text) {
        bubble.className = 'bubble';
        bubble.innerHTML = '<span style="opacity:0.5;font-size:13px">🖼 Image expired</span>';
      } else {
        bubble.className = 'bubble image-bubble';
        const imgSrc = m.text;
        bubble.innerHTML = `<img src="${imgSrc}" alt="image" onerror="this.parentElement.innerHTML='🖼 Failed to load'">`;
        bubble.querySelector('img').addEventListener('click', () => openLightbox(imgSrc));
      }
    } else if (isImageUrl(m.text)) {
      bubble.className = 'bubble image-bubble';
      const imgSrc = m.text;
      bubble.innerHTML = `<img src="${imgSrc}" alt="image" onerror="this.parentElement.innerHTML='🖼 Failed to load'">`;
      bubble.querySelector('img').addEventListener('click', () => openLightbox(imgSrc));
    } else {
      bubble.className = 'bubble';
      bubble.innerHTML = escHtml(m.text);
    }
    if (m.reactions && m.reactions.length) {
      const badge = document.createElement('div');
      badge.className = 'reaction-badge';
      // Group by emoji so repeated reactions of the same emoji show as one badge with a count
      const grouped = {};
      m.reactions.forEach(r => { grouped[r.emoji] = (grouped[r.emoji] || 0) + 1; });
      badge.textContent = Object.entries(grouped).map(([emoji, count]) => count > 1 ? `${emoji}${count}` : emoji).join(' ');
      badge.title = m.reactions.map(r => `${r.from === myUsername ? 'You' : (contacts.find(c=>c.code===r.from)?.name || r.from)} reacted ${r.emoji}`).join('\n');
      badge.addEventListener('click', () => {
        // Tapping the badge only removes YOUR own reaction, not everyone's
        const hadMine = m.reactions.some(r => r.from === myUsername);
        if (!hadMine) return;
        m.reactions = m.reactions.filter(r => r.from !== myUsername);
        saveChats(); renderMessages(code, type);
        sendReactionUpdate(code, type, m, null);
      });
      bwrap.appendChild(badge);
    }
    bwrap.insertBefore(bubble, bwrap.firstChild);

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    if (m.sent) {
      meta.innerHTML = `<span class="msg-seen">${m.seen ? 'Seen' : ''}</span><span class="msg-time-label">${formatTimestamp(m.time)}</span>`;
    } else {
      meta.innerHTML = `<span class="msg-time-label">${formatTimestamp(m.time)}</span>`;
    }
    bwrap.appendChild(meta);

    row.appendChild(bwrap);
    row.dataset.msgid = m.msgId || '';
    let pressTimer;
    const startPress = () => { pressTimer = setTimeout(() => showReactionPicker(row, bwrap, m, code, type), 600); };
    const cancelPress = () => clearTimeout(pressTimer);
    bubble.addEventListener('mousedown',   startPress);
    bubble.addEventListener('mouseup',     cancelPress);
    bubble.addEventListener('mouseleave',  cancelPress);
    bubble.addEventListener('touchstart',  startPress, { passive: true });
    bubble.addEventListener('touchend',    cancelPress);
    bubble.addEventListener('touchmove',   cancelPress, { passive: true });
    bubble.addEventListener('contextmenu', e => { e.preventDefault(); clearTimeout(pressTimer); showReactionPicker(row, bwrap, m, code, type); });

    setupSwipeToReply(row, bwrap, m, code, type, cancelPress);

    wrap.appendChild(row);
  });
  wrap.scrollTop = wrap.scrollHeight;
}

// ─── SWIPE TO REPLY ───────────────────────────────────────────────────────────
// Swiping a bubble left-to-right (in either direction of conversation — your
// own messages or theirs) reveals a small reply icon and, past a threshold,
// sets that message as the active reply target for the next thing you send.
const SWIPE_REPLY_THRESHOLD = 60;

function setupSwipeToReply(row, bwrap, msg, code, type, cancelPress) {
  let startX = 0, startY = 0, currentX = 0, dragging = false, triggered = false;
  const icon = document.createElement('div');
  icon.className = 'swipe-reply-icon';
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`;
  row.appendChild(icon);

  function onStart(x, y) {
    startX = x; startY = y; currentX = 0; dragging = true; triggered = false;
    bwrap.style.transition = 'none';
  }
  function onMove(x, y) {
    if (!dragging) return;
    const dx = x - startX, dy = y - startY;
    // If the gesture is more vertical than horizontal, it's a scroll, not a swipe — bail out
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10 && Math.abs(currentX) < 10) { dragging = false; return; }
    if (dx < 0) { currentX = 0; return; } // only allow left-to-right
    currentX = Math.min(dx, 90);
    if (currentX > 8) cancelPress?.(); // real horizontal drag — don't also trigger long-press
    bwrap.style.transform = `translateX(${currentX}px)`;
    icon.style.opacity = Math.min(currentX / SWIPE_REPLY_THRESHOLD, 1);
    triggered = currentX >= SWIPE_REPLY_THRESHOLD;
  }
  function onEnd() {
    if (!dragging) return;
    dragging = false;
    bwrap.style.transition = 'transform 0.2s ease';
    bwrap.style.transform = 'translateX(0)';
    icon.style.opacity = 0;
    if (triggered) setReplyTarget(msg, code);
  }

  row.addEventListener('mousedown',  e => onStart(e.clientX, e.clientY));
  row.addEventListener('mousemove',  e => onMove(e.clientX, e.clientY));
  row.addEventListener('mouseup',    onEnd);
  row.addEventListener('mouseleave', onEnd);
  row.addEventListener('touchstart', e => { const t = e.touches[0]; onStart(t.clientX, t.clientY); }, { passive: true });
  row.addEventListener('touchmove',  e => { const t = e.touches[0]; onMove(t.clientX, t.clientY); }, { passive: true });
  row.addEventListener('touchend',   onEnd);
}

function replyPreviewText(replyTo) {
  if (replyTo.type === 'image') return '🖼 Image';
  if (replyTo.type === 'sticker') return '🎭 Sticker';
  if (replyTo.type === 'voice') return '🎤 Voice message';
  if (replyTo.type === 'file') return '📎 File';
  if (replyTo.type === 'snap') return '📸 Blink';
  return (replyTo.text || '').slice(0, 80);
}

function setReplyTarget(msg, code) {
  // Store the ABSOLUTE sender of the quoted message (a real username), not a
  // boolean relative to "me" — so this renders correctly on both my screen
  // and the recipient's screen, which have opposite ideas of who "I" am.
  const quotedSender = msg.sent ? myUsername : (msg.senderCode || code);
  replyTarget = {
    msgId: msg.msgId, quotedSender, text: msg.text, type: msg.type,
    senderName: msg.senderName, code
  };
  renderReplyPreview();
  document.getElementById('msg-input')?.focus();
}

function clearReplyTarget() {
  replyTarget = null;
  renderReplyPreview();
}

function renderReplyPreview() {
  const bar = document.getElementById('reply-preview-bar');
  if (!bar) return;
  if (!replyTarget) { bar.classList.remove('show'); bar.innerHTML = ''; return; }
  const author = replyTarget.quotedSender === myUsername ? 'You' : (replyTarget.senderName || contacts.find(c=>c.code===replyTarget.quotedSender)?.name || replyTarget.quotedSender);
  bar.innerHTML = `
    <div class="reply-preview-content">
      <div class="reply-preview-author">Replying to ${escHtml(author)}</div>
      <div class="reply-preview-text">${escHtml(replyPreviewText(replyTarget))}</div>
    </div>
    <button class="reply-preview-close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  bar.classList.add('show');
  bar.querySelector('.reply-preview-close').addEventListener('click', clearReplyTarget);
}

function scrollToMessage(code, msgId) {
  if (!msgId) return;
  const row = document.querySelector(`.msg-row[data-msgid="${msgId}"]`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('highlight-flash');
    setTimeout(() => row.classList.remove('highlight-flash'), 1000);
  }
}

function setupVoicePlayback(bubbleEl, src, duration) {
  const playBtn = bubbleEl.querySelector('.voice-play-btn');
  const waveBar = bubbleEl.querySelector('.voice-wave-bar');
  const bars = bubbleEl.querySelectorAll('.voice-wave-bar span');
  let audio = null;
  let playing = false;
  let wasPlayingBeforeScrub = false;

  function getAudio() {
    if (!audio) audio = new Audio(src);
    return audio;
  }

  function updateBarsFromPct(pct) {
    const filledCount = Math.floor(pct * bars.length);
    bars.forEach((b, i) => b.classList.toggle('played', i < filledCount));
  }

  function pctFromEvent(e) {
    const rect = waveBar.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let pct = (clientX - rect.left) / rect.width;
    return Math.min(1, Math.max(0, pct));
  }

  playBtn.addEventListener('click', () => {
    const a = getAudio();
    if (playing) {
      a.pause();
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      playing = false;
      return;
    }
    a.play().catch(() => toast('Failed to play voice message'));
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
    playing = true;

    a.ontimeupdate = () => {
      const pct = a.currentTime / (a.duration || duration || 1);
      updateBarsFromPct(pct);
    };
    a.onended = () => {
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      playing = false;
      bars.forEach(b => b.classList.remove('played'));
    };
  });

  // ─── Scrub / seek on the waveform ───────────────────────────────────────────
  let scrubbing = false;

  function startScrub(e) {
    scrubbing = true;
    wasPlayingBeforeScrub = playing;
    const a = getAudio();
    if (playing) a.pause();
    seekTo(e);
  }
  function seekTo(e) {
    const pct = pctFromEvent(e);
    updateBarsFromPct(pct);
    const a = getAudio();
    const dur = a.duration || duration || 0;
    if (dur) a.currentTime = pct * dur;
  }
  function endScrub() {
    if (!scrubbing) return;
    scrubbing = false;
    if (wasPlayingBeforeScrub) {
      const a = getAudio();
      a.play().catch(() => {});
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
      playing = true;
    }
  }

  waveBar.style.cursor = 'pointer';
  waveBar.addEventListener('mousedown', e => { startScrub(e); const mm = ev => seekTo(ev); const mu = () => { endScrub(); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); }; document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu); });
  waveBar.addEventListener('touchstart', e => { startScrub(e); }, { passive: true });
  waveBar.addEventListener('touchmove', e => { if (scrubbing) seekTo(e); }, { passive: true });
  waveBar.addEventListener('touchend', endScrub);
}

function hashColor(str) { let n=0; for(const c of str) n+=c.charCodeAt(0); return (n*47)%360; }

// ─── REACTION PICKER ──────────────────────────────────────────────────────────
function showReactionPicker(row, bwrap, msg, code, type) {
  document.querySelectorAll('.reaction-picker, .msg-action-row').forEach(p => p.remove());
  if (!msg.reactions) msg.reactions = [];
  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  const myExisting = msg.reactions.find(r => r.from === myUsername);

  const applyReaction = (emoji) => {
    msg.reactions = msg.reactions.filter(rx => rx.from !== myUsername);
    const isRemoving = myExisting?.emoji === emoji;
    if (!isRemoving) msg.reactions.push({ from: myUsername, emoji });
    saveChats(); renderMessages(code, type);
    sendReactionUpdate(code, type, msg, isRemoving ? null : emoji);
  };

  REACTIONS.forEach(r => {
    const span = document.createElement('span');
    span.textContent = r;
    if (myExisting?.emoji === r) span.classList.add('active');
    span.addEventListener('click', () => { applyReaction(r); closePickerAndActions(); });
    picker.appendChild(span);
  });

  // "+" button — lets the user pick any emoji via their device's own emoji keyboard
  const plusBtn = document.createElement('span');
  plusBtn.className = 'reaction-plus-btn';
  plusBtn.textContent = '+';
  plusBtn.addEventListener('click', () => {
    closePickerAndActions();
    showCustomEmojiInput(bwrap, code, type, msg, applyReaction);
  });
  picker.appendChild(plusBtn);

  bwrap.appendChild(picker);

  // Delete is only ever offered for messages YOU sent — you have no
  // authority to remove something someone else sent from their device, so
  // there is no "delete" option shown at all for received messages.
  let actionRow = null;
  if (msg.sent) {
    actionRow = document.createElement('div');
    actionRow.className = 'msg-action-row';
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'msg-action-btn delete';
    deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg> Delete for everyone`;
    deleteBtn.addEventListener('click', () => {
      closePickerAndActions();
      confirmDeleteMessage(code, type, msg);
    });
    actionRow.appendChild(deleteBtn);
    bwrap.appendChild(actionRow);

    // Position the action row right above the picker using its real measured
    // height, rather than a guessed fixed offset — stays correct even if the
    // picker's size changes (e.g. wraps to two lines on a narrow screen).
    requestAnimationFrame(() => {
      const pickerHeight = picker.offsetHeight;
      actionRow.style.bottom = `calc(100% + ${pickerHeight + 16}px)`;
    });
  }

  function closePickerAndActions() {
    picker.remove();
    actionRow?.remove();
  }

  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!picker.contains(e.target) && !(actionRow && actionRow.contains(e.target))) {
        closePickerAndActions();
        document.removeEventListener('click', close);
      }
    });
  }, 10);
}

// Deletes a message you sent — a real "delete for everyone." Removes it from
// your own history and notifies the other side(s) of the chat to remove
// their copy too, identified by msgId. This is only ever reachable for
// messages you sent — there is no path that lets you delete someone else's
// message from their device.
function confirmDeleteMessage(code, type, msg) {
  if (!msg.sent || !msg.msgId) return;
  if (!confirm('Delete this message for everyone?')) return;

  removeMessageFromChat(code, msg);
  sendDeleteMessageUpdate(code, type, msg.msgId);
  toast('Message deleted for everyone');
}

function removeMessageFromChat(code, msg) {
  const list = chats[code];
  if (!list) return;
  const idx = list.indexOf(msg);
  if (idx === -1) return;
  list.splice(idx, 1);
  saveChats();
  if (activeCode === code) renderMessages(code, activeType);
  renderContacts(document.getElementById('search')?.value || '');
}

// Notifies whoever else is in this chat that a message I sent should be
// removed, identified by its stable msgId — same pattern as reaction sync.
async function sendDeleteMessageUpdate(code, type, msgId) {
  const payload = JSON.stringify({ msgId });
  if (type === 'group') {
    const group = groups.find(g => g.id === code);
    if (!group) return;
    await Promise.all(group.members.filter(m => m.code !== myUsername)
      .map(member => pushToSupabase(member.code, payload, 'delete_message', { groupId: code })));
  } else {
    await pushToSupabase(code, payload, 'delete_message');
  }
}

// Small inline input where the user can type/paste any emoji using their
// device's native emoji keyboard (iOS/Android/Windows/Mac all have one built
// into the system keyboard — there's no need to ship our own emoji picker).
function showCustomEmojiInput(bwrap, code, type, msg, applyReaction) {
  document.querySelectorAll('.custom-emoji-input-wrap').forEach(p => p.remove());
  const wrap = document.createElement('div');
  wrap.className = 'custom-emoji-input-wrap';
  wrap.innerHTML = `<input type="text" class="custom-emoji-input" placeholder="😀" maxlength="8">`;
  bwrap.appendChild(wrap);
  const input = wrap.querySelector('input');
  input.focus();

  const commit = () => {
    const val = input.value.trim();
    wrap.remove();
    if (val) applyReaction(val);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });
  input.addEventListener('blur', () => setTimeout(commit, 100));
}

// Notifies whoever else is in this chat that a reaction was added/removed on
// a specific message, identified by its stable msgId. Messages sent before
// this feature existed don't have a msgId and can't sync reactions — there's
// no reliable way to match them across sender/recipient after the fact, since
// each side recorded its own local timestamp independently.
async function sendReactionUpdate(code, type, msg, reaction) {
  // Older messages from before msgId existed get one assigned retroactively
  // right here, so the reaction can always be applied and rendered locally.
  // It still won't sync correctly to someone else's independently-stored copy
  // of that same old message (they have no way to already know this ID), but
  // it at least stops behaving like reactions are blocked entirely.
  if (!msg.msgId) { msg.msgId = generateMsgId(); saveChats(); }
  const payload = JSON.stringify({ msgId: msg.msgId, reaction });
  if (type === 'group') {
    const group = groups.find(g => g.id === code);
    if (!group) return;
    await Promise.all(group.members.filter(m => m.code !== myUsername)
      .map(member => pushToSupabase(member.code, payload, 'reaction_update', { groupId: code })));
  } else {
    await pushToSupabase(code, payload, 'reaction_update');
  }
}

// ─── ADD MESSAGE ──────────────────────────────────────────────────────────────
function addMessageToChat(code, msg) {
  if (!msg.msgId) msg.msgId = 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  if (!chats[code]) chats[code] = [];
  chats[code].push(msg);
  enforceStorageLimit(code);
  saveChats();
  if (code === activeCode) renderMessages(code, activeType);
  renderContacts(document.getElementById('search').value);

  if (!msg.sent && ['text','image','sticker'].includes(msg.type)) {
    if (code === activeCode && activeType === 'dm' && document.hasFocus()) {
      if (contacts.find(c => c.code === code)) {
        pushToSupabase(code, '__read__', 'read_receipt');
      }
    }
  }

  if (!msg.sent && msg.type !== 'system' && msg.type !== 'code_change' && msg.type !== 'avatar_update' && msg.type !== 'read_receipt' && msg.type !== 'story' && msg.type !== 'story_view' && msg.type !== 'story_delete') {
    const isGroup  = groups.find(g => g.id === code);
    const contact  = contacts.find(c => c.code === code);
    const sender   = msg.senderName || contact?.name || code;
    const chatType = isGroup ? 'group' : 'dm';
    const chatName = isGroup ? isGroup.name : (contact?.name || code);
    const label    = isGroup ? `${sender} in ${chatName}` : chatName;
    const notifText = msg.type === 'snap' ? '📸 sent you a Blink' : msg.text;
    showNotification(label, notifText, code, chatType);
  }
}

function addSystemMessage(chatCode, text) {
  addMessageToChat(chatCode, { type: 'system', text, time: Date.now() });
}

// ─── SEND ─────────────────────────────────────────────────────────────────────
function generateMsgId() { return 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text  = input.value.trim();
  if (!text || !activeCode) return;
  const type = isImageUrl(text) ? 'image' : 'text';
  const msgId = generateMsgId();
  const replyTo = buildReplyToPayload();

  if (activeType === 'group') {
    await sendGroupMessage(text, type, { msgId, replyTo });
  } else {
    addMessageToChat(activeCode, { msgId, text, time: Date.now(), sent: true, read: true, type, replyTo });
    await pushToSupabase(activeCode, text, type, { msgId, replyTo: replyTo ? JSON.stringify(replyTo) : null });
  }
  trackMessageSent(type);
  input.value = ''; input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
  clearReplyTarget();
}

// Builds the small replyTo snapshot attached to the next outgoing message,
// based on whatever the user swiped to reply to.
function buildReplyToPayload() {
  if (!replyTarget) return null;
  return {
    msgId: replyTarget.msgId,
    quotedSender: replyTarget.quotedSender,
    text: replyTarget.type === 'text' ? replyTarget.text : '',
    type: replyTarget.type,
    senderName: replyTarget.senderName || null
  };
}

// ─── GROUP MESSAGING ──────────────────────────────────────────────────────────
async function sendGroupMessage(text, type = 'text', extraData = {}) {
  const group = groups.find(g => g.id === activeCode);
  if (!group) return;
  const msg = { text, time: Date.now(), sent: true, read: true, type, senderCode: myUsername, senderName: myUsername, ...extraData };
  addMessageToChat(activeCode, msg);
  // For the network payload, replyTo (if present) needs to be a string —
  // everything else in extraData is already string/number/boolean safe.
  const networkExtra = { ...extraData };
  if (networkExtra.replyTo) networkExtra.replyTo = JSON.stringify(networkExtra.replyTo);
  const promises = group.members.filter(m => m.code !== myUsername)
    .map(member => pushToSupabase(member.code, text, type, { groupId: group.id, senderCode: myUsername, senderName: myUsername, ...networkExtra }));
  await Promise.all(promises);
}

async function createGroup(name, memberCodes) {
  const groupId = 'grp_' + myUsername + '_' + Date.now();
  const members = [{ code: myUsername, name: myUsername }, ...memberCodes.map(code => ({ code, name: contacts.find(c=>c.code===code)?.name||code }))];
  const group = { id: groupId, name, members, createdBy: myUsername };
  groups.push(group); saveGroups();
  const invitePayload = JSON.stringify({ groupId, groupName: name, invitedByName: myUsername, members });
  await Promise.all(memberCodes.map(code => pushToSupabase(code, invitePayload, 'group_invite')));
  openGroup(groupId);
  toast(`Group "${name}" created`);
}

function joinGroup(invite) {
  if (groups.find(g => g.id === invite.groupId)) { toast('Already in this group'); return; }
  const group = { id: invite.groupId, name: invite.groupName, members: invite.members||[], createdBy: invite.invitedByCode||'' };
  if (!group.members.find(m => m.code === myUsername)) group.members.push({ code: myUsername, name: myUsername });
  groups.push(group); saveGroups();
  renderContacts(document.getElementById('search').value);
  openGroup(invite.groupId);
  toast(`Joined "${invite.groupName}"`);
}

// ─── ADMIN STATS TRACKING ───────────────────────────────────────────────────────
// Lightweight, fire-and-forget counters for the admin dashboard. These are
// just numbers — no message content is ever stored — so they persist safely
// even though the actual messages themselves expire within 24-48h.
const STATS_CONTENT_TYPES = ['text', 'image', 'voice', 'sticker', 'file', 'snap'];

async function incrementDailyStat(statName, amount = 1) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_daily_stat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ stat_name: statName, by_amount: amount })
    });
  } catch(e) { /* stats are best-effort, never block on failure */ }
}

// Call this once per genuine user-initiated send (not once per recipient
// address) — so sending one message to a group of 5 still counts as 1.
function trackMessageSent(type) {
  if (!STATS_CONTENT_TYPES.includes(type)) return;
  incrementDailyStat('messages_sent', 1);
  trackActiveUserToday();
  incrementUserTotal();
}

// All-time per-user message count, used for the admin leaderboard. Separate
// from daily_stats since this needs to persist indefinitely, not reset daily.
async function incrementUserTotal() {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_user_total`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ p_username: myUsername })
    });
  } catch(e) {}
}

// Increments "active users" at most once per username per calendar day,
// using a small localStorage marker to avoid over-counting repeat sends.
function trackActiveUserToday() {
  const today = todayStr();
  if (ls('lastActiveStatDate') === today) return;
  ls('lastActiveStatDate', today);
  incrementDailyStat('active_users', 1);
}

function trackNewSignup() {
  incrementDailyStat('new_signups', 1);
}

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
// Cache of recipient device lists so we don't hit the devices table on every
// keystroke-triggered send. Short-lived — a minute is plenty since device
// lists change rarely.
const deviceListCache = new Map(); // username -> { devices: [...], fetchedAt }
const DEVICE_CACHE_MS = 60 * 1000;

async function getDevicesForUsername(username) {
  const cached = deviceListCache.get(username);
  if (cached && (Date.now() - cached.fetchedAt) < DEVICE_CACHE_MS) return cached.devices;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/devices?username=eq.${encodeURIComponent(username)}&select=device_id`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('getDevicesForUsername failed:', res.status, errText);
      return [];
    }
    const rows = await res.json();
    const ids = rows.map(r => r.device_id);
    deviceListCache.set(username, { devices: ids, fetchedAt: Date.now() });
    return ids;
  } catch(e) { console.error('getDevicesForUsername exception:', e); return []; }
}

// Builds the actual address a message should be written to. If the recipient
// has one or more registered devices, the address is forked per device
// (username#deviceId) so each device has its own row and polls only its own
// address — no race condition over who reads it first. If no devices are
// registered (lookup failed, or recipient never registered any device — e.g.
// an older client), falls back to the bare username so delivery still works.
async function resolveDeliveryAddresses(username) {
  const deviceIds = await getDevicesForUsername(username);
  if (!deviceIds.length) return [username]; // fallback: bare address
  return deviceIds.map(id => `${username}#${id}`);
}

async function pushToSupabase(toCode, text, type = 'text', extra = {}) {
  try {
    const check = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?select=id&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'count=exact' } });
    const count = parseInt(check.headers.get('content-range')?.split('/')[1] || '0');
    if (count > SERVER_LIMIT) { toast('Server busy — try again shortly'); return; }

    const isDeviceControlMessage = !!extra.targetDeviceId;
    const addresses = isDeviceControlMessage ? [toCode] : await resolveDeliveryAddresses(toCode);

    // PostgREST requires every object in a bulk insert to have the exact
    // same set of keys — so every row, real or mirrored, must explicitly
    // include selfSync/originalTo (even if just as false/null), rather than
    // only adding those keys on the mirror rows.
    const rows = addresses.map(addr => ({
      from: myUsername, to: addr, text, type, created_at: new Date().toISOString(),
      selfSync: false, originalTo: null, ...extra
    }));

    // Mirror this exact send to my OTHER devices too, so opening Blink on a
    // second device sees the full conversation — not just what other people
    // sent me, but everything I sent out from anywhere. Skipped for messages
    // that are already part of the device-control channel (sync/link
    // handshakes), since those are inherently single-device by design.
    if (!isDeviceControlMessage) {
      const myOtherDevices = await getMyOtherDevices();
      myOtherDevices.forEach(dev => {
        rows.push({
          from: myUsername, to: `${myUsername}#${dev.device_id}`,
          text, type, created_at: new Date().toISOString(),
          ...extra, selfSync: true, originalTo: toCode
        });
      });
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify(rows)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[pushToSupabase] insert FAILED', res.status, errText);
      toast('Failed to send');
    }
  } catch(e) { console.error('[pushToSupabase] exception', e); toast('Failed to send — check connection'); }
}

// Raw push/poll using an explicit "from" — used during device linking,
// before this device has a myUsername of its own. Never forked — these are
// always addressed to a specific bare username or deviceId directly.
async function pushRaw(fromId, toCode, text, type, extra = {}) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ from: fromId, to: toCode, text, type, created_at: new Date().toISOString(), ...extra })
    });
  } catch(e) {}
}

async function pollRaw(forId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?to=eq.${encodeURIComponent(forId)}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    if (!res.ok) return [];
    return await res.json();
  } catch(e) { return []; }
}

async function deleteMessageIds(ids) {
  if (!ids.length) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=in.(${ids.join(',')})`, {
      method: 'DELETE', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
  } catch(e) {}
}

async function pollMessages() {
  if (!myUsername) return;
  try {
    // Poll two addresses:
    //  1. My own device-specific address (username#deviceId) — where forked
    //     DM/group/sticker/etc messages land, addressed only to me, no race with other devices.
    //  2. The bare username — where device-control messages (sync_request, link_request, etc.)
    //     and any fallback messages (sent when the sender couldn't resolve my device list) land.
    //     Every one of my devices polls this too, but control messages already carry their
    //     own targetDeviceId so only the intended device acts on them.
    const myAddress = `${myUsername}#${myDeviceId}`;
    const [ownRes, sharedRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?to=eq.${encodeURIComponent(myAddress)}&select=*`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }),
      fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?to=eq.${encodeURIComponent(myUsername)}&select=*`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } })
    ]);

    const ownRows    = ownRes.ok ? await ownRes.json() : [];
    const sharedRows = sharedRes.ok ? await sharedRes.json() : [];

    // Shared-address rows: only keep control messages meant for this device,
    // or anything with no targetDeviceId at all (true fallback delivery).
    const relevantSharedRows = sharedRows.filter(r => !r.targetDeviceId || r.targetDeviceId === myDeviceId);

    const rows = [...ownRows, ...relevantSharedRows];
    if (!rows.length) return;

    const ids = [];
    rows.forEach(r => {
      ids.push(r.id);

      // ── Self-sync: this is a message I sent from ANOTHER of my own devices ──
      // Re-route it as if it just arrived addressed to the real recipient, so
      // it gets filed under the correct chat as something I already sent —
      // no notification, no unread bump, just history catching up.
      if (r.selfSync) {
        handleSelfSyncRow(r);
        return;
      }

      if (r.type === 'story') {
        ensureContact(r.from);
        stories[r.from] = { url: r.text, time: new Date(r.created_at).getTime(), viewedByMe: false, viewers: [] };
        saveStories();
        renderStoriesBar();
        return;
      }
      if (r.type === 'story_delete') {
        delete stories[r.from];
        saveStories();
        renderStoriesBar();
        return;
      }
      if (r.type === 'story_view') {
        if (myStory) {
          const viewerName = r.text || r.from;
          if (!myStory.viewers.includes(viewerName)) myStory.viewers.push(viewerName);
          saveMyStory();
        }
        return;
      }
      if (r.type === 'read_receipt') {
        if (chats[r.from]) {
          chats[r.from].forEach(m => { m.seen = false; });
          const lastSent = [...chats[r.from]].reverse().find(m => m.sent);
          if (lastSent) lastSent.seen = true;
          saveChats();
          if (activeCode === r.from) renderMessages(r.from, activeType);
          renderContacts(document.getElementById('search').value);
        }
        return;
      }
      if (r.type === 'avatar_update') {
        try {
          const { username, avatar } = JSON.parse(r.text);
          avatars[username] = avatar; saveAvatars();
          renderContacts(document.getElementById('search').value);
          if (activeCode === username) renderAvatarEl(document.getElementById('chat-avatar'), username, contacts.find(c=>c.code===username)?.name||username, 44);
        } catch(e) {}
        return;
      }
      if (r.type === 'code_change') {
        try {
          const { oldCode, newCode, username } = JSON.parse(r.text);
          const contact = contacts.find(c => c.code === oldCode);
          if (contact) {
            if (chats[oldCode]) { chats[newCode] = chats[oldCode]; delete chats[oldCode]; }
            contact.code = newCode; contact.name = username;
            saveContacts(); saveChats();
            addSystemMessage(newCode, `${oldCode} is now @${newCode}`);
            renderContacts(document.getElementById('search').value);
            if (activeCode === oldCode) openChat(newCode);
          }
        } catch(e) {}
        return;
      }
      if (r.groupId) {
        const group = groups.find(g => g.id === r.groupId);
        if (!group) return;
        addMessageToChat(r.groupId, { msgId: r.msgId, text: r.text, time: new Date(r.created_at).getTime(), sent: false, read: r.groupId===activeCode, type: r.type||'text', senderCode: r.senderCode, senderName: r.senderName, duration: r.duration, replyTo: parseReplyTo(r.replyTo) });
        return;
      }
      if (r.type === 'group_invite') {
        ensureContact(r.from);
        try {
          const invite = JSON.parse(r.text);
          addMessageToChat(r.from, { text: r.text, time: new Date(r.created_at).getTime(), sent: false, read: r.from===activeCode, type: 'group_invite', groupId: invite.groupId, groupName: invite.groupName, invitedByName: invite.invitedByName, invitedByCode: r.from, members: invite.members });
        } catch(e) {}
        return;
      }
      // ── Contact sync: another of my devices added/renamed a contact ──
      if (r.type === 'contact_sync') {
        if (r.targetDeviceId && r.targetDeviceId !== myDeviceId) return;
        try {
          const { contact: rc, removed } = JSON.parse(r.text);
          if (removed) {
            contacts = contacts.filter(c => c.code !== rc.code);
          } else {
            const existing = contacts.find(c => c.code === rc.code);
            if (!existing) contacts.push(rc);
            else if ((rc.lastModified||0) >= (existing.lastModified||0)) Object.assign(existing, rc);
          }
          saveContacts();
          renderContacts(document.getElementById('search')?.value || '');
        } catch(e) {}
        return;
      }

      // ── Sync request: another of my devices wants to compare/exchange data ──
      if (r.type === 'sync_request') {
        if (r.targetDeviceId && r.targetDeviceId !== myDeviceId) return; // not for me
        try {
          const manifest = JSON.parse(r.text);
          if (manifest.deviceId === myDeviceId) return; // ignore my own request echo
          handleSyncRequest(manifest, manifest.deviceId);
        } catch(e) {}
        return;
      }

      // ── Sync response: another of my devices sent back data to merge ──
      if (r.type === 'sync_response') {
        if (r.targetDeviceId && r.targetDeviceId !== myDeviceId) return; // not for me
        try {
          const response = JSON.parse(r.text);
          applySyncResponse(response);
        } catch(e) {}
        return;
      }

      // ── Reaction update: someone reacted to (or un-reacted) a message ──
      if (r.type === 'reaction_update') {
        try {
          const { msgId, reaction } = JSON.parse(r.text);
          const chatKey = r.groupId || r.from;
          const target = chats[chatKey]?.find(m => m.msgId === msgId);
          if (target) {
            if (!target.reactions) target.reactions = [];
            // Replace this specific person's reaction, regardless of who else has reacted
            target.reactions = target.reactions.filter(rx => rx.from !== r.from);
            if (reaction) target.reactions.push({ from: r.from, emoji: reaction });
            saveChats();
            if (activeCode === chatKey) renderMessages(chatKey, activeType);
          }
        } catch(e) {}
        return;
      }

      // ── Delete message: the sender removed a message they sent ──
      if (r.type === 'delete_message') {
        try {
          const { msgId } = JSON.parse(r.text);
          const chatKey = r.groupId || r.from;
          const list = chats[chatKey];
          const target = list?.find(m => m.msgId === msgId);
          if (target) removeMessageFromChat(chatKey, target);
        } catch(e) {}
        return;
      }

      // ── Snap received: one-time photo ──
      if (r.type === 'snap') {
        ensureContact(r.from);
        addMessageToChat(r.from, { msgId: r.msgId, snapId: r.snapId, text: r.text, time: new Date(r.created_at).getTime(), sent: false, read: r.from===activeCode, type: 'snap', opened: false });
        recordSnapReceivedFrom(r.from);
        return;
      }

      // ── Snap opened: recipient viewed a specific snap I sent ──
      if (r.type === 'snap_opened') {
        if (chats[r.from]) {
          const targetSnap = chats[r.from].find(m => m.type === 'snap' && m.sent && m.snapId === r.snapId);
          if (targetSnap) { targetSnap.viewedByRecipient = true; saveChats(); if (activeCode === r.from) renderMessages(r.from, activeType); }
        }
        toast((contacts.find(c=>c.code===r.from)?.name || r.from) + ' opened your Blink');
        return;
      }

      // ── Device removed: the primary device removed this device from the account ──
      if (r.type === 'device_removed') {
        if (r.targetDeviceId && r.targetDeviceId !== myDeviceId) return;
        toast('This device was removed from your account');
        setTimeout(() => { localStorage.clear(); window.location.reload(); }, 1500);
        return;
      }

      // ── Link request: another device wants to connect to my account ──
      if (r.type === 'link_request') {
        const requestingDeviceId = r.text;
        respondToLinkRequest(myUsername, requestingDeviceId).then(code => {
          showLinkApprovalUI(requestingDeviceId, code);
        });
        return;
      }

      // ── Link confirm: requesting device sent back a code to verify ──
      if (r.type === 'link_confirm') {
        try {
          const { requestingDeviceId, code } = JSON.parse(r.text);
          verifyAndApproveLinkConfirm(requestingDeviceId, code).then(ok => {
            if (ok) toast('New device connected');
          });
        } catch(e) {}
        return;
      }

      const silentTypes = ['read_receipt','code_change','avatar_update','username_update','story','story_view','story_delete'];
      if (silentTypes.includes(r.type)) return;
      if (!r.text) return;
      ensureContact(r.from);
      addMessageToChat(r.from, { msgId: r.msgId, text: r.text, time: new Date(r.created_at).getTime(), sent: false, read: r.from===activeCode, type: r.type||'text', duration: r.duration, replyTo: parseReplyTo(r.replyTo) });
    });

    // With per-device addresses, every row this poll picked up was meant for
    // THIS device specifically (or is a control message already filtered to
    // this device above) — safe to delete immediately, no other device is
    // waiting on it.
    if (ids.length) await deleteMessageIds(ids);
  } catch(e) {}
}

function parseReplyTo(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch(e) { return null; }
}

// Handles a row that's a mirror of something I sent from a different one of
// my own devices. Re-derives the right local chat and message shape based on
// the row's type, then files it in as already-sent — never as a fresh
// incoming message, so it doesn't notify or bump unread counts.
function handleSelfSyncRow(r) {
  const chatKey = r.groupId || r.originalTo;
  if (!chatKey) return;

  // Silent/control types that have their own dedicated state — apply the
  // same effect locally rather than re-adding them as chat messages.
  if (r.type === 'reaction_update') {
    try {
      const { msgId, reaction } = JSON.parse(r.text);
      const target = chats[chatKey]?.find(m => m.msgId === msgId);
      if (target) {
        if (!target.reactions) target.reactions = [];
        target.reactions = target.reactions.filter(rx => rx.from !== myUsername);
        if (reaction) target.reactions.push({ from: myUsername, emoji: reaction });
        saveChats();
        if (activeCode === chatKey) renderMessages(chatKey, activeType);
      }
    } catch(e) {}
    return;
  }
  if (r.type === 'delete_message') {
    try {
      const { msgId } = JSON.parse(r.text);
      const target = chats[chatKey]?.find(m => m.msgId === msgId);
      if (target) removeMessageFromChat(chatKey, target);
    } catch(e) {}
    return;
  }
  if (['read_receipt','story','story_delete','story_view','code_change','avatar_update','contact_sync','group_invite','snap_opened'].includes(r.type)) {
    // These either don't apply across devices the same way, or are already
    // covered by the regular per-device sync mechanisms — skip silently.
    return;
  }

  if (!chats[chatKey]) chats[chatKey] = [];
  const already = chats[chatKey].some(m => m.msgId === r.msgId);
  if (already) return; // this device already has it locally

  const msg = {
    msgId: r.msgId, text: r.text, time: new Date(r.created_at).getTime(),
    sent: true, read: true, type: r.type || 'text',
    duration: r.duration, replyTo: parseReplyTo(r.replyTo)
  };
  if (r.groupId) { msg.senderCode = myUsername; msg.senderName = myUsername; }

  chats[chatKey].push(msg);
  chats[chatKey].sort((a, b) => a.time - b.time);
  enforceStorageLimit(chatKey);
  saveChats();
  if (chatKey === activeCode) renderMessages(chatKey, activeType);
  renderContacts(document.getElementById('search')?.value || '');
}

function ensureContact(username) {
  if (!contacts.find(c => c.code === username)) {
    contacts.push({ name: username, code: username });
    saveContacts();
    renderContacts(document.getElementById('search').value);
  }
}

// ─── STICKERS ─────────────────────────────────────────────────────────────────
async function loadStickers() {
  try {
    const res = await fetch('stickers.json');
    const data = await res.json();
    stickerData = data.categories;
    buildStickerTabs(); renderStickerGrid('favourites');
  } catch(e) {}
}

function buildStickerTabs() {
  const tabs = document.getElementById('sticker-tabs');
  tabs.innerHTML = '';
  [{ id:'favourites', name:'⭐ Favourites' }, { id:'custom', name:'🖼 My Stickers' }, ...stickerData].forEach(cat => {
    const tab = document.createElement('div');
    tab.className = 'sticker-tab' + (activeStickerCat===cat.id?' active':'');
    tab.textContent = cat.name; tab.dataset.cat = cat.id;
    tab.addEventListener('click', () => {
      activeStickerCat = cat.id;
      document.querySelectorAll('.sticker-tab').forEach(t => t.classList.toggle('active', t.dataset.cat===cat.id));
      renderStickerGrid(cat.id);
    });
    tabs.appendChild(tab);
  });
}

function renderStickerGrid(catId) {
  const grid = document.getElementById('sticker-grid');
  grid.innerHTML = '';
  document.getElementById('create-sticker-btn').style.display = catId==='custom'?'flex':'none';
  const stickers = catId==='favourites'?favStickers:catId==='custom'?customStickers:(stickerData.find(c=>c.id===catId)?.stickers||[]);
  if (!stickers.length) {
    const msg = catId==='favourites'?'Hover a sticker and click ★ to favourite it':catId==='custom'?'Tap "+ Create" to make your own stickers':'No stickers';
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#8e8e93;font-size:13px;padding:24px">${msg}</div>`;
    return;
  }
  stickers.forEach(s => {
    const item = document.createElement('div');
    item.className = 'sticker-item';
    const isFav = favStickers.some(f => f.id===s.id);
    if (catId==='custom') {
      item.innerHTML = `<img src="${s.url}" alt="${s.name}" loading="lazy"><button class="sticker-fav-btn active" style="color:#ff453a" title="Delete">✕</button>`;
      item.querySelector('img').addEventListener('click', () => sendStickerMsg(s));
      item.querySelector('.sticker-fav-btn').addEventListener('click', e => {
        e.stopPropagation();
        customStickers = customStickers.filter(cs=>cs.id!==s.id);
        favStickers    = favStickers.filter(f=>f.id!==s.id);
        saveCustomStickers(); saveFavStickers(); renderStickerGrid('custom'); toast('Sticker deleted');
      });
    } else {
      item.innerHTML = `<img src="${s.url}" alt="${s.name}" loading="lazy"><button class="sticker-fav-btn ${isFav?'active':''}" title="${isFav?'Remove':'Favourite'}">★</button>`;
      item.querySelector('img').addEventListener('click', () => sendStickerMsg(s));
      item.querySelector('.sticker-fav-btn').addEventListener('click', e => {
        e.stopPropagation();
        const idx = favStickers.findIndex(f=>f.id===s.id);
        if (idx===-1) { favStickers.push(s); toast(`${s.name} added to favourites`); }
        else { favStickers.splice(idx,1); toast('Removed from favourites'); }
        saveFavStickers(); renderStickerGrid(activeStickerCat);
      });
    }
    grid.appendChild(item);
  });
}

function saveReceivedSticker(url) {
  // Avoid duplicates — check if this exact image is already saved
  if (customStickers.some(s => s.url === url)) {
    toast('Already in My Stickers');
    return;
  }
  const sticker = { id: 'cs_' + Date.now(), name: 'Saved Sticker', url };
  customStickers.push(sticker);
  saveCustomStickers();
  toast('Sticker saved to My Stickers');
}

function showStickerMenu(bubbleEl, bwrap, url) {
  document.querySelectorAll('.sticker-tap-menu').forEach(m => m.remove());

  const alreadySaved = customStickers.some(s => s.url === url);

  const menu = document.createElement('div');
  menu.className = 'sticker-tap-menu';
  menu.innerHTML = `
    <button class="sticker-menu-btn add-sticker-btn" ${alreadySaved ? 'disabled' : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      ${alreadySaved ? 'Already Saved' : 'Add Sticker'}
    </button>`;

  if (!alreadySaved) {
    menu.querySelector('.add-sticker-btn').addEventListener('click', () => {
      saveReceivedSticker(url);
      menu.remove();
    });
  }

  bwrap.appendChild(menu);

  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
    });
  }, 10);
}

function sendStickerMsg(s) {
  if (!activeCode) return;
  const msgId = generateMsgId();
  if (activeType==='group') sendGroupMessage(s.url,'sticker',{msgId});
  else { addMessageToChat(activeCode,{msgId,text:s.url,time:Date.now(),sent:true,read:true,type:'sticker'}); pushToSupabase(activeCode,s.url,'sticker',{msgId}); }
  trackMessageSent('sticker');
  closeAllPanels();
}

// ─── LIGHTBOX ─────────────────────────────────────────────────────────────────
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.getElementById('lightbox-img').src = '';
  document.body.style.overflow = '';
}

function closeAllPanels() {
  document.getElementById('sticker-panel').classList.remove('open');
  document.getElementById('attach-menu').classList.remove('open');
  document.getElementById('attach-btn').classList.remove('open');
}

// ─── STORAGE ──────────────────────────────────────────────────────────────────
function enforceStorageLimit(code) {
  if (chats[code]?.length > 500) chats[code] = chats[code].slice(-500);
  try {
    const used = new Blob([JSON.stringify(chats)]).size;
    if (used > 4*1024*1024) Object.keys(chats).forEach(k => { if(chats[k].length>50) chats[k]=chats[k].slice(-50); });
  } catch(e) {}
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function isImageUrl(url) { if(!url) return false; return /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?.*)?$/i.test(url.trim()); }

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatTime(ts) {
  const d=new Date(ts),now=new Date(),diff=now-d;
  if(diff<60000) return 'now';
  if(diff<3600000) return Math.floor(diff/60000)+'m';
  if(d.toDateString()===now.toDateString()) return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString([],{month:'short',day:'numeric'});
}
function formatDateLabel(d) {
  const now=new Date();
  if(d.toDateString()===now.toDateString()) return 'Today';
  const y=new Date(now); y.setDate(y.getDate()-1);
  if(d.toDateString()===y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});
}
function escHtml(t) { if(!t) return ''; return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
function toast(msg) {
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'),2200);
}

// ─── RENAME HELPER ────────────────────────────────────────────────────────────
function showRenameModal(contact) {
  document.getElementById('rename-input').value = contact.name;
  document.getElementById('rename-modal').classList.add('open');
  document.getElementById('rename-input').focus();
  document.getElementById('rename-confirm').onclick = () => {
    const newName = document.getElementById('rename-input').value.trim();
    if (!newName) { toast('Name cannot be empty'); return; }
    contact.name = newName; contact.lastModified = Date.now(); saveContacts();
    renderContacts(document.getElementById('search').value);
    if (activeCode===contact.code) document.getElementById('chat-header-name').textContent = newName;
    document.getElementById('rename-modal').classList.remove('open');
    toast('Contact renamed');
    pushContactUpdateToDevices(contact);
  };
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────

// Welcome
document.getElementById('welcome-btn').addEventListener('click', async () => {
  if (window._signupsDisabled) {
    document.getElementById('welcome-hint').style.color = '#ff453a';
    document.getElementById('welcome-hint').textContent = 'New signups are temporarily disabled.';
    return;
  }
  const val = document.getElementById('welcome-input').value.trim();
  if (!validateUsername(val)) {
    document.getElementById('welcome-hint').style.color = '#ff453a';
    document.getElementById('welcome-hint').textContent = 'Letters, numbers and _ only. No spaces.';
    return;
  }
  const btn = document.getElementById('welcome-btn');
  btn.textContent = 'Checking...';
  btn.disabled = true;
  const taken = await isUsernameTaken(val);
  if (taken) {
    btn.textContent = 'Get Started';
    btn.disabled = false;
    document.getElementById('welcome-hint').style.color = '#ff453a';
    document.getElementById('welcome-hint').textContent = '@' + val + ' is already taken — try another.';
    return;
  }
  if (await isUsernameBlacklisted(val)) {
    btn.textContent = 'Get Started';
    btn.disabled = false;
    document.getElementById('welcome-hint').style.color = '#ff453a';
    // Same wording as "already taken" — doesn't reveal this username is
    // specifically blocked, just nudges toward picking something else.
    document.getElementById('welcome-hint').textContent = '@' + val + ' is unavailable — try another.';
    return;
  }
  await setUsername(val, true);
  await registerUsername(val);
  trackNewSignup();
  document.getElementById('welcome-screen').style.display = 'none';
  stopLinkingPoll();
  await registerDevice();
  startApp();
});
document.getElementById('welcome-input').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('welcome-btn').click(); });
document.getElementById('welcome-input').addEventListener('input', () => {
  document.getElementById('welcome-hint').style.color = '#8e8e93';
  document.getElementById('welcome-hint').textContent = 'No spaces. Letters, numbers and _ only.';
});

// ─── DEVICE LINKING UI ──────────────────────────────────────────────────────────
document.getElementById('welcome-connect-link').addEventListener('click', () => {
  document.getElementById('link-step-username').style.display = 'block';
  document.getElementById('link-step-code').style.display = 'none';
  document.getElementById('link-username-input').value = '';
  document.getElementById('link-modal').classList.add('open');
  document.getElementById('link-username-input').focus();
});

let pendingLinkTarget = '';

document.getElementById('link-cancel-1').addEventListener('click', () => document.getElementById('link-modal').classList.remove('open'));
document.getElementById('link-cancel-2').addEventListener('click', () => document.getElementById('link-modal').classList.remove('open'));
document.getElementById('link-modal').addEventListener('click', e => { if (e.target === document.getElementById('link-modal')) document.getElementById('link-modal').classList.remove('open'); });

document.getElementById('link-send-request').addEventListener('click', async () => {
  const target = document.getElementById('link-username-input').value.trim();
  if (!validateUsername(target)) { toast('Enter a valid username'); return; }
  const btn = document.getElementById('link-send-request');
  btn.disabled = true; btn.textContent = 'Sending...';
  await sendLinkRequest(target, myDeviceId);
  btn.disabled = false; btn.textContent = 'Send Request';
  pendingLinkTarget = target;
  document.getElementById('link-step-username').style.display = 'none';
  document.getElementById('link-step-code').style.display = 'block';
  document.getElementById('link-code-input').value = '';
  document.getElementById('link-code-input').focus();
});

document.getElementById('link-submit-code').addEventListener('click', async () => {
  const code = document.getElementById('link-code-input').value.trim();
  if (!/^\d{6}$/.test(code)) { toast('Enter the 6-digit code'); return; }
  const btn = document.getElementById('link-submit-code');
  btn.disabled = true; btn.textContent = 'Connecting...';
  await submitLinkCode(pendingLinkTarget, myDeviceId, code);
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Connect'; }, 3000);
});

document.getElementById('link-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('link-submit-code').click(); });

document.getElementById('link-approval-dismiss').addEventListener('click', () => {
  document.getElementById('link-approval-overlay').classList.remove('open');
});

// Settings — manual sync trigger
document.getElementById('settings-sync-btn').addEventListener('click', async () => {
  document.getElementById('settings-overlay').classList.remove('open');
  toast('Checking for other devices...');
  await requestSync(true);
});

// Feedback / bug report
document.getElementById('settings-feedback-btn').addEventListener('click', () => {
  document.getElementById('settings-overlay').classList.remove('open');
  document.getElementById('feedback-text').value = '';
  document.getElementById('feedback-modal').classList.add('open');
  document.getElementById('feedback-text').focus();
});
document.getElementById('feedback-cancel').addEventListener('click', () => document.getElementById('feedback-modal').classList.remove('open'));
document.getElementById('feedback-modal').addEventListener('click', e => { if (e.target === document.getElementById('feedback-modal')) document.getElementById('feedback-modal').classList.remove('open'); });
document.getElementById('feedback-send').addEventListener('click', async () => {
  const text = document.getElementById('feedback-text').value.trim();
  if (!text) { toast('Write something first'); return; }
  const btn = document.getElementById('feedback-send');
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/feedback_reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ username: myUsername, message: text })
    });
    document.getElementById('feedback-modal').classList.remove('open');
    toast('Thanks — feedback sent');
  } catch(e) {
    toast('Failed to send feedback');
  }
  btn.disabled = false; btn.textContent = 'Send';
});

// Story editor
document.getElementById('story-editor-cancel').addEventListener('click', closeStoryEditor);
document.getElementById('story-editor-text-btn').addEventListener('click', () => {
  editorEditingText = null;
  editorActiveColor = '#ffffff';
  editorBgOn = false;
  document.querySelectorAll('.story-text-color').forEach(b => b.classList.toggle('active', b.dataset.color === '#ffffff'));
  document.getElementById('story-text-bg-toggle').classList.remove('active');
  document.getElementById('story-text-input').value = '';
  document.getElementById('story-text-panel').classList.add('open');
  document.getElementById('story-text-input').focus();
});
document.getElementById('story-editor-sticker-btn').addEventListener('click', openStickerPanelForStory);
document.getElementById('story-editor-post-btn').addEventListener('click', flattenAndPost);

document.querySelectorAll('.story-text-color').forEach(btn => {
  btn.addEventListener('click', () => {
    editorActiveColor = btn.dataset.color;
    document.querySelectorAll('.story-text-color').forEach(b => b.classList.toggle('active', b === btn));
  });
});
document.getElementById('story-text-bg-toggle').addEventListener('click', () => {
  editorBgOn = !editorBgOn;
  document.getElementById('story-text-bg-toggle').classList.toggle('active', editorBgOn);
});
document.getElementById('story-text-done').addEventListener('click', addTextElement);
document.getElementById('story-text-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addTextElement(); }
});

window.addEventListener('resize', () => { if (document.getElementById('story-editor').classList.contains('open')) renderEditorCanvas(); });

// Blink Camera (Snap-style one-time photos)
document.getElementById('blink-camera-btn').addEventListener('click', openBlinkCamera);
document.getElementById('blink-camera-close').addEventListener('click', closeBlinkCamera);
document.getElementById('blink-camera-flip').addEventListener('click', flipCamera);
document.getElementById('blink-camera-shutter').addEventListener('click', captureSnapPhoto);
document.getElementById('blink-camera-retake').addEventListener('click', retakeSnap);
document.getElementById('blink-camera-send-btn').addEventListener('click', openSnapSendToPicker);

document.getElementById('snap-sendto-cancel').addEventListener('click', () => document.getElementById('snap-sendto-modal').classList.remove('open'));
document.getElementById('snap-sendto-modal').addEventListener('click', e => { if (e.target === document.getElementById('snap-sendto-modal')) document.getElementById('snap-sendto-modal').classList.remove('open'); });
document.getElementById('snap-sendto-confirm').addEventListener('click', sendSnapToSelected);

// Stories
let storyPressTimer;
document.getElementById('my-story-circle').addEventListener('click', () => {
  if (myStory) openStoryViewer(myUsername);
  else document.getElementById('story-file-input').click();
});
document.getElementById('my-story-circle').addEventListener('mousedown', () => {
  if (myStory) storyPressTimer = setTimeout(() => { if (confirm('Remove your story?')) removeMyStory(); }, 600);
});
document.getElementById('my-story-circle').addEventListener('mouseup', () => clearTimeout(storyPressTimer));
document.getElementById('my-story-circle').addEventListener('touchstart', () => {
  if (myStory) storyPressTimer = setTimeout(() => { if (confirm('Remove your story?')) removeMyStory(); }, 600);
}, { passive: true });
document.getElementById('my-story-circle').addEventListener('touchend', () => clearTimeout(storyPressTimer));
document.getElementById('story-file-input').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  openStoryEditor(file);
});
document.getElementById('story-viewer-close').addEventListener('click', closeStoryViewer);
document.getElementById('story-viewer-tap-right').addEventListener('click', closeStoryViewer);
document.getElementById('story-viewer-tap-left').addEventListener('click', closeStoryViewer);
document.getElementById('story-viewer-delete').addEventListener('click', () => {
  if (confirm('Remove your story?')) {
    removeMyStory();
    closeStoryViewer();
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeStoryViewer(); });

// Lightbox
document.getElementById('lightbox').addEventListener('click', e => { if(e.target===document.getElementById('lightbox')) closeLightbox(); });
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.addEventListener('keydown', e => { if(e.key==='Escape') { closeLightbox(); document.getElementById('settings-overlay').classList.remove('open'); } });

// Avatar upload/remove
document.getElementById('settings-upload-avatar').addEventListener('click', () => document.getElementById('avatar-file-input').click());
document.getElementById('avatar-file-input').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value='';
  if (!file) return;
  await setProfilePicture(file);
  document.getElementById('settings-overlay').classList.remove('open');
});
document.getElementById('settings-remove-avatar').addEventListener('click', () => {
  removeProfilePicture();
  document.getElementById('settings-overlay').classList.remove('open');
});

// Settings — remove story
document.getElementById('settings-remove-story').addEventListener('click', () => {
  if (!myStory) { toast('You have no active story'); return; }
  document.getElementById('settings-overlay').classList.remove('open');
  if (confirm('Remove your story?')) removeMyStory();
});

// Remove account
document.getElementById('settings-remove-account').addEventListener('click', async () => {
  document.getElementById('settings-overlay').classList.remove('open');

  const others = await getMyOtherDevices();
  const isLastDevice = others.length === 0;

  const title = document.getElementById('remove-account-title');
  const body  = document.getElementById('remove-account-body');
  const confirmBtn = document.getElementById('remove-account-confirm');

  if (isLastDevice) {
    title.textContent = '⚠️ Remove Account';
    body.textContent = 'This will permanently delete your username and erase all your messages, contacts, and data from this device. This cannot be undone.';
    confirmBtn.textContent = 'Delete Everything';
  } else {
    title.textContent = '⚠️ Remove This Device';
    body.textContent = `This will remove this device from your account and erase its local data. @${myUsername} will remain active on your other ${others.length > 1 ? 'devices' : 'device'}.`;
    confirmBtn.textContent = 'Remove This Device';
  }
  document.getElementById('remove-account-modal').dataset.isLastDevice = isLastDevice ? '1' : '0';

  const countdown  = document.getElementById('remove-account-countdown');
  countdown.textContent = '3';
  confirmBtn.disabled = true;
  confirmBtn.style.opacity = '0.4';
  document.getElementById('remove-account-modal').classList.add('open');
  let secs = 3;
  const timer = setInterval(() => {
    secs--;
    if (secs <= 0) {
      clearInterval(timer);
      countdown.textContent = '';
      confirmBtn.disabled = false;
      confirmBtn.style.opacity = '1';
    } else {
      countdown.textContent = secs;
    }
  }, 1000);
  document.getElementById('remove-account-modal')._timer = timer;
});
document.getElementById('remove-account-cancel').addEventListener('click', () => {
  clearInterval(document.getElementById('remove-account-modal')._timer);
  document.getElementById('remove-account-modal').classList.remove('open');
});
document.getElementById('remove-account-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('remove-account-modal')) {
    clearInterval(document.getElementById('remove-account-modal')._timer);
    document.getElementById('remove-account-modal').classList.remove('open');
  }
});
document.getElementById('remove-account-confirm').addEventListener('click', async () => {
  const isLastDevice = document.getElementById('remove-account-modal').dataset.isLastDevice === '1';
  if (isLastDevice) {
    // Only device on this account — full teardown, same as before.
    await releaseUsername(myUsername);
  }
  // Either way, this device's own registration should be removed so other
  // devices stop trying to fork messages to an address that no longer exists.
  await unregisterThisDevice();
  localStorage.clear();
  window.location.reload();
});

document.getElementById('settings-btn').addEventListener('click', async () => {
  try { document.getElementById('settings-username-val').textContent = '@' + myUsername; } catch(e) {}
  try { updateMyAvatarUI(); } catch(e) {}
  try { updateNotificationToggleUI(); } catch(e) {}
  try {
    const removeStoryBtn = document.getElementById('settings-remove-story');
    if (removeStoryBtn) removeStoryBtn.style.display = myStory ? 'block' : 'none';
  } catch(e) {}
  document.getElementById('settings-overlay').classList.add('open');
  renderManageDevicesSection();
});
document.getElementById('settings-close').addEventListener('click', () => document.getElementById('settings-overlay').classList.remove('open'));
document.getElementById('settings-overlay').addEventListener('click', e => { if(e.target===document.getElementById('settings-overlay')) document.getElementById('settings-overlay').classList.remove('open'); });

async function renderManageDevicesSection() {
  const section = document.getElementById('manage-devices-section');
  const list = document.getElementById('manage-devices-list');
  if (!section || !list) return;

  const allDevices = await getAllMyDevices();
  const amPrimary = isPrimaryDevice(allDevices);

  if (!amPrimary || allDevices.length <= 1) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = '';
  allDevices.forEach((dev, idx) => {
    const isMe = dev.device_id === myDeviceId;
    const isPrimaryRow = idx === 0;
    const row = document.createElement('div');
    row.className = 'device-row';
    const lastSeenStr = formatTime(new Date(dev.last_seen).getTime());
    row.innerHTML = `
      <div class="device-row-info">
        <div class="device-row-label">${escHtml(dev.device_label || 'Device')}${isPrimaryRow ? ' · Primary' : ''}${isMe ? ' (this device)' : ''}</div>
        <div class="device-row-seen">Last active ${lastSeenStr}</div>
      </div>
      ${!isMe ? `<button class="device-remove-btn" data-id="${dev.device_id}">Remove</button>` : ''}
    `;
    if (!isMe) {
      row.querySelector('.device-remove-btn').addEventListener('click', async () => {
        if (!confirm(`Remove "${dev.device_label || 'this device'}" from your account?`)) return;
        await removeOtherDevice(dev.device_id);
        toast('Device removed');
        renderManageDevicesSection();
      });
    }
    list.appendChild(row);
  });
}

// Notifications toggle
document.getElementById('notif-toggle').addEventListener('change', async e => {
  if (e.target.checked) {
    const granted = await requestNotificationPermission();
    if (!granted) { e.target.checked=false; toast('Notifications blocked — check browser settings'); updateNotificationToggleUI(); return; }
    notificationsOn = true;
  } else { notificationsOn = false; }
  ls('notificationsOn', String(notificationsOn));
  updateNotificationToggleUI();
  toast('Notifications ' + (notificationsOn?'on':'off'));
});

// Change username
document.getElementById('settings-change-username').addEventListener('click', () => {
  document.getElementById('settings-overlay').classList.remove('open');
  document.getElementById('username-input').value = myUsername;
  document.getElementById('username-modal').classList.add('open');
  document.getElementById('username-input').focus();
});
document.getElementById('username-cancel').addEventListener('click', () => document.getElementById('username-modal').classList.remove('open'));
document.getElementById('username-modal').addEventListener('click', e => { if(e.target===document.getElementById('username-modal')) document.getElementById('username-modal').classList.remove('open'); });
document.getElementById('username-confirm').addEventListener('click', async () => {
  const val = document.getElementById('username-input').value.trim();
  if (!validateUsername(val)) { toast('Invalid — letters, numbers and _ only'); return; }
  if (val===myUsername) { document.getElementById('username-modal').classList.remove('open'); return; }

  const btn = document.getElementById('username-confirm');
  btn.textContent = 'Checking...';
  btn.disabled = true;
  const taken = await isUsernameTaken(val);
  btn.textContent = 'Save';
  btn.disabled = false;

  if (taken) { toast('@' + val + ' is already taken'); return; }

  const oldUsername = myUsername;
  document.getElementById('username-modal').classList.remove('open');
  await releaseUsername(oldUsername);
  await registerUsername(val);
  await setUsername(val, false);
  toast('Username updated — reshare your new @' + val);
});
document.getElementById('username-input').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('username-confirm').click(); });

// Code bar
document.getElementById('my-code-bar').addEventListener('click', () => {
  navigator.clipboard?.writeText(myUsername).then(()=>toast('@'+myUsername+' copied!')).catch(()=>toast('@'+myUsername));
});

// Edit mode
document.getElementById('edit-btn').addEventListener('click', toggleEditMode);
document.getElementById('edit-mark-read').addEventListener('click', () => {
  selectedContacts.forEach(id => { if(chats[id]) chats[id].forEach(m=>{if(!m.sent)m.read=true;}); });
  saveChats(); selectedContacts.clear();
  renderContacts(document.getElementById('search').value); updateEditActions(); toast('Marked as read');
});
document.getElementById('edit-rename').addEventListener('click', () => {
  const code = [...selectedContacts][0];
  const contact = contacts.find(c=>c.code===code);
  if (contact) showRenameModal(contact);
});
document.getElementById('edit-delete').addEventListener('click', () => {
  const ids = [...selectedContacts];
  const names = ids.map(id=>contacts.find(c=>c.code===id)?.name||groups.find(g=>g.id===id)?.name).filter(Boolean);
  document.getElementById('delete-name').textContent = names.join(', ');
  document.getElementById('delete-modal').classList.add('open');
  document.getElementById('delete-confirm').onclick = () => {
    ids.forEach(id => {
      contacts=contacts.filter(c=>c.code!==id); groups=groups.filter(g=>g.id!==id); delete chats[id];
      if(ls('lastChat')===id){ls('lastChat','');ls('lastType','dm');}
      if(activeCode===id){activeCode=null;document.getElementById('empty-state').style.display='flex';document.getElementById('chat-main').style.display='none';if(isMobile())showSidebar();}
    });
    saveContacts(); saveGroups(); saveChats(); selectedContacts.clear();
    renderContacts(document.getElementById('search').value); updateEditActions();
    document.getElementById('delete-modal').classList.remove('open'); toggleEditMode();
    toast(`Deleted ${names.length} item${names.length>1?'s':''}`);
  };
});

// Rename/delete modals
document.getElementById('rename-cancel').addEventListener('click', ()=>document.getElementById('rename-modal').classList.remove('open'));
document.getElementById('rename-modal').addEventListener('click', e=>{if(e.target===document.getElementById('rename-modal'))document.getElementById('rename-modal').classList.remove('open');});
document.getElementById('rename-input').addEventListener('keydown', e=>{if(e.key==='Enter')document.getElementById('rename-confirm').click();});
document.getElementById('delete-cancel').addEventListener('click', ()=>document.getElementById('delete-modal').classList.remove('open'));
document.getElementById('delete-modal').addEventListener('click', e=>{if(e.target===document.getElementById('delete-modal'))document.getElementById('delete-modal').classList.remove('open');});

// New contact
document.getElementById('new-contact-btn').addEventListener('click', () => {
  document.getElementById('contact-name-input').value=''; document.getElementById('contact-code-input').value='';
  document.getElementById('modal').classList.add('open'); document.getElementById('contact-name-input').focus();
});
document.getElementById('modal-cancel').addEventListener('click', ()=>document.getElementById('modal').classList.remove('open'));
document.getElementById('modal').addEventListener('click', e=>{if(e.target===document.getElementById('modal'))document.getElementById('modal').classList.remove('open');});
document.getElementById('modal-add').addEventListener('click', () => {
  const name=document.getElementById('contact-name-input').value.trim();
  const code=document.getElementById('contact-code-input').value.trim();
  if(!name||!code){toast('Fill in both fields');return;}
  if(code===myUsername){toast("That's your own username");return;}
  if(contacts.find(c=>c.code===code)){toast('Contact already exists');return;}
  contacts.push({name,code,lastModified:Date.now()}); saveContacts(); renderContacts();
  document.getElementById('modal').classList.remove('open');
  toast(`${name} added`); openChat(code);
  pushContactUpdateToDevices(contacts[contacts.length - 1]);
});

// New group
document.getElementById('new-group-btn').addEventListener('click', () => {
  const list=document.getElementById('group-member-list');
  list.innerHTML='';
  if(!contacts.length){list.innerHTML='<div style="color:#8e8e93;font-size:13px;padding:8px 0">Add contacts first</div>';}
  else{contacts.forEach(c=>{const row=document.createElement('label');row.className='member-checkbox-row';row.innerHTML=`<input type="checkbox" value="${c.code}"><div class="avatar ${avatarColor(c.code)}" style="width:32px;height:32px;font-size:13px">${avatarLetter(c.name)}</div><span>${escHtml(c.name)}</span>`;list.appendChild(row);});}
  document.getElementById('group-name-input').value='';
  document.getElementById('group-modal').classList.add('open');
  document.getElementById('group-name-input').focus();
});
document.getElementById('group-modal-cancel').addEventListener('click', ()=>document.getElementById('group-modal').classList.remove('open'));
document.getElementById('group-modal').addEventListener('click', e=>{if(e.target===document.getElementById('group-modal'))document.getElementById('group-modal').classList.remove('open');});
document.getElementById('group-modal-create').addEventListener('click', async () => {
  const name=document.getElementById('group-name-input').value.trim();
  if(!name){toast('Enter a group name');return;}
  const checked=[...document.querySelectorAll('#group-member-list input:checked')].map(i=>i.value);
  if(!checked.length){toast('Select at least one member');return;}
  document.getElementById('group-modal').classList.remove('open');
  await createGroup(name,checked);
});

// Search / back
document.getElementById('search').addEventListener('input', e=>renderContacts(e.target.value));
document.getElementById('back-btn').addEventListener('click', showSidebar);

// Image
document.getElementById('attach-btn').addEventListener('click', () => {
  const menu = document.getElementById('attach-menu');
  const wasOpen = menu.classList.contains('open');
  closeAllPanels();
  if (!wasOpen) {
    menu.classList.add('open');
    document.getElementById('attach-btn').classList.add('open');
  }
});
document.getElementById('attach-photo-btn').addEventListener('click', () => {
  closeAllPanels();
  document.getElementById('image-file-input').click();
});
document.getElementById('attach-file-btn').addEventListener('click', () => {
  closeAllPanels();
  document.getElementById('generic-file-input').click();
});
document.getElementById('image-file-input').addEventListener('change', async e=>{
  const file=e.target.files[0];e.target.value='';
  if(!file||!activeCode)return;
  toast('Compressing...');
  try{
    const base64=await compressImage(file);
    const sizeKB=Math.round((base64.length*3/4)/1024);
    const msgId = generateMsgId();
    if(activeType==='group') await sendGroupMessage(base64,'image',{msgId});
    else{addMessageToChat(activeCode,{msgId,text:base64,time:Date.now(),sent:true,read:true,type:'image'});await pushToSupabase(activeCode,base64,'image',{msgId});}
    trackMessageSent('image');
    toast(`Sent · ${sizeKB}KB`);
  }catch(err){toast('Failed to compress image');}
});

document.getElementById('generic-file-input').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !activeCode) return;
  if (file.size > MAX_FILE_BYTES) {
    toast(`File too large — max ${Math.round(MAX_FILE_BYTES/1024)}KB`);
    return;
  }
  toast('Sending file...');
  try {
    const base64 = await fileToBase64(file);
    const sizeKB = Math.round(file.size / 1024);
    const fileData = JSON.stringify({ name: file.name, size: file.size, data: base64 });
    const msgId = generateMsgId();
    if (activeType === 'group') {
      await sendGroupMessage(fileData, 'file', { msgId });
    } else {
      addMessageToChat(activeCode, { msgId, text: fileData, time: Date.now(), sent: true, read: true, type: 'file' });
      await pushToSupabase(activeCode, fileData, 'file', { msgId });
    }
    trackMessageSent('file');
    toast(`Sent · ${sizeKB}KB`);
  } catch(err) {
    toast('Failed to send file');
  }
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Stickers
document.getElementById('create-sticker-btn').addEventListener('click', ()=>document.getElementById('sticker-file-input').click());
document.getElementById('sticker-file-input').addEventListener('change', async e=>{
  const file=e.target.files[0];e.target.value='';
  if(!file)return;
  toast('Creating sticker...');
  try{
    const base64=await compressImage(file,MAX_STICKER_BYTES,300,0.7);
    const sizeKB=Math.round((base64.length*3/4)/1024);
    customStickers.push({id:'cs_'+Date.now(),name:'My Sticker',url:base64});
    saveCustomStickers();activeStickerCat='custom';
    document.querySelectorAll('.sticker-tab').forEach(t=>t.classList.toggle('active',t.dataset.cat==='custom'));
    renderStickerGrid('custom');toast(`Sticker created · ${sizeKB}KB`);
  }catch(err){toast('Failed to create sticker');}
});
document.getElementById('sticker-btn').addEventListener('click', ()=>{
  const sp=document.getElementById('sticker-panel');
  const wasOpen=sp.classList.contains('open');
  closeAllPanels();if(!wasOpen)sp.classList.add('open');
});
document.addEventListener('click', e=>{if(!e.target.closest('#input-area'))closeAllPanels();});

// Voice recording — press and hold mic button
const micBtn = document.getElementById('mic-btn');
let micHeld = false;
let micStartedRecording = false;

async function handleMicDown(e) {
  e.preventDefault();
  if (!activeCode) return;
  micHeld = true;
  micStartedRecording = await startRecording();
}
function handleMicUp() {
  if (!micHeld) return;
  micHeld = false;
  if (micStartedRecording) stopRecording(true);
  micStartedRecording = false;
}
micBtn.addEventListener('mousedown', handleMicDown);
micBtn.addEventListener('mouseup', handleMicUp);
micBtn.addEventListener('mouseleave', () => { if (micHeld) handleMicUp(); });
micBtn.addEventListener('touchstart', handleMicDown, { passive: false });
micBtn.addEventListener('touchend', handleMicUp);
micBtn.addEventListener('touchcancel', handleMicUp);

document.getElementById('recording-cancel').addEventListener('click', () => {
  micHeld = false;
  stopRecording(false);
});

document.getElementById('voice-preview-delete').addEventListener('click', () => {
  hideVoicePreview();
});

document.getElementById('voice-preview-play').addEventListener('click', () => {
  if (!recordedBlob) return;
  const btn = document.getElementById('voice-preview-play');
  const fill = document.getElementById('voice-preview-fill');
  const timeEl = document.getElementById('voice-preview-time');

  if (voicePreviewAudio && !voicePreviewAudio.paused) {
    voicePreviewAudio.pause();
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    return;
  }
  if (!voicePreviewAudio) voicePreviewAudio = new Audio(URL.createObjectURL(recordedBlob));
  voicePreviewAudio.play();
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';

  voicePreviewAudio.ontimeupdate = () => {
    const pct = (voicePreviewAudio.currentTime / (voicePreviewAudio.duration || recordedDuration)) * 100;
    fill.style.width = pct + '%';
    timeEl.textContent = formatDuration(voicePreviewAudio.currentTime);
  };
  voicePreviewAudio.onended = () => {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    fill.style.width = '0%';
    timeEl.textContent = formatDuration(recordedDuration);
  };
});

// Scrub the voice preview bar before sending
const voicePreviewBar = document.getElementById('voice-preview-bar');
function voicePreviewSeek(e) {
  if (!recordedBlob) return;
  if (!voicePreviewAudio) voicePreviewAudio = new Audio(URL.createObjectURL(recordedBlob));
  const rect = voicePreviewBar.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const dur = voicePreviewAudio.duration || recordedDuration || 0;
  if (dur) voicePreviewAudio.currentTime = pct * dur;
  document.getElementById('voice-preview-fill').style.width = (pct * 100) + '%';
  document.getElementById('voice-preview-time').textContent = formatDuration(pct * dur);
}
voicePreviewBar.addEventListener('mousedown', e => {
  voicePreviewSeek(e);
  const mm = ev => voicePreviewSeek(ev);
  const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
  document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
});
voicePreviewBar.addEventListener('touchstart', voicePreviewSeek, { passive: true });
voicePreviewBar.addEventListener('touchmove', voicePreviewSeek, { passive: true });

// Msg input
const msgInput=document.getElementById('msg-input');
const sendBtn=document.getElementById('send-btn');
msgInput.addEventListener('input',()=>{
  const hasText = !!msgInput.value.trim();
  sendBtn.disabled = !hasText;
  sendBtn.style.display = hasText ? 'flex' : 'none';
  document.getElementById('mic-btn').style.display = hasText ? 'none' : 'flex';
  msgInput.style.height='auto';
  msgInput.style.height=Math.min(msgInput.scrollHeight,120)+'px';
});
msgInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!sendBtn.disabled)sendMessage();}});
sendBtn.addEventListener('click', () => {
  if (recordedBlob) sendVoiceMessage();
  else sendMessage();
});

// Initial state — show mic, hide send
document.getElementById('mic-btn').style.display = 'flex';
document.getElementById('send-btn').style.display = 'none';

init();
