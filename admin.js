// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://gkrfiyalbjbgkjevmpod.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmUiLCJyZWYiOiJna3JmaXlhbGJqYmdramV2bXBvZCIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNzgxNjIwNDk5LCJleHAiOjIwOTcxOTY0OTl9.TXLwbzyyPcjJCGNnDKdHhA_4t1J4MD5FZHxQapEz4gY';
const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

// The dashboard is opened only when the signed-in Supabase user has an admin
// row. RLS independently enforces this on every data request.
let adminUsername = '';
const gate = document.getElementById('gate');
const gateError = document.getElementById('gate-error');
const passwordChangePanel = document.getElementById('gate-password-change');
function showPasswordChange() {
  gateError.textContent = '';
  document.getElementById('gate-btn').style.display = 'none';
  passwordChangePanel.style.display = 'flex';
}
function showDashboard() {
  gate.style.display = 'none';
  document.getElementById('dashboard').classList.add('open');
  loadDashboard();
}
async function verifyAdmin() {
  const account = await BlinkAuth.account();
  const admin = await BlinkAuth.adminState();
  if (!account?.username || !admin) return false;
  adminUsername = account.username;
  if (admin.must_change_password) showPasswordChange();
  else showDashboard();
  return true;
}
document.getElementById('gate-btn').addEventListener('click', tryEnter);
document.getElementById('gate-input').addEventListener('keydown', e => { if (e.key === 'Enter') tryEnter(); });
document.getElementById('gate-username').addEventListener('keydown', e => { if (e.key === 'Enter') tryEnter(); });
async function tryEnter() {
  gateError.textContent = '';
  try {
    const username = document.getElementById('gate-username').value.trim();
    await BlinkAuth.signIn(username, document.getElementById('gate-input').value);
    if (!(await verifyAdmin())) {
      await BlinkAuth.signOut('local');
      throw new Error('Username or password is incorrect.');
    }
  } catch (error) {
    gateError.textContent = error.message || 'Username or password is incorrect.';
  }
}
document.getElementById('gate-change-btn').addEventListener('click', async () => {
  gateError.textContent = '';
  const next = document.getElementById('gate-new-password').value;
  const confirmNext = document.getElementById('gate-confirm-password').value;
  if (Array.from(next).length < 4) { gateError.textContent = 'Password must be at least 4 characters.'; return; }
  if (next !== confirmNext) { gateError.textContent = 'The passwords do not match.'; return; }
  try {
    await BlinkAuth.changePasswordAndSignOut(adminUsername, next);
    const admin = await BlinkAuth.adminState();
    if (!admin || admin.must_change_password) throw new Error('Password changed, but the admin password-change check did not clear. Contact the Blink administrator.');
    passwordChangePanel.style.display = 'none';
    showDashboard();
  } catch (error) { gateError.textContent = error.message || 'Could not change password.'; }
});
async function restoreAdminSession() {
  if (!(await BlinkAuth.currentSession())) return;
  if (!(await verifyAdmin())) await BlinkAuth.signOut('local');
}
restoreAdminSession();
document.getElementById('logout-btn').addEventListener('click', async () => {
  await BlinkAuth.signOut('local');
  adminUsername = '';
  document.getElementById('dashboard').classList.remove('open');
  gate.style.display = 'flex';
  document.getElementById('gate-btn').style.display = '';
  passwordChangePanel.style.display = 'none';
  document.getElementById('gate-input').value = '';
  document.getElementById('gate-new-password').value = '';
  document.getElementById('gate-confirm-password').value = '';
});

