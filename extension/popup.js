document.addEventListener('DOMContentLoaded', async () => {
  const traderIdInput = document.getElementById('traderId');
  const serverUrlInput = document.getElementById('serverUrl');
  const autoSyncCheckbox = document.getElementById('autoSync');
  const syncNowBtn = document.getElementById('syncNowBtn');
  const statusBox = document.getElementById('statusBox');
  const connBadge = document.getElementById('connBadge');
  const lastSyncedText = document.getElementById('lastSyncedText');
  const openHistoryBtn = document.getElementById('openHistoryBtn');
  const openDashBtn = document.getElementById('openDashBtn');

  // Load saved settings
  chrome.storage.local.get(['traderId', 'serverUrl', 'autoSync', 'lastSynced', 'lastCount'], (res) => {
    if (res.traderId) traderIdInput.value = res.traderId;
    if (res.serverUrl) serverUrlInput.value = res.serverUrl;
    if (res.autoSync !== undefined) autoSyncCheckbox.checked = res.autoSync;
    if (res.lastSynced) {
      const d = new Date(res.lastSynced);
      lastSyncedText.innerText = `Last: ${d.toLocaleTimeString()} (${res.lastCount || 0} trades)`;
      connBadge.className = 'badge badge-active';
      connBadge.innerText = '● Active';
    }
  });

  // Save settings on input
  function saveSettings() {
    chrome.storage.local.set({
      traderId: traderIdInput.value.trim(),
      serverUrl: serverUrlInput.value.trim() || 'https://binarypropfirm.com',
      autoSync: autoSyncCheckbox.checked
    });
  }
  traderIdInput.addEventListener('input', saveSettings);
  serverUrlInput.addEventListener('input', saveSettings);
  autoSyncCheckbox.addEventListener('change', saveSettings);

  function showStatus(msg, type = 'success') {
    statusBox.style.display = 'block';
    statusBox.className = `status-box status-${type}`;
    statusBox.innerText = msg;
  }

  // Handle Sync Now Click
  syncNowBtn.addEventListener('click', async () => {
    const traderId = traderIdInput.value.trim();
    if (!traderId) {
      showStatus('অনুগ্রহ করে আপনার Trader ID লিখুন।', 'error');
      traderIdInput.focus();
      return;
    }

    saveSettings();
    syncNowBtn.disabled = true;
    syncNowBtn.innerText = '⏳ Scanning & Syncing...';

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || (!tab.url.includes('market-qx.info') && !tab.url.includes('quotex.com'))) {
        showStatus('Quotex Trade History পেজ ওপেন করুন: market-qx.info/en/trades', 'error');
        syncNowBtn.disabled = false;
        syncNowBtn.innerText = '🚀 Sync Quotex Trades Now';
        return;
      }

      // Send sync trigger to content script in the active tab
      chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_SYNC' }, (response) => {
        syncNowBtn.disabled = false;
        syncNowBtn.innerText = '🚀 Sync Quotex Trades Now';

        if (chrome.runtime.lastError) {
          showStatus('পেজটি একবার রিলোড (F5) দিন এবং আবার সিঙ্ক বাটন চাপুন।', 'error');
          return;
        }

        if (response && response.success) {
          showStatus(`✅ ${response.message || 'ট্রেড সফলভাবে সিঙ্ক হয়েছে!'}`, 'success');
          connBadge.className = 'badge badge-active';
          connBadge.innerText = '● Synced';
          lastSyncedText.innerText = `Last: ${new Date().toLocaleTimeString()} (${response.count || 0} trades)`;
        } else {
          showStatus(response?.error || 'কোনো ট্রেড পাওয়া যায়নি বা সিঙ্ক ব্যর্থ হয়েছে।', 'error');
        }
      });
    } catch (err) {
      console.error(err);
      syncNowBtn.disabled = false;
      syncNowBtn.innerText = '🚀 Sync Quotex Trades Now';
      showStatus('ত্রুটি: ' + err.message, 'error');
    }
  });

  // Quick navigation buttons
  openHistoryBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://market-qx.info/en/trades?page=1&account=demo' });
  });

  openDashBtn.addEventListener('click', () => {
    const sUrl = serverUrlInput.value.trim() || 'https://binarypropfirm.com';
    chrome.tabs.create({ url: `${sUrl}/dashboard.html#trading-history` });
  });
});
