/* ═══════════════════════════════════════════════
   ĐGNL Nhanh — Background Service Worker v2.1
   + Keepalive + Auto Re-login + Smart Retry
   ═══════════════════════════════════════════════ */

const BASE = 'https://thinangluc.vnuhcm.edu.vn';
const LOGIN_URL = `${BASE}/dgnl/auth/sign-in`;
const GOOGLE_OAUTH_URL = `${BASE}/dgnl/oauth2/authorization/google`;
const HOME_PATTERNS = ['/app/home', '/app/v1/home', '/dgnl/app', '/app/v1/event-history'];
const ALARM_NAME = 'dgnl-check';
const KEEPALIVE_ALARM = 'dgnl-keepalive';
const STORAGE_KEY = 'dgnl_watch';
const RESULT_KEY = 'dgnl_last_result';
const CREDENTIALS_KEY = 'dgnl_credentials';

// Track active login tabs
let loginTabId = null;
let googleLoginResolver = null;

/* ──────────────────────────────────────────────
   4A. LẤY DỮ LIỆU
   ────────────────────────────────────────────── */

async function getSession() {
  // Thử nhiều URL path khác nhau
  const urlsToTry = [
    BASE + '/dgnl',
    BASE + '/dgnl/',
    BASE + '/dgnl/app',
    BASE + '/dgnl/app/v1',
    BASE,
    BASE + '/',
  ];

  // Tên cookie có thể khác nhau
  const cookieNames = ['JSESSIONID', 'SESSION', 'PHPSESSID', 'sid', 'connect.sid'];

  for (const url of urlsToTry) {
    for (const name of cookieNames) {
      try {
        const cookie = await chrome.cookies.get({ url, name });
        if (cookie) {
          console.log('[ĐGNL] Tìm thấy cookie:', name, 'tại URL:', url, 'path:', cookie.path, 'domain:', cookie.domain);
          return cookie.value;
        }
      } catch (err) { /* skip */ }
    }
  }

  // Debug: tìm TẤT CẢ cookies liên quan tới domain
  try {
    // Thử nhiều domain patterns
    const domains = [
      'thinangluc.vnuhcm.edu.vn',
      '.thinangluc.vnuhcm.edu.vn',
      '.vnuhcm.edu.vn',
      'vnuhcm.edu.vn',
    ];

    for (const domain of domains) {
      const cookies = await chrome.cookies.getAll({ domain });
      if (cookies.length > 0) {
        console.log(`[ĐGNL] Cookies tìm thấy với domain "${domain}" (${cookies.length}):`);
        cookies.forEach(c => {
          console.log(`  ${c.name} = ${c.value.substring(0, 15)}... (domain=${c.domain}, path=${c.path}, httpOnly=${c.httpOnly}, secure=${c.secure})`);
        });

        // Trả về cookie session đầu tiên tìm thấy
        const sessionCookie = cookies.find(c =>
          c.name === 'JSESSIONID' || c.name === 'SESSION' || c.name.includes('SESSION') || c.name.includes('session')
        );
        if (sessionCookie) {
          console.log('[ĐGNL] Dùng cookie:', sessionCookie.name, '=', sessionCookie.value.substring(0, 10) + '...');
          return sessionCookie.value;
        }
      }
    }

    // Cuối cùng: lấy TẤT CẢ cookies theo URL
    const urlCookies = await chrome.cookies.getAll({ url: BASE + '/dgnl' });
    console.log(`[ĐGNL] Cookies theo URL (${urlCookies.length}):`, urlCookies.map(c => c.name));
    if (urlCookies.length > 0) {
      const sess = urlCookies.find(c => c.name.includes('SESSION') || c.name.includes('session'));
      if (sess) return sess.value;
    }

  } catch (e) {
    console.warn('[ĐGNL] Lỗi đọc cookies:', e);
  }

  console.warn('[ĐGNL] KHÔNG TÌM THẤY session cookie nào');
  return null;
}

function buildHeaders(jsessionid) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Cookie': `JSESSIONID=${jsessionid}`,
    'Referer': `${BASE}/dgnl/app/home`,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

async function fetchWithRetry(url, options, maxRetries = 8) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.status === 401) {
        throw { code: 'SESSION_EXPIRED', status: 401 };
      }
      if (response.status === 404) {
        throw { code: 'NOT_FOUND', status: 404 };
      }

      if ([500, 502, 503, 429].includes(response.status)) {
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < maxRetries) {
          const waitMs = Math.min(Math.pow(2, attempt - 1) * 1000, 15000);
          notifyPopup({
            type: 'RETRY_STATUS',
            attempt,
            maxRetries,
            waitMs,
          });
          await sleep(waitMs);
          continue;
        }
        throw { code: 'MAX_RETRIES_EXCEEDED', lastStatus: response.status };
      }

      return response;
    } catch (err) {
      clearTimeout(timeoutId);

      if (err.code === 'SESSION_EXPIRED' || err.code === 'NOT_FOUND') {
        throw err;
      }
      if (err.code === 'MAX_RETRIES_EXCEEDED') {
        throw err;
      }

      lastError = err;

      if (attempt < maxRetries) {
        const waitMs = Math.min(Math.pow(2, attempt - 1) * 1000, 15000);
        notifyPopup({
          type: 'RETRY_STATUS',
          attempt,
          maxRetries,
          waitMs,
        });
        await sleep(waitMs);
        continue;
      }
    }
  }

  throw { code: 'MAX_RETRIES_EXCEEDED', lastError };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll cho session cookie thay vì sleep cố định.
 * Kiểm tra mỗi 300ms, trả về ngay khi tìm thấy cookie.
 * @param {number} timeoutMs - Thời gian tối đa chờ (ms)
 * @returns {Promise<string|null>} - Cookie value hoặc null
 */
async function pollForCookie(timeoutMs = 5000) {
  const interval = 300;
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    const cookie = await getSession();
    if (cookie) {
      console.log(`[ĐGNL] Cookie tìm thấy sau ${elapsed}ms:`, cookie.substring(0, 10) + '...');
      return cookie;
    }
    await sleep(interval);
    elapsed += interval;
  }
  console.warn(`[ĐGNL] Không tìm thấy cookie sau ${timeoutMs}ms`);
  return null;
}

