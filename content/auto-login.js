/* ═══════════════════════════════════════════════
   ĐGNL Nhanh — Content Script (Auto-Login)
   Chạy trên https://thinangluc.vnuhcm.edu.vn/*
   ═══════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ── Lắng nghe message từ Service Worker ── */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    switch (msg.type) {
      case 'FILL_LOGIN':
        performLogin(msg.cccd, msg.password)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ error: String(err.message || err) }));
        return true;

      case 'CHECK_LOGIN_STATUS':
        sendResponse(checkCurrentPage());
        return false;

      case 'FETCH_DATA_FROM_PAGE':
        fetchDataFromPage()
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ error: String(err.message || err) }));
        return true;

      default:
        return false;
    }
  });

  /* ── Kiểm tra trang hiện tại ── */
  function checkCurrentPage() {
    const url = window.location.href;
    if (url.includes('/app/home') || url.includes('/app/v1/home') || url.includes('/app/v1/event-history')) {
      return { status: 'LOGGED_IN', url };
    }
    if (url.includes('/auth/sign-in') || url.includes('/app/login')) {
      return { status: 'LOGIN_PAGE', url };
    }
    return { status: 'UNKNOWN', url };
  }

  /* ── Lấy dữ liệu trực tiếp từ trang đã đăng nhập ── */
  async function fetchDataFromPage() {
    console.log('[ĐGNL Content] Lấy dữ liệu trực tiếp từ trang...');

    const base = window.location.origin;
    let profile = null;
    let scores = null;

    // Lấy profile
    try {
      const res = await fetch(base + '/dgnl/api/profile/v1/get-profile/HOME', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        profile = await res.json();
        console.log('[ĐGNL Content] Profile:', profile);
      }
    } catch (e) {
      console.warn('[ĐGNL Content] Lỗi lấy profile:', e);
    }

    // Lấy điểm — thử nhiều endpoint
    const scoreEndpoints = [
      '/dgnl/api/app/v1/search-result-test-info',  // API chính thức tra điểm
      '/dgnl/api/score/v1/my-score',
      '/dgnl/api/score/v1/get-my-score',
      '/dgnl/api/score/v1/result',
      '/dgnl/api/result/v1/my-result',
      '/dgnl/api/thi-sinh/v1/ket-qua',
      '/dgnl/api/thi-sinh/v1/diem-thi',
      '/dgnl/api/profile/v1/get-score',
      '/dgnl/api/profile/v1/get-result',
      '/dgnl/api/list-reg-documents',
    ];

    for (const endpoint of scoreEndpoints) {
      try {
        const res = await fetch(base + endpoint, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        });
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            console.log('[ĐGNL Content]', endpoint, 'trả về', contentType, '— bỏ qua');
            continue;
          }
          let data;
          try {
            data = await res.json();
          } catch (parseErr) {
            console.warn('[ĐGNL Content]', endpoint, 'JSON parse lỗi:', parseErr.message);
            continue;
          }
          console.log('[ĐGNL Content] Score endpoint OK:', endpoint, data);
          scores = { endpoint, data };
          break;
        }
      } catch (e) {
        // next endpoint
      }
    }

    return { profile, scores };
  }

  /* ── Thực hiện đăng nhập ── */
  async function performLogin(cccd, password) {
    console.log('[ĐGNL Content] Bắt đầu auto-login...');
    console.log('[ĐGNL Content] URL hiện tại:', window.location.href);

    // Log tất cả input trên trang
    const debugInputs = document.querySelectorAll('input');
    console.log('[ĐGNL Content] Số lượng input trên trang:', debugInputs.length);
    debugInputs.forEach((inp, i) => {
      console.log(`  input[${i}]: id="${inp.id}" name="${inp.name}" type="${inp.type}" placeholder="${inp.placeholder}"`);
    });

    // 1. Chờ form xuất hiện
    const usernameInput = await waitForElement([
      '#username',
      'input[name="username"]',
      'input[placeholder*="CCCD"]',
      'input[placeholder*="căn cước"]',
      'input[placeholder*="CMND"]',
      'input[type="text"]',
    ], 10000);

    if (!usernameInput) {
      return { error: 'Không tìm thấy ô nhập CCCD. Trang có ' + debugInputs.length + ' input.' };
    }
    console.log('[ĐGNL Content] Username input:', usernameInput.id || usernameInput.name);

    const passwordInput = await waitForElement([
      '#password',
      'input[name="password"]',
      'input[type="password"]',
      'input[placeholder*="khẩu"]',
      'input[placeholder*="Mật"]',
      'input[placeholder*="Password"]',
    ], 5000);

    let pwInput = passwordInput;
    if (!pwInput) {
      // Fallback: tìm input thứ 2
      const allInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])');
      for (const inp of allInputs) {
        if (inp !== usernameInput && !inp.id.includes('captcha')) {
          pwInput = inp;
          break;
        }
      }
    }

    if (!pwInput) {
      return { error: 'Không tìm thấy ô nhập mật khẩu.' };
    }
    console.log('[ĐGNL Content] Password input:', pwInput.id || pwInput.name || pwInput.type);

    return await fillAndSubmit(usernameInput, pwInput, cccd, password);
  }

  /* ── Điền form và submit ── */
  async function fillAndSubmit(usernameInput, passwordInput, cccd, password) {
    // 1. Điền CCCD
    usernameInput.focus();
    usernameInput.value = '';
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await delay(100);
    await simulateTyping(usernameInput, cccd);
    await delay(150);

    // 2. Điền mật khẩu
    passwordInput.focus();
    passwordInput.value = '';
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    await delay(100);
    await simulateTyping(passwordInput, password);
    await delay(200);

    // 3. Tìm và click nút đăng nhập
    const submitBtn = findElement([
      '#btnSignIn',
      'button[type="submit"]',
      'button.btn-primary',
      'button.btn-login',
    ]);

    if (!submitBtn) {
      const form = usernameInput.closest('form');
      if (form) {
        form.submit();
      } else {
        return { error: 'Không tìm thấy nút đăng nhập.' };
      }
    } else {
      console.log('[ĐGNL Content] Click:', submitBtn.textContent?.trim().substring(0, 30));
      submitBtn.click();
    }

    return await waitForLoginResult();
  }

  /* ── Chờ element xuất hiện ── */
  function waitForElement(selectors, timeoutMs) {
    return new Promise((resolve) => {
      const found = findElement(selectors);
      if (found) { resolve(found); return; }

      let elapsed = 0;
      const interval = 200; // Nhanh hơn: 200ms thay vì 300ms
      const timer = setInterval(() => {
        elapsed += interval;
        const el = findElement(selectors);
        if (el) {
          clearInterval(timer);
          resolve(el);
          return;
        }
        if (elapsed >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, interval);
    });
  }

  /* ── Simulate typing ── */
  async function simulateTyping(input, text) {
    input.focus();
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: char, code: `Key${char.toUpperCase()}`, bubbles: true, cancelable: true,
      }));
      input.value += char;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', {
        key: char, code: `Key${char.toUpperCase()}`, bubbles: true, cancelable: true,
      }));
      await delay(15 + Math.random() * 20); // Nhanh hơn: 15-35ms thay vì 30-80ms
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ── Chờ kết quả login ── */
  function waitForLoginResult() {
    return new Promise((resolve) => {
      let checks = 0;
      const maxChecks = 40; // Nhiều lần hơn nhưng nhanh hơn

      const interval = setInterval(() => {
        checks++;
        const url = window.location.href;

        if (url.includes('/app/home') || url.includes('/app/v1/home') || url.includes('/app/v1/event-history')) {
          clearInterval(interval);
          console.log('[ĐGNL Content] Đăng nhập thành công! URL:', url);
          resolve({ success: true, url });
          return;
        }

        const errorEl = findElement([
          '.alert-danger',
          '.error-message',
          '.text-danger',
          '.invalid-feedback',
          '[role="alert"]',
        ]);

        if (errorEl && errorEl.textContent.trim().length > 3 && errorEl.offsetParent !== null) {
          clearInterval(interval);
          resolve({ error: errorEl.textContent.trim() });
          return;
        }

        if (checks >= maxChecks) {
          clearInterval(interval);
          resolve({ error: 'Timeout — không nhận được phản hồi sau 12 giây.' });
        }
      }, 300); // Nhanh hơn: 300ms thay vì 500ms → tổng 12s
    });
  }

  /* ── Helpers ── */
  function findElement(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (e) { /* skip */ }
    }
    return null;
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ── Auto-notify extension khi user ở trang đã login ── */
  const url = window.location.href;
  if (url.includes('/app/home') || url.includes('/app/v1/home') || url.includes('/app/v1/event-history')) {
    chrome.runtime.sendMessage({ type: 'PAGE_LOGIN_SUCCESS', url }).catch(() => {});
  }
})();
