// ScoreChecker Minimalist Popup JS

/* State */
let rawData = null;
let selectedInterval = 2;
let currentMode = 'fast';

async function fetchListRegistrations() {
  const sel = document.getElementById('input-session');
  if(!sel) return;
  try {
    const res = await fetch('https://thinangluc.vnuhcm.edu.vn/dgnl/api/public/v1/list-registrations');
    const data = await res.json();
    if (data && data.data) {
      sel.innerHTML = '';
      data.data.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = item.text;
        sel.appendChild(opt);
      });
      // Select the last one by default (usually latest session)
      if (data.data.length > 0) {
        sel.value = data.data[data.data.length - 1].id;
      }
    } else {
      sel.innerHTML = '<option value="">Lỗi tải đợt thi</option>';
    }
  } catch (e) {
    sel.innerHTML = '<option value="">Lỗi kết nối đợt thi</option>';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  fetchListRegistrations();

  // Bind settings modal
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('hidden');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.add('hidden');
  });

  // Tabs binding
  document.getElementById('tab-fast').addEventListener('click', () => switchMode('fast'));
  document.getElementById('tab-slow').addEventListener('click', () => switchMode('slow'));

  // Bind Login
  document.getElementById('btn-login-main').addEventListener('click', handleLoginClick);
  document.getElementById('btn-google-login').addEventListener('click', handleGoogleLogin);
  document.getElementById('btn-logout').addEventListener('click', handleLogout);
  document.getElementById('btn-refresh').addEventListener('click', () => {
    if (currentMode === 'fast') {
      handleLoginClick();
    } else {
      showScreen('loading');
      chrome.runtime.sendMessage({ type: 'FETCH_SCORES' }).then(res => {
        if (res && !res.error) {
          rawData = res;
          renderResults(res);
        } else {
          handleLogout();
        }
      });
    }
  });


  chrome.runtime.onMessage.addListener(handleBgMessage);

  // Try fetching score directly
  try {
    showScreen('loading');
    const stored = await chrome.storage.local.get(['dgnl_credentials', 'dgnl_fast_creds', 'dgnl_mode']);
    if (stored.dgnl_mode) switchMode(stored.dgnl_mode);

    if (stored.dgnl_credentials) {
      document.getElementById('input-cccd').value = stored.dgnl_credentials.cccd || '';
      document.getElementById('input-password').value = stored.dgnl_credentials.password || '';
    }
    if (stored.dgnl_fast_creds) {
      if (!document.getElementById('input-cccd').value) document.getElementById('input-cccd').value = stored.dgnl_fast_creds.cccd || '';
      document.getElementById('input-email').value = stored.dgnl_fast_creds.email || '';
    }

    const data = await chrome.runtime.sendMessage({ type: 'FETCH_SCORES' });
    if (!data || data.error) {
      showScreen('login');
    } else {
      rawData = data;
      renderResults(data);
    }
  } catch (err) {
    showScreen('login');
  }

  initSettingsGroup();
});

function switchMode(mode) {
  currentMode = mode;
  chrome.storage.local.set({ dgnl_mode: mode });
  const tabsContainer = document.querySelector('.tabs-container');
  const btnFast = document.getElementById('tab-fast');
  const btnSlow = document.getElementById('tab-slow');
  const grpEmail = document.getElementById('group-email');
  const grpPass = document.getElementById('group-password');
  const btnTxt = document.getElementById('btn-login-txt');
  const grpSession = document.getElementById('group-session');

  if (mode === 'fast') {
    tabsContainer.classList.remove('mode-slow');
    btnFast.classList.add('active');
    btnSlow.classList.remove('active');
    grpEmail.classList.remove('hidden');
    if(grpSession) grpSession.classList.remove('hidden');
    grpPass.classList.add('hidden');
    btnTxt.textContent = "Tra cứu";
  } else {
    tabsContainer.classList.add('mode-slow');
    btnSlow.classList.add('active');
    btnFast.classList.remove('active');
    grpPass.classList.remove('hidden');
    grpEmail.classList.add('hidden');
    if(grpSession) grpSession.classList.add('hidden');
    btnTxt.textContent = "Tra Cứu";
  }
}

async function handleLoginClick() {
  const cccd = document.getElementById('input-cccd').value.trim();
  if (!cccd) return showLoginError("Vui lòng nhập số CCCD");

  if (currentMode === 'fast') {
    const email = document.getElementById('input-email').value.trim();
    if (!email) return showLoginError("Chế độ Nhanh yêu cầu Email thi");

    const sessionId = document.getElementById('input-session') ? document.getElementById('input-session').value : null;

    await chrome.storage.local.set({ dgnl_fast_creds: { cccd, email } });
    showScreen('loading');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'FAST_API_LOGIN', cccd, email, sessionId });
      if (!result || result.error) {
        showScreen('login');
        showLoginError(result ? result.error : "Lỗi server API");
      } else {
        rawData = result;
        renderResults(result);
      }
    } catch (e) {
      showScreen('login');
      showLoginError("Lỗi giao tiếp Background!");
    }

  } else {
    const password = document.getElementById('input-password').value;
    if (!password) return showLoginError("Vui lòng nhập Mật khẩu hệ thống ĐGNL");

    await chrome.storage.local.set({ dgnl_credentials: { cccd, password } });
    showScreen('loading');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'AUTO_LOGIN', cccd, password });
      if (!result || result.error) {
        showScreen('login');
        showLoginError(result ? result.error : "Lỗi server tra cứu web");
      } else {
        rawData = result;
        renderResults(result);
      }
    } catch (e) {
      showScreen('login');
      showLoginError("Lỗi kết nối Timeout");
    }
  }
}

