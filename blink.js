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

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  myUsername = ls('myUsername') || '';
  const oldCode = ls('myCode');
  if (oldCode && !myUsername) ls('myCode', '');

  const appEl = document.getElementById('app');
  appEl.style.animation = 'none';
  appEl.style.opacity = '1';

  if (!myUsername) {
    document.getElementById('welcome-screen').style.display = 'flex';
    return;
  }
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
  notificationsOn = ls('notificationsOn') !== 'false';
  updateMyAvatarUI();
  cleanExpiredImages();
  cleanExpiredStories();
  renderContacts();
  await loadStickers();
  if (SUPABASE_URL && SUPABASE_KEY) setInterval(pollMessages, POLL_INTERVAL);
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
      renderAvatarEl(document.getElementById('chat-avatar'), myUsername, myUsername, 36);
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
  const msg = { text: base64, time: Date.now(), sent: true, read: true, type: 'voice', duration: recordedDuration };

  if (activeType === 'group') {
    await sendGroupMessage(base64, 'voice', { duration: recordedDuration });
  } else {
    addMessageToChat(activeCode, msg);
    await pushToSupabase(activeCode, base64, 'voice', { duration: recordedDuration });
  }

  hideVoicePreview();
  toast(`Voice sent · ${sizeKB}KB`);
}


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

// ─── MOBILE NAV ───────────────────────────────────────────────────────────────
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
      else if (last.type === 'group_invite') preview = '👥 Group invite';
      else preview = (last.sent ? 'You: ' : (last.senderName ? last.senderName + ': ' : '')) + last.text;
    }
    const div = document.createElement('div');
    div.className = 'contact-item' + (isActive ? ' active' : '') + (isSelected ? ' selected' : '');
    const avatarHtml = type === 'group'
      ? `<div class="avatar group-avatar">${groupAvatarSVG(avatarColor(data.id))}</div>`
      : `<div class="avatar ${getAvatar(data.code) ? 'avatar-img' : avatarColor(data.code)}">${getAvatar(data.code) ? `<img src="${getAvatar(data.code)}" style="width:44px;height:44px;border-radius:50%;object-fit:cover;display:block;">` : avatarLetter(data.name)}</div>`;
    if (editMode) {
      div.innerHTML = `<div class="select-circle ${isSelected?'checked':''}"></div>${avatarHtml}<div class="contact-info"><div class="contact-name">${escHtml(data.name)}</div><div class="contact-preview">${escHtml(preview)}</div></div>`;
      div.addEventListener('click', () => toggleSelectContact(id));
    } else {
      div.innerHTML = `${avatarHtml}<div class="contact-info"><div class="contact-name">${escHtml(data.name)}</div><div class="contact-preview">${escHtml(preview)}</div></div><div class="contact-meta">${last?`<div class="contact-time">${formatTime(last.time)}</div>`:''} ${unread>0?`<div class="unread-badge">${unread}</div>`:''}</div>`;
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
  renderAvatarEl(av, code, contact.name, 36);
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
  const msgs = (chats[code] || []).filter(m => m.text !== '__read__' && m.text !== '');
  let lastDate = null;
  msgs.forEach(m => {
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
    const bubble = document.createElement('div');
    if (m.type === 'voice') {
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
    if (m.reaction) {
      const badge = document.createElement('div');
      badge.className = 'reaction-badge';
      badge.textContent = m.reaction;
      badge.addEventListener('click', () => { m.reaction = null; saveChats(); renderMessages(code, type); });
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
    wrap.appendChild(row);
  });
  wrap.scrollTop = wrap.scrollHeight;
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
  document.querySelectorAll('.reaction-picker').forEach(p => p.remove());
  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  REACTIONS.forEach(r => {
    const span = document.createElement('span');
    span.textContent = r;
    span.addEventListener('click', () => { msg.reaction = msg.reaction===r?null:r; saveChats(); renderMessages(code,type); picker.remove(); });
    picker.appendChild(span);
  });
  bwrap.appendChild(picker);
  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); }
    });
  }, 10);
}

// ─── ADD MESSAGE ──────────────────────────────────────────────────────────────
function addMessageToChat(code, msg) {
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
    showNotification(label, msg.text, code, chatType);
  }
}

function addSystemMessage(chatCode, text) {
  addMessageToChat(chatCode, { type: 'system', text, time: Date.now() });
}

// ─── SEND ─────────────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text  = input.value.trim();
  if (!text || !activeCode) return;
  const type = isImageUrl(text) ? 'image' : 'text';
  if (activeType === 'group') await sendGroupMessage(text, type);
  else { addMessageToChat(activeCode, { text, time: Date.now(), sent: true, read: true, type }); await pushToSupabase(activeCode, text, type); }
  input.value = ''; input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
}

