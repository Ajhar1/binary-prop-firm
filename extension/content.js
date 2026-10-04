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
  let liveWatcherTimer = null;
  let warnedNoActiveChallenge = false;

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
      // Save last 500 ticket IDs
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
    }, 4500);
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
    const isLivePage = window.location.pathname.includes('/demo-trade') || window.location.pathname.includes('/trade');
    const isHistoryPage = window.location.pathname.includes('/trades');
    const traderLabel = config.traderId ? config.traderId : 'ID Not Set';

    root.innerHTML = `
      <div class="bpf-pill" id="bpfPill" title="Binary Prop Firm - Live Synchronizer">
        <span class="bpf-logo-badge">BPF</span>
        <span class="bpf-status-text">
          Trader: <strong id="bpfTraderIdDisplay">${traderLabel}</strong>
        </span>
        <span class="bpf-account-tag ${accountType === 'live' ? 'live' : 'demo'}" id="bpfAcctTag">
          ${accountType === 'live' ? 'LIVE' : 'DEMO'}
        </span>
        <div class="bpf-indicator-wrap" id="bpfIndicatorWrap" title="লাইভ অটো-সিঙ্ক সচল রয়েছে">
          <span class="bpf-pulse-dot"></span>
          <span class="bpf-indicator-label">${isLivePage ? 'Auto-Sync' : 'Connected'}</span>
        </div>
        <button class="bpf-btn-sync" id="bpfSyncBtn">
          <span>${isHistoryPage ? '⚡ Sync Trades' : (isLivePage ? '🔄 Sync Now' : '📊 Trade History')}</span>
        </button>
      </div>
    `;

    document.body.appendChild(root);

    document.getElementById('bpfSyncBtn').addEventListener('click', () => {
      if (window.location.pathname.includes('/trades')) {
        runManualTradeSync();
      } else if (isLivePage) {
        silentLiveSync(true);
      } else {
        const acct = detectAccountType();
        window.location.href = `https://market-qx.info/en/trades?page=1&account=${acct}`;
      }
    });
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

  // 5. Module 3: Heartbeat Engine (Sends ping every 30s)
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
    }).catch(() => {
      // Ignore background network heartbeat fail
    });
  }

  // 6. Parse Quotex Trade History Table from any Document/DOM
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

  // 8. Module 2: Zero-Click Live Chart Auto-Capture (Silent Background Sync)
  async function silentLiveSync(isUserTriggered = false) {
    if (isSyncing) return;
    if (!config.traderId) return;

    isSyncing = true;
    const acctType = detectAccountType();

    try {
      // Fetch latest trade history silently using active session
      const historyUrl = `${window.location.origin}/en/trades?page=1&account=${acctType}`;
      const res = await fetch(historyUrl, { credentials: 'include' });
      if (!res.ok) {
        isSyncing = false;
        return;
      }

      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const { trades } = parseQuotexTradesFromDoc(doc, acctType);

      if (!trades || trades.length === 0) {
        if (isUserTriggered) {
          showToast('কোনো ট্রেড পাওয়া যায়নি।', 'info');
        }
        isSyncing = false;
        return;
      }

      // Filter trades not yet cached
      const unsyncedTrades = trades.filter(t => !syncedTicketsCache.has(t.ticketId));

      if (unsyncedTrades.length > 0) {
        const result = await postTradesToServer(unsyncedTrades, acctType);

        if (result && result.success) {
          unsyncedTrades.forEach(t => syncedTicketsCache.add(t.ticketId));
          saveSyncedCache();

          if (result.addedCount > 0) {
            const firstTrade = unsyncedTrades[0];
            const pnlStr = firstTrade.result === 'WIN' ? `+$${firstTrade.profit}` : `-$${firstTrade.amount}`;
            const badgeType = acctType === 'live' ? 'রিয়েল' : 'ডেমো';
            showToast(`⚡ [${badgeType}] নতুন ট্রেড সিঙ্ক হয়েছে: ${firstTrade.asset} (${pnlStr})`, 'success');
          } else if (result.filteredOldCount > 0 && !isUserTriggered) {
            // Old trades filtered silently
          } else if (isUserTriggered) {
            showToast(result.message || 'ট্রেড আপডেট হয়েছে।', 'success');
          }
        } else if (result && result.noActiveChallenge) {
          if (!warnedNoActiveChallenge || isUserTriggered) {
            showToast('⚠️ আপনার অ্যাকাউন্টে কোনো সক্রিয় চ্যালেঞ্জ (in_progress) চালু নেই।', 'error');
            warnedNoActiveChallenge = true;
          }
        } else if (isUserTriggered && result?.message) {
          showToast(result.message, 'error');
        }
      } else if (isUserTriggered) {
        showToast('সকল ট্রেড ইতিমধ্যে সিঙ্ক রয়েছে!', 'success');
      }
    } catch (err) {
      console.warn('[BPF Live Auto-Sync Error]', err);
      if (isUserTriggered) {
        showToast('সিঙ্ক ত্রুটি: ' + err.message, 'error');
      }
    } finally {
      isSyncing = false;
    }
  }

  // 9. Manual Sync on /en/trades History Page
  async function runManualTradeSync() {
    const btn = document.getElementById('bpfSyncBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerText = '⏳ Syncing...';
    }

    loadConfig(async () => {
      const acctType = detectAccountType();
      const { trades } = parseQuotexTradesFromDoc(document, acctType);

      if (!trades || trades.length === 0) {
        showToast('ট্রেড লিস্টে কোনো ট্রেড পাওয়া যায়নি। পেজটি স্ক্রল বা রিফ্রেশ করুন।', 'error');
        if (btn) {
          btn.disabled = false;
          btn.innerText = '⚡ Sync Trades';
        }
        return;
      }

      try {
        const result = await postTradesToServer(trades, acctType);

        if (btn) {
          btn.disabled = false;
          btn.innerText = '⚡ Sync Trades';
        }

        if (result && result.success) {
          trades.forEach(t => syncedTicketsCache.add(t.ticketId));
          saveSyncedCache();
          showToast(result.message || `${trades.length} টি ট্রেড সফলভাবে সিঙ্ক হয়েছে!`, 'success');
        } else if (result && result.noActiveChallenge) {
          showToast('⚠️ কোনো সক্রিয় চ্যালেঞ্জ পাওয়া যায়নি! ট্রেড সেভ করার জন্য চ্যালেঞ্জ সক্রিয় থাকতে হবে।', 'error');
        } else {
          showToast(result?.message || 'সিঙ্ক ব্যর্থ হয়েছে।', 'error');
        }
      } catch (err) {
        if (btn) {
          btn.disabled = false;
          btn.innerText = '⚡ Sync Trades';
        }
        showToast('সার্ভার কানেকশন ত্রুটি: ' + err.message, 'error');
      }
    });
  }

  // 10. Live Chart Sidebar DOM Observer (Zero-Click Trigger)
  function initLiveChartWatcher() {
    const isLivePage = window.location.pathname.includes('/demo-trade') || window.location.pathname.includes('/trade');
    if (!isLivePage) return;

    // Observe changes in document body for trades panel changes
    let observerTimeout = null;
    const observer = new MutationObserver(() => {
      if (observerTimeout) clearTimeout(observerTimeout);
      observerTimeout = setTimeout(() => {
        silentLiveSync(false);
        updateWidgetStatus();
      }, 1200);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Also run periodic poll every 8 seconds on live chart
    if (liveWatcherTimer) clearInterval(liveWatcherTimer);
    liveWatcherTimer = setInterval(() => {
      silentLiveSync(false);
      updateWidgetStatus();
    }, 8000);

    // Initial silent check on live chart after 3 seconds
    setTimeout(() => {
      silentLiveSync(false);
    }, 3000);
  }

  // 11. Listen for messages from popup
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req.action === 'TRIGGER_SYNC') {
        const isLivePage = window.location.pathname.includes('/demo-trade') || window.location.pathname.includes('/trade');
        if (isLivePage) {
          silentLiveSync(true).then(() => {
            sendResponse({ success: true, message: 'লাইভ চার্ট থেকে সিঙ্ক সম্পন্ন হয়েছে!' });
          }).catch(err => {
            sendResponse({ success: false, error: err.message });
          });
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
        }
        return true;
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

      const path = window.location.pathname.toLowerCase();

      // If on Trade History page and autoSync is enabled
      if (path.includes('/trades') && config.autoSync && config.traderId) {
        setTimeout(() => {
          runManualTradeSync();
        }, 2200);
      }

      // If on Live Chart page, start zero-click watcher
      if (path.includes('/demo-trade') || path.includes('/trade')) {
        initLiveChartWatcher();
      }
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startExtension);
  } else {
    startExtension();
  }
})();
