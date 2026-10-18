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

  let cachedRegBrokerId = '';
  let cachedDetectedBrokerId = '';

  function updateIdMatchUi(regId, activeId) {
    if (regId !== undefined) cachedRegBrokerId = String(regId || '').trim();
    if (activeId !== undefined) cachedDetectedBrokerId = String(activeId || '').trim();

    const regEl = document.getElementById('popupRegId');
    const actEl = document.getElementById('popupActiveId');
    const tagEl = document.getElementById('popupIdStatusTag');
    if (!regEl || !actEl || !tagEl) return;

    const cleanReg = cachedRegBrokerId.replace(/[^0-9]/g, '');
    const cleanAct = cachedDetectedBrokerId.replace(/[^0-9]/g, '');

    regEl.innerText = cleanReg || (cachedRegBrokerId ? cachedRegBrokerId : '--');
    actEl.innerText = cleanAct || (cachedDetectedBrokerId ? cachedDetectedBrokerId : '--');

    if (cleanReg && cleanAct) {
      if (cleanReg === cleanAct) {
        tagEl.style.background = 'rgba(0, 230, 118, 0.15)';
        tagEl.style.color = '#00e676';
        tagEl.style.border = '1px solid rgba(0, 230, 118, 0.3)';
        tagEl.innerText = '✅ Quotex Account ID Verified';
      } else {
        tagEl.style.background = 'rgba(239, 68, 68, 0.18)';
        tagEl.style.color = '#ef4444';
        tagEl.style.border = '1px solid rgba(239, 68, 68, 0.35)';
        tagEl.innerText = '⚠️ Quotex ID Mismatch (Sync Blocked)';
      }
    } else if (cleanReg) {
      tagEl.style.background = 'rgba(245, 158, 11, 0.12)';
      tagEl.style.color = '#fbbf24';
      tagEl.style.border = '1px solid rgba(245, 158, 11, 0.25)';
      tagEl.innerText = 'ℹ️ লগইনকৃত Quotex ID স্ক্যান করা হচ্ছে...';
    } else {
      tagEl.style.background = 'rgba(148, 163, 184, 0.1)';
      tagEl.style.color = '#94a3b8';
      tagEl.style.border = '1px solid rgba(148, 163, 184, 0.2)';
      tagEl.innerText = 'অ্যাকাউন্ট ভেরিফিকেশন চেক করা হচ্ছে';
    }
  }

  async function pingServerHeartbeat(tId, sUrl) {
    const tid = (tId || traderIdInput.value).trim();
    if (!tid) return;
    const surl = (sUrl || serverUrlInput.value || 'https://binarypropfirm.com').trim().replace(/\/+$/, '');
    try {
      const res = await fetch(surl + '/api/extension/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traderId: tid,
          status: 'online',
          accountType: 'demo',
          url: 'popup',
          timestamp: Date.now()
        })
      });
      const data = await res.json();
      if (data && data.registeredBrokerAccountId !== undefined) {
        cachedRegBrokerId = String(data.registeredBrokerAccountId || '').trim();
        chrome.storage.local.set({ quotex_registered_broker_id: cachedRegBrokerId });
        updateIdMatchUi(cachedRegBrokerId, cachedDetectedBrokerId);
      }
      if (data && data.active) {
        connBadge.className = 'badge badge-active';
        connBadge.innerText = '● Connected';
      } else if (data && data.isDisqualified) {
        connBadge.className = 'badge badge-locked';
        connBadge.innerText = '● Locked';
      }
    } catch (e) {}
  }

  // Load saved settings
  chrome.storage.local.get([
    'traderId',
    'serverUrl',
    'autoSync',
    'lastSynced',
    'lastCount',
    'quotex_broker_tz_str',
    'quotex_registered_broker_id',
    'quotex_detected_account_id'
  ], (res) => {
    if (res.traderId) {
      traderIdInput.value = res.traderId;
      pingServerHeartbeat(res.traderId, res.serverUrl);
    }
    if (res.serverUrl) serverUrlInput.value = res.serverUrl;
    if (res.autoSync !== undefined) autoSyncCheckbox.checked = res.autoSync;
    if (res.quotex_broker_tz_str) {
      const tzText = document.getElementById('brokerTzText');
      const tzTag = document.getElementById('brokerTzTag');
      if (tzText) tzText.innerText = `⏱️ ব্রোকার টাইম: ${res.quotex_broker_tz_str}`;
      if (tzTag) tzTag.innerText = res.quotex_broker_tz_str;
    }
    updateIdMatchUi(res.quotex_registered_broker_id, res.quotex_detected_account_id);

    if (res.lastSynced) {
      const d = new Date(res.lastSynced);
      lastSyncedText.innerText = `Last: ${d.toLocaleTimeString()} (${res.lastCount || 0} trades)`;
      connBadge.className = 'badge badge-active';
      connBadge.innerText = '● Active';
    }
  });

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.quotex_registered_broker_id || changes.quotex_detected_account_id) {
        chrome.storage.local.get(['quotex_registered_broker_id', 'quotex_detected_account_id'], (res) => {
          updateIdMatchUi(res.quotex_registered_broker_id, res.quotex_detected_account_id);
        });
      }
    });
  }

  // Save settings on input
  let saveTimer = null;
  function saveSettings() {
    const tId = traderIdInput.value.trim();
    const sUrl = serverUrlInput.value.trim() || 'https://binarypropfirm.com';
    chrome.storage.local.set({
      traderId: tId,
      serverUrl: sUrl,
      autoSync: autoSyncCheckbox.checked
    });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => pingServerHeartbeat(tId, sUrl), 400);
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

    // Check account ID match before triggering
    const cleanReg = cachedRegBrokerId.replace(/[^0-9]/g, '');
    const cleanAct = cachedDetectedBrokerId.replace(/[^0-9]/g, '');
    if (cleanReg && cleanAct && cleanReg !== cleanAct) {
      showStatus(`⚠️ Quotex ID মিলছে না! চ্যালেঞ্জের ID: ${cleanReg}, কিন্তু লগইনকৃত ID: ${cleanAct}। ট্রেড সিঙ্ক সম্পূর্ণ ব্লক রাখা হয়েছে।`, 'error');
      return;
    }

    saveSettings();
    syncNowBtn.disabled = true;
    syncNowBtn.innerText = '⏳ Scanning & Syncing...';

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url || (!tab.url.includes('market-qx.info') && !tab.url.includes('quotex.com') && !tab.url.includes('qxbroker.com'))) {
        chrome.tabs.create({ url: 'https://market-qx.info/en/trades?page=1&account=demo' });
        showStatus('Quotex Trades পেজ ওপেন করা হচ্ছে...', 'success');
        syncNowBtn.disabled = false;
        syncNowBtn.innerText = '🚀 Sync Quotex Trades Now';
        return;
      }

      // If active tab is on Quotex but not on /trades, navigate directly to /trades
      if (!tab.url.includes('/trades')) {
        chrome.tabs.update(tab.id, { url: 'https://market-qx.info/en/trades?page=1&account=demo' });
        showStatus('🚀 Trades পেজে নেওয়া হচ্ছে, সেখানে অটোমেটিক সিঙ্ক হবে...', 'success');
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

        if (response && response.accountMismatch) {
          showStatus(`⚠️ ${response.error || 'Quotex Account ID মিলছে না! ট্রেড সিঙ্ক ব্লক করা হয়েছে।'}`, 'error');
          return;
        }

        if (response && response.success) {
          showStatus(`✅ ${response.message || 'ট্রেড সফলভাবে সিঙ্ক হয়েছে!'}`, 'success');
          connBadge.className = 'badge badge-active';
          connBadge.innerText = '● Synced';
          lastSyncedText.innerText = `Last: ${new Date().toLocaleTimeString()} (${response.count || 0} trades)`;
        } else {
          showStatus(response?.error || 'কোনো ট্রেড পাওয়া যায়নি বা সিঙ্ক ব্যর্থ হয়েছে।', 'error');
          if (response?.error && (response.error.includes('বাতিল') || response.error.includes('বন্ধ') || response.error.includes('নিষ্ক্রিয়') || response.error.includes('ডিসকোয়ালিফাই'))) {
            connBadge.className = 'badge badge-locked';
            connBadge.innerText = '● Locked';
          }
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