// ─── DASHBOARD DATA ───────────────────────────────────────────────────────────
async function loadDashboard() {
  await Promise.all([
    loadStats(), loadConfig(), loadBlacklist(),
    loadLeaderboard(), loadStorageUsage(), loadClientErrors(),
    loadFeedback(), loadScheduledBroadcasts()
  ]);
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

// ─── FORCE RELOAD ─────────────────────────────────────────────────────────────
document.getElementById('force-reload-btn').addEventListener('click', async () => {
  const btn = document.getElementById('force-reload-btn');
  const status = document.getElementById('force-reload-status');
  if (!confirm('This will force every user to hard-reload the app on their next visit. Continue?')) return;
  btn.disabled = true;
  btn.textContent = 'Pushing…';
  status.textContent = '';
  const newVer = Date.now().toString();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_config`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'force_reload_version', value: newVer, updated_at: new Date().toISOString() })
    });
    if (res.ok) {
      status.style.color = '#4ade80';
      status.textContent = `✓ Done — version ${newVer} pushed. Users will reload on next app open.`;
    } else {
      const err = await res.text().catch(() => '');
      status.style.color = '#ff453a';
      status.textContent = 'Failed: ' + err;
    }
  } catch(e) {
    status.style.color = '#ff453a';
    status.textContent = 'Failed: ' + e.message;
  }
  btn.textContent = '⟲ Force Reload for All Users';
  btn.disabled = false;
});

// ─── USERNAME BLACKLIST ───────────────────────────────────────────────────────
async function loadBlacklist() {
  const list = document.getElementById('blacklist-list');
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/username_blacklist?select=*&order=banned_at.desc`, { headers });
    const rows = res.ok ? await res.json() : [];

    if (!rows.length) {
      list.innerHTML = `<div class="empty-note">No blocked usernames.</div>`;
      return;
    }

    list.innerHTML = rows.map(r => {
      const expired = r.expires_at && new Date(r.expires_at) < new Date();
      const expiryLabel = !r.expires_at ? 'Permanent'
        : expired ? 'Expired (will be treated as unblocked)'
        : `Expires ${new Date(r.expires_at).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}`;
      return `
        <div class="blacklist-row">
          <div class="blacklist-row-info">
            <div class="blacklist-username">@${escapeHtml(r.username)}</div>
            ${r.reason ? `<div class="blacklist-reason">${escapeHtml(r.reason)}</div>` : ''}
            <div class="blacklist-expiry">${expiryLabel}</div>
          </div>
          <button class="blacklist-remove-btn" data-username="${escapeHtml(r.username)}">Unblock</button>
        </div>
      `;
    }).join('');

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
  const durationSelect = document.getElementById('blacklist-duration-select');
  const username = usernameInput.value.trim().replace(/^@/, '');
  const reason = reasonInput.value.trim();
  const durationHours = durationSelect.value ? parseFloat(durationSelect.value) : null;
  const expiresAt = durationHours ? new Date(Date.now() + durationHours * 3600 * 1000).toISOString() : null;

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
      body: JSON.stringify({ username, reason: reason.length ? reason : null, expires_at: expiresAt })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      alert('Failed to block user: ' + errText);
      return;
    }
    usernameInput.value = '';
    reasonInput.value = '';
    durationSelect.value = '';
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

// ─── USER LOOKUP ──────────────────────────────────────────────────────────────
document.getElementById('user-search-btn').addEventListener('click', lookupUser);
document.getElementById('user-search-input').addEventListener('keydown', e => { if (e.key === 'Enter') lookupUser(); });

async function lookupUser() {
  const input = document.getElementById('user-search-input');
  const resultEl = document.getElementById('user-search-result');
  const username = input.value.trim().replace(/^@/, '');
  if (!username) return;

  resultEl.innerHTML = `<div class="empty-note">Searching...</div>`;

  try {
    const [devicesRes, blacklistRes, totalsRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/devices?username=eq.${encodeURIComponent(username)}&select=*&order=created_at.asc`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/username_blacklist?username=eq.${encodeURIComponent(username)}&select=*`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/user_totals?username=eq.${encodeURIComponent(username)}&select=*`, { headers })
    ]);

    const devices = devicesRes.ok ? await devicesRes.json() : [];
    const blacklist = blacklistRes.ok ? await blacklistRes.json() : [];
    const totals = totalsRes.ok ? await totalsRes.json() : [];

    if (!devices.length && !totals.length) {
      resultEl.innerHTML = `<div class="empty-note">No record of @${escapeHtml(username)} — they may not have sent a message yet, or never existed.</div>`;
      return;
    }

    const blockEntry = blacklist[0];
    const isBlocked = blockEntry && (!blockEntry.expires_at || new Date(blockEntry.expires_at) > new Date());
    const totalMsgs = totals[0]?.total_messages || 0;
    const firstSeen = totals[0]?.first_seen ? new Date(totals[0].first_seen).toLocaleDateString() : 'Unknown';
    const lastSeen = devices.length ? new Date(Math.max(...devices.map(d => new Date(d.last_seen).getTime()))).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : 'Unknown';

    resultEl.innerHTML = `
      <div class="user-result-card">
        <div class="user-result-row"><span class="k">Username</span><span>@${escapeHtml(username)}</span></div>
        <div class="user-result-row"><span class="k">Status</span><span class="${isBlocked ? 'user-result-blocked' : 'user-result-ok'}">${isBlocked ? 'Blocked' : 'Active'}</span></div>
        <div class="user-result-row"><span class="k">Total Messages Sent</span><span>${totalMsgs}</span></div>
        <div class="user-result-row"><span class="k">First Seen</span><span>${firstSeen}</span></div>
        <div class="user-result-row"><span class="k">Last Active</span><span>${lastSeen}</span></div>
        <div class="user-result-row"><span class="k">Devices</span><span>${devices.length}</span></div>
        ${devices.map(d => `
          <div class="user-result-row" style="padding-left:12px;">
            <span class="k">↳ ${escapeHtml(d.device_label || 'Device')}</span>
            <span>
              <button class="force-signout-btn" data-device="${escapeHtml(d.device_id)}">${d.force_signed_out ? 'Pending sign-out' : 'Force Sign Out'}</button>
            </span>
          </div>
        `).join('')}
      </div>
    `;

    resultEl.querySelectorAll('.force-signout-btn').forEach(btn => {
      btn.addEventListener('click', () => forceSignOutDevice(btn.dataset.device, btn));
    });
  } catch(e) {
    resultEl.innerHTML = `<div class="empty-note">Search failed: ${e.message}</div>`;
  }
}

async function forceSignOutDevice(deviceId, btn) {
  if (!confirm('Force this device to sign out? It will be logged out next time it checks in (within ~60 seconds).')) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/blink_admin_set_device_signout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_device_id: deviceId, p_force_signed_out: true })
    });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Admin request failed'));
    btn.textContent = 'Pending sign-out';
    btn.disabled = true;
  } catch(e) { alert('Failed: ' + e.message); }
}

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
async function loadLeaderboard() {
  const tbody = document.getElementById('leaderboard-tbody');
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_totals?select=*&order=total_messages.desc&limit=15`, { headers });
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-note">No data yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>@${escapeHtml(r.username)}</td>
        <td>${r.total_messages}</td>
        <td>${new Date(r.last_seen).toLocaleDateString([], { month:'short', day:'numeric' })}</td>
      </tr>
    `).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-note">Failed to load: ${e.message}</td></tr>`;
  }
}

// ─── STORAGE USAGE ────────────────────────────────────────────────────────────
async function loadStorageUsage() {
  const el = document.getElementById('storage-stats');
  try {
    const tables = ['messages', 'devices', 'usernames', 'username_blacklist', 'client_errors', 'feedback_reports'];
    const counts = await Promise.all(tables.map(async t => {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*&limit=1`, {
        headers: { ...headers, 'Prefer': 'count=exact' }
      });
      const count = res.headers.get('content-range')?.split('/')[1] || '?';
      return { table: t, count };
    }));
    el.innerHTML = counts.map(c => `
      <div class="stat-card">
        <div class="label">${c.table}</div>
        <div class="value" style="font-size:22px;">${c.count}</div>
        <div class="sub">rows</div>
      </div>
    `).join('');
  } catch(e) {
    el.innerHTML = `<div class="empty-note">Failed to load: ${e.message}</div>`;
  }
}

// ─── CLIENT ERRORS ────────────────────────────────────────────────────────────
async function loadClientErrors() {
  const tbody = document.getElementById('errors-tbody');
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/client_errors?select=*&order=created_at.desc&limit=25`, { headers });
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-note">No errors logged. Good sign.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${new Date(r.created_at).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</td>
        <td>${r.username ? '@' + escapeHtml(r.username) : '—'}</td>
        <td class="err-msg">${escapeHtml(r.message)}</td>
        <td>${escapeHtml(r.context || '—')}</td>
      </tr>
    `).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-note">Failed to load: ${e.message}</td></tr>`;
  }
}

// ─── FEEDBACK / BUG REPORTS ────────────────────────────────────────────────────
async function loadFeedback() {
  const tbody = document.getElementById('feedback-tbody');
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/feedback_reports?select=*&order=created_at.desc&limit=30`, { headers });
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-note">No feedback yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${new Date(r.created_at).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</td>
        <td>${r.username ? '@' + escapeHtml(r.username) : '—'}</td>
        <td style="max-width:320px;">${escapeHtml(r.message)}</td>
        <td>
          <span class="feedback-status-${r.status}">${r.status}</span>
          ${r.status === 'open' ? `<button class="feedback-resolve-btn" data-id="${r.id}">Mark Resolved</button>` : ''}
        </td>
      </tr>
    `).join('');
    tbody.querySelectorAll('.feedback-resolve-btn').forEach(btn => {
      btn.addEventListener('click', () => resolveFeedback(btn.dataset.id));
    });
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-note">Failed to load: ${e.message}</td></tr>`;
  }
}

async function resolveFeedback(id) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/feedback_reports?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: 'resolved' })
    });
    loadFeedback();
  } catch(e) { alert('Failed: ' + e.message); }
}

