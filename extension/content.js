// Binary Prop Firm - Quotex Trade Synchronizer Content Script
(function () {
  let config = {
    traderId: '',
    serverUrl: 'https://binarypropfirm.com',
    autoSync: true
  };

  const syncedTicketsCache = new Set();
  let isSyncing = false;
  let heartbeatTimer = null;

  // 1. Load config from chrome.storage.local
  function loadConfig(cb) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['traderId', 'serverUrl', 'autoSync', 'syncedCache'], (res) => {
        if (res.traderId) config.traderId = res.traderId;
        if (res.serverUrl) config.serverUrl = res.serverUrl;
        if (res.autoSync !== undefined) config.autoSync = res.autoSync;
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
      const arr = Array.from(syncedTicketsCache).slice(-500);
      chrome.storage.local.set({ syncedCache: arr });
    }
  }

  // 2. Detect Account Type (Demo vs Live)
  function detectAccountType() {
    const path = window.location.pathname.toLowerCase();
    const search = window.location.search.toLowerCase();

    // Check URL parameters
    if (search.includes('account=live')) return 'live';
    if (search.includes('account=demo')) return 'demo';

    // Check live chart paths
    if (path.includes('/demo-trade')) return 'demo';

    // Check page header / account dropdown for DEMO or LIVE
    const headerEl = document.querySelector('header, .header, .top-bar, [class*="header"], [class*="account"]');
    const headerText = headerEl ? headerEl.innerText.toUpperCase() : '';
    if (headerText.includes('DEMO')) return 'demo';
    if (headerText.includes('LIVE')) return 'live';

    // If pathname is /en/trade and no DEMO is visible, it's live
    if (path.includes('/trade') && !path.includes('demo')) return 'live';

    return 'demo';
  }

  // 3. Floating Toast Notification
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
    }, 5000);
  }

  // Helper to safely update Sync button text while keeping mobile indicator dot
  function setSyncBtnText(text) {
    const btn = document.getElementById('bpfSyncBtn');
    if (!btn) return;
    btn.innerHTML = `<span class="bpf-mobile-dot"></span><span>${text}</span>`;
  }

  // Draggable Engine for Floating Widget (Supports PC Mouse & Mobile Phone Touch)
  function makeWidgetDraggable(root) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let dragThresholdPassed = false;

    // Restore previously saved position from localStorage
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
        if (e && e.cancelable) e.preventDefault(); // prevent touch scroll
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

    // Mouse Listeners (Desktop Computer)
    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // only left click
      onStart(e.clientX, e.clientY);

      const moveHandler = (moveEvent) => {
        onMove(moveEvent.clientX, moveEvent.clientY, moveEvent);
      };

      const upHandler = () => {
        window.removeEventListener('mousemove', moveHandler);
        window.removeEventListener('mouseup', upHandler);
        onEnd();
      };

      window.addEventListener('mousemove', moveHandler, { passive: false });
      window.addEventListener('mouseup', upHandler);
    });

    // Touch Listeners (Mobile Phone)
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

    root.addEventListener('touchend', () => {
      onEnd();
    }, { passive: true });

    root.addEventListener('touchcancel', () => {
      onEnd();
    }, { passive: true });

    // Prevent button click if dragged
    root.addEventListener('click', (e) => {
      if (dragThresholdPassed) {
        e.preventDefault();
        e.stopPropagation();
        dragThresholdPassed = false;
      }
    }, true);

    // Keep clamped inside viewport on screen resize or mobile orientation change
    window.addEventListener('resize', () => {
      if (!root.style.left) return;
      const rect = root.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth - 6);
      const maxTop = Math.max(0, window.innerHeight - root.offsetHeight - 6);
      if (rect.left > maxLeft) root.style.left = maxLeft + 'px';
      if (rect.top > maxTop) root.style.top = maxTop + 'px';
    });
  }

  // 4. Inject Floating Widget onto Quotex Page
  function injectWidget() {
    if (document.getElementById('bpf-sync-widget-root')) {
      updateWidgetStatus();
      return;
    }

    const root = document.createElement('div');
    root.id = 'bpf-sync-widget-root';

    const accountType = detectAccountType();
    const isHistoryPage = window.location.pathname.includes('/trades');
    const traderLabel = config.traderId ? config.traderId : 'ID Not Set';

    root.innerHTML = `
      <div class="bpf-pill" id="bpfPill" title="Binary Prop Firm — ড্র্যাগ করে যেকোনো জায়গায় নিয়ে রাখুন">
        <span class="bpf-drag-handle" title="ড্র্যাগ করুন">⋮⋮</span>
        <span class="bpf-logo-badge">BPF</span>
        <span class="bpf-status-text">
          Trader: <strong id="bpfTraderIdDisplay">${traderLabel}</strong>
        </span>
        <span class="bpf-account-tag ${accountType === 'live' ? 'live' : 'demo'}" id="bpfAcctTag">
          ${accountType === 'live' ? 'LIVE' : 'DEMO'}
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

    // Sync Trades Click Handler:
    // User Requirement: "Sync Trades এর মধ্যে চাপ দিলে সোজা যেন ইউজাররা Trades অপশনে চলে যাই তারপর ট্রেডিং হিস্টোরি আমাদের সার্ভারে চলে আসে।"
    document.getElementById('bpfSyncBtn').addEventListener('click', () => {
      if (isExtensionLocked) {
        showToast(lockReason || '⚠️ আপনার চ্যালেঞ্জটি বর্তমানে বন্ধ/নিষ্ক্রিয় রয়েছে। এক্সটেনশন কোনো ট্রেড সিঙ্ক করবে না।', 'error');
        return;
      }

      if (!config.traderId) {
        showToast('ত্রুটি: আপনার Trader ID সেট করা নেই! এক্সটেনশন আইকনে ক্লিক করে Trader ID লিখুন।', 'error');
        return;
      }

      if (window.location.pathname.includes('/trades')) {
        // Already on Trades page -> Sync now
        runManualTradeSync();
      } else {
        // On Live Chart or other page -> Navigate directly to Trades page with correct account, and auto-sync on load!
        const acct = detectAccountType();
        sessionStorage.setItem('bpf_auto_sync_target', 'true');
        sessionStorage.setItem('bpf_account_type', acct);

        const btn = document.getElementById('bpfSyncBtn');
        if (btn) {
          btn.disabled = true;
          setSyncBtnText('⏳ Trades পেজে যাওয়া হচ্ছে...');
        }

        showToast('🚀 Trades হিস্টোরি পেজে নিয়ে যাওয়া হচ্ছে, সেখানে স্বয়ংক্রিয়ভাবে সিঙ্ক হবে...', 'info');

        // Navigate straight to Quotex Trades page with account query
        window.location.href = `${window.location.origin}/en/trades?page=1&account=${acct}`;
      }
    });

    // Back to Chart Click Handler (if present)
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
    const traderDisp = document.getElementById('bpfTraderIdDisplay');
    if (traderDisp && config.traderId) {
      traderDisp.innerText = config.traderId;
    }
  }

  // Server Challenge Lock / Active Status Handler
  let isExtensionLocked = false;
  let lockReason = '';

  function handleServerStatusResponse(data) {
    if (!data) return;
    const pill = document.getElementById('bpfPill');
    const indicatorWrap = document.getElementById('bpfIndicatorWrap');
    const syncBtn = document.getElementById('bpfSyncBtn');

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

  // 5. Heartbeat Engine (Sends ping every 30s to keep dashboard connected)
  function sendHeartbeat() {
    if (!config.traderId) return;
    const targetUrl = (config.serverUrl || 'https://binarypropfirm.com').replace(/\/+$/, '') + '/api/extension/heartbeat';
    const accountType = detectAccountType();

    fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traderId: config.traderId,
        status: 'online',
        accountType,
        url: window.location.href,
        timestamp: Date.now()
      })
    })
    .then(res => res.json())
    .then(data => {
      handleServerStatusResponse(data);
    })
    .catch(() => {
      // Ignore background network heartbeat fail
    });
  }

  // 6. Parse Quotex Trade History Table from Document
  function parseQuotexTradesFromDoc(doc, forcedAccountType) {
    const trades = [];
    const accountType = forcedAccountType || detectAccountType();

    // Identify Table Rows (supports standard table or custom div-row grid)
    const rows = Array.from(doc.querySelectorAll('table tbody tr, .trades-table__row, [class*="table"] [class*="row"]'));

    rows.forEach((row) => {
      const text = row.innerText || '';
      // Skip header row
      if (text.includes('Asset') && text.includes('Profit')) return;

      const cells = Array.from(row.querySelectorAll('td, [class*="col"], [class*="cell"]'));
      if (cells.length < 5) return;

      try {
        // A. Asset (e.g. EUR/JPY, AUD/CAD OTC)
        let asset = '';
        const assetCell = cells[0];
        if (assetCell) {
          const pairMatch = assetCell.innerText.match(/([A-Z]{3}\/[A-Z]{3}(\s*\(?OTC\)?)?|[A-Z]{6})/i);
          asset = pairMatch ? pairMatch[0].trim() : assetCell.innerText.trim();
        }

        // B. Info: UUID Ticket Hash and Payout %
        let ticketId = '';
        let payout = '';
        const infoCell = cells[1] || cells[0];
        if (infoCell) {
          const uuidMatch = infoCell.innerText.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
          if (uuidMatch) ticketId = uuidMatch[0].toLowerCase();
          const payoutMatch = infoCell.innerText.match(/\d{1,3}%/);
          if (payoutMatch) payout = payoutMatch[0];
        }

        // C. Opening Quote: price & timestamp
        let openQuote = '';
        let openTime = '';
        cells.forEach(c => {
          const timeMatch = c.innerText.match(/\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4},?\s*\d{1,2}:\d{1,2}:\d{1,2}/);
          if (timeMatch && !openTime) {
            openTime = timeMatch[0];
            const lines = c.innerText.split('\n').map(s => s.trim()).filter(Boolean);
            openQuote = lines.find(l => /^\d+\.?\d*$/.test(l)) || lines[0] || '';
          }
        });

        // D. Closing Quote
        let closeQuote = '';
        let closeTime = '';
        let foundFirst = false;
        cells.forEach(c => {
          const timeMatch = c.innerText.match(/\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4},?\s*\d{1,2}:\d{1,2}:\d{1,2}/);
          if (timeMatch) {
            if (!foundFirst) {
              foundFirst = true;
            } else if (!closeTime) {
              closeTime = timeMatch[0];
              const lines = c.innerText.split('\n').map(s => s.trim()).filter(Boolean);
              closeQuote = lines.find(l => /^\d+\.?\d*$/.test(l)) || lines[0] || '';
            }
          }
        });

        // E. Amount & Direction (CALL vs PUT)
        let amount = 0;
        let direction = 'CALL';
        cells.forEach(c => {
          const cText = c.innerText;
          if (cText.includes('$') || cText.includes('€') || cText.includes('₹') || cText.includes('৳')) {
            const amtMatch = cText.match(/(\d+\.?\d*)\s*[$€₹৳]/) || cText.match(/[$€₹৳]\s*(\d+\.?\d*)/);
            if (amtMatch && !amount) {
              amount = parseFloat(amtMatch[1]);
              if (cText.includes('↓') || c.innerHTML.includes('down') || c.innerHTML.includes('arrow-down') || c.innerHTML.includes('red')) {
                direction = 'PUT';
              } else if (cText.includes('↑') || c.innerHTML.includes('up') || c.innerHTML.includes('arrow-up') || c.innerHTML.includes('green')) {
                direction = 'CALL';
              }
            }
          }
        });

        // F. Profit & Result (WIN / LOSS)
        let profit = 0;
        let result = 'LOSS';
        const lastCell = cells[cells.length - 1];
        if (lastCell) {
          const profMatch = lastCell.innerText.match(/(\d+\.?\d*)\s*[$€₹৳]/) || lastCell.innerText.match(/[$€₹৳]\s*(\d+\.?\d*)/);
          if (profMatch) {
            profit = parseFloat(profMatch[1]);
            if (profit > 0 || lastCell.style.color?.includes('green') || lastCell.className?.includes('green') || lastCell.className?.includes('success')) {
              result = 'WIN';
            }
          }
        }

        // Fallback unique ticketId if Quotex didn't show full UUID
        if (!ticketId && openTime && asset) {
          ticketId = 'qx_' + btoa(`${asset}_${openTime}_${amount}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 24);
        }

        if (asset && (openTime || amount > 0)) {
          trades.push({
            ticketId,
            asset,
            payout: payout || '90%',
            direction,
            openQuote: openQuote || '0.00',
            openTime: openTime || new Date().toLocaleString(),
            closeQuote: closeQuote || '0.00',
            closeTime: closeTime || new Date().toLocaleString(),
            amount: amount || 1.0,
            profit: profit || 0.0,
            result,
            accountType
          });
        }
      } catch (rowErr) {
        console.warn('[BPF Sync] Error parsing trade row:', rowErr);
      }
    });

    return { trades, accountType };
  }

  // 7. Send Trades to Prop Firm Server
  async function postTradesToServer(trades, accountType) {
    if (!config.traderId) {
      showToast('ত্রুটি: Trader ID সেট করা নেই! এক্সটেনশনে Trader ID লিখুন।', 'error');
      return { success: false, message: 'Trader ID not set' };
    }

    const targetUrl = (config.serverUrl || 'https://binarypropfirm.com').replace(/\/+$/, '') + '/api/extension/sync-trades';

    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traderId: config.traderId,
        accountType,
        source: 'quotex',
        trades
      })
    });

    return await res.json();
  }

  // 8. Wait for SPA Trade Table to Render
  function waitForTradesTable(callback, maxAttempts = 30) {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const rows = document.querySelectorAll('table tbody tr, .trades-table__row');
      const noData = document.querySelector('.no-data, [class*="no-data"]');

      if (rows.length > 0 || noData || attempts >= maxAttempts) {
        clearInterval(interval);
        callback();
      }
    }, 250);
  }

  // 9. Manual / Auto Sync Handler on /en/trades Page
  async function runManualTradeSync() {
    if (isSyncing) return;
    if (isExtensionLocked) {
      showToast(lockReason || '⚠️ আপনার চ্যালেঞ্জটি বর্তমানে বন্ধ/নিষ্ক্রিয় রয়েছে। এক্সটেনশন কোনো ট্রেড সিঙ্ক করবে না।', 'error');
      return;
    }
    isSyncing = true;

    const btn = document.getElementById('bpfSyncBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>⏳ সিঙ্ক হচ্ছে...</span>';
    }

    loadConfig(async () => {
      const acctType = detectAccountType();
      const { trades } = parseQuotexTradesFromDoc(document, acctType);

      if (!trades || trades.length === 0) {
        showToast('ট্রেড লিস্টে কোনো ট্রেড পাওয়া যায়নি। পেজটি স্ক্রল বা রিফ্রেশ করুন।', 'error');
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

        if (result && (result.isDisqualified || result.noActiveChallenge)) {
          handleServerStatusResponse(result);
          showToast('⚠️ ' + (result.message || 'চ্যালেঞ্জ বন্ধ থাকায় এক্সটেনশন কোনো ট্রেড গ্রহণ করবে না।'), 'error');
        } else if (result && result.success) {
          handleServerStatusResponse({ active: true });
          trades.forEach(t => syncedTicketsCache.add(t.ticketId));
          saveSyncedCache();
          showToast(result.message || `${trades.length} টি ট্রেড সফলভাবে সিঙ্ক হয়েছে!`, 'success');
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

  // 10. Check and Auto-Sync on /en/trades Page
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

  // 11. Listen for messages from popup
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req.action === 'TRIGGER_SYNC') {
        if (isExtensionLocked) {
          sendResponse({ success: false, error: lockReason || 'আপনার চ্যালেঞ্জটি বন্ধ বা বাতিল রয়েছে।' });
          return true;
        }
        if (!window.location.pathname.includes('/trades')) {
          const acct = detectAccountType();
          sessionStorage.setItem('bpf_auto_sync_target', 'true');
          window.location.href = `${window.location.origin}/en/trades?page=1&account=${acct}`;
          sendResponse({ success: true, message: 'Trades অপশনে নেওয়া হচ্ছে...' });
          return true;
        } else {
          const acct = detectAccountType();
          const { trades } = parseQuotexTradesFromDoc(document, acct);
          if (!trades || trades.length === 0) {
            sendResponse({ success: false, error: 'ট্রেড পাওয়া যায়নি। পেজটি স্ক্রল বা রিফ্রেশ করুন।' });
            return true;
          }
          postTradesToServer(trades, acct).then(res => {
            sendResponse(res);
          }).catch(err => {
            sendResponse({ success: false, error: err.message });
          });
          return true;
        }
      }
    });
  }

  // 12. Initialization
  function startExtension() {
    loadConfig(() => {
      injectWidget();
      sendHeartbeat();

      // Start 30s Heartbeat Engine
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(sendHeartbeat, 30000);

      // If on Trade History page, check for auto-sync after status verified
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
