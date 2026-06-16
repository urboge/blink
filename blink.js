// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://gkrfiyalbjbgkjevmpod.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrcmZpeWFsYmpiZ2tqZXZtcG9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MjA0OTksImV4cCI6MjA5NzE5NjQ5OX0.TXLwbzyyPcjJCGNnDKdHhA_4t1J4MD5FZHxQapEz4gY';
const TABLE         = 'messages';
const POLL_INTERVAL = 3000;
const SERVER_LIMIT  = 500; // max undelivered messages before blocking sends

// ─── STATE ────────────────────────────────────────────────────────────────────
let myCode          = '';
let contacts        = [];
let chats           = {};
let activeCode      = null;
let stickerData     = [];
let activeStickerCat = 'favourites';
let favStickers     = [];

const REACTIONS     = ['👍','❤️','😂','😮','😢','🔥'];
const AVATAR_COLORS = ['av-blue','av-purple','av-pink','av-green','av-orange','av-teal'];
const isMobile      = () => window.innerWidth <= 640;

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  myCode      = ls('myCode') || generateCode();
  ls('myCode', myCode);
  document.getElementById('my-code-display').textContent = myCode;
  contacts    = JSON.parse(ls('contacts')    || '[]');
  chats       = JSON.parse(ls('chats')       || '{}');
  favStickers = JSON.parse(ls('favStickers') || '[]');
  renderContacts();
  await loadStickers();
  if (SUPABASE_URL && SUPABASE_KEY) setInterval(pollMessages, POLL_INTERVAL);

  // Reopen last chat
  const lastChat = ls('lastChat');
  if (lastChat && contacts.find(c => c.code === lastChat)) openChat(lastChat);
}

// ─── LOCALSTORAGE ─────────────────────────────────────────────────────────────
function ls(key, val) {
  if (val === undefined) return localStorage.getItem(key);
  localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
}
function saveContacts()    { ls('contacts',    JSON.stringify(contacts)); }
function saveChats()       { ls('chats',       JSON.stringify(chats)); }
function saveFavStickers() { ls('favStickers', JSON.stringify(favStickers)); }
function generateCode()    { return Math.random().toString(36).slice(2, 10); }

// ─── AVATAR ───────────────────────────────────────────────────────────────────
function avatarColor(code) {
  let n = 0; for (const c of code) n += c.charCodeAt(0);
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}
function avatarLetter(name) { return name.trim()[0].toUpperCase(); }

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

// ─── CONTACTS ─────────────────────────────────────────────────────────────────
function renderContacts(filter = '') {
  const list = document.getElementById('contacts-list');
  list.innerHTML = '';
  const filtered = contacts.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()));
  if (!filtered.length) {
    list.innerHTML = `<div style="text-align:center;color:#8e8e93;font-size:14px;padding:24px 16px;">No contacts yet</div>`;
    return;
  }
  filtered.forEach(c => {
    const msgs   = chats[c.code] || [];
    const last   = msgs[msgs.length - 1];
    const unread = msgs.filter(m => !m.sent && !m.read).length;
    const preview = last
      ? (last.type === 'sticker' ? '🎭 Sticker' : last.type === 'image' ? '🖼 Image' : (last.sent ? 'You: ' : '') + last.text)
      : 'No messages yet';
    const div = document.createElement('div');
    div.className = 'contact-item' + (c.code === activeCode ? ' active' : '');
    div.innerHTML = `
      <div class="avatar ${avatarColor(c.code)}">${avatarLetter(c.name)}</div>
      <div class="contact-info">
        <div class="contact-name">${c.name}</div>
        <div class="contact-preview">${preview}</div>
      </div>
      <div class="contact-meta">
        ${last ? `<div class="contact-time">${formatTime(last.time)}</div>` : ''}
        ${unread > 0 ? `<div class="unread-badge">${unread}</div>` : ''}
      </div>`;
    div.addEventListener('click', () => openChat(c.code));
    list.appendChild(div);
  });
}