// ─── GROUP MESSAGING ──────────────────────────────────────────────────────────
async function sendGroupMessage(text, type = 'text', extraData = {}) {
  const group = groups.find(g => g.id === activeCode);
  if (!group) return;
  const msg = { text, time: Date.now(), sent: true, read: true, type, senderCode: myUsername, senderName: myUsername, ...extraData };
  addMessageToChat(activeCode, msg);
  const promises = group.members.filter(m => m.code !== myUsername)
    .map(member => pushToSupabase(member.code, text, type, { groupId: group.id, senderCode: myUsername, senderName: myUsername, ...extraData }));
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

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
async function pushToSupabase(toCode, text, type = 'text', extra = {}) {
  try {
    const check = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?select=id&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'count=exact' } });
    const count = parseInt(check.headers.get('content-range')?.split('/')[1] || '0');
    if (count > SERVER_LIMIT) { toast('Server busy — try again shortly'); return; }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ from: myUsername, to: toCode, text, type, created_at: new Date().toISOString(), ...extra })
    });
    if (!res.ok) toast('Failed to send');
  } catch(e) { toast('Failed to send — check connection'); }
}

async function pollMessages() {
  if (!myUsername) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?to=eq.${myUsername}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    if (!res.ok) return;
    const rows = await res.json();
    if (!rows.length) return;
    const ids = [];
    rows.forEach(r => {
      ids.push(r.id);

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
          if (activeCode === username) renderAvatarEl(document.getElementById('chat-avatar'), username, contacts.find(c=>c.code===username)?.name||username, 36);
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
        addMessageToChat(r.groupId, { text: r.text, time: new Date(r.created_at).getTime(), sent: false, read: r.groupId===activeCode, type: r.type||'text', senderCode: r.senderCode, senderName: r.senderName, duration: r.duration });
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
      const silentTypes = ['read_receipt','code_change','avatar_update','username_update','story','story_view','story_delete'];
      if (silentTypes.includes(r.type)) return;
      if (!r.text) return;
      ensureContact(r.from);
      addMessageToChat(r.from, { text: r.text, time: new Date(r.created_at).getTime(), sent: false, read: r.from===activeCode, type: r.type||'text', duration: r.duration });
    });
    if (ids.length) {
      await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=in.(${ids.join(',')})`, {
        method: 'DELETE', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
    }
  } catch(e) {}
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

function sendStickerMsg(s) {
  if (!activeCode) return;
  if (activeType==='group') sendGroupMessage(s.url,'sticker');
  else { addMessageToChat(activeCode,{text:s.url,time:Date.now(),sent:true,read:true,type:'sticker'}); pushToSupabase(activeCode,s.url,'sticker'); }
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

function closeAllPanels() { document.getElementById('sticker-panel').classList.remove('open'); }

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
    contact.name = newName; saveContacts();
    renderContacts(document.getElementById('search').value);
    if (activeCode===contact.code) document.getElementById('chat-header-name').textContent = newName;
    document.getElementById('rename-modal').classList.remove('open');
    toast('Contact renamed');
  };
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────

// Welcome
document.getElementById('welcome-btn').addEventListener('click', async () => {
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
  await setUsername(val, true);
  await registerUsername(val);
  document.getElementById('welcome-screen').style.display = 'none';
  startApp();
});
document.getElementById('welcome-input').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('welcome-btn').click(); });
document.getElementById('welcome-input').addEventListener('input', () => {
  document.getElementById('welcome-hint').style.color = '#8e8e93';
  document.getElementById('welcome-hint').textContent = 'No spaces. Letters, numbers and _ only.';
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
document.getElementById('settings-remove-account').addEventListener('click', () => {
  document.getElementById('settings-overlay').classList.remove('open');
  const countdown  = document.getElementById('remove-account-countdown');
  const confirmBtn = document.getElementById('remove-account-confirm');
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
  await releaseUsername(myUsername);
  localStorage.clear();
  window.location.reload();
});

document.getElementById('settings-btn').addEventListener('click', () => {
  try { document.getElementById('settings-username-val').textContent = '@' + myUsername; } catch(e) {}
  try { updateMyAvatarUI(); } catch(e) {}
  try { updateNotificationToggleUI(); } catch(e) {}
  try {
    const removeStoryBtn = document.getElementById('settings-remove-story');
    if (removeStoryBtn) removeStoryBtn.style.display = myStory ? 'block' : 'none';
  } catch(e) {}
  document.getElementById('settings-overlay').classList.add('open');
});
document.getElementById('settings-close').addEventListener('click', () => document.getElementById('settings-overlay').classList.remove('open'));
document.getElementById('settings-overlay').addEventListener('click', e => { if(e.target===document.getElementById('settings-overlay')) document.getElementById('settings-overlay').classList.remove('open'); });

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
  contacts.push({name,code}); saveContacts(); renderContacts();
  document.getElementById('modal').classList.remove('open');
  toast(`${name} added`); openChat(code);
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
document.getElementById('image-btn').addEventListener('click', ()=>{closeAllPanels();document.getElementById('image-file-input').click();});
document.getElementById('image-file-input').addEventListener('change', async e=>{
  const file=e.target.files[0];e.target.value='';
  if(!file||!activeCode)return;
  toast('Compressing...');
  try{
    const base64=await compressImage(file);
    const sizeKB=Math.round((base64.length*3/4)/1024);
    if(activeType==='group') await sendGroupMessage(base64,'image');
    else{addMessageToChat(activeCode,{text:base64,time:Date.now(),sent:true,read:true,type:'image'});await pushToSupabase(activeCode,base64,'image');}
    toast(`Sent · ${sizeKB}KB`);
  }catch(err){toast('Failed to compress image');}
});

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
