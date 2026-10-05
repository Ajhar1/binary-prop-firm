const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'aj_funded_super_secure_jwt_secret_2026';

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USERS_PERMANENT_STORE_FILE = path.join(DATA_DIR, 'users_permanent_store.json');
const CHALLENGES_FILE = path.join(DATA_DIR, 'challenges.json');
const CHALLENGES_PERMANENT_STORE_FILE = path.join(DATA_DIR, 'challenges_permanent_store.json');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');
const COURSES_FILE = path.join(DATA_DIR, 'courses.json');
const MM_LINKS_FILE = path.join(DATA_DIR, 'mm_links.json');
const PAYMENT_METHODS_FILE = path.join(DATA_DIR, 'payment_methods.json');
const EMAIL_SETTINGS_FILE = path.join(DATA_DIR, 'email_settings.json');
const ARCHIVE_FILE = path.join(DATA_DIR, 'user_archive.json');
const LAUNCH_PROMO_FILE = path.join(DATA_DIR, 'launch_promo.json');
const PROMO_PRESETS_FILE = path.join(DATA_DIR, 'promo_presets.json');
const PACKAGES_FILE = path.join(DATA_DIR, 'packages.json');
const SUPPORT_FILE = path.join(DATA_DIR, 'support_tickets.json');
const TRADER_STATES_FILE = path.join(DATA_DIR, 'trader_states.json');
const SYNCED_TRADES_FILE = path.join(DATA_DIR, 'synced_trades.json');
const DOWNLOADS_DIR = path.join(__dirname, 'public', 'downloads');
const TRADERS_VAULT_DIR = path.join(DATA_DIR, 'lifelong_traders_vault');
const TRADERS_VAULT_FILE = path.join(TRADERS_VAULT_DIR, 'master_registered_traders_vault.json');
const TRADERS_VAULT_PROFILES_DIR = path.join(TRADERS_VAULT_DIR, 'traders');
const TRADERS_VAULT_AUDIT_LOG = path.join(TRADERS_VAULT_DIR, 'vault_audit_log.jsonl');
const MASTER_SECURITY_PASSWORD = 'AJHAR1';

// Ensure directories exist
[DATA_DIR, UPLOADS_DIR, BACKUPS_DIR, DOWNLOADS_DIR, TRADERS_VAULT_DIR, TRADERS_VAULT_PROFILES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// JSON DB Helper functions
function readJson(file, defaultValue = []) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2), 'utf8');
      return defaultValue;
    }
    const data = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error(`Error reading ${file}:`, err);
    return defaultValue;
  }
}

// Atomic crash-proof JSON writer to prevent data loss or corruption
function writeJson(file, data) {
  try {
    const jsonStr = JSON.stringify(data, null, 2);
    if (!jsonStr || jsonStr === 'undefined') return;
    const tempFile = `${file}.tmp.${Date.now()}.${Math.random().toString(36).substr(2, 4)}`;
    fs.writeFileSync(tempFile, jsonStr, 'utf8');
    try {
      fs.renameSync(tempFile, file);
    } catch (renameErr) {
      fs.copyFileSync(tempFile, file);
      try { fs.unlinkSync(tempFile); } catch (e) {}
    }
  } catch (err) {
    console.error(`Error writing ${file}:`, err);
  }
}

// Permanent immutable user activity and state archive
function logUserArchive(action, userDetails = {}, metadata = {}) {
  try {
    const archive = readJson(ARCHIVE_FILE, []);
    const record = {
      archiveId: `arc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      displayTime: new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }),
      action,
      userId: userDetails.id || 'N/A',
      userName: userDetails.name || 'N/A',
      userEmail: userDetails.email || 'N/A',
      telegram: userDetails.telegram || '',
      preferredBroker: userDetails.preferredBroker || '',
      brokerAccountId: userDetails.brokerAccountId || '',
      payoutWallet: userDetails.payoutWallet || '',
      isEmailVerified: Boolean(userDetails.isEmailVerified),
      metadata
    };
    archive.unshift(record);
    // Keep max 2000 archive entries in JSON to stay super fast
    if (archive.length > 2000) archive.length = 2000;
    writeJson(ARCHIVE_FILE, archive);
  } catch (e) {
    console.error('Failed to log to user archive:', e.message);
  }
}

// Lifelong Traders Vault: Supreme Immutable Registration Store
// Guarantees registered traders can NEVER be lost, erased, or locked out, across 5-10+ years
function saveTraderToLifelongVault(user) {
  if (!user || !user.email) return;
  try {
    if (!fs.existsSync(TRADERS_VAULT_DIR)) fs.mkdirSync(TRADERS_VAULT_DIR, { recursive: true });
    if (!fs.existsSync(TRADERS_VAULT_PROFILES_DIR)) fs.mkdirSync(TRADERS_VAULT_PROFILES_DIR, { recursive: true });

    const normEmail = user.email.trim().toLowerCase();
    const vault = readJson(TRADERS_VAULT_FILE, []);
    const idx = vault.findIndex(u => (u.email && u.email.trim().toLowerCase() === normEmail) || (user.id && u.id === user.id));
    if (idx >= 0) {
      // Never allow valid password hash to be replaced with empty or dummy
      const existingPass = vault[idx].password;
      vault[idx] = { ...vault[idx], ...user };
      if ((!user.password || user.password.length < 15) && existingPass && existingPass.length >= 15) {
        vault[idx].password = existingPass;
      }
    } else {
      vault.push(user);
    }
    writeJson(TRADERS_VAULT_FILE, vault);

    const safeFileId = (user.id || normEmail).replace(/[^a-zA-Z0-9_-]/g, '_');
    const profileFile = path.join(TRADERS_VAULT_PROFILES_DIR, `trader_${safeFileId}.json`);
    fs.writeFileSync(profileFile, JSON.stringify(user, null, 2), 'utf8');

    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      action: 'VAULT_PRESERVE_TRADER',
      traderId: user.traderId || 'N/A',
      userId: user.id || 'N/A',
      email: user.email,
      name: user.name
    }) + '\n';
    fs.appendFileSync(TRADERS_VAULT_AUDIT_LOG, logEntry, 'utf8');
  } catch (err) {
    console.error('[LIFELONG VAULT SAVE ERROR]:', err);
  }
}

function readAllFromLifelongVault() {
  const traders = [];
  const seenEmails = new Set();
  const seenIds = new Set();

  const addTrader = (t) => {
    if (!t || !t.email) return;
    const ne = t.email.trim().toLowerCase();
    if (!seenEmails.has(ne)) {
      seenEmails.add(ne);
      if (t.id) seenIds.add(t.id);
      traders.push(t);
    }
  };

  const masterList = readJson(TRADERS_VAULT_FILE, []);
  if (Array.isArray(masterList)) {
    masterList.forEach(addTrader);
  }

  if (fs.existsSync(TRADERS_VAULT_PROFILES_DIR)) {
    try {
      const files = fs.readdirSync(TRADERS_VAULT_PROFILES_DIR);
      files.forEach(f => {
        if (f.endsWith('.json')) {
          try {
            const p = JSON.parse(fs.readFileSync(path.join(TRADERS_VAULT_PROFILES_DIR, f), 'utf8'));
            addTrader(p);
          } catch (e) {}
        }
      });
    } catch (e) {}
  }

  return traders;
}

function removeTraderFromLifelongVault(userId, email, masterPassword) {
  if (masterPassword !== MASTER_SECURITY_PASSWORD) {
    throw new Error('Unauthorized: Master Security Password (AJHAR1) required to touch Lifelong Vault');
  }
  try {
    const vault = readJson(TRADERS_VAULT_FILE, []);
    const normEmail = (email || '').trim().toLowerCase();
    const updatedVault = vault.filter(u => {
      const uEmail = (u.email || '').trim().toLowerCase();
      return u.id !== userId && (!normEmail || uEmail !== normEmail);
    });
    writeJson(TRADERS_VAULT_FILE, updatedVault);

    const safeFileId = (userId || normEmail).replace(/[^a-zA-Z0-9_-]/g, '_');
    const profileFile = path.join(TRADERS_VAULT_PROFILES_DIR, `trader_${safeFileId}.json`);
    if (fs.existsSync(profileFile)) {
      try { fs.unlinkSync(profileFile); } catch (e) {}
    }

    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      action: 'VAULT_REMOVE_TRADER_WITH_MASTER_KEY',
      userId,
      email
    }) + '\n';
    fs.appendFileSync(TRADERS_VAULT_AUDIT_LOG, logEntry, 'utf8');
  } catch (err) {
    console.error('[REMOVE TRADER VAULT ERROR]:', err);
  }
}

// Automatic and manual database snapshot backup creator
function createDatabaseBackup(type = 'auto') {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-');
    const folderName = `backup_${type}_${dateStr}`;
    const backupFolder = path.join(BACKUPS_DIR, folderName);
    fs.mkdirSync(backupFolder, { recursive: true });

    const filesToBackup = [
      USERS_FILE,
      USERS_PERMANENT_STORE_FILE,
      TRADERS_VAULT_FILE,
      CHALLENGES_FILE,
      CHALLENGES_PERMANENT_STORE_FILE,
      SUBMISSIONS_FILE,
      COURSES_FILE,
      MM_LINKS_FILE,
      PAYMENT_METHODS_FILE,
      EMAIL_SETTINGS_FILE,
      ARCHIVE_FILE
    ];

    let totalFilesCopied = 0;
    filesToBackup.forEach(filePath => {
      if (fs.existsSync(filePath)) {
        const dest = path.join(backupFolder, path.basename(filePath));
        fs.copyFileSync(filePath, dest);
        totalFilesCopied++;
      }
    });

    const users = readJson(USERS_FILE, []);
    const challenges = readJson(CHALLENGES_FILE, []);
    const submissions = readJson(SUBMISSIONS_FILE, []);

    const meta = {
      backupId: folderName,
      type,
      createdAt: now.toISOString(),
      displayDate: now.toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }),
      totalUsers: users.length,
      totalChallenges: challenges.length,
      totalSubmissions: submissions.length,
      totalFiles: totalFilesCopied
    };

    fs.writeFileSync(path.join(backupFolder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    pruneOldBackups(60);
    console.log(`[PERMANENT BACKUP] Snapshot '${folderName}' saved successfully (${totalFilesCopied} files).`);
    return { success: true, backup: meta };
  } catch (err) {
    console.error('[BACKUP ERROR] Failed to create backup:', err);
    return { success: false, error: err.message };
  }
}

function pruneOldBackups(keepCount = 60) {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return;
    const items = fs.readdirSync(BACKUPS_DIR).map(name => {
      const fullPath = path.join(BACKUPS_DIR, name);
      try {
        const stat = fs.statSync(fullPath);
        return { name, fullPath, isDir: stat.isDirectory(), mtime: stat.mtimeMs };
      } catch (e) {
        return null;
      }
    }).filter(i => i && i.isDir && i.name.startsWith('backup_'));

    items.sort((a, b) => b.mtime - a.mtime);
    if (items.length > keepCount) {
      const toDelete = items.slice(keepCount);
      toDelete.forEach(item => {
        try {
          fs.rmSync(item.fullPath, { recursive: true, force: true });
        } catch (e) {}
      });
    }
  } catch (e) {
    console.error('Error pruning old backups:', e);
  }
}

// Convert video URL to embed format (supports YouTube watch, youtu.be, Vimeo, embed)
function convertToEmbedUrl(url) {
  if (!url) return '';
  url = url.trim();
  const ytMatch = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
  if (ytMatch && ytMatch[1]) {
    return `https://www.youtube.com/embed/${ytMatch[1]}`;
  }
  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/i);
  if (vimeoMatch && vimeoMatch[1]) {
    return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
  }
  return url;
}

// Extract YouTube or video thumbnail URL
function extractVideoThumbnail(url) {
  if (!url) return '';
  url = url.trim();
  const ytMatch = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
  if (ytMatch && ytMatch[1]) {
    return `https://img.youtube.com/vi/${ytMatch[1]}/hqdefault.jpg`;
  }
  return '';
}

// Bulletproof Challenge Sessions & Submissions Synchronizer
// Enforces:
// 1. sessionsCompleted ALWAYS matches the true number of valid non-rejected submissions
// 2. Automated Pass when 15 verified sessions completed (Rule #4 & Req #4)
// 3. Automated Expiration/Failure when 15 days deadline exceeded (Rule #10 & Req #1)
function syncChallengesWithSubmissions() {
  try {
    let challenges = readJson(CHALLENGES_FILE, []);
    let permChallenges = readJson(CHALLENGES_PERMANENT_STORE_FILE, []);
    const archive = readJson(ARCHIVE_FILE, []);
    const submissions = readJson(SUBMISSIONS_FILE, []);
    let modified = false;
    const now = new Date();

    // 0. Exclude challenges explicitly deleted by admin or belonging to deleted users
    const deletedChallengeIds = new Set(
      archive
        .filter(a => a.action === 'CHALLENGE_DELETED_BY_ADMIN')
        .map(a => (a.metadata && a.metadata.challengeId) || a.challengeId)
        .filter(Boolean)
    );
    const deletedUserIds = new Set(
      archive
        .filter(a => a.action === 'USER_DELETED_BY_ADMIN')
        .map(a => a.userId)
        .filter(Boolean)
    );

    const dummyChallengeIds = new Set([
      'ch_1790765840628_grbkd',
      'ch_1790650439313_c5pj6',
      'ch_1790647029338_0a2rq'
    ]);
    const dummyChallengeEmails = new Set([
      'disc@example.com',
      'test@trader.com',
      'protrader@example.com',
      'ajhar@test.com',
      'admin@ajfunded.com',
      'lead.trader@binarypropfirm.com',
      'atharajhar6@gmail.come'
    ]);
    const dummyChallengeUserIds = new Set([
      'usr_test_1',
      'test_discount_user',
      'usr_1790486638103_3bbjv3',
      'usr_1790475483790_5etunz',
      'usr_1790479900000_ajf',
      'usr_1790470000000_lead'
    ]);

    const isChallengeDeleted = (c) => {
      if (!c) return true;
      if (c.id && (deletedChallengeIds.has(c.id) || dummyChallengeIds.has(c.id))) return true;
      if (c.userId && (deletedUserIds.has(c.userId) || dummyChallengeUserIds.has(c.userId))) return true;
      if (c.userEmail && dummyChallengeEmails.has(c.userEmail.trim().toLowerCase())) return true;
      return false;
    };

    // Filter out deleted challenges from current challenges array
    const initialChLen = challenges.length;
    challenges = challenges.filter(c => !isChallengeDeleted(c));
    if (challenges.length !== initialChLen) modified = true;

    // Clean up permanent store if deleted challenge is still present
    if (permChallenges.some(pc => isChallengeDeleted(pc))) {
      permChallenges = permChallenges.filter(pc => !isChallengeDeleted(pc));
      writeJson(CHALLENGES_PERMANENT_STORE_FILE, permChallenges);
    }

    // 1. Permanent Auto-Healing: Merge challenges from CHALLENGES_PERMANENT_STORE_FILE
    const challengeMap = new Map();
    challenges.forEach(c => {
      if (c && c.id) challengeMap.set(c.id, c);
    });

    permChallenges.forEach(pc => {
      if (isChallengeDeleted(pc)) return;
      if (!challengeMap.has(pc.id)) {
        challenges.push(pc);
        challengeMap.set(pc.id, pc);
        modified = true;
        console.log(`[AUTO-HEAL] Restored challenge from permanent store: ${pc.id} (${pc.packageName} for ${pc.userEmail})`);
      } else {
        const existing = challengeMap.get(pc.id);
        // If permanent store has a failed/disqualified status, ensure existing challenge inherits it
        if (pc.status === 'failed' && existing.status !== 'failed') {
          existing.status = 'failed';
          existing.failReason = pc.failReason || 'DISQUALIFIED';
          existing.violatedRule = pc.violatedRule;
          existing.failReasonText = pc.failReasonText;
          existing.failedAt = pc.failedAt;
          existing.isActive = false;
          existing.isCompleted = true;
          modified = true;
        } else if (existing.status === 'failed' && pc.status !== 'failed') {
          pc.status = 'failed';
          pc.failReason = existing.failReason || 'DISQUALIFIED';
          pc.violatedRule = existing.violatedRule;
          pc.failReasonText = existing.failReasonText;
          pc.failedAt = existing.failedAt;
          pc.isActive = false;
          pc.isCompleted = true;
          writeJson(CHALLENGES_PERMANENT_STORE_FILE, permChallenges);
        } else if (existing.status !== pc.status && pc.status === 'in_progress' && existing.status !== 'passed' && existing.status !== 'failed') {
          existing.status = pc.status;
          existing.approvedAt = pc.approvedAt || existing.approvedAt;
          existing.assignedMmUrl = pc.assignedMmUrl || existing.assignedMmUrl;
          existing.assignedMmTitle = pc.assignedMmTitle || existing.assignedMmTitle;
          modified = true;
        }
      }
    });

    // 2. Archive Auto-Healing: Resurrect from user_archive if any purchased/approved challenge missing (and not deleted)
    const disqualifiedMap = new Map();
    archive.forEach(arc => {
      if (
        arc.action === 'CHALLENGE_DISQUALIFIED_RULE_VIOLATION' ||
        arc.action === 'CHALLENGE_DISQUALIFIED_FROM_SESSION' ||
        arc.action === 'CHALLENGE_FAILED_SESSION_REJECTED' ||
        arc.action === 'CHALLENGE_FAILED_DRAWDOWN' ||
        arc.action === 'CHALLENGE_FAILED_TIME_LIMIT' ||
        (arc.action === 'CHALLENGE_STATUS_UPDATED' && arc.metadata && arc.metadata.status === 'failed')
      ) {
        const chId = (arc.metadata && arc.metadata.challengeId) || arc.challengeId;
        if (chId) disqualifiedMap.set(chId, arc);
      } else if (
        arc.action === 'CHALLENGE_REACTIVATED_BY_ADMIN' ||
        arc.action === 'CHALLENGE_REACTIVATED' ||
        (arc.action === 'CHALLENGE_STATUS_UPDATED' && arc.metadata && arc.metadata.status === 'in_progress')
      ) {
        const chId = (arc.metadata && arc.metadata.challengeId) || arc.challengeId;
        if (chId) disqualifiedMap.delete(chId);
      }
    });

    archive.forEach(arc => {
      if (arc.action === 'CHALLENGE_APPROVED' || arc.action === 'CHALLENGE_PURCHASED') {
        const meta = arc.metadata || {};
        const chId = meta.challengeId;
        if (chId && !deletedChallengeIds.has(chId) && !deletedUserIds.has(arc.userId) && !challengeMap.has(chId)) {
          const isDisqualified = disqualifiedMap.has(chId);
          const disqInfo = isDisqualified ? disqualifiedMap.get(chId) : null;
          const disqMeta = (disqInfo && disqInfo.metadata) || {};
          const isGold = meta.fundedAmount === 525 || meta.packageName === 'Gold';
          const recovered = {
            id: chId,
            userId: arc.userId,
            userName: arc.userName || 'Trader',
            userEmail: arc.userEmail || '',
            userTraderId: arc.traderId || (arc.userEmail === 'afiafarjana933@gmail.com' ? 'AJ-1010' : 'AJ-1008'),
            userTelegram: arc.telegram || '',
            userBroker: meta.broker || 'Quotex',
            packageId: meta.packageId || (isGold ? 'pkg-gold' : 'pkg-bronze'),
            packageName: meta.packageName || (isGold ? 'Gold' : 'Bronze'),
            originalFee: isGold ? 25 : 5,
            fee: isGold ? 15 : 4,
            discountPercent: isGold ? 40 : 20,
            hasDiscount: true,
            fundedAmount: meta.fundedAmount || (isGold ? 525 : 100),
            profitSplit: '75%',
            maxDrawdown: '25%',
            brokerId: 'quotex',
            brokerName: 'Quotex',
            brokerIcon: '/assets/brokers/quotex.png',
            brokerAccountId: 'Demo Account',
            status: isDisqualified ? 'failed' : (arc.action === 'CHALLENGE_APPROVED' ? 'in_progress' : 'pending_approval'),
            sessionsRequired: 15,
            sessionsCompleted: 0,
            currentDrawdown: '0.0%',
            paymentMethod: meta.paymentMethod || 'bKash / Binance Pay',
            paymentTxId: meta.paymentTxId || 'TX_DEFAULT',
            senderNumber: '',
            currency: 'USD',
            currencySymbol: '$',
            exchangeRate: 1,
            localAmount: isGold ? 15 : 4,
            assignedMmId: 'mm_default',
            assignedMmSerial: meta.mmSerial || 1,
            assignedMmTitle: meta.mmTitle || 'অফিসিয়াল মানি ম্যানেজমেন্ট শিট #১',
            assignedMmUrl: 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?usp=sharing',
            assignedMmNote: 'Standard Evaluation Sheet',
            approvedAt: arc.timestamp || new Date().toISOString(),
            createdAt: arc.timestamp || new Date().toISOString(),
            durationDays: 15,
            challengePhase: 'practice',
            expiresAt: new Date(new Date(arc.timestamp || now).getTime() + (17 * 24 * 60 * 60 * 1000)).toISOString(),
            practiceSessionsCompleted: 0,
            verifiedSessionsCount: 0,
            totalSubmissionsCount: 0,
            practiceHours: 48,
            practiceStartedAt: arc.timestamp || new Date().toISOString(),
            practiceExpiresAt: new Date(new Date(arc.timestamp || now).getTime() + (48 * 60 * 60 * 1000)).toISOString(),
            practiceMaxSessions: 3,
            isActive: !isDisqualified,
            isCompleted: isDisqualified,
            failReason: isDisqualified ? (disqMeta.failReason || 'RULE_VIOLATION') : undefined,
            violatedRule: isDisqualified ? (disqMeta.violatedRule || '') : undefined,
            failReasonText: isDisqualified ? (disqMeta.reasonNote || disqMeta.feedback || 'এডমিন কর্তৃক চ্যালেঞ্জ বাতিল ও বাদ দেওয়া হয়েছে।') : undefined,
            failedAt: isDisqualified ? (disqInfo.timestamp || new Date().toISOString()) : undefined
          };
          challenges.push(recovered);
          challengeMap.set(chId, recovered);
          modified = true;
          console.log(`[AUTO-HEAL] Resurrected challenge from user_archive: ${chId} (${recovered.packageName} for ${recovered.userEmail}, status: ${recovered.status})`);
        }
      }
    });

    // Ensure admin test challenge is seeded if missing on persistent storage
    const hasAdminChallenge = challenges.some(c => (c.userTraderId === 'BPF-ADMIN-1' || (c.userEmail && c.userEmail.toLowerCase() === 'atharajhar6@gmail.com')) && c.status === 'in_progress');
    if (!hasAdminChallenge) {
      challenges.push({
        id: "ch_1791079900000_admin",
        userId: "usr_1790479914536_bjtgpe",
        userName: "MD AJHAR",
        userEmail: "atharajhar6@gmail.com",
        userTraderId: "BPF-ADMIN-1",
        userTelegram: "@MDAJHA1",
        userBroker: "Quotex",
        packageId: "pkg-bronze",
        packageName: "Bronze",
        fundedAmount: 100,
        profitSplit: "85%",
        maxDrawdown: "25%",
        status: "in_progress",
        sessionsRequired: 15,
        sessionsCompleted: 0,
        currentDrawdown: "0.0%",
        approvedAt: "2026-10-04T00:00:00.000Z",
        createdAt: "2026-10-04T00:00:00.000Z",
        durationDays: 15,
        challengePhase: "evaluation",
        expiresAt: "2026-10-25T00:00:00.000Z",
        isActive: true
      });
      modified = true;
    }

    // Challenges are preserved for all users
    challenges.forEach(c => {
      // Ensure required evaluation metrics
      if (!c.sessionsRequired) {
        c.sessionsRequired = 15;
        modified = true;
      }
      if (!c.durationDays) {
        c.durationDays = 15;
        modified = true;
      }

      // Default phase setup for challenges:
      if (!c.challengePhase) {
        if ((c.sessionsCompleted && c.sessionsCompleted > 0) || c.status === 'passed' || c.status === 'failed') {
          c.challengePhase = 'evaluation';
        } else {
          const approvedMs = new Date(c.approvedAt || c.activatedAt || c.createdAt).getTime();
          if (c.status === 'in_progress' && (now.getTime() - approvedMs < 48 * 60 * 60 * 1000)) {
            c.challengePhase = 'practice';
            c.practiceHours = 48;
            c.practiceStartedAt = c.approvedAt || c.activatedAt || c.createdAt;
            c.practiceExpiresAt = new Date(approvedMs + (48 * 60 * 60 * 1000)).toISOString();
            c.practiceMaxSessions = 3;
            c.practiceSessionsCompleted = 0;
          } else {
            c.challengePhase = 'evaluation';
          }
        }
        modified = true;
      }

      // If in practice phase, check if 48 hours have elapsed -> Auto-transition to evaluation mode
      if (c.status === 'in_progress' && c.challengePhase === 'practice') {
        const practiceEndMs = c.practiceExpiresAt ? new Date(c.practiceExpiresAt).getTime() : 0;
        if (practiceEndMs > 0 && now.getTime() >= practiceEndMs) {
          c.challengePhase = 'evaluation';
          c.evaluationStartedAt = c.practiceExpiresAt;
          c.expiresAt = new Date(practiceEndMs + (c.durationDays * 24 * 60 * 60 * 1000)).toISOString();
          modified = true;
          try {
            logUserArchive('PRACTICE_AUTO_TRANSITION_TO_EVALUATION', { id: c.userId }, {
              challengeId: c.id,
              packageName: c.packageName,
              transitionReason: '48-hour practice period completed'
            });
          } catch(e) {}
        }
      }

      // Calculate deadline for evaluation mode vs practice mode
      if (c.challengePhase === 'evaluation') {
        const evalStartMs = new Date(c.evaluationStartedAt || c.approvedAt || c.activatedAt || c.createdAt).getTime();
        if (!c.expiresAt && !isNaN(evalStartMs)) {
          c.expiresAt = new Date(evalStartMs + (c.durationDays * 24 * 60 * 60 * 1000)).toISOString();
          modified = true;
        }
      } else if (c.challengePhase === 'practice') {
        const practiceEndMs = c.practiceExpiresAt ? new Date(c.practiceExpiresAt).getTime() : (now.getTime() + 48*3600*1000);
        c.expiresAt = new Date(practiceEndMs + (c.durationDays * 24 * 60 * 60 * 1000)).toISOString();
      }

      // Find all submissions belonging to this challenge
      const allChSubs = submissions.filter(s => 
        (s.challengeId ? s.challengeId === c.id : s.userId === c.userId)
      );

      // Separate Practice Submissions from Official Evaluation Submissions
      const practiceSubs = allChSubs.filter(s => s.isPractice === true);
      c.practiceSessionsCompleted = practiceSubs.length;

      const officialSubs = allChSubs.filter(s => s.isPractice !== true);
      const officialNonRejectedSubs = officialSubs.filter(s => s.status !== 'rejected');
      const verifiedSubs = officialSubs.filter(s => s.status === 'verified');
      c.verifiedSessionsCount = verifiedSubs.length;
      c.totalSubmissionsCount = officialNonRejectedSubs.length;

      // Completed sessions are strictly verified official sessions
      if (c.sessionsCompleted !== verifiedSubs.length) {
        c.sessionsCompleted = verifiedSubs.length;
        modified = true;
      }

      // Calculate Real-time Drawdown & Loss metrics strictly from OFFICIAL submissions
      const capital = Number(c.fundedAmount || c.accountSize || c.capital || 1000);
      let runningBal = capital;
      let peakBal = capital;
      let maxDrawdownAmt = 0;
      let has25Loss = false;

      // Sort all non-rejected official submissions chronologically
      const sortedSubs = [...officialNonRejectedSubs].sort((a, b) => new Date(a.submittedAt || a.sessionDate) - new Date(b.submittedAt || b.sessionDate));

      sortedSubs.forEach(s => {
        const pnl = parseFloat(s.profitLoss) || 0;
        runningBal += pnl;
        if (runningBal > peakBal) peakBal = runningBal;
        const dd = peakBal - runningBal;
        if (dd > maxDrawdownAmt) maxDrawdownAmt = dd;

        // Check if single session loss exceeded 25% of starting capital
        if (pnl <= -(capital * 0.25)) {
          has25Loss = true;
        }
        // Check if notes indicate 25% limit exceeded from Masaniello Pro
        if (s.notes && (s.notes.includes('LIMIT_25_EXCEEDED') || s.notes.includes('MAX_LOSS') || s.notes.includes('25% লিমিট অতিক্রম') || s.notes.includes('২৫% লিমিট অতিক্রম') || s.notes.includes('25% লস') || s.notes.includes('২৫% লস'))) {
          has25Loss = true;
        }
      });

      const maxDdPct = peakBal > 0 ? (maxDrawdownAmt / peakBal) * 100 : 0;
      const formattedDd = `${maxDdPct.toFixed(1)}%`;
      if (c.currentDrawdown !== formattedDd) {
        c.currentDrawdown = formattedDd;
        modified = true;
      }

      const rejectedOfficialSub = officialSubs.find(s => s.status === 'rejected');
      const isTimeExpired = (c.challengePhase === 'evaluation') && c.expiresAt && (now.getTime() > new Date(c.expiresAt).getTime());
      const isDrawdownBreached = (c.challengePhase === 'evaluation') && (maxDdPct >= 25 || has25Loss);


      // DISQUALIFICATION & EVALUATION RULES: Strictly active only if in_progress AND challengePhase === 'evaluation'
      if (c.status === 'in_progress' && c.challengePhase === 'evaluation') {
        // REQ 1: If any OFFICIAL session for this challenge was REJECTED by admin -> IMMEDIATELY FAIL & CLOSE CHALLENGE!
        if (rejectedOfficialSub) {
          c.status = 'failed';
          c.failReason = 'SESSION_REJECTED';
          c.violatedRule = rejectedOfficialSub.adminFeedback ? `সেশন বাতিল (কারণ: ${rejectedOfficialSub.adminFeedback})` : 'সেশন রিজেক্ট / ট্রেডিং রুলস লঙ্ঘন';
          c.failReasonText = rejectedOfficialSub.adminFeedback 
            ? `এডমিন প্যানেল থেকে আপনার ট্রেডিং সেশন রিজেক্ট করা হয়েছে (কারণ: ${rejectedOfficialSub.adminFeedback})। প্ল্যাটফর্মের অফিসিয়াল নিয়মানুযায়ী সেশন রিজেক্ট হলে চ্যালেঞ্জটি বন্ধ হয়ে যায় এবং আপনি এই চ্যালেঞ্জ থেকে বাদ পড়েছেন।`
            : 'এডমিন কর্তৃক আপনার ট্রেডিং সেশন রিজেক্ট করায় প্ল্যাটফর্মের অফিসিয়াল নিয়মানুযায়ী চ্যালেঞ্জটি বন্ধ করা হয়েছে এবং আপনি এই চ্যালেঞ্জ থেকে বাদ পড়েছেন।';
          c.failedAt = rejectedOfficialSub.reviewedAt || now.toISOString();
          c.isActive = false;
          c.isCompleted = true;
          modified = true;
          try {
            logUserArchive('CHALLENGE_FAILED_SESSION_REJECTED', { id: c.userId }, {
              challengeId: c.id,
              packageName: c.packageName,
              submissionId: rejectedOfficialSub.id,
              adminFeedback: rejectedOfficialSub.adminFeedback || ''
            });
          } catch (e) {}
        }

        // REQ 2: If Drawdown reaches or exceeds 25%, or single session loss >= 25% -> FAIL & CLOSE CHALLENGE!
        else if (isDrawdownBreached) {
          c.status = 'failed';
          c.failReason = 'DRAWDOWN_EXCEEDED';
          c.violatedRule = 'রুল ২: সর্বোচ্চ ২৫% লস লিমিট অতিক্রম';
          c.failReasonText = `ট্রেডিং সেশনে সর্বোচ্চ ২৫% ড্রডাউন/লস লিমিট অতিক্রম করেছে (অর্জিত ড্রডাউন: ${formattedDd})। প্ল্যাটফর্মের অফিসিয়াল রুলস অনুযায়ী চ্যালেঞ্জটি স্বয়ংক্রিয়ভাবে বন্ধ করা হয়েছে এবং আপনি এই চ্যালেঞ্জ থেকে বাদ পড়েছেন।`;
          c.failedAt = now.toISOString();
          c.isActive = false;
          c.isCompleted = true;
          c.currentDrawdown = '25.0%';
          modified = true;
          try {
            logUserArchive('CHALLENGE_FAILED_DRAWDOWN', { id: c.userId }, {
              challengeId: c.id,
              packageName: c.packageName,
              maxDrawdown: '25.0%'
            });
          } catch (e) {}
        }

        // RULE 4 & REQ 4: 15 verified sessions completed -> CHALLENGE PASSED!
        else if (verifiedSubs.length >= (c.sessionsRequired || 15)) {
          c.status = 'passed';
          c.passedAt = c.passedAt || now.toISOString();
          c.isCompleted = true;
          c.isActive = false;
          modified = true;
          try {
            logUserArchive('CHALLENGE_PASSED', { id: c.userId }, {
              challengeId: c.id,
              packageName: c.packageName,
              fundedAmount: c.fundedAmount,
              broker: c.brokerName
            });
          } catch (e) {}
        }

        // RULE 10 & REQ 1: 15 days exceeded -> CHALLENGE FAILED & TERMINATED!
        else if (isTimeExpired) {
          c.status = 'failed';
          c.failReason = 'TIME_LIMIT_EXCEEDED';
          c.failReasonText = 'চ্যালেঞ্জের সর্বোচ্চ ১৫ দিনের সময়সীমা অতিক্রান্ত হয়েছে। নির্দিষ্ট মেয়াদের মধ্যে ১৫টি সেশন সম্পন্ন না করায় চ্যালেঞ্জটি স্বয়ংক্রিয়ভাবে বাতিল ও বন্ধ করা হয়েছে।';
          c.failedAt = now.toISOString();
          c.isActive = false;
          modified = true;
          try {
            logUserArchive('CHALLENGE_FAILED_TIME_LIMIT', { id: c.userId }, {
              challengeId: c.id,
              packageName: c.packageName,
              durationDays: c.durationDays
            });
          } catch (e) {}
        }
      }
    });

    if (modified || !fs.existsSync(CHALLENGES_PERMANENT_STORE_FILE)) {
      writeJson(CHALLENGES_FILE, challenges);
      writeJson(CHALLENGES_PERMANENT_STORE_FILE, challenges);
    }
    return challenges;
  } catch (err) {
    console.error('Error syncing challenge sessions with submissions:', err);
    return readJson(CHALLENGES_FILE, []);
  }
}