// ─── SCHEDULED BROADCASTS ─────────────────────────────────────────────────────
async function loadScheduledBroadcasts() {
  const list = document.getElementById('scheduled-list');
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/scheduled_broadcasts?shown=eq.false&show_at=gt.${encodeURIComponent(new Date().toISOString())}&select=*&order=show_at.asc`, { headers });
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) {
      list.innerHTML = `<div class="empty-note">No broadcasts scheduled.</div>`;
      return;
    }
    list.innerHTML = rows.map(r => `
      <div class="scheduled-row">
        <div class="scheduled-row-info">
          <div class="scheduled-message">${escapeHtml(r.message)}</div>
          <div class="scheduled-time">Shows at ${new Date(r.show_at).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</div>
        </div>
        <button class="scheduled-cancel-btn" data-id="${r.id}">Cancel</button>
      </div>
    `).join('');
    list.querySelectorAll('.scheduled-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => cancelScheduledBroadcast(btn.dataset.id));
    });
  } catch(e) {
    list.innerHTML = `<div class="empty-note">Failed to load: ${e.message}</div>`;
  }
}

document.getElementById('scheduled-add-btn').addEventListener('click', async () => {
  const msgInput = document.getElementById('scheduled-message-input');
  const timeInput = document.getElementById('scheduled-time-input');
  const message = msgInput.value.trim();
  const showAt = timeInput.value;

  if (!message || !showAt) { alert('Enter both a message and a time'); return; }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/scheduled_broadcasts`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ message, show_at: new Date(showAt).toISOString() })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      alert('Failed to schedule: ' + errText);
      return;
    }
    msgInput.value = '';
    timeInput.value = '';
    loadScheduledBroadcasts();
  } catch(e) { alert('Failed: ' + e.message); }
});

