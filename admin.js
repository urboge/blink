// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://gkrfiyalbjbgkjevmpod.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrcmZpeWFsYmpiZ2tqZXZtcG9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MjA0OTksImV4cCI6MjA5NzE5NjQ5OX0.TXLwbzyyPcjJCGNnDKdHhA_4t1J4MD5FZHxQapEz4gY';

// SHA-256 hash of the shared admin password — keeps the plaintext out of the
// page source, but this is still a client-side check, not real security.
// Default password is "Blink5323". To change it, hash a new password in any
// console with: crypto.subtle.digest('SHA-256', new TextEncoder().encode('newpw'))
//   .then(b => console.log(Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')))
const ADMIN_PASSWORD_HASH = 'ef8f2109e60c363ed869e954bc3b2650ec921b0d9a90cb4b9f76b87cb670f92b';

// Blink accounts allowed to access this page, checked directly against
// Blink's own localStorage (admin.html must be hosted in the same
// folder/origin as blink.html for this to see the same storage). The error
// message deliberately never reveals that this check exists or what it
// requires — wrong password and wrong account both show the same generic
// "incorrect password" message.
const ALLOWED_USERNAMES = ['timurs', 'test'];

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isAllowedDevice() {
  return ALLOWED_USERNAMES.includes(localStorage.getItem('myUsername'));
}

// ─── GATE (password + local account check) ────────────────────────────────────
document.getElementById('gate-btn').addEventListener('click', tryEnter);
document.getElementById('gate-input').addEventListener('keydown', e => { if (e.key === 'Enter') tryEnter(); });

async function tryEnter() {
  const password = document.getElementById('gate-input').value;
  const errorEl = document.getElementById('gate-error');
  errorEl.textContent = '';

  const hash = await sha256(password);
  // Same generic message whether the password was wrong or the account
  // isn't allowed — never hint that an account-based check exists at all.
  if (hash !== ADMIN_PASSWORD_HASH || !isAllowedDevice()) {
    errorEl.textContent = 'Incorrect password';
    return;
  }

  sessionStorage.setItem('blinkAdminUnlocked', 'true');
  document.getElementById('gate').style.display = 'none';
  document.getElementById('dashboard').classList.add('open');
  loadDashboard();
}

// Restore unlocked state if the page was refreshed within the same tab session
if (sessionStorage.getItem('blinkAdminUnlocked') === 'true' && isAllowedDevice()) {
  document.getElementById('gate').style.display = 'none';
  document.getElementById('dashboard').classList.add('open');
  loadDashboard();
}

document.getElementById('logout-btn').addEventListener('click', () => {
  sessionStorage.removeItem('blinkAdminUnlocked');
  document.getElementById('dashboard').classList.remove('open');
  document.getElementById('gate').style.display = 'flex';
  document.getElementById('gate-input').value = '';
});

// ─── DASHBOARD DATA ───────────────────────────────────────────────────────────
async function loadDashboard() {
  await Promise.all([loadStats(), loadConfig(), loadBlacklist()]);
}

document.getElementById('refresh-btn').addEventListener('click', loadDashboard);