async function handleGoogleLogin() {
  showScreen('loading');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GOOGLE_LOGIN' });
    if (!result || result.error) {
      showScreen('login');
      showLoginError(result ? result.error : "Lỗi server gg login");
    } else {
      rawData = result;
      renderResults(result);
    }
  } catch (e) {
    showScreen('login');
    showLoginError("Lỗi kết nối gg");
  }
}

async function handleLogout() {
  rawData = null;
  await chrome.runtime.sendMessage({ type: 'LOGOUT' });
  showScreen('login');
}

function showScreen(screenId) {
  ['screen-login', 'screen-loading', 'screen-result'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  document.getElementById('screen-' + screenId).classList.remove('hidden');
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// Add the requested parseScoreData function to handle unified format
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
            maxScore: toNum(s.diemToiDa),
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
            maxScore: toNum(s.maxScore),
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
              maxScore: toNum(s.maxScore),
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
              maxScore: toNum(s.diemToiDa),
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
              maxScore: toNum(s.maxScore || s.diemToiDa),
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
              maxScore: toNum(s.maxScore),
            }))
          : [],
      };
    }
  }

  return null;
}

function renderResults(data) {
  const profile = data.profile || data;
  const name = (profile.data && (profile.data.hoVaTen || profile.data.fullName)) || profile.hoVaTen || "Thí sinh";
  document.getElementById('student-name').textContent = name;

  // Utilize the requested parseScoreData function
  const scoreInfo = parseScoreData(data.scores);
  
  const outEl = document.getElementById('score-total');
  const sectionsContainer = document.getElementById('score-sections');
  
  if (!scoreInfo || !scoreInfo.total || scoreInfo.total <= 0) {
    outEl.textContent = "--";
    sectionsContainer.classList.add('hidden');
    sectionsContainer.innerHTML = '';
  } else {
    outEl.textContent = scoreInfo.total;

    
    // RENDER THÀNH PHẦN
    if (scoreInfo.sections && scoreInfo.sections.length > 0) {
       sectionsContainer.innerHTML = '';
        scoreInfo.sections.forEach(sec => {
           const item = document.createElement('div');
           item.className = 'score-item';
           const maxStr = sec.maxScore > 0 ? sec.maxScore : '300';
           item.innerHTML = `
             <span class="sec-name">${sec.name}</span>
             <span class="sec-score"><strong>${sec.score}</strong> / ${maxStr}</span>
           `;
           
           // Click to reveal this section (removes CSS blur)
           item.addEventListener('click', () => {
             if (document.body.classList.contains('surprise-mode')) {
               item.classList.add('revealed');
             }
           });
           
           sectionsContainer.appendChild(item);
        });
       sectionsContainer.classList.remove('hidden');
    } else {
       sectionsContainer.classList.add('hidden');
       sectionsContainer.innerHTML = '';
    }
  }

  showScreen('result');
}



async function initSettingsGroup() {
  const watchToggle = document.getElementById('watch-toggle');
  const dToggle = document.getElementById('discord-toggle');
  const dWebhook = document.getElementById('input-webhook');
  const dSaveBtn = document.getElementById('btn-discord-save');
  const intervals = document.querySelectorAll('.iv');

  chrome.runtime.sendMessage({ type: 'WATCH_GET_STATUS' }).then(st => {
    if (st && st.active) {
      watchToggle.checked = true;
      selectedInterval = st.intervalMinutes || 2;
      updateIntervalUI();
    }
  });

  chrome.storage.local.get(['dgnl_discord_config']).then(st => {
    if (st.dgnl_discord_config) {
      dToggle.checked = st.dgnl_discord_config.enabled;
      dWebhook.value = st.dgnl_discord_config.webhookUrl || '';
    }
  });

  watchToggle.addEventListener('change', async (e) => {
    if (e.target.checked) {
      await chrome.runtime.sendMessage({ type: 'WATCH_START', intervalMinutes: selectedInterval });
    } else {
      await chrome.runtime.sendMessage({ type: 'WATCH_STOP' });
    }
  });

  intervals.forEach(btn => {
    btn.addEventListener('click', async () => {
      selectedInterval = Number(btn.dataset.minutes);
      updateIntervalUI();
      if (watchToggle.checked) {
        await chrome.runtime.sendMessage({ type: 'WATCH_STOP' });
        await chrome.runtime.sendMessage({ type: 'WATCH_START', intervalMinutes: selectedInterval });
      }
    });
  });

  function updateIntervalUI() {
    intervals.forEach(b => b.classList.toggle('active', Number(b.dataset.minutes) === selectedInterval));
  }

  dSaveBtn.addEventListener('click', () => {
    chrome.storage.local.set({
      dgnl_discord_config: {
        enabled: dToggle.checked,
        webhookUrl: dWebhook.value.trim()
      }
    });
    dSaveBtn.textContent = "Đã lưu!";
    setTimeout(() => dSaveBtn.textContent = "Lưu Webhook", 1000);
  });
}

