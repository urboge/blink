// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://gkrfiyalbjbgkjevmpod.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrcmZpeWFsYmpiZ2tqZXZtcG9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MjA0OTksImV4cCI6MjA5NzE5NjQ5OX0.TXLwbzyyPcjJCGNnDKdHhA_4t1J4MD5FZHxQapEz4gY';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const hdrs = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

const myUsername = localStorage.getItem('myUsername') || '';

let activeNote = null;
let activeTab  = 'browse';
let uploadMode = 'text';
let uploadFile = null;
let uploadFileType = null;
let searchDebounce = null;
let currentQuery = '';

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (!myUsername) {
    toast('Log into Blink first');
    setTimeout(() => window.location.href = 'blink.html', 1500);
    return;
  }
  // Load landing suggestions immediately
  loadSuggestions('browse');
  bindEvents();
  fetchStudyPayBalance();
});

function formatBP(n) {
  if (n >= 1e18) return (n / 1e18).toFixed(n % 1e18 === 0 ? 0 : 1).replace(/\.0$/, '') + 'q';
  if (n >= 1e15) return (n / 1e15).toFixed(n % 1e15 === 0 ? 0 : 1).replace(/\.0$/, '') + 'q';
  if (n >= 1e12) return (n / 1e12).toFixed(n % 1e12 === 0 ? 0 : 1).replace(/\.0$/, '') + 't';
  if (n >= 1e9)  return (n / 1e9 ).toFixed(n % 1e9  === 0 ? 0 : 1).replace(/\.0$/, '') + 'b';
  if (n >= 1e6)  return (n / 1e6 ).toFixed(n % 1e6  === 0 ? 0 : 1).replace(/\.0$/, '') + 'm';
  if (n >= 1e3)  return (n / 1e3 ).toFixed(n % 1e3  === 0 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

async function fetchStudyPayBalance() {
  if (!myUsername) return;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/balances?username=eq.${encodeURIComponent(myUsername)}&select=amount`,
      { headers: hdrs }
    );
    if (!res.ok) return;
    const rows = await res.json();
    const label = document.getElementById('study-pay-label');
    if (label) label.textContent = rows.length ? `BP ${formatBP(rows[0].amount)}` : 'BP —';
  } catch(e) {}
}

// ─── EVENTS ───────────────────────────────────────────────────────────────────
function bindEvents() {
  // Landing search
  document.getElementById('hero-search-btn').addEventListener('click', doSearch);
  document.getElementById('hero-search').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  document.getElementById('filter-subject').addEventListener('input', () => { if (inResults()) debounceResultsSearch(); });
  document.getElementById('filter-class').addEventListener('input', () => { if (inResults()) debounceResultsSearch(); });

  // Landing tabs
  document.querySelectorAll('.ltab').forEach(t => t.addEventListener('click', () => switchLandingTab(t.dataset.tab)));

  // Results inline search
  document.getElementById('results-search-input').addEventListener('input', debounceResultsSearch);
  document.getElementById('results-back').addEventListener('click', showLanding);

  // Upload
  document.getElementById('upload-btn').addEventListener('click', openUpload);
  document.getElementById('upload-close').addEventListener('click', closeUpload);
  document.getElementById('upload-cancel').addEventListener('click', closeUpload);
  document.getElementById('upload-overlay').addEventListener('click', e => { if (e.target.id === 'upload-overlay') closeUpload(); });
  document.getElementById('upload-submit').addEventListener('click', submitNote);
  document.querySelectorAll('.ctab').forEach(t => t.addEventListener('click', () => setUploadMode(t.dataset.mode)));
  document.getElementById('up-file').addEventListener('change', handleFileSelect);

  // My Notes
  document.getElementById('my-notes-btn').addEventListener('click', openMyNotes);
  document.getElementById('my-notes-close').addEventListener('click', closeMyNotes);
  document.getElementById('my-notes-overlay').addEventListener('click', e => { if (e.target.id === 'my-notes-overlay') closeMyNotes(); });

  // Detail actions
  document.getElementById('nd-delete-btn').addEventListener('click', deleteActiveNote);
  document.getElementById('like-btn').addEventListener('click', toggleLike);
  document.getElementById('qa-send').addEventListener('click', () => submitQuestion());
  document.getElementById('qa-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitQuestion(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeUpload(); closeMyNotes(); }
  });
}

// ─── LANDING / RESULTS VIEWS ──────────────────────────────────────────────────
function inResults() { return document.getElementById('results-view').style.display !== 'none'; }

function doSearch() {
  const q = document.getElementById('hero-search').value.trim();
  currentQuery = q;
  showResults(q);
}

function showResults(query) {
  document.getElementById('landing').style.display = 'none';
  document.getElementById('results-view').style.display = 'flex';
  document.getElementById('results-search-input').value = query;
  const sub = document.getElementById('filter-subject').value.trim();
  const cls = document.getElementById('filter-class').value.trim();
  const label = [query, sub, cls].filter(Boolean).join(' · ') || 'All notes';
  document.getElementById('results-label').textContent = label;
  loadResultsList(query);
}

function showLanding() {
  document.getElementById('results-view').style.display = 'none';
  document.getElementById('landing').style.display = 'flex';
  activeNote = null;
}

function debounceResultsSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    const q = document.getElementById('results-search-input').value.trim();
    loadResultsList(q);
  }, 300);
}

// ─── LANDING TABS ─────────────────────────────────────────────────────────────
function switchLandingTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.ltab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  loadSuggestions(tab);
}

// ─── LOAD SUGGESTIONS (landing cards) ─────────────────────────────────────────
async function loadSuggestions(tab) {
  const row = document.getElementById('suggestion-row');
  row.innerHTML = '<div class="empty-state-light">Loading...</div>';

  if (tab === 'following') {
    await loadFollowingSuggestions(row);
    return;
  }

  // Browse: load recent notes
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_study_notes`, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ query: '', limit_count: 8 })
    });
    const notes = res.ok ? await res.json() : [];
    if (!notes.length) { row.innerHTML = '<div class="empty-state-light">No notes yet.<br>Be the first to share!</div>'; return; }
    renderSuggestionCards(notes, row);
  } catch(e) {
    row.innerHTML = '<div class="empty-state-light">Could not load notes</div>';
  }
}

