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
let myAvatar         = '';  // own profile pic base64
let avatars          = {};  // { username: base64 }
let notificationsOn  = true; // user preference
let contacts         = [];   // [{name, code}] where code = their username
let chats            = {};   // keyed by username
let groups           = [];
let activeCode       = null;
let activeType       = 'dm';
let stickerData      = [];
let activeStickerCat = 'favourites';
let favStickers      = [];
let customStickers   = [];
let editMode         = false;
let selectedContacts = new Set();

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

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  myUsername = ls('myUsername') || '';

  // Migration: if old random code exists but no username yet, retire it
  const oldCode = ls('myCode');
  if (oldCode && !myUsername) {
    // Has old random code — show welcome, old code is retired
    ls('myCode', '');
  }

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
  notificationsOn = ls('notificationsOn') !== 'false';
  updateMyAvatarUI();
  cleanExpiredImages();
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

// ─── SET USERNAME (first time or change) ──────────────────────────────────────
async function setUsername(newUsername, isFirstTime = false) {
  const oldUsername = myUsername;
  myUsername = newUsername;
  ls('myUsername', myUsername);
  document.getElementById('my-username-display').textContent = myUsername;

  if (!isFirstTime && oldUsername) {
    // Broadcast code change to all contacts silently
    // They receive this, update our entry in their contacts, chat history moves
    const payload = JSON.stringify({ oldCode: oldUsername, newCode: newUsername, username: newUsername });
    const promises = contacts.map(c => pushToSupabase(c.code, payload, 'code_change'));
    await Promise.all(promises);

    // System message in each DM
    contacts.forEach(c => addSystemMessage(c.code, `You changed your username to ${newUsername}`));
    groups.forEach(g => addSystemMessage(g.id, `You changed your username to ${newUsername}`));
  }
}

// ─── AVATAR ──────────────────────────────────────────────────────────────────
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
    // ensure color class present
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
    // Broadcast to all contacts silently
    const payload = JSON.stringify({ username: myUsername, avatar: base64 });
    contacts.forEach(c => pushToSupabase(c.code, payload, 'avatar_update'));
    toast('Profile picture updated');
    // Re-render open chat header if needed
    if (activeCode && activeType === 'dm') {
      const contact = contacts.find(c => c.code === activeCode);
      if (!contact) renderAvatarEl(document.getElementById('chat-avatar'), myUsername, myUsername, 36);
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
  // Don't notify if chat is already open and tab is focused
  if (document.hasFocus() && chatCode === activeCode) return;

  let preview = text;
  if (text?.startsWith('data:')) preview = '🖼 Image';
  else if (text?.length > 60) preview = text.slice(0, 60) + '…';

  const n = new Notification(`Blink — ${senderName}`, {
    body: preview || 'New message',
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%232563eb"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%232563eb"><circle cx="12" cy="12" r="10"/></svg>',
    silent: false
  });

  n.onclick = () => {
    window.focus();
    if (chatType === 'group') openGroup(chatCode);
    else openChat(chatCode);
    n.close();
  };

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
      else if (last.type === 'group_invite') preview = '👥 Group invite';
      else preview = (last.sent ? 'You: ' : (last.senderName ? last.senderName + ': ' : '')) + last.text;
    }

    const div = document.createElement('div');
    div.className = 'contact-item' + (isActive ? ' active' : '') + (isSelected ? ' selected' : '');

    const avatarHtml = type === 'group'
      ? `<div class="avatar group-avatar">${groupAvatarSVG(avatarColor(data.id))}</div>`
      : `<div class="avatar ${getAvatar(data.code) ? 'avatar-img' : avatarColor(data.code)}" data-username="${data.code}">${getAvatar(data.code) ? `<img src="${getAvatar(data.code)}" style="width:44px;height:44px;border-radius:50%;object-fit:cover;display:block;">` : avatarLetter(data.name)}</div>`;

    if (editMode) {
      div.innerHTML = `
        <div class="select-circle ${isSelected ? 'checked' : ''}"></div>
        ${avatarHtml}
        <div class="contact-info">
          <div class="contact-name">${escHtml(data.name)}</div>
          <div class="contact-preview">${escHtml(preview)}</div>
        </div>`;
      div.addEventListener('click', () => toggleSelectContact(id));
    } else {
      div.innerHTML = `
        ${avatarHtml}
        <div class="contact-info">
          <div class="contact-name">${escHtml(data.name)}</div>
          <div class="contact-preview">${escHtml(preview)}</div>
        </div>
        <div class="contact-meta">
          ${last ? `<div class="contact-time">${formatTime(last.time)}</div>` : ''}
          ${unread > 0 ? `<div class="unread-badge">${unread}</div>` : ''}
        </div>`;
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
  // no auto-focus
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
  // no auto-focus
}

