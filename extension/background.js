// Binary Prop Firm - Extension Background Service Worker
chrome.runtime.onInstalled.addListener(() => {
  console.log('[BPF Background] Service worker installed.');
});

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
  if (msg.action === 'PING_SERVER') {
    sendBackgroundHeartbeat().then(() => sendResponse({ success: true }));
    return true;
  }
});