async function fetchProfile(jsessionid) {
  const url = `${BASE}/dgnl/api/profile/v1/get-profile/HOME`;
  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: buildHeaders(jsessionid),
    credentials: 'include',
  });
  return response.json();
}

async function fetchScores(jsessionid) {
  const endpoints = [
    '/dgnl/api/app/v1/search-result-test-info',  // API chính thức tra điểm
    '/dgnl/api/score/v1/my-score',
    '/dgnl/api/score/v1/get-my-score',
    '/dgnl/api/score/v1/result',
    '/dgnl/api/score/v1/get-result',
    '/dgnl/api/result/v1/my-result',
    '/dgnl/api/result/v1/get-result',
    '/dgnl/api/diem/v1/my-diem',
    '/dgnl/api/ketqua/v1/my-ketqua',
    '/dgnl/api/thi-sinh/v1/ket-qua',
    '/dgnl/api/thi-sinh/v1/diem-thi',
    '/dgnl/api/profile/v1/get-score',
    '/dgnl/api/profile/v1/get-result',
    '/dgnl/api/list-reg-documents',
  ];

  for (const endpoint of endpoints) {
    const url = `${BASE}${endpoint}`;
    try {
      const response = await fetchWithRetry(url, {
        method: 'GET',
        headers: buildHeaders(jsessionid),
        credentials: 'include',
      }, 3);

      // Kiểm tra content-type trước khi parse JSON
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        console.log(`[ĐGNL] ${endpoint} trả về ${contentType}, bỏ qua...`);
        continue;
      }

      let data;
      try {
        data = await response.json();
      } catch (parseErr) {
        console.warn(`[ĐGNL] ${endpoint} — JSON parse lỗi:`, parseErr.message);
        continue;
      }

      console.log(`[ĐGNL] Endpoint thành công: ${endpoint}`, data);
      return { endpoint, data };
    } catch (err) {
      if (err.code === 'SESSION_EXPIRED') {
        throw err;
      }
      if (err.code === 'NOT_FOUND') {
        console.log(`[ĐGNL] 404 tại ${endpoint}, thử endpoint tiếp...`);
        continue;
      }
      console.warn(`[ĐGNL] Lỗi tại ${endpoint}:`, err);
      continue;
    }
  }
  console.log('[ĐGNL] Không endpoint nào trả về data.');
  return null;
}

async function handleFetchScores() {
  const jsessionid = await getSession();
  if (!jsessionid) {
    return { error: 'NOT_LOGGED_IN' };
  }

  try {
    const results = await Promise.allSettled([
      fetchProfile(jsessionid),
      fetchScores(jsessionid),
    ]);

    const profileResult = results[0];
    const scoresResult = results[1];

    const profile =
      profileResult.status === 'fulfilled' ? profileResult.value : null;
    const scores =
      scoresResult.status === 'fulfilled' ? scoresResult.value : null;

    if (profileResult.status === 'rejected') {
      const reason = profileResult.reason;
      if (reason && reason.code === 'SESSION_EXPIRED') {
        return { error: 'SESSION_EXPIRED' };
      }
      if (reason && reason.code === 'MAX_RETRIES_EXCEEDED') {
        return { error: 'MAX_RETRIES_EXCEEDED' };
      }
    }

    if (scoresResult.status === 'rejected') {
      const reason = scoresResult.reason;
      if (reason && reason.code === 'SESSION_EXPIRED') {
        return { error: 'SESSION_EXPIRED' };
      }
    }

    return {
      profile,
      scores,
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error('[ĐGNL] handleFetchScores error:', err);
    if (err.code) return { error: err.code };
    return { error: String(err.message || err) };
  }
}

/* ──────────────────────────────────────────────
   4A-2. AUTO LOGIN (CCCD + PASSWORD)
   ────────────────────────────────────────────── */

async function handleAutoLogin(cccd, password) {
  console.log('[ĐGNL] Bắt đầu auto-login với CCCD:', cccd.substring(0, 4) + '****');

  try {
    // Step 1: Open login page in a new tab
    notifyPopup({ type: 'LOGIN_STEP', step: 'open', state: 'active', text: 'Đang mở trang đăng nhập...' });

    const tab = await chrome.tabs.create({
      url: LOGIN_URL,
      active: false, // background tab
    });
    loginTabId = tab.id;

    // Chờ page load (content_scripts manifest tự inject trên document_idle)
    await waitForTabLoad(tab.id, 15000);
    // Không sleep(3000) nữa — content script sẽ tự poll chờ form

    notifyPopup({ type: 'LOGIN_STEP', step: 'fill', state: 'active', text: 'Đang điền thông tin...' });

    // Step 2: Send credentials to content script (retry up to 3 times)
    let loginResult;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        loginResult = await chrome.tabs.sendMessage(tab.id, {
          type: 'FILL_LOGIN',
          cccd,
          password,
        });
        break; // success
      } catch (err) {
        lastError = err;
        console.log(`[ĐGNL] Content script attempt ${attempt} failed:`, err.message);
        // Inject content script manually and retry
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/auto-login.js'],
          });
        } catch (injectErr) {
          console.warn('[ĐGNL] Inject failed:', injectErr.message);
        }
        await sleep(1000); // Giảm từ 2000 → 1000
      }
    }

    if (!loginResult && lastError) {
      await safeCloseTab(tab.id);
      return { error: 'Content script không phản hồi. Thử đăng nhập thủ công.' };
    }

    notifyPopup({ type: 'LOGIN_STEP', step: 'submit', state: 'active', text: 'Đang xác thực...' });

    if (!loginResult) {
      await safeCloseTab(tab.id);
      return { error: 'Không nhận được phản hồi từ trang đăng nhập.' };
    }

    if (loginResult.error) {
      // If timeout, make tab visible so user can see what happened
      if (loginResult.error.includes('Timeout')) {
        try {
          await chrome.tabs.update(tab.id, { active: true });
          // Don't close the tab — let user interact
          loginTabId = null;
          return { error: 'Đăng nhập chậm. Tab đã được mở — vui lòng kiểm tra và thử lại.' };
        } catch (e) { /* tab might be closed */ }
      }

      await safeCloseTab(tab.id);
      return { error: loginResult.error };
    }

    // Step 3: Login successful — poll cookie NHANH thay vì sleep cố định
    notifyPopup({ type: 'LOGIN_STEP', step: 'fetch', state: 'active', text: 'Đang lấy điểm...' });

    const jsessionid = await pollForCookie(5000); // Poll mỗi 300ms, tối đa 5s

    if (!jsessionid) {
      // FALLBACK: Dùng content script lấy dữ liệu trực tiếp từ trang đã đăng nhập
      console.log('[ĐGNL] Không có cookie → dùng content script lấy data trực tiếp...');

      try {
        // Inject content script vào trang home (nếu chưa có)
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/auto-login.js'],
          });
        } catch (e) { /* already injected */ }
        await sleep(500);

        const pageData = await chrome.tabs.sendMessage(tab.id, { type: 'FETCH_DATA_FROM_PAGE' });
        console.log('[ĐGNL] Dữ liệu từ content script:', pageData);

        await safeCloseTab(tab.id);

        if (pageData && (pageData.profile || pageData.scores)) {
          notifyPopup({ type: 'LOGIN_STEP', step: 'fetch', state: 'done', text: 'Hoàn tất!' });
          const result = {
            profile: pageData.profile,
            scores: pageData.scores,
            timestamp: Date.now(),
          };
          await saveLoginResult(result);
          return result;
        }

        return { error: 'Đăng nhập thành công nhưng không lấy được dữ liệu. Thử đăng nhập thủ công.' };
      } catch (fetchErr) {
        console.error('[ĐGNL] Fallback fetch error:', fetchErr);
        await safeCloseTab(tab.id);
        return { error: 'Đăng nhập thành công nhưng lỗi lấy dữ liệu: ' + (fetchErr.message || fetchErr) };
      }
    }

    // Có cookie → đóng tab và fetch bình thường
    await safeCloseTab(tab.id);

    const data = await handleFetchScores();

    if (data.error) {
      return { error: `Đăng nhập thành công nhưng: ${data.error}` };
    }

    notifyPopup({ type: 'LOGIN_STEP', step: 'fetch', state: 'done', text: 'Hoàn tất!' });

    await saveLoginResult(data);

    return data;

  } catch (err) {
    console.error('[ĐGNL] Auto-login error:', err);
    await safeCloseTab(loginTabId);
    return { error: `Lỗi đăng nhập: ${err.message || String(err)}` };
  } finally {
    loginTabId = null;
  }
}