// ─── RENDER MESSAGES ──────────────────────────────────────────────────────────
function renderMessages(code, type = 'dm') {
  const wrap = document.getElementById('messages-wrap');
  wrap.innerHTML = '';
  const msgs = chats[code] || [];
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

    // System message
    if (m.type === 'system') {
      const sys = document.createElement('div');
      sys.className = 'system-msg';
      sys.textContent = m.text;
      wrap.appendChild(sys);
      return;
    }

    // Group invite card
    if (m.type === 'group_invite') {
      const card = document.createElement('div');
      card.className = 'invite-card';
      const alreadyJoined = groups.find(g => g.id === m.groupId);
      card.innerHTML = `
        <div class="invite-icon">👥</div>
        <div class="invite-info">
          <div class="invite-title">${escHtml(m.groupName)}</div>
          <div class="invite-sub">Group invite from ${escHtml(m.invitedByName)}</div>
        </div>
        ${alreadyJoined
          ? `<div class="invite-joined">Joined</div>`
          : `<button class="invite-btn">Join</button>`}`;
      if (!alreadyJoined) card.querySelector('.invite-btn').addEventListener('click', () => joinGroup(m));
      wrap.appendChild(card);
      return;
    }

    const row   = document.createElement('div');
    row.className = 'msg-row ' + (m.sent ? 'sent' : 'received');
    const bwrap = document.createElement('div');
    bwrap.className = 'bubble-wrap';

    // Sender name in group
    if (type === 'group' && !m.sent && m.senderName) {
      const nameLabel = document.createElement('div');
      nameLabel.className = 'sender-name';
      nameLabel.textContent = m.senderName;
      nameLabel.style.color = `hsl(${hashColor(m.senderCode||'')}, 65%, 55%)`;
      bwrap.appendChild(nameLabel);
    }

    const bubble = document.createElement('div');
    if (m.type === 'sticker') {
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
    row.appendChild(bwrap);

    let pressTimer;
    bubble.addEventListener('mousedown',   () => { pressTimer = setTimeout(() => showReactionPicker(row, bwrap, m, code, type), 500); });
    bubble.addEventListener('mouseup',     () => clearTimeout(pressTimer));
    bubble.addEventListener('mouseleave',  () => clearTimeout(pressTimer));
    bubble.addEventListener('touchstart',  () => { pressTimer = setTimeout(() => showReactionPicker(row, bwrap, m, code, type), 500); }, { passive: true });
    bubble.addEventListener('touchend',    () => clearTimeout(pressTimer));
    bubble.addEventListener('contextmenu', e  => { e.preventDefault(); showReactionPicker(row, bwrap, m, code, type); });

    wrap.appendChild(row);
  });

  wrap.scrollTop = wrap.scrollHeight;
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
    span.addEventListener('click', () => { msg.reaction = msg.reaction === r ? null : r; saveChats(); renderMessages(code, type); picker.remove(); });
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

  // Show notification for incoming non-system messages
  if (!msg.sent && msg.type !== 'system' && msg.type !== 'code_change' && msg.type !== 'avatar_update') {
    const isGroup   = groups.find(g => g.id === code);
    const contact   = contacts.find(c => c.code === code);
    const sender    = msg.senderName || contact?.name || code;
    const chatType  = isGroup ? 'group' : 'dm';
    const chatName  = isGroup ? isGroup.name : (contact?.name || code);
    const label     = isGroup ? `${sender} in ${chatName}` : chatName;
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
  if (activeType === 'group') {
    await sendGroupMessage(text, type);
  } else {
    addMessageToChat(activeCode, { text, time: Date.now(), sent: true, read: true, type });
    await pushToSupabase(activeCode, text, type);
  }
  input.value = ''; input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
}