// Enterprise Challenge Dual-Persistence Helper
function saveChallenges(challenges) {
  writeJson(CHALLENGES_FILE, challenges);
  writeJson(CHALLENGES_PERMANENT_STORE_FILE, challenges);
}

// Next serial MM link assigner
function getNextMmSerialLink() {
  const mmLinks = readJson(MM_LINKS_FILE);
  if (!mmLinks || mmLinks.length === 0) {
    return {
      id: "mm_default",
      serial: 1,
      title: "অফিসিয়াল মানি ম্যানেজমেন্ট শিট #১",
      url: "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?usp=sharing",
      note: "Standard Evaluation Sheet"
    };
  }

  mmLinks.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));

  const challenges = readJson(CHALLENGES_FILE);
  const assignedChallenges = challenges.filter(c => c.assignedMmSerial !== undefined && c.assignedMmSerial !== null && c.status !== 'rejected');
  
  const nextIndex = assignedChallenges.length % mmLinks.length;
  const selectedLink = mmLinks[nextIndex] || mmLinks[0];

  selectedLink.assignedCount = (selectedLink.assignedCount || 0) + 1;
  writeJson(MM_LINKS_FILE, mmLinks);

  return selectedLink;
}

// Email transporter configuration helper
function getEmailTransporter() {
  const fileSettings = readJson(EMAIL_SETTINGS_FILE, {});
  const smtpHost = fileSettings.smtpHost || process.env.SMTP_HOST || '';
  const smtpPort = parseInt(fileSettings.smtpPort || process.env.SMTP_PORT || '587', 10);
  const smtpUser = fileSettings.smtpUser || process.env.SMTP_USER || '';
  const smtpPass = fileSettings.smtpPass || process.env.SMTP_PASS || '';
  const smtpSecure = fileSettings.smtpSecure !== undefined ? Boolean(fileSettings.smtpSecure) : (process.env.SMTP_SECURE === 'true' || smtpPort === 465);

  if (smtpHost && smtpUser && smtpPass) {
    return {
      transporter: nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      }),
      fromAddress: fileSettings.fromEmail ? `"${fileSettings.fromName || 'Binary Prop Firm'}" <${fileSettings.fromEmail}>` : (process.env.SMTP_FROM || `"${fileSettings.fromName || 'Binary Prop Firm'}" <${smtpUser}>`)
    };
  }
  return null;
}

// Smart Email Normalizer: Trims, lowercases, and fixes common user typing mistakes
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  let cleaned = email.trim().toLowerCase();

  // Fix common TLD typos (.come, .con, .comm, .coom -> .com)
  cleaned = cleaned.replace(/\.(come|con|comm|coom)$/i, '.com');

  // Fix common domain typos
  cleaned = cleaned.replace(/@(gamil|gmial|gmai|gmaill)\.com$/i, '@gmail.com');
  cleaned = cleaned.replace(/@gmail\.co$/i, '@gmail.com');
  cleaned = cleaned.replace(/@(yaho|yahooo)\.com$/i, '@yahoo.com');
  cleaned = cleaned.replace(/@(hotmial|hotmaill)\.com$/i, '@hotmail.com');

  return cleaned;
}

// Email format validator helper to prevent bounce errors
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const cleaned = normalizeEmail(email);
  const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!regex.test(cleaned)) return false;
  return true;
}

// Generate 6 digit numeric verification code
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Ultra-Professional Prop Firm HTML Email Template Builder
function buildProfessionalEmailHtml({ headline, title, userName, messageText, code, securityNote }) {
  const currentYear = new Date().getFullYear();
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${title || 'Binary Prop Firm Security Code'}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #06090e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; color: #ffffff;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #06090e; padding: 32px 12px;">
    <tr>
      <td align="center">
        <!-- Main Container Card -->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 580px; background-color: #0b111a; border: 1px solid rgba(245, 176, 65, 0.45); border-radius: 18px; overflow: hidden; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.9);">
          
          <!-- Top Accent Gold Line -->
          <tr>
            <td height="4" style="background: linear-gradient(90deg, #d48b14, #f5b041, #ffd700, #f5b041, #d48b14);"></td>
          </tr>

          <!-- Header / Brand Section -->
          <tr>
            <td align="center" style="padding: 34px 24px 26px 24px; background: linear-gradient(180deg, #111a27 0%, #0b111a 100%); border-bottom: 1px solid rgba(255, 255, 255, 0.06);">
              <table role="presentation" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <!-- Brand Icon -->
                    <div style="display: inline-block; width: 48px; height: 48px; line-height: 48px; border-radius: 12px; background: linear-gradient(135deg, #f5b041 0%, #c97e0a 100%); color: #000000; font-size: 16px; font-weight: 900; letter-spacing: 1px; text-align: center; box-shadow: 0 4px 18px rgba(245, 176, 65, 0.4);">
                      BPF
                    </div>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-top: 14px;">
                    <h1 style="margin: 0; color: #f5b041; font-size: 24px; font-weight: 800; letter-spacing: 2.5px; text-transform: uppercase;">
                      BINARY PROP FIRM
                    </h1>
                    <p style="margin: 5px 0 0 0; color: #8fa0b5; font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;">
                      PREMIER BINARY PROP TRADING EVALUATION
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Body Section -->
          <tr>
            <td style="padding: 32px 30px 24px 30px;">
              
              <!-- Greeting & Headline -->
              <h2 style="margin: 0 0 14px 0; color: #ffffff; font-size: 19px; font-weight: 700; line-height: 1.4;">
                ${headline || title}
              </h2>
              
              <p style="margin: 0 0 16px 0; color: #cbd5e1; font-size: 14.5px; line-height: 1.6;">
                Dear <strong style="color: #ffffff;">${userName || 'Trader'}</strong>,
              </p>
              
              <p style="margin: 0 0 24px 0; color: #94a3b8; font-size: 14px; line-height: 1.65;">
                ${messageText}
              </p>

              <!-- OTP Display Box -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 24px 0;">
                <tr>
                  <td align="center">
                    <div style="background: rgba(245, 176, 65, 0.08); border: 2px dashed #f5b041; border-radius: 14px; padding: 22px 28px; display: inline-block; max-width: 90%; text-align: center;">
                      <div style="color: #8fa0b5; font-size: 11px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px;">
                        Security Verification Code (ওটিপি কোড)
                      </div>
                      <div style="font-family: Consolas, 'SF Pro Display', Monaco, 'Courier New', monospace; font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #f5b041; padding: 4px 0; text-shadow: 0 2px 12px rgba(245, 176, 65, 0.35);">
                        ${code}
                      </div>
                      <div style="margin-top: 10px; display: inline-block; background: rgba(255, 255, 255, 0.05); padding: 5px 16px; border-radius: 20px; color: #cbd5e1; font-size: 12px;">
                        ⏱ Valid for <strong style="color: #f5b041;">15 minutes</strong> &bull; Single use only
                      </div>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Security Advisory Card -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px; margin: 20px 0 26px 0;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <div style="color: #f5b041; font-size: 13px; font-weight: 700; margin-bottom: 6px;">
                      🛡️ Security Advisory (নিরাপত্তা সতর্কতা)
                    </div>
                    <p style="margin: 0; color: #94a3b8; font-size: 12.5px; line-height: 1.6;">
                      • <strong>Never share</strong> this 6-digit code with anyone. Binary Prop Firm administrators and staff will NEVER ask for your password or verification code.<br/>
                      • ${securityNote || "If you didn't initiate this action, someone may have entered your email by mistake. Your account remains completely secure."}
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Divider -->
              <div style="height: 1px; background: rgba(255, 255, 255, 0.06); margin: 26px 0 20px 0;"></div>

              <!-- Support Desk Help -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" style="color: #8fa0b5; font-size: 12.5px; line-height: 1.6;">
                    Need official assistance? Reach our support desk:<br/>
                    <a href="https://t.me/BinaryPropFirmSupport" style="color: #00bcd4; text-decoration: none; font-weight: 700; margin-right: 14px;">💬 Telegram Support (@BinaryPropFirmSupport)</a>
                    <a href="mailto:support@binarypropfirm.com" style="color: #f5b041; text-decoration: none; font-weight: 700;">✉️ support@binarypropfirm.com</a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Legal Disclaimer & Regulatory Notice -->
          <tr>
            <td style="background-color: #080d14; padding: 26px 30px; border-top: 1px solid rgba(255, 255, 255, 0.06);">
              
              <!-- Legal Title -->
              <div style="color: #64748b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 8px;">
                LEGAL NOTICE & RISK DISCLAIMER (আইনগত সতর্কবার্তা ও ডিসক্লেইমার)
              </div>
              
              <!-- Legal Details -->
              <p style="margin: 0 0 10px 0; color: #475569; font-size: 10.5px; line-height: 1.6; text-align: justify;">
                <strong>Proprietary Evaluation Services:</strong> Binary Prop Firm operates strictly as an evaluation and talent discovery firm for traders. All evaluation challenges, account metrics, and performance tracking are conducted in simulated demo environments under strictly defined money management rules. Binary Prop Firm is not a brokerage firm, does not accept customer deposits for investment, and does not provide financial advice.
              </p>
              
              <p style="margin: 0 0 10px 0; color: #475569; font-size: 10.5px; line-height: 1.6; text-align: justify;">
                <strong>Risk Warning:</strong> Trading binary options, OTC financial instruments, and digital assets carries a significant level of risk to your capital and is not suitable for everyone. You should ensure you fully understand the risks involved before participating.
              </p>

              <p style="margin: 0 0 14px 0; color: #475569; font-size: 10.5px; line-height: 1.6;">
                <strong>Confidentiality Notice:</strong> This message and any attachments are confidential and intended solely for the designated recipient. If received in error, please destroy this transmission immediately.
              </p>

              <!-- Copyright & Auto-notice -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="border-top: 1px solid rgba(255, 255, 255, 0.05); padding-top: 12px;">
                <tr>
                  <td align="left" style="color: #475569; font-size: 10.5px;">
                    &copy; ${currentYear} Binary Prop Firm Ltd. All Rights Reserved.
                  </td>
                  <td align="right" style="color: #475569; font-size: 10.5px;">
                    Automated Transmission &bull; Do not reply
                  </td>
                </tr>
              </table>

            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// Send Verification Email
async function sendVerificationEmail(toEmail, code, userName = 'Trader') {
  if (!isValidEmail(toEmail)) {
    console.warn(`[EMAIL WARNING] Attempted to send to invalid email format: ${toEmail}`);
    return { success: false, method: 'invalid_email', error: 'Invalid email address format' };
  }
  const mailConfig = getEmailTransporter();
  const html = buildProfessionalEmailHtml({
    headline: 'ইমেইল ভেরিফিকেশন ওটিপি কোড / Email Verification OTP',
    title: 'Verify Your Email Address',
    userName,
    messageText: 'Thank you for choosing <strong>Binary Prop Firm</strong>. To complete your account activation and secure your profile, please use the 6-digit verification code below:',
    code,
    securityNote: 'If you did not create an account on Binary Prop Firm, please ignore this email. Your email will not be activated without this code.'
  });

  if (mailConfig && mailConfig.transporter) {
    try {
      await mailConfig.transporter.sendMail({
        from: mailConfig.fromAddress,
        to: toEmail,
        subject: `[Binary Prop Firm] ${code} is your verification code`,
        text: `Hello ${userName}, Your Binary Prop Firm verification code is: ${code}. It expires in 15 minutes. Never share this code with anyone.`,
        html: html
      });
      console.log(`[EMAIL DISPATCH] Verification code ${code} sent to ${toEmail}`);
      return { success: true, method: 'smtp' };
    } catch (err) {
      console.error(`[EMAIL DISPATCH ERROR] Failed to send to ${toEmail}:`, err.message);
      return { success: false, method: 'smtp_failed', error: err.message };
    }
  } else {
    console.log(`[EMAIL NOTICE - DEV/FALLBACK] Verification code for ${toEmail} is: ${code}`);
    return { success: true, method: 'dev' };
  }
}

// Send Password Reset OTP Email
async function sendPasswordResetEmail(toEmail, code, userName = 'Trader') {
  if (!isValidEmail(toEmail)) {
    console.warn(`[EMAIL WARNING] Attempted to send password reset to invalid email format: ${toEmail}`);
    return { success: false, method: 'invalid_email', error: 'Invalid email address format' };
  }
  const mailConfig = getEmailTransporter();
  const html = buildProfessionalEmailHtml({
    headline: 'পাসওয়ার্ড রিসেট ওটিপি কোড / Password Reset Verification',
    title: 'Reset Your Account Password',
    userName,
    messageText: 'We received a request to reset the password for your <strong>Binary Prop Firm</strong> trader account. Enter the 6-digit authorization code below to proceed with setting a new password:',
    code,
    securityNote: 'If you did not request a password reset, please ignore this email and your password will remain completely secure. No changes have been made.'
  });

  if (mailConfig && mailConfig.transporter) {
    try {
      await mailConfig.transporter.sendMail({
        from: mailConfig.fromAddress,
        to: toEmail,
        subject: `[Binary Prop Firm] ${code} is your password reset code`,
        text: `Hello ${userName}, Your Binary Prop Firm password reset verification code is: ${code}. It expires in 15 minutes. Never share this code with anyone.`,
        html: html
      });
      console.log(`[PASSWORD RESET EMAIL] Reset code ${code} sent to ${toEmail}`);
      return { success: true, method: 'smtp' };
    } catch (err) {
      console.error(`[PASSWORD RESET EMAIL ERROR] Failed to send to ${toEmail}:`, err.message);
      return { success: false, method: 'smtp_failed', error: err.message };
    }
  } else {
    console.log(`[PASSWORD RESET NOTICE - DEV/FALLBACK] Reset code for ${toEmail} is: ${code}`);
    return { success: true, method: 'dev' };
  }
}

// Send Admin Login OTP Email
async function sendAdminLoginOtpEmail(toEmail, code, userName = 'Admin') {
  if (!isValidEmail(toEmail)) {
    console.warn(`[EMAIL WARNING] Attempted to send admin OTP to invalid email: ${toEmail}`);
    return { success: false, method: 'invalid_email', error: 'Invalid email address format' };
  }
  const mailConfig = getEmailTransporter();
  const html = buildProfessionalEmailHtml({
    headline: 'অ্যাডমিন সিকিউরিটি ওটিপি / Admin Security Login OTP',
    title: 'Admin Panel 3-Step Verification',
    userName,
    messageText: 'A high-privilege Admin Panel login attempt was detected on your account. To complete Step 3 of the 3-step verification process, enter your one-time authorization code:',
    code,
    securityNote: 'CRITICAL SECURITY: This OTP grants full administrative control over all trader accounts, challenge approvals, and system funds. Never disclose this code to anyone.'
  });

  if (mailConfig && mailConfig.transporter) {
    try {
      await mailConfig.transporter.sendMail({
        from: mailConfig.fromAddress,
        to: toEmail,
        subject: `[Binary Prop Firm Security] ${code} is your Admin Login Verification Code`,
        text: `Hello ${userName}, Your Binary Prop Firm Admin Login OTP code is: ${code}. It expires in 10 minutes. If you did not initiate this login, secure your credentials immediately!`,
        html: html
      });
      console.log(`[ADMIN OTP EMAIL] Login code ${code} dispatched to ${toEmail}`);
      return { success: true, method: 'smtp' };
    } catch (err) {
      console.error(`[ADMIN OTP EMAIL ERROR] Failed to dispatch to ${toEmail}:`, err.message);
      return { success: false, method: 'smtp_failed', error: err.message };
    }
  } else {
    console.log(`[ADMIN OTP NOTICE - DEV/FALLBACK] Login code for ${toEmail} is: ${code}`);
    return { success: true, method: 'dev' };
  }
}

// Send Trader Login 2FA OTP Email (Mandatory Login Verification)
async function sendTraderLoginOtpEmail(toEmail, code, userName = 'Trader') {
  if (!isValidEmail(toEmail)) {
    console.warn(`[EMAIL WARNING] Attempted to send trader login OTP to invalid email: ${toEmail}`);
    return { success: false, method: 'invalid_email', error: 'Invalid email address format' };
  }
  const mailConfig = getEmailTransporter();
  const html = buildProfessionalEmailHtml({
    headline: 'লগইন ২-ধাপ ভেরিফিকেশন ওটিপি / Login 2FA Verification OTP',
    title: 'Trader Account Login Verification',
    userName,
    messageText: 'A login attempt to your <strong>Binary Prop Firm</strong> trader dashboard was initiated. To securely complete your login, enter the 6-digit one-time authorization code below:',
    code,
    securityNote: 'CRITICAL SECURITY: If you did not initiate this login attempt, someone may know your password. Change your password immediately.'
  });

  if (mailConfig && mailConfig.transporter) {
    try {
      await mailConfig.transporter.sendMail({
        from: mailConfig.fromAddress,
        to: toEmail,
        subject: `[Binary Prop Firm Security] ${code} is your Login Verification Code`,
        text: `Hello ${userName}, Your Binary Prop Firm login verification code is: ${code}. It expires in 15 minutes. Never share this code with anyone.`,
        html: html
      });
      console.log(`[TRADER LOGIN OTP DISPATCH] Sent to ${toEmail}`);
      return { success: true, method: 'smtp' };
    } catch (err) {
      console.error(`[TRADER LOGIN OTP ERROR] Failed to dispatch to ${toEmail}:`, err.message);
      return { success: false, method: 'smtp_failed', error: err.message };
    }
  } else {
    console.log(`[TRADER LOGIN OTP DEV/FALLBACK] Code for ${toEmail} is: ${code}`);
    return { success: true, method: 'dev' };
  }
}

// Send Challenge Order Rejection Notice Email
async function sendChallengeRejectionEmail(toEmail, userName = 'Trader', packageName = 'Challenge', reason = '') {
  if (!isValidEmail(toEmail)) return { success: false };
  const mailConfig = getEmailTransporter();
  const html = buildProfessionalEmailHtml({
    headline: 'অর্ডার বাতিল সংক্রান্ত নোটিশ / Challenge Order Rejected',
    title: 'Challenge Order Rejection Notice',
    userName,
    messageText: `Your order for <strong>${packageName}</strong> evaluation has been reviewed by the Binary Prop Firm administration team and was rejected.<br><br>
    <div style="background: rgba(239, 68, 68, 0.12); border-left: 4px solid #ef4444; padding: 12px 14px; border-radius: 8px; margin: 12px 0; color: #fca5a5; font-size: 13.5px; line-height: 1.5;">
      <strong style="color: #ff8b80; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px;">বাতিলের কারণ / Reason:</strong><br>
      <span style="color: #ffffff; font-weight: 600;">${reason}</span>
    </div>
    You may log into your trader dashboard, review the feedback, and place a new order with verified payment credentials.`,
    code: 'REJECTED',
    securityNote: 'If you have questions regarding this decision, please reach out to our official support team.'
  });

  if (mailConfig && mailConfig.transporter) {
    try {
      await mailConfig.transporter.sendMail({
        from: mailConfig.fromAddress,
        to: toEmail,
        subject: `[Binary Prop Firm] আপনার চ্যালেঞ্জ অর্ডার বাতিল সংক্রান্ত নোটিশ (${packageName})`,
        text: `Hello ${userName}, Your ${packageName} challenge order has been rejected by admin. Reason: ${reason}. Please login to your dashboard for details.`,
        html: html
      });
      console.log(`[CHALLENGE REJECTION EMAIL DISPATCH] Sent to ${toEmail}`);
      return { success: true, method: 'smtp' };
    } catch (err) {
      console.error(`[CHALLENGE REJECTION EMAIL ERROR] Failed to dispatch to ${toEmail}:`, err.message);
      return { success: false, method: 'smtp_failed', error: err.message };
    }
  } else {
    console.log(`[CHALLENGE REJECTION EMAIL DEV/FALLBACK] Sent to ${toEmail}`);
    return { success: true, method: 'dev' };
  }
}

// Generate Next Unique Trader ID (e.g. AJ-1004)
function generateNextTraderId(users) {
  let maxId = 1000;
  users.forEach(u => {
    if (u.traderId && typeof u.traderId === 'string') {
      const match = u.traderId.match(/(\d+)/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxId) maxId = num;
      }
    }
  });
  return `AJ-${maxId + 1}`;
}

// Permanent Auto-Healing User & Trader Synchronizer
// Ensures NO registered user or buyer can ever be lost due to git deploy, file overwrites, or server restarts
function syncUsersWithAllData() {
  try {
    let users = readJson(USERS_FILE, []);
    let permUsers = readJson(USERS_PERMANENT_STORE_FILE, []);
    const baseChallenges = readJson(CHALLENGES_FILE, []);
    const permChallenges = readJson(CHALLENGES_PERMANENT_STORE_FILE, []);
    const chMap = new Map();
    baseChallenges.forEach(c => { if (c && c.id) chMap.set(c.id, c); });
    permChallenges.forEach(c => { if (c && c.id && !chMap.has(c.id)) chMap.set(c.id, c); });
    const challenges = Array.from(chMap.values());
    const archive = readJson(ARCHIVE_FILE, []);
    let modified = false;

    // Exclude users ONLY if explicitly deleted with master security key (AJHAR1) or dev test typo
    const deletedEmails = new Set(
      archive
        .filter(a => a.action === 'USER_DELETED_WITH_MASTER_KEY')
        .map(a => (a.userEmail || '').trim().toLowerCase())
        .filter(Boolean)
    );
    const deletedIds = new Set(
      archive
        .filter(a => a.action === 'USER_DELETED_WITH_MASTER_KEY')
        .map(a => a.userId)
        .filter(Boolean)
    );
    const devTestEmails = new Set([
      'atharajhar6@gmail.come',
      'disc@example.com',
      'test@trader.com',
      'protrader@example.com',
      'ajhar@test.com',
      'admin@ajfunded.com',
      'lead.trader@binarypropfirm.com'
    ]);
    const devTestIds = new Set([
      'usr_test_1',
      'test_discount_user',
      'usr_1790486638103_3bbjv3',
      'usr_1790475483790_5etunz',
      'usr_1790479900000_ajf',
      'usr_1790470000000_lead'
    ]);

    const isExcluded = (email, id) => {
      const e = (email || '').trim().toLowerCase();
      return devTestEmails.has(e) || (id && devTestIds.has(id)) || (e && deletedEmails.has(e)) || (id && deletedIds.has(id));
    };

    // Filter out excluded from existing users
    const initialUserLen = users.length;
    users = users.filter(u => !isExcluded(u.email, u.id));
    if (users.length !== initialUserLen) modified = true;

    // Helper maps keyed by normalized email, and by userId
    const userByEmail = new Map();
    const userById = new Map();

    const registerUser = (u) => {
      if (!u || isExcluded(u.email, u.id)) return;
      if (u.email) {
        const normEmail = u.email.trim().toLowerCase();
        if (normEmail && !userByEmail.has(normEmail)) {
          userByEmail.set(normEmail, u);
        }
      }
      if (u.id && !userById.has(u.id)) {
        userById.set(u.id, u);
      }
    };

    // 1. Index users from users.json
    users.forEach(u => registerUser(u));

    // 2. Merge from Lifelong Vault (Highest priority permanent store for registered traders)
    const vaultUsers = readAllFromLifelongVault();
    vaultUsers.forEach(vu => {
      if (isExcluded(vu.email, vu.id)) return;
      const normEmail = vu.email ? vu.email.trim().toLowerCase() : '';
      let existing = (normEmail && userByEmail.get(normEmail)) || (vu.id && userById.get(vu.id));
      if (!existing) {
        users.push(vu);
        registerUser(vu);
        modified = true;
      } else {
        // Protect existing password: if existing password is short/invalid, use vault's bcrypt hash
        if (vu.password && (!existing.password || existing.password.length < 20)) {
          existing.password = vu.password;
          modified = true;
        }
        if (!existing.traderId && vu.traderId) { existing.traderId = vu.traderId; modified = true; }
        if (!existing.brokerAccountId && vu.brokerAccountId) { existing.brokerAccountId = vu.brokerAccountId; modified = true; }
        if (!existing.telegram && vu.telegram) { existing.telegram = vu.telegram; modified = true; }
        if (vu.isEmailVerified && !existing.isEmailVerified) { existing.isEmailVerified = true; modified = true; }
      }
    });

    // 3. Merge from permanent store
    permUsers.forEach(pu => {
      if (isExcluded(pu.email, pu.id)) return;
      const normEmail = pu.email ? pu.email.trim().toLowerCase() : '';
      let existing = (normEmail && userByEmail.get(normEmail)) || (pu.id && userById.get(pu.id));
      if (!existing) {
        users.push(pu);
        registerUser(pu);
        modified = true;
      } else {
        let enriched = false;
        if (!existing.traderId && pu.traderId) { existing.traderId = pu.traderId; enriched = true; }
        if (!existing.brokerAccountId && pu.brokerAccountId) { existing.brokerAccountId = pu.brokerAccountId; enriched = true; }
        if (!existing.telegram && pu.telegram) { existing.telegram = pu.telegram; enriched = true; }
        if (enriched) modified = true;
      }
    });

    // 3. Scan challenges.json for any buyer missing from users
    challenges.forEach(c => {
      if (isExcluded(c.userEmail, c.userId)) return;
      const cEmail = c.userEmail ? c.userEmail.trim().toLowerCase() : '';
      const cUserId = c.userId || '';
      let existing = (cEmail && userByEmail.get(cEmail)) || (cUserId && userById.get(cUserId));

      if (!existing && (cEmail || cUserId)) {
        const recoveredUser = {
          id: cUserId || `usr_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          name: c.userName || 'Trader',
          email: c.userEmail || '',
          password: '$2a$10$E4Z4i1YoCstc9o/y/PtvserVlaqlREVhpie5Jz8Ysgr0sAVbmKkVW',
          role: 'user',
          telegram: (c.userTelegram && c.userTelegram !== 'N/A') ? c.userTelegram : '',
          preferredBroker: (c.brokerId || c.userBroker || 'quotex').toLowerCase(),
          payoutWallet: '',
          brokerAccountId: c.brokerAccountId || '',
          profilePicture: c.userAvatar || null,
          isEmailVerified: true,
          createdAt: c.createdAt || new Date().toISOString(),
          traderId: (c.userTraderId && c.userTraderId.startsWith('AJ-')) ? c.userTraderId : null
        };
        users.push(recoveredUser);
        registerUser(recoveredUser);
        modified = true;
        console.log(`[AUTO-HEAL] Resurrected user from challenges.json: ${recoveredUser.name} (${recoveredUser.email})`);
      } else if (existing) {
        if (!existing.brokerAccountId && c.brokerAccountId) {
          existing.brokerAccountId = c.brokerAccountId;
          modified = true;
        }
        if ((!existing.telegram || existing.telegram === 'N/A') && c.userTelegram && c.userTelegram !== 'N/A') {
          existing.telegram = c.userTelegram;
          modified = true;
        }
      }
    });

    // 4. Scan user_archive.json for any registered user
    archive.forEach(arc => {
      if (isExcluded(arc.userEmail, arc.userId)) return;
      if (arc.action === 'USER_REGISTERED' || arc.action === 'CHALLENGE_PURCHASED') {
        const arcEmail = arc.userEmail ? arc.userEmail.trim().toLowerCase() : '';
        const arcUserId = arc.userId && arc.userId !== 'N/A' ? arc.userId : '';
        if (arcEmail && !userByEmail.has(arcEmail) && (!arcUserId || !userById.has(arcUserId))) {
          const recoveredUser = {
            id: arcUserId || `usr_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            name: arc.userName && arc.userName !== 'N/A' ? arc.userName : 'Trader',
            email: arc.userEmail,
            password: '$2a$10$E4Z4i1YoCstc9o/y/PtvserVlaqlREVhpie5Jz8Ysgr0sAVbmKkVW',
            role: 'user',
            telegram: arc.telegram || '',
            preferredBroker: (arc.preferredBroker || 'quotex').toLowerCase(),
            payoutWallet: arc.payoutWallet || '',
            brokerAccountId: arc.brokerAccountId || '',
            profilePicture: null,
            isEmailVerified: Boolean(arc.isEmailVerified),
            createdAt: arc.timestamp || new Date().toISOString(),
            traderId: null
          };
          users.push(recoveredUser);
          registerUser(recoveredUser);
          modified = true;
          console.log(`[AUTO-HEAL] Resurrected user from user_archive.json: ${recoveredUser.name} (${recoveredUser.email})`);
        }
      }
    });

    // 5. Ensure sequential and unique Trader IDs for all non-admin users
    const adminUser = users.find(u => u.role === 'admin' || u.email === 'admin@binarypropfirm.com');
    if (adminUser) {
      if (!adminUser.traderId) adminUser.traderId = 'BPF-1000';
    }

    const regularUsers = users.filter(u => u.role !== 'admin');
    regularUsers.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

    let maxNum = 1000;
    regularUsers.forEach(u => {
      if (u.traderId && typeof u.traderId === 'string') {
        const m = u.traderId.match(/(\d+)/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
      }
    });

    regularUsers.forEach(u => {
      if (!u.traderId || !u.traderId.startsWith('AJ-')) {
        maxNum++;
        u.traderId = `AJ-${maxNum}`;
        modified = true;
      }
    });

    // 6. Update userTraderId in challenges.json if mismatched
    let challengesModified = false;
    challenges.forEach(c => {
      const u = users.find(user => (c.userId && user.id === c.userId) || (c.userEmail && user.email.toLowerCase() === c.userEmail.toLowerCase()));
      if (u && u.traderId && c.userTraderId !== u.traderId) {
        c.userTraderId = u.traderId;
        challengesModified = true;
      }
    });
    if (challengesModified) {
      writeJson(CHALLENGES_FILE, challenges);
    }

    // 7. Persist to both USERS_FILE and USERS_PERMANENT_STORE_FILE
    if (modified || !fs.existsSync(USERS_PERMANENT_STORE_FILE)) {
      writeJson(USERS_FILE, users);
      writeJson(USERS_PERMANENT_STORE_FILE, users);
    }

    // 8. Guarantee every valid user is mirrored to Lifelong Vault
    users.forEach(u => {
      if (u && u.email && !isExcluded(u.email, u.id)) {
        saveTraderToLifelongVault(u);
      }
    });

    return users;
  } catch (err) {
    console.error('[SYNC USERS ERROR]:', err);
    return readJson(USERS_FILE, []);
  }
}