async function loadFollowingSuggestions(row) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/study_follows?follower=eq.${enc(myUsername)}&select=followee`, { headers: hdrs });
    const followed = res.ok ? (await res.json()).map(r => r.followee) : [];
    if (!followed.length) {
      row.innerHTML = '<div class="empty-state-light">You\'re not following anyone yet.<br>Open a note and tap Follow to see their uploads here.</div>';
      return;
    }
    const filter = followed.map(u => `username.eq.${enc(u)}`).join(',');
    const nr = await fetch(`${SUPABASE_URL}/rest/v1/study_notes?or=(${filter})&select=*&order=created_at.desc&limit=8`, { headers: hdrs });
    const notes = nr.ok ? await nr.json() : [];
    if (!notes.length) { row.innerHTML = '<div class="empty-state-light">No recent notes from people you follow.</div>'; return; }
    renderSuggestionCards(notes, row);
  } catch(e) {
    row.innerHTML = '<div class="empty-state-light">Could not load your feed</div>';
  }
}

function renderSuggestionCards(notes, container) {
  container.innerHTML = '';
  const icons = { text: '📝', image: '🖼️', pdf: '📄' };
  notes.forEach(note => {
    const card = document.createElement('div');
    card.className = 'suggestion-card';
    const days = Math.ceil((new Date(note.expires_at) - Date.now()) / 86400000);
    card.innerHTML = `
      <div class="sc-icon">${icons[note.file_type] || '📝'}</div>
      <div class="sc-info">
        <div class="sc-title">${esc(note.title)}</div>
        <div class="sc-meta">@${esc(note.username)} · ${days > 0 ? `${days}d left` : 'expiring soon'}</div>
      </div>
      <span class="sc-badge">${esc(note.subject)}</span>
      <span class="sc-badge purple">${esc(note.class_code)}</span>
      <div class="sc-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>
    `;
    card.addEventListener('click', () => {
      showResults('');
      setTimeout(() => openNote(note, null), 50);
    });
    container.appendChild(card);
  });
}

// ─── RESULTS LIST ─────────────────────────────────────────────────────────────
async function loadResultsList(query) {
  const list = document.getElementById('results-list');
  list.innerHTML = '<div style="padding:14px;font-size:13px;color:#a0a09a;">Searching...</div>';

  const sub = document.getElementById('filter-subject').value.trim();
  const cls = document.getElementById('filter-class').value.trim();
  const combined = [query, sub, cls].filter(Boolean).join(' ').trim();

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_study_notes`, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ query: combined, limit_count: 40 })
    });
    let notes = res.ok ? await res.json() : [];
    if (sub) notes = notes.filter(n => n.subject.toLowerCase().includes(sub.toLowerCase()));
    if (cls) notes = notes.filter(n => n.class_code.toLowerCase().includes(cls.toLowerCase()));
    renderResultsList(notes);
  } catch(e) {
    list.innerHTML = '<div style="padding:14px;font-size:13px;color:#a0a09a;">Search failed</div>';
  }
}