// ─── GROUP MESSAGING ──────────────────────────────────────────────────────────
async function sendGroupMessage(text, type = 'text', extraData = {}) {
  const group = groups.find(g => g.id === activeCode);
  if (!group) return;
  const msg = { text, time: Date.now(), sent: true, read: true, type, senderCode: myUsername, senderName: myUsername, ...extraData };
  addMessageToChat(activeCode, msg);
  const promises = group.members
    .filter(m => m.code !== myUsername)
    .map(member => pushToSupabase(member.code, text, type, { groupId: group.id, senderCode: myUsername, senderName: myUsername, ...extraData }));
  await Promise.all(promises);
}

// ─── CREATE GROUP ─────────────────────────────────────────────────────────────
async function createGroup(name, memberCodes) {
  const groupId = 'grp_' + myUsername + '_' + Date.now();
  const members = [
    { code: myUsername, name: myUsername },
    ...memberCodes.map(code => ({ code, name: contacts.find(c => c.code === code)?.name || code }))
  ];
  const group = { id: groupId, name, members, createdBy: myUsername };
  groups.push(group); saveGroups();
  const invitePayload = JSON.stringify({ groupId, groupName: name, invitedByName: myUsername, members });
  await Promise.all(memberCodes.map(code => pushToSupabase(code, invitePayload, 'group_invite')));
  openGroup(groupId);
  toast(`Group "${name}" created`);
}