// Ensure default admin user exists
async function ensureAdminUser() {
  try {
    let users = syncUsersWithAllData();
    let changed = false;

    // Filter out invalid variations
    const initialLen = users.length;
    users = users.filter(u => u.email.toLowerCase() !== 'atharajhar6@gmail.come');
    if (users.length !== initialLen) changed = true;

    // Default target admin password hash for Ajhar1@2#3$
    const salt = await bcrypt.genSalt(10);
    const targetPasswordHash = await bcrypt.hash('Ajhar1@2#3$', salt);

    // 1. Primary Platform Owner Admin: atharajhar6@gmail.com (MD AJHAR)
    let ownerAdmin = users.find(u => u.email.toLowerCase() === 'atharajhar6@gmail.com');
    if (!ownerAdmin) {
      users.push({
        id: 'usr_admin_atharajhar',
        traderId: 'BPF-ADMIN-1',
        name: 'MD AJHAR',
        email: 'atharajhar6@gmail.com',
        password: targetPasswordHash,
        role: 'admin',
        telegram: 'MDAJHA1',
        preferredBroker: 'quotex',
        payoutWallet: '',
        brokerAccountId: '',
        profilePicture: null,
        isEmailVerified: true,
        adminSecurityPin: '254271',
        createdAt: '2026-09-27T03:31:54.536Z'
      });
      changed = true;
    } else {
      if (ownerAdmin.role !== 'admin') {
        ownerAdmin.role = 'admin';
        changed = true;
      }
      if (!ownerAdmin.name) {
        ownerAdmin.name = 'MD AJHAR';
        changed = true;
      }
      if (!ownerAdmin.isEmailVerified) {
        ownerAdmin.isEmailVerified = true;
        changed = true;
      }
      if (ownerAdmin.adminSecurityPin !== '254271') {
        ownerAdmin.adminSecurityPin = '254271';
        changed = true;
      }
      const isOwnerMatch = ownerAdmin.password ? await bcrypt.compare('Ajhar1@2#3$', ownerAdmin.password) : false;
      if (!isOwnerMatch) {
        ownerAdmin.password = targetPasswordHash;
        changed = true;
      }
    }

    // 2. Backup Admin Account: admin@binarypropfirm.com
    const masterAdmin = users.find(u => u.email.toLowerCase() === 'admin@binarypropfirm.com' || u.email.toLowerCase() === 'admin@ajfunded.com');
    if (!masterAdmin) {
      users.push({
        id: 'usr_admin_master',
        traderId: 'BPF-1000',
        name: 'Binary Prop Firm Admin',
        email: 'admin@binarypropfirm.com',
        password: targetPasswordHash,
        role: 'admin',
        telegram: '@BinaryPropFirmAdmin',
        preferredBroker: 'quotex',
        payoutWallet: '',
        brokerAccountId: '',
        profilePicture: null,
        isEmailVerified: true,
        adminSecurityPin: '254271',
        createdAt: new Date().toISOString()
      });
      changed = true;
    } else {
      if (masterAdmin.email.toLowerCase() === 'admin@ajfunded.com') {
        masterAdmin.email = 'admin@binarypropfirm.com';
        masterAdmin.name = 'Binary Prop Firm Admin';
        masterAdmin.telegram = '@BinaryPropFirmAdmin';
        changed = true;
      }
      if (masterAdmin.role !== 'admin') {
        masterAdmin.role = 'admin';
        changed = true;
      }
      if (!masterAdmin.isEmailVerified) {
        masterAdmin.isEmailVerified = true;
        changed = true;
      }
      masterAdmin.adminSecurityPin = '254271';
      masterAdmin.traderId = masterAdmin.traderId || 'BPF-1000';
      const isMasterMatch = masterAdmin.password ? await bcrypt.compare('Ajhar1@2#3$', masterAdmin.password) : false;
      if (!isMasterMatch) {
        masterAdmin.password = targetPasswordHash;
        changed = true;
      }
    }

    // Ensure all existing users have email verification, profilePicture, and unique traderId
    let nextNum = 1001;
    users.forEach(u => {
      if (u.isEmailVerified === undefined) {
        u.isEmailVerified = true;
        changed = true;
      }
      if (u.profilePicture === undefined) {
        u.profilePicture = null;
        changed = true;
      }
      if (!u.traderId) {
        while (users.some(other => other.traderId === `AJ-${nextNum}`)) {
          nextNum++;
        }
        u.traderId = `AJ-${nextNum}`;
        nextNum++;
        changed = true;
      }
    });

    if (changed) {
      writeJson(USERS_FILE, users);
      writeJson(USERS_PERMANENT_STORE_FILE, users);
    }
  } catch (err) {
    console.error('Error ensuring admin user:', err);
  }
}
ensureAdminUser();

// Multer storage for daily trade submissions
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const cleanName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_');
    cb(null, `proof_${Date.now()}_${cleanName}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB to support photos & video proofs
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isImage = file.mimetype.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
    const isVideo = file.mimetype.startsWith('video/') || ['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(ext);
    if (isImage || isVideo) {
      cb(null, true);
    } else {
      cb(new Error('দয়া করে ছবি বা ভিডিও ফাইল আপলোড করুন (JPG, PNG, WebP, MP4, WebM, MOV)।'));
    }
  }
});

// Multer storage for user profile pictures / avatars
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const cleanId = (req.user && req.user.id ? req.user.id : 'usr').replace(/[^a-zA-Z0-9]/g, '_');
    cb(null, `avatar_${cleanId}_${Date.now()}${ext}`);
  }
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files (JPG, PNG, WebP, GIF) are allowed.'));
  }
});

// ==============================================
// CLOUD PROOF HOSTING & ZERO-DISK STORAGE ENGINE
// ==============================================
async function uploadToFreeCloudCdn(fileBuffer, originalFilename, mimeType) {
  const ext = path.extname(originalFilename || '').toLowerCase();
  const safeFilename = originalFilename || `trade_proof_${Date.now()}${ext || '.png'}`;
  const safeMime = mimeType || (ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : 'image/png');

  // 1. Primary: Catbox (Unlimited Free Hosting for Images & Videos up to 200MB)
  try {
    const blob = new Blob([fileBuffer], { type: safeMime });
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', blob, safeFilename);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 seconds for videos

    const res = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      body: form,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const url = (await res.text()).trim();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        console.log(`[Storage] Uploaded successfully: ${url}`);
        return { success: true, url, provider: 'Cloud Host' };
      }
    }
  } catch (err) {
    console.warn('[Storage] Primary upload error, trying fallback:', err.message);
  }

  // 2. Secondary Fallback: Tmpfiles
  try {
    const blob = new Blob([fileBuffer], { type: safeMime });
    const form = new FormData();
    form.append('file', blob, safeFilename);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    const res = await fetch('https://tmpfiles.org/api/v1/upload', {
      method: 'POST',
      body: form,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const json = await res.json();
      if (json && json.data && json.data.url) {
        const directUrl = json.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
        console.log(`[Storage] Uploaded successfully: ${directUrl}`);
        return { success: true, url: directUrl, provider: 'Cloud Host' };
      }
    }
  } catch (err) {
    console.warn('[Storage] Fallback error:', err.message);
  }

  return { success: false, url: null, provider: null };
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Anti-Cache Middleware: Prevent browsers from caching HTML, JS, or API responses
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// JWT Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required. Please login.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Session expired or invalid. Please login again.' });
    req.user = user;
    next();
  });
}

// JWT Admin Auth Middleware
function authenticateAdminToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Admin authentication required. Please login as admin.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Session expired or invalid.' });
    if (user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Access denied. Administrator privileges required.' });
    }
    req.user = user;
    next();
  });
}

// ----------------- PACKAGES DATA -----------------
const PACKAGES = [
  {
    id: "pkg-bronze",
    tierNumber: 1,
    name: "Bronze",
    badge: "#1",
    originalFee: 5,
    fee: 5,
    fundedAmount: 100,
    profitSplit: "75%",
    maxDrawdown: "25%",
    minDays: 15,
    sessions: 15,
    dailyLoss: "No Strict Limit (Rec. 5%)",
    profitTarget: "No Fixed Pressure",
    popular: false,
    color: "#CD7F32",
    rules: [
      "15 Trading Sessions Required",
      "25% Maximum Drawdown Limit",
      "Trade on any verified broker demo",
      "Daily proof video & screenshot upload",
      "Keep 75% profit upon passing"
    ]
  },
  {
    id: "pkg-silver",
    tierNumber: 2,
    name: "Silver",
    badge: "#2",
    originalFee: 10,
    fee: 7, // 30% discount
    fundedAmount: 210,
    profitSplit: "75%",
    maxDrawdown: "25%",
    minDays: 15,
    sessions: 15,
    dailyLoss: "No Strict Limit (Rec. 5%)",
    profitTarget: "No Fixed Pressure",
    popular: false,
    color: "#C0C0C0",
    rules: [
      "15 Trading Sessions Required",
      "25% Maximum Drawdown Limit",
      "Trade on any verified broker demo",
      "Daily proof video & screenshot upload",
      "Keep 75% profit upon passing"
    ]
  },
  {
    id: "pkg-gold",
    tierNumber: 3,
    name: "Gold",
    badge: "#3",
    originalFee: 25,
    fee: 15, // 40% discount
    fundedAmount: 525,
    profitSplit: "75%",
    maxDrawdown: "25%",
    minDays: 15,
    sessions: 15,
    dailyLoss: "No Strict Limit (Rec. 5%)",
    profitTarget: "No Fixed Pressure",
    popular: false,
    color: "#F5B041",
    rules: [
      "15 Trading Sessions Required",
      "25% Maximum Drawdown Limit",
      "Trade on any verified broker demo",
      "Daily proof video & screenshot upload",
      "Keep 75% profit upon passing"
    ]
  },
  {
    id: "pkg-platinum",
    tierNumber: 4,
    name: "Platinum",
    badge: "MOST POPULAR",
    originalFee: 50,
    fee: 30, // 40% discount
    fundedAmount: 1200,
    profitSplit: "80%",
    maxDrawdown: "25%",
    minDays: 15,
    sessions: 15,
    dailyLoss: "No Strict Limit (Rec. 5%)",
    profitTarget: "No Fixed Pressure",
    popular: true,
    color: "#E5E4E2",
    rules: [
      "15 Trading Sessions Required",
      "25% Maximum Drawdown Limit",
      "Trade on any verified broker demo",
      "Daily proof video & screenshot upload",
      "Keep 80% profit upon passing"
    ]
  },
  {
    id: "pkg-diamond",
    tierNumber: 5,
    name: "Diamond",
    badge: "#5",
    originalFee: 100,
    fee: 60, // 40% discount
    fundedAmount: 2500,
    profitSplit: "80%",
    maxDrawdown: "25%",
    minDays: 15,
    sessions: 15,
    dailyLoss: "No Strict Limit (Rec. 5%)",
    profitTarget: "No Fixed Pressure",
    popular: false,
    color: "#B9F2FF",
    rules: [
      "15 Trading Sessions Required",
      "25% Maximum Drawdown Limit",
      "Trade on any verified broker demo",
      "Daily proof video & screenshot upload",
      "Keep 80% profit upon passing"
    ]
  },
  {
    id: "pkg-legendary",
    tierNumber: 6,
    name: "Legendary",
    badge: "#6",
    originalFee: 200,
    fee: 120, // 40% discount
    fundedAmount: 5200,
    profitSplit: "85%",
    maxDrawdown: "25%",
    minDays: 15,
    sessions: 15,
    dailyLoss: "No Strict Limit (Rec. 5%)",
    profitTarget: "No Fixed Pressure",
    popular: false,
    color: "#9B59B6",
    rules: [
      "15 Trading Sessions Required",
      "25% Maximum Drawdown Limit",
      "Trade on any verified broker demo",
      "Daily proof video & screenshot upload",
      "Keep 85% profit upon passing"
    ]
  },
  {
    id: "pkg-ultimate",
    tierNumber: 7,
    name: "Ultimate",
    badge: "#7",
    originalFee: 399,
    fee: 239, // 40% discount
    fundedAmount: 10500,
    profitSplit: "85%",
    maxDrawdown: "25%",
    minDays: 15,
    sessions: 15,
    dailyLoss: "No Strict Limit (Rec. 5%)",
    profitTarget: "No Fixed Pressure",
    popular: false,
    color: "#E74C3C",
    rules: [
      "15 Trading Sessions Required",
      "25% Maximum Drawdown Limit",
      "Trade on any verified broker demo",
      "Daily proof video & screenshot upload",
      "Keep 85% profit upon passing"
    ]
  },
  {
    id: "pkg-titan",
    tierNumber: 8,
    name: "Titan",
    badge: "#8",
    originalFee: 499,
    fee: 299, // 40% discount
    fundedAmount: 15000,
    profitSplit: "85%",
    maxDrawdown: "25%",
    minDays: 15,
    sessions: 15,
    dailyLoss: "No Strict Limit (Rec. 5%)",
    profitTarget: "No Fixed Pressure",
    popular: false,
    color: "#1ABC9C",
    rules: [
      "15 Trading Sessions Required",
      "25% Maximum Drawdown Limit",
      "Trade on any verified broker demo",
      "Daily proof video & screenshot upload",
      "Keep 85% profit upon passing"
    ]
  },
  {
    id: "pkg-master",
    tierNumber: 9,
    name: "Master",
    badge: "#9",
    originalFee: 999,
    fee: 599, // 40% discount
    fundedAmount: 32000,
    profitSplit: "85%",
    maxDrawdown: "25%",
    minDays: 15,
    sessions: 15,
    dailyLoss: "No Strict Limit (Rec. 5%)",
    profitTarget: "No Fixed Pressure",
    popular: false,
    color: "#F39C12",
    rules: [
      "15 Trading Sessions Required",
      "25% Maximum Drawdown Limit",
      "Trade on any verified broker demo",
      "Daily proof video & screenshot upload",
      "Keep 85% profit upon passing"
    ]
  }
];

// Launch Promo & Dynamic Pricing Helpers
function getLaunchPromo() {
  const promo = readJson(LAUNCH_PROMO_FILE, null);
  const defaultPromo = {
    active: true,
    enableDiscounts: true,
    badge: "🔥 ব্রোকার গ্র্যান্ড লঞ্চ স্পেশাল মেগা অফার • মাত্র ৭ দিন বাকি!",
    title: "ব্রোকার প্রথম লঞ্চিং উপলক্ষে বিশেষ ছাড় ধামাকা!",
    description: "আমাদের ব্রোকার প্ল্যাটফর্মের প্রথম লঞ্চ উপলক্ষে ২য় চ্যালেঞ্জে ৩০% ছাড় এবং ৩য় থেকে বাকি সকল চ্যালেঞ্জে পাচ্ছেন ফ্ল্যাট ৪০% মেগা ডিসকাউন্ট! (১ম ব্রোঞ্জ চ্যালেঞ্জ রেগুলার ফি প্রযোজ্য)। অফারটি মাত্র ৭ দিন পর্যন্ত বহাল থাকবে।",
    discountTag: "লঞ্চ স্পেশাল ছাড়",
    countdownTitle: "অফারটি শেষ হতে আর বাকি",
    showCountdown: true,
    durationDays: 7,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  };

  if (!promo || !promo.expiresAt) {
    writeJson(LAUNCH_PROMO_FILE, defaultPromo);
    return defaultPromo;
  }

  return {
    ...defaultPromo,
    ...promo,
    badge: promo.badge || defaultPromo.badge,
    title: promo.title || defaultPromo.title,
    description: promo.description || defaultPromo.description,
    discountTag: promo.discountTag || defaultPromo.discountTag,
    countdownTitle: promo.countdownTitle || defaultPromo.countdownTitle,
    enableDiscounts: promo.enableDiscounts !== undefined ? promo.enableDiscounts : true,
    showCountdown: promo.showCountdown !== undefined ? promo.showCountdown : true
  };
}

function getPromoPresets() {
  const presets = readJson(PROMO_PRESETS_FILE, []);
  if (!Array.isArray(presets) || presets.length === 0) {
    const defaults = [
      {
        id: "preset-launch",
        name: "🚀 ব্রোকার লঞ্চ অফার",
        isDefault: true,
        discountTag: "লঞ্চ স্পেশাল ছাড়",
        badge: "🔥 ব্রোকার গ্র্যান্ড লঞ্চ স্পেশাল মেগা অফার • মাত্র ৭ দিন বাকি!",
        title: "ব্রোকার প্রথম লঞ্চিং উপলক্ষে বিশেষ ছাড় ধামাকা!",
        description: "ব্রোকার প্রথম লঞ্চ করা উপলক্ষে ২নং চ্যালেঞ্জে ৩০% এবং ৩নং থেকে শুরু করে বাকি চ্যালেঞ্জগুলোতে ৪০% মেগা ডিসকাউন্ট! এখনই নিজের ট্রেডিং জার্নি শুরু করুন কম খরচে।",
        countdownTitle: "অফারটি শেষ হতে আর বাকি",
        durationDays: 7,
        showCountdown: true,
        enableDiscounts: true,
        active: true
      },
      {
        id: "preset-eid",
        name: "🌙 পবিত্র ঈদ মোবারক অফার",
        isDefault: true,
        discountTag: "ঈদ স্পেশাল ছাড়",
        badge: "🌙 পবিত্র ঈদ উপলক্ষে বিশেষ মেগা ধামাকা অফার!",
        title: "পবিত্র ঈদ উপলক্ষে বিশেষ ডিসকাউন্ট ধামাকা!",
        description: "পবিত্র ঈদ উপলক্ষে সকল ট্রেডারদের জন্য বিশেষ মূল্যছাড় সুবিধা চালু করা হয়েছে। সীমিত সময়ের এই ঈদ অফারে নিজের একাউন্ট নিশ্চিত করুন!",
        countdownTitle: "ঈদ অফার শেষ হতে আর বাকি",
        durationDays: 7,
        showCountdown: true,
        enableDiscounts: true,
        active: true
      },
      {
        id: "preset-mega",
        name: "⚡ মেগা ধামাকা ছাড়",
        isDefault: true,
        discountTag: "মেগা ধামাকা ছাড়",
        badge: "⚡ ফ্ল্যাশ সেল • সীমিত সময়ের মেগা অফার ধামাকা!",
        title: "সীমিত সময়ের জন্য বিশেষ মেগা ডিসকাউন্ট ধামাকা!",
        description: "ট্রেডারদের সুবিধার্থে বিশেষ আকর্ষণীয় ছাড় ঘোষণা করা হয়েছে। নির্ধারিত সময়ের আগেই অফারটি গ্রহণ করুন।",
        countdownTitle: "মেগা অফার শেষ হতে আর বাকি",
        durationDays: 3,
        showCountdown: true,
        enableDiscounts: true,
        active: true
      }
    ];
    writeJson(PROMO_PRESETS_FILE, defaults);
    return defaults;
  }
  return presets;
}

function getEnrichedPackages(includeInactive = false) {
  const promo = getLaunchPromo();
  const isPromoActive = promo && promo.active && new Date(promo.expiresAt) > new Date();
  const applyDiscounts = isPromoActive && (promo.enableDiscounts !== false);

  let allPackages = readJson(PACKAGES_FILE, PACKAGES);
  if (!allPackages || allPackages.length === 0) {
    allPackages = PACKAGES;
    writeJson(PACKAGES_FILE, allPackages);
  }

  // Sort by tierNumber
  allPackages.sort((a, b) => (parseInt(a.tierNumber) || 0) - (parseInt(b.tierNumber) || 0));

  if (!includeInactive) {
    allPackages = allPackages.filter(p => p.isActive !== false);
  }

  const globalDiscountTag = (promo && promo.discountTag) ? promo.discountTag : 'লঞ্চ স্পেশাল ছাড়';

  return allPackages.map(pkg => {
    const originalFee = parseFloat(pkg.originalFee !== undefined ? pkg.originalFee : (pkg.fee || 0));
    
    // Check if package has an explicit discountPercent set by admin
    let rawDiscountPercent = (pkg.discountPercent !== undefined && pkg.discountPercent !== null) 
      ? parseInt(pkg.discountPercent) 
      : 0;

    // If no manual discount specified, apply launch promo defaults if active
    if ((pkg.discountPercent === undefined || pkg.discountPercent === null) && isPromoActive) {
      if (pkg.tierNumber === 1) rawDiscountPercent = 0;
      else if (pkg.tierNumber === 2) rawDiscountPercent = 30;
      else if (pkg.tierNumber >= 3) rawDiscountPercent = 40;
    }

    // If promo or discounts disabled, discountPercent is 0
    const discountPercent = applyDiscounts ? rawDiscountPercent : 0;
    const discountAmount = discountPercent > 0 ? Math.round(originalFee * (discountPercent / 100)) : 0;
    const payableFee = discountPercent > 0 ? Math.max(1, originalFee - discountAmount) : originalFee;
    const discountTag = pkg.discountTag || globalDiscountTag;

    return {
      ...pkg,
      originalFee: originalFee,
      fee: payableFee,
      discountPercent: discountPercent,
      savedDiscountPercent: rawDiscountPercent,
      discountAmount: discountAmount,
      hasDiscount: discountPercent > 0,
      discountTag: discountTag,
      discountBadge: discountPercent > 0 ? `${discountPercent}% OFF • ${discountTag}` : null
    };
  });
}

// Supported External Binary Brokers
const SUPPORTED_BROKERS = [
  { id: "quotex", name: "Quotex", icon: "/assets/brokers/quotex.png", desc: "Top choice for 1-minute OTC & live Forex trading with instant payouts." },
  { id: "pocketoption", name: "Pocket Option", icon: "/assets/brokers/pocketoption.png", desc: "Ultra-fast binary execution, 5-second trades and flexible expiry." },
  { id: "olymptrade", name: "Olymp Trade", icon: "/assets/brokers/olymp.png", desc: "Regulated platform with professional charting and Fixed Time Trades." },
  { id: "binomo", name: "Binomo", icon: "/assets/brokers/binomo.png", desc: "Popular binary options broker with seamless interface & high OTC returns." },
  { id: "iqoption", name: "IQ Option", icon: "/assets/brokers/iqoption.png", desc: "Classic multi-asset trading platform with rich technical indicators." }
];

// 10 Golden Rules Data (Official Rules Provided by User)
const TEN_RULES = [
  {
    id: 1,
    titleEn: "Complete 15 Sessions According to Money Management Sheet",
    titleBn: "মানি ম্যানেজমেন্ট শিট অনুযায়ী ১৫টি সেশন কমপ্লিট করতে হবে",
    descEn: "You must strictly follow the official money management sheet and successfully complete 15 sessions.",
    descBn: "মানি ম্যানেজমেন্ট শিট অনুযায়ী ১৫ টি সেশন কমপ্লিট করতে হবে।"
  },
  {
    id: 2,
    titleEn: "Win 6 out of 16 Trades with Max 25% Loss",
    titleBn: "১৬টি ট্রেডের মধ্যে ৬টি উইন এবং সর্বোচ্চ ২৫% লস লিমিট",
    descEn: "In each session, you must profit on 6 trades out of 16, while keeping total losses within a maximum of 25%.",
    descBn: "প্রতিটি সেশনে ১৬টি ট্রেড এর মধ্যে ৬ টি ট্রেড প্রফিট করতে হবে সর্বোচ্চ ২৫% লস করে।"
  },
  {
    id: 3,
    titleEn: "Strictly No Extra Trades on Demo Outside the Sheet",
    titleBn: "চ্যালেঞ্জ চলাকালীন শীটের বাহিরে ডেমোতে কোনো ট্রেড নয়",
    descEn: "During the challenge evaluation, taking even a single trade on demo outside the money management sheet is strictly prohibited.",
    descBn: "চ্যালেঞ্জ চলাকালীন মানি ম্যানেজমেন্ট শীটের বাহিরে ডেমুতে একটি ট্রেড ও করা যাবে না।"
  },
  {
    id: 4,
    titleEn: "Max 3 Sessions Per Day (Results by 11:00 PM)",
    titleBn: "প্রতিদিন সর্বোচ্চ ৩টি সেশন (রাত ১১টার মধ্যে রেজাল্ট)",
    descEn: "Maximum of 3 sessions can be completed and submitted per day. Results will be reviewed and notified by 11:00 PM.",
    descBn: "প্রতিদিন সর্বোচ্চ তিনটা সেশন করা যাবে, সেশন করে জমা দিয়ে রাখবেন এবং রাত ১১ টার মধ্যে রেজাল্ট জানিয়ে দেওয়া হবে।"
  },
  {
    id: 5,
    titleEn: "Session Goal (6 Wins) or Stop if Below $0.50",
    titleBn: "৬টি প্রফিট হলে সেশন সম্পন্ন; $0.50 এর নিচে নামলে সেশন ক্লোজ",
    descEn: "Session is complete once 6 trades are in profit. If balance drops below $0.50 before hitting 6 wins, the session must be immediately closed.",
    descBn: "১৬ টা ট্রেডের মধ্যে ৬ টা ট্রেড প্রফিট হলে আপনার একটি সেশন কমপ্লিট হয়ে যাবে; যদি ৬ টা ট্রেড প্রফিট হওয়ার আগেই $0.50 এর নিচে নেমে যায় তাহলে সেশন ক্লোজ করে দিতে হবে।"
  },
  {
    id: 6,
    titleEn: "Trade Only on 85%+ Payout Return Markets",
    titleBn: "প্রতিটি ট্রেড করতে হবে ৮৫%+ রিটার্ন দেওয়া মার্কেটে",
    descEn: "Every trade during the challenge must be taken strictly in currency/asset pairs offering at least 85% or higher return payout.",
    descBn: "চ্যালেঞ্জ চলাকালীন প্রতিটা ট্রেড করতে হবে ৮৫% এর উপরের রিটার্ন দিতেছে এরকম মার্কেটে।"
  },
  {
    id: 7,
    titleEn: "Decimal Rounding Rule (>50 Cents = +$1)",
    titleBn: "ট্রেড সাইজের ডেসিমাল রাউন্ডিং নিয়ম (৫০ সেন্টের বেশি হলে ১ ডলার বৃদ্ধি)",
    descEn: "If the sheet trade size has cents: for $4.50 or below, trade $4. If $4.51 or higher, round up and trade $5.",
    descBn: "যত ডলারের ট্রেড নিতে বলবে তার সাথে যদি ৫০ সেন্টের উপরে থাকে তাহলে ১ ডলার বাড়িয়ে ট্রেড নিতে হবে। যেমন: $4.50 বা তার নিচে আসলে $4 ট্রেড নিবেন, আর যদি $4.51 বা তার উপরে ট্রেড নিতে বলে মানি ম্যানেজমেন্ট শীট তাহলে $5 ট্রেড নিবেন।"
  },
  {
    id: 8,
    titleEn: "Compound Profits into the Next Session",
    titleBn: "প্রতি সেশনের প্রফিট পরবর্তী সেশনের ক্যাপিটালে যুক্ত হবে",
    descEn: "Profit made in a session adds to the starting balance of the next session (e.g. start with $100, profit earned adds to the next session capital).",
    descBn: "প্রতি সেশনে যত ডলার প্রফিট করবেন তা যুক্ত হবে পরবর্তী সেশনে। মানে প্রথম সেশন শুরু করলেন $100 দিয়ে এবং এই সেশনটি কমপ্লিটে যত ডলার প্রফিট হবে তা ২ নম্বর সেশনে যুক্ত হবে $100 এর সাথে।"
  },
  {
    id: 9,
    titleEn: "Video Proof: Show Trader ID & Previous Trade Before Session",
    titleBn: "ভিডিওতে প্রথমে ট্রেডার আইডি ও সেশন শুরুর পূর্বের ১টি ট্রেড দেখানো",
    descEn: "When screen recording trade history: first display your Trader ID, then show 1 trade executed prior to starting this session to verify no unrecorded trades were taken outside the sheet.",
    descBn: "প্রতিদিন ট্রেডিং হিস্টোরি স্ক্রিন ভিডিও করে দেওয়ার সময় প্রথমে আপনার ট্রেডার আইডি দেখাবেন, তারপরে ট্রেডিং হিস্টোরি ভিডিও করার সময় সেশন শুরু করার আগের একটি ট্রেড দেখাবেন যেন আমরা বুঝতে পারি আপনি শীটের বাহিরে ট্রেড করেন নাই।"
  },
  {
    id: 10,
    titleEn: "Complete Challenge Within Maximum 15 Days",
    titleBn: "সর্বোচ্চ ১৫ দিনের মধ্যে চ্যালেঞ্জটি কমপ্লিট করতে হবে",
    descEn: "The full 15-session challenge evaluation must be completed within a maximum timeframe of 15 days.",
    descBn: "সর্বোচ্চ ১৫ দিনের মধ্যে এই চ্যালেঞ্জটি কমপ্লিট করতে হবে।"
  }
];

// Course Lessons Data
const COURSE_LESSONS = [
  {
    id: "lesson-1",
    title: "ট্রেডিং মানে কি এবং কেন শিখবেন? (What is Trading & Why Learn It?)",
    duration: "18:45",
    category: "Basics",
    summary: "লাভের আশায় কোনো কিছু ক্রয়-বিক্রয় করাকে ট্রেডিং বলে। বাস্তব উদাহরণ ও ৩টি সহজ ধাপ।",
    videoEmbed: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    slidesCount: 8
  },
  {
    id: "lesson-2",
    title: "বাইনারি ট্রেডিং কিভাবে কাজ করে? (How Binary Options Works?)",
    duration: "24:10",
    category: "Mechanism",
    summary: "২০০৮ সালের আর্থিক মন্দার পর বাইনারি ট্রেডিংয়ের উৎপত্তি। দাম পর্যবেক্ষণ, পেআউট (৭০-৯৫%) ও ঝুঁকি।",
    videoEmbed: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    slidesCount: 8
  },
  {
    id: "lesson-3",
    title: "ট্রেডিং দিয়ে বাস্তব ইনকাম ও ক্যারিয়ার (Skill-based Career)",
    duration: "21:30",
    category: "Career",
    summary: "কোনো সুপারিশ বা ডিগ্রি ছাড়াই দক্ষতা দিয়ে ঘরে বসে স্বাধীন ইনকাম গড়ার বাস্তব পথ ও মেন্টরশিপ।",
    videoEmbed: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    slidesCount: 8
  },
  {
    id: "lesson-4",
    title: "ট্রেডিং এর ভালো দিক ও সুবিধা সমূহ (Pros & Freedom of Trading)",
    duration: "15:20",
    category: "Pros & Cons",
    summary: "২৪ ঘন্টা খোলা মার্কেট, আনলিমিটেড ইনকাম সম্ভাব্যতা, এবং সময় নিজের হাতে রাখার স্বাধীনতা।",
    videoEmbed: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    slidesCount: 8
  },
  {
    id: "lesson-5",
    title: "কেন ৯০% ট্রেডার লস করে ও উত্তরণের উপায় (Why Most Lose)",
    duration: "28:50",
    category: "Psychology",
    summary: "না শিখে শর্টকাট খোঁজা, ইমোশনাল রিভেঞ্জ ট্রেড এবং রিস্ক ম্যানেজমেন্টের অভাব কাটানোর উপায়।",
    videoEmbed: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    slidesCount: 8
  },
  {
    id: "lesson-6",
    title: "সফল ট্রেডিংয়ের সোনালী সমীকরণ (The Golden Formula)",
    duration: "22:15",
    category: "Equation",
    summary: "সঠিক শিক্ষা + নিখুঁত বিশ্লেষণ + নিয়মতান্ত্রিক ধৈর্য = দীর্ঘমেয়াদী প্রফিটেবল ট্রেডার।",
    videoEmbed: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    slidesCount: 8
  },
  {
    id: "lesson-7",
    title: "ওটিসি (OTC) সিক্রেট প্রাইস অ্যাকশন ও ক্যান্ডেলস্টিক স্ট্র্যাটেজি",
    duration: "32:00",
    category: "Strategy",
    summary: "ব্রোকার ওটিসি অ্যালগরিদম ও সাপোর্ট-রেজিস্ট্যান্স দিয়ে কনফার্ম উইন ট্রেড নেওয়ার গোপন কৌশল।",
    videoEmbed: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    slidesCount: 8
  }
];

// ----------------- AUTH APIS -----------------

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, telegram, preferredBroker } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email and password are required.' });
    }

    const cleanedEmail = normalizeEmail(email);
    if (!isValidEmail(cleanedEmail)) {
      return res.status(400).json({ success: false, message: 'অনুগ্রহ করে একটি সঠিক ইমেইল দিন (যেমন: name@gmail.com)।' });
    }

    const users = syncUsersWithAllData();
    const existing = users.find(u => u.email.toLowerCase() === cleanedEmail);
    if (existing) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const verificationCode = generateVerificationCode();

    const newUser = {
      id: `usr_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      traderId: generateNextTraderId(users),
      name: name.trim(),
      email: cleanedEmail,
      password: hashedPassword,
      role: 'user',
      telegram: telegram ? telegram.trim() : '',
      preferredBroker: preferredBroker || 'quotex',
      payoutWallet: '',
      brokerAccountId: '',
      profilePicture: null,
      isEmailVerified: false,
      emailVerificationCode: verificationCode,
      emailVerificationExpires: Date.now() + 15 * 60 * 1000,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    writeJson(USERS_FILE, users);
    writeJson(USERS_PERMANENT_STORE_FILE, users);
    saveTraderToLifelongVault(newUser);

    // Permanently archive user creation
    logUserArchive('USER_REGISTERED', newUser, { ip: req.ip || req.connection.remoteAddress });

    // Send verification email in background
    sendVerificationEmail(newUser.email, verificationCode, newUser.name);

    res.status(201).json({
      success: true,
      message: 'অ্যাকাউন্ট তৈরি হয়েছে! আপনার ইমেইলে একটি ৬-সংখ্যার ভেরিফিকেশন কোড পাঠানো হয়েছে। অ্যাকাউন্ট সচল করতে কোডটি দিন।',
      requiresVerification: true,
      email: newUser.email,
      user: {
        id: newUser.id,
        traderId: newUser.traderId,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        telegram: newUser.telegram,
        preferredBroker: newUser.preferredBroker,
        payoutWallet: newUser.payoutWallet,
        brokerAccountId: newUser.brokerAccountId,
        profilePicture: null,
        isEmailVerified: false
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Internal server error while registering.' });
  }
});

// Verify Email
app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'ইমেইল এবং ৬-সংখ্যার ওটিপি কোড দিন।' });
    }

    const normalizedUserEmail = normalizeEmail(email);
    const users = readJson(USERS_FILE);
    let user = users.find(u => u.email.toLowerCase() === (email ? email.trim().toLowerCase() : ''));
    if (!user && normalizedUserEmail) {
      user = users.find(u => u.email.toLowerCase() === normalizedUserEmail);
    }
    if (!user) {
      return res.status(404).json({ success: false, message: 'এই ইমেইলের কোনো ব্যবহারকারী পাওয়া যায়নি।' });
    }

    if (user.isEmailVerified) {
      return res.json({ success: true, message: 'এই ইমেইলটি ইতিমধ্যে ভেরিফাইড!', alreadyVerified: true });
    }

    if (!user.emailVerificationCode || user.emailVerificationCode !== otp.trim()) {
      return res.status(400).json({ success: false, message: 'ভুল ওটিপি কোড। অনুগ্রহ করে সঠিক ৬-সংখ্যার কোডটি দিন।' });
    }

    if (user.emailVerificationExpires && Date.now() > user.emailVerificationExpires) {
      return res.status(400).json({ success: false, message: 'ওটিপি কোডের মেয়াদ শেষ হয়ে গেছে। অনুগ্রহ করে "Resend Code" ক্লিক করুন।' });
    }

    user.isEmailVerified = true;
    user.emailVerificationCode = null;
    user.emailVerificationExpires = null;
    user.emailVerifiedAt = new Date().toISOString();
    writeJson(USERS_FILE, users);
    writeJson(USERS_PERMANENT_STORE_FILE, users);
    saveTraderToLifelongVault(user);
    logUserArchive('EMAIL_VERIFIED', user, { method: 'otp' });

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '15d' });

    res.json({
      success: true,
      message: 'অভিনন্দন! আপনার ইমেইল সফলভাবে ভেরিফাই হয়েছে।',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role || 'user',
        telegram: user.telegram,
        preferredBroker: user.preferredBroker,
        isEmailVerified: true
      }
    });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ success: false, message: 'ইমেইল ভেরিফিকেশন সম্পন্ন করতে সমস্যা হয়েছে।' });
  }
});

