// Binary Prop Firm - Extension Background Service Worker
chrome.runtime.onInstalled.addListener(() => {
  console.log('[BPF Background] Service worker installed.');
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
    fetchOptions.body = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body);
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
  chrome.storage.local.get(['traderId', 'serverUrl'], async (res) => {
    if (!res.traderId) return;
    const url = (res.serverUrl || 'https://binarypropfirm.com').replace(/\/+$/, '') + '/api/extension/heartbeat';
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traderId: res.traderId,
          status: 'online',
          accountType: 'demo',
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

  if (msg.action === 'PING_SERVER') {
    sendBackgroundHeartbeat().then(() => sendResponse({ success: true }));
    return true;
  }
});