// ─── OPEN CHAT ────────────────────────────────────────────────────────────────
function openChat(code) {
  activeCode = code;
  const contact = contacts.find(c => c.code === code);
  if (!contact) return;
  if (chats[code]) { chats[code].forEach(m => { if (!m.sent) m.read = true; }); saveChats(); }
  const av = document.getElementById('chat-avatar');
  av.className = 'avatar ' + avatarColor(code);
  av.textContent = avatarLetter(contact.name);
  document.getElementById('chat-header-name').textContent = contact.name;
  document.getElementById('chat-header-code').textContent = code;
  document.getElementById('empty-state').style.display = 'none';
  const cm = document.getElementById('chat-main');
  cm.style.display = 'flex'; cm.style.flex = '1';
  cm.style.flexDirection = 'column'; cm.style.overflow = 'hidden';
  ls('lastChat', code);
  renderMessages(code);
  renderContacts(document.getElementById('search').value);
  showChat();
  document.getElementById('msg-input').focus();
}

// ─── RENDER MESSAGES ──────────────────────────────────────────────────────────
function renderMessages(code) {
  const wrap = document.getElementById('messages-wrap');
  wrap.innerHTML = '';
  const msgs = chats[code] || [];
  let lastDate = null;
  msgs.forEach((m) => {
    const d = new Date(m.time);
    if (d.toDateString() !== lastDate) {
      const sep = document.createElement('div');
      sep.className = 'msg-time';
      sep.textContent = formatDateLabel(d);
      wrap.appendChild(sep);
      lastDate = d.toDateString();
    }
    const row   = document.createElement('div');
    row.className = 'msg-row ' + (m.sent ? 'sent' : 'received');

    const bwrap = document.createElement('div');
    bwrap.className = 'bubble-wrap';

    const bubble = document.createElement('div');
    if (m.type === 'sticker') {
      bubble.className = 'bubble sticker-bubble';
      bubble.innerHTML = `<img src="${m.text}" alt="sticker">`;
    } else if (m.type === 'image' || isImageUrl(m.text)) {
      bubble.className = 'bubble image-bubble';
      bubble.innerHTML = `<img src="${m.text}" alt="image" onclick="window.open('${m.text}','_blank')" onerror="this.parentElement.innerHTML='🖼 Image (failed to load)'">`;
    } else {
      bubble.className = 'bubble';
      bubble.innerHTML = escHtml(m.text);
    }

    if (m.reaction) {
      const badge = document.createElement('div');
      badge.className = 'reaction-badge';
      badge.textContent = m.reaction;
      badge.title = 'Click to remove';
      badge.addEventListener('click', () => { m.reaction = null; saveChats(); renderMessages(code); });
      bwrap.appendChild(badge);
    }

    bwrap.insertBefore(bubble, bwrap.firstChild);
    row.appendChild(bwrap);

    // Long press / right-click for reactions
    let pressTimer;
    bubble.addEventListener('mousedown',   () => { pressTimer = setTimeout(() => showReactionPicker(row, bwrap, m, code), 500); });
    bubble.addEventListener('mouseup',     () => clearTimeout(pressTimer));
    bubble.addEventListener('mouseleave',  () => clearTimeout(pressTimer));
    bubble.addEventListener('touchstart',  () => { pressTimer = setTimeout(() => showReactionPicker(row, bwrap, m, code), 500); }, { passive: true });
    bubble.addEventListener('touchend',    () => clearTimeout(pressTimer));
    bubble.addEventListener('contextmenu', e  => { e.preventDefault(); showReactionPicker(row, bwrap, m, code); });

    wrap.appendChild(row);
  });
  wrap.scrollTop = wrap.scrollHeight;
}