function renderResultsList(notes) {
  const list = document.getElementById('results-list');
  const icons = { text: '📝', image: '🖼️', pdf: '📄' };
  if (!notes.length) {
    list.innerHTML = '<div style="padding:14px;font-size:13px;color:#a0a09a;text-align:center;">No notes found</div>';
    return;
  }
  list.innerHTML = '';
  notes.forEach(note => {
    const row = document.createElement('div');
    row.className = 'note-row';
    if (activeNote?.id === note.id) row.classList.add('active');
    const days = Math.ceil((new Date(note.expires_at) - Date.now()) / 86400000);
    row.innerHTML = `
      <div class="note-row-icon">${icons[note.file_type] || '📝'}</div>
      <div class="note-row-info">
        <div class="note-row-title">${esc(note.title)}</div>
        <div class="note-row-meta">
          <span class="note-row-badge">${esc(note.subject)}</span>
          <span class="note-row-badge purple">${esc(note.class_code)}</span>
          <span class="note-row-expiry">${days > 0 ? days + 'd' : 'soon'}</span>
        </div>
      </div>
    `;
    row.addEventListener('click', () => openNote(note, row));
    list.appendChild(row);
  });
}

// ─── OPEN NOTE ────────────────────────────────────────────────────────────────
async function openNote(note, rowEl) {
  activeNote = note;
  document.querySelectorAll('.note-row').forEach(r => r.classList.remove('active'));
  if (rowEl) rowEl.classList.add('active');

  const isOwn = note.username === myUsername;
  const icons = { text: '📝', image: '🖼️', pdf: '📄' };

  document.getElementById('nd-badges').innerHTML = `
    <span class="nd-badge">${esc(note.subject)}</span>
    <span class="nd-badge purple">${esc(note.class_code)}</span>`;

  document.getElementById('nd-title').textContent = note.title;

  const days = Math.ceil((new Date(note.expires_at) - Date.now()) / 86400000);
  const expiry = days <= 0 ? 'Expiring soon' : days === 1 ? 'Expires tomorrow' : `Expires in ${days} days`;
  document.getElementById('nd-meta').innerHTML = `
    <span>${icons[note.file_type] || '📝'} @${esc(note.username)}</span>
    <span class="dot">·</span>
    <span>${expiry}</span>
    ${!isOwn ? `<button class="follow-btn" id="follow-btn">Follow</button>` : ''}`;

  const desc = document.getElementById('nd-description');
  desc.textContent = note.description || '';
  desc.style.display = note.description ? 'block' : 'none';

  const body = document.getElementById('nd-body');
  if (note.file_type === 'image' && note.file_data) {
    body.innerHTML = `<img src="${note.file_data}" alt="Note">`;
  } else if (note.file_type === 'pdf' && note.file_data) {
    body.innerHTML = `<a class="pdf-download" href="${note.file_data}" download="${esc(note.title)}.pdf">📄 Download PDF — ${esc(note.title)}</a>`;
  } else if (note.body_text) {
    body.innerHTML = `<div class="body-text">${esc(note.body_text)}</div>`;
  } else {
    body.innerHTML = '';
  }

  document.getElementById('nd-delete-btn').style.display = isOwn ? 'flex' : 'none';
  document.getElementById('detail-empty-state').style.display = 'none';
  document.getElementById('note-detail').style.display = 'block';

  if (!isOwn) setupFollow(note.username);
  setupLikes(note.id);
  setupDonate(note.username, isOwn);
  loadQA(note.id);
  loadRecs(note);
}