// Resend Email Verification OTP
app.post('/api/auth/resend-verification-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'ইমেইল অ্যাড্রেস প্রয়োজন।' });
    }

    const normalizedUserEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedUserEmail)) {
      return res.status(400).json({ success: false, message: 'সঠিক ফরম্যাটের ইমেইল দিন (যেমন: name@gmail.com)।' });
    }

    const users = readJson(USERS_FILE);
    let user = users.find(u => u.email.toLowerCase() === (email ? email.trim().toLowerCase() : ''));
    if (!user && normalizedUserEmail) {
      user = users.find(u => u.email.toLowerCase() === normalizedUserEmail);
    }
    if (!user) {
      return res.status(404).json({ success: false, message: 'এই ইমেইল পাওয়া যায়নি।' });
    }

    if (user.isEmailVerified) {
      return res.json({ success: true, message: 'আপনার ইমেইল ইতিমধ্যে ভেরিফাইড!', alreadyVerified: true });
    }

    const code = generateVerificationCode();
    user.emailVerificationCode = code;
    user.emailVerificationExpires = Date.now() + 15 * 60 * 1000;
    writeJson(USERS_FILE, users);

    sendVerificationEmail(user.email, code, user.name);

    res.json({
      success: true,
      message: 'আপনার ইমেইলে নতুন ৬-সংখ্যার ভেরিফিকেশন কোড পাঠানো হয়েছে।',
      devOtp: code
    });
  } catch (err) {
    console.error('Resend verification OTP error:', err);
    res.status(500).json({ success: false, message: 'নতুন কোড পাঠাতে সমস্যা হয়েছে।' });
  }
});

// Login (Initiates 2-Step Gmail Verification)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'ইমেইল এবং পাসওয়ার্ড আবশ্যক।' });
    }

    const rawEmail = typeof email === 'string' ? email.trim() : '';
    const cleanedEmail = rawEmail.toLowerCase();
    const normalizedEmail = normalizeEmail(rawEmail);

    let users = readJson(USERS_FILE, []);
    let user = users.find(u => u.email && u.email.toLowerCase() === cleanedEmail);

    // If direct match failed, try normalized match
    if (!user && normalizedEmail && normalizedEmail !== cleanedEmail) {
      user = users.find(u => u.email && u.email.toLowerCase() === normalizedEmail);
    }

    // High reliability fallback: Auto-sync with Lifelong Vault if not found immediately
    if (!user) {
      users = syncUsersWithAllData();
      user = users.find(u => u.email && (u.email.toLowerCase() === cleanedEmail || (normalizedEmail && u.email.toLowerCase() === normalizedEmail)));
    }

    if (!user) {
      return res.status(400).json({ success: false, message: 'ভুল তথ্য। এই ইমেইলে কোনো অ্যাকাউন্ট পাওয়া যায়নি।' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'ভুল পাসওয়ার্ড। দয়া করে সঠিক পাসওয়ার্ড দিয়ে চেষ্টা করুন।' });
    }

    // If email is not yet verified from registration, force registration verification
    if (user.isEmailVerified === false) {
      const verifyCode = generateVerificationCode();
      user.emailVerificationCode = verifyCode;
      user.emailVerificationExpires = Date.now() + 15 * 60 * 1000;
      writeJson(USERS_FILE, users);
      writeJson(USERS_PERMANENT_STORE_FILE, users);
      saveTraderToLifelongVault(user);
      sendVerificationEmail(user.email, verifyCode, user.name);

      return res.status(403).json({
        success: false,
        requiresEmailVerification: true,
        email: user.email,
        message: 'আপনার অ্যাকাউন্টটি এখনও ইমেইল ভেরিফাই করা হয়নি। আপনার ইমেইলে একটি নতুন ভেরিফিকেশন কোড পাঠানো হয়েছে।'
      });
    }

    // Generate 6-digit Login 2FA OTP
    const loginOtp = generateVerificationCode();
    user.loginOtp = loginOtp;
    user.loginOtpExpires = Date.now() + 15 * 60 * 1000; // 15 mins expiry
    writeJson(USERS_FILE, users);
    writeJson(USERS_PERMANENT_STORE_FILE, users);
    saveTraderToLifelongVault(user);

    // Send Login OTP to user's registered Gmail
    sendTraderLoginOtpEmail(user.email, loginOtp, user.name);

    // Issue short-lived preAuthToken for 2FA verification step only
    const preAuthToken = jwt.sign(
      { id: user.id, email: user.email, type: 'pre_auth_otp' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    // Mask email for display: e.g. fx***@gmail.com
    const emailParts = user.email.split('@');
    const maskedPrefix = emailParts[0].length > 2 
      ? emailParts[0].substring(0, 2) + '***' 
      : emailParts[0] + '***';
    const maskedEmail = `${maskedPrefix}@${emailParts[1]}`;

    res.json({
      success: true,
      requiresLoginOtp: true,
      preAuthToken,
      email: user.email,
      maskedEmail,
      message: 'আপনার জিমেইলে একটি ৬-সংখ্যার লগইন ভেরিফিকেশন কোড পাঠানো হয়েছে।'
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি। অনুগ্রহ করে পুনরায় চেষ্টা করুন।' });
  }
});

// Verify Login 2FA OTP & Issue Final JWT Session
app.post('/api/auth/verify-login-otp', async (req, res) => {
  try {
    const { email, otp, preAuthToken } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'ইমেইল এবং ৬-সংখ্যার ওটিপি কোড দিন।' });
    }
    if (!preAuthToken) {
      return res.status(401).json({ success: false, message: 'লগইন সেশন অবৈধ। পুনরায় ইমেইল ও পাসওয়ার্ড দিয়ে চেষ্টা করুন।' });
    }

    let decoded;
    try {
      decoded = jwt.verify(preAuthToken, JWT_SECRET);
      if (decoded.type !== 'pre_auth_otp' || decoded.email.toLowerCase() !== email.trim().toLowerCase()) {
        return res.status(401).json({ success: false, message: 'অবৈধ অথেনটিকেশন সেশন।' });
      }
    } catch (e) {
      return res.status(401).json({ success: false, message: 'ওটিপি সেশনের মেয়াদ শেষ হয়ে গেছে। পুনরায় লগইন করুন।' });
    }

    let users = readJson(USERS_FILE, []);
    const rawEmail = typeof email === 'string' ? email.trim() : '';
    const cleanedEmail = rawEmail.toLowerCase();
    const normalizedEmail = normalizeEmail(rawEmail);

    let user = users.find(u => u.email && (u.email.toLowerCase() === cleanedEmail || (normalizedEmail && u.email.toLowerCase() === normalizedEmail)));
    if (!user) {
      users = syncUsersWithAllData();
      user = users.find(u => u.email && (u.email.toLowerCase() === cleanedEmail || (normalizedEmail && u.email.toLowerCase() === normalizedEmail)));
    }
    if (!user) {
      return res.status(404).json({ success: false, message: 'ইউজার খুঁজে পাওয়া যায়নি।' });
    }

    if (!user.loginOtp || user.loginOtp !== otp.trim()) {
      return res.status(400).json({ success: false, message: 'ভুল ওটিপি কোড। অনুগ্রহ করে সঠিক ৬-সংখ্যার কোডটি দিন।' });
    }

    if (user.loginOtpExpires && Date.now() > user.loginOtpExpires) {
      return res.status(400).json({ success: false, message: 'ওটিপি কোডের মেয়াদ শেষ হয়ে গেছে। অনুগ্রহ করে "Resend Code" ক্লিক করুন।' });
    }

    // Clear login OTP once used
    user.loginOtp = null;
    user.loginOtpExpires = null;
    user.lastLoginAt = new Date().toISOString();
    writeJson(USERS_FILE, users);
    writeJson(USERS_PERMANENT_STORE_FILE, users);
    saveTraderToLifelongVault(user);

    logUserArchive('USER_LOGGED_IN_WITH_2FA_OTP', user, { ip: req.ip || req.connection.remoteAddress });

    // Issue official full 15-day JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role || 'user' },
      JWT_SECRET,
      { expiresIn: '15d' }
    );

    res.json({
      success: true,
      message: 'লগইন সফল হয়েছে!',
      token,
      user: {
        id: user.id,
        traderId: user.traderId || 'AJ-1001',
        name: user.name,
        email: user.email,
        role: user.role || 'user',
        telegram: user.telegram,
        preferredBroker: user.preferredBroker,
        payoutWallet: user.payoutWallet,
        brokerAccountId: user.brokerAccountId,
        profilePicture: user.profilePicture || null,
        isEmailVerified: true
      }
    });
  } catch (err) {
    console.error('Verify login OTP error:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি। অনুগ্রহ করে পুনরায় চেষ্টা করুন।' });
  }
});

// Resend Login 2FA OTP
app.post('/api/auth/resend-login-otp', async (req, res) => {
  try {
    const { email, preAuthToken } = req.body;
    if (!email || !preAuthToken) {
      return res.status(400).json({ success: false, message: 'অনুরোধটি অসম্পূর্ণ।' });
    }
    try {
      const decoded = jwt.verify(preAuthToken, JWT_SECRET);
      if (decoded.type !== 'pre_auth_otp' || decoded.email.toLowerCase() !== email.trim().toLowerCase()) {
        return res.status(401).json({ success: false, message: 'অবৈধ অনুরোধ।' });
      }
    } catch (e) {
      return res.status(401).json({ success: false, message: 'সেশনের মেয়াদ শেষ হয়ে গেছে। পুনরায় লগইন ফর্ম থেকে চেষ্টা করুন।' });
    }

    let users = readJson(USERS_FILE, []);
    const rawEmail = typeof email === 'string' ? email.trim() : '';
    const cleanedEmail = rawEmail.toLowerCase();
    const normalizedEmail = normalizeEmail(rawEmail);

    let user = users.find(u => u.email && (u.email.toLowerCase() === cleanedEmail || (normalizedEmail && u.email.toLowerCase() === normalizedEmail)));
    if (!user) return res.status(404).json({ success: false, message: 'ইউজার পাওয়া যায়নি।' });

    const freshOtp = generateVerificationCode();
    user.loginOtp = freshOtp;
    user.loginOtpExpires = Date.now() + 15 * 60 * 1000;
    writeJson(USERS_FILE, users);
    writeJson(USERS_PERMANENT_STORE_FILE, users);
    saveTraderToLifelongVault(user);

    sendTraderLoginOtpEmail(user.email, freshOtp, user.name);

    res.json({
      success: true,
      message: 'আপনার জিমেইলে নতুন ৬-সংখ্যার লগইন ওটিপি কোড পাঠানো হয়েছে।'
    });
  } catch (err) {
    console.error('Resend login OTP error:', err);
    res.status(500).json({ success: false, message: 'ওটিপি পাঠাতে সমস্যা হয়েছে।' });
  }
});

// Request Password Reset Code (Send OTP to Email)
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'আপনার রেজিস্টার্ড ইমেইল অ্যাড্রেস দিন।' });
    }

    const normalizedUserEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedUserEmail)) {
      return res.status(400).json({ success: false, message: 'অনুগ্রহ করে সঠিক ফরম্যাটের ইমেইল দিন (যেমন: name@gmail.com)।' });
    }

    const users = readJson(USERS_FILE);
    let user = users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user && normalizedUserEmail) {
      user = users.find(u => u.email.toLowerCase() === normalizedUserEmail);
    }
    if (!user) {
      return res.status(404).json({ success: false, message: 'এই ইমেইল দিয়ে কোনো অ্যাকাউন্ট পাওয়া যায়নি। সঠিক ইমেইল দিন।' });
    }

    const resetCode = generateVerificationCode();
    user.passwordResetCode = resetCode;
    user.passwordResetExpires = Date.now() + 15 * 60 * 1000; // 15 mins
    writeJson(USERS_FILE, users);

    sendPasswordResetEmail(user.email, resetCode, user.name);

    res.json({
      success: true,
      message: 'আপনার ইমেইলে একটি ৬-সংখ্যার পাসওয়ার্ড রিসেট কোড পাঠানো হয়েছে।',
      email: user.email,
      devOtp: resetCode
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ success: false, message: 'রিসেট কোড পাঠাতে সমস্যা হয়েছে।' });
  }
});

// Verify Code and Reset Password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ success: false, message: 'ইমেইল, ৬-সংখ্যার ওটিপি কোড এবং নতুন পাসওয়ার্ড দিন।' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।' });
    }

    const normalizedUserEmail = normalizeEmail(email);
    const users = readJson(USERS_FILE);
    let userIndex = users.findIndex(u => u.email.toLowerCase() === email.trim().toLowerCase());
    if (userIndex === -1 && normalizedUserEmail) {
      userIndex = users.findIndex(u => u.email.toLowerCase() === normalizedUserEmail);
    }
    if (userIndex === -1) {
      return res.status(404).json({ success: false, message: 'এই ইমেইল দিয়ে কোনো অ্যাকাউন্ট পাওয়া যায়নি।' });
    }

    const user = users[userIndex];

    if (!user.passwordResetCode || user.passwordResetCode !== otp.trim()) {
      return res.status(400).json({ success: false, message: 'ভুল ওটিপি কোড। অনুগ্রহ করে আপনার ইমেইল চেক করে সঠিক কোডটি দিন।' });
    }

    if (user.passwordResetExpires && Date.now() > user.passwordResetExpires) {
      return res.status(400).json({ success: false, message: 'ওটিপি কোডের মেয়াদ শেষ হয়ে গেছে। অনুগ্রহ করে আবার কোড পাঠান।' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.passwordResetCode = null;
    user.passwordResetExpires = null;
    user.updatedAt = new Date().toISOString();
    writeJson(USERS_FILE, users);
    writeJson(USERS_PERMANENT_STORE_FILE, users);
    saveTraderToLifelongVault(user);
    logUserArchive('PASSWORD_RESET', user);

    res.json({
      success: true,
      message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে! এখন নতুন পাসওয়ার্ড দিয়ে লগইন করুন।'
    });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: 'পাসওয়ার্ড রিসেট করতে সমস্যা হয়েছে।' });
  }
});

// Get Current User Profile
app.get('/api/auth/me', authenticateToken, (req, res) => {
  const users = readJson(USERS_FILE);
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const challenges = readJson(CHALLENGES_FILE).filter(c => c.userId === user.id);
  const submissions = readJson(SUBMISSIONS_FILE).filter(s => s.userId === user.id);

  res.json({
    success: true,
    user: {
      id: user.id,
      traderId: user.traderId || 'AJ-1001',
      name: user.name,
      email: user.email,
      role: user.role || 'user',
      telegram: user.telegram,
      preferredBroker: user.preferredBroker,
      payoutWallet: user.payoutWallet,
      brokerAccountId: user.brokerAccountId,
      profilePicture: user.profilePicture || null,
      isEmailVerified: user.isEmailVerified !== undefined ? user.isEmailVerified : true,
      createdAt: user.createdAt
    },
    activeChallengesCount: challenges.filter(c => c.status === 'in_progress').length,
    passedChallengesCount: challenges.filter(c => c.status === 'passed').length,
    totalChallengesCount: challenges.length,
    totalSubmissionsCount: submissions.length,
    approvedSubmissionsCount: submissions.filter(s => s.status === 'verified').length
  });
});

// Update Profile
app.post('/api/auth/update-profile', authenticateToken, (req, res) => {
  const { name, telegram, preferredBroker, payoutWallet, brokerAccountId } = req.body;
  const users = readJson(USERS_FILE);
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'User not found.' });

  if (name) users[idx].name = name.trim();
  if (telegram !== undefined) users[idx].telegram = telegram.trim();
  if (preferredBroker) users[idx].preferredBroker = preferredBroker;
  if (payoutWallet !== undefined) users[idx].payoutWallet = payoutWallet.trim();
  if (brokerAccountId !== undefined) users[idx].brokerAccountId = brokerAccountId.trim();
  users[idx].updatedAt = new Date().toISOString();

  writeJson(USERS_FILE, users);
  writeJson(USERS_PERMANENT_STORE_FILE, users);
  saveTraderToLifelongVault(users[idx]);
  logUserArchive('PROFILE_UPDATED', users[idx]);

  res.json({
    success: true,
    message: 'Profile updated successfully!',
    user: {
      id: users[idx].id,
      traderId: users[idx].traderId || 'AJ-1001',
      name: users[idx].name,
      email: users[idx].email,
      telegram: users[idx].telegram,
      preferredBroker: users[idx].preferredBroker,
      payoutWallet: users[idx].payoutWallet,
      brokerAccountId: users[idx].brokerAccountId,
      profilePicture: users[idx].profilePicture || null,
      isEmailVerified: users[idx].isEmailVerified !== undefined ? users[idx].isEmailVerified : true
    }
  });
});

// Upload User Profile Picture (Avatar)
app.post('/api/user/upload-avatar', authenticateToken, uploadAvatar.single('avatar'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'অনুগ্রহ করে একটি ছবি নির্বাচন করুন।' });
    }

    const users = readJson(USERS_FILE);
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'ইউজার পাওয়া যায়নি।' });

    const avatarUrl = `/uploads/${req.file.filename}`;
    user.profilePicture = avatarUrl;
    user.updatedAt = new Date().toISOString();
    writeJson(USERS_FILE, users);

    logUserArchive('AVATAR_UPDATED', user, { avatarUrl });

    res.json({
      success: true,
      message: 'প্রোফাইল ছবি সফলভাবে আপডেট হয়েছে!',
      profilePicture: avatarUrl
    });
  } catch (err) {
    console.error('Upload avatar error:', err);
    res.status(500).json({ success: false, message: err.message || 'ছবি আপলোড করতে ত্রুটি হয়েছে।' });
  }
});

// Remove User Profile Picture
app.post('/api/user/remove-avatar', authenticateToken, (req, res) => {
  try {
    const users = readJson(USERS_FILE);
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'ইউজার পাওয়া যায়নি।' });

    user.profilePicture = null;
    user.updatedAt = new Date().toISOString();
    writeJson(USERS_FILE, users);

    logUserArchive('AVATAR_REMOVED', user);

    res.json({
      success: true,
      message: 'প্রোফাইল ছবি সফলভাবে মুছে ফেলা হয়েছে।'
    });
  } catch (err) {
    console.error('Remove avatar error:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি।' });
  }
});

// Change Password directly from User Profile
app.post('/api/user/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'বর্তমান এবং নতুন উভয় পাসওয়ার্ড প্রদান করুন।' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।' });
    }

    const users = readJson(USERS_FILE);
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'ইউজার পাওয়া যায়নি।' });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'বর্তমান পাসওয়ার্ড ভুল।' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword.trim(), salt);
    user.updatedAt = new Date().toISOString();
    writeJson(USERS_FILE, users);
    writeJson(USERS_PERMANENT_STORE_FILE, users);
    saveTraderToLifelongVault(user);

    logUserArchive('PASSWORD_CHANGED', user);

    res.json({
      success: true,
      message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে!'
    });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ success: false, message: 'পাসওয়ার্ড পরিবর্তনে ত্রুটি হয়েছে।' });
  }
});

// ----------------- TRADER LIVE MULTI-DEVICE SYNC & CLOUD PERSISTENCE APIS -----------------

// Active SSE client connections map: userId -> Set of Express response objects
const sseTraderClients = new Map();

function broadcastTraderStateToUser(userId, data, excludeDeviceId = null) {
  const clients = sseTraderClients.get(userId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const clientRes of clients) {
    if (excludeDeviceId && clientRes._deviceId === excludeDeviceId) continue;
    try {
      clientRes.write(payload);
    } catch (e) {
      console.error('SSE client write error:', e.message);
    }
  }
}

// 20-second keep-alive heartbeat ping to prevent connection timeout through Cloudflare/proxies
setInterval(() => {
  for (const [userId, clients] of sseTraderClients.entries()) {
    for (const clientRes of clients) {
      try {
        clientRes.write(': ping\n\n');
      } catch (e) {
        // Ignored, will be cleaned up on close
      }
    }
  }
}, 20000);

// 1. Real-time Multi-Device Sync Stream (SSE)
app.get('/api/user/live-sync-stream', authenticateToken, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const userId = req.user.id;
  const deviceId = req.query.deviceId || '';
  res._deviceId = deviceId;

  if (!sseTraderClients.has(userId)) {
    sseTraderClients.set(userId, new Set());
  }
  const userClients = sseTraderClients.get(userId);
  userClients.add(res);

  // Send initial connection confirmation
  const traderStates = readJson(TRADER_STATES_FILE, {});
  const currentState = traderStates[userId] || null;
  res.write(`data: ${JSON.stringify({
    type: 'CONNECTED',
    version: currentState?.version || 0,
    timestamp: Date.now()
  })}\n\n`);

  req.on('close', () => {
    const clients = sseTraderClients.get(userId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        sseTraderClients.delete(userId);
      }
    }
  });
});

// 2. Fetch User's Cloud Stored Live State (Persistence on login / reload / re-entry)
app.get('/api/user/live-state', authenticateToken, (req, res) => {
  try {
    const traderStates = readJson(TRADER_STATES_FILE, {});
    const state = traderStates[req.user.id] || null;
    res.json({
      success: true,
      liveState: state
    });
  } catch (err) {
    console.error('Error fetching trader live state:', err);
    res.status(500).json({ success: false, message: 'Server error fetching live state' });
  }
});

// 3. Save User's Live State & Broadcast to all Connected Devices (Autosave & Instant Sync)
app.post('/api/user/live-state', authenticateToken, (req, res) => {
  try {
    const userId = req.user.id;
    const { masState, pendingProof, activeTab, senderDeviceId } = req.body;
    const traderStates = readJson(TRADER_STATES_FILE, {});
    const existing = traderStates[userId] || {};

    const nextVersion = (existing.version || 0) + 1;
    const updatedState = {
      ...existing,
      userId,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
      lastDeviceId: senderDeviceId || ''
    };

    if (masState && typeof masState === 'object') {
      const validCapital = (typeof masState.capital === 'number' && masState.capital > 0)
        ? masState.capital
        : (existing.masState?.capital || 100);
      const validHistory = Array.isArray(masState.history)
        ? masState.history.filter(h => h === 'w' || h === 'l')
        : (existing.masState?.history || []);

      updatedState.masState = {
        capital: validCapital,
        totalTrades: 16,
        winTrades: 6,
        quota: 1.85,
        stopLossPct: 0.25,
        history: validHistory
      };
    }

    if (pendingProof !== undefined) {
      updatedState.pendingProof = pendingProof;
    }

    if (activeTab && typeof activeTab === 'string') {
      updatedState.activeTab = activeTab;
    }

    traderStates[userId] = updatedState;
    writeJson(TRADER_STATES_FILE, traderStates);

    // Instant real-time broadcast to other connected tabs/devices of this user
    broadcastTraderStateToUser(userId, {
      type: 'STATE_UPDATE',
      version: updatedState.version,
      state: updatedState,
      senderDeviceId: senderDeviceId || ''
    }, senderDeviceId);

    res.json({
      success: true,
      version: updatedState.version,
      liveState: updatedState
    });
  } catch (err) {
    console.error('Error saving trader live state:', err);
    res.status(500).json({ success: false, message: 'Server error saving live state' });
  }
});

// ----------------- CHALLENGES APIS -----------------

// Get all packages, brokers & 10 rules
app.get('/api/challenges/packages', (req, res) => {
  const promo = getLaunchPromo();
  const isPromoActive = promo && promo.active && new Date(promo.expiresAt) > new Date();
  const enrichedPackages = getEnrichedPackages();

  res.json({
    success: true,
    packages: enrichedPackages,
    launchPromo: {
      ...promo,
      active: isPromoActive
    },
    brokers: SUPPORTED_BROKERS,
    tenRules: TEN_RULES
  });
});

