// Binary Prop Firm - Quotex Trade Synchronizer Content Script
(function () {
  let config = {
    traderId: '',
    serverUrl: 'https://binarypropfirm.com',
    autoSync: true
  };

  // 1. Load config from chrome.storage.local
  function loadConfig(cb) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['traderId', 'serverUrl', 'autoSync'], (res) => {
        if (res.traderId) config.traderId = res.traderId;
        if (res.serverUrl) config.serverUrl = res.serverUrl;
        if (res.autoSync !== undefined) config.autoSync = res.autoSync;
        if (cb) cb();
      });
    } else if (cb) {
      cb();
    }
  }

  // 2. Inject floating widget onto Quotex page
  function injectWidget() {
    if (document.getElementById('bpf-sync-widget-root')) return;

    const root = document.createElement('div');
    root.id = 'bpf-sync-widget-root';

    const traderLabel = config.traderId ? config.traderId : 'ID Not Set';
    const isHistoryPage = window.location.pathname.includes('/trades');

    root.innerHTML = `
      <div class="bpf-pill" id="bpfPill">
        <span class="bpf-logo-badge">BPF</span>
        <span class="bpf-status-text">Trader: <span id="bpfTraderIdDisplay">${traderLabel}</span></span>
        <button class="bpf-btn-sync" id="bpfSyncBtn">
          <span>${isHistoryPage ? '⚡ Sync Trades' : '📊 Trade History'}</span>
        </button>
      </div>
    `;

    document.body.appendChild(root);

    document.getElementById('bpfSyncBtn').addEventListener('click', () => {
      if (window.location.pathname.includes('/trades')) {
        runTradeSync(true);
      } else {
        // Navigate to trade history page
        window.location.href = 'https://market-qx.info/en/trades?page=1&account=demo';
      }
    });
  }

  // 3. Show stylish floating toast notification
  function showToast(message, type = 'success') {
    const oldToast = document.getElementById('bpf-toast');
    if (oldToast) oldToast.remove();

    const toast = document.createElement('div');
    toast.id = 'bpf-toast';
    toast.className = type === 'error' ? 'error' : '';
    toast.innerHTML = `
      <span>${type === 'error' ? '⚠️' : '✅'}</span>
      <span>${message}</span>
    `;

    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast && toast.parentNode) toast.remove();
    }, 4500);
  }

  // 4. Parse Quotex Trade History Table
  function parseQuotexTrades() {
    const trades = [];

    // Detect Account Type (Demo vs Live)
    let accountType = 'demo';
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('account') === 'live') {
      accountType = 'live';
    } else {
      // Check account dropdown text if present
      const accountSelector = document.querySelector('.select-account, [class*="account-select"], [class*="accountType"]');
      if (accountSelector && accountSelector.innerText.toLowerCase().includes('live')) {
        accountType = 'live';
      }
    }

    // Identify Table Rows (supports standard table or custom div-row grid)
    const rows = Array.from(document.querySelectorAll('table tbody tr, .trades-table__row, [class*="table"] [class*="row"]'));

    rows.forEach((row, idx) => {
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
        // Find cell containing timestamp (DD/MM/YYYY, HH:MM:SS)
        cells.forEach(c => {
          const timeMatch = c.innerText.match(/\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{1,2}:\d{1,2}/);
          if (timeMatch && !openTime) {
            openTime = timeMatch[0];
            const lines = c.innerText.split('\n').map(s => s.trim()).filter(Boolean);
            openQuote = lines.find(l => /^\d+\.?\d*$/.test(l)) || lines[0] || '';
          } else if (timeMatch && openTime && !window._foundClose) {
            // will catch closeQuote in D
          }
        });

        // D. Closing Quote
        let closeQuote = '';
        let closeTime = '';
        let foundFirst = false;
        cells.forEach(c => {
          const timeMatch = c.innerText.match(/\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{1,2}:\d{1,2}/);
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
          if (cText.includes('$') || cText.includes('€') || cText.includes('₹')) {
            const amtMatch = cText.match(/(\d+\.?\d*)\s*[$€₹]/) || cText.match(/[$€₹]\s*(\d+\.?\d*)/);
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
          const profMatch = lastCell.innerText.match(/(\d+\.?\d*)\s*[$€₹]/) || lastCell.innerText.match(/[$€₹]\s*(\d+\.?\d*)/);
          if (profMatch) {
            profit = parseFloat(profMatch[1]);
            if (profit > 0 || lastCell.style.color?.includes('green') || lastCell.className?.includes('green') || lastCell.className?.includes('success')) {
              result = 'WIN';
            }
          }
        }

        // Fallback ticketId if Quotex didn't show full UUID
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
        console.warn('[BPF Sync] Error parsing row:', rowErr);
      }
    });

    return { trades, accountType };
  }

  // 5. Send Parsed Trades to Binary Prop Firm Server
  async function runTradeSync(isManual = false) {
    const btn = document.getElementById('bpfSyncBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerText = '⏳ Syncing...';
    }

    loadConfig(async () => {
      if (!config.traderId) {
        showToast('ত্রুটি: আপনার Trader ID সেট করা নেই! এক্সটেনশন আইকনে ক্লিক করে Trader ID লিখুন।', 'error');
        if (btn) {
          btn.disabled = false;
          btn.innerText = '⚡ Sync Trades';
        }
        return;
      }

      const { trades, accountType } = parseQuotexTrades();

      if (!trades || trades.length === 0) {
        if (isManual) {
          showToast('কোনো ট্রেড পাওয়া যায়নি। দয়া করে পেজটি একবার রিফ্রেশ করুন এবং ট্রেড লিস্ট দৃশ্যমান রয়েছে কিনা চেক করুন।', 'error');
        }
        if (btn) {
          btn.disabled = false;
          btn.innerText = '⚡ Sync Trades';
        }
        return;
      }

      try {
        const targetUrl = (config.serverUrl || 'https://binarypropfirm.com').replace(/\/+$/, '') + '/api/extension/sync-trades';

        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            traderId: config.traderId,
            accountType,
            source: 'quotex',
            trades
          })
        });

        const data = await res.json();

        if (btn) {
          btn.disabled = false;
          btn.innerText = '⚡ Sync Trades';
        }

        if (data && data.success) {
          const msg = data.message || `${trades.length} টি ট্রেড সফলভাবে সিঙ্ক হয়েছে!`;
          showToast(msg, 'success');

          // Save last synced timestamp in storage
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({
              lastSynced: new Date().toISOString(),
              lastCount: trades.length
            });
          }
        } else {
          showToast(data.message || 'সিঙ্ক ব্যর্থ হয়েছে। সার্ভার রেসপন্স চেক করুন।', 'error');
        }
      } catch (netErr) {
        console.error('[BPF Sync Net Error]', netErr);
        if (btn) {
          btn.disabled = false;
          btn.innerText = '⚡ Sync Trades';
        }
        showToast('সার্ভার কানেকশন ত্রুটি: ' + netErr.message, 'error');
      }
    });
  }

  // 6. Listen for messages from popup
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req.action === 'TRIGGER_SYNC') {
        const { trades, accountType } = parseQuotexTrades();
        if (!trades || trades.length === 0) {
          sendResponse({ success: false, error: 'Quotex ট্রেড টেবিলে কোনো ডাটা পাওয়া যায়নি। পেজটি স্ক্রল বা রিফ্রেশ করুন।' });
          return true;
        }

        runTradeSync(true).then(() => {
          sendResponse({ success: true, count: trades.length, message: `${trades.length} টি ট্রেড সফলভাবে সিঙ্ক হয়েছে!` });
        }).catch(err => {
          sendResponse({ success: false, error: err.message });
        });

        return true; // Keep message channel open for async response
      }
    });
  }

  // 7. Auto Run on Page Load
  window.addEventListener('load', () => {
    loadConfig(() => {
      injectWidget();

      // If on Trade History page and autoSync is enabled, trigger auto-sync after brief delay
      if (window.location.pathname.includes('/trades') && config.autoSync && config.traderId) {
        setTimeout(() => {
          runTradeSync(false);
        }, 2000);
      }
    });
  });

  // Also try immediately in case DOM is already ready
  loadConfig(() => {
    injectWidget();
  });
})();