// ─── FOLLOW ───────────────────────────────────────────────────────────────────
async function setupFollow(username) {
  const btn = document.getElementById('follow-btn');
  if (!btn) return;
  let following = false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/study_follows?follower=eq.${enc(myUsername)}&followee=eq.${enc(username)}&select=follower`, { headers: hdrs });
    following = (await res.json()).length > 0;
  } catch(e) {}
  updateFollowBtn(btn, following);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if (following) {
        await fetch(`${SUPABASE_URL}/rest/v1/study_follows?follower=eq.${enc(myUsername)}&followee=eq.${enc(username)}`, { method: 'DELETE', headers: hdrs });
        following = false;
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/study_follows`, { method: 'POST', headers: { ...hdrs, 'Prefer': 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ follower: myUsername, followee: username }) });
        following = true;
      }
      updateFollowBtn(btn, following);
      toast(following ? `Following @${username}` : `Unfollowed @${username}`);
    } catch(e) { toast('Failed — try again'); }
    btn.disabled = false;
  });
}
function updateFollowBtn(btn, f) { btn.textContent = f ? 'Following' : 'Follow'; btn.classList.toggle('following', f); }

// ─── LIKES ────────────────────────────────────────────────────────────────────
async function setupLikes(noteId) {
  const btn = document.getElementById('like-btn');
  const countEl = document.getElementById('like-count');
  let liked = false, count = 0;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/study_note_likes?note_id=eq.${noteId}&select=username`, { headers: hdrs });
    const rows = await res.json();
    count = rows.length; liked = rows.some(r => r.username === myUsername);
  } catch(e) {}
  updateLike(btn, countEl, liked, count);
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (liked) {
        await fetch(`${SUPABASE_URL}/rest/v1/study_note_likes?note_id=eq.${noteId}&username=eq.${enc(myUsername)}`, { method: 'DELETE', headers: hdrs });
        liked = false; count--;
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/study_note_likes`, { method: 'POST', headers: { ...hdrs, 'Prefer': 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ note_id: noteId, username: myUsername }) });
        liked = true; count++;
      }
      updateLike(btn, countEl, liked, count);
    } catch(e) { toast('Failed'); }
    btn.disabled = false;
  };
}
function updateLike(btn, el, liked, count) {
  btn.classList.toggle('liked', liked);
  btn.querySelector('svg').setAttribute('fill', liked ? 'currentColor' : 'none');
  el.textContent = `${count} ${count === 1 ? 'like' : 'likes'}`;
}
function toggleLike() {} // handled by btn.onclick above