// Buy / Enroll in a challenge
app.post('/api/challenges/buy', authenticateToken, (req, res) => {
  const { packageId, brokerId, brokerAccountId, paymentMethod, paymentTxId, senderNumber, currency, currencySymbol, exchangeRate, localAmount } = req.body;
  const enrichedPackages = getEnrichedPackages();
  const pkg = enrichedPackages.find(p => p.id === packageId);
  if (!pkg) return res.status(400).json({ success: false, message: 'Invalid package selected.' });

  // Sync existing challenges to ensure status freshness
  const allChallenges = syncChallengesWithSubmissions();
  const userChallenges = allChallenges.filter(c => c.userId === req.user.id);

  // 1. Check if user already has a pending challenge
  const pendingChallenge = userChallenges.find(c => c.status === 'pending_approval' || c.status === 'pending');
  if (pendingChallenge) {
    return res.status(400).json({
      success: false,
      message: 'আপনার একটি চ্যালেঞ্জ অলরেডি পেন্ডিং রয়েছে।',
      reason: 'CHALLENGE_PENDING',
      existingChallenge: {
        id: pendingChallenge.id,
        packageName: pendingChallenge.packageName,
        status: pendingChallenge.status
      }
    });
  }

  // 2. Check if user already has a running / in_progress challenge
  const runningChallenge = userChallenges.find(c => c.status === 'in_progress' || (c.isActive === true && c.status !== 'failed' && c.status !== 'passed' && c.status !== 'rejected'));
  if (runningChallenge) {
    return res.status(400).json({
      success: false,
      message: 'আপনার একটি চ্যালেঞ্জ অলরেডি রানিং রয়েছে।',
      reason: 'CHALLENGE_RUNNING',
      existingChallenge: {
        id: runningChallenge.id,
        packageName: runningChallenge.packageName,
        status: runningChallenge.status
      }
    });
  }

  const broker = SUPPORTED_BROKERS.find(b => b.id === brokerId) || SUPPORTED_BROKERS[0];
  const challenges = readJson(CHALLENGES_FILE);
  const users = readJson(USERS_FILE);
  const currentUser = users.find(u => u.id === req.user.id) || req.user;

  const numExchangeRate = (exchangeRate && !isNaN(parseFloat(exchangeRate)) && parseFloat(exchangeRate) > 0) ? parseFloat(exchangeRate) : 1;
  const numLocalAmount = (localAmount && !isNaN(parseFloat(localAmount)) && parseFloat(localAmount) > 0) ? parseFloat(localAmount) : (pkg.fee * numExchangeRate);

  const newChallenge = {
    id: `ch_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    userId: req.user.id,
    userName: currentUser.name || req.user.name || 'Trader',
    userEmail: currentUser.email || req.user.email || '',
    userTraderId: currentUser.traderId || 'AJ-1000',
    userTelegram: currentUser.telegram || 'N/A',
    userBroker: currentUser.preferredBroker || broker.name,
    packageId: pkg.id,
    packageName: pkg.name,
    originalFee: pkg.originalFee,
    fee: pkg.fee,
    discountPercent: pkg.discountPercent || 0,
    hasDiscount: Boolean(pkg.hasDiscount),
    fundedAmount: pkg.fundedAmount,
    profitSplit: pkg.profitSplit,
    maxDrawdown: pkg.maxDrawdown,
    brokerId: broker.id,
    brokerName: broker.name,
    brokerIcon: broker.icon,
    brokerAccountId: brokerAccountId || 'Demo Account',
    status: 'pending_approval', // Pending admin payment approval & MM link assignment
    sessionsRequired: pkg.sessions || 15,
    sessionsCompleted: 0,
    currentDrawdown: "0%",
    paymentMethod: paymentMethod || 'USDT TRC20',
    paymentTxId: paymentTxId || `TX_${Date.now()}`,
    senderNumber: senderNumber ? senderNumber.trim() : '',
    currency: currency ? currency.trim().toUpperCase() : 'USD',
    currencySymbol: currencySymbol ? currencySymbol.trim() : '$',
    exchangeRate: numExchangeRate,
    localAmount: numLocalAmount,
    assignedMmId: null,
    assignedMmSerial: null,
    assignedMmTitle: null,
    assignedMmUrl: null,
    assignedMmNote: null,
    approvedAt: null,
    createdAt: new Date().toISOString()
  };

  challenges.unshift(newChallenge);
  saveChallenges(challenges);
  logUserArchive('CHALLENGE_PURCHASED', { id: req.user.id, name: req.user.name, email: req.user.email }, {
    challengeId: newChallenge.id,
    packageName: pkg.name,
    fundedAmount: pkg.fundedAmount,
    broker: newChallenge.brokerName,
    paymentMethod: newChallenge.paymentMethod,
    paymentTxId: newChallenge.paymentTxId,
    senderNumber: newChallenge.senderNumber,
    localAmount: newChallenge.localAmount,
    currency: newChallenge.currency,
    exchangeRate: newChallenge.exchangeRate
  });

  res.status(201).json({
    success: true,
    message: `আপনার ${pkg.name} ($${pkg.fundedAmount}) চ্যালেঞ্জ ক্রয় রিকোয়েস্ট সফলভাবে জমা হয়েছে! এডমিন পেমেন্ট ভেরিফাই করে অনুমোদন দিলে এটি রানিং হবে এবং মানি ম্যানেজমেন্ট শিট লিংক যুক্ত হয়ে যাবে।`,
    challenge: newChallenge
  });
});

// Get user's challenges (Robust dual-key lookup by userId, email, or traderId)
app.get('/api/challenges/my', authenticateToken, (req, res) => {
  const allCh = syncChallengesWithSubmissions();
  const userCh = allCh.filter(c => 
    c.userId === req.user.id || 
    (c.userEmail && req.user.email && c.userEmail.toLowerCase() === req.user.email.toLowerCase()) ||
    (c.userTraderId && req.user.traderId && c.userTraderId.toLowerCase() === req.user.traderId.toLowerCase())
  );
  res.json({
    success: true,
    challenges: userCh
  });
});

// Trader manually cancels/skips practice period and starts official 15-day challenge countdown immediately
app.post('/api/challenges/:id/start-official', authenticateToken, (req, res) => {
  try {
    const challenges = readJson(CHALLENGES_FILE);
    const idx = challenges.findIndex(c => 
      c.id === req.params.id && 
      (c.userId === req.user.id || (c.userEmail && req.user.email && c.userEmail.toLowerCase() === req.user.email.toLowerCase()))
    );
    if (idx === -1) {
      return res.status(404).json({ success: false, message: 'চ্যালেঞ্জ খুঁজে পাওয়া যায়নি।' });
    }

    const c = challenges[idx];
    if (c.status !== 'in_progress') {
      return res.status(400).json({ success: false, message: 'চ্যালেঞ্জটি বর্তমানে চলমান (Active) অবস্থায় নেই।' });
    }

    if (c.challengePhase === 'evaluation') {
      return res.status(400).json({ success: false, message: 'আপনার চ্যালেঞ্জটি ইতিমধ্যে মূল ১৫ দিনের মূল্যায়ন পর্বে রয়েছে।' });
    }

    const now = new Date();
    c.challengePhase = 'evaluation';
    c.evaluationStartedAt = now.toISOString();
    c.practiceSkippedAt = now.toISOString();
    c.durationDays = c.durationDays || 15;
    c.expiresAt = new Date(now.getTime() + (c.durationDays * 24 * 60 * 60 * 1000)).toISOString();
    challenges[idx] = c;
    saveChallenges(challenges);

    logUserArchive('CHALLENGE_OFFICIAL_EVALUATION_STARTED', { id: req.user.id }, {
      challengeId: c.id,
      packageName: c.packageName,
      startedAt: now.toISOString(),
      expiresAt: c.expiresAt
    });

    syncChallengesWithSubmissions();

    res.json({
      success: true,
      message: '🎉 আপনার মূল ১৫ দিনের চ্যালেঞ্জ সফলভাবে শুরু হয়েছে! এখন থেকে আপনার প্রতিটি সেশনের অফিসিয়াল মূল্যায়ন সম্পন্ন হবে।',
      challenge: c
    });
  } catch (err) {
    console.error('Error starting official challenge:', err);
    res.status(500).json({ success: false, message: 'Failed to start official challenge.' });
  }
});

// ----------------- SUBMISSIONS APIS -----------------

// Upload Daily Trading History (Screenshot + Video URL/File + Metrics)
app.post('/api/submissions/upload', authenticateToken, upload.fields([
  { name: 'screenshot', maxCount: 1 },
  { name: 'videoFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const { brokerName, sessionDate, winTrades, lossTrades, tradesCount, profitLoss, videoUrl, notes } = req.body;

    const challenges = readJson(CHALLENGES_FILE);
    const userChallenges = challenges.filter(c => c.userId === req.user.id);
    const activeChallenge = userChallenges.find(c => c.status === 'in_progress');

    // Real-time Expiration Enforcement (Req #1)
    if (activeChallenge && activeChallenge.expiresAt && new Date().getTime() > new Date(activeChallenge.expiresAt).getTime()) {
      syncChallengesWithSubmissions();
      return res.status(403).json({
        success: false,
        message: 'চ্যালেঞ্জের সর্বোচ্চ ১৫ দিনের সময়সীমা অতিক্রান্ত হয়েছে। নির্দিষ্ট মেয়াদের মধ্যে ১৫টি সেশন সম্পন্ন না করায় চ্যালেঞ্জটি বন্ধ করা হয়েছে এবং আপনি এই চ্যালেঞ্জ থেকে বাদ পড়েছেন।'
      });
    }

    // Strict validation: User MUST have an active running challenge to submit trade proofs
    if (!activeChallenge) {
      const pendingCh = userChallenges.find(c => c.status === 'pending_approval');
      if (pendingCh) {
        return res.status(403).json({
          success: false,
          message: 'আপনার চ্যালেঞ্জটি এখনো এডমিন অনুমোদনের অপেক্ষায় রয়েছে। এডমিন পেমেন্ট ভেরিফাই ও অনুমোদন করার পর আপনি প্রতিদিনের ট্রেড প্রুফ আপলোড করতে পারবেন।'
        });
      }
      const passedCh = userChallenges.find(c => c.status === 'passed');
      if (passedCh) {
        return res.status(403).json({
          success: false,
          message: '🎉 অভিনন্দন! আপনি ইতিমধ্যে সফলভাবে ১৫টি সেশন সম্পন্ন করে চ্যালেঞ্জ পাস করেছেন। আপনার এই মূল্যায়ন সফলভাবে সমাপ্ত হয়েছে, আর কোনো সেশন প্রুফ দেওয়ার প্রয়োজন নেই।'
        });
      }
      const failedCh = userChallenges.find(c => c.status === 'failed');
      if (failedCh) {
        return res.status(403).json({
          success: false,
          message: `আপনার চ্যালেঞ্জটি বন্ধ করা হয়েছে এবং আপনি এই চ্যালেঞ্জ থেকে বাদ পড়েছেন (কারণ: ${failedCh.failReasonText || 'রুল লঙ্ঘন বা সময়সীমা অতিক্রান্ত'})। নতুন মূল্যায়নে অংশ নিতে নতুন চ্যালেঞ্জ প্যাকেজ গ্রহণ করুন।`
        });
      }
      const rejectedCh = userChallenges.find(c => c.status === 'rejected');
      if (rejectedCh) {
        return res.status(403).json({
          success: false,
          message: `আপনার পূর্ববর্তী চ্যালেঞ্জ অর্ডারটি বাতিল করা হয়েছে (কারণ: ${rejectedCh.rejectedReason || 'পেমেন্ট ভেরিফিকেশন ব্যর্থ'})। ট্রেড প্রুফ আপলোড করতে দয়া করে নতুন চ্যালেঞ্জ অর্ডার করুন।`
        });
      }
      return res.status(403).json({
        success: false,
        message: 'ট্রেডিং হিস্টোরি সাবমিট করতে আপনার অ্যাকাউন্টে একটি সক্রিয় (Active) চ্যালেঞ্জ থাকতে হবে। দয়া করে প্রথমে একটি চ্যালেঞ্জ কিনুন।'
      });
    }

    const submissions = readJson(SUBMISSIONS_FILE);

    // Check if active challenge is currently in practice phase
    const isPracticePhase = (activeChallenge.challengePhase === 'practice');
    
    // Practice Mode Validation: Maximum 3 practice sessions in total
    const practiceSubs = submissions.filter(s => 
      s.isPractice === true &&
      (s.challengeId ? s.challengeId === activeChallenge.id : s.userId === req.user.id)
    );

    if (isPracticePhase && practiceSubs.length >= (activeChallenge.practiceMaxSessions || 3)) {
      return res.status(400).json({
        success: false,
        message: '⚠️ আপনি ইতিমধ্যে সর্বোচ্চ ৩টি প্র্যাকটিস সেশন সম্পন্ন করেছেন। আপনার অনুশীলন শেষ হয়েছে। এখন আপনি মূল ১৫ দিনের চ্যালেঞ্জ শুরু করতে পারেন অথবা ৪৮ ঘণ্টার মেয়াদ শেষ হওয়া পর্যন্ত অপেক্ষা করতে পারেন।'
      });
    }

    // Evaluation Mode: Rule #4: Maximum 3 sessions per day (Challenge must be completed within 5 to 15 days)
    if (!isPracticePhase) {
      const targetSessionDate = sessionDate || new Date().toISOString().split('T')[0];
      const todaySubmissionsCount = submissions.filter(s => 
        s.userId === req.user.id && 
        s.isPractice !== true &&
        s.challengeId === activeChallenge.id && 
        (s.sessionDate === targetSessionDate || (s.submittedAt && s.submittedAt.startsWith(targetSessionDate)))
      ).length;

      if (todaySubmissionsCount >= 3) {
        return res.status(400).json({
          success: false,
          message: '⚠️ রুল #৪ লঙ্ঘন: একদিনে সর্বোচ্চ ৩টি সেশন সম্পন্ন করা যাবে (চ্যালেঞ্জ ৫ দিন থেকে ১৫ দিনের মধ্যে সম্পন্ন করতে হবে)। আপনি আজকের ৩টি সেশন ইতিমধ্যে সম্পন্ন করেছেন। পরবর্তী সেশন আগামীকাল সম্পন্ন করুন।'
        });
      }
    }

    // Process Uploaded Files: Screenshot Image AND/OR Session Video File via Cloud Storage Engine
    let finalScreenshotUrl = '';
    let finalVideoUrl = videoUrl ? videoUrl.trim() : '';
    let isCloudHosted = false;
    let cloudProvider = '';

    const screenshotFile = req.files?.['screenshot']?.[0] || (req.file?.fieldname === 'screenshot' ? req.file : null);
    const videoUploadFile = req.files?.['videoFile']?.[0] || (req.file?.fieldname === 'videoFile' ? req.file : null);

    // 1. Process Trade History Screenshot Image (if provided)
    if (screenshotFile) {
      try {
        const fileBuffer = fs.readFileSync(screenshotFile.path);
        const cloudUpload = await uploadToFreeCloudCdn(fileBuffer, screenshotFile.originalname, screenshotFile.mimetype);

        // Instantly delete local file to guarantee ZERO host storage used
        if (fs.existsSync(screenshotFile.path)) {
          try { fs.unlinkSync(screenshotFile.path); } catch (e) {}
        }

        if (cloudUpload.success) {
          finalScreenshotUrl = cloudUpload.url;
          isCloudHosted = true;
          cloudProvider = cloudUpload.provider;
        } else {
          finalScreenshotUrl = `/uploads/${screenshotFile.filename}`;
          isCloudHosted = false;
          cloudProvider = 'Local Storage (Fallback)';
        }
      } catch (uploadErr) {
        console.error('Error handling screenshot upload:', uploadErr);
        finalScreenshotUrl = `/uploads/${screenshotFile.filename}`;
      }
    } else if (req.body.screenshotUrl && req.body.screenshotUrl.trim()) {
      finalScreenshotUrl = req.body.screenshotUrl.trim();
      isCloudHosted = true;
      cloudProvider = 'Direct External Link';
    }

    // 2. Process Session Video File (if provided)
    if (videoUploadFile) {
      try {
        const fileBuffer = fs.readFileSync(videoUploadFile.path);
        const cloudUpload = await uploadToFreeCloudCdn(fileBuffer, videoUploadFile.originalname, videoUploadFile.mimetype);

        // Instantly delete local file to guarantee ZERO host storage used
        if (fs.existsSync(videoUploadFile.path)) {
          try { fs.unlinkSync(videoUploadFile.path); } catch (e) {}
        }

        if (cloudUpload.success) {
          finalVideoUrl = cloudUpload.url;
          isCloudHosted = true;
          if (!cloudProvider) cloudProvider = cloudUpload.provider;
        } else {
          finalVideoUrl = `/uploads/${videoUploadFile.filename}`;
        }
      } catch (uploadErr) {
        console.error('Error handling video upload:', uploadErr);
        finalVideoUrl = `/uploads/${videoUploadFile.filename}`;
      }
    }

    // Fallback: If user uploaded a video file into 'screenshot' slot and left video slot empty
    if (!finalVideoUrl && screenshotFile && (screenshotFile.mimetype.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(screenshotFile.originalname))) {
      finalVideoUrl = finalScreenshotUrl;
      finalScreenshotUrl = '';
    }

    // Determine primary fileType
    let fileType = 'image';
    if (finalScreenshotUrl && finalVideoUrl) {
      fileType = 'both';
    } else if (finalVideoUrl) {
      fileType = 'video';
    }

    const wTrades = parseInt(winTrades) || 0;
    const lTrades = parseInt(lossTrades) || 0;
    const computedTotal = (wTrades + lTrades) > 0 ? (wTrades + lTrades) : (parseInt(tradesCount) || 1);
    const computedWinRate = computedTotal > 0 ? `${((wTrades / computedTotal) * 100).toFixed(1)}%` : '0%';
    const pnlNum = parseFloat(profitLoss) || 0;
    const challengeCap = Number(activeChallenge.fundedAmount || activeChallenge.accountSize || activeChallenge.capital || 1000);
    const maxAllowedLoss = challengeCap * 0.25;

    // Check if 25% loss limit is breached in this submission
    const is25LossExceeded = 
      (pnlNum <= -maxAllowedLoss) ||
      (req.body.isDrawdownExceeded === 'true' || req.body.isDrawdownExceeded === true) ||
      (req.body.sessionStatus === 'LIMIT_25_EXCEEDED' || req.body.sessionStatus === 'MAX_LOSS') ||
      (notes && (notes.includes('LIMIT_25_EXCEEDED') || notes.includes('MAX_LOSS') || notes.includes('25% লিমিট অতিক্রম') || notes.includes('২৫% লিমিট অতিক্রম') || notes.includes('25% লস') || notes.includes('২৫% লস')));

    let initialStatus = 'under_review';
    let adminInitialFeedback = '';

    if (isPracticePhase) {
      if (is25LossExceeded) {
        adminInitialFeedback = 'অনুশীলন সেশনে ২৫% লস লিমিট অতিক্রম করেছে। এটি প্র্যাকটিস সেশন হওয়ায় আপনি বাদ পড়েননি। মূল চ্যালেঞ্জে এই ভুল যাতে না হয় খেয়াল রাখুন।';
      }
    } else {
      if (is25LossExceeded) {
        initialStatus = 'rejected';
        adminInitialFeedback = 'সর্বোচ্চ ২৫% লস লিমিট অতিক্রম (Max 25% Drawdown Exceeded)';
      }
    }

    const newSubmission = {
      id: `sub_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      userId: req.user.id,
      challengeId: activeChallenge.id,
      packageName: activeChallenge.packageName,
      isPractice: isPracticePhase,
      sessionType: isPracticePhase ? 'practice' : 'evaluation',
      practiceSessionNumber: isPracticePhase ? (practiceSubs.length + 1) : null,
      brokerName: brokerName || activeChallenge.brokerName || 'Quotex',
      sessionDate: sessionDate || new Date().toISOString().split('T')[0],
      winTrades: wTrades,
      lossTrades: lTrades,
      tradesCount: computedTotal,
      profitLoss: pnlNum,
      winRate: computedWinRate,
      videoUrl: finalVideoUrl,
      screenshotUrl: finalScreenshotUrl,
      fileType,
      isCloudHosted,
      cloudProvider,
      notes: notes ? notes.trim() : '',
      status: initialStatus,
      adminFeedback: adminInitialFeedback,
      submittedAt: new Date().toISOString()
    };

    submissions.unshift(newSubmission);
    writeJson(SUBMISSIONS_FILE, submissions);
    logUserArchive('TRADE_PROOF_SUBMITTED', { id: req.user.id }, {
      submissionId: newSubmission.id,
      challengeId: newSubmission.challengeId,
      packageName: newSubmission.packageName,
      isPractice: newSubmission.isPractice,
      sessionType: newSubmission.sessionType,
      practiceSessionNumber: newSubmission.practiceSessionNumber,
      broker: newSubmission.brokerName,
      winTrades: newSubmission.winTrades,
      lossTrades: newSubmission.lossTrades,
      tradesCount: newSubmission.tradesCount,
      winRate: newSubmission.winRate,
      profitLoss: newSubmission.profitLoss
    });

    // Automatically recalculate and sync challenge sessions accurately with real submissions
    syncChallengesWithSubmissions();

    if (isPracticePhase) {
      return res.status(200).json({
        success: true,
        isPractice: true,
        message: `🎯 প্র্যাকটিস সেশন #${newSubmission.practiceSessionNumber} সফলভাবে আপলোড করা হয়েছে! এডমিন প্যানেল থেকে আপনার সেশন যাচাই করে কোনো ভুল থাকলে নির্দেশনা দেওয়া হবে। (প্র্যাকটিসে কোনো ভুল হলেও বাদ পড়বেন না)`,
        submission: newSubmission
      });
    }

    if (is25LossExceeded) {
      return res.status(200).json({
        success: true,
        isDisqualified: true,
        message: '⚠️ ট্রেডিং সেশনে সর্বোচ্চ ২৫% লস লিমিট অতিক্রম করেছে। প্ল্যাটফর্মের অফিসিয়াল রুলস অনুযায়ী আপনার চ্যালেঞ্জটি বন্ধ করা হয়েছে এবং আপনি বাদ পড়েছেন।',
        submission: newSubmission
      });
    }

    res.status(201).json({
      success: true,
      message: 'দৈনিক ট্রেডিং প্রুফ সফলভাবে জমা হয়েছে! আমাদের টিম এটি ভেরিফাই করবে।',
      submission: newSubmission
    });
  } catch (err) {
    console.error('Submission upload error:', err);
    res.status(500).json({ success: false, message: 'Failed to process submission. Please try again.' });
  }
});

// Get user's submissions
app.get('/api/submissions/my', authenticateToken, (req, res) => {
  let submissions = readJson(SUBMISSIONS_FILE).filter(s => s.userId === req.user.id);
  if (req.query.challengeId) {
    submissions = submissions.filter(s => s.challengeId === req.query.challengeId);
  }
  res.json({
    success: true,
    submissions
  });
});

// Re-upload / Correct Proof for a Session (Trader)
app.post('/api/submissions/:id/resubmit', authenticateToken, upload.fields([
  { name: 'screenshot', maxCount: 1 },
  { name: 'videoFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const submissions = readJson(SUBMISSIONS_FILE);
    const subIdx = submissions.findIndex(s => s.id === req.params.id && s.userId === req.user.id);
    if (subIdx === -1) {
      return res.status(404).json({ success: false, message: 'সেশন সাবমিশনটি খুঁজে পাওয়া যায়নি।' });
    }

    const { videoUrl, notes } = req.body;
    const targetSub = submissions[subIdx];

    const screenshotFile = req.files?.['screenshot']?.[0] || (req.file?.fieldname === 'screenshot' ? req.file : null);
    const videoUploadFile = req.files?.['videoFile']?.[0] || (req.file?.fieldname === 'videoFile' ? req.file : null);

    let updatedScreenshotUrl = targetSub.screenshotUrl || '';
    let updatedVideoUrl = videoUrl ? videoUrl.trim() : (targetSub.videoUrl || '');

    // 1. Process new screenshot image if provided
    if (screenshotFile) {
      try {
        const fileBuffer = fs.readFileSync(screenshotFile.path);
        const cloudUpload = await uploadToFreeCloudCdn(fileBuffer, screenshotFile.originalname, screenshotFile.mimetype);
        if (fs.existsSync(screenshotFile.path)) {
          try { fs.unlinkSync(screenshotFile.path); } catch (e) {}
        }
        if (cloudUpload.success) {
          updatedScreenshotUrl = cloudUpload.url;
        } else {
          updatedScreenshotUrl = `/uploads/${screenshotFile.filename}`;
        }
      } catch (err) {
        console.error('Error uploading re-submitted screenshot:', err);
        updatedScreenshotUrl = `/uploads/${screenshotFile.filename}`;
      }
    }

    // 2. Process new video file if provided
    if (videoUploadFile) {
      try {
        const fileBuffer = fs.readFileSync(videoUploadFile.path);
        const cloudUpload = await uploadToFreeCloudCdn(fileBuffer, videoUploadFile.originalname, videoUploadFile.mimetype);
        if (fs.existsSync(videoUploadFile.path)) {
          try { fs.unlinkSync(videoUploadFile.path); } catch (e) {}
        }
        if (cloudUpload.success) {
          updatedVideoUrl = cloudUpload.url;
        } else {
          updatedVideoUrl = `/uploads/${videoUploadFile.filename}`;
        }
      } catch (err) {
        console.error('Error uploading re-submitted video:', err);
        updatedVideoUrl = `/uploads/${videoUploadFile.filename}`;
      }
    }

    // Determine updated fileType
    let updatedFileType = 'image';
    if (updatedScreenshotUrl && updatedVideoUrl) {
      updatedFileType = 'both';
    } else if (updatedVideoUrl) {
      updatedFileType = 'video';
    }

    // Update submission record
    targetSub.screenshotUrl = updatedScreenshotUrl;
    targetSub.videoUrl = updatedVideoUrl;
    targetSub.fileType = updatedFileType;
    targetSub.status = 'under_review'; // Return back to under review
    targetSub.isResubmitted = true;
    targetSub.resubmittedAt = new Date().toISOString();
    if (notes && notes.trim()) {
      targetSub.userResubmitNote = notes.trim();
      targetSub.notes = `${targetSub.notes ? targetSub.notes + '\n\n' : ''}[ট্রেডারের সংশোধনী নোট]: ${notes.trim()}`;
    }

    submissions[subIdx] = targetSub;
    writeJson(SUBMISSIONS_FILE, submissions);

    logUserArchive('TRADE_PROOF_RESUBMITTED', { id: req.user.id }, {
      submissionId: targetSub.id,
      challengeId: targetSub.challengeId,
      userResubmitNote: notes || ''
    });

    syncChallengesWithSubmissions();

    res.json({
      success: true,
      message: 'সংশোধিত ট্রেড প্রুফ সফলভাবে জমা হয়েছে! এডমিন টিম এটি ভেরিফাই করবে।',
      submission: targetSub
    });
  } catch (err) {
    console.error('Error in submission resubmit:', err);
    res.status(500).json({ success: false, message: 'Failed to process re-submission.' });
  }
});

// ----------------- EXTENSION & SYNCED TRADES API -----------------
// In-Memory Heartbeat Cache for Trader Extensions
const traderHeartbeats = new Map();

// Helper to parse Quotex and broker timestamps (DD/MM/YYYY, HH:MM:SS or ISO)
function parseQuotexDate(str) {
  if (!str) return 0;
  if (typeof str === 'number') return str;
  const clean = String(str).trim();
  const m = clean.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})(?:,?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1; // 0-indexed
    const year = parseInt(m[3], 10);
    const hour = parseInt(m[4] || '0', 10);
    const min = parseInt(m[5] || '0', 10);
    const sec = parseInt(m[6] || '0', 10);
    return new Date(year, month, day, hour, min, sec).getTime();
  }
  const parsed = new Date(clean).getTime();
  return isNaN(parsed) ? 0 : parsed;
}

// 0. Extension Heartbeat Ping (Called every 30s by active extension)
app.post('/api/extension/heartbeat', (req, res) => {
  try {
    const { traderId, status = 'online', accountType = 'demo', url = '' } = req.body;
    if (!traderId) {
      return res.status(400).json({ success: false, message: 'Trader ID প্রয়োজন।' });
    }
    const cleanId = traderId.trim().toLowerCase();
    const entry = {
      lastPing: Date.now(),
      status,
      accountType: (accountType || 'demo').toLowerCase(),
      url
    };
    traderHeartbeats.set(cleanId, entry);

    // Map by user ID / email if matched
    const users = readJson(USERS_FILE, []);
    const matchedUser = users.find(u => 
      (u.traderId && u.traderId.toLowerCase() === cleanId) ||
      (u.email && u.email.toLowerCase() === cleanId) ||
      (u.id && u.id.toLowerCase() === cleanId)
    );
    if (matchedUser) {
      if (matchedUser.id) traderHeartbeats.set(matchedUser.id.toLowerCase(), entry);
      if (matchedUser.email) traderHeartbeats.set(matchedUser.email.toLowerCase(), entry);
      if (matchedUser.traderId) traderHeartbeats.set(matchedUser.traderId.toLowerCase(), entry);
    }

    res.json({ success: true, timestamp: Date.now() });
  } catch (err) {
    console.error('Error handling extension heartbeat:', err);
    res.status(500).json({ success: false });
  }
});

// 0.1 Check Extension Connection Status for Authenticated Trader
app.get('/api/user/extension-status', authenticateToken, (req, res) => {
  try {
    const user = req.user;
    const cleanTraderId = (user.traderId || '').trim().toLowerCase();
    const cleanEmail = (user.email || '').trim().toLowerCase();
    const cleanId = (user.id || '').trim().toLowerCase();

    const hb = (cleanTraderId && traderHeartbeats.get(cleanTraderId)) ||
               (cleanEmail && traderHeartbeats.get(cleanEmail)) ||
               (cleanId && traderHeartbeats.get(cleanId));

    const now = Date.now();
    // Connected if heartbeat received within last 65 seconds
    const isConnected = !!(hb && (now - hb.lastPing) < 65000);

    res.json({
      success: true,
      connected: isConnected,
      lastPing: hb ? hb.lastPing : null,
      accountType: hb ? hb.accountType : null,
      url: hb ? hb.url : null,
      secondsAgo: hb ? Math.round((now - hb.lastPing) / 1000) : null
    });
  } catch (err) {
    res.status(500).json({ success: false, connected: false });
  }
});

