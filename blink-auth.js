/* Blink password authentication. The synthetic email is an internal Supabase
   Auth identifier only; Blink does not collect or send email or phone data. */
(function () {
  'use strict';
  const URL = 'https://gkrfiyalbjbgkjevmpod.supabase.co';
  const KEY = 'sb_publishable_e-Adkvwj1gTVa_61L_K1PQ_PI-xG0Ra';
  const SESSION_KEY = 'blinkAuthSession';
  let refreshPromise = null;

  function readSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (_) { return null; }
  }
  function writeSession(session) {
    if (!session?.access_token || !session?.refresh_token) throw new Error('Supabase did not return a sign-in session. Disable email confirmation in Auth settings and retry.');
    const expiresAt = session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...session, expires_at: expiresAt }));
    return session;
  }
  function clearSession() { localStorage.removeItem(SESSION_KEY); }
  function alias(username) { return `${String(username || '').trim().toLowerCase()}@accounts.blink.invalid`; }
  function baseHeaders(token) {
    return { apikey: KEY, Authorization: `Bearer ${token || KEY}`, 'Content-Type': 'application/json' };
  }
  async function raw(path, options = {}, token = null) {
    return fetch(URL + path, { ...options, headers: { ...baseHeaders(token), ...(options.headers || {}) } });
  }
  async function refresh() {
    const session = readSession();
    if (!session?.refresh_token) return null;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const res = await fetch(`${URL}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST', headers: baseHeaders(null),
          body: JSON.stringify({ refresh_token: session.refresh_token })
        });
        if (!res.ok) { clearSession(); return null; }
        return writeSession(await res.json());
      } catch (_) { return null; }
      finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }
  async function currentSession() {
    let s = readSession();
    if (!s?.access_token) return null;
    if (!s.expires_at || s.expires_at < Math.floor(Date.now() / 1000) + 60) s = await refresh();
    return s;
  }
  async function headers() {
    const s = await currentSession();
    return baseHeaders(s?.access_token || null);
  }
  async function api(path, options = {}) {
    const h = await headers();
    return fetch(URL + path, { ...options, headers: { ...h, ...(options.headers || {}) } });
  }
  function validCredentials(username, password) {
    const normalized = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{1,24}$/.test(normalized)) throw new Error('Username must be 1–24 letters, numbers, or underscores.');
    if (Array.from(String(password || '')).length < 4) throw new Error('Password must be at least 4 characters.');
    return normalized;
  }
  async function signUp(username, password) {
    const normalized = validCredentials(username, password);
    const res = await raw('/auth/v1/signup', {
      method: 'POST', body: JSON.stringify({
        email: alias(normalized), password,
        data: { blink_username: normalized }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.msg || data.message || data.error_description || data.error || 'Could not create the account.');
    const session = data.access_token ? data : data.session;
    if (!session?.access_token) throw new Error('Account created without a session. In Supabase Auth, turn off email confirmations; Blink does not use email. Then sign in.');
    writeSession(session);
    return session;
  }
  async function signIn(username, password) {
    const normalized = validCredentials(username, password);
    const email = alias(normalized);
    const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: baseHeaders(null), body: JSON.stringify({ email, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.msg || data.message || data.error_description || data.error || 'Username or password is incorrect.');
    return writeSession(data);
  }
  async function account() {
    const s = await currentSession();
    if (!s?.user?.id) return null;
    const res = await api(`/rest/v1/blink_accounts?select=user_id,username&user_id=eq.${encodeURIComponent(s.user.id)}&limit=1`);
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return rows[0] || null;
  }
  async function adminState() {
    const s = await currentSession();
    if (!s?.user?.id) return null;
    const res = await api(`/rest/v1/blink_admins?select=must_change_password&user_id=eq.${encodeURIComponent(s.user.id)}&limit=1`);
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return rows[0] || null;
  }
  async function changePassword(password) {
    if (Array.from(String(password || '')).length < 4) throw new Error('Password must be at least 4 characters.');
    const s = await currentSession();
    if (!s?.access_token) throw new Error('Sign in again to change your password.');
    const res = await raw('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ password }) }, s.access_token);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.msg || data.message || data.error_description || data.error || 'Password update failed.');
    return true;
  }
  async function signOut(scope = 'local') {
    const stored = readSession();
    const s = await currentSession();
    if (scope === 'global' && stored?.access_token && !s?.access_token) {
      throw new Error('Could not verify the session to sign out globally. Check your connection and try again.');
    }
    if (s?.access_token) {
      try {
        const res = await raw(`/auth/v1/logout?scope=${encodeURIComponent(scope)}`, { method: 'POST' }, s.access_token);
        if (scope === 'global' && !res.ok && ![401, 403, 404].includes(res.status)) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.msg || data.message || data.error_description || 'Supabase did not confirm global sign-out.');
        }
      } catch (error) {
        if (scope === 'global') throw error;
      }
    }
    clearSession();
  }
  async function changePasswordAndSignOut(username, password) {
    const normalized = String(username || '').trim().toLowerCase();
    await changePassword(password);
    // Global logout revokes refresh sessions on every device. Blink's RLS
    // policies also check the live Supabase session id, invalidating old JWTs.
    await signOut('global');
    return signIn(normalized, password);
  }
  async function usernameBlocked(username) {
    const res = await fetch(`${URL}/rest/v1/rpc/blink_username_is_blocked`, {
      method: 'POST', headers: baseHeaders(null), body: JSON.stringify({ p_username: String(username || '').trim().toLowerCase() })
    });
    if (!res.ok) return false;
    return res.json();
  }

  // Secure legacy app REST calls as well as callers using api() directly.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (input, init = {}) {
    const requestUrl = typeof input === 'string' || input instanceof window.URL ? String(input) : input.url;
    let parsed;
    try { parsed = new window.URL(requestUrl, window.location.href); }
    catch (_) { return nativeFetch(input, init); }
    if (parsed.origin !== new window.URL(URL).origin || !/^\/(rest\/v1|functions\/v1)\//.test(parsed.pathname)) {
      return nativeFetch(input, init);
    }
    const requestHeaders = input instanceof Request ? new Headers(input.headers) : new Headers();
    new Headers(init.headers || {}).forEach((value, key) => requestHeaders.set(key, value));
    const session = await currentSession();
    requestHeaders.set('apikey', KEY);
    requestHeaders.set('Authorization', `Bearer ${session?.access_token || KEY}`);
    return nativeFetch(input, { ...init, headers: requestHeaders });
  };

  window.BlinkAuth = { URL, KEY, SESSION_KEY, api, headers, currentSession, signUp, signIn, account, adminState, changePassword, changePasswordAndSignOut, signOut, usernameBlocked, validCredentials };
})();
