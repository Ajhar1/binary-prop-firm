// Binary Prop Firm - Extension Background Service Worker
chrome.runtime.onInstalled.addListener(() => {
  console.log('[BPF Background] Service worker installed.');
});

// In-memory fallback cache for verified Quotex Account IDs
let cachedQuotexAccountId = null;
chrome.storage.local.get(['quotex_detected_account_id'], (res) => {
  if (res && res.quotex_detected_account_id) {
    cachedQuotexAccountId = String(res.quotex_detected_account_id).replace(/[^0-9]/g, '');
  }
});

// Universal Background API Proxy - Bypasses all webpage CSP restrictions
async function handleBackgroundApiFetch(msg) {
  const serverUrl = (msg.serverUrl || 'https://binarypropfirm.com').replace(/\/+$/, '');
  const endpoint = msg.endpoint || '';
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  const targetUrl = serverUrl + cleanEndpoint;

  const method = (msg.method || 'POST').toUpperCase();
  const headers = {
    'Content-Type': 'application/json',
    ...(msg.headers || {})
  };

  const fetchOptions = {
    method,
    headers
  };

  if (method !== 'GET' && method !== 'HEAD' && msg.body !== undefined) {
    let bodyObj = typeof msg.body === 'string' ? null : msg.body;
    if (typeof msg.body === 'string') {
      try { bodyObj = JSON.parse(msg.body); } catch(e) {}
    }

    // Auto-inject verified Quotex Account ID if missing in sync payload
    if (cleanEndpoint.includes('/api/extension/sync-trades') && bodyObj) {
      if (!bodyObj.detectedBrokerAccountId) {
        if (!cachedQuotexAccountId) {
          try {
            const stored = await new Promise(r => chrome.storage.local.get(['quotex_detected_account_id'], r));
            if (stored && stored.quotex_detected_account_id) {
              cachedQuotexAccountId = String(stored.quotex_detected_account_id).replace(/[^0-9]/g, '');
            }
          } catch(e) {}
        }
        if (cachedQuotexAccountId) {
          bodyObj.detectedBrokerAccountId = cachedQuotexAccountId;
          console.log('[BPF Background] Injected cached Quotex Account ID into sync payload:', cachedQuotexAccountId);
        }
      } else {
        cachedQuotexAccountId = String(bodyObj.detectedBrokerAccountId).replace(/[^0-9]/g, '');
      }
    }

    fetchOptions.body = bodyObj ? JSON.stringify(bodyObj) : (typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body));
  }

  try {
    const res = await fetch(targetUrl, fetchOptions);
    let data;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { rawText: text, message: text };
    }

    // Auto-invalidate stale cached Quotex ID if server reports an account mismatch
    if (data && data.accountMismatch) {
      console.warn('[BPF Background] Account mismatch detected by server. Purging stale Quotex ID:', cachedQuotexAccountId);
      cachedQuotexAccountId = null;
      chrome.storage.local.remove(['quotex_detected_account_id']);
    }

    return {
      success: true,
      ok: res.ok,
      status: res.status,
      data
    };
  } catch (err) {
    console.error('[BPF Background Fetch Error]', targetUrl, err);
    return {
      success: false,
      ok: false,
      status: 0,
      error: err.message || 'Network request failed'
    };
  }
}

// Periodic keepalive / heartbeat engine
async function sendBackgroundHeartbeat() {
  chrome.storage.local.get(['traderId', 'serverUrl', 'quotex_detected_account_id'], async (res) => {
    if (!res.traderId) return;
    const url = (res.serverUrl || 'https://binarypropfirm.com').replace(/\/+$/, '') + '/api/extension/heartbeat';
    const detectedId = res.quotex_detected_account_id ? String(res.quotex_detected_account_id).replace(/[^0-9]/g, '') : cachedQuotexAccountId;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traderId: res.traderId,
          status: 'online',
          accountType: 'demo',
          detectedBrokerAccountId: detectedId || null,
          url: 'background',
          timestamp: Date.now()
        })
      });
    } catch (e) {}
  });
}

// Listen for messages from popup or content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'API_FETCH') {
    handleBackgroundApiFetch(msg).then((result) => {
      sendResponse(result);
    });
    return true; // Keep asynchronous message port open
  }

  if (msg.action === 'SAVE_QUOTEX_ID') {
    const cleanId = String(msg.id || '').replace(/[^0-9]/g, '');
    if (cleanId) {
      cachedQuotexAccountId = cleanId;
      chrome.storage.local.set({ quotex_detected_account_id: cleanId }, () => {
        sendResponse({ success: true, id: cleanId });
      });
      return true;
    }
    sendResponse({ success: false });
    return false;
  }

  if (msg.action === 'CLEAR_QUOTEX_ID') {
    console.log('[BPF Background] Clearing cached Quotex Account ID upon user or mismatch request.');
    cachedQuotexAccountId = null;
    chrome.storage.local.remove(['quotex_detected_account_id'], () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.action === 'PING_SERVER') {
    sendBackgroundHeartbeat().then(() => sendResponse({ success: true }));
    return true;
  }
});