// ─── DONATE ───────────────────────────────────────────────────────────────────
function setupDonate(authorUsername, isOwn) {
  const row = document.getElementById('nd-donate-row');
  // Hide donate row when viewing your own note — can't tip yourself
  row.style.display = isOwn ? 'none' : 'flex';
  if (isOwn) return;

  document.querySelectorAll('.donate-btn').forEach(btn => {
    // Remove any previous listener by replacing the node
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
  });

  document.querySelectorAll('.donate-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const amount = parseInt(btn.dataset.amount);
      if (!confirm(`Send ${amount} BP to @${authorUsername} as a thank-you?`)) return;

      document.querySelectorAll('.donate-btn').forEach(b => b.disabled = true);

      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/transfer_currency`, {
          method: 'POST', headers: hdrs,
          body: JSON.stringify({
            sender_username: myUsername,
            recipient_username: authorUsername,
            transfer_amount: amount
          })
        });
        const result = await res.json();
        if (res.ok && result === 'Success') {
          toast(`Sent ${amount} BP to @${authorUsername} 💙`);
          fetchStudyPayBalance(); // refresh balance chip
        } else {
          toast(result?.message || result || 'Transfer failed — check your balance');
        }
      } catch(e) {
        toast('Connection error — try again');
      }

      document.querySelectorAll('.donate-btn').forEach(b => b.disabled = false);
    });
  });
}

// ─── Q&A ──────────────────────────────────────────────────────────────────────
async function loadQA(noteId) {
  const thread = document.getElementById('qa-thread');
  thread.innerHTML = '<div class="qa-empty">Loading...</div>';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/study_note_qa?note_id=eq.${noteId}&select=*&order=created_at.asc`, { headers: hdrs });
    const rows = res.ok ? await res.json() : [];
    const questions = rows.filter(r => !r.parent_id);
    const byParent = {};
    rows.filter(r => r.parent_id).forEach(a => { (byParent[a.parent_id] = byParent[a.parent_id] || []).push(a); });
    if (!questions.length) { thread.innerHTML = '<div class="qa-empty">No questions yet — ask the first one.</div>'; return; }
    thread.innerHTML = '';
    questions.forEach(q => {
      const el = document.createElement('div');
      el.className = 'qa-question';
      el.innerHTML = `
        <div class="qa-q-header"><span class="qa-author">@${esc(q.username)}</span><span class="qa-time">${fmtTime(q.created_at)}</span></div>
        <div class="qa-text">${esc(q.text)}</div>
        <div class="qa-answers"></div>
        <button class="qa-reply-btn">Reply</button>
        <div class="qa-reply-wrap">
          <input class="qa-reply-input" type="text" placeholder="Write an answer...">
          <button class="qa-reply-send">Send</button>
        </div>`;
      const answersEl = el.querySelector('.qa-answers');
      (byParent[q.id] || []).forEach(a => {
        const ae = document.createElement('div');
        ae.className = 'qa-answer';
        ae.innerHTML = `<div class="qa-q-header"><span class="qa-author">@${esc(a.username)}</span>${a.is_author ? '<span class="qa-author-badge">Author</span>' : ''}<span class="qa-time">${fmtTime(a.created_at)}</span></div><div class="qa-text">${esc(a.text)}</div>`;
        answersEl.appendChild(ae);
      });
      const rBtn = el.querySelector('.qa-reply-btn'), rWrap = el.querySelector('.qa-reply-wrap'), rInput = el.querySelector('.qa-reply-input');
      rBtn.addEventListener('click', () => { rWrap.style.display = rWrap.style.display === 'none' ? 'flex' : 'none'; if (rWrap.style.display === 'flex') rInput.focus(); });
      const sendReply = () => submitAnswer(noteId, q.id, rInput);
      el.querySelector('.qa-reply-send').addEventListener('click', sendReply);
      rInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendReply(); });
      thread.appendChild(el);
    });
  } catch(e) { thread.innerHTML = '<div class="qa-empty">Failed to load Q&A</div>'; }
}

async function submitQuestion() {
  const input = document.getElementById('qa-input');
  const text = input.value.trim();
  if (!text || !activeNote) return;
  document.getElementById('qa-send').disabled = true;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/study_note_qa`, { method: 'POST', headers: { ...hdrs, 'Prefer': 'return=minimal' }, body: JSON.stringify({ note_id: activeNote.id, username: myUsername, text }) });
    input.value = '';
    await loadQA(activeNote.id);
    if (activeNote.username !== myUsername) {
      const payload = JSON.stringify({ noteTitle: activeNote.title, question: text, from: myUsername });
      fetch(`${SUPABASE_URL}/rest/v1/messages`, { method: 'POST', headers: { ...hdrs, 'Prefer': 'return=minimal' }, body: JSON.stringify({ from: myUsername, to: activeNote.username, text: payload, type: 'study_question_notify' }) }).catch(() => {});
    }
  } catch(e) { toast('Failed — try again'); }
  document.getElementById('qa-send').disabled = false;
}

async function submitAnswer(noteId, parentId, inputEl) {
  const text = inputEl.value.trim();
  if (!text) return;
  const isAuthor = activeNote && activeNote.username === myUsername;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/study_note_qa`, { method: 'POST', headers: { ...hdrs, 'Prefer': 'return=minimal' }, body: JSON.stringify({ note_id: noteId, parent_id: parentId, username: myUsername, text, is_author: isAuthor }) });
    inputEl.value = '';
    await loadQA(noteId);
  } catch(e) { toast('Failed'); }
}