function handleBgMessage(msg) { }

/* ═══════════════════════════════════════════
   SURPRISE MODE — Logic Nặn Điểm (Slide Panel)
   ═══════════════════════════════════════════ */

(function initSurpriseMode() {
  const STORAGE_KEY = 'dgnl_surprise_mode';
  const SNAP_THRESHOLD = 80; // px — kéo quá đây thì tấm bay luôn

  function setupSurpriseMode() {
    const toggle = document.getElementById('surprise-toggle');
    const cloudTotal = document.getElementById('cloud-total');
    const btnRevealAll = document.getElementById('btn-reveal-all');
    if (!toggle || !cloudTotal) return;

    // Thêm biểu tượng và chữ bên trong tấm che
    if (!cloudTotal.querySelector('.cover-icon')) {
      //const icon = document.createElement('span');
      //icon.className = 'cover-icon';
      //icon.textContent = '🎯';
      //cloudTotal.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'cover-label';
      label.textContent = 'Kéo để xem →';
      cloudTotal.appendChild(label);
    }

    // ── Load trạng thái đã lưu ──
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      if (result[STORAGE_KEY]) {
        toggle.checked = true;
        activateSurpriseMode();
      } else {
        toggle.checked = false;
        document.body.classList.remove('surprise-mode');
      }
    });

    // ── Toggle on/off ──
    toggle.addEventListener('change', () => {
      chrome.storage.local.set({ [STORAGE_KEY]: toggle.checked });
      if (toggle.checked) {
        activateSurpriseMode();
      } else {
        document.body.classList.remove('surprise-mode');
      }
    });

    function activateSurpriseMode() {
      document.body.classList.add('surprise-mode');
      // Reset tấm về vị trí ban đầu (đang che)
      cloudTotal.classList.remove('revealed');
      cloudTotal.style.transition = 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease';
      cloudTotal.style.transform = 'translateX(0px)';
      cloudTotal.style.opacity = '1';
      // Reset các chip điểm thành phần
      document.querySelectorAll('.score-item').forEach(c => c.classList.remove('revealed'));
    }

    // ── "Bật tung": tấm bay vụt sang phải ──
    btnRevealAll.addEventListener('click', () => {
      revealTotal();
      document.querySelectorAll('.score-item').forEach(c => c.classList.add('revealed'));
    });

    // ── Drag logic: tấm trượt THEO ngón tay sang phải ──
    let isDragging = false;
    let startX = 0;
    let currentDragX = 0;

    cloudTotal.addEventListener('pointerdown', (e) => {
      if (!document.body.classList.contains('surprise-mode')) return;
      if (cloudTotal.classList.contains('revealed')) return;
      isDragging = true;
      startX = e.clientX;
      currentDragX = 0;
      cloudTotal.setPointerCapture(e.pointerId);
      // Tắt transition khi đang kéo để tấm đi theo ngay lập tức (60fps)
      cloudTotal.style.transition = 'none';
      cloudTotal.style.cursor = 'grabbing';
      e.preventDefault();
    });

    cloudTotal.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      // Chỉ cho kéo SANG PHẢI (dx > 0)
      const dx = e.clientX - startX;
      currentDragX = Math.max(0, dx);
      cloudTotal.style.transform = `translateX(${currentDragX}px)`;
    });

    cloudTotal.addEventListener('pointerup', () => {
      if (!isDragging) return;
      isDragging = false;
      cloudTotal.style.cursor = 'grab';
      // Bật lại transition cho animation snap
      cloudTotal.style.transition = 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease';

      if (currentDragX >= SNAP_THRESHOLD) {
        // Kéo đủ xa → tấm bay tiếp ra ngoài màn hình
        revealTotal();
      } else {
        // Kéo chưa đủ → tấm bật về chỗ cũ
        cloudTotal.style.transform = 'translateX(0px)';
      }
    });

    cloudTotal.addEventListener('pointercancel', () => {
      isDragging = false;
      cloudTotal.style.transition = 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
      cloudTotal.style.transform = 'translateX(0px)';
    });
  }

  // Slide tấm ra ngoài hoàn toàn
  function revealTotal() {
    const cloudTotal = document.getElementById('cloud-total');
    if (!cloudTotal) return;
    cloudTotal.style.transition = 'transform 0.45s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.35s ease';
    cloudTotal.classList.add('revealed');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSurpriseMode);
  } else {
    setupSurpriseMode();
  }
})();