/* ──────────────────────────────────────────────
   4A-3. GOOGLE LOGIN
   ────────────────────────────────────────────── */

async function handleGoogleLogin() {
  console.log('[ĐGNL] Bắt đầu Google login...');

  try {
    notifyPopup({ type: 'LOGIN_STEP', step: 'open', state: 'active', text: 'Đang mở Google...' });

    // Open Google OAuth in a visible tab (user needs to interact)
    const tab = await chrome.tabs.create({
      url: GOOGLE_OAUTH_URL,
      active: true,
    });
    loginTabId = tab.id;

    // Wait for the user to complete Google login and be redirected back
    notifyPopup({ type: 'LOGIN_STEP', step: 'fill', state: 'active', text: 'Chờ đăng nhập Google...' });

    const success = await waitForRedirectToHome(tab.id, 120000); // 2 min timeout

    if (!success) {
      await safeCloseTab(tab.id);
      return { error: 'Hết thời gian chờ. Vui lòng thử lại.' };
    }

    notifyPopup({ type: 'LOGIN_STEP', step: 'submit', state: 'done', text: 'Đăng nhập thành công!' });

    notifyPopup({ type: 'LOGIN_STEP', step: 'fetch', state: 'active', text: 'Đang lấy điểm...' });

    // Poll cookie nhanh thay vì sleep cố định
    const jsessionid = await pollForCookie(5000);

    if (jsessionid) {
      // Có cookie → đóng tab, fetch bình thường
      await safeCloseTab(tab.id);
      const data = await handleFetchScores();
      if (data.error) {
        return { error: `Đăng nhập Google thành công nhưng: ${data.error}` };
      }
      notifyPopup({ type: 'LOGIN_STEP', step: 'fetch', state: 'done', text: 'Hoàn tất!' });
      await saveLoginResult(data);
      return data;
    }

    // Không có cookie → fallback: content script lấy data
    console.log('[ĐGNL] Google login: không có cookie → dùng content script...');
    try {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/auto-login.js'],
        });
      } catch (e) { /* already injected */ }
      await sleep(500);

      const pageData = await chrome.tabs.sendMessage(tab.id, { type: 'FETCH_DATA_FROM_PAGE' });
      await safeCloseTab(tab.id);

      if (pageData && (pageData.profile || pageData.scores)) {
        notifyPopup({ type: 'LOGIN_STEP', step: 'fetch', state: 'done', text: 'Hoàn tất!' });
        const result = {
          profile: pageData.profile,
          scores: pageData.scores,
          timestamp: Date.now(),
        };
        // VĐ4: Lưu kết quả vào storage để popup mở lại vẫn hiển thị
        await saveLoginResult(result);
        return result;
      }
      return { error: 'Đăng nhập Google thành công nhưng không lấy được dữ liệu.' };
    } catch (fetchErr) {
      await safeCloseTab(tab.id);
      return { error: 'Lỗi lấy dữ liệu: ' + (fetchErr.message || fetchErr) };
    }

  } catch (err) {
    console.error('[ĐGNL] Google login error:', err);
    await safeCloseTab(loginTabId);
    return { error: `Lỗi Google login: ${err.message || String(err)}` };
  } finally {
    loginTabId = null;
  }
}