// ─── JOIN GROUP ───────────────────────────────────────────────────────────────
function joinGroup(invite) {
  if (groups.find(g => g.id === invite.groupId)) { toast('Already in this group'); return; }
  const group = { id: invite.groupId, name: invite.groupName, members: invite.members || [], createdBy: invite.invitedByCode || '' };
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

      // ── Avatar update ──
      if (r.type === 'avatar_update') {
        try {
          const { username, avatar } = JSON.parse(r.text);
          avatars[username] = avatar;
          saveAvatars();
          renderContacts(document.getElementById('search').value);
          if (activeCode === username) {
            renderAvatarEl(document.getElementById('chat-avatar'), username, contacts.find(c=>c.code===username)?.name||username, 36);
          }
        } catch(e) {}
        return;
      }

      // ── Code change: silent, update contact entry and migrate chat history ──
      if (r.type === 'code_change') {
        try {
          const { oldCode, newCode, username } = JSON.parse(r.text);
          const contact = contacts.find(c => c.code === oldCode);
          if (contact) {
            // Migrate chat history to new code
            if (chats[oldCode]) {
              chats[newCode] = chats[oldCode];
              delete chats[oldCode];
            }
            contact.code = newCode;
            contact.name = username;
            saveContacts(); saveChats();
            addSystemMessage(newCode, `${oldCode} is now @${newCode}`);
            renderContacts(document.getElementById('search').value);
            if (activeCode === oldCode) openChat(newCode);
          }
        } catch(e) {}
        return;
      }

      // ── Group message ──
      if (r.groupId) {
        const group = groups.find(g => g.id === r.groupId);
        if (!group) return;
        addMessageToChat(r.groupId, {
          text: r.text, time: new Date(r.created_at).getTime(),
          sent: false, read: r.groupId === activeCode,
          type: r.type || 'text', senderCode: r.senderCode, senderName: r.senderName
        });
        return;
      }

      // ── Group invite ──
      if (r.type === 'group_invite') {
        // Auto-add sender as contact if unknown
        ensureContact(r.from);
        try {
          const invite = JSON.parse(r.text);
          addMessageToChat(r.from, {
            text: r.text, time: new Date(r.created_at).getTime(),
            sent: false, read: r.from === activeCode,
            type: 'group_invite', groupId: invite.groupId, groupName: invite.groupName,
            invitedByName: invite.invitedByName, invitedByCode: r.from, members: invite.members
          });
        } catch(e) {}
        return;
      }

      // ── Regular DM — works even if sender is not in contacts ──
      ensureContact(r.from);
      addMessageToChat(r.from, {
        text: r.text, time: new Date(r.created_at).getTime(),
        sent: false, read: r.from === activeCode, type: r.type || 'text'
      });
    });

    if (ids.length) {
      await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=in.(${ids.join(',')})`, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
    }
  } catch(e) {}
}

// Auto-add unknown sender as contact using their username as name
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
    tab.className = 'sticker-tab' + (activeStickerCat === cat.id ? ' active' : '');
    tab.textContent = cat.name; tab.dataset.cat = cat.id;
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
  document.getElementById('create-sticker-btn').style.display = catId === 'custom' ? 'flex' : 'none';
  const stickers = catId === 'favourites' ? favStickers : catId === 'custom' ? customStickers : (stickerData.find(c => c.id === catId)?.stickers || []);
  if (!stickers.length) {
    const msg = catId === 'favourites' ? 'Hover a sticker and click ★ to favourite it'
              : catId === 'custom'     ? 'Tap "+ Create" to make your own stickers' : 'No stickers';
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#8e8e93;font-size:13px;padding:24px">${msg}</div>`;
    return;
  }
  stickers.forEach(s => {
    const item = document.createElement('div');
    item.className = 'sticker-item';
    const isFav = favStickers.some(f => f.id === s.id);
    if (catId === 'custom') {
      item.innerHTML = `<img src="${s.url}" alt="${s.name}" loading="lazy"><button class="sticker-fav-btn active" style="color:#ff453a" title="Delete">✕</button>`;
      item.querySelector('img').addEventListener('click', () => sendStickerMsg(s));
      item.querySelector('.sticker-fav-btn').addEventListener('click', e => {
        e.stopPropagation();
        customStickers = customStickers.filter(cs => cs.id !== s.id);
        favStickers    = favStickers.filter(f => f.id !== s.id);
        saveCustomStickers(); saveFavStickers(); renderStickerGrid('custom'); toast('Sticker deleted');
      });
    } else {
      item.innerHTML = `<img src="${s.url}" alt="${s.name}" loading="lazy"><button class="sticker-fav-btn ${isFav?'active':''}" title="${isFav?'Remove':'Favourite'}">★</button>`;
      item.querySelector('img').addEventListener('click', () => sendStickerMsg(s));
      item.querySelector('.sticker-fav-btn').addEventListener('click', e => {
        e.stopPropagation();
        const idx = favStickers.findIndex(f => f.id === s.id);
        if (idx === -1) { favStickers.push(s); toast(`${s.name} added to favourites`); }
        else { favStickers.splice(idx, 1); toast('Removed from favourites'); }
        saveFavStickers(); renderStickerGrid(activeStickerCat);
      });
    }
    grid.appendChild(item);
  });
}