async function loadStats() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/daily_stats?select=*&order=date.desc&limit=14`, { headers });
    const rows = res.ok ? await res.json() : [];

    const today = new Date().toISOString().slice(0, 10);
    const todayRow = rows.find(r => r.date === today) || { messages_sent: 0, active_users: 0, new_signups: 0 };

    // Quick aggregate over the loaded window
    const last7 = rows.slice(0, 7);
    const messages7d = last7.reduce((sum, r) => sum + (r.messages_sent || 0), 0);
    const activeUsers7d = last7.reduce((sum, r) => sum + (r.active_users || 0), 0);

    document.getElementById('today-stats').innerHTML = `
      <div class="stat-card">
        <div class="label">Messages Today</div>
        <div class="value">${todayRow.messages_sent || 0}</div>
      </div>
      <div class="stat-card">
        <div class="label">Active Users Today</div>
        <div class="value">${todayRow.active_users || 0}</div>
      </div>
      <div class="stat-card">
        <div class="label">New Signups Today</div>
        <div class="value">${todayRow.new_signups || 0}</div>
      </div>
      <div class="stat-card">
        <div class="label">Messages (7d)</div>
        <div class="value">${messages7d}</div>
        <div class="sub">~${Math.round(messages7d / 7)}/day avg</div>
      </div>
      <div class="stat-card">
        <div class="label">Active Users (7d)</div>
        <div class="value">${activeUsers7d}</div>
      </div>
    `;

    const tbody = document.getElementById('stats-tbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-note">No data yet — stats begin accumulating as people use the app.</td></tr>`;
    } else {
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td>${formatDate(r.date)}</td>
          <td>${r.messages_sent || 0}</td>
          <td>${r.active_users || 0}</td>
          <td>${r.new_signups || 0}</td>
        </tr>
      `).join('');
    }
  } catch(e) {
    document.getElementById('stats-tbody').innerHTML = `<tr><td colspan="4" class="empty-note">Failed to load stats: ${e.message}</td></tr>`;
  }
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ─── CONFIG / FEATURE FLAGS ───────────────────────────────────────────────────
const CONFIG_DEFINITIONS = [
  { key: 'maintenance_mode', label: 'Maintenance Mode', desc: 'Shows a maintenance screen to all users instead of the app.' },
  { key: 'disable_signups', label: 'Disable New Signups', desc: 'Prevents new accounts from being created. Existing accounts still work.' }
];

async function loadConfig() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_config?select=*`, { headers });
    const rows = res.ok ? await res.json() : [];
    const configMap = Object.fromEntries(rows.map(r => [r.key, r.value]));

    const list = document.getElementById('config-list');
    list.innerHTML = CONFIG_DEFINITIONS.map(def => `
      <div class="config-row">
        <div>
          <div class="config-label">${def.label}</div>
          <div class="config-desc">${def.desc}</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" data-key="${def.key}" ${configMap[def.key] === 'true' ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
    `).join('');

    list.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.addEventListener('change', () => setConfig(input.dataset.key, input.checked ? 'true' : 'false'));
    });

    document.getElementById('broadcast-input').value = configMap.broadcast_message || '';
  } catch(e) {
    document.getElementById('config-list').innerHTML = `<div class="empty-note">Failed to load settings: ${e.message}</div>`;
  }
}

async function setConfig(key, value) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_config`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      alert('Failed to save — your login may have expired. Try logging out and back in.\n' + errText);
    }
  } catch(e) { alert('Failed to save setting: ' + e.message); }
}

document.getElementById('broadcast-save').addEventListener('click', () => {
  const val = document.getElementById('broadcast-input').value.trim();
  setConfig('broadcast_message', val);
});

// ─── USERNAME BLACKLIST ───────────────────────────────────────────────────────
async function loadBlacklist() {
  const list = document.getElementById('blacklist-list');
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/username_blacklist?select=*&order=banned_at.desc`, { headers });
    const rows = res.ok ? await res.json() : [];
    console.log('[loadBlacklist] rows:', rows);

    if (!rows.length) {
      list.innerHTML = `<div class="empty-note">No blocked usernames.</div>`;
      return;
    }

    list.innerHTML = rows.map(r => `
      <div class="blacklist-row">
        <div class="blacklist-row-info">
          <div class="blacklist-username">@${escapeHtml(r.username)}</div>
          ${r.reason ? `<div class="blacklist-reason">${escapeHtml(r.reason)}</div>` : ''}
        </div>
        <button class="blacklist-remove-btn" data-username="${escapeHtml(r.username)}">Unblock</button>
      </div>
    `).join('');

    list.querySelectorAll('.blacklist-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => removeFromBlacklist(btn.dataset.username));
    });
  } catch(e) {
    list.innerHTML = `<div class="empty-note">Failed to load: ${e.message}</div>`;
  }
}

function escapeHtml(t) {
  if (!t) return '';
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

document.getElementById('blacklist-add-btn').addEventListener('click', async () => {
  const usernameInput = document.getElementById('blacklist-username-input');
  const reasonInput = document.getElementById('blacklist-reason-input');
  const username = usernameInput.value.trim().replace(/^@/, '');
  const reason = reasonInput.value.trim();

  if (!username) return;

  try {
    // Delete any existing entry for this username first, then insert fresh —
    // avoids any ambiguity around upsert/merge behavior silently dropping
    // the reason field on a re-block.
    await fetch(`${SUPABASE_URL}/rest/v1/username_blacklist?username=eq.${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers
    });

    const res = await fetch(`${SUPABASE_URL}/rest/v1/username_blacklist`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ username, reason: reason.length ? reason : null })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      alert('Failed to block user: ' + errText);
      return;
    }
    usernameInput.value = '';
    reasonInput.value = '';
    loadBlacklist();
  } catch(e) { alert('Failed to block user: ' + e.message); }
});

document.getElementById('blacklist-username-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('blacklist-add-btn').click();
});

async function removeFromBlacklist(username) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/username_blacklist?username=eq.${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers
    });
    loadBlacklist();
  } catch(e) { alert('Failed to unblock user: ' + e.message); }
}