// ─── RECOMMENDATIONS ──────────────────────────────────────────────────────────
async function loadRecs(note) {
  const el = document.getElementById('recommendations');
  el.innerHTML = '';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_study_notes`, { method: 'POST', headers: hdrs, body: JSON.stringify({ query: `${note.subject} ${note.class_code}`, limit_count: 6 }) });
    let related = res.ok ? (await res.json()).filter(n => n.id !== note.id).slice(0, 4) : [];
    if (!related.length) return;
    el.innerHTML = `<h3>More for ${esc(note.subject)} · ${esc(note.class_code)}</h3><div id="recs-grid"></div>`;
    const grid = document.getElementById('recs-grid');
    related.forEach(r => {
      const card = document.createElement('div');
      card.className = 'rec-card';
      card.innerHTML = `<div><span class="note-row-badge">${esc(r.subject)}</span></div><div class="rec-title">${esc(r.title)}</div><div class="rec-author">@${esc(r.username)}</div>`;
      card.addEventListener('click', () => openNote(r, null));
      grid.appendChild(card);
    });
  } catch(e) {}
}

// ─── DELETE ───────────────────────────────────────────────────────────────────
async function deleteActiveNote() {
  if (!activeNote || activeNote.username !== myUsername) return;
  if (!confirm('Delete this note? This cannot be undone.')) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/study_notes?id=eq.${activeNote.id}&username=eq.${enc(myUsername)}`, { method: 'DELETE', headers: hdrs });
    toast('Note deleted');
    activeNote = null;
    document.getElementById('detail-empty-state').style.display = 'flex';
    document.getElementById('note-detail').style.display = 'none';
    loadResultsList(document.getElementById('results-search-input').value.trim());
    loadSuggestions(activeTab);
  } catch(e) { toast('Failed to delete'); }
}

// ─── MY NOTES ─────────────────────────────────────────────────────────────────
function openMyNotes() { document.getElementById('my-notes-overlay').classList.add('open'); loadMyNotes(); }
function closeMyNotes() { document.getElementById('my-notes-overlay').classList.remove('open'); }

async function loadMyNotes() {
  const list = document.getElementById('my-notes-list');
  list.innerHTML = '<div style="padding:12px;font-size:13px;color:#a0a09a;">Loading...</div>';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/study_notes?username=eq.${enc(myUsername)}&select=*&order=created_at.desc`, { headers: hdrs });
    const notes = res.ok ? await res.json() : [];
    if (!notes.length) { list.innerHTML = '<div style="padding:14px;font-size:13px;color:#a0a09a;text-align:center;">You haven\'t shared any notes yet.</div>'; return; }
    list.innerHTML = '';
    notes.forEach(note => {
      const item = document.createElement('div');
      item.className = 'mn-item';
      const days = Math.ceil((new Date(note.expires_at) - Date.now()) / 86400000);
      item.innerHTML = `
        <div class="mn-info">
          <div class="mn-title">${esc(note.title)}</div>
          <div class="mn-meta">${esc(note.subject)} · ${esc(note.class_code)} · ${days > 0 ? days + 'd left' : 'expiring soon'}</div>
        </div>
        <button class="mn-del" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>`;
      item.addEventListener('click', e => {
        if (e.target.closest('.mn-del')) return;
        closeMyNotes();
        if (!inResults()) showResults('');
        setTimeout(() => openNote(note, null), 50);
      });
      item.querySelector('.mn-del').addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Delete this note?')) return;
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/study_notes?id=eq.${note.id}&username=eq.${enc(myUsername)}`, { method: 'DELETE', headers: hdrs });
          toast('Note deleted');
          if (activeNote?.id === note.id) { activeNote = null; document.getElementById('detail-empty-state').style.display = 'flex'; document.getElementById('note-detail').style.display = 'none'; }
          loadMyNotes();
          if (inResults()) loadResultsList(document.getElementById('results-search-input').value.trim());
          loadSuggestions(activeTab);
        } catch(e) { toast('Failed to delete'); }
      });
      list.appendChild(item);
    });
  } catch(e) { list.innerHTML = '<div style="padding:12px;font-size:13px;color:#a0a09a;">Failed to load</div>'; }
}