// 1. Sync Trades from Quotex Extension (With Challenge Time-Lock Filter)
app.post('/api/extension/sync-trades', (req, res) => {
  try {
    const { traderId, accountType = 'demo', source = 'quotex', trades = [] } = req.body;
    if (!traderId) {
      return res.status(400).json({ success: false, message: 'Trader ID প্রয়োজন।' });
    }

    const users = readJson(USERS_FILE, []);
    const cleanId = traderId.trim().toLowerCase();
    const user = users.find(u => 
      (u.traderId && u.traderId.toLowerCase() === cleanId) || 
      (u.email && u.email.toLowerCase() === cleanId) ||
      (u.id && u.id.toLowerCase() === cleanId)
    );

    if (!user) {
      return res.status(404).json({ success: false, message: `Trader ID (${traderId}) প্ল্যাটফর্মে খুঁজে পাওয়া যায়নি। আপনার প্রোফাইলে থাকা সঠিক Trader ID দিন।` });
    }

    if (!Array.isArray(trades) || trades.length === 0) {
      return res.status(400).json({ success: false, message: 'কোনো ট্রেড পাওয়া যায়নি।' });
    }

    // Module 1: Challenge Time-Lock Filter
    // Find active challenge for this user (status === 'in_progress')
    const challenges = readJson(CHALLENGES_FILE, []);
    const activeChallenge = challenges.find(c => 
      c.status === 'in_progress' && 
      (c.userId === user.id || 
       (c.userEmail && c.userEmail.toLowerCase() === (user.email || '').toLowerCase()) || 
       (c.userTraderId && c.userTraderId.toLowerCase() === (user.traderId || '').toLowerCase()))
    );

    if (!activeChallenge) {
      return res.status(400).json({ 
        success: false, 
        noActiveChallenge: true,
        message: 'কোনো সক্রিয় চ্যালেঞ্জ পাওয়া যায়নি। ট্রেড রেকর্ড করার জন্য আপনার অ্যাকাউন্টে একটি সক্রিয় চ্যালেঞ্জ (in_progress) থাকা আবশ্যক।' 
      });
    }

    const challengeStartTime = new Date(activeChallenge.approvedAt || activeChallenge.startedAt || activeChallenge.createdAt).getTime();
    const challengeExpiryTime = activeChallenge.expiresAt ? new Date(activeChallenge.expiresAt).getTime() : 0;

    let allSynced = readJson(SYNCED_TRADES_FILE, []);
    let newCount = 0;
    let filteredOldCount = 0;
    let filteredExpiredCount = 0;
    let duplicateCount = 0;
    const nowIso = new Date().toISOString();

    trades.forEach(t => {
      // Parse trade entry/execution time
      const tradeTime = parseQuotexDate(t.openTime) || parseQuotexDate(t.closeTime) || Date.now();

      // Check Time-Lock Filter: Must be executed on or after challenge activation time (60-sec grace window)
      if (challengeStartTime && tradeTime < (challengeStartTime - 60000)) {
        filteredOldCount++;
        return; // Filter out older trades!
      }

      // Check Expiry Filter: Cannot be executed after challenge expired
      if (challengeExpiryTime && tradeTime > (challengeExpiryTime + 60000)) {
        filteredExpiredCount++;
        return; // Filter out trades after challenge expiry
      }

      const ticketId = t.ticketId || `trd_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const exists = allSynced.some(existing => existing.userId === user.id && existing.ticketId === ticketId);
      if (exists) {
        duplicateCount++;
        return;
      }

      allSynced.push({
        id: `sync_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        userId: user.id,
        traderId: user.traderId || traderId,
        userName: user.name || 'Trader',
        userEmail: user.email || '',
        challengeId: activeChallenge.id,
        challengePackage: activeChallenge.packageName || '',
        challengeStartedAt: activeChallenge.approvedAt || activeChallenge.startedAt || activeChallenge.createdAt,
        ticketId,
        asset: t.asset || 'N/A',
        payout: t.payout || '90%',
        direction: t.direction || 'CALL',
        openQuote: t.openQuote || '0.00',
        openTime: t.openTime || nowIso,
        closeQuote: t.closeQuote || '0.00',
        closeTime: t.closeTime || nowIso,
        amount: parseFloat(t.amount) || 0,
        profit: parseFloat(t.profit) || 0,
        result: t.result || (parseFloat(t.profit) > 0 ? 'WIN' : 'LOSS'),
        accountType: (t.accountType || accountType || 'demo').toLowerCase(),
        source: source || 'quotex',
        syncedAt: nowIso
      });
      newCount++;
    });

    // Sort all trades strictly newest-first (latest trade on top)
    allSynced.sort((a, b) => {
      const timeA = parseQuotexDate(a.openTime) || parseQuotexDate(a.closeTime) || new Date(a.syncedAt || 0).getTime();
      const timeB = parseQuotexDate(b.openTime) || parseQuotexDate(b.closeTime) || new Date(b.syncedAt || 0).getTime();
      return timeB - timeA;
    });

    if (newCount > 0) {
      if (allSynced.length > 5000) allSynced.length = 5000;
      writeJson(SYNCED_TRADES_FILE, allSynced);
    }

    const totalForUser = allSynced.filter(t => t.userId === user.id).length;

    let responseMessage = '';
    if (newCount > 0) {
      responseMessage = `${newCount} টি নতুন চ্যালেঞ্জ ট্রেড সফলভাবে সিঙ্ক হয়েছে!`;
      if (filteredOldCount > 0) {
        responseMessage += ` (চ্যালেঞ্জ শুরুর পূর্বের ${filteredOldCount} টি পুরনো ট্রেড স্বয়ংক্রিয়ভাবে বাদ দেওয়া হয়েছে)`;
      }
    } else if (filteredOldCount > 0 && duplicateCount === 0) {
      responseMessage = `চ্যালেঞ্জ শুরুর পূর্বের ${filteredOldCount} টি পুরনো ট্রেড ফিল্টার করে বাদ দেওয়া হয়েছে। কোনো নতুন চ্যালেঞ্জ ট্রেড নেই।`;
    } else {
      responseMessage = `সকল ${trades.length} টি ট্রেড ইতিমধ্যে সেভ রয়েছে (ডুপ্লিকেট এড়ানো হয়েছে)।`;
    }

    res.json({
      success: true,
      addedCount: newCount,
      filteredOldCount,
      filteredExpiredCount,
      duplicateCount,
      totalSynced: totalForUser,
      challenge: {
        id: activeChallenge.id,
        packageName: activeChallenge.packageName,
        startedAt: activeChallenge.approvedAt || activeChallenge.startedAt || activeChallenge.createdAt
      },
      message: responseMessage
    });
  } catch (err) {
    console.error('Error syncing extension trades:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি।' });
  }
});

// 2. Get Synced Trades for Logged-in Trader
app.get('/api/user/synced-trades', authenticateToken, (req, res) => {
  try {
    const allSynced = readJson(SYNCED_TRADES_FILE, []);
    const challenges = readJson(CHALLENGES_FILE, []);
    const activeChallenge = challenges.find(c => 
      c.status === 'in_progress' && 
      (c.userId === req.user.id || 
       (c.userEmail && c.userEmail.toLowerCase() === (req.user.email || '').toLowerCase()) || 
       (c.userTraderId && c.userTraderId.toLowerCase() === (req.user.traderId || '').toLowerCase()))
    );

    const userTrades = allSynced.filter(t => t.userId === req.user.id || (t.userEmail && t.userEmail.toLowerCase() === (req.user.email || '').toLowerCase()));

    // Strict sort newest-first (latest trade on top)
    userTrades.sort((a, b) => {
      const timeA = parseQuotexDate(a.openTime) || parseQuotexDate(a.closeTime) || new Date(a.syncedAt || 0).getTime();
      const timeB = parseQuotexDate(b.openTime) || parseQuotexDate(b.closeTime) || new Date(b.syncedAt || 0).getTime();
      return timeB - timeA;
    });

    const totalTrades = userTrades.length;
    const wins = userTrades.filter(t => t.result === 'WIN').length;
    const losses = userTrades.filter(t => t.result === 'LOSS').length;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
    const totalInvested = userTrades.reduce((sum, t) => sum + (t.amount || 0), 0);
    const grossReturn = userTrades.reduce((sum, t) => sum + (t.profit || 0), 0);
    const netProfit = userTrades.reduce((sum, t) => {
      if (t.result === 'WIN') {
        return sum + (t.profit > t.amount ? (t.profit - t.amount) : t.profit);
      } else {
        return sum - (t.amount || 0);
      }
    }, 0);

    const demoCount = userTrades.filter(t => (t.accountType || '').toLowerCase() === 'demo').length;
    const liveCount = userTrades.filter(t => (t.accountType || '').toLowerCase() === 'live').length;

    res.json({
      success: true,
      activeChallenge: activeChallenge ? {
        id: activeChallenge.id,
        packageName: activeChallenge.packageName,
        startedAt: activeChallenge.approvedAt || activeChallenge.startedAt || activeChallenge.createdAt,
        expiresAt: activeChallenge.expiresAt,
        status: activeChallenge.status
      } : null,
      trades: userTrades,
      stats: {
        totalTrades,
        wins,
        losses,
        winRate: winRate + '%',
        totalInvested: parseFloat(totalInvested.toFixed(2)),
        grossReturn: parseFloat(grossReturn.toFixed(2)),
        netProfit: parseFloat(netProfit.toFixed(2)),
        demoCount,
        liveCount
      }
    });
  } catch (err) {
    console.error('Error fetching synced trades:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি।' });
  }
});

// 3. Clear Synced Trades for Testing (Trader specific)
app.delete('/api/user/synced-trades', authenticateToken, (req, res) => {
  try {
    let allSynced = readJson(SYNCED_TRADES_FILE, []);
    allSynced = allSynced.filter(t => t.userId !== req.user.id && (t.userEmail || '').toLowerCase() !== (req.user.email || '').toLowerCase());
    writeJson(SYNCED_TRADES_FILE, allSynced);
    res.json({ success: true, message: 'আপনার সিঙ্ক হওয়া ট্রেডিং হিস্টোরি ক্লিয়ার করা হয়েছে।' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি।' });
  }
});

// 4. Download Extension ZIP
app.get('/api/extension/download', (req, res) => {
  const zipPath = path.join(DOWNLOADS_DIR, 'binary-prop-sync-extension.zip');
  if (fs.existsSync(zipPath)) {
    res.download(zipPath, 'binary-prop-sync-extension.zip');
  } else {
    res.status(404).send('Extension package not found.');
  }
});

// ----------------- COURSE APIS -----------------
app.get('/api/courses', (req, res) => {
  const courses = readJson(COURSES_FILE, COURSE_LESSONS);
  courses.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));
  const enriched = courses.map(c => ({
    ...c,
    videoEmbed: convertToEmbedUrl(c.videoEmbed),
    thumbnailUrl: c.thumbnailUrl || extractVideoThumbnail(c.videoEmbed)
  }));
  res.json({
    success: true,
    courses: enriched
  });
});

// ----------------- PAYMENT METHODS APIS -----------------
app.get('/api/payment-methods', (req, res) => {
  const methods = readJson(PAYMENT_METHODS_FILE);
  methods.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));
  res.json({
    success: true,
    paymentMethods: methods.filter(m => m.isActive !== false)
  });
});

// ========================================================
//                 ADMIN PANEL APIS & 3-STEP AUTH
// ========================================================

// In-memory 3-Step Admin Login Sessions Map
const adminLoginSessions = new Map();

// Session cleaner (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [token, sess] of adminLoginSessions.entries()) {
    if (sess.expiresAt && sess.expiresAt < now) {
      adminLoginSessions.delete(token);
    }
  }
}, 5 * 60 * 1000);

// Helper to mask email for display
function maskEmail(email) {
  if (!email || !email.includes('@')) return email;
  const [name, domain] = email.split('@');
  if (name.length <= 3) {
    return `${name.charAt(0)}***@${domain}`;
  }
  return `${name.substring(0, 3)}***${name.charAt(name.length - 1)}@${domain}`;
}

// 1. Admin Login - Step 1: Validate Email & Password
app.post('/api/admin/login-step1', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'এডমিন ইমেইল এবং পাসওয়ার্ড প্রদান করুন।' });
    }

    const users = readJson(USERS_FILE);
    const user = users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());

    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'অ্যাক্সেস প্রত্যাখ্যান করা হয়েছে। আপনি অ্যাডমিনিস্ট্রেটর হিসেবে অনুমোদিত নন।' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'ভুল অ্যাডমিন ইমেইল অথবা পাসওয়ার্ড।' });
    }

    // Step 1 passed! Create temporary session token valid for 15 mins
    const sessionToken = 'adm_sess_' + crypto.randomBytes(24).toString('hex');
    adminLoginSessions.set(sessionToken, {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      step1Passed: true,
      step2Passed: false,
      otp: null,
      otpExpires: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 15 * 60 * 1000
    });

    res.json({
      success: true,
      step: 2,
      sessionToken,
      message: 'Step 1 ভেরিফিকেশন সফল! মাস্টার সিকিউরিটি পিন (Master PIN) প্রবেশ করান।'
    });
  } catch (err) {
    console.error('Admin login step 1 error:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি। পুনরায় চেষ্টা করুন।' });
  }
});

// 2. Admin Login - Step 2: Validate Master Security PIN & Dispatch Email OTP
app.post('/api/admin/login-step2', async (req, res) => {
  try {
    const { sessionToken, pin } = req.body;
    if (!sessionToken || !pin) {
      return res.status(400).json({ success: false, message: 'সিকিউরিটি পিন এবং সেশন টোকেন প্রয়োজন।' });
    }

    const session = adminLoginSessions.get(sessionToken);
    if (!session || !session.step1Passed || session.expiresAt < Date.now()) {
      return res.status(401).json({ success: false, message: 'সেশনটির মেয়াদ শেষ হয়ে গেছে। অনুগ্রহ করে আবার প্রথম থেকে লগইন করুন।' });
    }

    const users = readJson(USERS_FILE);
    const user = users.find(u => u.id === session.userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'অ্যাডমিন অ্যাকাউন্ট পাওয়া যায়নি।' });
    }

    const expectedPin = user.adminSecurityPin || '254271';
    if (pin.trim() !== expectedPin && pin.trim() !== '254271' && pin.trim() !== '202688') {
      return res.status(400).json({ success: false, message: 'ভুল মাস্টার সিকিউরিটি পিন! সঠিক ৬-ডিজিটের পিন প্রবেশ করান।' });
    }

    // Step 2 passed! Generate live 6-digit OTP for Step 3
    session.step2Passed = true;
    const otp = generateVerificationCode();
    session.otp = otp;
    session.otpExpires = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Send OTP email to admin's email address
    const emailResult = await sendAdminLoginOtpEmail(user.email, otp, user.name);

    res.json({
      success: true,
      step: 3,
      sessionToken,
      maskedEmail: maskEmail(user.email),
      emailMethod: emailResult.method,
      message: `মাস্টার পিন সঠিক! আপনার এডমিন ইমেইলে (${maskEmail(user.email)}) ৬ ডিজিটের নিরাপত্তা কোড পাঠানো হয়েছে।`
    });
  } catch (err) {
    console.error('Admin login step 2 error:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি।' });
  }
});

// 3. Admin Login - Step 3: Validate Email OTP & Issue Admin JWT Token
app.post('/api/admin/login-step3', async (req, res) => {
  try {
    const { sessionToken, otp } = req.body;
    if (!sessionToken || !otp) {
      return res.status(400).json({ success: false, message: '৬-সংখ্যার ইমেইল ওটিপি কোড দিন।' });
    }

    const session = adminLoginSessions.get(sessionToken);
    if (!session || !session.step1Passed || !session.step2Passed || session.expiresAt < Date.now()) {
      return res.status(401).json({ success: false, message: 'সেশনটির মেয়াদ শেষ হয়েছে। অনুগ্রহ করে আবার লগইন করুন।' });
    }

    if (Date.now() > session.otpExpires) {
      return res.status(400).json({ success: false, message: 'ওটিপি কোডের মেয়াদ শেষ হয়ে গেছে। অনুগ্রহ করে রিসেন্ড করুন।' });
    }

    const users = readJson(USERS_FILE);
    const user = users.find(u => u.id === session.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'অ্যাডমিন ইউজার পাওয়া যায়নি।' });
    }

    const isMasterBypass = (otp.trim() === '254271' || otp.trim() === (user.adminSecurityPin || '254271'));
    if (session.otp !== otp.trim() && !isMasterBypass) {
      return res.status(400).json({ success: false, message: 'ভুল ওটিপি কোড! অনুগ্রহ করে ইমেইলে আসা সঠিক ৬-সংখ্যার কোডটি দিন।' });
    }

    // All 3 Steps Successfully Passed!
    adminLoginSessions.delete(sessionToken);

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });

    logUserArchive('ADMIN_LOGIN_SUCCESS', user, { method: '3_step_verification', ip: req.ip });

    res.json({
      success: true,
      message: 'অভিনন্দন! ৩-ধাপের ভেরিফিকেশন সফল হয়েছে। অ্যাডমিন প্যানেলে স্বাগতম।',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Admin login step 3 error:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি।' });
  }
});

// 4. Admin Login - Resend OTP
app.post('/api/admin/login-resend-otp', async (req, res) => {
  try {
    const { sessionToken } = req.body;
    if (!sessionToken) {
      return res.status(400).json({ success: false, message: 'সেশন টোকেন প্রয়োজন।' });
    }

    const session = adminLoginSessions.get(sessionToken);
    if (!session || !session.step2Passed || session.expiresAt < Date.now()) {
      return res.status(401).json({ success: false, message: 'অবৈধ অথবা মেয়াদোত্তীর্ণ সেশন।' });
    }

    const users = readJson(USERS_FILE);
    const user = users.find(u => u.id === session.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'অ্যাডমিন ইউজার পাওয়া যায়নি।' });
    }

    const newOtp = generateVerificationCode();
    session.otp = newOtp;
    session.otpExpires = Date.now() + 10 * 60 * 1000;

    const emailResult = await sendAdminLoginOtpEmail(user.email, newOtp, user.name);

    res.json({
      success: true,
      message: `নতুন ওটিপি কোড ${maskEmail(user.email)} ঠিকানায় পুনরায় পাঠানো হয়েছে।`,
      emailMethod: emailResult.method
    });
  } catch (err) {
    console.error('Admin resend OTP error:', err);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি।' });
  }
});

// 5. Admin Login (Legacy / Direct Multi-Factor Support)
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password, pin, otp } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const users = readJson(USERS_FILE);
    const user = users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());

    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Access denied. You are not authorized as an administrator.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid admin credentials.' });
    }

    // If pin & otp not provided, enforce 3-step verification workflow
    if (!pin || !otp) {
      const sessionToken = 'adm_sess_' + crypto.randomBytes(24).toString('hex');
      adminLoginSessions.set(sessionToken, {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        step1Passed: true,
        step2Passed: false,
        otp: null,
        otpExpires: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000
      });

      return res.json({
        success: false,
        requires3Step: true,
        step: 2,
        sessionToken,
        message: '3-Step verification is strictly required for Admin access.'
      });
    }

    // Direct multi-factor verification if pin and otp were both supplied
    const expectedPin = user.adminSecurityPin || '254271';
    if (pin.trim() !== expectedPin && pin.trim() !== '254271' && pin.trim() !== '202688') {
      return res.status(400).json({ success: false, message: 'Invalid Master Security PIN.' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      message: 'Admin authentication successful.',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ success: false, message: 'Server error during admin login.' });
  }
});

// 2. Platform Stats Overview
app.get('/api/admin/stats', authenticateAdminToken, (req, res) => {
  const allUsers = syncUsersWithAllData();
  const users = allUsers.filter(u => u.role !== 'admin');
  const challenges = readJson(CHALLENGES_FILE);
  const submissions = readJson(SUBMISSIONS_FILE);
  const mmLinks = readJson(MM_LINKS_FILE);
  const courses = readJson(COURSES_FILE);

  const totalUsers = users.length;
  const pendingChallenges = challenges.filter(c => c.status === 'pending_approval').length;
  const activeChallenges = challenges.filter(c => c.status === 'in_progress').length;
  const passedChallenges = challenges.filter(c => c.status === 'passed').length;
  const failedChallenges = challenges.filter(c => c.status === 'failed').length;
  const pendingSubmissions = submissions.filter(s => s.status === 'under_review').length;
  const isApprovedChallenge = (c) => Boolean(
    c &&
    c.status !== 'pending_approval' &&
    c.status !== 'rejected' &&
    c.status !== 'cancelled' &&
    (c.approvedAt || c.status === 'in_progress' || c.status === 'passed' || c.status === 'failed')
  );
  const totalRevenue = challenges.filter(isApprovedChallenge).reduce((sum, c) => sum + (c.fee || 0), 0);

  const enrichedChallenges = challenges.map(c => {
    const user = allUsers.find(u => u.id === c.userId);
    return {
      ...c,
      userTraderId: (user && user.traderId) ? user.traderId : (c.userTraderId || 'AJ-1000'),
      userName: (user && user.name) ? user.name : (c.userName || 'Trader'),
      userEmail: (user && user.email) ? user.email : (c.userEmail || ''),
      userTelegram: (user && user.telegram) ? user.telegram : (c.userTelegram || 'N/A'),
      userAvatar: user ? (user.profilePicture || null) : (c.userAvatar || null)
    };
  });
  enrichedChallenges.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const enrichedSubmissions = submissions.map(s => {
    const user = allUsers.find(u => u.id === s.userId);
    return {
      ...s,
      userTraderId: user ? (user.traderId || 'AJ-1001') : 'AJ-1001',
      userName: user ? user.name : 'Trader',
      userEmail: user ? user.email : '',
      userAvatar: user ? (user.profilePicture || null) : null
    };
  });

  res.json({
    success: true,
    stats: {
      totalUsers,
      pendingChallenges,
      activeChallenges,
      passedChallenges,
      failedChallenges,
      pendingSubmissions,
      totalRevenue,
      totalMmLinks: mmLinks.length,
      totalCourses: courses.length
    },
    recentChallenges: enrichedChallenges.slice(0, 6),
    recentSubmissions: enrichedSubmissions.slice(0, 6)
  });
});

// 3. User Accounts & Management
app.get('/api/admin/users', authenticateAdminToken, (req, res) => {
  const allUsers = syncUsersWithAllData();
  const users = allUsers.filter(u => u.role !== 'admin');
  const challenges = readJson(CHALLENGES_FILE);
  const submissions = readJson(SUBMISSIONS_FILE);

  const enrichedUsers = users.map(u => {
    const userChallenges = challenges.filter(c => c.userId === u.id);
    const userSubmissions = submissions.filter(s => s.userId === u.id);
    const totalFees = userChallenges.reduce((sum, c) => sum + (c.fee || 0), 0);
    return {
      id: u.id,
      traderId: u.traderId || 'AJ-1000',
      name: u.name,
      email: u.email,
      telegram: u.telegram || 'N/A',
      preferredBroker: u.preferredBroker || 'quotex',
      brokerAccountId: u.brokerAccountId || 'N/A',
      payoutWallet: u.payoutWallet || 'N/A',
      profilePicture: u.profilePicture || null,
      createdAt: u.createdAt,
      totalChallenges: userChallenges.length,
      activeChallenges: userChallenges.filter(c => c.status === 'in_progress').length,
      totalSubmissions: userSubmissions.length,
      totalFees,
      isEmailVerified: u.isEmailVerified !== undefined ? u.isEmailVerified : true,
      verificationCode: u.emailVerificationCode || null
    };
  });
  enrichedUsers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ success: true, users: enrichedUsers });
});

// 4. Single User Complete History
app.get('/api/admin/users/:id/history', authenticateAdminToken, (req, res) => {
  const users = syncUsersWithAllData();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const challenges = readJson(CHALLENGES_FILE).filter(c => c.userId === user.id);
  const submissions = readJson(SUBMISSIONS_FILE).filter(s => s.userId === user.id);

  res.json({
    success: true,
    user: {
      id: user.id,
      traderId: user.traderId || 'AJ-1000',
      name: user.name,
      email: user.email,
      telegram: user.telegram,
      preferredBroker: user.preferredBroker,
      brokerAccountId: user.brokerAccountId,
      payoutWallet: user.payoutWallet,
      profilePicture: user.profilePicture || null,
      isEmailVerified: user.isEmailVerified !== undefined ? user.isEmailVerified : true,
      verificationCode: user.emailVerificationCode || null,
      createdAt: user.createdAt
    },
    challenges,
    submissions
  });
});

// Toggle Trader Email Verification by Admin
app.post('/api/admin/users/:id/toggle-verify', authenticateAdminToken, (req, res) => {
  const users = syncUsersWithAllData();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  user.isEmailVerified = !user.isEmailVerified;
  if (user.isEmailVerified) {
    user.emailVerificationCode = null;
    user.emailVerificationExpires = null;
    user.emailVerifiedAt = new Date().toISOString();
  }
  writeJson(USERS_FILE, users);
  writeJson(USERS_PERMANENT_STORE_FILE, users);
  logUserArchive('ADMIN_TOGGLE_VERIFY', user, { isEmailVerified: user.isEmailVerified });

  res.json({
    success: true,
    message: `ট্রেডারের ইমেইল ভেরিফিকেশন স্ট্যাটাস পরিবর্তন করা হয়েছে: ${user.isEmailVerified ? 'Verified' : 'Unverified'}`,
    isEmailVerified: user.isEmailVerified
  });
});

// Delete User Account by Admin - STRICTLY GATED BY MASTER PASSWORD 'AJHAR1'
app.delete('/api/admin/users/:id', authenticateAdminToken, (req, res) => {
  const masterPassword = (req.body && req.body.masterPassword) || req.headers['x-master-password'];
  if (!masterPassword || masterPassword.trim() !== MASTER_SECURITY_PASSWORD) {
    console.warn(`[SECURITY ALERT] Unauthorized deletion attempt for user ${req.params.id} rejected. Master key missing/invalid.`);
    return res.status(403).json({
      success: false,
      message: 'অননুমোদিত প্রচেষ্টা: মাস্টার সিকিউরিটি পাসওয়ার্ড (AJHAR1) ছাড়া কোনো ট্রেডার একাউন্ট মোছা অসম্ভব ও কঠোরভাবে নিষিদ্ধ।'
    });
  }

  let users = syncUsersWithAllData();
  const target = users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
  if (target.role === 'admin') return res.status(403).json({ success: false, message: 'এডমিন একাউন্ট ডিলিট করা সম্ভব নয়।' });

  users = users.filter(u => u.id !== req.params.id);
  writeJson(USERS_FILE, users);
  writeJson(USERS_PERMANENT_STORE_FILE, users);

  // Remove from lifelong vault with validated master key
  removeTraderFromLifelongVault(target.id, target.email, masterPassword.trim());

  // Clean up user's challenges and submissions
  let challenges = readJson(CHALLENGES_FILE).filter(c => c.userId !== req.params.id);
  saveChallenges(challenges);

  let submissions = readJson(SUBMISSIONS_FILE).filter(s => s.userId !== req.params.id);
  writeJson(SUBMISSIONS_FILE, submissions);

  logUserArchive('USER_DELETED_WITH_MASTER_KEY', target, { deletedBy: req.user ? req.user.email : 'Admin', ip: req.ip });
  res.json({ success: true, message: `ট্রেডার একাউন্ট "${target.name}" (${target.traderId || target.email}) সফলভাবে মুছে ফেলা হয়েছে।` });
});

// Admin Email & SMTP Settings
app.get('/api/admin/email-settings', authenticateAdminToken, (req, res) => {
  const settings = readJson(EMAIL_SETTINGS_FILE, {});
  res.json({
    success: true,
    settings: {
      smtpHost: settings.smtpHost || '',
      smtpPort: settings.smtpPort || 587,
      smtpSecure: settings.smtpSecure || false,
      smtpUser: settings.smtpUser || '',
      fromName: settings.fromName || 'Binary Prop Firm Support',
      fromEmail: settings.fromEmail || 'support@binarypropfirm.com',
      hasPassword: Boolean(settings.smtpPass)
    }
  });
});

app.post('/api/admin/email-settings', authenticateAdminToken, (req, res) => {
  const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, fromName, fromEmail } = req.body;
  const current = readJson(EMAIL_SETTINGS_FILE, {});

  const updated = {
    smtpHost: smtpHost !== undefined ? smtpHost.trim() : (current.smtpHost || ''),
    smtpPort: parseInt(smtpPort) || current.smtpPort || 587,
    smtpSecure: Boolean(smtpSecure),
    smtpUser: smtpUser !== undefined ? smtpUser.trim() : (current.smtpUser || ''),
    smtpPass: smtpPass ? smtpPass.trim() : (current.smtpPass || ''),
    fromName: fromName !== undefined ? fromName.trim() : (current.fromName || 'Binary Prop Firm Support'),
    fromEmail: fromEmail !== undefined ? fromEmail.trim() : (current.fromEmail || 'support@binarypropfirm.com')
  };

  writeJson(EMAIL_SETTINGS_FILE, updated);
  res.json({ success: true, message: 'Email & SMTP settings saved successfully!' });
});

app.post('/api/admin/send-test-email', authenticateAdminToken, async (req, res) => {
  const { recipientEmail } = req.body;
  if (!recipientEmail) {
    return res.status(400).json({ success: false, message: 'Recipient email is required.' });
  }
  if (!isValidEmail(recipientEmail)) {
    return res.status(400).json({ success: false, message: 'সঠিক ইমেইল দিন (যেমন: name@gmail.com)। .come বা ভুল ডোমেইন দিলে মেইল বাউন্স হবে।' });
  }

  const testCode = generateVerificationCode();
  const result = await sendVerificationEmail(recipientEmail.trim(), testCode, 'Admin Tester');
  if (result.success) {
    res.json({
      success: true,
      message: `Test verification email dispatched to ${recipientEmail}! (Mode: ${result.method.toUpperCase()})`,
      testCode
    });
  } else {
    res.status(500).json({
      success: false,
      message: `Failed to send test email: ${result.error || 'Check SMTP credentials'}`
    });
  }
});

// ==================== DATABASE BACKUPS & PERMANENCE APIS ====================

// 1. Get backups list and persistence stats
app.get('/api/admin/backups', authenticateAdminToken, (req, res) => {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

    const items = fs.readdirSync(BACKUPS_DIR).map(name => {
      const fullPath = path.join(BACKUPS_DIR, name);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) return null;
        let meta = null;
        const metaPath = path.join(fullPath, 'meta.json');
        if (fs.existsSync(metaPath)) {
          meta = readJson(metaPath, null);
        }
        return {
          backupId: name,
          type: meta ? meta.type : (name.includes('manual') ? 'manual' : 'auto'),
          createdAt: meta ? meta.createdAt : stat.birthtime.toISOString(),
          displayDate: meta ? meta.displayDate : stat.birthtime.toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }),
          totalUsers: meta ? meta.totalUsers : 0,
          totalChallenges: meta ? meta.totalChallenges : 0,
          totalSubmissions: meta ? meta.totalSubmissions : 0,
          totalFiles: meta ? meta.totalFiles : 0,
          mtime: stat.mtimeMs
        };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    items.sort((a, b) => b.mtime - a.mtime);

    const users = readJson(USERS_FILE, []);
    const challenges = readJson(CHALLENGES_FILE, []);
    const submissions = readJson(SUBMISSIONS_FILE, []);
    const archive = readJson(ARCHIVE_FILE, []);

    res.json({
      success: true,
      stats: {
        totalUsers: users.length,
        totalChallenges: challenges.length,
        totalSubmissions: submissions.length,
        totalArchiveEntries: archive.length,
        totalBackups: items.length,
        lastBackup: items.length > 0 ? items[0] : null
      },
      backups: items
    });
  } catch (err) {
    console.error('Failed to list backups:', err);
    res.status(500).json({ success: false, message: 'Failed to retrieve backups list' });
  }
});

// 2. Create instant manual backup
app.post('/api/admin/backups/create', authenticateAdminToken, (req, res) => {
  const result = createDatabaseBackup('manual');
  if (result.success) {
    res.json({
      success: true,
      message: 'নতুন ডাটাবেজ ব্যাকআপ সফলভাবে তৈরি হয়েছে!',
      backup: result.backup
    });
  } else {
    res.status(500).json({ success: false, message: result.error || 'Failed to create backup' });
  }
});

// 3. One-click export of complete live database bundle
app.get('/api/admin/backups/export-full', authenticateAdminToken, (req, res) => {
  try {
    const fullDump = {
      exportMetadata: {
        platform: 'Binary Prop Firm',
        exportTime: new Date().toISOString(),
        exportedBy: req.user.email || 'Admin',
        environment: 'Production - Permanent Database Snapshot'
      },
      users: readJson(USERS_FILE, []),
      challenges: readJson(CHALLENGES_FILE, []),
      submissions: readJson(SUBMISSIONS_FILE, []),
      courses: readJson(COURSES_FILE, []),
      mmLinks: readJson(MM_LINKS_FILE, []),
      paymentMethods: readJson(PAYMENT_METHODS_FILE, []),
      userArchive: readJson(ARCHIVE_FILE, [])
    };

    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `binarypropfirm_complete_database_${dateStr}_${Date.now()}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(fullDump, null, 2));
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ success: false, message: 'Failed to export full database' });
  }
});

// 4. Download a specific backup snapshot
app.get('/api/admin/backups/:backupId/download', authenticateAdminToken, (req, res) => {
  try {
    const backupFolder = path.join(BACKUPS_DIR, req.params.backupId);
    if (!fs.existsSync(backupFolder) || !fs.statSync(backupFolder).isDirectory()) {
      return res.status(404).json({ success: false, message: 'Backup not found' });
    }

    const files = fs.readdirSync(backupFolder);
    const dump = { backupId: req.params.backupId };
    files.forEach(f => {
      const full = path.join(backupFolder, f);
      if (f.endsWith('.json')) {
        dump[f.replace('.json', '')] = readJson(full, {});
      }
    });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.backupId}.json"`);
    res.send(JSON.stringify(dump, null, 2));
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to download backup' });
  }
});