function sendStickerMsg(s) {
  if (!activeCode) return;
  if (activeType === 'group') sendGroupMessage(s.url, 'sticker');
  else { addMessageToChat(activeCode, { text: s.url, time: Date.now(), sent: true, read: true, type: 'sticker' }); pushToSupabase(activeCode, s.url, 'sticker'); }
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

// ─── PANELS ───────────────────────────────────────────────────────────────────
function closeAllPanels() { document.getElementById('sticker-panel').classList.remove('open'); }

// ─── STORAGE ──────────────────────────────────────────────────────────────────
function enforceStorageLimit(code) {
  if (chats[code]?.length > 500) chats[code] = chats[code].slice(-500);
  try {
    const used = new Blob([JSON.stringify(chats)]).size;
    if (used > 4 * 1024 * 1024) Object.keys(chats).forEach(k => { if (chats[k].length > 50) chats[k] = chats[k].slice(-50); });
  } catch(e) {}
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function isImageUrl(url) { if (!url) return false; return /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?.*)?$/i.test(url.trim()); }
function formatTime(ts) {
  const d = new Date(ts), now = new Date(), diff = now - d;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return Math.floor(diff/60000)+'m';
  if (d.toDateString()===now.toDateString()) return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString([],{month:'short',day:'numeric'});
}
function formatDateLabel(d) {
  const now = new Date();
  if (d.toDateString()===now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(y.getDate()-1);
  if (d.toDateString()===y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});
}
function escHtml(t) { if(!t) return ''; return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
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
    if (activeCode === contact.code) document.getElementById('chat-header-name').textContent = newName;
    document.getElementById('rename-modal').classList.remove('open');
    toast('Contact renamed');
  };
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────

// Welcome screen
document.getElementById('welcome-btn').addEventListener('click', async () => {
  const val = document.getElementById('welcome-input').value.trim();
  if (!validateUsername(val)) {
    document.getElementById('welcome-hint').style.color = '#ff453a';
    document.getElementById('welcome-hint').textContent = 'Letters, numbers and _ only. No spaces.';
    return;
  }
  await setUsername(val, true);
  document.getElementById('welcome-screen').style.display = 'none';
  startApp();
});
document.getElementById('welcome-input').addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('welcome-btn').click(); });
document.getElementById('welcome-input').addEventListener('input', () => {
  document.getElementById('welcome-hint').style.color = '#8e8e93';
  document.getElementById('welcome-hint').textContent = 'No spaces. Letters, numbers and _ only.';
});

// Lightbox
document.getElementById('lightbox').addEventListener('click', e => { if (e.target===document.getElementById('lightbox')) closeLightbox(); });
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.addEventListener('keydown', e => { if (e.key==='Escape') { closeLightbox(); document.getElementById('settings-panel').classList.remove('open'); } });

document.getElementById('settings-upload-avatar').addEventListener('click', () => document.getElementById('avatar-file-input').click());
document.getElementById('avatar-file-input').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  await setProfilePicture(file);
  document.getElementById('settings-panel').classList.remove('open');
});
document.getElementById('settings-remove-avatar').addEventListener('click', () => {
  removeProfilePicture();
  document.getElementById('settings-panel').classList.remove('open');
});

// Settings button
document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('settings-username-val').textContent = '@' + myUsername;
  updateMyAvatarUI();
  updateNotificationToggleUI();
  document.getElementById('settings-panel').classList.toggle('open');
});

document.getElementById('notif-toggle').addEventListener('change', async e => {
  if (e.target.checked) {
    const granted = await requestNotificationPermission();
    if (!granted) {
      e.target.checked = false;
      toast('Notifications blocked — check browser settings');
      updateNotificationToggleUI();
      return;
    }
    notificationsOn = true;
  } else {
    notificationsOn = false;
  }
  ls('notificationsOn', String(notificationsOn));
  updateNotificationToggleUI();
  toast('Notifications ' + (notificationsOn ? 'on' : 'off'));
});
document.getElementById('settings-close').addEventListener('click', () => document.getElementById('settings-panel').classList.remove('open'));
document.getElementById('settings-change-username').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('open');
  document.getElementById('username-input').value = myUsername;
  document.getElementById('username-modal').classList.add('open');
  document.getElementById('username-input').focus();
});

// Username modal
document.getElementById('username-cancel').addEventListener('click', () => document.getElementById('username-modal').classList.remove('open'));
document.getElementById('username-modal').addEventListener('click', e => { if (e.target===document.getElementById('username-modal')) document.getElementById('username-modal').classList.remove('open'); });
document.getElementById('username-confirm').addEventListener('click', async () => {
  const val = document.getElementById('username-input').value.trim();
  if (!validateUsername(val)) { toast('Invalid — letters, numbers and _ only'); return; }
  if (val === myUsername) { document.getElementById('username-modal').classList.remove('open'); return; }
  document.getElementById('username-modal').classList.remove('open');
  await setUsername(val, false);
  toast('Username updated — reshare your new @' + val);
});
document.getElementById('username-input').addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('username-confirm').click(); });