/* ──────────────────────────────────────────────
   4A-4. TAB HELPERS
   ────────────────────────────────────────────── */

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // Don't reject, just continue
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function waitForRedirectToHome(tabId, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      resolve(false);
    }, timeoutMs);

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;

      // Check if redirected to home/app page
      if (changeInfo.url || changeInfo.status === 'complete') {
        const url = changeInfo.url || tab.url || '';
        const isHome = HOME_PATTERNS.some(pattern => url.includes(pattern));

        if (isHome) {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.tabs.onRemoved.removeListener(removedListener);
          resolve(true);
        }
      }
    }

    function removedListener(removedTabId) {
      if (removedTabId === tabId) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.onRemoved.removeListener(removedListener);
        resolve(false);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
  });
}

async function safeCloseTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    // Tab already closed
  }
}

/* ──────────────────────────────────────────────
   4A-5. LOGOUT
   ────────────────────────────────────────────── */

async function handleLogout() {
  try {
    // VĐ5: Xóa TẤT CẢ cookies liên quan, không chỉ JSESSIONID
    const domains = [
      'thinangluc.vnuhcm.edu.vn',
      '.thinangluc.vnuhcm.edu.vn',
      '.vnuhcm.edu.vn',
    ];
    for (const domain of domains) {
      try {
        const cookies = await chrome.cookies.getAll({ domain });
        for (const c of cookies) {
          const cookieUrl = `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path}`;
          await chrome.cookies.remove({ url: cookieUrl, name: c.name });
          console.log(`[ĐGNL] Đã xóa cookie: ${c.name} (domain=${c.domain}, path=${c.path})`);
        }
      } catch (e) { /* skip domain */ }
    }
    // Clear stored results
    await chrome.storage.local.remove([RESULT_KEY, STORAGE_KEY]);
    // Stop watching
    await chrome.alarms.clear(ALARM_NAME);
    // Clear badge
    chrome.action.setBadgeText({ text: '' });
  } catch (e) {
    console.warn('[ĐGNL] Logout cleanup error:', e);
  }
  return { ok: true };
}

/* ──────────────────────────────────────────────
   4A-6. SAVE LOGIN RESULT TO STORAGE
   ────────────────────────────────────────────── */

async function saveLoginResult(data) {
  try {
    const scoreInfo = parseScoreData(data.scores);
    await chrome.storage.local.set({
      [RESULT_KEY]: {
        scoreInfo,
        profile: data.profile,
        foundAt: Date.now(),
      },
    });
    console.log('[ĐGNL] Đã lưu kết quả vào storage.');

    // Set badge nếu có điểm
    if (scoreInfo && scoreInfo.total > 0) {
      chrome.action.setBadgeText({ text: String(scoreInfo.total) });
      chrome.action.setBadgeBackgroundColor({ color: '#1D4ED8' });

      // Gửi Discord notification (đăng nhập)
      sendDiscordNotification(scoreInfo, data.profile, '🔑 Đăng nhập xem điểm').catch(e =>
        console.warn('[ĐGNL] Discord send error in saveLoginResult:', e)
      );
    }
  } catch (e) {
    console.warn('[ĐGNL] Lỗi lưu kết quả:', e);
  }
}

/* ──────────────────────────────────────────────
   4B. CANH ĐIỂM TỰ ĐỘNG
   ────────────────────────────────────────────── */

async function startWatching(intervalMinutes) {
  const watchData = {
    active: true,
    intervalMinutes,
    startedAt: Date.now(),
    lastCheck: null,
    lastStatus: 'idle',
    checkCount: 0,
    reloginCount: 0,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: watchData });

  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.1,
    periodInMinutes: intervalMinutes,
  });

  // Bắt đầu keepalive song song
  startKeepalive();

  console.log(
    `[ĐGNL] Bắt đầu canh điểm mỗi ${intervalMinutes} phút + keepalive.`
  );
  return watchData;
}

async function stopWatching() {
  await chrome.alarms.clear(ALARM_NAME);
  stopKeepalive();
  await chrome.storage.local.remove(STORAGE_KEY);
  console.log('[ĐGNL] Đã dừng canh điểm + keepalive.');
}

async function getWatchStatus() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || null;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkForNewScore();
  } else if (alarm.name === KEEPALIVE_ALARM) {
    keepaliveSession();
  }
});

/* ──────────────────────────────────────────────
   4B-1. SESSION KEEPALIVE — Giữ phiên sống
   ────────────────────────────────────────────── */

function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, {
    delayInMinutes: 10,
    periodInMinutes: 10,  // Ping mỗi 10 phút
  });
  console.log('[ĐGNL] Keepalive started — ping mỗi 10 phút.');
}

function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
  console.log('[ĐGNL] Keepalive stopped.');
}