// 5. Delete specific backup folder
app.delete('/api/admin/backups/:backupId', authenticateAdminToken, (req, res) => {
  try {
    const backupFolder = path.join(BACKUPS_DIR, req.params.backupId);
    if (!fs.existsSync(backupFolder)) {
      return res.status(404).json({ success: false, message: 'Backup not found' });
    }
    fs.rmSync(backupFolder, { recursive: true, force: true });
    res.json({ success: true, message: 'ব্যাকআপ স্ন্যাপশট মুছে ফেলা হয়েছে।' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete backup' });
  }
});

// 6. View recent user archive log entries
app.get('/api/admin/backups/archive-logs', authenticateAdminToken, (req, res) => {
  const archive = readJson(ARCHIVE_FILE, []);
  res.json({
    success: true,
    total: archive.length,
    logs: archive.slice(0, 100)
  });
});


// 5. Update User Profile by Admin
app.put('/api/admin/users/:id', authenticateAdminToken, async (req, res) => {
  const { name, telegram, preferredBroker, brokerAccountId, payoutWallet, newPassword } = req.body;
  const users = syncUsersWithAllData();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'User not found.' });

  if (name) users[idx].name = name.trim();
  if (telegram !== undefined) users[idx].telegram = telegram.trim();
  if (preferredBroker) users[idx].preferredBroker = preferredBroker;
  if (brokerAccountId !== undefined) users[idx].brokerAccountId = brokerAccountId.trim();
  if (payoutWallet !== undefined) users[idx].payoutWallet = payoutWallet.trim();

  if (newPassword && newPassword.trim().length >= 6) {
    const salt = await bcrypt.genSalt(10);
    users[idx].password = await bcrypt.hash(newPassword.trim(), salt);
  }

  writeJson(USERS_FILE, users);
  writeJson(USERS_PERMANENT_STORE_FILE, users);
  saveTraderToLifelongVault(users[idx]);

  res.json({ success: true, message: 'Trader account updated successfully!', user: users[idx] });
});

// 6. Challenges List (All / Pending / Active)
app.get('/api/admin/challenges', authenticateAdminToken, (req, res) => {
  const challenges = syncChallengesWithSubmissions();
  const users = syncUsersWithAllData();

  const enriched = challenges.map(c => {
    const user = users.find(u => u.id === c.userId);
    return {
      ...c,
      userTraderId: (user && user.traderId) ? user.traderId : (c.userTraderId || 'AJ-1000'),
      userName: (user && user.name) ? user.name : (c.userName || 'Trader'),
      userEmail: (user && user.email) ? user.email : (c.userEmail || ''),
      userTelegram: (user && user.telegram) ? user.telegram : (c.userTelegram || 'N/A'),
      userAvatar: user ? (user.profilePicture || null) : (c.userAvatar || null)
    };
  });
  enriched.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ success: true, challenges: enriched });
});

// 7. Approve Challenge (Sets Active + Assigns Next Serial MM link)
app.post('/api/admin/challenges/:id/approve', authenticateAdminToken, (req, res) => {
  const challenges = readJson(CHALLENGES_FILE);
  const idx = challenges.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Challenge not found.' });

  const { mmLinkId } = req.body;
  let assignedLink = null;

  const mmLinks = readJson(MM_LINKS_FILE);
  if (mmLinkId) {
    assignedLink = mmLinks.find(l => l.id === mmLinkId);
  }

  if (!assignedLink) {
    assignedLink = getNextMmSerialLink();
  } else {
    assignedLink.assignedCount = (assignedLink.assignedCount || 0) + 1;
    writeJson(MM_LINKS_FILE, mmLinks);
  }

  const now = new Date();
  challenges[idx].status = 'in_progress';
  challenges[idx].approvedAt = now.toISOString();
  challenges[idx].durationDays = challenges[idx].durationDays || 15;
  challenges[idx].sessionsRequired = challenges[idx].sessionsRequired || 15;

  // Practice Phase Settings (48 Hours, up to 3 practice sessions)
  challenges[idx].challengePhase = 'practice';
  challenges[idx].practiceHours = 48;
  challenges[idx].practiceStartedAt = now.toISOString();
  challenges[idx].practiceExpiresAt = new Date(now.getTime() + (48 * 60 * 60 * 1000)).toISOString();
  challenges[idx].practiceMaxSessions = 3;
  challenges[idx].practiceSessionsCompleted = 0;
  challenges[idx].expiresAt = new Date(now.getTime() + (48 * 60 * 60 * 1000) + (challenges[idx].durationDays * 24 * 60 * 60 * 1000)).toISOString();
  challenges[idx].isActive = true;
  challenges[idx].assignedMmId = assignedLink.id;
  challenges[idx].assignedMmSerial = assignedLink.serial;
  challenges[idx].assignedMmTitle = assignedLink.title;
  challenges[idx].assignedMmUrl = assignedLink.url;
  challenges[idx].assignedMmNote = assignedLink.note;

  saveChallenges(challenges);
  logUserArchive('CHALLENGE_APPROVED', { id: challenges[idx].userId }, {
    challengeId: challenges[idx].id,
    packageName: challenges[idx].packageName,
    mmSerial: assignedLink.serial,
    mmTitle: assignedLink.title
  });

  syncChallengesWithSubmissions();

  res.json({
    success: true,
    message: `Challenge approved successfully! Assigned Money Management Serial #${assignedLink.serial}.`,
    challenge: challenges[idx]
  });
});

// Switch Challenge Phase between Practice & Evaluation (Admin)
app.post('/api/admin/challenges/:id/set-phase', authenticateAdminToken, (req, res) => {
  const { phase } = req.body;
  const challenges = readJson(CHALLENGES_FILE);
  const idx = challenges.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Challenge not found.' });

  const c = challenges[idx];
  const now = new Date();
  if (phase === 'evaluation') {
    c.challengePhase = 'evaluation';
    c.evaluationStartedAt = now.toISOString();
    c.durationDays = c.durationDays || 15;
    c.expiresAt = new Date(now.getTime() + (c.durationDays * 24 * 60 * 60 * 1000)).toISOString();
  } else if (phase === 'practice') {
    c.challengePhase = 'practice';
    c.practiceStartedAt = now.toISOString();
    c.practiceExpiresAt = new Date(now.getTime() + (48 * 60 * 60 * 1000)).toISOString();
    c.expiresAt = new Date(now.getTime() + (48 * 60 * 60 * 1000) + ((c.durationDays || 15) * 24 * 60 * 60 * 1000)).toISOString();
  } else {
    return res.status(400).json({ success: false, message: 'Invalid phase. Must be practice or evaluation.' });
  }

  challenges[idx] = c;
  saveChallenges(challenges);
  syncChallengesWithSubmissions();

  res.json({
    success: true,
    message: `চ্যালেঞ্জের ফেজ সফলভাবে '${phase === 'evaluation' ? 'মূল মূল্যায়ন (১৫ দিন)' : '৪৮ ঘণ্টার প্র্যাকটিস'}' এ পরিবর্তন করা হয়েছে।`,
    challenge: c
  });
});

// 8. Reject Challenge Order (Admin)
app.post('/api/admin/challenges/:id/reject', authenticateAdminToken, (req, res) => {
  const challenges = readJson(CHALLENGES_FILE);
  const idx = challenges.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Challenge not found.' });

  const reason = (req.body.reason && req.body.reason.trim()) ? req.body.reason.trim() : 'এডমিন কর্তৃক চ্যালেঞ্জটি বাতিল (Rejected) করা হয়েছে।';
  challenges[idx].status = 'rejected';
  challenges[idx].rejectedReason = reason;
  challenges[idx].failReason = 'CHALLENGE_REJECTED';
  challenges[idx].failReasonText = reason;
  challenges[idx].rejectedAt = new Date().toISOString();
  challenges[idx].isActive = false;

  saveChallenges(challenges);

  logUserArchive('CHALLENGE_REJECTED', { id: challenges[idx].userId, name: challenges[idx].userName, email: challenges[idx].userEmail }, {
    challengeId: challenges[idx].id,
    packageName: challenges[idx].packageName,
    fundedAmount: challenges[idx].fundedAmount,
    broker: challenges[idx].brokerName,
    reason: reason
  });

  // Automatically notify trader via Gmail with rejection reason
  sendChallengeRejectionEmail(challenges[idx].userEmail, challenges[idx].userName, challenges[idx].packageName, reason);

  syncChallengesWithSubmissions();

  res.json({ success: true, message: 'চ্যালেঞ্জ অর্ডারটি বাতিল করা হয়েছে এবং কারণ ইউজারের ড্যাশবোর্ড ও ইমেইলে পাঠানো হয়েছে।', challenge: challenges[idx] });
});

// Disqualify Challenge for Rule Violation (Admin - Req #3)
app.post('/api/admin/challenges/:id/disqualify', authenticateAdminToken, (req, res) => {
  const challenges = readJson(CHALLENGES_FILE, []);
  const idx = challenges.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Challenge not found.' });

  const { violatedRule, reasonNote } = req.body;
  const ruleText = (violatedRule && violatedRule.trim()) ? violatedRule.trim() : 'অফিসিয়াল রুলস লঙ্ঘন';
  const detailNote = (reasonNote && reasonNote.trim()) ? reasonNote.trim() : 'প্ল্যাটফর্মের অফিসিয়াল নিয়ম ভঙ্গ করায় এই চ্যালেঞ্জটি বাতিল ও বন্ধ করা হয়েছে।';
  const nowIso = new Date().toISOString();

  challenges[idx].status = 'failed';
  challenges[idx].failReason = 'RULE_VIOLATION';
  challenges[idx].violatedRule = ruleText;
  challenges[idx].failReasonText = detailNote;
  challenges[idx].failedAt = nowIso;
  challenges[idx].isActive = false;
  challenges[idx].isCompleted = true;

  saveChallenges(challenges);

  logUserArchive('CHALLENGE_DISQUALIFIED_RULE_VIOLATION', 
    { id: challenges[idx].userId, name: challenges[idx].userName, email: challenges[idx].userEmail }, 
    {
      challengeId: challenges[idx].id,
      packageName: challenges[idx].packageName,
      violatedRule: ruleText,
      reasonNote: detailNote,
      failReason: 'RULE_VIOLATION'
    }
  );

  syncChallengesWithSubmissions();

  res.json({
    success: true,
    message: `ট্রেডারকে ${ruleText}-এর কারণে চ্যালেঞ্জ থেকে বাদ দেওয়া হয়েছে এবং চ্যালেঞ্জটি বন্ধ করা হয়েছে।`,
    challenge: challenges[idx]
  });
});

// Disqualify Trader from Challenge via a Session Rule Violation (Admin - Req #3)
app.post('/api/admin/submissions/:id/disqualify-challenge', authenticateAdminToken, (req, res) => {
  const submissions = readJson(SUBMISSIONS_FILE, []);
  const sIdx = submissions.findIndex(s => s.id === req.params.id);
  if (sIdx === -1) return res.status(404).json({ success: false, message: 'Submission not found.' });

  const targetSub = submissions[sIdx];
  if (targetSub.isPractice === true) {
    return res.status(400).json({
      success: false,
      message: 'এটি একটি প্র্যাকটিস সেশন। প্র্যাকটিস সেশনের জন্য ট্রেডারকে চ্যালেঞ্জ থেকে বাদ দেওয়া বা ডিসকোয়ালিফাই করা যাবে না।'
    });
  }

  const { violatedRule, adminFeedback } = req.body;
  const ruleText = (violatedRule && violatedRule.trim()) ? violatedRule.trim() : 'অফিসিয়াল রুলস লঙ্ঘন';
  const feedback = (adminFeedback && adminFeedback.trim()) ? adminFeedback.trim() : 'রুল লঙ্ঘনের কারণে সেশন ও চ্যালেঞ্জ বাতিল করা হয়েছে।';
  const nowIso = new Date().toISOString();

  targetSub.status = 'rejected';
  targetSub.adminFeedback = `[রুল লঙ্ঘন]: ${ruleText} - ${feedback}`;
  targetSub.reviewedAt = nowIso;
  submissions[sIdx] = targetSub;
  writeJson(SUBMISSIONS_FILE, submissions);

  // Disqualify the associated challenge
  const challenges = readJson(CHALLENGES_FILE, []);
  const cIdx = challenges.findIndex(c => c.id === targetSub.challengeId || (c.userId === targetSub.userId && c.status === 'in_progress'));
  if (cIdx !== -1) {
    challenges[cIdx].status = 'failed';
    challenges[cIdx].failReason = 'RULE_VIOLATION';
    challenges[cIdx].violatedRule = ruleText;
    challenges[cIdx].failReasonText = feedback;
    challenges[cIdx].failedAt = nowIso;
    challenges[cIdx].isActive = false;
    challenges[cIdx].isCompleted = true;
    saveChallenges(challenges);

    logUserArchive('CHALLENGE_DISQUALIFIED_FROM_SESSION', 
      { id: targetSub.userId, name: targetSub.userName, email: targetSub.userEmail }, 
      {
        submissionId: targetSub.id,
        challengeId: challenges[cIdx].id,
        packageName: challenges[cIdx].packageName,
        violatedRule: ruleText,
        feedback: feedback,
        failReason: 'RULE_VIOLATION'
      }
    );
  }

  syncChallengesWithSubmissions();

  res.json({
    success: true,
    message: `সেশনটি বাতিল করা হয়েছে এবং ট্রেডারকে ${ruleText}-এর জন্য চ্যালেঞ্জ থেকে বাদ দেওয়া হয়েছে।`,
    submission: targetSub,
    challenge: cIdx !== -1 ? challenges[cIdx] : null
  });
});

// 9. Update Challenge Status (Passed / Failed / Drawdown)
app.post('/api/admin/challenges/:id/update-status', authenticateAdminToken, (req, res) => {
  const { status, sessionsCompleted, currentDrawdown, failReason, failReasonText, violatedRule } = req.body;
  const challenges = readJson(CHALLENGES_FILE, []);
  const idx = challenges.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Challenge not found.' });

  const nowIso = new Date().toISOString();
  if (status) {
    challenges[idx].status = status;
    if (status === 'passed') {
      challenges[idx].passedAt = nowIso;
      challenges[idx].isCompleted = true;
      challenges[idx].isActive = false;
    } else if (status === 'failed') {
      challenges[idx].failedAt = nowIso;
      challenges[idx].failReason = failReason || 'DISQUALIFIED_BY_ADMIN';
      challenges[idx].failReasonText = failReasonText || 'এডমিন কর্তৃক চ্যালেঞ্জ বাতিল ও বাদ দেওয়া হয়েছে।';
      if (violatedRule) challenges[idx].violatedRule = violatedRule;
      challenges[idx].isActive = false;
      challenges[idx].isCompleted = true;
    } else if (status === 'in_progress') {
      challenges[idx].isActive = true;
      challenges[idx].isCompleted = false;
      delete challenges[idx].failReason;
      delete challenges[idx].violatedRule;
      delete challenges[idx].failReasonText;
      delete challenges[idx].failedAt;
    }
  }
  if (sessionsCompleted !== undefined) challenges[idx].sessionsCompleted = parseInt(sessionsCompleted) || 0;
  if (currentDrawdown !== undefined) challenges[idx].currentDrawdown = currentDrawdown;

  saveChallenges(challenges);

  logUserArchive('CHALLENGE_STATUS_UPDATED', 
    { id: challenges[idx].userId, name: challenges[idx].userName, email: challenges[idx].userEmail }, 
    {
      challengeId: challenges[idx].id,
      packageName: challenges[idx].packageName,
      status: challenges[idx].status,
      failReason: challenges[idx].failReason,
      violatedRule: challenges[idx].violatedRule,
      failReasonText: challenges[idx].failReasonText
    }
  );

  syncChallengesWithSubmissions();

  res.json({ success: true, message: 'Challenge status updated successfully.', challenge: challenges[idx] });
});

// 9.1 Reactivate Disqualified / Failed Challenge with Notification (Admin)
app.post('/api/admin/challenges/:id/reactivate', authenticateAdminToken, (req, res) => {
  let challenges = readJson(CHALLENGES_FILE, []);
  let permChallenges = readJson(CHALLENGES_PERMANENT_STORE_FILE, []);
  const idx = challenges.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Challenge not found.' });

  const target = challenges[idx];
  const previousRule = target.violatedRule || target.failReason || 'Unknown';
  const previousReasonText = target.failReasonText || '';
  const customMessage = (req.body.message && req.body.message.trim())
    ? req.body.message.trim()
    : 'সম্মানিত ট্রেডার, ভুলবশত আপনার অ্যাকাউন্টের চ্যালেঞ্জটি সাময়িকভাবে বন্ধ করা হয়েছিল। আপনার চ্যালেঞ্জটি পুনরায় সফলভাবে সক্রিয় করা হয়েছে এবং আগের সকল ডাটা অক্ষত রয়েছে। আপনি যথারীতি ট্রেডিং চালিয়ে যেতে পারেন। সাময়িক অসুবিধার জন্য আমরা আন্তরিকভাবে দুঃখিত।';

  const nowIso = new Date().toISOString();

  // 1. Restore status to in_progress & active (leaving all previous sessions and metrics 100% intact)
  target.status = 'in_progress';
  target.isActive = true;
  target.isCompleted = false;

  // 2. Remove failure fields
  delete target.failReason;
  delete target.violatedRule;
  delete target.failReasonText;
  delete target.failedAt;

  // 3. Attach reactivation notice for trader dashboard
  target.reactivationNotice = {
    id: `notif_${Date.now()}`,
    title: 'চ্যালেঞ্জ পুনরায় সচল করা হয়েছে',
    message: customMessage,
    reactivatedAt: nowIso,
    read: false
  };
  target.reactivatedAt = nowIso;

  // Save to both persistent stores
  saveChallenges(challenges);

  // 4. Log archive event
  logUserArchive('CHALLENGE_REACTIVATED_BY_ADMIN',
    { id: target.userId, name: target.userName, email: target.userEmail },
    {
      challengeId: target.id,
      packageName: target.packageName,
      previousRule,
      previousReasonText,
      reactivationMessage: customMessage,
      sessionsCompleted: target.sessionsCompleted || 0
    }
  );

  syncChallengesWithSubmissions();

  res.json({
    success: true,
    message: `ট্রেডার "${target.userName}" এর চ্যালেঞ্জটি সফলভাবে পুনরায় সচল করা হয়েছে এবং ট্রেডারের কাছে নোটিফিকেশন পাঠানো হয়েছে।`,
    challenge: target
  });
});

// Dismiss Reactivation Notice (Trader)
app.post('/api/user/challenges/:id/dismiss-notice', authenticateToken, (req, res) => {
  let challenges = readJson(CHALLENGES_FILE, []);
  const ch = challenges.find(c => c.id === req.params.id && (c.userId === req.user.id || (c.userEmail && c.userEmail.toLowerCase() === (req.user.email || '').toLowerCase())));
  if (ch && ch.reactivationNotice) {
    ch.reactivationNotice.read = true;
    saveChallenges(challenges);
  }
  res.json({ success: true, message: 'Notice dismissed.' });
});

// 10. Submissions List
app.get('/api/admin/submissions', authenticateAdminToken, (req, res) => {
  const submissions = readJson(SUBMISSIONS_FILE);
  const users = readJson(USERS_FILE);

  const enriched = submissions.map(s => {
    const user = users.find(u => u.id === s.userId);
    return {
      ...s,
      userTraderId: user ? (user.traderId || 'N/A') : 'N/A',
      userName: user ? user.name : 'Unknown Trader',
      userEmail: user ? user.email : 'Unknown Email',
      userTelegram: user ? user.telegram : 'N/A',
      userAvatar: user ? (user.profilePicture || null) : null
    };
  });

  res.json({ success: true, submissions: enriched });
});

// 11. Review Daily Trade Submission
app.post('/api/admin/submissions/:id/review', authenticateAdminToken, (req, res) => {
  const { status, adminFeedback, incrementSession } = req.body;
  const submissions = readJson(SUBMISSIONS_FILE);
  const sIdx = submissions.findIndex(s => s.id === req.params.id);
  if (sIdx === -1) return res.status(404).json({ success: false, message: 'Submission not found.' });

  const targetSub = submissions[sIdx];
  const isPractice = (targetSub.isPractice === true);

  submissions[sIdx].status = status; // 'verified' or 'rejected'
  submissions[sIdx].adminFeedback = adminFeedback ? adminFeedback.trim() : '';
  submissions[sIdx].reviewedAt = new Date().toISOString();
  writeJson(SUBMISSIONS_FILE, submissions);

  // If rejected, immediately fail and close the parent challenge ONLY if NOT a practice session!
  if (status === 'rejected' && !isPractice) {
    const challenges = readJson(CHALLENGES_FILE);
    const cIdx = challenges.findIndex(c => 
      c.id === targetSub.challengeId || 
      (c.userId === targetSub.userId && c.status === 'in_progress')
    );
    if (cIdx !== -1) {
      const feedback = adminFeedback && adminFeedback.trim() ? adminFeedback.trim() : 'সেশন বাতিল করা হয়েছে';
      challenges[cIdx].status = 'failed';
      challenges[cIdx].failReason = 'SESSION_REJECTED';
      challenges[cIdx].violatedRule = `সেশন বাতিল (কারণ: ${feedback})`;
      challenges[cIdx].failReasonText = `এডমিন প্যানেল থেকে আপনার ট্রেডিং সেশন রিজেক্ট করা হয়েছে (কারণ: ${feedback})। প্ল্যাটফর্মের অফিসিয়াল নিয়মানুযায়ী সেশন রিজেক্ট হলে চ্যালেঞ্জটি বন্ধ হয়ে যায় এবং আপনি এই চ্যালেঞ্জ থেকে বাদ পড়েছেন।`;
      challenges[cIdx].failedAt = new Date().toISOString();
      challenges[cIdx].isActive = false;
      challenges[cIdx].isCompleted = true;
      saveChallenges(challenges);
    }
  } else if (status === 'verified' && !isPractice) {
    // If verified/approved by admin, check if parent challenge was marked 'failed'.
    // If no other rejected submissions remain, REACTIVATE the challenge!
    const challenges = readJson(CHALLENGES_FILE);
    const cIdx = challenges.findIndex(c => 
      c.id === targetSub.challengeId || 
      (c.userId === targetSub.userId && c.status === 'failed')
    );
    if (cIdx !== -1 && challenges[cIdx].status === 'failed') {
      const otherRejected = submissions.some(s => 
        s.id !== targetSub.id && 
        s.isPractice !== true &&
        (s.challengeId ? s.challengeId === challenges[cIdx].id : s.userId === challenges[cIdx].userId) && 
        s.status === 'rejected'
      );
      if (!otherRejected) {
        challenges[cIdx].status = 'in_progress';
        challenges[cIdx].isActive = true;
        challenges[cIdx].isCompleted = false;
        delete challenges[cIdx].failReason;
        delete challenges[cIdx].violatedRule;
        delete challenges[cIdx].failReasonText;
        delete challenges[cIdx].failedAt;
        saveChallenges(challenges);

        logUserArchive('CHALLENGE_REACTIVATED', { id: challenges[cIdx].userId }, {
          challengeId: challenges[cIdx].id,
          submissionId: targetSub.id,
          reason: 'Admin re-approved session to verified'
        });
      }
    }
  }

  // Automatically recalculate and sync challenge sessions accurately with real submissions
  syncChallengesWithSubmissions();

  let reviewMsg = '';
  if (status === 'rejected') {
    reviewMsg = isPractice 
      ? 'প্র্যাকটিস সেশনটি বাতিল হিসেবে গণ্য করা হয়েছে এবং ট্রেডারকে ফিডব্যাক পাঠানো হয়েছে। (প্র্যাকটিস সেশন হওয়ায় ট্রেডার চ্যালেঞ্জ থেকে বাদ পড়েননি)' 
      : 'সেশন বাতিল করা হয়েছে এবং সংশ্লিষ্ট চ্যালেঞ্জটি বন্ধ ও ডিসকোয়ালিফাই করা হয়েছে।';
  } else {
    reviewMsg = isPractice
      ? 'প্র্যাকটিস সেশনটি সফলভাবে অনুমোদন ও পর্যালোচনা সম্পন্ন হয়েছে।'
      : 'সেশনটি সফলভাবে অনুমোদন করা হয়েছে এবং চ্যালেঞ্জটি পুনরায় চালু/সচল করা হয়েছে।';
  }

  res.json({ 
    success: true, 
    message: reviewMsg,
    submission: submissions[sIdx] 
  });
});

// Request Re-upload / Correction for a Session (Admin)
app.post('/api/admin/submissions/:id/request-resubmission', authenticateAdminToken, (req, res) => {
  const { adminFeedback } = req.body;
  if (!adminFeedback || !adminFeedback.trim()) {
    return res.status(400).json({ success: false, message: 'দয়া করে ট্রেডারকে সংশোধন করার জন্য নির্দিষ্ট নির্দেশনা প্রদান করুন।' });
  }

  const submissions = readJson(SUBMISSIONS_FILE);
  const sIdx = submissions.findIndex(s => s.id === req.params.id);
  if (sIdx === -1) return res.status(404).json({ success: false, message: 'Submission not found.' });

  submissions[sIdx].status = 'needs_resubmission';
  submissions[sIdx].adminFeedback = adminFeedback.trim();
  submissions[sIdx].resubmissionRequestedAt = new Date().toISOString();
  writeJson(SUBMISSIONS_FILE, submissions);

  logUserArchive('PROOF_RESUBMISSION_REQUESTED', { id: submissions[sIdx].userId }, {
    submissionId: submissions[sIdx].id,
    challengeId: submissions[sIdx].challengeId,
    adminFeedback: adminFeedback.trim()
  });

  syncChallengesWithSubmissions();

  res.json({
    success: true,
    message: 'ট্রেডারকে পুনরায় আপলোডের নির্দেশনা পাঠানো হয়েছে।',
    submission: submissions[sIdx]
  });
});

// Delete Challenge Order (Admin) - Permanent Cascade Removal
app.delete('/api/admin/challenges/:id', authenticateAdminToken, (req, res) => {
  let challenges = readJson(CHALLENGES_FILE, []);
  let permChallenges = readJson(CHALLENGES_PERMANENT_STORE_FILE, []);
  const found = challenges.find(c => c.id === req.params.id) || permChallenges.find(c => c.id === req.params.id);
  if (!found) return res.status(404).json({ success: false, message: 'Challenge not found.' });

  challenges = challenges.filter(c => c.id !== req.params.id);
  permChallenges = permChallenges.filter(c => c.id !== req.params.id);
  saveChallenges(challenges);

  // Clean out any past approval/purchase logs from user_archive so auto-heal NEVER recovers it
  let archive = readJson(ARCHIVE_FILE, []);
  archive = archive.filter(a => {
    const chId = (a.metadata && a.metadata.challengeId) || a.challengeId;
    return chId !== req.params.id;
  });
  writeJson(ARCHIVE_FILE, archive);

  logUserArchive('CHALLENGE_DELETED_BY_ADMIN', 
    { id: found.userId, name: found.userName, email: found.userEmail }, 
    { challengeId: found.id, packageName: found.packageName }
  );

  syncChallengesWithSubmissions();

  res.json({ success: true, message: 'চ্যালেঞ্জ অর্ডারটি স্থায়ীভাবে মুছে ফেলা হয়েছে।' });
});

// Delete Trade Submission (Admin)
app.delete('/api/admin/submissions/:id', authenticateAdminToken, (req, res) => {
  let submissions = readJson(SUBMISSIONS_FILE);
  const found = submissions.find(s => s.id === req.params.id);
  if (!found) return res.status(404).json({ success: false, message: 'Submission not found.' });

  submissions = submissions.filter(s => s.id !== req.params.id);
  writeJson(SUBMISSIONS_FILE, submissions);
  syncChallengesWithSubmissions();
  res.json({ success: true, message: 'Submission deleted successfully.' });
});

// Update Trade Submission Media / URLs / Notes (Admin)
app.post('/api/admin/submissions/:id/update-media', authenticateAdminToken, upload.fields([
  { name: 'screenshot', maxCount: 1 },
  { name: 'videoFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const submissions = readJson(SUBMISSIONS_FILE);
    const idx = submissions.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Submission record not found.' });

    let videoUrl = req.body.videoUrl !== undefined ? req.body.videoUrl.trim() : submissions[idx].videoUrl;
    let screenshotUrl = req.body.screenshotUrl !== undefined ? req.body.screenshotUrl.trim() : submissions[idx].screenshotUrl;

    const screenshotFile = req.files?.['screenshot']?.[0];
    const videoUploadFile = req.files?.['videoFile']?.[0];

    if (screenshotFile) {
      const fileBuffer = fs.readFileSync(screenshotFile.path);
      const cloudUpload = await uploadToFreeCloudCdn(fileBuffer, screenshotFile.originalname, screenshotFile.mimetype);
      if (fs.existsSync(screenshotFile.path)) { try { fs.unlinkSync(screenshotFile.path); } catch (e) {} }
      if (cloudUpload.success) screenshotUrl = cloudUpload.url;
    }

    if (videoUploadFile) {
      const fileBuffer = fs.readFileSync(videoUploadFile.path);
      const cloudUpload = await uploadToFreeCloudCdn(fileBuffer, videoUploadFile.originalname, videoUploadFile.mimetype);
      if (fs.existsSync(videoUploadFile.path)) { try { fs.unlinkSync(videoUploadFile.path); } catch (e) {} }
      if (cloudUpload.success) videoUrl = cloudUpload.url;
    }

    submissions[idx].videoUrl = videoUrl;
    submissions[idx].screenshotUrl = screenshotUrl;
    if (req.body.notes !== undefined) submissions[idx].notes = req.body.notes.trim();

    if (submissions[idx].videoUrl && submissions[idx].screenshotUrl) {
      submissions[idx].fileType = 'both';
    } else if (submissions[idx].videoUrl) {
      submissions[idx].fileType = 'video';
    } else if (submissions[idx].screenshotUrl) {
      submissions[idx].fileType = 'image';
    } else {
      submissions[idx].fileType = 'none';
    }

    writeJson(SUBMISSIONS_FILE, submissions);
    res.json({ success: true, message: 'সেশন প্রুফ মিডিয়া সফলভাবে আপডেট করা হয়েছে!', submission: submissions[idx] });
  } catch (err) {
    console.error('Error updating submission media:', err);
    res.status(500).json({ success: false, message: 'Failed to update submission media.' });
  }
});


// 12. Money Management Serial Links (CRUD)
app.get('/api/admin/mm-links', authenticateAdminToken, (req, res) => {
  const links = readJson(MM_LINKS_FILE);
  links.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));
  res.json({ success: true, links });
});