// Code bar (copy)
document.getElementById('my-code-bar').addEventListener('click', () => {
  navigator.clipboard?.writeText(myUsername).then(() => toast('@' + myUsername + ' copied!')).catch(() => toast('@' + myUsername));
});

// Edit mode
document.getElementById('edit-btn').addEventListener('click', toggleEditMode);
document.getElementById('edit-mark-read').addEventListener('click', () => {
  selectedContacts.forEach(id => { if (chats[id]) chats[id].forEach(m => { if (!m.sent) m.read = true; }); });
  saveChats(); selectedContacts.clear();
  renderContacts(document.getElementById('search').value); updateEditActions(); toast('Marked as read');
});
document.getElementById('edit-rename').addEventListener('click', () => {
  const code = [...selectedContacts][0];
  const contact = contacts.find(c => c.code === code);
  if (contact) showRenameModal(contact);
});
document.getElementById('edit-delete').addEventListener('click', () => {
  const ids = [...selectedContacts];
  const names = ids.map(id => contacts.find(c=>c.code===id)?.name || groups.find(g=>g.id===id)?.name).filter(Boolean);
  document.getElementById('delete-name').textContent = names.join(', ');
  document.getElementById('delete-modal').classList.add('open');
  document.getElementById('delete-confirm').onclick = () => {
    ids.forEach(id => {
      contacts = contacts.filter(c => c.code !== id);
      groups   = groups.filter(g => g.id !== id);
      delete chats[id];
      if (ls('lastChat')===id) { ls('lastChat',''); ls('lastType','dm'); }
      if (activeCode===id) { activeCode=null; document.getElementById('empty-state').style.display='flex'; document.getElementById('chat-main').style.display='none'; if(isMobile()) showSidebar(); }
    });
    saveContacts(); saveGroups(); saveChats(); selectedContacts.clear();
    renderContacts(document.getElementById('search').value); updateEditActions();
    document.getElementById('delete-modal').classList.remove('open'); toggleEditMode();
    toast(`Deleted ${names.length} item${names.length>1?'s':''}`);
  };
});

// Rename modal
document.getElementById('rename-cancel').addEventListener('click', () => document.getElementById('rename-modal').classList.remove('open'));
document.getElementById('rename-modal').addEventListener('click', e => { if(e.target===document.getElementById('rename-modal')) document.getElementById('rename-modal').classList.remove('open'); });
document.getElementById('rename-input').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('rename-confirm').click(); });

// Delete modal
document.getElementById('delete-cancel').addEventListener('click', () => document.getElementById('delete-modal').classList.remove('open'));
document.getElementById('delete-modal').addEventListener('click', e => { if(e.target===document.getElementById('delete-modal')) document.getElementById('delete-modal').classList.remove('open'); });

// New contact
document.getElementById('new-contact-btn').addEventListener('click', () => {
  document.getElementById('contact-name-input').value=''; document.getElementById('contact-code-input').value='';
  document.getElementById('modal').classList.add('open'); document.getElementById('contact-name-input').focus();
});
document.getElementById('modal-cancel').addEventListener('click', () => document.getElementById('modal').classList.remove('open'));
document.getElementById('modal').addEventListener('click', e => { if(e.target===document.getElementById('modal')) document.getElementById('modal').classList.remove('open'); });
document.getElementById('modal-add').addEventListener('click', () => {
  const name = document.getElementById('contact-name-input').value.trim();
  const code = document.getElementById('contact-code-input').value.trim();
  if (!name||!code) { toast('Fill in both fields'); return; }
  if (code===myUsername) { toast("That's your own username"); return; }
  if (contacts.find(c=>c.code===code)) { toast('Contact already exists'); return; }
  contacts.push({name,code}); saveContacts(); renderContacts();
  document.getElementById('modal').classList.remove('open');
  toast(`${name} added`); openChat(code);
});