async function keepaliveSession() {
  const jsessionid = await getSession();
  if (!jsessionid) {
    console.log('[ĐGNL] Keepalive: không có session, thử auto re-login...');
    const reloginResult = await autoRelogin();
    if (reloginResult) {
      console.log('[ĐGNL] Keepalive: re-login thành công!');
      notifyPopup({ type: 'KEEPALIVE_RELOGIN_OK' });
    } else {
      console.warn('[ĐGNL] Keepalive: re-login thất bại.');
      notifyPopup({ type: 'KEEPALIVE_RELOGIN_FAIL' });
    }
    return;
  }

  // Ping nhẹ — chỉ gọi profile để giữ session
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${BASE}/dgnl/api/profile/v1/get-profile/HOME`, {
      method: 'GET',
      headers: buildHeaders(jsessionid),
      credentials: 'include',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.status === 401) {
      console.log('[ĐGNL] Keepalive: session hết hạn (401), thử re-login...');
      const reloginResult = await autoRelogin();
      if (reloginResult) {
        notifyPopup({ type: 'KEEPALIVE_RELOGIN_OK' });
      } else {
        notifyPopup({ type: 'KEEPALIVE_RELOGIN_FAIL' });
      }
      return;
    }

    console.log(`[ĐGNL] Keepalive: OK (HTTP ${response.status})`);
    notifyPopup({ type: 'KEEPALIVE_OK' });
  } catch (err) {
    console.warn('[ĐGNL] Keepalive: ping lỗi:', err.message);
    // Server có thể nghẽn — không cần re-login ngay, chờ lần sau
  }
}

/* ──────────────────────────────────────────────
   4B-2. AUTO RE-LOGIN — Tự đăng nhập lại
   ────────────────────────────────────────────── */

/**
 * Tự động đăng nhập lại bằng CCCD + mật khẩu đã lưu.
 * Dùng khi session hết hạn trong lúc canh điểm.
 * @param {number} maxAttempts - Số lần thử tối đa
 * @returns {Promise<boolean>} - true nếu re-login thành công
 */
async function autoRelogin(maxAttempts = 5) {
  // Lấy credentials đã lưu
  const stored = await chrome.storage.local.get(CREDENTIALS_KEY);
  const creds = stored[CREDENTIALS_KEY];
  if (!creds || !creds.cccd || !creds.password) {
    console.warn('[ĐGNL] Auto re-login: không có credentials đã lưu.');
    return false;
  }

  console.log(`[ĐGNL] Auto re-login: thử đăng nhập lại (tối đa ${maxAttempts} lần)...`);
  notifyPopup({ type: 'AUTO_RELOGIN_START' });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Thêm jitter (delay ngẫu nhiên 2-10s) để tránh đồng loạt
      if (attempt > 1) {
        const jitter = Math.floor(Math.random() * 8000) + 2000;
        console.log(`[ĐGNL] Auto re-login: chờ ${jitter}ms trước lần thử ${attempt}...`);
        notifyPopup({
          type: 'AUTO_RELOGIN_RETRY',
          attempt,
          maxAttempts,
          waitMs: jitter,
        });
        await sleep(jitter);
      }

      const result = await handleAutoLogin(creds.cccd, creds.password);

      if (result && !result.error) {
        console.log(`[ĐGNL] Auto re-login: thành công sau lần thử ${attempt}!`);
        notifyPopup({ type: 'AUTO_RELOGIN_OK', attempt });
        return true;
      }

      console.warn(`[ĐGNL] Auto re-login lần ${attempt}: ${result?.error || 'unknown error'}`);
    } catch (err) {
      console.error(`[ĐGNL] Auto re-login lần ${attempt} lỗi:`, err);
    }
  }

  console.error(`[ĐGNL] Auto re-login: thất bại sau ${maxAttempts} lần.`);
  notifyPopup({ type: 'AUTO_RELOGIN_FAILED', maxAttempts });
  return false;
}

/* ──────────────────────────────────────────────
   4B-3. CHECK FOR NEW SCORE — Canh điểm
   ────────────────────────────────────────────── */

async function checkForNewScore() {
  const status = await getWatchStatus();
  if (!status || !status.active) return;

  status.lastCheck = Date.now();
  status.lastStatus = 'checking';
  status.checkCount = (status.checkCount || 0) + 1;
  await chrome.storage.local.set({ [STORAGE_KEY]: status });

  notifyPopup({
    type: 'WATCH_CHECKING',
    checkCount: status.checkCount,
  });

  let jsessionid = await getSession();

  // Nếu không có session → thử auto re-login thay vì dừng
  if (!jsessionid) {
    console.log('[ĐGNL] checkForNewScore: session hết hạn, thử auto re-login...');
    notifyPopup({ type: 'WATCH_RELOGIN', checkCount: status.checkCount });

    const reloginOk = await autoRelogin(3); // thử 3 lần nhanh

    if (reloginOk) {
      jsessionid = await getSession();
    }

    if (!jsessionid) {
      // Re-login thất bại → thông báo nhưng KHÔNG dừng canh điểm
      // Sẽ thử lại ở lần check tiếp theo
      status.lastStatus = 'relogin_failed';
      status.reloginCount = (status.reloginCount || 0) + 1;
      await chrome.storage.local.set({ [STORAGE_KEY]: status });

      notifyPopup({
        type: 'WATCH_RELOGIN_FAILED',
        checkCount: status.checkCount,
        reloginCount: status.reloginCount,
        nextCheckIn: status.intervalMinutes * 60,
      });

      // Chỉ thông báo nếu thất bại > 3 lần liên tiếp
      if (status.reloginCount >= 3) {
        chrome.notifications.create('dgnl-relogin-failed', {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'ĐGNL Nhanh — Đăng nhập lại thất bại',
          message: `Đã thử ${status.reloginCount} lần. Server có thể đang nghẽn. Vẫn đang tiếp tục canh...`,
        });
      }
      return;
    }

    // Re-login thành công → reset counter
    status.reloginCount = 0;
  }

  try {
    const data = await handleFetchScores();

    if (data.error) {
      // Nếu session expired trong lúc fetch → thử re-login
      if (data.error === 'SESSION_EXPIRED') {
        console.log('[ĐGNL] Session expired during fetch, will retry next check');
        status.lastStatus = 'session_expired';
      } else {
        status.lastStatus = 'error';
      }
      status.lastError = data.error;
      await chrome.storage.local.set({ [STORAGE_KEY]: status });
      notifyPopup({
        type: 'WATCH_ERROR',
        error: data.error,
        checkCount: status.checkCount,
      });
      return;
    }

    const scoreInfo = parseScoreData(data.scores);

    if (scoreInfo && scoreInfo.total > 0) {
      await onScoreFound(scoreInfo, data.profile);
    } else {
      status.lastStatus = 'no_score';
      status.reloginCount = 0; // Reset — session hoạt động tốt
      await chrome.storage.local.set({ [STORAGE_KEY]: status });
      notifyPopup({
        type: 'WATCH_NO_SCORE',
        checkCount: status.checkCount,
        nextCheckIn: status.intervalMinutes * 60,
      });
    }
  } catch (err) {
    console.error('[ĐGNL] checkForNewScore error:', err);
    status.lastStatus = 'error';
    status.lastError = String(err.message || err);
    await chrome.storage.local.set({ [STORAGE_KEY]: status });
  }
}

async function onScoreFound(scoreInfo, profile) {
  await stopWatching();

  await chrome.storage.local.set({
    [RESULT_KEY]: {
      scoreInfo,
      profile,
      foundAt: Date.now(),
    },
  });

  const rank = getRank(scoreInfo.total, scoreInfo.max);
  const name =
    profile?.data?.hoVaTen ||
    profile?.data?.fullName ||
    profile?.data?.hoTen ||
    profile?.hoVaTen ||
    profile?.fullName ||
    profile?.hoTen ||
    'Thí sinh';

  chrome.notifications.create('dgnl-score-found', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `🎉 Có điểm rồi! — ${scoreInfo.total}/${scoreInfo.max}`,
    message: `${name} — ${rank.label}. Click để xem chi tiết.`,
    requireInteraction: true,
    priority: 2,
  });

  chrome.action.setBadgeText({ text: String(scoreInfo.total) });
  chrome.action.setBadgeBackgroundColor({ color: '#1D4ED8' });

  // Gửi Discord notification (canh điểm tự động)
  sendDiscordNotification(scoreInfo, profile, '🔔 Canh điểm tự động').catch(e =>
    console.warn('[ĐGNL] Discord send error in onScoreFound:', e)
  );

  notifyPopup({
    type: 'SCORE_FOUND',
    scoreInfo,
    profile,
  });
}

chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId.startsWith('dgnl-')) {
    chrome.notifications.clear(notifId);
  }
});

/* ──────────────────────────────────────────────
   4A-X. FAST API LOGIN (CCCD + EMAIL) [DOM AUTOMATION]
   ────────────────────────────────────────────── */
async function handleFastApiLogin(cccd, email, sessionId) {
  console.log('[ĐGNL] Bắt đầu DOM Auto login với CCCD:', cccd, 'Email:', email, 'SessionID:', sessionId);
  let tabId = null;
  try {
    notifyPopup({ type: 'LOGIN_STEP', step: 'open', state: 'active', text: 'Đang mở luồng Tra cứu nhanh...' });

    // Mở trang Web tra cứu điểm public của Hệ thống (không cần đăng nhập)
    const tab = await chrome.tabs.create({
      url: `${BASE}/dgnl/search-result-exam`,
      active: false
    });
    tabId = tab.id;

    // Đợi trang load xong (để form và thư viện jQuery / ReCaptcha tải xong)
    await waitForTabLoad(tab.id, 10000);
    notifyPopup({ type: 'LOGIN_STEP', step: 'submit', state: 'active', text: 'Đang điền thông tin và xác minh...' });

    // Tiêm mã vào thế giới chính để thao tác DOM và chặn bắt Request gửi đi
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (c, e, sessionId) => {
        return new Promise((resolve) => {
          try {
            // 1. Gắn bẫy chặn Request (Monkey Patching XHR) để bắt cục JSON trả về
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url) {
              this.addEventListener("load", function () {
                if (url.includes("search-result-exam/")) {
                  try {
                    let data = JSON.parse(this.responseText);
                    resolve({ success: data });
                  } catch (ex) {
                    if (this.responseText.includes("Không tìm thấy")) {
                      resolve({ err: "Không tìm thấy hồ sơ hệ thống." });
                    } else {
                      resolve({ err: "Lỗi Server hoặc sai định dạng trả về." });
                    }
                  }
                }
              });
              originalOpen.apply(this, arguments);
            };

            // 2. Điền form y hệt người dùng
            const elSession = document.getElementById('cboDotDuThi');
            const elCccd = document.getElementById('txtSoBaoDanh');
            const elEmail = document.getElementById('txtEmail');
            const btnSubmit = document.getElementById('bntSearch');

            if (!elCccd || !elEmail || !btnSubmit) {
              resolve({ err: "Giao diện trang Web trường đã bị thay đổi, không điền được form." });
              return;
            }

            if (elSession && sessionId) {
              elSession.value = sessionId;
              elSession.dispatchEvent(new Event('change', { bubbles: true }));
            }
            elCccd.value = c;
            elCccd.dispatchEvent(new Event('input', { bubbles: true }));

            elEmail.value = e;
            elEmail.dispatchEvent(new Event('input', { bubbles: true }));

            btnSubmit.click();

            // 3. Dự phòng bắt Lỗi Giao Diện (Toast thông báo lỗi không tìm thấy Đợt Thi, Email sai định dạng...)
            const observer = new MutationObserver(() => {
              const toast = document.querySelector('.gritter-title') || document.querySelector('.gritter-item p');
              if (toast) {
                const txt = toast.innerText || toast.textContent;
                // Tránh bắt các thông báo không liên quan
                if (txt.includes("Không tìm thấy") || txt.includes("hợp lệ") || txt.includes("không") || txt.includes("chưa")) {
                  resolve({ err: txt });
                }
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            // Timeout an toàn sau 15 giây
            setTimeout(() => {
              resolve({ err: "Quá thời gian hồi đáp từ máy chủ ĐHQG (Timeout 15s)." });
            }, 15000);

          } catch (ext) {
            resolve({ err: "DOM Exception: " + String(ext) });
          }
        });
      },
      args: [cccd, email, sessionId]
    });

    await safeCloseTab(tabId);

    const res = results[0]?.result;

    // Phân tích kết quả
    if (!res || res.err) {
      console.warn("[ĐGNL] DOM Automation Error", res?.err);
      return { error: `Tra cứu lỗi: ${res?.err || 'Bị rào chắn Server từ chối.'}` };
    }

    const data = res.success;
    if (data.code && data.code !== 0) {
      return { error: data.msg || 'Máy chủ ĐHQG từ chối yêu cầu.' };
    }

    notifyPopup({ type: 'LOGIN_STEP', step: 'fetch', state: 'done', text: 'Hoàn tất!' });

    // Tách object thực tế chứa điểm
    const p = data.data || data;

    // Tạo cấu trúc tương tự để lưu Điểm
    const finalResult = {
      profile: data,
      scores: {
        data: [{
          tongDiem: p.diemTongKet || 0,
          diemToiDa: 1200,
          diemThanhPhan: [
            { tenThanhPhan: 'Tiếng Việt', diem: p.diemTiengViet },
            { tenThanhPhan: 'Tiếng Anh', diem: p.diemTiengAnh },
            { tenThanhPhan: 'Toán', diem: p.diemToan },
            { tenThanhPhan: 'Tư duy khoa học', diem: p.diemKhoaHocTuNhien }
          ]
        }]
      },
      timestamp: Date.now()
    };

    await saveLoginResult(finalResult);

    return finalResult;

  } catch (err) {
    if (tabId) await safeCloseTab(tabId);
    console.error('[ĐGNL] Fast API error:', err);
    return { error: `Lỗi bất ngờ ở chế độ Nhanh: ${err.message || String(err)}` };
  }
}

/* ──────────────────────────────────────────────
   4C. MESSAGE HANDLER
   ────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case 'FETCH_SCORES':
      handleFetchScores().then(sendResponse);
      return true;

    case 'AUTO_LOGIN':
      handleAutoLogin(msg.cccd, msg.password).then(sendResponse);
      return true;

    case 'FAST_API_LOGIN':
      handleFastApiLogin(msg.cccd, msg.email, msg.sessionId).then(sendResponse);
      return true;

    case 'GOOGLE_LOGIN':
      handleGoogleLogin().then(sendResponse);
      return true;

    case 'CANCEL_LOGIN':
      safeCloseTab(loginTabId);
      loginTabId = null;
      sendResponse({ ok: true });
      return false;

    case 'LOGOUT':
      handleLogout().then(sendResponse);
      return true;

    case 'WATCH_START':
      startWatching(msg.intervalMinutes || 2).then(sendResponse);
      return true;

    case 'WATCH_STOP':
      stopWatching().then(() => sendResponse({ ok: true }));
      return true;

    case 'WATCH_GET_STATUS':
      getWatchStatus().then(sendResponse);
      return true;

    case 'OPEN_LOGIN':
      chrome.tabs.create({
        url: `${BASE}/dgnl/auth/sign-in`,
      });
      sendResponse({ ok: true });
      return false;

    case 'PAGE_LOGIN_SUCCESS':
      // VĐ1: Content script thông báo user đã login trên web
      // → Fetch scores và lưu storage để popup tự hiển thị
      console.log('[ĐGNL] User logged in on page:', msg.url);
      handleFetchScores().then(async (data) => {
        if (data && !data.error) {
          await saveLoginResult(data);
          console.log('[ĐGNL] Đã fetch + lưu scores sau PAGE_LOGIN_SUCCESS');
          // Thông báo popup (nếu đang mở) để tự cập nhật
          notifyPopup({
            type: 'SCORE_FOUND',
            scoreInfo: parseScoreData(data.scores),
            profile: data.profile,
          });
        }
      }).catch(e => console.warn('[ĐGNL] Fetch sau PAGE_LOGIN_SUCCESS lỗi:', e));
      sendResponse({ ok: true });
      return false;

    case 'DISCORD_SAVE_CONFIG':
      saveDiscordConfig(msg.config).then(() => sendResponse({ ok: true }));
      return true;

    case 'DISCORD_GET_CONFIG':
      getDiscordConfig().then(sendResponse);
      return true;

    case 'DISCORD_TEST':
      sendDiscordTest(msg.webhookUrl).then(sendResponse);
      return true;

    case 'DISCORD_SEND_NOW': {
      // Gửi điểm hiện tại về Discord ngay lập tức
      chrome.storage.local.get(RESULT_KEY).then(async (stored) => {
        const saved = stored[RESULT_KEY];
        if (!saved || !saved.scoreInfo) {
          sendResponse({ ok: false, error: 'Chưa có điểm để gửi.' });
          return;
        }
        const result = await sendDiscordNotification(
          saved.scoreInfo,
          saved.profile,
          '📤 Gửi thủ công'
        );
        sendResponse(result);
      }).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    default:
      return false;
  }
});

/* ──────────────────────────────────────────────
   4D. PARSE SCORE DATA
   ────────────────────────────────────────────── */

function parseScoreData(scores) {
  if (!scores) return null;

  const d = scores.data || scores;

  function toNum(val) {
    return Number(val) || 0;
  }

  // Format 1 — kiểu tiếng Việt
  if (d && d.tongDiem != null && !Array.isArray(d)) {
    return {
      total: toNum(d.tongDiem),
      max: toNum(d.diemToiDa || 1200),
      sections: Array.isArray(d.diemThanhPhan)
        ? d.diemThanhPhan.map((s) => ({
          name: s.tenThanhPhan || s.ten || 'Phần',
          score: toNum(s.diem),
          maxScore: toNum(s.diemToiDa || 300),
        }))
        : [],
    };
  }

  // Format 2 — kiểu tiếng Anh
  if (d && d.totalScore != null && !Array.isArray(d)) {
    return {
      total: toNum(d.totalScore),
      max: toNum(d.maxScore || 1200),
      sections: Array.isArray(d.sections)
        ? d.sections.map((s) => ({
          name: s.name || s.sectionName || 'Section',
          score: toNum(s.score),
          maxScore: toNum(s.maxScore || 300),
        }))
        : [],
    };
  }

  // Format 3 — nested data
  if (d && d.data && !Array.isArray(d)) {
    const inner = d.data;
    if (inner.totalScore != null) {
      return {
        total: toNum(inner.totalScore),
        max: toNum(inner.maxScore || 1200),
        sections: Array.isArray(inner.sections)
          ? inner.sections.map((s) => ({
            name: s.name || 'Section',
            score: toNum(s.score),
            maxScore: toNum(s.maxScore || 300),
          }))
          : [],
      };
    }
    if (inner.tongDiem != null) {
      return {
        total: toNum(inner.tongDiem),
        max: toNum(inner.diemToiDa || 1200),
        sections: Array.isArray(inner.diemThanhPhan)
          ? inner.diemThanhPhan.map((s) => ({
            name: s.tenThanhPhan || 'Phần',
            score: toNum(s.diem),
            maxScore: toNum(s.diemToiDa || 300),
          }))
          : [],
      };
    }
  }

  // Format 4 — array top-level
  if (Array.isArray(d) && d.length > 0) {
    const first = d[0];
    if (first.score != null || first.tongDiem != null) {
      const total = toNum(first.score || first.tongDiem || 0);
      const max = toNum(first.maxScore || first.diemToiDa || 1200);
      return {
        total,
        max,
        sections: Array.isArray(first.sections || first.diemThanhPhan)
          ? (first.sections || first.diemThanhPhan).map((s) => ({
            name: s.name || s.tenThanhPhan || 'Phần',
            score: toNum(s.score || s.diem),
            maxScore: toNum(s.maxScore || s.diemToiDa || 300),
          }))
          : [],
      };
    }
    if (first.totalScore != null) {
      return {
        total: toNum(first.totalScore),
        max: toNum(first.maxScore || 1200),
        sections: Array.isArray(first.sections)
          ? first.sections.map((s) => ({
            name: s.name || 'Section',
            score: toNum(s.score),
            maxScore: toNum(s.maxScore || 300),
          }))
          : [],
      };
    }
  }

  return null;
}

/* ──────────────────────────────────────────────
   4E. DISCORD WEBHOOK NOTIFICATIONS
   ────────────────────────────────────────────── */

const DISCORD_CONFIG_KEY = 'dgnl_discord_config';

async function getDiscordConfig() {
  const result = await chrome.storage.local.get(DISCORD_CONFIG_KEY);
  return result[DISCORD_CONFIG_KEY] || { webhookUrl: '', enabled: false };
}

async function saveDiscordConfig(config) {
  await chrome.storage.local.set({ [DISCORD_CONFIG_KEY]: config });
}

/**
 * Gửi thông báo điểm tới Discord qua Webhook.
 * @param {Object} scoreInfo - { total, max, sections: [...] }
 * @param {Object} profile - profile data từ API
 * @param {string} [reason] - Lý do gửi (vd: "Canh điểm tự động", "Đăng nhập", "Gửi thủ công")
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendDiscordNotification(scoreInfo, profile, reason = 'Có điểm mới') {
  const config = await getDiscordConfig();
  if (!config.webhookUrl || !config.enabled) {
    console.log('[ĐGNL] Discord: bỏ qua — chưa cấu hình hoặc đã tắt.');
    return { ok: false, error: 'NOT_CONFIGURED' };
  }

  const name =
    profile?.data?.hoVaTen ||
    profile?.data?.fullName ||
    profile?.data?.hoTen ||
    profile?.hoVaTen ||
    profile?.fullName ||
    profile?.hoTen ||
    'Thí sinh';

  const rank = scoreInfo ? getRank(scoreInfo.total, scoreInfo.max) : null;

  // Màu embed theo rank
  const rankColors = {
    'XUẤT SẮC': 0x27ae60,  // xanh lá
    'GIỎI': 0x1a3c6e,      // xanh dương đậm
    'KHÁ': 0xe67e22,        // cam
    'TRUNG BÌNH': 0x95a5a6, // xám
  };
  const embedColor = rank ? (rankColors[rank.label] || 0x5865F2) : 0x5865F2;

  // Build fields cho từng phần điểm
  const sectionFields = [];
  if (scoreInfo?.sections?.length > 0) {
    scoreInfo.sections.forEach((sec) => {
      const bar = buildProgressBar(sec.score, sec.maxScore);
      sectionFields.push({
        name: sec.name,
        value: `${bar}  **${sec.score}** / ${sec.maxScore}`,
        inline: false,
      });
    });
  }

  // Thời gian VN
  const now = new Date();
  const timeStr = now.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const embed = {
    title: ' ĐGNL Nhanh — Có điểm!',
    color: embedColor,
    fields: [
      {
        name: ' Thí sinh',
        value: `**${name}**`,
        inline: true,
      },
      {
        name: ' Tổng điểm',
        value: scoreInfo ? `**${scoreInfo.total}** / ${scoreInfo.max}` : 'Chưa có',
        inline: true,
      },
      {
        name: ' Xếp hạng',
        value: rank ? `**${rank.label}**` : '—',
        inline: true,
      },
      ...(sectionFields.length > 0
        ? [{ name: '\u200B', value: ' **Chi tiết từng phần:**', inline: false }, ...sectionFields]
        : []),
    ],
    footer: {
      text: `${reason} • ${timeStr}`,
    }
  };

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'ĐGNL Nhanh',
        embeds: [embed],
      }),
    });

    if (response.ok || response.status === 204) {
      console.log('[ĐGNL] Discord: gửi thành công!');
      return { ok: true };
    } else {
      const text = await response.text().catch(() => '');
      console.error(`[ĐGNL] Discord: lỗi HTTP ${response.status}:`, text);
      return { ok: false, error: `HTTP ${response.status}` };
    }
  } catch (err) {
    console.error('[ĐGNL] Discord: lỗi gửi:', err);
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Gửi message test tới Discord.
 */
async function sendDiscordTest(webhookUrl) {
  const now = new Date();
  const timeStr = now.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const embed = {
    title: '✅ ĐGNL Nhanh — Kết nối thành công!',
    description: 'Webhook hoạt động bình thường. Khi có điểm sẽ được gửi về kênh này.',
    color: 0x27ae60,
    footer: {
      text: `Test lúc ${timeStr}`,
    },
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'ĐGNL Nhanh',
        embeds: [embed],
      }),
    });

    if (response.ok || response.status === 204) {
      return { ok: true };
    } else {
      return { ok: false, error: `HTTP ${response.status}` };
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Build a text-based progress bar for Discord embed.
 */
function buildProgressBar(score, maxScore) {
  const filled = maxScore > 0 ? Math.round((score / maxScore) * 10) : 0;
  const empty = 10 - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

// VĐ6: getRank() — thống nhất màu với popup.js
function getRank(total, max) {
  const pct = total / max;
  if (pct >= 0.85) {
    return { label: 'XUẤT SẮC', textColor: '#fff', bgColor: '#27ae60' };
  }
  if (pct >= 0.70) {
    return { label: 'GIỎI', textColor: '#fff', bgColor: '#1a3c6e' };
  }
  if (pct >= 0.55) {
    return { label: 'KHÁ', textColor: '#fff', bgColor: '#e67e22' };
  }
  return { label: 'TRUNG BÌNH', textColor: '#fff', bgColor: '#95a5a6' };
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { });
}

