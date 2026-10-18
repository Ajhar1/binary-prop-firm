// Binary Prop Firm - Quotex Trade Synchronizer Content Script v1.0.6
// Enhanced: 7-Layer Quotex Account ID Verification Engine, Timezone Auto-Detection, Turbo 5s Support
(function () {
  let config = {
    traderId: '',
    serverUrl: 'https://binarypropfirm.com',
    autoSync: true,
    brokerTzOffsetMin: null, // in minutes, e.g. -360 for UTC-6, +360 for UTC+6
    brokerTzStr: 'UTC'
  };

  const syncedTicketsCache = new Set();
  let isSyncing = false;
  let heartbeatTimer = null;
  let tzScanTimer = null;

  // Quotex Account Verification State
  let detectedQuotexAccountId = null;
  let currentRegisteredBrokerAccountId = '';
  let isAccountIdMismatch = false;
  let lastIdScanTime = 0;

  // 1. Load config from chrome.storage.local
  function loadConfig(cb) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get([
        'traderId',
        'serverUrl',
        'autoSync',
        'syncedCache',
        'quotex_broker_tz_offset_min',
        'quotex_broker_tz_str',
        'quotex_registered_broker_id',
        'quotex_detected_account_id'
      ], (res) => {
        if (res.traderId) config.traderId = res.traderId;
        if (res.serverUrl) config.serverUrl = res.serverUrl;
        if (res.autoSync !== undefined) config.autoSync = res.autoSync;
        if (typeof res.quotex_broker_tz_offset_min === 'number') {
          config.brokerTzOffsetMin = res.quotex_broker_tz_offset_min;
        }
        if (res.quotex_broker_tz_str) {
          config.brokerTzStr = res.quotex_broker_tz_str;
        }
        if (res.quotex_registered_broker_id) {
          currentRegisteredBrokerAccountId = res.quotex_registered_broker_id;
        }
        if (res.quotex_detected_account_id) {
          detectedQuotexAccountId = res.quotex_detected_account_id;
        }
        if (Array.isArray(res.syncedCache)) {
          res.syncedCache.forEach(id => syncedTicketsCache.add(id));
        }
        if (cb) cb();
      });
    } else if (cb) {
      cb();
    }
  }

  function saveSyncedCache() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const arr = Array.from(syncedTicketsCache).slice(-600);
      chrome.storage.local.set({ syncedCache: arr });
    }
  }

  function saveBrokerTz(offsetMin, tzStr) {
    config.brokerTzOffsetMin = offsetMin;
    config.brokerTzStr = tzStr;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        quotex_broker_tz_offset_min: offsetMin,
        quotex_broker_tz_str: tzStr
      });
    }
    updateWidgetStatus();
  }

  // 2. Universal Broker Timezone Auto-Detection Engine
  function parseUtcOffsetString(str) {
    if (!str) return null;
    // Matches: UTC-6, UTC -6, UTC+06:00, UTC+5:30, GMT-6, UTC+6.5, UTC-05:00
    const m = String(str).match(/(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::(\d{2})|\.(\d+))?/i);
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    const hours = parseInt(m[2], 10);
    let minutes = 0;
    if (m[3]) {
      minutes = parseInt(m[3], 10);
    } else if (m[4]) {
      minutes = Math.round(parseFloat('0.' + m[4]) * 60);
    }
    return sign * (hours * 60 + minutes);
  }

  function getOffsetMinutesFromIana(tzName) {
    try {
      const now = new Date();
      const invDate = new Date(now.toLocaleString('en-US', { timeZone: tzName }));
      return Math.round((invDate.getTime() - now.getTime()) / 60000);
    } catch (e) {
      return null;
    }
  }

  function scanQuotexBrokerTimezone() {
    try {
      // Method A: Check header, clock, profile bar, or top-bar elements
      const targetEls = document.querySelectorAll('header, .header, .top-bar, [class*="header"], [class*="time"], [class*="clock"], [class*="profile"]');
      for (const el of targetEls) {
        const text = el.innerText || '';
        const offsetMin = parseUtcOffsetString(text);
        if (offsetMin !== null) {
          const m = text.match(/(?:UTC|GMT)\s*[+-]\s*\d{1,2}(?::\d{2})?/i);
          const tzStr = m ? m[0].toUpperCase().replace(/\s+/g, '') : `UTC${offsetMin >= 0 ? '+' : ''}${Math.round(offsetMin / 60)}`;
          saveBrokerTz(offsetMin, tzStr);
          return offsetMin;
        }
      }

      // Method B: Check Quotex LocalStorage preferences
      try {
        const keys = ['time_zone', 'timezone', 'settings', 'user_settings', 'profile', 'app_state'];
        for (const k of keys) {
          const val = localStorage.getItem(k);
          if (!val) continue;
          const offsetMin = parseUtcOffsetString(val);
          if (offsetMin !== null) {
            saveBrokerTz(offsetMin, `UTC${offsetMin >= 0 ? '+' : ''}${Math.round(offsetMin / 60)}`);
            return offsetMin;
          }
          const ianaMatch = val.match(/([A-Za-z]+(?:\/[A-Za-z_]+)+)/);
          if (ianaMatch) {
            const min = getOffsetMinutesFromIana(ianaMatch[1]);
            if (min !== null) {
              saveBrokerTz(min, `UTC${min >= 0 ? '+' : ''}${Math.round(min / 60)}`);
              return min;
            }
          }
        }
      } catch (e) {}

      // Method C: Search first 4000 characters of body text
      const bodyText = (document.body && document.body.innerText ? document.body.innerText.substring(0, 4000) : '');
      const bodyOffsetMin = parseUtcOffsetString(bodyText);
      if (bodyOffsetMin !== null) {
        const m = bodyText.match(/(?:UTC|GMT)\s*[+-]\s*\d{1,2}(?::\d{2})?/i);
        const tzStr = m ? m[0].toUpperCase().replace(/\s+/g, '') : `UTC${bodyOffsetMin >= 0 ? '+' : ''}${Math.round(bodyOffsetMin / 60)}`;
        saveBrokerTz(bodyOffsetMin, tzStr);
        return bodyOffsetMin;
      }
    } catch (err) {}

    // Method D: If already loaded from chrome.storage, keep it
    if (config.brokerTzOffsetMin !== null) {
      return config.brokerTzOffsetMin;
    }

    return null;
  }

  // 2.1 Quotex Account ID Auto-Detection & Verification Engine (7-Layer Resilient System)
  async function scanQuotexAccountId(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && detectedQuotexAccountId && (now - lastIdScanTime < 45000)) {
      return detectedQuotexAccountId;
    }

    // Helper: Validate and persist detected ID
    const commitId = (idStr) => {
      const clean = String(idStr || '').replace(/[^0-9]/g, '');
      if (clean && clean.length >= 5 && clean.length <= 12) {
        detectedQuotexAccountId = clean;
        lastIdScanTime = Date.now();
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ quotex_detected_account_id: clean });
        }
        updateWidgetStatus();
        return clean;
      }
      return null;
    };

    // Helper: JWT Payload Extractor
    const extractIdFromJwt = (token) => {
      try {
        if (!token || typeof token !== 'string' || !token.includes('.')) return null;
        const parts = token.split('.');
        if (parts.length >= 2) {
          const payloadStr = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
          const rm = payloadStr.match(/"(?:id|userId|user_id|accountId|account_id|sub)"\s*:\s*"?(\d{5,12})"?/i);
          if (rm && rm[1]) return String(rm[1]);
          const payload = JSON.parse(payloadStr);
          const candidate = payload.id || payload.userId || payload.user_id || payload.sub || payload.account_id || payload.accountId;
          if (candidate && /^\d{5,12}$/.test(String(candidate))) {
            return String(candidate);
          }
        }
      } catch (e) {}
      return null;
    };

    // Strategy 1: Check Active DOM elements (Leaf nodes, short texts, data-attributes, and body)
    try {
      const userEl = document.querySelector('[data-user-id], [data-id], [data-account-id], [data-account]');
      if (userEl) {
        const uid = userEl.getAttribute('data-user-id') || userEl.getAttribute('data-account-id') || userEl.getAttribute('data-id');
        if (uid && commitId(uid)) return detectedQuotexAccountId;
      }

      const allElements = document.querySelectorAll('div, span, p, strong, b, h1, h2, h3, h4, h5, li, a, td');
      for (const el of allElements) {
        if (el.children.length > 2) continue;
        const t = (el.innerText || '').replace(/[\u00a0\r\n\t]/g, ' ').trim();
        if (t && t.length < 60 && /\bID\s*[:#]?\s*\d{5,12}\b/i.test(t)) {
          const m = t.match(/\bID\s*[:#]?\s*(\d{5,12})\b/i);
          if (m && commitId(m[1])) return detectedQuotexAccountId;
        }
      }

      const bodyText = (document.body ? document.body.innerText : '').replace(/[\u00a0\r\n\t]/g, ' ');
      const bodyMatch = bodyText.match(/\bID\s*[:#]?\s*(\d{5,12})\b/i);
      if (bodyMatch && commitId(bodyMatch[1])) return detectedQuotexAccountId;
    } catch (e) {}

    // Strategy 2: Check chrome.storage.local (Immediate retrieval if already captured previously)
    if (detectedQuotexAccountId && !forceRefresh) {
      return detectedQuotexAccountId;
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        const stored = await new Promise(res => chrome.storage.local.get(['quotex_detected_account_id'], res));
        if (stored && stored.quotex_detected_account_id) {
          if (commitId(stored.quotex_detected_account_id)) return detectedQuotexAccountId;
        }
      } catch (e) {}
    }

    // Strategy 3: Deep Scan LocalStorage & SessionStorage (including JWT tokens & JSON)
    try {
      const storages = [localStorage, sessionStorage];
      for (const store of storages) {
        if (!store) continue;
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (!k) continue;
          const v = store.getItem(k);
          if (!v) continue;

          if (/id/i.test(k) && /^\d{5,12}$/.test(v.trim())) {
            if (commitId(v.trim())) return detectedQuotexAccountId;
          }

          if (v.includes('eyJ')) {
            const jwtMatches = v.match(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g);
            if (jwtMatches) {
              for (const token of jwtMatches) {
                const jId = extractIdFromJwt(token);
                if (jId && commitId(jId)) return detectedQuotexAccountId;
              }
            }
          }

          const jm = v.match(/"(?:id|userId|user_id|accountId|account_id|trader_id|traderId)"\s*:\s*"?(\d{5,12})"?/i);
          if (jm && jm[1] && commitId(jm[1])) return detectedQuotexAccountId;
        }
      }
    } catch (e) {}

    // Strategy 4: Check document.cookie for ID or JWT tokens
    try {
      const cookieStr = document.cookie || '';
      const cookieIdMatch = cookieStr.match(/\b(?:user_id|userId|uid|account_id|id)\s*=\s*(\d{5,12})\b/i);
      if (cookieIdMatch && commitId(cookieIdMatch[1])) return detectedQuotexAccountId;

      const cookieJwt = cookieStr.match(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g);
      if (cookieJwt) {
        for (const token of cookieJwt) {
          const jId = extractIdFromJwt(token);
          if (jId && commitId(jId)) return detectedQuotexAccountId;
        }
      }
    } catch (e) {}

    // Strategy 5: Inline script search for state configs
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (txt.includes('id') || txt.includes('user')) {
          const sm = txt.match(/(?:["']?(?:id|userId|user_id|accountId|account_id)["']?\s*[:=]\s*["']?(\d{5,12})["']?)/i);
          if (sm && sm[1] && commitId(sm[1])) return detectedQuotexAccountId;
        }
      }
    } catch (e) {}

    // Strategy 6: Dynamic Hidden Sandbox Iframe to /en/settings (Executes Quotex SPA to render ID)
    if (!detectedQuotexAccountId && !window.location.pathname.includes('/settings')) {
      try {
        const iframeId = 'bpf-settings-scanner-frame';
        let frame = document.getElementById(iframeId);
        if (!frame) {
          frame = document.createElement('iframe');
          frame.id = iframeId;
          frame.src = `${window.location.origin}/en/settings`;
          frame.style.cssText = 'position:fixed; width:1px; height:1px; top:-9999px; left:-9999px; opacity:0; pointer-events:none; border:none; z-index:-1;';
          document.body.appendChild(frame);
        }

        const startT = Date.now();
        while (Date.now() - startT < 4000) {
          try {
            if (frame.contentDocument && frame.contentDocument.body) {
              const frameText = (frame.contentDocument.body.innerText || '').replace(/[\u00a0\r\n\t]/g, ' ');
              const m = frameText.match(/\bID\s*[:#]?\s*(\d{5,12})\b/i);
              if (m && commitId(m[1])) {
                try { frame.remove(); } catch(e){}
                return detectedQuotexAccountId;
              }
            }
          } catch (fErr) {}
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (e) {}
    }

    return detectedQuotexAccountId;
  }

  // Live Mutation Observer to auto-capture ID as soon as SPA finishes rendering
  function initLiveDomIdObserver() {
    const checkDomForId = () => {
      try {
        const bodyText = (document.body ? document.body.innerText : '').replace(/[\u00a0\r\n\t]/g, ' ');
        if (bodyText) {
          const m = bodyText.match(/\bID\s*[:#]?\s*(\d{5,12})\b/i);
          if (m && m[1]) {
            const clean = m[1].replace(/[^0-9]/g, '');
            if (clean && clean !== detectedQuotexAccountId) {
              const prev = detectedQuotexAccountId;
              detectedQuotexAccountId = clean;
              lastIdScanTime = Date.now();
              if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ quotex_detected_account_id: clean });
              }
              updateWidgetStatus();
              if (!prev && currentRegisteredBrokerAccountId && clean === currentRegisteredBrokerAccountId.replace(/[^0-9]/g, '')) {
                showToast(`✅ Quotex Account ID [${clean}] সফলভাবে ভেরিফাই ও সেভ হয়েছে!`, 'success');
              }
            }
          }
        }
      } catch (e) {}
    };

    checkDomForId();
    if (document.body) {
      const observer = new MutationObserver(() => checkDomForId());
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function verifyQuotexAccountIdMatch(detectedId, registeredId) {
    const cleanReg = (registeredId || currentRegisteredBrokerAccountId || '').replace(/[^0-9]/g, '');
    const cleanDet = (detectedId || detectedQuotexAccountId || '').replace(/[^0-9]/g, '');

    // If challenge has a registered Quotex Account ID:
    if (cleanReg) {
      if (!cleanDet) {
        isAccountIdMismatch = true;
        return { isMismatch: true, missingDetected: true, cleanReg, cleanDet: '' };
      }
      if (cleanReg !== cleanDet) {
        isAccountIdMismatch = true;
        return { isMismatch: true, cleanReg, cleanDet };
      }
      isAccountIdMismatch = false;
      return { isMismatch: false, verified: true, cleanReg, cleanDet };
    }

    return { isMismatch: false, verified: false, cleanReg, cleanDet };
  }

  function showAccountMismatchModal(registeredId, currentId) {
    const existing = document.getElementById('bpf-mismatch-modal-overlay');
    if (existing) existing.remove();

    const cleanReg = String(registeredId || currentRegisteredBrokerAccountId || 'Not Set').replace(/[^0-9]/g, '') || registeredId || 'Not Set';
    const cleanDet = String(currentId || detectedQuotexAccountId || '').replace(/[^0-9]/g, '');
    const isMissing = !cleanDet;

    const overlay = document.createElement('div');
    overlay.id = 'bpf-mismatch-modal-overlay';
    overlay.className = 'bpf-modal-overlay';

    overlay.innerHTML = `
      <div class="bpf-modal-card" role="dialog" aria-modal="true">
        <div class="bpf-modal-header">
          <div class="bpf-modal-icon-wrap">${isMissing ? '🔍' : '⚠️'}</div>
          <div>
            <h3 class="bpf-modal-title">${isMissing ? 'Quotex ID ভেরিফাই প্রয়োজন' : 'Quotex Account ID মিলছে না!'}</h3>
            <span class="bpf-modal-badge-blocked" style="${isMissing ? 'background:rgba(255,184,0,0.15)!important; color:#fbbf24!important; border-color:rgba(255,184,0,0.4)!important;' : ''}">
              ${isMissing ? '⏳ Verification Pending' : '🚫 Trade Sync Blocked'}
            </span>
          </div>
        </div>
        <div class="bpf-modal-body">
          <p style="margin:0 0 10px 0;">
            ${isMissing
              ? `আপনার চ্যালেঞ্জটি Quotex ID: <strong>[${cleanReg}]</strong> এর সাথে যুক্ত। ট্রেড সিঙ্ক চালু করতে এক্সটেনশনকে একবার আপনার Quotex ID ভেরিফাই করতে হবে।`
              : `আপনার চ্যালেঞ্জটি নির্দিষ্ট করা Quotex অ্যাকাউন্টের সাথে যুক্ত। আপনি বর্তমানে যে Quotex অ্যাকাউন্টে লগইন করে আছেন, সেটির ID আপনার চ্যালেঞ্জের রেজিস্ট্রার্ড ID-র সাথে মিলছে না।`
            }
          </p>
          <div class="bpf-modal-id-grid">
            <div class="bpf-modal-id-box registered">
              <div class="bpf-modal-id-label">রেজিস্ট্রার্ড Quotex ID</div>
              <div class="bpf-modal-id-val">${cleanReg}</div>
            </div>
            <div class="bpf-modal-id-box current">
              <div class="bpf-modal-id-label">${isMissing ? 'সনাক্তকরণ স্ট্যাটাস' : 'বর্তমান লগইনকৃত ID'}</div>
              <div class="bpf-modal-id-val" style="${isMissing ? 'color:#fbbf24;' : ''}">${cleanDet || 'Not Detected'}</div>
            </div>
          </div>
          <div class="bpf-modal-notice" style="${isMissing ? 'background:rgba(255,184,0,0.08)!important; border-left-color:#fbbf24!important;' : ''}">
            ${isMissing
              ? `💡 <strong>সহজ সমাধান:</strong> নিচের <strong>"⚙️ Quotex Settings পেজে যান"</strong> বাটনে চাপ দিন। Settings পেজটি ওপেন হওয়ামাত্র এক্সটেনশন স্বয়ংক্রিয়ভাবে আপনার ID পড়ে পার্মানেন্টলি সেভ করে নেবে, এরপর আর কখনোই এটি করতে হবে না।`
              : `⚠️ <strong>নিরাপত্তা সতর্কতা:</strong> অন্য কোনো অ্যাকাউন্ট থেকে নেওয়া ট্রেড আপনার চ্যালেঞ্জে গ্রহণযোগ্য নয়। সঠিক Quotex অ্যাকাউন্টে লগইন করার পর পুনরায় সিঙ্ক করুন।`
            }
          </div>
        </div>
        <div class="bpf-modal-actions">
          <button class="bpf-modal-btn bpf-modal-btn-sec" id="bpfCloseMismatchModal">
            বন্ধ করুন
          </button>
          <button class="bpf-modal-btn bpf-modal-btn-pri" id="bpfOpenSettingsBtn" style="${isMissing ? 'background:linear-gradient(135deg,#f59e0b 0%,#d97706 100%)!important; box-shadow:0 4px 14px rgba(245,158,11,0.4)!important;' : ''}">
            ⚙️ Quotex Settings পেজে যান (১ ক্লিকে ভেরিফাই)
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const closeModal = () => {
      if (overlay && overlay.parentNode) overlay.remove();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    const closeBtn = document.getElementById('bpfCloseMismatchModal');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    const settingsBtn = document.getElementById('bpfOpenSettingsBtn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        closeModal();
        window.location.href = `${window.location.origin}/en/settings`;
      });
    }
  }

  // 3. Robust Trade Timestamp Parser in Absolute UTC Epoch Milliseconds
  function parseQuotexTimestampInUtc(str, brokerOffsetMin) {
    if (!str) return 0;
    const clean = String(str).trim();

    // 1. Format: DD[/.-]MM[/.-]YYYY[,] HH:mm:ss
    const mDmy = clean.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})(?:,?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (mDmy) {
      let day = parseInt(mDmy[1], 10);
      let month = parseInt(mDmy[2], 10) - 1; // 0-indexed
      let year = parseInt(mDmy[3], 10);
      let hour = parseInt(mDmy[4] || '0', 10);
      let min = parseInt(mDmy[5] || '0', 10);
      let sec = parseInt(mDmy[6] || '0', 10);

      // Guard against swapped month/day if day is <= 12 and month > 12
      if (month > 11 && day <= 12) {
        const temp = day;
        day = month + 1;
        month = temp - 1;
      }

      const activeOffset = (typeof brokerOffsetMin === 'number' && !isNaN(brokerOffsetMin))
        ? brokerOffsetMin
        : (config.brokerTzOffsetMin !== null ? config.brokerTzOffsetMin : -new Date().getTimezoneOffset());

      // Formula: Date.UTC(y, m, d, h, min, sec) - (offsetMinutes * 60000)
      return Date.UTC(year, month, day, hour, min, sec) - (activeOffset * 60 * 1000);
    }

    // 2. Format: YYYY-MM-DD HH:mm:ss
    const mYmd = clean.match(/^(\d{4})[\/\.-](\d{1,2})[\/\.-](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (mYmd) {
      let year = parseInt(mYmd[1], 10);
      let month = parseInt(mYmd[2], 10) - 1;
      let day = parseInt(mYmd[3], 10);
      let hour = parseInt(mYmd[4] || '0', 10);
      let min = parseInt(mYmd[5] || '0', 10);
      let sec = parseInt(mYmd[6] || '0', 10);

      const activeOffset = (typeof brokerOffsetMin === 'number' && !isNaN(brokerOffsetMin))
        ? brokerOffsetMin
        : (config.brokerTzOffsetMin !== null ? config.brokerTzOffsetMin : -new Date().getTimezoneOffset());

      return Date.UTC(year, month, day, hour, min, sec) - (activeOffset * 60 * 1000);
    }

    const d = new Date(clean).getTime();
    return isNaN(d) ? 0 : d;
  }

  // 4. Detect Account Type (Demo vs Live)
  function detectAccountType() {
    const path = window.location.pathname.toLowerCase();
    const search = window.location.search.toLowerCase();

    if (search.includes('account=live')) return 'live';
    if (search.includes('account=demo')) return 'demo';
    if (path.includes('/demo-trade')) return 'demo';

    const headerEl = document.querySelector('header, .header, .top-bar, [class*="header"], [class*="account"]');
    const headerText = headerEl ? headerEl.innerText.toUpperCase() : '';
    if (headerText.includes('DEMO')) return 'demo';
    if (headerText.includes('LIVE')) return 'live';

    if (path.includes('/trade') && !path.includes('demo')) return 'live';
    return 'demo';
  }

  // 5. Floating Toast Notification
  function showToast(message, type = 'success') {
    const oldToast = document.getElementById('bpf-toast');
    if (oldToast) oldToast.remove();

    const toast = document.createElement('div');
    toast.id = 'bpf-toast';
    toast.className = type === 'error' ? 'error' : (type === 'info' ? 'info' : '');
    toast.innerHTML = `
      <span style="font-size:16px;">${type === 'error' ? '⚠️' : (type === 'info' ? 'ℹ️' : '✅')}</span>
      <span style="font-size:12px; font-weight:600; line-height:1.4;">${message}</span>
    `;

    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast && toast.parentNode) toast.remove();
    }, 5500);
  }

  function setSyncBtnText(text) {
    const btn = document.getElementById('bpfSyncBtn');
    if (!btn) return;
    btn.innerHTML = `<span class="bpf-mobile-dot"></span><span>${text}</span>`;
  }

  // 6. Draggable Engine for Floating Widget
  function makeWidgetDraggable(root) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let dragThresholdPassed = false;

    try {
      const savedPos = localStorage.getItem('bpf_widget_pos');
      if (savedPos) {
        const { left, top } = JSON.parse(savedPos);
        const maxLeft = Math.max(0, window.innerWidth - 60);
        const maxTop = Math.max(0, window.innerHeight - 40);
        const clampedLeft = Math.min(Math.max(6, left), maxLeft);
        const clampedTop = Math.min(Math.max(6, top), maxTop);
        root.style.left = clampedLeft + 'px';
        root.style.top = clampedTop + 'px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
      }
    } catch (e) {}

    const onStart = (clientX, clientY) => {
      isDragging = true;
      dragThresholdPassed = false;
      startX = clientX;
      startY = clientY;
      const rect = root.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
    };

    const onMove = (clientX, clientY, e) => {
      if (!isDragging) return;
      const dx = clientX - startX;
      const dy = clientY - startY;

      if (!dragThresholdPassed && Math.hypot(dx, dy) > 5) {
        dragThresholdPassed = true;
        root.classList.add('is-dragging');
      }

      if (dragThresholdPassed) {
        if (e && e.cancelable) e.preventDefault();
        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth - 6);
        const maxTop = Math.max(0, window.innerHeight - root.offsetHeight - 6);

        newLeft = Math.min(Math.max(6, newLeft), maxLeft);
        newTop = Math.min(Math.max(6, newTop), maxTop);

        root.style.left = newLeft + 'px';
        root.style.top = newTop + 'px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
      }
    };

    const onEnd = () => {
      if (!isDragging) return;
      isDragging = false;
      root.classList.remove('is-dragging');

      if (dragThresholdPassed) {
        try {
          const rect = root.getBoundingClientRect();
          localStorage.setItem('bpf_widget_pos', JSON.stringify({
            left: Math.round(rect.left),
            top: Math.round(rect.top)
          }));
        } catch (e) {}
      }
    };

    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      onStart(e.clientX, e.clientY);

      const moveHandler = (moveEvent) => onMove(moveEvent.clientX, moveEvent.clientY, moveEvent);
      const upHandler = () => {
        window.removeEventListener('mousemove', moveHandler);
        window.removeEventListener('mouseup', upHandler);
        onEnd();
      };

      window.addEventListener('mousemove', moveHandler, { passive: false });
      window.addEventListener('mouseup', upHandler);
    });

    root.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) {
        onStart(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });

    root.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) {
        onMove(e.touches[0].clientX, e.touches[0].clientY, e);
      }
    }, { passive: false });

    root.addEventListener('touchend', () => onEnd(), { passive: true });
    root.addEventListener('touchcancel', () => onEnd(), { passive: true });

    root.addEventListener('click', (e) => {
      if (dragThresholdPassed) {
        e.preventDefault();
        e.stopPropagation();
        dragThresholdPassed = false;
      }
    }, true);

    window.addEventListener('resize', () => {
      if (!root.style.left) return;
      const rect = root.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth - 6);
      const maxTop = Math.max(0, window.innerHeight - root.offsetHeight - 6);
      if (rect.left > maxLeft) root.style.left = maxLeft + 'px';
      if (rect.top > maxTop) root.style.top = maxTop + 'px';
    });
  }

  // 7. Inject Floating Widget onto Quotex Page with New PB Logo & Timezone Tag
  function injectWidget() {
    if (document.getElementById('bpf-sync-widget-root')) {
      updateWidgetStatus();
      return;
    }

    const root = document.createElement('div');
    root.id = 'bpf-sync-widget-root';

    const accountType = detectAccountType();
    const isHistoryPage = window.location.pathname.includes('/trades');
    const iconUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL('icon48.png')
      : '';

    root.innerHTML = `
      <div class="bpf-pill" id="bpfPill" title="Binary Prop Firm — ড্র্যাগ করে যেকোনো জায়গায় নিয়ে রাখুন">
        <span class="bpf-drag-handle" title="ড্র্যাগ করুন">⋮⋮</span>
        ${iconUrl ? `<img src="${iconUrl}" style="width:20px; height:20px; border-radius:4px; box-shadow:0 1px 4px rgba(0,0,0,0.4); display:inline-block; vertical-align:middle;" alt="PB" />` : '<span class="bpf-logo-badge">PB</span>'}
        <span class="bpf-account-tag ${accountType === 'live' ? 'live' : 'demo'}" id="bpfAcctTag">
          ${accountType === 'live' ? 'LIVE' : 'DEMO'}
        </span>
        <span id="bpfTzTag" style="font-size:10px; font-weight:700; background:rgba(255,184,0,0.15); color:#ffb800; border:1px solid rgba(255,184,0,0.3); padding:2px 6px; border-radius:10px;" title="শনাক্তকৃত ব্রোকার টাইমজোন">
          ${config.brokerTzStr || 'UTC'}
        </span>
        <span id="bpfIdTag" class="bpf-id-tag scanning" title="Quotex Account ID">
          ID: ...
        </span>
        <div class="bpf-indicator-wrap" id="bpfIndicatorWrap" title="এক্সটেনশন কানেক্টেড রয়েছে">
          <span class="bpf-pulse-dot"></span>
          <span class="bpf-indicator-label">Connected</span>
        </div>
        <button class="bpf-btn-sync" id="bpfSyncBtn" title="Sync Trades এ চাপ দিলে সোজা Trades পেজে গিয়ে অটোমেটিক ট্রেড সিঙ্ক হবে">
          <span class="bpf-mobile-dot"></span>
          <span>⚡ Sync Trades</span>
        </button>
        ${isHistoryPage ? `
          <button class="bpf-btn-chart" id="bpfBackChartBtn" title="ট্রেডিং চার্টে ফিরে যান">
            <span>📈 ট্রেড চার্ট</span>
          </button>
        ` : ''}
      </div>
    `;

    document.body.appendChild(root);
    makeWidgetDraggable(root);

    document.getElementById('bpfSyncBtn').addEventListener('click', async () => {
      if (isExtensionLocked) {
        showToast(lockReason || '⚠️ আপনার চ্যালেঞ্জটি বর্তমানে বন্ধ/নিষ্ক্রিয় রয়েছে। এক্সটেনশন কোনো ট্রেড সিঙ্ক করবে না।', 'error');
        return;
      }

      if (!config.traderId) {
        showToast('ত্রুটি: আপনার Trader ID সেট করা নেই! এক্সটেনশন আইকনে ক্লিক করে Trader ID লিখুন।', 'error');
        return;
      }

      // Step 1: Scan & Verify Quotex Account ID match with active challenge
      const detectedId = await scanQuotexAccountId(true);
      if (!currentRegisteredBrokerAccountId) {
        try {
          await fetchChallengeStatus();
        } catch (e) {}
      }

      const matchCheck = verifyQuotexAccountIdMatch(detectedId, currentRegisteredBrokerAccountId);
      if (matchCheck.isMismatch) {
        showAccountMismatchModal(matchCheck.cleanReg, matchCheck.cleanDet);
        showToast('⚠️ Quotex Account ID মিলছে না! ট্রেড সিঙ্ক সম্পূর্ণ ব্লক রাখা হয়েছে।', 'error');
        const syncBtn = document.getElementById('bpfSyncBtn');
        if (syncBtn) {
          syncBtn.innerHTML = `<span>⚠️ ID Mismatch</span>`;
          syncBtn.style.background = '#4a1515';
          syncBtn.style.borderColor = '#ff5252';
          syncBtn.style.color = '#ff8a80';
        }
        return;
      }

      if (window.location.pathname.includes('/trades')) {
        runManualTradeSync();
      } else {
        const acct = detectAccountType();
        sessionStorage.setItem('bpf_auto_sync_target', 'true');
        sessionStorage.setItem('bpf_account_type', acct);

        const btn = document.getElementById('bpfSyncBtn');
        if (btn) {
          btn.disabled = true;
          setSyncBtnText('⏳ Trades পেজে যাওয়া হচ্ছে...');
        }

        showToast('🚀 Trades হিস্টোরি পেজে নিয়ে যাওয়া হচ্ছে, সেখানে স্বয়ংক্রিয়ভাবে সিঙ্ক হবে...', 'info');
        window.location.href = `${window.location.origin}/en/trades?page=1&account=${acct}`;
      }
    });

    const backBtn = document.getElementById('bpfBackChartBtn');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        const acct = detectAccountType();
        const targetPath = (acct === 'live') ? '/en/trade' : '/en/demo-trade';
        window.location.href = `${window.location.origin}${targetPath}`;
      });
    }
  }

  function updateWidgetStatus() {
    const acctTag = document.getElementById('bpfAcctTag');
    if (acctTag) {
      const acct = detectAccountType();
      acctTag.className = `bpf-account-tag ${acct === 'live' ? 'live' : 'demo'}`;
      acctTag.innerText = acct === 'live' ? 'LIVE' : 'DEMO';
    }
    const tzTag = document.getElementById('bpfTzTag');
    if (tzTag && config.brokerTzStr) {
      tzTag.innerText = config.brokerTzStr;
    }
    const idTag = document.getElementById('bpfIdTag');
    if (idTag) {
      const cleanReg = (currentRegisteredBrokerAccountId || '').replace(/[^0-9]/g, '');
      const cleanDet = (detectedQuotexAccountId || '').replace(/[^0-9]/g, '');

      if (cleanReg && cleanDet) {
        if (cleanReg === cleanDet) {
          idTag.className = 'bpf-id-tag verified';
          idTag.innerText = `ID: ${cleanDet}`;
          idTag.title = `Quotex ID ভেরিফাইড (${cleanDet})`;
        } else {
          idTag.className = 'bpf-id-tag mismatch';
          idTag.innerText = `⚠️ ID Mismatch`;
          idTag.title = `Quotex ID মিলছে না! চ্যালেঞ্জ: ${cleanReg}, বর্তমান: ${cleanDet}`;
        }
      } else if (cleanDet) {
        idTag.className = 'bpf-id-tag scanning';
        idTag.innerText = `ID: ${cleanDet}`;
        idTag.title = `লগইনকৃত Quotex ID: ${cleanDet}`;
      } else {
        idTag.className = 'bpf-id-tag scanning';
        idTag.innerText = `ID: ...`;
        idTag.title = `Quotex Account ID স্ক্যান করা হচ্ছে`;
      }
    }
  }

  // Server Challenge Lock / Active Status Handler
  let isExtensionLocked = false;
  let lockReason = '';
  let currentChallengeStartTime = 0;
  let currentChallengeStartedAtIso = '';

  function handleServerStatusResponse(data) {
    if (!data) return;
    const pill = document.getElementById('bpfPill');
    const indicatorWrap = document.getElementById('bpfIndicatorWrap');
    const syncBtn = document.getElementById('bpfSyncBtn');

    if (data.registeredBrokerAccountId !== undefined) {
      currentRegisteredBrokerAccountId = String(data.registeredBrokerAccountId || '').trim();
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ quotex_registered_broker_id: currentRegisteredBrokerAccountId });
      }
    }
    updateWidgetStatus();

    if (data.accountMismatch) {
      isAccountIdMismatch = true;
      showAccountMismatchModal(data.registeredBrokerAccountId, data.detectedBrokerAccountId);
      if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.style.opacity = '0.7';
        syncBtn.style.background = '#4a1515';
        syncBtn.style.borderColor = '#ff5252';
        syncBtn.style.color = '#ff8a80';
        syncBtn.innerHTML = `<span>⚠️ ID Mismatch</span>`;
      }
      return;
    }

    if (data.challengeStartTime) {
      currentChallengeStartTime = data.challengeStartTime;
    } else if (data.challengeStartedAt) {
      currentChallengeStartTime = new Date(data.challengeStartedAt).getTime();
    }
    if (data.challengeStartedAt) {
      currentChallengeStartedAtIso = data.challengeStartedAt;
    }

    if (data.isDisqualified || data.noActiveChallenge || data.active === false) {
      isExtensionLocked = true;
      lockReason = data.message || 'চ্যালেঞ্জ বন্ধ বা বাতিল রয়েছে।';

      if (pill) {
        pill.style.borderColor = 'rgba(255, 82, 82, 0.7)';
        pill.style.background = 'linear-gradient(135deg, rgba(255,82,82,0.18), rgba(18,21,29,0.96))';
      }
      if (indicatorWrap) {
        indicatorWrap.title = lockReason;
        indicatorWrap.innerHTML = `
          <span style="width:8px; height:8px; border-radius:50%; background:#ff5252; box-shadow:0 0 8px #ff5252; display:inline-block;"></span>
          <span style="color:#ff5252; font-weight:700; font-size:11px;">${data.isDisqualified ? 'Disqualified' : 'Inactive'}</span>
        `;
      }
      if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.style.opacity = '0.55';
        syncBtn.style.cursor = 'not-allowed';
        syncBtn.style.background = '#4a1515';
        syncBtn.style.borderColor = '#ff5252';
        syncBtn.style.color = '#ff8a80';
        syncBtn.innerHTML = `<span>🚫 ${data.isDisqualified ? 'চ্যালেঞ্জ বাতিল' : 'চ্যালেঞ্জ বন্ধ'}</span>`;
      }
    } else if (data.active === true) {
      isExtensionLocked = false;
      lockReason = '';

      if (pill) {
        pill.style.borderColor = '';
        pill.style.background = '';
      }
      if (indicatorWrap) {
        indicatorWrap.title = 'এক্সটেনশন কানেক্টেড রয়েছে';
        indicatorWrap.innerHTML = `
          <span class="bpf-pulse-dot"></span>
          <span class="bpf-indicator-label">Connected</span>
        `;
      }
      if (syncBtn && !isSyncing) {
        syncBtn.disabled = false;
        syncBtn.style.opacity = '1';
        syncBtn.style.cursor = 'pointer';
        syncBtn.style.background = '';
        syncBtn.style.borderColor = '';
        syncBtn.style.color = '';
        setSyncBtnText('⚡ Sync Trades');
      }
    }
  }

  // 8. Heartbeat Engine (Sends ping every 30s to keep dashboard connected)
  async function fetchChallengeStatus() {
    if (!config.traderId) return null;
    const targetUrl = (config.serverUrl || 'https://binarypropfirm.com').replace(/\/+$/, '') + '/api/extension/heartbeat';
    const accountType = detectAccountType();
    const detectedId = await scanQuotexAccountId();

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traderId: config.traderId,
          status: 'online',
          accountType,
          detectedBrokerAccountId: detectedId,
          url: window.location.href,
          brokerTzOffset: config.brokerTzOffsetMin,
          brokerTzStr: config.brokerTzStr,
          timestamp: Date.now()
        })
      });
      const data = await res.json();
      handleServerStatusResponse(data);
      return data;
    } catch (e) {
      return null;
    }
  }

  function sendHeartbeat() {
    fetchChallengeStatus();
  }

  // Instant Disconnect Beacon when tab closes or navigates away
  function sendDisconnectSignal() {
    if (!config.traderId) return;
    const targetUrl = (config.serverUrl || 'https://binarypropfirm.com').replace(/\/+$/, '') + '/api/extension/disconnect';
    const payload = JSON.stringify({
      traderId: config.traderId,
      timestamp: Date.now()
    });

    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(targetUrl, blob);
    } else {
      try {
        fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true
        });
      } catch (e) {}
    }
  }

  window.addEventListener('beforeunload', sendDisconnectSignal);
  window.addEventListener('pagehide', sendDisconnectSignal);

  // 9. Parse Quotex Trade History Table from Document with Turbo/Timeframe Support
  function parseQuotexTradesFromDoc(doc, forcedAccountType) {
    const trades = [];
    const accountType = forcedAccountType || detectAccountType();
    const activeOffsetMin = scanQuotexBrokerTimezone();

    let rows = Array.from(doc.querySelectorAll('table tbody tr, .trades-table__row, [class*="trades-table"] [class*="row"], [class*="trade-item"], [class*="trades-list"] > div, [class*="trade-history"] [class*="item"]'));
    if (rows.length === 0) {
      rows = Array.from(doc.querySelectorAll('[class*="table"] [class*="row"]'));
    }

    rows.forEach((row) => {
      const text = row.innerText || '';
      if (text.includes('Asset') && text.includes('Profit') && !text.includes('$') && !text.includes('€') && !text.includes('OTC')) return;

      const cells = Array.from(row.querySelectorAll('td, [class*="col"], [class*="cell"]'));
      const hasTradeCurrency = /([A-Z]{3}\/[A-Z]{3}|OTC)/i.test(text);
      const hasQuoteOrAmount = /\d+\.?\d*\s*[$€₹৳]/.test(text) || /[$€₹৳]\s*\d+\.?\d*/.test(text);

      if (cells.length < 5 && (!hasTradeCurrency || !hasQuoteOrAmount)) return;

      try {
        // A. Asset
        let asset = '';
        const pairMatch = text.match(/([A-Z]{3}\/[A-Z]{3}(\s*\(?OTC\)?)?|[A-Z]{6}(\s*\(?OTC\)?)?)/i);
        if (pairMatch) {
          asset = pairMatch[0].trim();
        } else if (cells[0]) {
          asset = cells[0].innerText.trim();
        }

        // B. Ticket ID & Payout %
        let ticketId = '';
        let payout = '';
        const uuidMatch = text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
        if (uuidMatch) ticketId = uuidMatch[0].toLowerCase();
        
        // Match exact Quotex payout percentage (e.g. 93%, 92%, 85%)
        // Do NOT use trailing \b after '%' because '%' is non-word character!
        const payoutMatch = text.match(/\b(\d{1,3})\s*%/);
        if (payoutMatch) payout = `${payoutMatch[1]}%`;

        if (!payout) {
          cells.forEach(c => {
            const m = (c.innerText || '').match(/\b(\d{1,3})\s*%/);
            if (m && !payout) payout = `${m[1]}%`;
          });
        }

        // C & D. Opening & Closing Quotes and Timestamps
        let openQuote = '';
        let openTime = '';
        let closeQuote = '';
        let closeTime = '';

        const allTimeMatches = Array.from(text.matchAll(/\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4},?\s*\d{1,2}:\d{1,2}:\d{1,2}/g)).map(m => m[0]);
        if (allTimeMatches.length >= 1) openTime = allTimeMatches[0];
        if (allTimeMatches.length >= 2) closeTime = allTimeMatches[1];

        cells.forEach(c => {
          const timeMatch = c.innerText.match(/\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4},?\s*\d{1,2}:\d{1,2}:\d{1,2}/);
          if (timeMatch && !openTime) {
            openTime = timeMatch[0];
          } else if (timeMatch && !closeTime && timeMatch[0] !== openTime) {
            closeTime = timeMatch[0];
          }
        });

        const openQMatch = text.match(/Opening quote:?\s*(\d+\.?\d*)/i);
        if (openQMatch) openQuote = openQMatch[1];
        const closeQMatch = text.match(/Closing quote:?\s*(\d+\.?\d*)/i);
        if (closeQMatch) closeQuote = closeQMatch[1];

        // E. Amount & Direction
        let amount = 0;
        let direction = 'CALL';
        const amtMatch = text.match(/Amount:?\s*(\d+\.?\d*)\s*[$€₹৳]/i) || text.match(/Amount:?\s*[$€₹৳]\s*(\d+\.?\d*)/i);
        if (amtMatch) {
          amount = parseFloat(amtMatch[1]);
        } else {
          cells.forEach(c => {
            const cText = c.innerText;
            if ((cText.includes('$') || cText.includes('€') || cText.includes('₹') || cText.includes('৳')) && !amount) {
              const m = cText.match(/(\d+\.?\d*)\s*[$€₹৳]/) || cText.match(/[$€₹৳]\s*(\d+\.?\d*)/);
              if (m) amount = parseFloat(m[1]);
            }
          });
        }

        if (text.includes('↓') || row.innerHTML.includes('down') || row.innerHTML.includes('arrow-down') || row.innerHTML.includes('red') || /put/i.test(text)) {
          direction = 'PUT';
        } else if (text.includes('↑') || row.innerHTML.includes('up') || row.innerHTML.includes('arrow-up') || row.innerHTML.includes('green') || /call/i.test(text)) {
          direction = 'CALL';
        }

        // F. Profit & Result (WIN / LOSS / REFUND)
        let profit = 0;
        let result = 'LOSS';
        const allMoneyMatches = Array.from(text.matchAll(/(\d+\.?\d*)\s*[$€₹৳]/g)).map(m => parseFloat(m[1]));
        if (allMoneyMatches.length > 0) {
          if (allMoneyMatches.length >= 2) {
            profit = allMoneyMatches[0];
          } else if (allMoneyMatches.length === 1 && allMoneyMatches[0] !== amount) {
            profit = allMoneyMatches[0];
          }
        }
        const lastCell = cells[cells.length - 1];
        if (lastCell) {
          const profMatch = lastCell.innerText.match(/(\d+\.?\d*)\s*[$€₹৳]/) || lastCell.innerText.match(/[$€₹৳]\s*(\d+\.?\d*)/);
          if (profMatch) profit = parseFloat(profMatch[1]);
        }
        if (profit > 0 || row.innerHTML.includes('green') || row.innerHTML.includes('success')) {
          result = 'WIN';
        }
        if (text.toLowerCase().includes('refund') || text.toLowerCase().includes('tie')) {
          result = 'REFUND';
        }
        if (openQuote && closeQuote && openQuote !== '0.00' && parseFloat(openQuote) === parseFloat(closeQuote)) {
          result = 'REFUND';
        } else if (amount > 0 && Math.abs(profit - amount) < 0.01 && result !== 'WIN') {
          result = 'REFUND';
        }

        // Calculate exact payout % from actual profit/amount if DOM percentage was not found
        if (!payout && amount > 0 && profit > 0) {
          let calculatedRate = 0;
          if (profit > amount) {
            // Gross return format: e.g. $1.93 on $1.00 stake = 93%, $3.86 on $2.00 = 93%, $5.76 on $3.00 = 92%
            calculatedRate = Math.round(((profit - amount) / amount) * 100);
          } else {
            // Net profit format: e.g. $0.93 on $1.00 stake = 93%
            calculatedRate = Math.round((profit / amount) * 100);
          }
          if (calculatedRate >= 40 && calculatedRate <= 100) {
            payout = `${calculatedRate}%`;
          }
        }

        // Fallback unique ticketId
        if (!ticketId && openTime && asset) {
          ticketId = 'qx_' + btoa(`${asset}_${openTime}_${amount}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 24);
        }

        // Calculate accurate UTC timestamps
        const openTimestamp = parseQuotexTimestampInUtc(openTime, activeOffsetMin);
        const closeTimestamp = parseQuotexTimestampInUtc(closeTime, activeOffsetMin);
        const openTimeIso = openTimestamp > 0 ? new Date(openTimestamp).toISOString() : '';
        const closeTimeIso = closeTimestamp > 0 ? new Date(closeTimestamp).toISOString() : '';

        // Calculate trade duration & timeframe (e.g. 5s turbo, 15s, 1m)
        let durationSeconds = 60;
        if (openTimestamp > 0 && closeTimestamp > 0 && closeTimestamp >= openTimestamp) {
          durationSeconds = Math.max(1, Math.round((closeTimestamp - openTimestamp) / 1000));
        }
        const timeframe = durationSeconds < 60 ? `${durationSeconds}s` : `${Math.round(durationSeconds / 60)}m`;

        if (asset && (openTime || amount > 0)) {
          trades.push({
            ticketId,
            asset,
            payout: payout || '85%',
            direction,
            openQuote: openQuote || '0.00',
            openTime: openTime || new Date().toLocaleString(),
            openTimestamp: openTimestamp || Date.now(),
            openTimeIso: openTimeIso || new Date().toISOString(),
            closeQuote: closeQuote || '0.00',
            closeTime: closeTime || new Date().toLocaleString(),
            closeTimestamp: closeTimestamp || 0,
            closeTimeIso: closeTimeIso || '',
            durationSeconds,
            timeframe,
            amount: amount || 1.0,
            profit: profit || 0.0,
            result,
            accountType,
            brokerTzOffset: activeOffsetMin,
            brokerTzStr: config.brokerTzStr
          });
        }
      } catch (rowErr) {
        console.warn('[BPF Sync] Error parsing trade row:', rowErr);
      }
    });

    return { trades, accountType };
  }

  function buildQuotexPageUrl(currentUrl, page, acctType) {
    try {
      const u = new URL(currentUrl);
      u.searchParams.set('page', String(page));
      if (acctType) {
        u.searchParams.set('account', acctType);
      }
      return u.toString();
    } catch (e) {
      const origin = window.location.origin;
      return `${origin}/en/trades?page=${page}&account=${acctType || 'demo'}`;
    }
  }

  // 10. Multi-Page Auto-Pagination Scanner (With 5-Minute Intelligent Grace Buffer)
  async function collectAllChallengeTrades(acctType, challengeStartTime) {
    const allCollectedTrades = [];
    const seenTicketIds = new Set();
    let pagesScanned = 0;
    const SAFETY_GRACE_BUFFER_MS = 5 * 60 * 1000; // 5 minutes grace window

    // Parse Page 1 from currently rendered DOM
    const page1 = parseQuotexTradesFromDoc(document, acctType);
    pagesScanned++;

    let reachedOlderTrades = false;

    for (const t of page1.trades) {
      if (!t.ticketId) continue;
      // Filter out trades strictly older than challenge start time minus grace buffer
      if (challengeStartTime && t.openTimestamp && t.openTimestamp < (challengeStartTime - SAFETY_GRACE_BUFFER_MS)) {
        reachedOlderTrades = true;
        continue;
      }
      if (!seenTicketIds.has(t.ticketId)) {
        seenTicketIds.add(t.ticketId);
        allCollectedTrades.push(t);
      }
    }

    // If Page 1 already encountered older trades or has few trades, no need to paginate
    if (reachedOlderTrades || page1.trades.length < 15) {
      return { trades: allCollectedTrades, pagesScanned };
    }

    // Fetch older pages (page 2 up to 20) until reaching trades before challenge start
    const maxPages = 20;
    for (let page = 2; page <= maxPages; page++) {
      try {
        const pageUrl = buildQuotexPageUrl(window.location.href, page, acctType);
        const res = await fetch(pageUrl, { credentials: 'include' });
        if (!res.ok) break;

        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const pageResult = parseQuotexTradesFromDoc(doc, acctType);

        if (!pageResult.trades || pageResult.trades.length === 0) {
          break;
        }

        pagesScanned++;
        let pageHasOlder = false;

        for (const t of pageResult.trades) {
          if (!t.ticketId) continue;
          if (challengeStartTime && t.openTimestamp && t.openTimestamp < (challengeStartTime - SAFETY_GRACE_BUFFER_MS)) {
            pageHasOlder = true;
            continue;
          }
          if (!seenTicketIds.has(t.ticketId)) {
            seenTicketIds.add(t.ticketId);
            allCollectedTrades.push(t);
          }
        }

        if (pageHasOlder) {
          break; // Reached trades before challenge start
        }

        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        console.warn(`[BPF Sync] Error during pagination scan on page ${page}:`, err);
        break;
      }
    }

    return { trades: allCollectedTrades, pagesScanned };
  }

  // 11. Send Trades to Prop Firm Server
  async function postTradesToServer(trades, accountType) {
    if (!config.traderId) {
      showToast('ত্রুটি: Trader ID সেট করা নেই! এক্সটেনশনে Trader ID লিখুন।', 'error');
      return { success: false, message: 'Trader ID not set' };
    }

    const targetUrl = (config.serverUrl || 'https://binarypropfirm.com').replace(/\/+$/, '') + '/api/extension/sync-trades';
    const detectedId = await scanQuotexAccountId();

    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traderId: config.traderId,
        accountType,
        source: 'quotex',
        detectedBrokerAccountId: detectedId,
        brokerTzOffset: config.brokerTzOffsetMin,
        brokerTzStr: config.brokerTzStr,
        clientTzOffset: new Date().getTimezoneOffset(),
        clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Dhaka',
        trades
      })
    });

    return await res.json();
  }

  function waitForTradesTable(callback, maxAttempts = 30) {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const rows = document.querySelectorAll('table tbody tr, .trades-table__row, [class*="trades-table"] [class*="row"]');
      const noData = document.querySelector('.no-data, [class*="no-data"]');

      if (rows.length > 0 || noData || attempts >= maxAttempts) {
        clearInterval(interval);
        callback();
      }
    }, 250);
  }

  // 12. Manual / Auto Sync Handler on /en/trades Page
  async function runManualTradeSync() {
    if (isSyncing) return;
    if (isExtensionLocked) {
      showToast(lockReason || '⚠️ আপনার চ্যালেঞ্জটি বর্তমানে বন্ধ/নিষ্ক্রিয় রয়েছে। এক্সটেনশন কোনো ট্রেড সিঙ্ক করবে না।', 'error');
      return;
    }

    const btn = document.getElementById('bpfSyncBtn');

    // Quotex Account ID Verification before parsing trades
    const detectedId = await scanQuotexAccountId(true);
    if (!currentRegisteredBrokerAccountId) {
      try {
        await fetchChallengeStatus();
      } catch (e) {}
    }

    const matchCheck = verifyQuotexAccountIdMatch(detectedId, currentRegisteredBrokerAccountId);
    if (matchCheck.isMismatch) {
      showAccountMismatchModal(matchCheck.cleanReg, matchCheck.cleanDet);
      showToast('⚠️ Quotex Account ID মিলছে না! ট্রেড সিঙ্ক বন্ধ রাখা হয়েছে।', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<span>⚠️ ID Mismatch</span>`;
        btn.style.background = '#4a1515';
        btn.style.borderColor = '#ff5252';
        btn.style.color = '#ff8a80';
      }
      return;
    }

    isSyncing = true;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>⏳ স্ক্যান ও সিঙ্ক হচ্ছে...</span>';
    }

    loadConfig(async () => {
      scanQuotexBrokerTimezone();

      if (!currentChallengeStartTime) {
        try {
          await fetchChallengeStatus();
        } catch (e) {}
      }

      const acctType = detectAccountType();
      const { trades, pagesScanned } = await collectAllChallengeTrades(acctType, currentChallengeStartTime);

      if (!trades || trades.length === 0) {
        showToast('ℹ️ চ্যালেঞ্জ শুরু হওয়ার পরের কোনো নতুন ট্রেড পাওয়া যায়নি। নতুন ট্রেড নেওয়ার পর পুনরায় চেষ্টা করুন।', 'info');
        if (btn) {
          btn.disabled = false;
          setSyncBtnText('⚡ Sync Trades');
        }
        isSyncing = false;
        return;
      }

      try {
        const result = await postTradesToServer(trades, acctType);

        if (btn) {
          btn.disabled = false;
          setSyncBtnText('✅ Synced');
          setTimeout(() => {
            if (btn) setSyncBtnText('⚡ Sync Trades');
          }, 3500);
        }

        if (result && result.accountMismatch) {
          isAccountIdMismatch = true;
          showAccountMismatchModal(result.registeredBrokerAccountId, result.detectedBrokerAccountId);
          showToast('⚠️ Quotex Account ID মিলছে না! সিঙ্ক ব্লক করা হয়েছে।', 'error');
          if (btn) {
            btn.innerHTML = `<span>⚠️ ID Mismatch</span>`;
            btn.style.background = '#4a1515';
            btn.style.borderColor = '#ff5252';
            btn.style.color = '#ff8a80';
          }
          return;
        }

        if (result && (result.isDisqualified || result.noActiveChallenge)) {
          handleServerStatusResponse(result);
          showToast('⚠️ ' + (result.message || 'চ্যালেঞ্জ বন্ধ থাকায় এক্সটেনশন কোনো ট্রেড গ্রহণ করবে না।'), 'error');
        } else if (result && result.success) {
          handleServerStatusResponse({ active: true, ...result });
          trades.forEach(t => syncedTicketsCache.add(t.ticketId));
          saveSyncedCache();

          // Immediately send updated heartbeat so dashboard shows online & paired instantly
          sendHeartbeat();

          let toastMsg = '';
          if (result.addedCount > 0) {
            toastMsg = `✅ ${result.addedCount} টি নতুন চ্যালেঞ্জ ট্রেড সফলভাবে সিঙ্ক হয়েছে! ${pagesScanned > 1 ? `(${pagesScanned} টি পেজ স্ক্যান করা হয়েছে)` : ''}`;
            if (result.filteredOldCount > 0) {
              toastMsg += ` (চ্যালেঞ্জ শুরুর পূর্বের পুরনো ${result.filteredOldCount} টি ট্রেড বাদ দেওয়া হয়েছে)`;
            }
          } else if (result.filteredOldCount > 0 && result.addedCount === 0) {
            toastMsg = `ℹ️ কোনো নতুন ট্রেড পাওয়া যায়নি। প্রাপ্ত ${result.filteredOldCount}টি ট্রেড চ্যালেঞ্জ সক্রিয় হওয়ার পূর্বের। নতুন ট্রেড নিন।`;
          } else if (result.duplicateCount > 0 && result.addedCount === 0) {
            toastMsg = `✅ সকল ${trades.length} টি ট্রেড ইতিমধ্যে সেভ রয়েছে (ডুপ্লিকেট এড়ানো হয়েছে)।`;
          } else {
            toastMsg = result.message || 'ট্রেড হিস্টোরি সিঙ্ক সম্পন্ন হয়েছে!';
          }

          showToast(toastMsg, result.addedCount > 0 ? 'success' : 'info');
        } else {
          showToast(result?.message || 'সিঙ্ক ব্যর্থ হয়েছে।', 'error');
        }
      } catch (err) {
        if (btn) {
          btn.disabled = false;
          setSyncBtnText('⚡ Sync Trades');
        }
        showToast('সার্ভার কানেকশন ত্রুটি: ' + err.message, 'error');
      } finally {
        isSyncing = false;
      }
    });
  }

  // 13. Auto-Sync on /en/trades Page Load
  function handleTradesPageAutoSync() {
    if (!window.location.pathname.includes('/trades')) return;
    if (isExtensionLocked) return;

    const isPending = sessionStorage.getItem('bpf_auto_sync_target') === 'true';
    if (isPending || config.autoSync) {
      sessionStorage.removeItem('bpf_auto_sync_target');

      const btn = document.getElementById('bpfSyncBtn');
      if (btn) {
        btn.disabled = true;
        setSyncBtnText('⏳ ট্রেড সিঙ্ক হচ্ছে...');
      }

      waitForTradesTable(() => {
        setTimeout(() => {
          runManualTradeSync();
        }, 600);
      });
    }
  }

  // 14. Message Listener from Popup
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req.action === 'TRIGGER_SYNC') {
        if (isExtensionLocked) {
          sendResponse({ success: false, error: lockReason || 'আপনার চ্যালেঞ্জটি বন্ধ বা বাতিল রয়েছে।' });
          return true;
        }

        scanQuotexAccountId(true).then((detectedId) => {
          const matchCheck = verifyQuotexAccountIdMatch(detectedId, currentRegisteredBrokerAccountId);
          if (matchCheck.isMismatch) {
            showAccountMismatchModal(matchCheck.cleanReg, matchCheck.cleanDet);
            sendResponse({
              success: false,
              accountMismatch: true,
              error: `Quotex Account ID মিলছে না! চ্যালেঞ্জ ID: ${matchCheck.cleanReg}, লগইনকৃত ID: ${matchCheck.cleanDet}`
            });
            return;
          }

          if (!window.location.pathname.includes('/trades')) {
            const acct = detectAccountType();
            sessionStorage.setItem('bpf_auto_sync_target', 'true');
            window.location.href = `${window.location.origin}/en/trades?page=1&account=${acct}`;
            sendResponse({ success: true, message: 'Trades অপশনে নেওয়া হচ্ছে...' });
          } else {
            const acct = detectAccountType();
            collectAllChallengeTrades(acct, currentChallengeStartTime).then(({ trades, pagesScanned }) => {
              if (!trades || trades.length === 0) {
                sendResponse({ success: false, error: 'চ্যালেঞ্জের কোনো ট্রেড পাওয়া যায়নি।' });
                return;
              }
              postTradesToServer(trades, acct).then(res => {
                if (res && res.accountMismatch) {
                  showAccountMismatchModal(res.registeredBrokerAccountId, res.detectedBrokerAccountId);
                  sendResponse({ success: false, accountMismatch: true, error: res.message });
                  return;
                }
                if (res && res.success) {
                  trades.forEach(t => syncedTicketsCache.add(t.ticketId));
                  saveSyncedCache();
                  sendHeartbeat();
                }
                sendResponse({ ...res, count: trades.length, pagesScanned });
              }).catch(err => {
                sendResponse({ success: false, error: err.message });
              });
            }).catch(err => {
              sendResponse({ success: false, error: err.message });
            });
          }
        });
        return true;
      }
    });
  }

  // 15. Initialization
  function startExtension() {
    loadConfig(() => {
      initLiveDomIdObserver();
      scanQuotexBrokerTimezone();
      scanQuotexAccountId();
      injectWidget();
      sendHeartbeat();

      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(sendHeartbeat, 8000);

      if (tzScanTimer) clearInterval(tzScanTimer);
      tzScanTimer = setInterval(scanQuotexBrokerTimezone, 15000);

      setInterval(() => scanQuotexAccountId(), 45000);

      if (window.location.pathname.includes('/trades')) {
        setTimeout(() => {
          if (!isExtensionLocked) {
            handleTradesPageAutoSync();
          }
        }, 800);
      }
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startExtension);
  } else {
    startExtension();
  }
})();
