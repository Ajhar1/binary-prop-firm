// Binary Prop Firm - PWA Controller & Smart Installation Engine
(function() {
  'use strict';

  // 1. Register Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then((reg) => {
          // Check for worker updates
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (newWorker) {
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  console.log('[PWA] New version ready.');
                }
              });
            }
          });
        })
        .catch((err) => {
          console.warn('[PWA] ServiceWorker registration failed:', err);
        });
    });
  }

  // 2. State & Environment Detection
  let deferredPrompt = null;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || 
                       window.navigator.standalone === true || 
                       document.referrer.includes('android-app://');

  function updateSidebarButtonVisibility() {
    const sidebarItem = document.getElementById('sidebarPwaInstallItem');
    if (sidebarItem) {
      if (isStandalone) {
        sidebarItem.style.display = 'none';
      } else {
        sidebarItem.style.display = 'flex';
      }
    }
  }

  // Check on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateSidebarButtonVisibility);
  } else {
    updateSidebarButtonVisibility();
  }

  if (isStandalone) {
    // Already running as installed app; no banner prompt needed
    return;
  }

  // 3. Listen for Android / Chrome / Edge install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.pwaDeferredPrompt = e;
    updateSidebarButtonVisibility();
    showPWAInstallPrompt();
  });

  // Track if successfully installed
  window.addEventListener('appinstalled', () => {
    console.log('[PWA] App successfully installed!');
    deferredPrompt = null;
    hidePWAInstallPrompt();
    const sidebarItem = document.getElementById('sidebarPwaInstallItem');
    if (sidebarItem) sidebarItem.style.display = 'none';
    try {
      localStorage.setItem('bpf_pwa_installed', 'true');
    } catch(e) {}
  });

  // 4. Smart Install UI Creation
  function createInstallUI() {
    if (document.getElementById('bpfPwaBanner')) return;

    // Check if dismissed recently (within 48 hours)
    try {
      const dismissed = localStorage.getItem('bpf_pwa_dismissed');
      if (dismissed && (Date.now() - parseInt(dismissed, 10)) < 48 * 3600 * 1000) {
        return;
      }
    } catch(e) {}

    const banner = document.createElement('div');
    banner.id = 'bpfPwaBanner';
    banner.innerHTML = `
      <div style="position:fixed; bottom:18px; left:50%; transform:translateX(-50%); width:calc(100% - 28px); max-width:440px; background:linear-gradient(135deg, #131722, #1a202c); border:1px solid rgba(255,184,0,0.5); border-radius:16px; padding:12px 14px; box-shadow:0 12px 40px rgba(0,0,0,0.8), 0 0 25px rgba(255,184,0,0.2); z-index:999999; display:flex; align-items:center; justify-content:space-between; gap:10px; font-family:'Inter', sans-serif; backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); animation:bpfSlideUp 0.35s ease;">
        <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
          <img src="/icons/icon-192.png" alt="Binary Prop Firm" style="width:42px; height:42px; border-radius:10px; border:1px solid rgba(255,184,0,0.4); flex-shrink:0; object-fit:cover; box-shadow:0 0 10px rgba(255,184,0,0.25);" />
          <div style="min-width:0;">
            <div style="font-weight:800; font-size:0.88rem; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Binary Prop Firm</div>
            <div style="font-size:0.73rem; color:#94a3b8; line-height:1.2;">ফোনে অ্যাপ আকারে ব্যবহার করুন</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
          <button id="bpfPwaInstallBtn" type="button" style="background:linear-gradient(135deg, #ffb800, #ff9100); color:#000; border:none; padding:8px 14px; border-radius:10px; font-weight:800; font-size:0.78rem; cursor:pointer; display:inline-flex; align-items:center; gap:5px; box-shadow:0 4px 14px rgba(255,184,0,0.35); transition:all 0.2s ease;">
            <i class="fas fa-download"></i> ইন্সটল
          </button>
          <button id="bpfPwaDismissBtn" type="button" aria-label="Close" style="background:none; border:none; color:#64748b; font-size:1.2rem; cursor:pointer; padding:4px 6px; line-height:1; display:flex; align-items:center; justify-content:center;">
            &times;
          </button>
        </div>
      </div>
    `;

    // Add Keyframe animation
    if (!document.getElementById('bpfPwaStyles')) {
      const style = document.createElement('style');
      style.id = 'bpfPwaStyles';
      style.textContent = `
        @keyframes bpfSlideUp {
          from { opacity: 0; transform: translate(-50%, 30px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(banner);

    // Event handlers
    const installBtn = document.getElementById('bpfPwaInstallBtn');
    const dismissBtn = document.getElementById('bpfPwaDismissBtn');

    if (installBtn) {
      installBtn.addEventListener('click', handleInstallClick);
    }
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        hidePWAInstallPrompt();
        try {
          localStorage.setItem('bpf_pwa_dismissed', Date.now().toString());
        } catch(e) {}
      });
    }
  }

  function showPWAInstallPrompt() {
    // Only show banner on mobile / tablet screens or if deferredPrompt / iOS detected
    if (window.innerWidth <= 1024 || deferredPrompt || isIOS) {
      createInstallUI();
    }
  }

  function hidePWAInstallPrompt() {
    const banner = document.getElementById('bpfPwaBanner');
    if (banner) banner.remove();
  }

  // 5. Handle Install Click (Android vs iOS)
  function handleInstallClick() {
    if (deferredPrompt) {
      // Android / Chrome / Edge Native Prompt
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
          console.log('[PWA] User accepted install prompt');
        } else {
          console.log('[PWA] User dismissed install prompt');
        }
        deferredPrompt = null;
        hidePWAInstallPrompt();
      });
    } else if (isIOS) {
      // iOS Safari Add to Home Screen Instructions Modal
      showIOSInstructionsModal();
    } else {
      // Fallback for browsers that don't support beforeinstallprompt
      showGenericInstructionsModal();
    }
  }

  // 6. iOS Instructions Modal
  function showIOSInstructionsModal() {
    let modal = document.getElementById('bpfIosModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'bpfIosModal';
      modal.innerHTML = `
        <div style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.8); z-index:9999999; display:flex; align-items:center; justify-content:center; padding:16px; box-sizing:border-box; backdrop-filter:blur(6px); font-family:'Inter', sans-serif;">
          <div style="background:#131722; border:1px solid rgba(255,184,0,0.5); border-radius:20px; padding:22px 18px; max-width:380px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.9); text-align:center; position:relative; color:#fff;">
            <button type="button" onclick="document.getElementById('bpfIosModal').style.display='none'" style="position:absolute; top:12px; right:14px; background:none; border:none; color:#94a3b8; font-size:1.6rem; cursor:pointer;">&times;</button>
            <div style="width:54px; height:54px; border-radius:14px; background:rgba(255,184,0,0.15); border:1px solid var(--yellow, #ffb800); display:flex; align-items:center; justify-content:center; margin:0 auto 12px auto; font-size:1.6rem; color:#ffb800;">
              <i class="fab fa-apple"></i>
            </div>
            <h3 style="margin:0 0 6px 0; font-size:1.15rem; font-weight:800;">iPhone-এ অ্যাপ ইন্সটল করার নিয়ম</h3>
            <p style="font-size:0.78rem; color:#94a3b8; margin:0 0 16px 0;">সাফারি (Safari) ব্রাউজার থেকে মাত্র ২ ধাপে অ্যাপটি আপনার হোম স্ক্রিনে যুক্ত করুন:</p>
            <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:12px 14px; text-align:left; margin-bottom:16px; font-size:0.82rem; line-height:1.6;">
              <div style="margin-bottom:8px; display:flex; align-items:flex-start; gap:8px;">
                <span style="background:#ffb800; color:#000; font-weight:800; border-radius:50%; width:20px; height:20px; display:flex; align-items:center; justify-content:center; font-size:0.75rem; flex-shrink:0;">১</span>
                <span>সাফারি ব্রাউজারের নিচের <strong>Share</strong> আইকনে <i class="fas fa-arrow-up-from-bracket" style="color:#60a5fa;"></i> চাপ দিন।</span>
              </div>
              <div style="display:flex; align-items:flex-start; gap:8px;">
                <span style="background:#ffb800; color:#000; font-weight:800; border-radius:50%; width:20px; height:20px; display:flex; align-items:center; justify-content:center; font-size:0.75rem; flex-shrink:0;">২</span>
                <span>একটু নিচে স্ক্রল করে <strong>'Add to Home Screen'</strong> <i class="fas fa-plus-square" style="color:#00e676;"></i> অপশনে ক্লিক করুন।</span>
              </div>
            </div>
            <button type="button" onclick="document.getElementById('bpfIosModal').style.display='none'" style="width:100%; background:linear-gradient(135deg, #ffb800, #ff9100); color:#000; border:none; padding:10px; border-radius:10px; font-weight:800; font-size:0.88rem; cursor:pointer;">
              বুঝেছি (Got It)
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    } else {
      modal.style.display = 'block';
    }
  }

  function showGenericInstructionsModal() {
    alert("আপনার ব্রাউজারের মেন্যু (⋮) থেকে 'Add to Home screen' বা 'Install App' নির্বাচন করুন।");
  }

  // 7. Expose Global Helper
  window.triggerBPFInstall = handleInstallClick;

  // Initialize prompt if on iOS mobile
  if (isIOS && !isStandalone) {
    window.addEventListener('load', () => {
      setTimeout(showPWAInstallPrompt, 2000);
    });
  }
})();
