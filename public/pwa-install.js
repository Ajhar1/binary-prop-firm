// Binary Prop Firm - PWA Controller & Smart Installation Engine
(function() {
  'use strict';

  // 1. Clear any stale localStorage locks so banner is never blocked
  try {
    localStorage.removeItem('bpf_pwa_dismissed');
    localStorage.removeItem('bpf_pwa_installed');
  } catch(e) {}

  // 2. Register Service Worker with cache-busting version
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js?v=3', { scope: '/' })
        .then((reg) => {
          reg.update().catch(() => {});
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

  // 3. Environment & Standalone Detection
  let deferredPrompt = null;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isMobile = (window.innerWidth <= 1024) || isIOS || isAndroid || /Mobi|Tablet/i.test(navigator.userAgent);
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateSidebarButtonVisibility);
  } else {
    updateSidebarButtonVisibility();
  }

  // If already running as installed standalone app, do not show install prompt
  if (isStandalone) {
    return;
  }

  // 4. Capture native install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.pwaDeferredPrompt = e;
    updateSidebarButtonVisibility();
    showPWAInstallPrompt();
  });

  window.addEventListener('appinstalled', () => {
    console.log('[PWA] App successfully installed!');
    deferredPrompt = null;
    hidePWAInstallPrompt();
    const sidebarItem = document.getElementById('sidebarPwaInstallItem');
    if (sidebarItem) sidebarItem.style.display = 'none';
  });

  // 5. Smart Install UI Creation
  function createInstallUI() {
    if (document.getElementById('bpfPwaBanner')) return;

    // Check if dismissed in this browser session only
    try {
      if (sessionStorage.getItem('bpf_pwa_session_dismissed') === 'true') {
        return;
      }
    } catch(e) {}

    const banner = document.createElement('div');
    banner.id = 'bpfPwaBanner';
    banner.innerHTML = `
      <div style="position:fixed; bottom:18px; left:50%; transform:translateX(-50%); width:calc(100% - 24px); max-width:440px; background:linear-gradient(135deg, #131722, #1a202c); border:1px solid rgba(255,184,0,0.6); border-radius:16px; padding:12px 14px; box-shadow:0 12px 40px rgba(0,0,0,0.85), 0 0 25px rgba(255,184,0,0.25); z-index:999999; display:flex; align-items:center; justify-content:space-between; gap:10px; font-family:'Inter', sans-serif; backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); animation:bpfSlideUp 0.35s ease;">
        <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
          <img src="/icons/icon-192.png?v=3" alt="Binary Prop Firm" style="width:44px; height:44px; border-radius:11px; flex-shrink:0; object-fit:cover; box-shadow:0 0 12px rgba(255,184,0,0.3); border:1px solid rgba(255,184,0,0.3);" />
          <div style="min-width:0;">
            <div style="font-weight:800; font-size:0.9rem; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Binary Prop Firm</div>
            <div style="font-size:0.73rem; color:#cbd5e1; line-height:1.2;">ফোনে অ্যাপ আকারে ব্যবহার করুন</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
          <button id="bpfPwaInstallBtn" type="button" style="background:linear-gradient(135deg, #ffb800, #ff9100); color:#000; border:none; padding:8px 15px; border-radius:10px; font-weight:800; font-size:0.8rem; cursor:pointer; display:inline-flex; align-items:center; gap:5px; box-shadow:0 4px 14px rgba(255,184,0,0.4); transition:all 0.2s ease;">
            <i class="fas fa-download"></i> ইন্সটল
          </button>
          <button id="bpfPwaDismissBtn" type="button" aria-label="Close" style="background:none; border:none; color:#94a3b8; font-size:1.3rem; cursor:pointer; padding:4px 6px; line-height:1; display:flex; align-items:center; justify-content:center;">
            &times;
          </button>
        </div>
      </div>
    `;

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

    const installBtn = document.getElementById('bpfPwaInstallBtn');
    const dismissBtn = document.getElementById('bpfPwaDismissBtn');

    if (installBtn) {
      installBtn.addEventListener('click', handleInstallClick);
    }
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        hidePWAInstallPrompt();
        try {
          sessionStorage.setItem('bpf_pwa_session_dismissed', 'true');
        } catch(e) {}
      });
    }
  }

  function showPWAInstallPrompt() {
    if (!isStandalone && isMobile) {
      createInstallUI();
    }
  }

  function hidePWAInstallPrompt() {
    const banner = document.getElementById('bpfPwaBanner');
    if (banner) banner.remove();
  }

  // 6. Handle Install Click (Android vs iOS vs Fallback)
  function handleInstallClick() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
          console.log('[PWA] User accepted prompt');
        }
        deferredPrompt = null;
        hidePWAInstallPrompt();
      }).catch(() => {
        hidePWAInstallPrompt();
      });
    } else if (isIOS) {
      showIOSInstructionsModal();
    } else {
      showAndroidInstructionsModal();
    }
  }

  // 7. iOS Instructions Modal
  function showIOSInstructionsModal() {
    let modal = document.getElementById('bpfIosModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'bpfIosModal';
      modal.innerHTML = `
        <div style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.85); z-index:9999999; display:flex; align-items:center; justify-content:center; padding:16px; box-sizing:border-box; backdrop-filter:blur(8px); font-family:'Inter', sans-serif;">
          <div style="background:#131722; border:1px solid rgba(255,184,0,0.5); border-radius:20px; padding:22px 18px; max-width:380px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.9); text-align:center; position:relative; color:#fff;">
            <button type="button" onclick="document.getElementById('bpfIosModal').style.display='none'" style="position:absolute; top:12px; right:14px; background:none; border:none; color:#94a3b8; font-size:1.6rem; cursor:pointer;">&times;</button>
            <div style="width:58px; height:58px; border-radius:15px; background:rgba(255,184,0,0.15); border:1px solid var(--yellow, #ffb800); display:flex; align-items:center; justify-content:center; margin:0 auto 12px auto; font-size:1.7rem; color:#ffb800;">
              <i class="fab fa-apple"></i>
            </div>
            <h3 style="margin:0 0 6px 0; font-size:1.15rem; font-weight:800;">iPhone-এ অ্যাপ ইন্সটল করার নিয়ম</h3>
            <p style="font-size:0.78rem; color:#94a3b8; margin:0 0 16px 0;">সাফারি (Safari) ব্রাউজার থেকে মাত্র ২ ধাপে অ্যাপটি আপনার হোম স্ক্রিনে যুক্ত করুন:</p>
            <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:12px 14px; text-align:left; margin-bottom:16px; font-size:0.82rem; line-height:1.6;">
              <div style="margin-bottom:10px; display:flex; align-items:flex-start; gap:8px;">
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

  // 8. Android Instructions Modal (Fallback if native prompt not triggered)
  function showAndroidInstructionsModal() {
    let modal = document.getElementById('bpfAndroidModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'bpfAndroidModal';
      modal.innerHTML = `
        <div style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.85); z-index:9999999; display:flex; align-items:center; justify-content:center; padding:16px; box-sizing:border-box; backdrop-filter:blur(8px); font-family:'Inter', sans-serif;">
          <div style="background:#131722; border:1px solid rgba(0,230,118,0.5); border-radius:20px; padding:22px 18px; max-width:380px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.9); text-align:center; position:relative; color:#fff;">
            <button type="button" onclick="document.getElementById('bpfAndroidModal').style.display='none'" style="position:absolute; top:12px; right:14px; background:none; border:none; color:#94a3b8; font-size:1.6rem; cursor:pointer;">&times;</button>
            <div style="width:58px; height:58px; border-radius:15px; background:rgba(0,230,118,0.15); border:1px solid #00e676; display:flex; align-items:center; justify-content:center; margin:0 auto 12px auto; font-size:1.7rem; color:#00e676;">
              <i class="fab fa-android"></i>
            </div>
            <h3 style="margin:0 0 6px 0; font-size:1.15rem; font-weight:800;">Android-এ অ্যাপ ইন্সটল করার নিয়ম</h3>
            <p style="font-size:0.78rem; color:#94a3b8; margin:0 0 16px 0;">ব্রাউজার থেকে সরাসরি মাত্র ২ ধাপে অ্যাপটি আপনার ফোনে ইনস্টল করুন:</p>
            <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:12px 14px; text-align:left; margin-bottom:16px; font-size:0.82rem; line-height:1.6;">
              <div style="margin-bottom:10px; display:flex; align-items:flex-start; gap:8px;">
                <span style="background:#00e676; color:#000; font-weight:800; border-radius:50%; width:20px; height:20px; display:flex; align-items:center; justify-content:center; font-size:0.75rem; flex-shrink:0;">১</span>
                <span>ব্রাউজারের উপরে বা নিচের <strong>৩ ডট মেন্যু (⋮)</strong> অপশনে চাপ দিন।</span>
              </div>
              <div style="display:flex; align-items:flex-start; gap:8px;">
                <span style="background:#00e676; color:#000; font-weight:800; border-radius:50%; width:20px; height:20px; display:flex; align-items:center; justify-content:center; font-size:0.75rem; flex-shrink:0;">২</span>
                <span>মেন্যু থেকে <strong>'Install app'</strong> বা <strong>'Add to Home screen'</strong> এ ক্লিক করুন।</span>
              </div>
            </div>
            <button type="button" onclick="document.getElementById('bpfAndroidModal').style.display='none'" style="width:100%; background:linear-gradient(135deg, #00e676, #00c853); color:#000; border:none; padding:10px; border-radius:10px; font-weight:800; font-size:0.88rem; cursor:pointer;">
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

  // 9. Expose Global Helper
  window.triggerBPFInstall = handleInstallClick;

  // 10. Automatically trigger prompt on mobile after 1.2s
  function initAutoPrompt() {
    if (!isStandalone && isMobile) {
      updateSidebarButtonVisibility();
      setTimeout(showPWAInstallPrompt, 1200);
    }
  }

  if (document.readyState === 'complete') {
    initAutoPrompt();
  } else {
    window.addEventListener('load', initAutoPrompt);
    setTimeout(initAutoPrompt, 1800);
  }
})();