async function cancelScheduledBroadcast(id) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/scheduled_broadcasts?id=eq.${id}`, { method: 'DELETE', headers });
    loadScheduledBroadcasts();
  } catch(e) { alert('Failed: ' + e.message); }
}

// ─── WALLET MANAGEMENT ────────────────────────────────────────────────────────
let walletTargetUser = null;
let walletCurrentBalance = 0;

document.getElementById('wallet-lookup-btn').addEventListener('click', lookupWallet);
document.getElementById('wallet-username-input').addEventListener('keydown', e => { if (e.key === 'Enter') lookupWallet(); });

async function lookupWallet() {
  const input = document.getElementById('wallet-username-input');
  const resultEl = document.getElementById('wallet-result');
  const actionRow = document.getElementById('wallet-action-row');
  const username = input.value.trim().replace(/^@/, '');
  if (!username) return;

  walletTargetUser = null;
  actionRow.style.display = 'none';
  resultEl.innerHTML = '<div class="empty-note">Looking up...</div>';

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/balances?username=eq.${encodeURIComponent(username)}&select=*`,
      { headers }
    );
    const rows = res.ok ? await res.json() : [];

    if (!rows.length) {
      resultEl.innerHTML = `<div class="empty-note">No wallet found for @${escapeHtml(username)} — they may not have opened Blink Pay yet.</div>`;
      return;
    }

    walletTargetUser = username;
    walletCurrentBalance = rows[0].amount;

    resultEl.innerHTML = `
      <div class="wallet-balance-card">
        <div>
          <div class="wallet-balance-label">@${escapeHtml(username)}</div>
        </div>
        <div class="wallet-balance-amount">BP ${walletCurrentBalance.toLocaleString()}</div>
      </div>`;

    actionRow.style.display = 'flex';
    document.getElementById('wallet-amount-input').value = '';
  } catch(e) {
    resultEl.innerHTML = `<div class="empty-note">Lookup failed: ${e.message}</div>`;
  }
}