// New group
document.getElementById('new-group-btn').addEventListener('click', () => {
  const list = document.getElementById('group-member-list');
  list.innerHTML = '';
  if (!contacts.length) { list.innerHTML = '<div style="color:#8e8e93;font-size:13px;padding:8px 0">Add contacts first</div>'; }
  else {
    contacts.forEach(c => {
      const row = document.createElement('label');
      row.className = 'member-checkbox-row';
      row.innerHTML = `<input type="checkbox" value="${c.code}"><div class="avatar ${avatarColor(c.code)}" style="width:32px;height:32px;font-size:13px">${avatarLetter(c.name)}</div><span>${escHtml(c.name)}</span>`;
      list.appendChild(row);
    });
  }
  document.getElementById('group-name-input').value='';
  document.getElementById('group-modal').classList.add('open');
  document.getElementById('group-name-input').focus();
});
document.getElementById('group-modal-cancel').addEventListener('click', () => document.getElementById('group-modal').classList.remove('open'));
document.getElementById('group-modal').addEventListener('click', e => { if(e.target===document.getElementById('group-modal')) document.getElementById('group-modal').classList.remove('open'); });
document.getElementById('group-modal-create').addEventListener('click', async () => {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) { toast('Enter a group name'); return; }
  const checked = [...document.querySelectorAll('#group-member-list input:checked')].map(i=>i.value);
  if (!checked.length) { toast('Select at least one member'); return; }
  document.getElementById('group-modal').classList.remove('open');
  await createGroup(name, checked);
});

// Search
document.getElementById('search').addEventListener('input', e => renderContacts(e.target.value));

// Back
document.getElementById('back-btn').addEventListener('click', showSidebar);

// Image
document.getElementById('image-btn').addEventListener('click', () => { closeAllPanels(); document.getElementById('image-file-input').click(); });
document.getElementById('image-file-input').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value='';
  if (!file||!activeCode) return;
  toast('Compressing...');
  try {
    const base64 = await compressImage(file);
    const sizeKB = Math.round((base64.length*3/4)/1024);
    if (activeType==='group') await sendGroupMessage(base64,'image');
    else { addMessageToChat(activeCode,{text:base64,time:Date.now(),sent:true,read:true,type:'image'}); await pushToSupabase(activeCode,base64,'image'); }
    toast(`Sent · ${sizeKB}KB`);
  } catch(err) { toast('Failed to compress image'); }
});

// Stickers
document.getElementById('create-sticker-btn').addEventListener('click', () => document.getElementById('sticker-file-input').click());
document.getElementById('sticker-file-input').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value='';
  if (!file) return;
  toast('Creating sticker...');
  try {
    const base64 = await compressImage(file, MAX_STICKER_BYTES, 300, 0.7);
    const sizeKB = Math.round((base64.length*3/4)/1024);
    customStickers.push({id:'cs_'+Date.now(), name:'My Sticker', url:base64});
    saveCustomStickers(); activeStickerCat='custom';
    document.querySelectorAll('.sticker-tab').forEach(t=>t.classList.toggle('active',t.dataset.cat==='custom'));
    renderStickerGrid('custom'); toast(`Sticker created · ${sizeKB}KB`);
  } catch(err) { toast('Failed to create sticker'); }
});
document.getElementById('sticker-btn').addEventListener('click', () => {
  const sp = document.getElementById('sticker-panel');
  const wasOpen = sp.classList.contains('open');
  closeAllPanels(); if (!wasOpen) sp.classList.add('open');
});
document.addEventListener('click', e => { if (!e.target.closest('#input-area')) closeAllPanels(); });

// Msg input
const msgInput = document.getElementById('msg-input');
const sendBtn  = document.getElementById('send-btn');
msgInput.addEventListener('input', () => {
  sendBtn.disabled = !msgInput.value.trim();
  msgInput.style.height='auto';
  msgInput.style.height=Math.min(msgInput.scrollHeight,120)+'px';
});
msgInput.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!sendBtn.disabled)sendMessage();} });
sendBtn.addEventListener('click', sendMessage);

init();