// ─── REACTION PICKER ──────────────────────────────────────────────────────────
function showReactionPicker(row, bwrap, msg, code) {
  document.querySelectorAll('.reaction-picker').forEach(p => p.remove());
  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  REACTIONS.forEach(r => {
    const span = document.createElement('span');
    span.textContent = r;
    span.addEventListener('click', () => {
      msg.reaction = msg.reaction === r ? null : r;
      saveChats(); renderMessages(code); picker.remove();
    });
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
  if (code === activeCode) renderMessages(code);
  renderContacts(document.getElementById('search').value);
}

// ─── SEND TEXT ────────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text  = input.value.trim();
  if (!text || !activeCode) return;
  const type = isImageUrl(text) ? 'image' : 'text';
  addMessageToChat(activeCode, { text, time: Date.now(), sent: true, read: true, type });
  input.value = ''; input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
  await pushToSupabase(activeCode, text, type);
}

// ─── SEND STICKER ─────────────────────────────────────────────────────────────
function sendSticker(s) {
  if (!activeCode) return;
  addMessageToChat(activeCode, { text: s.url, time: Date.now(), sent: true, read: true, type: 'sticker' });
  closeAllPanels();
  pushToSupabase(activeCode, s.url, 'sticker');
}

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
async function pushToSupabase(toCode, text, type = 'text') {
  try {
    // Check server load first
    const check = await fetch(
      `${SUPABASE_URL}/rest/v1/${TABLE}?select=id&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'count=exact' } }
    );
    const count = parseInt(check.headers.get('content-range')?.split('/')[1] || '0');
    if (count > SERVER_LIMIT) { toast('Server busy — try again shortly'); return; }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ from: myCode, to: toCode, text, type, created_at: new Date().toISOString() })
    });
    if (!res.ok) toast('Failed to send');
  } catch(e) { toast('Failed to send — check connection'); }
}

async function pollMessages() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${TABLE}?to=eq.${myCode}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) return;
    const rows = await res.json();
    if (!rows.length) return;
    const ids = [];
    rows.forEach(r => {
      const sender = contacts.find(c => c.code === r.from);
      if (!sender) { ids.push(r.id); return; }
      addMessageToChat(r.from, { text: r.text, time: new Date(r.created_at).getTime(), sent: false, read: r.from === activeCode, type: r.type || 'text' });
      ids.push(r.id);
    });
    if (ids.length) {
      await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=in.(${ids.join(',')})`, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
    }
  } catch(e) {}
}

// ─── STICKERS ─────────────────────────────────────────────────────────────────
async function loadStickers() {
  try {
    const res = await fetch('stickers.json');
    const data = await res.json();
    stickerData = data.categories;
    buildStickerTabs();
    renderStickerGrid('favourites');
  } catch(e) {}
}

function buildStickerTabs() {
  const tabs = document.getElementById('sticker-tabs');
  tabs.innerHTML = '';
  [{ id: 'favourites', name: '⭐ Favourites' }, ...stickerData].forEach(cat => {
    const tab = document.createElement('div');
    tab.className = 'sticker-tab' + (activeStickerCat === cat.id ? ' active' : '');
    tab.textContent = cat.name;
    tab.dataset.cat = cat.id;
    tab.addEventListener('click', () => {
      activeStickerCat = cat.id;
      document.querySelectorAll('.sticker-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === cat.id));
      renderStickerGrid(cat.id);
    });
    tabs.appendChild(tab);
  });
}

function renderStickerGrid(catId) {
  const grid = document.getElementById('sticker-grid');
  grid.innerHTML = '';
  const stickers = catId === 'favourites' ? favStickers : (stickerData.find(c => c.id === catId)?.stickers || []);
  if (!stickers.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#8e8e93;font-size:13px;padding:24px">
      ${catId === 'favourites' ? 'Hover a sticker and click ★ to favourite it' : 'No stickers'}
    </div>`;
    return;
  }
  stickers.forEach(s => {
    const item = document.createElement('div');
    item.className = 'sticker-item';
    const isFav = favStickers.some(f => f.id === s.id);
    item.innerHTML = `
      <img src="${s.url}" alt="${s.name}" loading="lazy">
      <button class="sticker-fav-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove' : 'Favourite'}">★</button>`;
    item.querySelector('img').addEventListener('click', () => sendSticker(s));
    item.querySelector('.sticker-fav-btn').addEventListener('click', e => {
      e.stopPropagation();
      const idx = favStickers.findIndex(f => f.id === s.id);
      if (idx === -1) { favStickers.push(s); toast(`${s.name} added to favourites`); }
      else { favStickers.splice(idx, 1); toast('Removed from favourites'); }
      saveFavStickers();
      renderStickerGrid(activeStickerCat);
    });
    grid.appendChild(item);
  });
}

// ─── PANELS ───────────────────────────────────────────────────────────────────
function closeAllPanels() {
  document.getElementById('image-panel').classList.remove('open');
  document.getElementById('sticker-panel').classList.remove('open');
}

// ─── STORAGE ──────────────────────────────────────────────────────────────────
function enforceStorageLimit(code) {
  if (chats[code]?.length > 500) chats[code] = chats[code].slice(-500);
  try {
    const used = new Blob([JSON.stringify(chats)]).size;
    if (used > 4 * 1024 * 1024) Object.keys(chats).forEach(k => { if (chats[k].length > 50) chats[k] = chats[k].slice(-50); });
  } catch(e) {}
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function isImageUrl(url) { return /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?.*)?$/i.test(url.trim()); }

function formatTime(ts) {
  const d = new Date(ts), now = new Date(), diff = now - d;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDateLabel(d) {
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function escHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────
document.getElementById('new-contact-btn').addEventListener('click', () => {
  document.getElementById('contact-name-input').value = '';
  document.getElementById('contact-code-input').value = '';
  document.getElementById('modal').classList.add('open');
  document.getElementById('contact-name-input').focus();
});
document.getElementById('modal-cancel').addEventListener('click', () => document.getElementById('modal').classList.remove('open'));
document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) document.getElementById('modal').classList.remove('open'); });
document.getElementById('modal-add').addEventListener('click', () => {
  const name = document.getElementById('contact-name-input').value.trim();
  const code = document.getElementById('contact-code-input').value.trim();
  if (!name || !code) { toast('Fill in both fields'); return; }
  if (code === myCode) { toast("That's your own code"); return; }
  if (contacts.find(c => c.code === code)) { toast('Contact already exists'); return; }
  contacts.push({ name, code }); saveContacts(); renderContacts();
  document.getElementById('modal').classList.remove('open');
  toast(`${name} added`); openChat(code);
});

document.getElementById('search').addEventListener('input', e => renderContacts(e.target.value));
document.getElementById('my-code-bar').addEventListener('click', () => {
  navigator.clipboard?.writeText(myCode).then(() => toast('Code copied!')).catch(() => toast('Your code: ' + myCode));
});
document.getElementById('back-btn').addEventListener('click', showSidebar);

document.getElementById('image-btn').addEventListener('click', () => {
  const ip = document.getElementById('image-panel');
  const wasOpen = ip.classList.contains('open');
  closeAllPanels();
  if (!wasOpen) { ip.classList.add('open'); document.getElementById('image-url-input').focus(); }
});

document.getElementById('sticker-btn').addEventListener('click', () => {
  const sp = document.getElementById('sticker-panel');
  const wasOpen = sp.classList.contains('open');
  closeAllPanels();
  if (!wasOpen) sp.classList.add('open');
});

document.getElementById('image-send-btn').addEventListener('click', () => {
  const url = document.getElementById('image-url-input').value.trim();
  if (!url) { toast('Paste an image URL first'); return; }
  if (!activeCode) return;
  addMessageToChat(activeCode, { text: url, time: Date.now(), sent: true, read: true, type: 'image' });
  document.getElementById('image-url-input').value = '';
  closeAllPanels();
  pushToSupabase(activeCode, url, 'image');
});

document.getElementById('image-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('image-send-btn').click();
});

document.addEventListener('click', e => {
  if (!e.target.closest('#input-area')) closeAllPanels();
});

const msgInput = document.getElementById('msg-input');
const sendBtn  = document.getElementById('send-btn');
msgInput.addEventListener('input', () => {
  sendBtn.disabled = !msgInput.value.trim();
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
});
msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) sendMessage(); }
});
sendBtn.addEventListener('click', sendMessage);

init();