document.getElementById('wallet-add-btn').addEventListener('click', () => adjustWallet(1));
document.getElementById('wallet-remove-btn').addEventListener('click', () => adjustWallet(-1));

async function adjustWallet(direction) {
  if (!walletTargetUser) return;
  const raw = parseFloat(document.getElementById('wallet-amount-input').value);
  if (!raw || raw <= 0 || isNaN(raw)) { alert('Enter a valid amount'); return; }
  const delta = Math.round(raw) * direction;
  const newBalance = walletCurrentBalance + delta;

  if (newBalance < 0) {
    if (!confirm(`This would set @${walletTargetUser}'s balance to ${newBalance}. Proceed with a negative balance?`)) return;
  }

  const verb = direction > 0 ? 'Add' : 'Remove';
  if (!confirm(`${verb} BP ${Math.round(raw)} ${direction > 0 ? 'to' : 'from'} @${walletTargetUser}?\nNew balance: BP ${newBalance.toLocaleString()}`)) return;

  try {
    // Upsert the balance row — sets it to the new computed value directly.
    const res = await fetch(`${SUPABASE_URL}/rest/v1/balances`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ username: walletTargetUser, amount: newBalance })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      alert('Failed to update balance: ' + err);
      return;
    }
    walletCurrentBalance = newBalance;
    document.getElementById('wallet-result').innerHTML = `
      <div class="wallet-balance-card">
        <div>
          <div class="wallet-balance-label">@${escapeHtml(walletTargetUser)}</div>
        </div>
        <div class="wallet-balance-amount">BP ${walletCurrentBalance.toLocaleString()}</div>
      </div>`;
    document.getElementById('wallet-amount-input').value = '';
    alert(`Done — @${walletTargetUser}'s balance is now BP ${walletCurrentBalance.toLocaleString()}`);
  } catch(e) {
    alert('Failed: ' + e.message);
  }
}