// ─── UPLOAD ───────────────────────────────────────────────────────────────────
function openUpload() {
  ['up-title','up-subject','up-class','up-description'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('up-body').value = '';
  document.getElementById('up-deadline').value = '';
  document.getElementById('up-file-preview').innerHTML = '';
  uploadFile = null; uploadFileType = null;
  setUploadMode('text');
  document.getElementById('upload-overlay').classList.add('open');
}
function closeUpload() { document.getElementById('upload-overlay').classList.remove('open'); }

function setUploadMode(mode) {
  uploadMode = mode;
  document.querySelectorAll('.ctab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  document.getElementById('up-body').style.display = mode === 'text' ? 'block' : 'none';
  if (mode !== 'text') {
    const fi = document.getElementById('up-file');
    fi.accept = mode === 'pdf' ? 'application/pdf' : 'image/*';
    fi.click();
  }
}

async function handleFileSelect(e) {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) { toast('File too large — max 4MB'); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    uploadFile = ev.target.result;
    uploadFileType = uploadMode;
    const preview = document.getElementById('up-file-preview');
    preview.innerHTML = uploadMode === 'image'
      ? `<img src="${uploadFile}" style="width:100%;border-radius:8px;margin-top:8px;">`
      : `<div class="file-chip">📄 ${esc(file.name)}</div>`;
  };
  reader.readAsDataURL(file);
}

async function submitNote() {
  const title = document.getElementById('up-title').value.trim();
  const subject = document.getElementById('up-subject').value.trim();
  const classCode = document.getElementById('up-class').value.trim();
  const deadline = document.getElementById('up-deadline').value || null;
  const desc = document.getElementById('up-description').value.trim();
  const bodyText = document.getElementById('up-body').value.trim();

  if (!title || !subject || !classCode) { toast('Title, subject, and class are required'); return; }
  if (uploadMode === 'text' && !bodyText) { toast('Write some notes first'); return; }
  if (uploadMode !== 'text' && !uploadFile) { toast('Choose a file first'); return; }

  const btn = document.getElementById('upload-submit');
  btn.disabled = true; btn.textContent = 'Posting...';

  const createdAt = new Date();
  let expiresAt = new Date(createdAt.getTime() + 14 * 86400000);
  if (deadline) {
    const dl2 = new Date(new Date(deadline).getTime() + 2 * 86400000);
    if (dl2 < expiresAt) expiresAt = dl2;
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/study_notes`, {
      method: 'POST', headers: { ...hdrs, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        username: myUsername, title, subject, class_code: classCode,
        description: desc || null,
        file_data: uploadMode !== 'text' ? uploadFile : null,
        file_type: uploadMode !== 'text' ? uploadFileType : 'text',
        body_text: uploadMode === 'text' ? bodyText : null,
        deadline, expires_at: expiresAt.toISOString()
      })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[submitNote] failed:', res.status, err);
      toast('Failed to post — see console');
    } else {
      toast('Notes posted!');
      closeUpload();
      loadSuggestions(activeTab);
      if (inResults()) loadResultsList(document.getElementById('results-search-input').value.trim());
    }
  } catch(e) { toast('Failed — check connection'); }
  btn.disabled = false; btn.textContent = 'Post Notes';
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function esc(t) { if (!t) return ''; return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function enc(t) { return encodeURIComponent(t); }

function fmtTime(isoStr) {
  const diff = Date.now() - new Date(isoStr);
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return new Date(isoStr).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}