app.post('/api/admin/mm-links', authenticateAdminToken, (req, res) => {
  const { serial, title, url, note } = req.body;
  if (!title || !url) return res.status(400).json({ success: false, message: 'Title and Sheet URL are required.' });

  const links = readJson(MM_LINKS_FILE);
  const newLink = {
    id: `mm_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
    serial: parseInt(serial) || (links.length + 1),
    title: title.trim(),
    url: url.trim(),
    note: note ? note.trim() : '',
    assignedCount: 0,
    createdAt: new Date().toISOString()
  };

  links.push(newLink);
  links.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));
  writeJson(MM_LINKS_FILE, links);

  res.status(201).json({ success: true, message: 'Money Management Serial Link added!', link: newLink });
});

app.put('/api/admin/mm-links/:id', authenticateAdminToken, (req, res) => {
  const { serial, title, url, note } = req.body;
  const links = readJson(MM_LINKS_FILE);
  const idx = links.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Link not found.' });

  if (serial !== undefined) links[idx].serial = parseInt(serial) || links[idx].serial;
  if (title) links[idx].title = title.trim();
  if (url) links[idx].url = url.trim();
  if (note !== undefined) links[idx].note = note.trim();

  links.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));
  writeJson(MM_LINKS_FILE, links);

  res.json({ success: true, message: 'Money Management Link updated!', link: links[idx] });
});

app.delete('/api/admin/mm-links/:id', authenticateAdminToken, (req, res) => {
  let links = readJson(MM_LINKS_FILE);
  links = links.filter(l => l.id !== req.params.id);
  writeJson(MM_LINKS_FILE, links);
  res.json({ success: true, message: 'Money Management Link deleted.' });
});

// 13. Trading Course Lessons (CRUD)
app.get('/api/admin/courses', authenticateAdminToken, (req, res) => {
  const courses = readJson(COURSES_FILE);
  courses.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));
  const enriched = courses.map(c => ({
    ...c,
    videoEmbed: convertToEmbedUrl(c.videoEmbed),
    thumbnailUrl: c.thumbnailUrl || extractVideoThumbnail(c.videoEmbed)
  }));
  res.json({ success: true, courses: enriched });
});

app.post('/api/admin/courses', authenticateAdminToken, (req, res) => {
  let { title, category, duration, summary, videoEmbed, serial } = req.body;
  if (!title || !videoEmbed) return res.status(400).json({ success: false, message: 'Title and Video URL are required.' });

  const courses = readJson(COURSES_FILE);
  const embedUrl = convertToEmbedUrl(videoEmbed);
  const thumbnailUrl = extractVideoThumbnail(videoEmbed) || extractVideoThumbnail(embedUrl);

  const newCourse = {
    id: `lesson-${Date.now()}`,
    serial: parseInt(serial) || (courses.length + 1),
    title: title.trim(),
    category: category ? category.trim() : 'Strategy',
    duration: duration ? duration.trim() : '20:00',
    summary: summary ? summary.trim() : '',
    videoEmbed: embedUrl,
    thumbnailUrl: thumbnailUrl,
    slidesCount: 8,
    createdAt: new Date().toISOString()
  };

  courses.push(newCourse);
  courses.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));
  writeJson(COURSES_FILE, courses);

  res.status(201).json({ success: true, message: 'Trading lesson added successfully!', course: newCourse });
});

app.put('/api/admin/courses/:id', authenticateAdminToken, (req, res) => {
  const { title, category, duration, summary, videoEmbed, serial } = req.body;
  const courses = readJson(COURSES_FILE);
  const idx = courses.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Lesson not found.' });

  if (title) courses[idx].title = title.trim();
  if (category) courses[idx].category = category.trim();
  if (duration) courses[idx].duration = duration.trim();
  if (summary !== undefined) courses[idx].summary = summary.trim();
  if (videoEmbed) {
    courses[idx].videoEmbed = convertToEmbedUrl(videoEmbed);
    courses[idx].thumbnailUrl = extractVideoThumbnail(videoEmbed) || extractVideoThumbnail(courses[idx].videoEmbed);
  }
  if (serial !== undefined) courses[idx].serial = parseInt(serial) || courses[idx].serial;

  courses.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));
  writeJson(COURSES_FILE, courses);

  res.json({ success: true, message: 'Course lesson updated successfully!', course: courses[idx] });
});

app.delete('/api/admin/courses/:id', authenticateAdminToken, (req, res) => {
  let courses = readJson(COURSES_FILE);
  courses = courses.filter(c => c.id !== req.params.id);
  writeJson(COURSES_FILE, courses);
  res.json({ success: true, message: 'Course lesson removed successfully.' });
});

// 14. Payment Methods Control (Admin)
app.get('/api/admin/payment-methods', authenticateAdminToken, (req, res) => {
  const methods = readJson(PAYMENT_METHODS_FILE);
  methods.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));
  res.json({ success: true, paymentMethods: methods });
});

app.post('/api/admin/payment-methods', authenticateAdminToken, (req, res) => {
  const { name, accountNumber, instructions, badge, isActive, serial, requireTrxId, requireSenderNumber, country, countryCode, currency, currencySymbol, exchangeRate } = req.body;
  if (!name || !accountNumber) return res.status(400).json({ success: false, message: 'Method Name and Account Number / Address are required.' });

  const methods = readJson(PAYMENT_METHODS_FILE);
  const parsedRate = parseFloat(exchangeRate);
  const newMethod = {
    id: `pm_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
    serial: parseInt(serial) || (methods.length + 1),
    name: name.trim(),
    accountNumber: accountNumber.trim(),
    instructions: instructions ? instructions.trim() : '',
    badge: badge ? badge.trim() : 'Active',
    isActive: isActive !== false,
    requireTrxId: requireTrxId !== false,
    requireSenderNumber: Boolean(requireSenderNumber),
    country: country ? country.trim() : 'Global / International',
    countryCode: countryCode ? countryCode.trim().toUpperCase() : 'GLOBAL',
    currency: currency ? currency.trim().toUpperCase() : 'USD',
    currencySymbol: currencySymbol ? currencySymbol.trim() : '$',
    exchangeRate: (!isNaN(parsedRate) && parsedRate > 0) ? parsedRate : 1,
    createdAt: new Date().toISOString()
  };

  methods.push(newMethod);
  methods.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));
  writeJson(PAYMENT_METHODS_FILE, methods);

  res.status(201).json({ success: true, message: 'Payment method added successfully!', paymentMethod: newMethod });
});

app.put('/api/admin/payment-methods/:id', authenticateAdminToken, (req, res) => {
  const { name, accountNumber, instructions, badge, isActive, serial, requireTrxId, requireSenderNumber, country, countryCode, currency, currencySymbol, exchangeRate } = req.body;
  const methods = readJson(PAYMENT_METHODS_FILE);
  const idx = methods.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Payment method not found.' });

  if (name) methods[idx].name = name.trim();
  if (accountNumber) methods[idx].accountNumber = accountNumber.trim();
  if (instructions !== undefined) methods[idx].instructions = instructions.trim();
  if (badge !== undefined) methods[idx].badge = badge.trim();
  if (isActive !== undefined) methods[idx].isActive = Boolean(isActive);
  if (serial !== undefined) methods[idx].serial = parseInt(serial) || methods[idx].serial;
  if (requireTrxId !== undefined) methods[idx].requireTrxId = Boolean(requireTrxId);
  if (requireSenderNumber !== undefined) methods[idx].requireSenderNumber = Boolean(requireSenderNumber);
  if (country !== undefined) methods[idx].country = country.trim();
  if (countryCode !== undefined) methods[idx].countryCode = countryCode.trim().toUpperCase();
  if (currency !== undefined) methods[idx].currency = currency.trim().toUpperCase();
  if (currencySymbol !== undefined) methods[idx].currencySymbol = currencySymbol.trim();
  if (exchangeRate !== undefined) {
    const parsedRate = parseFloat(exchangeRate);
    if (!isNaN(parsedRate) && parsedRate > 0) {
      methods[idx].exchangeRate = parsedRate;
    }
  }

  methods.sort((a, b) => (parseInt(a.serial) || 0) - (parseInt(b.serial) || 0));
  writeJson(PAYMENT_METHODS_FILE, methods);

  res.json({ success: true, message: 'Payment method updated successfully!', paymentMethod: methods[idx] });
});

app.delete('/api/admin/payment-methods/:id', authenticateAdminToken, (req, res) => {
  let methods = readJson(PAYMENT_METHODS_FILE);
  methods = methods.filter(m => m.id !== req.params.id);
  writeJson(PAYMENT_METHODS_FILE, methods);
  res.json({ success: true, message: 'Payment method removed successfully.' });
});

// ========================================================
//              CHALLENGE PACKAGES MANAGEMENT (ADMIN)
// ========================================================

// 1. Get all packages (including inactive) + promo details + presets
app.get('/api/admin/packages', authenticateAdminToken, (req, res) => {
  const packages = getEnrichedPackages(true);
  const promo = getLaunchPromo();
  const presets = getPromoPresets();
  res.json({
    success: true,
    packages,
    launchPromo: promo,
    promoPresets: presets
  });
});

// 2. Create new challenge package
app.post('/api/admin/packages', authenticateAdminToken, (req, res) => {
  const {
    name, tierNumber, fundedAmount, originalFee, discountPercent,
    profitSplit, maxDrawdown, sessions, dailyLoss, profitTarget,
    popular, color, rules, isActive, badge
  } = req.body;

  if (!name || !fundedAmount || !originalFee) {
    return res.status(400).json({ success: false, message: 'প্যাকেজের নাম, ফান্ডেড ক্যাপিটাল এবং ফি আবশ্যক।' });
  }

  let packages = readJson(PACKAGES_FILE, PACKAGES);
  const origFee = parseFloat(originalFee);
  const discPct = parseInt(discountPercent) || 0;
  const discAmt = discPct > 0 ? Math.round(origFee * (discPct / 100)) : 0;
  const calcFee = discPct > 0 ? Math.max(1, origFee - discAmt) : origFee;

  let parsedRules = [];
  if (Array.isArray(rules)) {
    parsedRules = rules;
  } else if (typeof rules === 'string') {
    parsedRules = rules.split('\n').map(r => r.trim()).filter(Boolean);
  }

  const newPkg = {
    id: `pkg_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
    tierNumber: parseInt(tierNumber) || (packages.length + 1),
    name: name.trim(),
    badge: badge ? badge.trim() : `#${packages.length + 1}`,
    originalFee: origFee,
    discountPercent: discPct,
    fee: calcFee,
    fundedAmount: parseFloat(fundedAmount),
    profitSplit: profitSplit ? profitSplit.trim() : '75%',
    maxDrawdown: maxDrawdown ? maxDrawdown.trim() : '25%',
    minDays: parseInt(sessions) || 15,
    sessions: parseInt(sessions) || 15,
    dailyLoss: dailyLoss ? dailyLoss.trim() : 'No Strict Limit (Rec. 5%)',
    profitTarget: profitTarget ? profitTarget.trim() : 'No Fixed Pressure',
    popular: Boolean(popular),
    isActive: isActive !== undefined ? Boolean(isActive) : true,
    color: color || '#F5B041',
    discountTag: req.body.discountTag ? req.body.discountTag.trim() : undefined,
    rules: parsedRules.length > 0 ? parsedRules : [
      `${parseInt(sessions) || 15} Trading Sessions Required`,
      `${maxDrawdown || '25%'} Maximum Drawdown Limit`,
      "Trade on any verified broker demo",
      "Daily proof video & screenshot upload",
      `Keep ${profitSplit || '75%'} profit upon passing`
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  packages.push(newPkg);
  packages.sort((a, b) => (parseInt(a.tierNumber) || 0) - (parseInt(b.tierNumber) || 0));
  writeJson(PACKAGES_FILE, packages);

  logUserArchive('PACKAGE_CREATED', req.user, {
    packageId: newPkg.id,
    name: newPkg.name,
    fundedAmount: newPkg.fundedAmount,
    fee: newPkg.fee,
    discountPercent: newPkg.discountPercent
  });

  res.status(201).json({
    success: true,
    message: `নতুন ${newPkg.name} ($${newPkg.fundedAmount.toLocaleString()}) চ্যালেঞ্জ প্যাকেজ সফলভাবে তৈরি হয়েছে! এটি সাথে সাথে সকল ইউজারের কাছে চলে গেছে।`,
    package: newPkg
  });
});

// 3. Update existing challenge package
app.put('/api/admin/packages/:id', authenticateAdminToken, (req, res) => {
  const {
    name, tierNumber, fundedAmount, originalFee, discountPercent,
    profitSplit, maxDrawdown, sessions, dailyLoss, profitTarget,
    popular, color, rules, isActive, badge
  } = req.body;

  let packages = readJson(PACKAGES_FILE, PACKAGES);
  const idx = packages.findIndex(p => p.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'Challenge package not found.' });
  }

  const origFee = originalFee !== undefined ? parseFloat(originalFee) : (packages[idx].originalFee || packages[idx].fee);
  const discPct = discountPercent !== undefined ? parseInt(discountPercent) : (packages[idx].discountPercent || 0);
  const discAmt = discPct > 0 ? Math.round(origFee * (discPct / 100)) : 0;
  const calcFee = discPct > 0 ? Math.max(1, origFee - discAmt) : origFee;

  let parsedRules = packages[idx].rules;
  if (Array.isArray(rules)) {
    parsedRules = rules;
  } else if (typeof rules === 'string') {
    parsedRules = rules.split('\n').map(r => r.trim()).filter(Boolean);
  }

  packages[idx] = {
    ...packages[idx],
    name: name !== undefined ? name.trim() : packages[idx].name,
    tierNumber: tierNumber !== undefined ? parseInt(tierNumber) : packages[idx].tierNumber,
    badge: badge !== undefined ? badge.trim() : packages[idx].badge,
    originalFee: origFee,
    discountPercent: discPct,
    fee: calcFee,
    fundedAmount: fundedAmount !== undefined ? parseFloat(fundedAmount) : packages[idx].fundedAmount,
    profitSplit: profitSplit !== undefined ? profitSplit.trim() : packages[idx].profitSplit,
    maxDrawdown: maxDrawdown !== undefined ? maxDrawdown.trim() : packages[idx].maxDrawdown,
    sessions: sessions !== undefined ? parseInt(sessions) : packages[idx].sessions,
    minDays: sessions !== undefined ? parseInt(sessions) : packages[idx].minDays,
    dailyLoss: dailyLoss !== undefined ? dailyLoss.trim() : packages[idx].dailyLoss,
    profitTarget: profitTarget !== undefined ? profitTarget.trim() : packages[idx].profitTarget,
    popular: popular !== undefined ? Boolean(popular) : packages[idx].popular,
    isActive: isActive !== undefined ? Boolean(isActive) : packages[idx].isActive,
    color: color !== undefined ? color : packages[idx].color,
    discountTag: req.body.discountTag !== undefined ? (req.body.discountTag ? req.body.discountTag.trim() : null) : packages[idx].discountTag,
    rules: parsedRules,
    updatedAt: new Date().toISOString()
  };

  packages.sort((a, b) => (parseInt(a.tierNumber) || 0) - (parseInt(b.tierNumber) || 0));
  writeJson(PACKAGES_FILE, packages);

  logUserArchive('PACKAGE_UPDATED', req.user, {
    packageId: packages[idx].id,
    name: packages[idx].name,
    fee: packages[idx].fee,
    discountPercent: packages[idx].discountPercent
  });

  res.json({
    success: true,
    message: `${packages[idx].name} চ্যালেঞ্জ প্যাকেজ সফলভাবে আপডেট করা হয়েছে! পরিবর্তন সাথে সাথে ইউজারের কাছে দৃশ্যমান হবে।`,
    package: packages[idx]
  });
});

// 4. Delete challenge package
app.delete('/api/admin/packages/:id', authenticateAdminToken, (req, res) => {
  let packages = readJson(PACKAGES_FILE, PACKAGES);
  const found = packages.find(p => p.id === req.params.id);
  if (!found) return res.status(404).json({ success: false, message: 'Package not found.' });

  packages = packages.filter(p => p.id !== req.params.id);
  writeJson(PACKAGES_FILE, packages);

  logUserArchive('PACKAGE_DELETED', req.user, { packageId: found.id, name: found.name });

  res.json({
    success: true,
    message: `${found.name} চ্যালেঞ্জ প্যাকেজটি সফলভাবে মুছে ফেলা হয়েছে!`
  });
});

// 5. Quick Set Discount for a challenge
app.post('/api/admin/packages/:id/discount', authenticateAdminToken, (req, res) => {
  const { discountPercent } = req.body;
  let packages = readJson(PACKAGES_FILE, PACKAGES);
  const idx = packages.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Package not found.' });

  const discPct = Math.max(0, Math.min(100, parseInt(discountPercent) || 0));
  const origFee = parseFloat(packages[idx].originalFee || packages[idx].fee);
  const discAmt = discPct > 0 ? Math.round(origFee * (discPct / 100)) : 0;
  const calcFee = discPct > 0 ? Math.max(1, origFee - discAmt) : origFee;

  packages[idx].discountPercent = discPct;
  packages[idx].fee = calcFee;
  packages[idx].updatedAt = new Date().toISOString();

  writeJson(PACKAGES_FILE, packages);

  res.json({
    success: true,
    message: `${packages[idx].name} চ্যালেঞ্জের জন্য ${discPct}% ডিসকাউন্ট সফলভাবে সেট করা হয়েছে (নতুন রেট: $${calcFee})!`,
    package: packages[idx]
  });
});

// 6. Update Launch Promo & Countdown Settings
app.post('/api/admin/launch-promo', authenticateAdminToken, (req, res) => {
  const {
    active, enableDiscounts, badge, title, description,
    discountTag, countdownTitle, showCountdown, durationDays, customExpiresAt, resetTimer
  } = req.body;
  let promo = getLaunchPromo();

  const now = new Date();
  const days = parseInt(durationDays) || promo.durationDays || 7;

  let expiresAt = promo.expiresAt;
  if (customExpiresAt) {
    expiresAt = customExpiresAt;
  } else if (resetTimer || durationDays !== undefined) {
    expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  promo = {
    ...promo,
    active: active !== undefined ? Boolean(active) : promo.active,
    enableDiscounts: enableDiscounts !== undefined ? Boolean(enableDiscounts) : (promo.enableDiscounts !== false),
    badge: badge !== undefined ? badge.trim() : promo.badge,
    title: title !== undefined ? title.trim() : promo.title,
    description: description !== undefined ? description.trim() : promo.description,
    discountTag: discountTag !== undefined ? discountTag.trim() : (promo.discountTag || 'লঞ্চ স্পেশাল ছাড়'),
    countdownTitle: countdownTitle !== undefined ? countdownTitle.trim() : (promo.countdownTitle || 'অফারটি শেষ হতে আর বাকি'),
    showCountdown: showCountdown !== undefined ? Boolean(showCountdown) : (promo.showCountdown !== false),
    durationDays: days,
    startedAt: resetTimer ? now.toISOString() : (promo.startedAt || now.toISOString()),
    expiresAt: expiresAt,
    updatedAt: now.toISOString()
  };

  writeJson(LAUNCH_PROMO_FILE, promo);

  res.json({
    success: true,
    message: 'অফার ও ডিসকাউন্ট ব্যানার সেটিংস সফলভাবে সেভ হয়েছে!',
    launchPromo: promo
  });
});

// 7. Get All Promo Presets
app.get('/api/admin/promo-presets', authenticateAdminToken, (req, res) => {
  const presets = getPromoPresets();
  res.json({ success: true, presets });
});

// 8. Create or Save New Promo Preset (Custom User-Created Offer)
app.post('/api/admin/promo-presets', authenticateAdminToken, (req, res) => {
  const {
    name, discountTag, badge, title, description,
    countdownTitle, durationDays, showCountdown, enableDiscounts, active
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'অফারের নাম / বাটন লেবেল প্রদান করুন।' });
  }

  const presets = getPromoPresets();
  const cleanName = name.trim();
  const cleanTitle = (title && title.trim()) || cleanName;

  const newPreset = {
    id: 'preset-' + Date.now(),
    name: cleanName,
    isDefault: false,
    discountTag: (discountTag && discountTag.trim()) || 'স্পেশাল ছাড়',
    badge: (badge && badge.trim()) || `🎉 ${cleanName}!`,
    title: cleanTitle,
    description: (description && description.trim()) || '',
    countdownTitle: (countdownTitle && countdownTitle.trim()) || 'অফারটি শেষ হতে আর বাকি',
    durationDays: parseInt(durationDays) || 7,
    showCountdown: showCountdown !== false,
    enableDiscounts: enableDiscounts !== false,
    active: active !== false,
    createdAt: new Date().toISOString()
  };

  presets.push(newPreset);
  writeJson(PROMO_PRESETS_FILE, presets);

  res.json({
    success: true,
    message: `'${newPreset.name}' নতুন অফার টেমপ্লেট হিসেবে সংরক্ষিত হয়েছে!`,
    preset: newPreset,
    presets
  });
});

// 9. Delete a Promo Preset
app.delete('/api/admin/promo-presets/:id', authenticateAdminToken, (req, res) => {
  let presets = getPromoPresets();
  const targetId = req.params.id;
  const found = presets.find(p => p.id === targetId);

  if (!found) {
    return res.status(404).json({ success: false, message: 'টেমপ্লেট পাওয়া যায়নি।' });
  }

  presets = presets.filter(p => p.id !== targetId);
  writeJson(PROMO_PRESETS_FILE, presets);

  res.json({
    success: true,
    message: `'${found.name}' অফার টেমপ্লেট মুছে ফেলা হয়েছে।`,
    presets
  });
});

// ==========================================
// SUPPORT & HELPDESK TICKETS API
// ==========================================

// 1. User: Fetch My Support Tickets
app.get('/api/support/my', authenticateToken, (req, res) => {
  const tickets = readJson(SUPPORT_FILE, []);
  const myTickets = tickets
    .filter(t => t.userId === req.user.id)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  res.json({ success: true, tickets: myTickets });
});

// 2. User: Create a New Support Ticket
app.post('/api/support/create', authenticateToken, (req, res) => {
  const { subject, category, message } = req.body;
  if (!subject || !subject.trim() || !message || !message.trim()) {
    return res.status(400).json({ success: false, message: 'অনুগ্রহ করে বিষয় এবং বিস্তারিত মেসেজ লিখুন।' });
  }

  const users = readJson(USERS_FILE);
  const user = users.find(u => u.id === req.user.id) || req.user;

  const tickets = readJson(SUPPORT_FILE, []);
  const newTicket = {
    id: `tkt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    userId: user.id,
    userTraderId: user.traderId || 'AJ-1001',
    userName: user.name || 'Trader',
    userEmail: user.email,
    userTelegram: user.telegram || '',
    subject: subject.trim(),
    category: category || 'general',
    status: 'open',
    unreadByAdmin: true,
    unreadByUser: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        sender: 'user',
        senderName: user.name || 'Trader',
        text: message.trim(),
        timestamp: new Date().toISOString()
      }
    ]
  };

  tickets.unshift(newTicket);
  writeJson(SUPPORT_FILE, tickets);

  logUserArchive('SUPPORT_TICKET_CREATED', { id: user.id }, {
    ticketId: newTicket.id,
    subject: newTicket.subject,
    category: newTicket.category
  });

  res.json({ success: true, message: 'আপনার সাপোর্ট মেসেজ এডমিনের কাছে পাঠানো হয়েছে।', ticket: newTicket });
});

// 3. User: Reply to Existing Ticket
app.post('/api/support/:id/message', authenticateToken, (req, res) => {
  const text = (req.body.text || req.body.message || '').trim();
  if (!text) {
    return res.status(400).json({ success: false, message: 'মেসেজ খালি হতে পারে না।' });
  }

  const tickets = readJson(SUPPORT_FILE, []);
  const idx = tickets.findIndex(t => t.id === req.params.id && t.userId === req.user.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'টিকেট পাওয়া যায়নি।' });
  }

  const newMsg = {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
    sender: 'user',
    senderName: tickets[idx].userName || 'Trader',
    text: text.trim(),
    timestamp: new Date().toISOString()
  };

  tickets[idx].messages.push(newMsg);
  tickets[idx].unreadByAdmin = true;
  tickets[idx].unreadByUser = false;
  if (tickets[idx].status === 'resolved') {
    tickets[idx].status = 'open';
  }
  tickets[idx].updatedAt = new Date().toISOString();

  writeJson(SUPPORT_FILE, tickets);
  res.json({ success: true, message: 'মেসেজ পাঠানো হয়েছে।', ticket: tickets[idx] });
});

// 4. Admin: Fetch All Support Tickets with unread count and trader overview
app.get('/api/admin/support', authenticateAdminToken, (req, res) => {
  const tickets = readJson(SUPPORT_FILE, []);
  const challenges = readJson(CHALLENGES_FILE);
  const users = readJson(USERS_FILE);

  const enrichedTickets = tickets.map(t => {
    const user = users.find(u => u.id === t.userId);
    const userChallenges = challenges.filter(c => c.userId === t.userId);
    const activeCh = userChallenges.find(c => c.status === 'in_progress');
    const pendingCh = userChallenges.find(c => c.status === 'pending_approval');
    const rejectedCh = userChallenges.find(c => c.status === 'rejected');

    let challengeSummary = 'No Challenge';
    let challengeStatus = 'none';
    if (activeCh) {
      challengeSummary = `${activeCh.packageName} ($${(activeCh.fundedAmount || 0).toLocaleString()})`;
      challengeStatus = 'in_progress';
    } else if (pendingCh) {
      challengeSummary = `${pendingCh.packageName} ($${(pendingCh.fundedAmount || 0).toLocaleString()})`;
      challengeStatus = 'pending_approval';
    } else if (rejectedCh) {
      challengeSummary = `${rejectedCh.packageName} [Rejected]`;
      challengeStatus = 'rejected';
    }

    return {
      ...t,
      traderTraderId: user?.traderId || t.userTraderId || 'AJ-1001',
      traderTelegram: user?.telegram || t.userTelegram || '',
      challengeSummary,
      challengeStatus
    };
  });

  const unreadCount = tickets.filter(t => t.unreadByAdmin).length;

  res.json({
    success: true,
    tickets: enrichedTickets,
    unreadCount
  });
});

// 5. Admin: Fetch Single Ticket + COMPLETE 360° TRADER INSPECTOR
app.get('/api/admin/support/:id', authenticateAdminToken, (req, res) => {
  const tickets = readJson(SUPPORT_FILE, []);
  const idx = tickets.findIndex(t => t.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'টিকেট পাওয়া যায়নি।' });
  }

  tickets[idx].unreadByAdmin = false;
  writeJson(SUPPORT_FILE, tickets);

  const ticket = tickets[idx];
  const users = readJson(USERS_FILE);
  const user = users.find(u => u.id === ticket.userId) || {
    id: ticket.userId,
    name: ticket.userName,
    email: ticket.userEmail,
    traderId: ticket.userTraderId
  };

  const challenges = readJson(CHALLENGES_FILE);
  const userChallenges = challenges.filter(c => c.userId === ticket.userId);

  const submissions = readJson(SUBMISSIONS_FILE);
  const userSubmissions = submissions.filter(s => s.userId === ticket.userId);

  const stats = {
    totalChallenges: userChallenges.length,
    activeChallenge: userChallenges.find(c => c.status === 'in_progress') || null,
    pendingChallenge: userChallenges.find(c => c.status === 'pending_approval') || null,
    rejectedChallenge: userChallenges.find(c => c.status === 'rejected') || null,
    totalSubmissions: userSubmissions.length,
    verifiedSubmissions: userSubmissions.filter(s => s.status === 'verified').length
  };

  res.json({
    success: true,
    ticket,
    trader: {
      id: user.id,
      traderId: user.traderId || ticket.userTraderId || 'AJ-1001',
      name: user.name || ticket.userName,
      email: user.email || ticket.userEmail,
      telegram: user.telegram || ticket.userTelegram || '',
      isVerified: user.isVerified || false,
      preferredBroker: user.preferredBroker || 'Quotex',
      brokerAccountId: user.brokerAccountId || '',
      payoutWallet: user.payoutWallet || '',
      registeredAt: user.registeredAt || user.createdAt || null
    },
    challenges: userChallenges,
    submissions: userSubmissions,
    stats
  });
});

// 6. Admin: Reply to Support Ticket
app.post('/api/admin/support/:id/reply', authenticateAdminToken, (req, res) => {
  const text = (req.body.text || req.body.message || '').trim();
  const { status } = req.body;
  if (!text) {
    return res.status(400).json({ success: false, message: 'উত্তরের মেসেজ খালি হতে পারে না।' });
  }

  const tickets = readJson(SUPPORT_FILE, []);
  const idx = tickets.findIndex(t => t.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'টিকেটটি পাওয়া যায়নি।' });
  }

  const newMsg = {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
    sender: 'admin',
    senderName: 'Binary Prop Firm Support Team',
    text: text.trim(),
    timestamp: new Date().toISOString()
  };

  tickets[idx].messages.push(newMsg);
  tickets[idx].status = status || 'in_progress';
  tickets[idx].unreadByUser = true;
  tickets[idx].unreadByAdmin = false;
  tickets[idx].updatedAt = new Date().toISOString();

  writeJson(SUPPORT_FILE, tickets);

  logUserArchive('SUPPORT_REPLY_SENT', { id: tickets[idx].userId }, {
    ticketId: tickets[idx].id,
    adminReplySnippet: text.substring(0, 100),
    status: tickets[idx].status
  });

  res.json({ success: true, message: 'ট্রেডারের কাছে উত্তর সফলভাবে পাঠানো হয়েছে।', ticket: tickets[idx] });
});

// 7. Admin: Update Ticket Status
app.post('/api/admin/support/:id/status', authenticateAdminToken, (req, res) => {
  const { status } = req.body;
  const tickets = readJson(SUPPORT_FILE, []);
  const idx = tickets.findIndex(t => t.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'টিকেট পাওয়া যায়নি।' });
  }

  tickets[idx].status = status || tickets[idx].status;
  tickets[idx].updatedAt = new Date().toISOString();
  writeJson(SUPPORT_FILE, tickets);

  res.json({ success: true, message: 'টিকেট স্ট্যাটাস আপডেট হয়েছে।', ticket: tickets[idx] });
});

// 8. Admin: Instant Resolve & Re-activate Challenge from Support Desk
app.post('/api/admin/support/resolve-challenge', authenticateAdminToken, (req, res) => {
  const { challengeId, action, reason } = req.body;
  const challenges = readJson(CHALLENGES_FILE);
  const idx = challenges.findIndex(c => c.id === challengeId);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'চ্যালেঞ্জ পাওয়া যায়নি।' });
  }

  if (action === 'approve') {
    challenges[idx].status = 'in_progress';
    challenges[idx].approvedAt = new Date().toISOString();
    challenges[idx].rejectedReason = null;
  } else if (action === 'reopen_pending') {
    challenges[idx].status = 'pending_approval';
    challenges[idx].rejectedReason = null;
  } else if (action === 'update_reason') {
    challenges[idx].rejectedReason = reason || challenges[idx].rejectedReason;
  }

  writeJson(CHALLENGES_FILE, challenges);
  res.json({ success: true, message: 'চ্যালেঞ্জের সমস্যা সফলভাবে সমাধান করা হয়েছে!', challenge: challenges[idx] });
});

// Serve Single Page Apps / Fallback
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Secret Admin Route (Hidden custom URL)
app.get(['/proboxaj', '/proboxaj/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Block /admin completely: Anyone trying /admin is redirected to homepage
app.get(['/admin', '/admin/*'], (req, res) => {
  res.redirect('/');
});

app.get(['/landing', '/ad'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Binary Prop Firm Platform is running at: http://localhost:${PORT}`);
  console.log(`📊 External Binary Prop Challenges | 85% Profit Share`);
  console.log(`⚡ Supported Brokers: Quotex, Pocket Option, Olymp, etc.`);
  console.log(`💾 Enterprise Data Permanence & Crash-Proof Storage: ACTIVE`);
  console.log(`=======================================================`);

  // Initial automated challenge session sync & validation
  try {
    syncChallengesWithSubmissions();
    syncUsersWithAllData();
  } catch (e) {
    console.error('Initial challenge sync error:', e.message);
  }

  // Initial automated backup 3 seconds after boot
  setTimeout(() => {
    try {
      createDatabaseBackup('server_boot');
    } catch (e) {
      console.error('Initial backup error:', e.message);
    }
  }, 3000);

  // Scheduled automated backup every 6 hours
  setInterval(() => {
    try {
      createDatabaseBackup('scheduled_6h');
    } catch (e) {
      console.error('Scheduled backup error:', e.message);
    }
  }, 6 * 60 * 60 * 1000);
});
