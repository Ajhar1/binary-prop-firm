/**
 * Enterprise MySQL Database Connection & Data Access Layer
 * Supports:
 * 1. Native mysql2/promise Connection Pool using process.env
 * 2. Automatic non-destructive schema migration (CREATE TABLE IF NOT EXISTS)
 * 3. Automatic JSON-to-MySQL initial data migration
 * 4. Dual-mode fallback: If MySQL is not configured (e.g. local dev), falls back safely to JSON store
 * 5. Double Safety Mirroring: Writes to MySQL as primary and mirrors to permanent JSON vault
 */

let mysql = null;
try {
  mysql = require('mysql2/promise');
} catch (e) {
  // mysql2 not installed in this environment; fallback to local safe store
}
const fs = require('fs');
const path = require('path');

const DB_HOST = process.env.DB_HOST || '';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_DATABASE = process.env.DB_DATABASE || process.env.DB_NAME || '';
const DB_USERNAME = process.env.DB_USERNAME || process.env.DB_USER || '';
const DB_PASSWORD = process.env.DB_PASSWORD || process.env.DB_PASS || '';

let pool = null;
let isConnected = false;

function isMySqlConfigured() {
  return Boolean(mysql && DB_HOST && DB_DATABASE && DB_USERNAME);
}

function isMySqlActive() {
  return isConnected && pool !== null;
}

async function initDatabase() {
  if (!isMySqlConfigured()) {
    console.log('[DATABASE] MySQL environment variables not detected (DB_HOST/DB_DATABASE/DB_USERNAME). Operating in Local Safe Store mode.');
    return false;
  }

  try {
    console.log(`[DATABASE] Connecting to MySQL at ${DB_HOST}:${DB_PORT}, database: ${DB_DATABASE}...`);
    pool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USERNAME,
      password: DB_PASSWORD,
      database: DB_DATABASE,
      waitForConnections: true,
      connectionLimit: 50,
      maxIdle: 20,
      idleTimeout: 60000,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000
    });

    // Test connection
    const connection = await pool.getConnection();
    console.log('[DATABASE] ✅ Successfully connected to MySQL database on Hostinger!');
    connection.release();
    isConnected = true;

    // Initialize Schema safely
    await initSchema();

    // Auto-migrate existing JSON data into MySQL if tables are empty
    await autoMigrateFromJson();

    return true;
  } catch (err) {
    console.error('[DATABASE ERROR] Failed to connect to MySQL:', err.message);
    console.warn('[DATABASE WARNING] Falling back gracefully to Local Secure Store mode.');
    isConnected = false;
    pool = null;
    return false;
  }
}

// Create tables safely if they do not exist
async function initSchema() {
  if (!isMySqlActive()) return;

  const queries = [
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(120) PRIMARY KEY,
      traderId VARCHAR(60) DEFAULT NULL,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(50) DEFAULT 'user',
      telegram VARCHAR(100) DEFAULT '',
      preferredBroker VARCHAR(100) DEFAULT '',
      payoutWallet VARCHAR(255) DEFAULT '',
      brokerAccountId VARCHAR(100) DEFAULT '',
      profilePicture LONGTEXT DEFAULT NULL,
      isEmailVerified TINYINT(1) DEFAULT 0,
      emailVerificationCode VARCHAR(100) DEFAULT NULL,
      emailVerificationExpires DATETIME DEFAULT NULL,
      emailVerifiedAt DATETIME DEFAULT NULL,
      adminSecurityPin VARCHAR(50) DEFAULT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      extraData JSON DEFAULT NULL,
      INDEX idx_user_email (email),
      INDEX idx_user_trader_id (traderId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS challenges (
      id VARCHAR(120) PRIMARY KEY,
      userId VARCHAR(120) NOT NULL,
      userName VARCHAR(255) DEFAULT '',
      userEmail VARCHAR(255) DEFAULT '',
      userTraderId VARCHAR(60) DEFAULT '',
      userTelegram VARCHAR(100) DEFAULT '',
      userBroker VARCHAR(100) DEFAULT '',
      packageId VARCHAR(100) DEFAULT '',
      packageName VARCHAR(100) DEFAULT '',
      originalFee DECIMAL(12,2) DEFAULT 0,
      fee DECIMAL(12,2) DEFAULT 0,
      discountPercent INT DEFAULT 0,
      hasDiscount TINYINT(1) DEFAULT 0,
      fundedAmount DECIMAL(12,2) DEFAULT 0,
      profitSplit VARCHAR(30) DEFAULT '75%',
      maxDrawdown VARCHAR(30) DEFAULT '25%',
      brokerId VARCHAR(100) DEFAULT '',
      brokerName VARCHAR(100) DEFAULT '',
      brokerIcon TEXT DEFAULT NULL,
      brokerAccountId VARCHAR(100) DEFAULT '',
      status VARCHAR(50) DEFAULT 'pending_approval',
      sessionsRequired INT DEFAULT 15,
      sessionsCompleted INT DEFAULT 0,
      currentDrawdown VARCHAR(30) DEFAULT '0.0%',
      paymentMethod VARCHAR(120) DEFAULT '',
      paymentTxId VARCHAR(255) DEFAULT '',
      senderNumber VARCHAR(100) DEFAULT '',
      currency VARCHAR(30) DEFAULT 'USD',
      currencySymbol VARCHAR(10) DEFAULT '$',
      exchangeRate DECIMAL(12,2) DEFAULT 1,
      localAmount DECIMAL(12,2) DEFAULT 0,
      assignedMmId VARCHAR(100) DEFAULT NULL,
      assignedMmSerial INT DEFAULT NULL,
      assignedMmTitle VARCHAR(255) DEFAULT NULL,
      assignedMmUrl TEXT DEFAULT NULL,
      assignedMmNote TEXT DEFAULT NULL,
      approvedAt DATETIME DEFAULT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      durationDays INT DEFAULT 15,
      challengePhase VARCHAR(50) DEFAULT 'practice',
      expiresAt DATETIME DEFAULT NULL,
      practiceSessionsCompleted INT DEFAULT 0,
      verifiedSessionsCount INT DEFAULT 0,
      totalSubmissionsCount INT DEFAULT 0,
      practiceHours INT DEFAULT 48,
      practiceStartedAt DATETIME DEFAULT NULL,
      practiceExpiresAt DATETIME DEFAULT NULL,
      practiceMaxSessions INT DEFAULT 3,
      isActive TINYINT(1) DEFAULT 1,
      isCompleted TINYINT(1) DEFAULT 0,
      evaluationStartedAt DATETIME DEFAULT NULL,
      practiceSkippedAt DATETIME DEFAULT NULL,
      reactivatedAt DATETIME DEFAULT NULL,
      reactivationNotice JSON DEFAULT NULL,
      failReason VARCHAR(120) DEFAULT NULL,
      violatedRule TEXT DEFAULT NULL,
      failReasonText TEXT DEFAULT NULL,
      failedAt DATETIME DEFAULT NULL,
      rawChallengeData JSON DEFAULT NULL,
      INDEX idx_ch_user (userId),
      INDEX idx_ch_status (status),
      INDEX idx_ch_email (userEmail)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS submissions (
      id VARCHAR(120) PRIMARY KEY,
      userId VARCHAR(120) NOT NULL,
      challengeId VARCHAR(120) NOT NULL,
      packageName VARCHAR(100) DEFAULT '',
      isPractice TINYINT(1) DEFAULT 0,
      sessionType VARCHAR(50) DEFAULT 'evaluation',
      practiceSessionNumber INT DEFAULT 0,
      brokerName VARCHAR(100) DEFAULT '',
      sessionDate VARCHAR(60) DEFAULT '',
      winTrades INT DEFAULT 0,
      lossTrades INT DEFAULT 0,
      tradesCount INT DEFAULT 0,
      profitLoss DECIMAL(12,2) DEFAULT 0,
      winRate VARCHAR(30) DEFAULT '0.0%',
      videoUrl TEXT DEFAULT NULL,
      screenshotUrl TEXT DEFAULT NULL,
      fileType VARCHAR(50) DEFAULT 'none',
      isCloudHosted TINYINT(1) DEFAULT 0,
      cloudProvider VARCHAR(100) DEFAULT '',
      notes TEXT DEFAULT NULL,
      status VARCHAR(50) DEFAULT 'under_review',
      adminFeedback TEXT DEFAULT NULL,
      submittedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewedAt DATETIME DEFAULT NULL,
      userTraderId VARCHAR(60) DEFAULT '',
      userName VARCHAR(255) DEFAULT '',
      userEmail VARCHAR(255) DEFAULT '',
      userTelegram VARCHAR(100) DEFAULT '',
      userAvatar TEXT DEFAULT NULL,
      forgivenOnReactivation TINYINT(1) DEFAULT 0,
      reactivatedAt DATETIME DEFAULT NULL,
      resubmissionRequestedAt DATETIME DEFAULT NULL,
      rawSubmissionData JSON DEFAULT NULL,
      INDEX idx_sub_ch (challengeId),
      INDEX idx_sub_user (userId),
      INDEX idx_sub_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS user_archive (
      archiveId VARCHAR(120) PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      displayTime VARCHAR(100) DEFAULT '',
      action VARCHAR(120) NOT NULL,
      userId VARCHAR(120) DEFAULT '',
      userName VARCHAR(255) DEFAULT '',
      userEmail VARCHAR(255) DEFAULT '',
      telegram VARCHAR(100) DEFAULT '',
      preferredBroker VARCHAR(100) DEFAULT '',
      brokerAccountId VARCHAR(100) DEFAULT '',
      payoutWallet VARCHAR(255) DEFAULT '',
      isEmailVerified TINYINT(1) DEFAULT 0,
      metadata JSON DEFAULT NULL,
      INDEX idx_arc_user (userId),
      INDEX idx_arc_action (action)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS support_tickets (
      id VARCHAR(120) PRIMARY KEY,
      userId VARCHAR(120) NOT NULL,
      userName VARCHAR(255) DEFAULT '',
      userEmail VARCHAR(255) DEFAULT '',
      userTraderId VARCHAR(60) DEFAULT '',
      subject VARCHAR(255) DEFAULT '',
      category VARCHAR(100) DEFAULT 'general',
      status VARCHAR(50) DEFAULT 'open',
      priority VARCHAR(50) DEFAULT 'medium',
      messages JSON DEFAULT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tkt_user (userId),
      INDEX idx_tkt_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS synced_trades (
      id VARCHAR(120) PRIMARY KEY,
      userId VARCHAR(120) NOT NULL,
      broker VARCHAR(100) DEFAULT 'quotex',
      brokerAccountId VARCHAR(100) DEFAULT '',
      tradeData JSON DEFAULT NULL,
      syncedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_synced_user (userId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS trader_states (
      userId VARCHAR(120) PRIMARY KEY,
      stateData JSON DEFAULT NULL,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS partners (
      id VARCHAR(120) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      phone VARCHAR(100) DEFAULT '',
      promoCode VARCHAR(100) DEFAULT '',
      commissionRate INT DEFAULT 10,
      traderDiscount INT DEFAULT 5,
      payoutMethod VARCHAR(100) DEFAULT 'Binance Pay',
      payoutDetails VARCHAR(255) DEFAULT '',
      status VARCHAR(50) DEFAULT 'active',
      isEmailVerified TINYINT(1) DEFAULT 0,
      emailVerificationCode VARCHAR(100) DEFAULT NULL,
      emailVerificationExpires DATETIME DEFAULT NULL,
      emailVerifiedAt DATETIME DEFAULT NULL,
      role VARCHAR(50) DEFAULT 'partner',
      totalReferred INT DEFAULT 0,
      totalSales INT DEFAULT 0,
      totalCommissionEarned DECIMAL(12,2) DEFAULT 0,
      totalCommissionPaid DECIMAL(12,2) DEFAULT 0,
      pendingCommission DECIMAL(12,2) DEFAULT 0,
      notes TEXT DEFAULT NULL,
      useCustomRate TINYINT(1) DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      customLinks JSON DEFAULT NULL,
      rawPartnerData LONGTEXT DEFAULT NULL,
      INDEX idx_partner_email (email),
      INDEX idx_partner_code (promoCode)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS promo_codes (
      id VARCHAR(120) PRIMARY KEY,
      code VARCHAR(100) NOT NULL UNIQUE,
      discountType VARCHAR(50) DEFAULT 'percentage',
      discountValue DECIMAL(10,2) DEFAULT 0,
      packageId VARCHAR(100) DEFAULT 'all',
      packageIds JSON DEFAULT NULL,
      maxUses INT DEFAULT NULL,
      usedCount INT DEFAULT 0,
      expiresAt DATETIME DEFAULT NULL,
      status VARCHAR(50) DEFAULT 'active',
      notes TEXT DEFAULT NULL,
      isPartnerCode TINYINT(1) DEFAULT 0,
      partnerId VARCHAR(120) DEFAULT NULL,
      partnerName VARCHAR(255) DEFAULT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      rawPromoData JSON DEFAULT NULL,
      INDEX idx_promo_code (code),
      INDEX idx_promo_partner (partnerId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS partner_payouts (
      id VARCHAR(120) PRIMARY KEY,
      partnerId VARCHAR(120) NOT NULL,
      partnerName VARCHAR(255) DEFAULT '',
      partnerEmail VARCHAR(255) DEFAULT '',
      partnerPromoCode VARCHAR(100) DEFAULT '',
      amount DECIMAL(12,2) DEFAULT 0,
      paymentMethod VARCHAR(100) DEFAULT 'Binance Pay',
      payoutAddress VARCHAR(255) DEFAULT '',
      status VARCHAR(50) DEFAULT 'pending',
      adminNotes TEXT DEFAULT NULL,
      rejectionReason TEXT DEFAULT NULL,
      transactionProofUrl TEXT DEFAULT NULL,
      requestedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      paidAt DATETIME DEFAULT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      rawPayoutData JSON DEFAULT NULL,
      INDEX idx_pp_partner (partnerId),
      INDEX idx_pp_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS partner_settings (
      id VARCHAR(60) PRIMARY KEY DEFAULT 'default',
      settingsData JSON DEFAULT NULL,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS partner_promo_requests (
      id VARCHAR(120) PRIMARY KEY,
      partnerId VARCHAR(120) NOT NULL,
      partnerName VARCHAR(255) DEFAULT '',
      partnerEmail VARCHAR(255) DEFAULT '',
      promoCode VARCHAR(100) DEFAULT '',
      requestedDiscount INT DEFAULT 5,
      status VARCHAR(50) DEFAULT 'pending',
      adminFeedback TEXT DEFAULT NULL,
      requestedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewedAt DATETIME DEFAULT NULL,
      rawRequestData JSON DEFAULT NULL,
      INDEX idx_pr_partner (partnerId),
      INDEX idx_pr_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS payouts (
      id VARCHAR(120) PRIMARY KEY,
      userId VARCHAR(120) DEFAULT '',
      payoutId VARCHAR(120) DEFAULT '',
      amount DECIMAL(12,2) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'pending',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      rawPayoutData JSON DEFAULT NULL,
      INDEX idx_payout_user (userId),
      INDEX idx_payout_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS payout_settings (
      id VARCHAR(60) PRIMARY KEY DEFAULT 'default',
      settingsData JSON DEFAULT NULL,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS launch_promo (
      id VARCHAR(60) PRIMARY KEY DEFAULT 'default',
      promoData JSON DEFAULT NULL,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

    `CREATE TABLE IF NOT EXISTS promo_presets (
      id VARCHAR(60) PRIMARY KEY DEFAULT 'default',
      presetsData JSON DEFAULT NULL,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
  ];

  for (const q of queries) {
    await pool.query(q);
  }

  // Non-destructive addition of partner referral columns to challenges table
  try {
    const alterColumns = [
      "ALTER TABLE challenges ADD COLUMN partnerId VARCHAR(120) DEFAULT NULL",
      "ALTER TABLE challenges ADD COLUMN partnerName VARCHAR(255) DEFAULT NULL",
      "ALTER TABLE challenges ADD COLUMN partnerPromoCode VARCHAR(100) DEFAULT NULL",
      "ALTER TABLE challenges ADD COLUMN partnerCommissionRate INT DEFAULT 0",
      "ALTER TABLE challenges ADD COLUMN partnerCommission DECIMAL(12,2) DEFAULT 0",
      "ALTER TABLE challenges ADD COLUMN partnerCommissionStatus VARCHAR(50) DEFAULT NULL",
      "ALTER TABLE challenges ADD COLUMN promoCode VARCHAR(100) DEFAULT NULL",
      "ALTER TABLE partners ADD COLUMN customLinks JSON DEFAULT NULL",
      "ALTER TABLE partners ADD COLUMN wallets JSON DEFAULT NULL",
      "ALTER TABLE partners ADD COLUMN telegram VARCHAR(100) DEFAULT ''",
      "ALTER TABLE partners ADD COLUMN telegramData JSON DEFAULT NULL",
      "ALTER TABLE partners ADD COLUMN country VARCHAR(100) DEFAULT ''",
      "ALTER TABLE partners ADD COLUMN balanceAdjustment DECIMAL(12,2) DEFAULT 0",
      "ALTER TABLE partners ADD COLUMN rawPartnerData LONGTEXT DEFAULT NULL",
      "ALTER TABLE partner_payouts ADD COLUMN rawPayoutData LONGTEXT DEFAULT NULL",
      "ALTER TABLE partner_promo_requests ADD COLUMN rawRequestData LONGTEXT DEFAULT NULL"
    ];
    for (const ac of alterColumns) {
      try {
        await pool.query(ac);
      } catch (colErr) {
        // Ignore column already exists error (ER_DUP_FIELDNAME / 1060)
        if (!colErr.message.includes('Duplicate column') && !colErr.message.includes('already exists')) {
          // Silent or info log
        }
      }
    }
  } catch (altErr) {
    // Non-fatal, rawChallengeData JSON preserves all extra columns regardless
  }
  console.log('[DATABASE] ✅ Database schema verified and ready.');
}

// Convert ISO string or number to MySQL DATETIME format (YYYY-MM-DD HH:MM:SS)
function toMySqlDateTime(val) {
  if (!val) return null;
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Auto-migrate data from JSON files if MySQL tables are empty or missing records
async function autoMigrateFromJson() {
  if (!isMySqlActive()) return;

  try {
    const dataDir = path.join(__dirname, 'data');

    // 1. Users Migration
    const usersFile = path.join(dataDir, 'users.json');
    if (fs.existsSync(usersFile)) {
      const users = JSON.parse(fs.readFileSync(usersFile, 'utf8') || '[]');
      let count = 0;
      for (const u of users) {
        if (!u || !u.id || !u.email) continue;
        const [existing] = await pool.query('SELECT id FROM users WHERE id = ? OR email = ? LIMIT 1', [u.id, u.email.trim().toLowerCase()]);
        if (existing.length === 0) {
          await pool.query(`INSERT INTO users (
            id, traderId, name, email, password, role, telegram, preferredBroker,
            payoutWallet, brokerAccountId, profilePicture, isEmailVerified,
            emailVerificationCode, emailVerificationExpires, emailVerifiedAt,
            adminSecurityPin, createdAt, updatedAt, extraData
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            u.id,
            u.traderId || null,
            u.name || 'Trader',
            u.email.trim().toLowerCase(),
            u.password || '',
            u.role || 'user',
            u.telegram || '',
            u.preferredBroker || '',
            u.payoutWallet || '',
            u.brokerAccountId || '',
            u.profilePicture || null,
            u.isEmailVerified ? 1 : 0,
            u.emailVerificationCode || null,
            toMySqlDateTime(u.emailVerificationExpires),
            toMySqlDateTime(u.emailVerifiedAt),
            u.adminSecurityPin || null,
            toMySqlDateTime(u.createdAt) || new Date(),
            toMySqlDateTime(u.updatedAt) || new Date(),
            JSON.stringify(u)
          ]);
          count++;
        }
      }
      if (count > 0) console.log(`[DATABASE MIGRATION] ✅ Migrated ${count} users into MySQL.`);
    }

    // 2. Challenges Migration
    const challengesFile = path.join(dataDir, 'challenges.json');
    if (fs.existsSync(challengesFile)) {
      const challenges = JSON.parse(fs.readFileSync(challengesFile, 'utf8') || '[]');
      let count = 0;
      for (const c of challenges) {
        if (!c || !c.id) continue;
        const [existing] = await pool.query('SELECT id FROM challenges WHERE id = ? LIMIT 1', [c.id]);
        if (existing.length === 0) {
          await pool.query(`INSERT INTO challenges (
            id, userId, userName, userEmail, userTraderId, userTelegram, userBroker,
            packageId, packageName, originalFee, fee, discountPercent, hasDiscount,
            fundedAmount, profitSplit, maxDrawdown, brokerId, brokerName, brokerIcon,
            brokerAccountId, status, sessionsRequired, sessionsCompleted, currentDrawdown,
            paymentMethod, paymentTxId, senderNumber, currency, currencySymbol, exchangeRate,
            localAmount, assignedMmId, assignedMmSerial, assignedMmTitle, assignedMmUrl, assignedMmNote,
            approvedAt, createdAt, durationDays, challengePhase, expiresAt,
            practiceSessionsCompleted, verifiedSessionsCount, totalSubmissionsCount, practiceHours,
            practiceStartedAt, practiceExpiresAt, practiceMaxSessions, isActive, isCompleted,
            evaluationStartedAt, practiceSkippedAt, reactivatedAt, reactivationNotice,
            failReason, violatedRule, failReasonText, failedAt, rawChallengeData
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            c.id,
            c.userId || '',
            c.userName || '',
            c.userEmail || '',
            c.userTraderId || '',
            c.userTelegram || '',
            c.userBroker || '',
            c.packageId || '',
            c.packageName || '',
            c.originalFee || 0,
            c.fee || 0,
            c.discountPercent || 0,
            c.hasDiscount ? 1 : 0,
            c.fundedAmount || 0,
            c.profitSplit || '75%',
            c.maxDrawdown || '25%',
            c.brokerId || '',
            c.brokerName || '',
            c.brokerIcon || null,
            c.brokerAccountId || '',
            c.status || 'pending_approval',
            c.sessionsRequired || 15,
            c.sessionsCompleted || 0,
            c.currentDrawdown || '0.0%',
            c.paymentMethod || '',
            c.paymentTxId || '',
            c.senderNumber || '',
            c.currency || 'USD',
            c.currencySymbol || '$',
            c.exchangeRate || 1,
            c.localAmount || 0,
            c.assignedMmId || null,
            c.assignedMmSerial || null,
            c.assignedMmTitle || null,
            c.assignedMmUrl || null,
            c.assignedMmNote || null,
            toMySqlDateTime(c.approvedAt),
            toMySqlDateTime(c.createdAt) || new Date(),
            c.durationDays || 15,
            c.challengePhase || 'practice',
            toMySqlDateTime(c.expiresAt),
            c.practiceSessionsCompleted || 0,
            c.verifiedSessionsCount || 0,
            c.totalSubmissionsCount || 0,
            c.practiceHours || 48,
            toMySqlDateTime(c.practiceStartedAt),
            toMySqlDateTime(c.practiceExpiresAt),
            c.practiceMaxSessions || 3,
            c.isActive !== false ? 1 : 0,
            c.isCompleted ? 1 : 0,
            toMySqlDateTime(c.evaluationStartedAt),
            toMySqlDateTime(c.practiceSkippedAt),
            toMySqlDateTime(c.reactivatedAt),
            c.reactivationNotice ? JSON.stringify(c.reactivationNotice) : null,
            c.failReason || null,
            c.violatedRule || null,
            c.failReasonText || null,
            toMySqlDateTime(c.failedAt),
            JSON.stringify(c)
          ]);
          count++;
        }
      }
      if (count > 0) console.log(`[DATABASE MIGRATION] ✅ Migrated ${count} challenges into MySQL.`);
    }

    // 3. Submissions Migration
    const subsFile = path.join(dataDir, 'submissions.json');
    if (fs.existsSync(subsFile)) {
      const subs = JSON.parse(fs.readFileSync(subsFile, 'utf8') || '[]');
      let count = 0;
      for (const s of subs) {
        if (!s || !s.id) continue;
        const [existing] = await pool.query('SELECT id FROM submissions WHERE id = ? LIMIT 1', [s.id]);
        if (existing.length === 0) {
          await pool.query(`INSERT INTO submissions (
            id, userId, challengeId, packageName, isPractice, sessionType, practiceSessionNumber,
            brokerName, sessionDate, winTrades, lossTrades, tradesCount, profitLoss, winRate,
            videoUrl, screenshotUrl, fileType, isCloudHosted, cloudProvider, notes, status,
            adminFeedback, submittedAt, reviewedAt, userTraderId, userName, userEmail, userTelegram,
            userAvatar, forgivenOnReactivation, reactivatedAt, resubmissionRequestedAt, rawSubmissionData
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            s.id,
            s.userId || '',
            s.challengeId || '',
            s.packageName || '',
            s.isPractice ? 1 : 0,
            s.sessionType || 'evaluation',
            s.practiceSessionNumber || 0,
            s.brokerName || '',
            s.sessionDate || '',
            s.winTrades || 0,
            s.lossTrades || 0,
            s.tradesCount || 0,
            s.profitLoss || 0,
            s.winRate || '0.0%',
            s.videoUrl || null,
            s.screenshotUrl || null,
            s.fileType || 'none',
            s.isCloudHosted ? 1 : 0,
            s.cloudProvider || '',
            s.notes || null,
            s.status || 'under_review',
            s.adminFeedback || null,
            toMySqlDateTime(s.submittedAt) || new Date(),
            toMySqlDateTime(s.reviewedAt),
            s.userTraderId || '',
            s.userName || '',
            s.userEmail || '',
            s.userTelegram || '',
            s.userAvatar || null,
            s.forgivenOnReactivation ? 1 : 0,
            toMySqlDateTime(s.reactivatedAt),
            toMySqlDateTime(s.resubmissionRequestedAt),
            JSON.stringify(s)
          ]);
          count++;
        }
      }
      if (count > 0) console.log(`[DATABASE MIGRATION] ✅ Migrated ${count} submissions into MySQL.`);
    }

    // 4. Archive Migration
    const arcFile = path.join(dataDir, 'user_archive.json');
    if (fs.existsSync(arcFile)) {
      const arc = JSON.parse(fs.readFileSync(arcFile, 'utf8') || '[]');
      let count = 0;
      for (const a of arc) {
        if (!a || !a.archiveId) continue;
        const [existing] = await pool.query('SELECT archiveId FROM user_archive WHERE archiveId = ? LIMIT 1', [a.archiveId]);
        if (existing.length === 0) {
          await pool.query(`INSERT INTO user_archive (
            archiveId, timestamp, displayTime, action, userId, userName, userEmail,
            telegram, preferredBroker, brokerAccountId, payoutWallet, isEmailVerified, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            a.archiveId,
            toMySqlDateTime(a.timestamp) || new Date(),
            a.displayTime || '',
            a.action || 'EVENT',
            a.userId || '',
            a.userName || '',
            a.userEmail || '',
            a.telegram || '',
            a.preferredBroker || '',
            a.brokerAccountId || '',
            a.payoutWallet || '',
            a.isEmailVerified ? 1 : 0,
            a.metadata ? JSON.stringify(a.metadata) : null
          ]);
          count++;
        }
      }
      if (count > 0) console.log(`[DATABASE MIGRATION] ✅ Migrated ${count} archive entries into MySQL.`);
    }

    // 5. Partners Initial Migration
    const partnersFile = path.join(dataDir, 'partners.json');
    const permPartnersFile = path.join(dataDir, 'partners_permanent_store.json');
    let partnerItems = [];
    if (fs.existsSync(partnersFile)) {
      try { partnerItems = JSON.parse(fs.readFileSync(partnersFile, 'utf8') || '[]'); } catch (e) {}
    }
    if ((!partnerItems || partnerItems.length === 0) && fs.existsSync(permPartnersFile)) {
      try { partnerItems = JSON.parse(fs.readFileSync(permPartnersFile, 'utf8') || '[]'); } catch (e) {}
    }
    if (Array.isArray(partnerItems) && partnerItems.length > 0) {
      let count = 0;
      for (const p of partnerItems) {
        if (!p || !p.id) continue;
        const [existing] = await pool.query('SELECT id FROM partners WHERE id = ? LIMIT 1', [p.id]);
        if (existing.length === 0) {
          await savePartner(p);
          count++;
        }
      }
      if (count > 0) console.log(`[DATABASE MIGRATION] ✅ Migrated ${count} partners into MySQL.`);
    }

    // 6. Promo Codes Initial Migration
    const promoFile = path.join(dataDir, 'promo_codes.json');
    const permPromoFile = path.join(dataDir, 'promo_codes_permanent_store.json');
    let promoItems = [];
    if (fs.existsSync(promoFile)) {
      try { promoItems = JSON.parse(fs.readFileSync(promoFile, 'utf8') || '[]'); } catch (e) {}
    }
    if ((!promoItems || promoItems.length === 0) && fs.existsSync(permPromoFile)) {
      try { promoItems = JSON.parse(fs.readFileSync(permPromoFile, 'utf8') || '[]'); } catch (e) {}
    }
    if (Array.isArray(promoItems) && promoItems.length > 0) {
      let count = 0;
      for (const pr of promoItems) {
        if (!pr || !pr.id) continue;
        const [existing] = await pool.query('SELECT id FROM promo_codes WHERE id = ? LIMIT 1', [pr.id]);
        if (existing.length === 0) {
          await savePromoCode(pr);
          count++;
        }
      }
      if (count > 0) console.log(`[DATABASE MIGRATION] ✅ Migrated ${count} promo codes into MySQL.`);
    }

    // 7. Partner Payouts Initial Migration
    const ppFile = path.join(dataDir, 'partner_payouts.json');
    if (fs.existsSync(ppFile)) {
      let ppItems = [];
      try { ppItems = JSON.parse(fs.readFileSync(ppFile, 'utf8') || '[]'); } catch (e) {}
      if (Array.isArray(ppItems) && ppItems.length > 0) {
        let count = 0;
        for (const pp of ppItems) {
          if (!pp || !pp.id) continue;
          const [existing] = await pool.query('SELECT id FROM partner_payouts WHERE id = ? LIMIT 1', [pp.id]);
          if (existing.length === 0) {
            await savePartnerPayout(pp);
            count++;
          }
        }
        if (count > 0) console.log(`[DATABASE MIGRATION] ✅ Migrated ${count} partner payouts into MySQL.`);
      }
    }

    // 8. Partner Settings Initial Migration
    const psFile = path.join(dataDir, 'partner_settings.json');
    if (fs.existsSync(psFile)) {
      try {
        const ps = JSON.parse(fs.readFileSync(psFile, 'utf8') || '{}');
        if (ps && Object.keys(ps).length > 0) {
          const [existing] = await pool.query("SELECT id FROM partner_settings WHERE id = 'default' LIMIT 1");
          if (existing.length === 0) {
            await savePartnerSettings(ps);
          }
        }
      } catch (e) {}
    }

    // 9. Partner Promo Requests Initial Migration
    const prqFile = path.join(dataDir, 'partner_promo_requests.json');
    if (fs.existsSync(prqFile)) {
      let prqItems = [];
      try { prqItems = JSON.parse(fs.readFileSync(prqFile, 'utf8') || '[]'); } catch (e) {}
      if (Array.isArray(prqItems) && prqItems.length > 0) {
        let count = 0;
        for (const prq of prqItems) {
          if (!prq || !prq.id) continue;
          const [existing] = await pool.query('SELECT id FROM partner_promo_requests WHERE id = ? LIMIT 1', [prq.id]);
          if (existing.length === 0) {
            await savePartnerPromoRequest(prq);
            count++;
          }
        }
        if (count > 0) console.log(`[DATABASE MIGRATION] ✅ Migrated ${count} partner promo requests into MySQL.`);
      }
    }

    // 10. Trader Payouts Initial Migration
    const tpFile = path.join(dataDir, 'payouts.json');
    if (fs.existsSync(tpFile)) {
      let tpItems = [];
      try { tpItems = JSON.parse(fs.readFileSync(tpFile, 'utf8') || '[]'); } catch (e) {}
      if (Array.isArray(tpItems) && tpItems.length > 0) {
        let count = 0;
        for (const tp of tpItems) {
          if (!tp || (!tp.id && !tp.payoutId)) continue;
          const tid = tp.id || tp.payoutId;
          const [existing] = await pool.query('SELECT id FROM payouts WHERE id = ? LIMIT 1', [tid]);
          if (existing.length === 0) {
            await savePayout(tp);
            count++;
          }
        }
        if (count > 0) console.log(`[DATABASE MIGRATION] ✅ Migrated ${count} trader payouts into MySQL.`);
      }
    }

    // 11. Payout Settings Initial Migration
    const tpsFile = path.join(dataDir, 'payout_settings.json');
    if (fs.existsSync(tpsFile)) {
      try {
        const tps = JSON.parse(fs.readFileSync(tpsFile, 'utf8') || '{}');
        if (tps && Object.keys(tps).length > 0) {
          const [existing] = await pool.query("SELECT id FROM payout_settings WHERE id = 'default' LIMIT 1");
          if (existing.length === 0) {
            await savePayoutSettings(tps);
          }
        }
      } catch (e) {}
    }

    // 12. Launch Promo Initial Migration
    const lpFile = path.join(dataDir, 'launch_promo.json');
    if (fs.existsSync(lpFile)) {
      try {
        const lp = JSON.parse(fs.readFileSync(lpFile, 'utf8') || '{}');
        if (lp && Object.keys(lp).length > 0) {
          const [existing] = await pool.query("SELECT id FROM launch_promo WHERE id = 'default' LIMIT 1");
          if (existing.length === 0) {
            await saveLaunchPromo(lp);
          }
        }
      } catch (e) {}
    }

    // 13. Promo Presets Initial Migration
    const prsFile = path.join(dataDir, 'promo_presets.json');
    if (fs.existsSync(prsFile)) {
      try {
        const prs = JSON.parse(fs.readFileSync(prsFile, 'utf8') || '[]');
        if (Array.isArray(prs) && prs.length > 0) {
          const [existing] = await pool.query("SELECT id FROM promo_presets WHERE id = 'default' LIMIT 1");
          if (existing.length === 0) {
            await savePromoPresets(prs);
          }
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error('[DATABASE AUTO-MIGRATE ERROR]:', err.message);
  }
}

// ==================== REPOSITORY / DATA ACCESS HELPERS ====================

// Format a MySQL user row into platform JSON representation
function formatUser(row) {
  if (!row) return null;
  let parsed = {};
  if (row.extraData) {
    try { parsed = typeof row.extraData === 'string' ? JSON.parse(row.extraData) : row.extraData; } catch (e) {}
  }
  return {
    ...parsed,
    id: row.id,
    traderId: row.traderId || parsed.traderId || 'AJ-1000',
    name: row.name,
    email: row.email,
    password: row.password,
    role: row.role || 'user',
    telegram: row.telegram || '',
    preferredBroker: row.preferredBroker || '',
    payoutWallet: row.payoutWallet || '',
    brokerAccountId: row.brokerAccountId || '',
    profilePicture: row.profilePicture || null,
    isEmailVerified: Boolean(row.isEmailVerified),
    emailVerificationCode: row.emailVerificationCode || null,
    emailVerificationExpires: row.emailVerificationExpires ? new Date(row.emailVerificationExpires).toISOString() : null,
    emailVerifiedAt: row.emailVerifiedAt ? new Date(row.emailVerifiedAt).toISOString() : null,
    adminSecurityPin: row.adminSecurityPin || parsed.adminSecurityPin || null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : new Date().toISOString()
  };
}

// Format a MySQL challenge row into platform JSON representation
function formatChallenge(row) {
  if (!row) return null;
  let parsed = {};
  if (row.rawChallengeData) {
    try { parsed = typeof row.rawChallengeData === 'string' ? JSON.parse(row.rawChallengeData) : row.rawChallengeData; } catch (e) {}
  }
  let reactNotice = null;
  if (row.reactivationNotice) {
    try { reactNotice = typeof row.reactivationNotice === 'string' ? JSON.parse(row.reactivationNotice) : row.reactivationNotice; } catch (e) {}
  }
  return {
    ...parsed,
    id: row.id,
    userId: row.userId,
    userName: row.userName || parsed.userName || '',
    userEmail: row.userEmail || parsed.userEmail || '',
    userTraderId: row.userTraderId || parsed.userTraderId || '',
    userTelegram: row.userTelegram || '',
    userBroker: row.userBroker || '',
    packageId: row.packageId || '',
    packageName: row.packageName || '',
    originalFee: Number(row.originalFee || 0),
    fee: Number(row.fee || 0),
    discountPercent: Number(row.discountPercent || 0),
    hasDiscount: Boolean(row.hasDiscount),
    fundedAmount: Number(row.fundedAmount || 0),
    profitSplit: row.profitSplit || '75%',
    maxDrawdown: row.maxDrawdown || '25%',
    brokerId: row.brokerId || '',
    brokerName: row.brokerName || '',
    brokerIcon: row.brokerIcon || null,
    brokerAccountId: row.brokerAccountId || '',
    status: row.status || 'pending_approval',
    sessionsRequired: Number(row.sessionsRequired || 15),
    sessionsCompleted: Number(row.sessionsCompleted || 0),
    currentDrawdown: row.currentDrawdown || '0.0%',
    paymentMethod: row.paymentMethod || '',
    paymentTxId: row.paymentTxId || '',
    senderNumber: row.senderNumber || '',
    currency: row.currency || 'USD',
    currencySymbol: row.currencySymbol || '$',
    exchangeRate: Number(row.exchangeRate || 1),
    localAmount: Number(row.localAmount || 0),
    assignedMmId: row.assignedMmId || null,
    assignedMmSerial: row.assignedMmSerial !== null ? Number(row.assignedMmSerial) : null,
    assignedMmTitle: row.assignedMmTitle || null,
    assignedMmUrl: row.assignedMmUrl || null,
    assignedMmNote: row.assignedMmNote || null,
    approvedAt: row.approvedAt ? new Date(row.approvedAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
    durationDays: Number(row.durationDays || 15),
    challengePhase: row.challengePhase || 'practice',
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    practiceSessionsCompleted: Number(row.practiceSessionsCompleted || 0),
    verifiedSessionsCount: Number(row.verifiedSessionsCount || 0),
    totalSubmissionsCount: Number(row.totalSubmissionsCount || 0),
    practiceHours: Number(row.practiceHours || 48),
    practiceStartedAt: row.practiceStartedAt ? new Date(row.practiceStartedAt).toISOString() : null,
    practiceExpiresAt: row.practiceExpiresAt ? new Date(row.practiceExpiresAt).toISOString() : null,
    practiceMaxSessions: Number(row.practiceMaxSessions || 3),
    isActive: Boolean(row.isActive),
    isCompleted: Boolean(row.isCompleted),
    evaluationStartedAt: row.evaluationStartedAt ? new Date(row.evaluationStartedAt).toISOString() : null,
    practiceSkippedAt: row.practiceSkippedAt ? new Date(row.practiceSkippedAt).toISOString() : null,
    reactivatedAt: row.reactivatedAt ? new Date(row.reactivatedAt).toISOString() : null,
    reactivationNotice: reactNotice || parsed.reactivationNotice || null,
    failReason: row.failReason || null,
    violatedRule: row.violatedRule || null,
    failReasonText: row.failReasonText || null,
    failedAt: row.failedAt ? new Date(row.failedAt).toISOString() : null
  };
}

// Format a MySQL submission row into platform JSON representation
function formatSubmission(row) {
  if (!row) return null;
  let parsed = {};
  if (row.rawSubmissionData) {
    try { parsed = typeof row.rawSubmissionData === 'string' ? JSON.parse(row.rawSubmissionData) : row.rawSubmissionData; } catch (e) {}
  }
  return {
    ...parsed,
    id: row.id,
    userId: row.userId,
    challengeId: row.challengeId,
    packageName: row.packageName || '',
    isPractice: Boolean(row.isPractice),
    sessionType: row.sessionType || 'evaluation',
    practiceSessionNumber: Number(row.practiceSessionNumber || 0),
    brokerName: row.brokerName || '',
    sessionDate: row.sessionDate || '',
    winTrades: Number(row.winTrades || 0),
    lossTrades: Number(row.lossTrades || 0),
    tradesCount: Number(row.tradesCount || 0),
    profitLoss: Number(row.profitLoss || 0),
    winRate: row.winRate || '0.0%',
    videoUrl: row.videoUrl || null,
    screenshotUrl: row.screenshotUrl || null,
    fileType: row.fileType || 'none',
    isCloudHosted: Boolean(row.isCloudHosted),
    cloudProvider: row.cloudProvider || '',
    notes: row.notes || null,
    status: row.status || 'under_review',
    adminFeedback: row.adminFeedback || null,
    submittedAt: row.submittedAt ? new Date(row.submittedAt).toISOString() : new Date().toISOString(),
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
    userTraderId: row.userTraderId || '',
    userName: row.userName || '',
    userEmail: row.userEmail || '',
    userTelegram: row.userTelegram || '',
    userAvatar: row.userAvatar || null,
    forgivenOnReactivation: Boolean(row.forgivenOnReactivation),
    reactivatedAt: row.reactivatedAt ? new Date(row.reactivatedAt).toISOString() : null,
    resubmissionRequestedAt: row.resubmissionRequestedAt ? new Date(row.resubmissionRequestedAt).toISOString() : null
  };
}

// Format a MySQL partner row into platform JSON representation
function formatPartner(row) {
  if (!row) return null;
  let parsed = {};
  if (row.rawPartnerData) {
    try { parsed = typeof row.rawPartnerData === 'string' ? JSON.parse(row.rawPartnerData) : row.rawPartnerData; } catch (e) {}
  }
  let cLinks = [];
  if (row.customLinks) {
    try { cLinks = typeof row.customLinks === 'string' ? JSON.parse(row.customLinks) : row.customLinks; } catch (e) {}
  } else if (parsed && parsed.customLinks) {
    cLinks = parsed.customLinks;
  }
  return {
    ...parsed,
    id: row.id,
    name: row.name || parsed.name || '',
    email: row.email ? row.email.trim().toLowerCase() : parsed.email,
    password: row.password || parsed.password || '',
    phone: row.phone || parsed.phone || '',
    promoCode: row.promoCode || parsed.promoCode || '',
    commissionRate: Number(row.commissionRate !== undefined ? row.commissionRate : (parsed.commissionRate || 10)),
    traderDiscount: Number(row.traderDiscount !== undefined ? row.traderDiscount : (parsed.traderDiscount || 5)),
    payoutMethod: row.payoutMethod || parsed.payoutMethod || 'Binance Pay',
    payoutDetails: row.payoutDetails || parsed.payoutDetails || '',
    status: row.status || parsed.status || 'active',
    isEmailVerified: Boolean(row.isEmailVerified !== undefined ? row.isEmailVerified : parsed.isEmailVerified),
    emailVerificationCode: row.emailVerificationCode || parsed.emailVerificationCode || null,
    emailVerificationExpires: row.emailVerificationExpires ? (new Date(row.emailVerificationExpires).getTime() || parsed.emailVerificationExpires) : (parsed.emailVerificationExpires || null),
    emailVerifiedAt: row.emailVerifiedAt ? new Date(row.emailVerifiedAt).toISOString() : (parsed.emailVerifiedAt || null),
    role: row.role || parsed.role || 'partner',
    totalReferred: Number(row.totalReferred !== undefined ? row.totalReferred : (parsed.totalReferred || 0)),
    totalSales: Number(row.totalSales !== undefined ? row.totalSales : (parsed.totalSales || 0)),
    totalCommissionEarned: Number(row.totalCommissionEarned !== undefined ? row.totalCommissionEarned : (parsed.totalCommissionEarned || 0)),
    totalCommissionPaid: Number(row.totalCommissionPaid !== undefined ? row.totalCommissionPaid : (parsed.totalCommissionPaid || 0)),
    pendingCommission: Number(row.pendingCommission !== undefined ? row.pendingCommission : (parsed.pendingCommission || 0)),
    notes: row.notes !== undefined ? row.notes : (parsed.notes || ''),
    useCustomRate: Boolean(row.useCustomRate !== undefined ? row.useCustomRate : parsed.useCustomRate),
    customLinks: Array.isArray(cLinks) ? cLinks : [],
    wallets: Array.isArray(row.wallets) ? row.wallets : (Array.isArray(parsed.wallets) ? parsed.wallets : []),
    telegram: row.telegram || parsed.telegram || '',
    telegramData: parsed.telegramData || null,
    country: row.country || parsed.country || '',
    balanceAdjustment: Number(row.balanceAdjustment !== undefined ? row.balanceAdjustment : (parsed.balanceAdjustment || 0)),
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : (parsed.createdAt || new Date().toISOString()),
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : (parsed.updatedAt || new Date().toISOString())
  };
}

// Format a MySQL promo code row into platform JSON representation
function formatPromoCode(row) {
  if (!row) return null;
  let parsed = {};
  if (row.rawPromoData) {
    try { parsed = typeof row.rawPromoData === 'string' ? JSON.parse(row.rawPromoData) : row.rawPromoData; } catch (e) {}
  }
  let pkgIds = ['all'];
  if (row.packageIds) {
    try { pkgIds = typeof row.packageIds === 'string' ? JSON.parse(row.packageIds) : row.packageIds; } catch (e) {}
  } else if (parsed.packageIds) {
    pkgIds = parsed.packageIds;
  }
  return {
    ...parsed,
    id: row.id,
    code: row.code,
    discountType: row.discountType || parsed.discountType || 'percentage',
    discountValue: Number(row.discountValue !== undefined ? row.discountValue : (parsed.discountValue || 0)),
    packageId: row.packageId || parsed.packageId || 'all',
    packageIds: Array.isArray(pkgIds) ? pkgIds : ['all'],
    maxUses: row.maxUses !== null && row.maxUses !== undefined ? Number(row.maxUses) : (parsed.maxUses || null),
    usedCount: Number(row.usedCount || parsed.usedCount || 0),
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : (parsed.expiresAt || null),
    status: row.status || parsed.status || 'active',
    notes: row.notes !== undefined ? row.notes : (parsed.notes || ''),
    isPartnerCode: Boolean(row.isPartnerCode || parsed.isPartnerCode),
    partnerId: row.partnerId || parsed.partnerId || null,
    partnerName: row.partnerName || parsed.partnerName || null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : (parsed.createdAt || new Date().toISOString()),
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : (parsed.updatedAt || new Date().toISOString())
  };
}

// Format a MySQL partner payout row
function formatPartnerPayout(row) {
  if (!row) return null;
  let parsed = {};
  if (row.rawPayoutData) {
    try { parsed = typeof row.rawPayoutData === 'string' ? JSON.parse(row.rawPayoutData) : row.rawPayoutData; } catch (e) {}
  }
  return {
    ...parsed,
    id: row.id,
    partnerId: row.partnerId || parsed.partnerId,
    partnerName: row.partnerName || parsed.partnerName || '',
    partnerEmail: row.partnerEmail || parsed.partnerEmail || '',
    partnerPromoCode: row.partnerPromoCode || parsed.partnerPromoCode || '',
    amount: Number(row.amount !== undefined ? row.amount : (parsed.amount || 0)),
    paymentMethod: row.paymentMethod || parsed.paymentMethod || 'Binance Pay',
    payoutAddress: row.payoutAddress || parsed.payoutAddress || '',
    status: row.status || parsed.status || 'pending',
    adminNotes: row.adminNotes || parsed.adminNotes || null,
    rejectionReason: row.rejectionReason || parsed.rejectionReason || null,
    transactionProofUrl: row.transactionProofUrl || parsed.transactionProofUrl || null,
    requestedAt: row.requestedAt ? new Date(row.requestedAt).toISOString() : (parsed.requestedAt || new Date().toISOString()),
    paidAt: row.paidAt ? new Date(row.paidAt).toISOString() : (parsed.paidAt || null),
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : (parsed.createdAt || new Date().toISOString())
  };
}

// Format a MySQL partner promo request row
function formatPartnerPromoRequest(row) {
  if (!row) return null;
  let parsed = {};
  if (row.rawRequestData) {
    try { parsed = typeof row.rawRequestData === 'string' ? JSON.parse(row.rawRequestData) : row.rawRequestData; } catch (e) {}
  }
  return {
    ...parsed,
    id: row.id,
    partnerId: row.partnerId || parsed.partnerId,
    partnerName: row.partnerName || parsed.partnerName || '',
    partnerEmail: row.partnerEmail || parsed.partnerEmail || '',
    promoCode: row.promoCode || parsed.promoCode || '',
    requestedDiscount: Number(row.requestedDiscount !== undefined ? row.requestedDiscount : (parsed.requestedDiscount || 5)),
    status: row.status || parsed.status || 'pending',
    adminFeedback: row.adminFeedback || parsed.adminFeedback || null,
    requestedAt: row.requestedAt ? new Date(row.requestedAt).toISOString() : (parsed.requestedAt || new Date().toISOString()),
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : (parsed.reviewedAt || null)
  };
}

// Format a MySQL trader payout row
function formatTraderPayout(row) {
  if (!row) return null;
  let parsed = {};
  if (row.rawPayoutData) {
    try { parsed = typeof row.rawPayoutData === 'string' ? JSON.parse(row.rawPayoutData) : row.rawPayoutData; } catch (e) {}
  }
  return {
    ...parsed,
    id: row.id,
    userId: row.userId || parsed.userId || '',
    payoutId: row.payoutId || parsed.payoutId || row.id,
    amount: Number(row.amount !== undefined ? row.amount : (parsed.amount || 0)),
    status: row.status || parsed.status || 'pending',
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : (parsed.createdAt || new Date().toISOString()),
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : (parsed.updatedAt || new Date().toISOString())
  };
}

// ----------------- Public Async Database Methods -----------------

async function getAllUsers() {
  if (!isMySqlActive()) return null;
  const [rows] = await pool.query('SELECT * FROM users ORDER BY createdAt ASC');
  return rows.map(formatUser);
}

async function getUserByEmail(email) {
  if (!isMySqlActive() || !email) return null;
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email.trim().toLowerCase()]);
  return rows.length > 0 ? formatUser(rows[0]) : null;
}

async function getUserById(id) {
  if (!isMySqlActive() || !id) return null;
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0 ? formatUser(rows[0]) : null;
}

async function saveUser(user) {
  if (!isMySqlActive() || !user || !user.id || !user.email) return false;
  const normEmail = user.email.trim().toLowerCase();
  const [existing] = await pool.query('SELECT id FROM users WHERE id = ? OR email = ? LIMIT 1', [user.id, normEmail]);

  if (existing.length === 0) {
    await pool.query(`INSERT INTO users (
      id, traderId, name, email, password, role, telegram, preferredBroker,
      payoutWallet, brokerAccountId, profilePicture, isEmailVerified,
      emailVerificationCode, emailVerificationExpires, emailVerifiedAt,
      adminSecurityPin, createdAt, updatedAt, extraData
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      user.id,
      user.traderId || null,
      user.name || 'Trader',
      normEmail,
      user.password || '',
      user.role || 'user',
      user.telegram || '',
      user.preferredBroker || '',
      user.payoutWallet || '',
      user.brokerAccountId || '',
      user.profilePicture || null,
      user.isEmailVerified ? 1 : 0,
      user.emailVerificationCode || null,
      toMySqlDateTime(user.emailVerificationExpires),
      toMySqlDateTime(user.emailVerifiedAt),
      user.adminSecurityPin || null,
      toMySqlDateTime(user.createdAt) || new Date(),
      toMySqlDateTime(user.updatedAt) || new Date(),
      JSON.stringify(user)
    ]);
  } else {
    await pool.query(`UPDATE users SET
      traderId = ?, name = ?, email = ?, password = ?, role = ?, telegram = ?,
      preferredBroker = ?, payoutWallet = ?, brokerAccountId = ?, profilePicture = ?,
      isEmailVerified = ?, emailVerificationCode = ?, emailVerificationExpires = ?,
      emailVerifiedAt = ?, adminSecurityPin = ?, updatedAt = ?, extraData = ?
      WHERE id = ?`, [
      user.traderId || null,
      user.name,
      normEmail,
      user.password,
      user.role || 'user',
      user.telegram || '',
      user.preferredBroker || '',
      user.payoutWallet || '',
      user.brokerAccountId || '',
      user.profilePicture || null,
      user.isEmailVerified ? 1 : 0,
      user.emailVerificationCode || null,
      toMySqlDateTime(user.emailVerificationExpires),
      toMySqlDateTime(user.emailVerifiedAt),
      user.adminSecurityPin || null,
      new Date(),
      JSON.stringify(user),
      user.id
    ]);
  }
  return true;
}

async function getAllChallenges() {
  if (!isMySqlActive()) return null;
  const [rows] = await pool.query('SELECT * FROM challenges ORDER BY createdAt DESC');
  return rows.map(formatChallenge);
}

async function getChallengeById(id) {
  if (!isMySqlActive() || !id) return null;
  const [rows] = await pool.query('SELECT * FROM challenges WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0 ? formatChallenge(rows[0]) : null;
}

async function saveChallenge(challenge) {
  if (!isMySqlActive() || !challenge || !challenge.id) return false;
  const [existing] = await pool.query('SELECT id FROM challenges WHERE id = ? LIMIT 1', [challenge.id]);

  if (existing.length === 0) {
    await pool.query(`INSERT INTO challenges (
      id, userId, userName, userEmail, userTraderId, userTelegram, userBroker,
      packageId, packageName, originalFee, fee, discountPercent, hasDiscount,
      fundedAmount, profitSplit, maxDrawdown, brokerId, brokerName, brokerIcon,
      brokerAccountId, status, sessionsRequired, sessionsCompleted, currentDrawdown,
      paymentMethod, paymentTxId, senderNumber, currency, currencySymbol, exchangeRate,
      localAmount, assignedMmId, assignedMmSerial, assignedMmTitle, assignedMmUrl, assignedMmNote,
      approvedAt, createdAt, durationDays, challengePhase, expiresAt,
      practiceSessionsCompleted, verifiedSessionsCount, totalSubmissionsCount, practiceHours,
      practiceStartedAt, practiceExpiresAt, practiceMaxSessions, isActive, isCompleted,
      evaluationStartedAt, practiceSkippedAt, reactivatedAt, reactivationNotice,
      failReason, violatedRule, failReasonText, failedAt, rawChallengeData
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      challenge.id,
      challenge.userId || '',
      challenge.userName || '',
      challenge.userEmail || '',
      challenge.userTraderId || '',
      challenge.userTelegram || '',
      challenge.userBroker || '',
      challenge.packageId || '',
      challenge.packageName || '',
      challenge.originalFee || 0,
      challenge.fee || 0,
      challenge.discountPercent || 0,
      challenge.hasDiscount ? 1 : 0,
      challenge.fundedAmount || 0,
      challenge.profitSplit || '75%',
      challenge.maxDrawdown || '25%',
      challenge.brokerId || '',
      challenge.brokerName || '',
      challenge.brokerIcon || null,
      challenge.brokerAccountId || '',
      challenge.status || 'pending_approval',
      challenge.sessionsRequired || 15,
      challenge.sessionsCompleted || 0,
      challenge.currentDrawdown || '0.0%',
      challenge.paymentMethod || '',
      challenge.paymentTxId || '',
      challenge.senderNumber || '',
      challenge.currency || 'USD',
      challenge.currencySymbol || '$',
      challenge.exchangeRate || 1,
      challenge.localAmount || 0,
      challenge.assignedMmId || null,
      challenge.assignedMmSerial || null,
      challenge.assignedMmTitle || null,
      challenge.assignedMmUrl || null,
      challenge.assignedMmNote || null,
      toMySqlDateTime(challenge.approvedAt),
      toMySqlDateTime(challenge.createdAt) || new Date(),
      challenge.durationDays || 15,
      challengePhaseSafe(challenge),
      toMySqlDateTime(challenge.expiresAt),
      challenge.practiceSessionsCompleted || 0,
      challenge.verifiedSessionsCount || 0,
      challenge.totalSubmissionsCount || 0,
      challenge.practiceHours || 48,
      toMySqlDateTime(challenge.practiceStartedAt),
      toMySqlDateTime(challenge.practiceExpiresAt),
      challenge.practiceMaxSessions || 3,
      challenge.isActive !== false ? 1 : 0,
      challenge.isCompleted ? 1 : 0,
      toMySqlDateTime(challenge.evaluationStartedAt),
      toMySqlDateTime(challenge.practiceSkippedAt),
      toMySqlDateTime(challenge.reactivatedAt),
      challenge.reactivationNotice ? JSON.stringify(challenge.reactivationNotice) : null,
      challenge.failReason || null,
      challenge.violatedRule || null,
      challenge.failReasonText || null,
      toMySqlDateTime(challenge.failedAt),
      JSON.stringify(challenge)
    ]);
  } else {
    await pool.query(`UPDATE challenges SET
      userId = ?, userName = ?, userEmail = ?, userTraderId = ?, userTelegram = ?, userBroker = ?,
      packageId = ?, packageName = ?, originalFee = ?, fee = ?, discountPercent = ?, hasDiscount = ?,
      fundedAmount = ?, profitSplit = ?, maxDrawdown = ?, brokerId = ?, brokerName = ?, brokerIcon = ?,
      brokerAccountId = ?, status = ?, sessionsRequired = ?, sessionsCompleted = ?, currentDrawdown = ?,
      paymentMethod = ?, paymentTxId = ?, senderNumber = ?, currency = ?, currencySymbol = ?, exchangeRate = ?,
      localAmount = ?, assignedMmId = ?, assignedMmSerial = ?, assignedMmTitle = ?, assignedMmUrl = ?, assignedMmNote = ?,
      approvedAt = ?, durationDays = ?, challengePhase = ?, expiresAt = ?,
      practiceSessionsCompleted = ?, verifiedSessionsCount = ?, totalSubmissionsCount = ?, practiceHours = ?,
      practiceStartedAt = ?, practiceExpiresAt = ?, practiceMaxSessions = ?, isActive = ?, isCompleted = ?,
      evaluationStartedAt = ?, practiceSkippedAt = ?, reactivatedAt = ?, reactivationNotice = ?,
      failReason = ?, violatedRule = ?, failReasonText = ?, failedAt = ?, rawChallengeData = ?
      WHERE id = ?`, [
      challenge.userId || '',
      challenge.userName || '',
      challenge.userEmail || '',
      challenge.userTraderId || '',
      challenge.userTelegram || '',
      challenge.userBroker || '',
      challenge.packageId || '',
      challenge.packageName || '',
      challenge.originalFee || 0,
      challenge.fee || 0,
      challenge.discountPercent || 0,
      challenge.hasDiscount ? 1 : 0,
      challenge.fundedAmount || 0,
      challenge.profitSplit || '75%',
      challenge.maxDrawdown || '25%',
      challenge.brokerId || '',
      challenge.brokerName || '',
      challenge.brokerIcon || null,
      challenge.brokerAccountId || '',
      challenge.status || 'pending_approval',
      challenge.sessionsRequired || 15,
      challenge.sessionsCompleted || 0,
      challenge.currentDrawdown || '0.0%',
      challenge.paymentMethod || '',
      challenge.paymentTxId || '',
      challenge.senderNumber || '',
      challenge.currency || 'USD',
      challenge.currencySymbol || '$',
      challenge.exchangeRate || 1,
      challenge.localAmount || 0,
      challenge.assignedMmId || null,
      challenge.assignedMmSerial || null,
      challenge.assignedMmTitle || null,
      challenge.assignedMmUrl || null,
      challenge.assignedMmNote || null,
      toMySqlDateTime(challenge.approvedAt),
      challenge.durationDays || 15,
      challengePhaseSafe(challenge),
      toMySqlDateTime(challenge.expiresAt),
      challenge.practiceSessionsCompleted || 0,
      challenge.verifiedSessionsCount || 0,
      challenge.totalSubmissionsCount || 0,
      challenge.practiceHours || 48,
      toMySqlDateTime(challenge.practiceStartedAt),
      toMySqlDateTime(challenge.practiceExpiresAt),
      challenge.practiceMaxSessions || 3,
      challenge.isActive !== false ? 1 : 0,
      challenge.isCompleted ? 1 : 0,
      toMySqlDateTime(challenge.evaluationStartedAt),
      toMySqlDateTime(challenge.practiceSkippedAt),
      toMySqlDateTime(challenge.reactivatedAt),
      challenge.reactivationNotice ? JSON.stringify(challenge.reactivationNotice) : null,
      challenge.failReason || null,
      challenge.violatedRule || null,
      challenge.failReasonText || null,
      toMySqlDateTime(challenge.failedAt),
      JSON.stringify(challenge),
      challenge.id
    ]);
  }
  return true;
}

function challengePhaseSafe(c) {
  return c.challengePhase || (c.practiceStartedAt ? 'practice' : 'evaluation');
}

async function getAllSubmissions() {
  if (!isMySqlActive()) return null;
  const [rows] = await pool.query('SELECT * FROM submissions ORDER BY submittedAt DESC');
  return rows.map(formatSubmission);
}

async function saveSubmission(s) {
  if (!isMySqlActive() || !s || !s.id) return false;
  const [existing] = await pool.query('SELECT id FROM submissions WHERE id = ? LIMIT 1', [s.id]);

  if (existing.length === 0) {
    await pool.query(`INSERT INTO submissions (
      id, userId, challengeId, packageName, isPractice, sessionType, practiceSessionNumber,
      brokerName, sessionDate, winTrades, lossTrades, tradesCount, profitLoss, winRate,
      videoUrl, screenshotUrl, fileType, isCloudHosted, cloudProvider, notes, status,
      adminFeedback, submittedAt, reviewedAt, userTraderId, userName, userEmail, userTelegram,
      userAvatar, forgivenOnReactivation, reactivatedAt, resubmissionRequestedAt, rawSubmissionData
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      s.id,
      s.userId || '',
      s.challengeId || '',
      s.packageName || '',
      s.isPractice ? 1 : 0,
      s.sessionType || 'evaluation',
      s.practiceSessionNumber || 0,
      s.brokerName || '',
      s.sessionDate || '',
      s.winTrades || 0,
      s.lossTrades || 0,
      s.tradesCount || 0,
      s.profitLoss || 0,
      s.winRate || '0.0%',
      s.videoUrl || null,
      s.screenshotUrl || null,
      s.fileType || 'none',
      s.isCloudHosted ? 1 : 0,
      s.cloudProvider || '',
      s.notes || null,
      s.status || 'under_review',
      s.adminFeedback || null,
      toMySqlDateTime(s.submittedAt) || new Date(),
      toMySqlDateTime(s.reviewedAt),
      s.userTraderId || '',
      s.userName || '',
      s.userEmail || '',
      s.userTelegram || '',
      s.userAvatar || null,
      s.forgivenOnReactivation ? 1 : 0,
      toMySqlDateTime(s.reactivatedAt),
      toMySqlDateTime(s.resubmissionRequestedAt),
      JSON.stringify(s)
    ]);
  } else {
    await pool.query(`UPDATE submissions SET
      userId = ?, challengeId = ?, packageName = ?, isPractice = ?, sessionType = ?,
      practiceSessionNumber = ?, brokerName = ?, sessionDate = ?, winTrades = ?,
      lossTrades = ?, tradesCount = ?, profitLoss = ?, winRate = ?, videoUrl = ?,
      screenshotUrl = ?, fileType = ?, isCloudHosted = ?, cloudProvider = ?, notes = ?,
      status = ?, adminFeedback = ?, reviewedAt = ?, userTraderId = ?, userName = ?,
      userEmail = ?, userTelegram = ?, userAvatar = ?, forgivenOnReactivation = ?,
      reactivatedAt = ?, resubmissionRequestedAt = ?, rawSubmissionData = ?
      WHERE id = ?`, [
      s.userId || '',
      s.challengeId || '',
      s.packageName || '',
      s.isPractice ? 1 : 0,
      s.sessionType || 'evaluation',
      s.practiceSessionNumber || 0,
      s.brokerName || '',
      s.sessionDate || '',
      s.winTrades || 0,
      s.lossTrades || 0,
      s.tradesCount || 0,
      s.profitLoss || 0,
      s.winRate || '0.0%',
      s.videoUrl || null,
      s.screenshotUrl || null,
      s.fileType || 'none',
      s.isCloudHosted ? 1 : 0,
      s.cloudProvider || '',
      s.notes || null,
      s.status || 'under_review',
      s.adminFeedback || null,
      toMySqlDateTime(s.reviewedAt),
      s.userTraderId || '',
      s.userName || '',
      s.userEmail || '',
      s.userTelegram || '',
      s.userAvatar || null,
      s.forgivenOnReactivation ? 1 : 0,
      toMySqlDateTime(s.reactivatedAt),
      toMySqlDateTime(s.resubmissionRequestedAt),
      JSON.stringify(s),
      s.id
    ]);
  }
  return true;
}

async function logArchiveEntry(entry) {
  if (!isMySqlActive() || !entry || !entry.archiveId) return false;
  try {
    await pool.query(`INSERT INTO user_archive (
      archiveId, timestamp, displayTime, action, userId, userName, userEmail,
      telegram, preferredBroker, brokerAccountId, payoutWallet, isEmailVerified, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      entry.archiveId,
      toMySqlDateTime(entry.timestamp) || new Date(),
      entry.displayTime || '',
      entry.action || 'EVENT',
      entry.userId || '',
      entry.userName || '',
      entry.userEmail || '',
      entry.telegram || '',
      entry.preferredBroker || '',
      entry.brokerAccountId || '',
      entry.payoutWallet || '',
      entry.isEmailVerified ? 1 : 0,
      entry.metadata ? JSON.stringify(entry.metadata) : null
    ]);
    return true;
  } catch (err) {
    console.error('[DATABASE ARCHIVE LOG ERROR]:', err.message);
    return false;
  }
}

async function getAllArchiveLogs() {
  if (!isMySqlActive()) return null;
  const [rows] = await pool.query('SELECT * FROM user_archive ORDER BY timestamp DESC');
  return rows.map(r => ({
    archiveId: r.archiveId,
    timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : new Date().toISOString(),
    displayTime: r.displayTime || '',
    action: r.action,
    userId: r.userId,
    userName: r.userName,
    userEmail: r.userEmail,
    telegram: r.telegram || '',
    preferredBroker: r.preferredBroker || '',
    brokerAccountId: r.brokerAccountId || '',
    payoutWallet: r.payoutWallet || '',
    isEmailVerified: Boolean(r.isEmailVerified),
    metadata: r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) : {}
  }));
}

async function deleteUser(id, email) {
  if (!isMySqlActive()) return false;
  try {
    if (id) await pool.query('DELETE FROM users WHERE id = ?', [id]);
    if (email) await pool.query('DELETE FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    return true;
  } catch (err) {
    console.error('[DATABASE DELETE USER ERROR]:', err.message);
    return false;
  }
}

async function deleteChallenge(id) {
  if (!isMySqlActive() || !id) return false;
  try {
    await pool.query('DELETE FROM challenges WHERE id = ?', [id]);
    return true;
  } catch (err) {
    console.error('[DATABASE DELETE CHALLENGE ERROR]:', err.message);
    return false;
  }
}

async function deleteSubmission(id) {
  if (!isMySqlActive() || !id) return false;
  try {
    await pool.query('DELETE FROM submissions WHERE id = ?', [id]);
    return true;
  } catch (err) {
    console.error('[DATABASE DELETE SUBMISSION ERROR]:', err.message);
    return false;
  }
}

// ==================== PARTNER / AFFILIATE PROGRAM CRUD ====================

async function getAllPartners() {
  if (!isMySqlActive()) return null;
  const [rows] = await pool.query('SELECT * FROM partners ORDER BY createdAt DESC');
  return rows.map(formatPartner);
}

async function getPartnerById(id) {
  if (!isMySqlActive() || !id) return null;
  const [rows] = await pool.query('SELECT * FROM partners WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0 ? formatPartner(rows[0]) : null;
}

async function getPartnerByEmail(email) {
  if (!isMySqlActive() || !email) return null;
  const [rows] = await pool.query('SELECT * FROM partners WHERE email = ? LIMIT 1', [email.trim().toLowerCase()]);
  return rows.length > 0 ? formatPartner(rows[0]) : null;
}

async function getPartnerByPromoCode(code) {
  if (!isMySqlActive() || !code) return null;
  const [rows] = await pool.query('SELECT * FROM partners WHERE UPPER(promoCode) = ? LIMIT 1', [code.trim().toUpperCase()]);
  return rows.length > 0 ? formatPartner(rows[0]) : null;
}

async function savePartner(partner) {
  if (!isMySqlActive() || !partner || !partner.id) return false;
  try {
    const normEmail = partner.email ? partner.email.trim().toLowerCase() : '';
    const [existing] = await pool.query('SELECT id FROM partners WHERE id = ? OR (email != "" AND email = ?) LIMIT 1', [partner.id, normEmail]);
    const targetId = existing.length > 0 ? existing[0].id : partner.id;

    if (existing.length === 0) {
      await pool.query(`INSERT INTO partners (
        id, name, email, password, phone, promoCode, commissionRate, traderDiscount,
        payoutMethod, payoutDetails, status, isEmailVerified, emailVerificationCode,
        emailVerificationExpires, emailVerifiedAt, role, totalReferred, totalSales,
        totalCommissionEarned, totalCommissionPaid, pendingCommission, notes, useCustomRate,
        createdAt, updatedAt, customLinks, rawPartnerData
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        partner.id,
        partner.name || '',
        normEmail,
        partner.password || '',
        partner.phone || '',
        partner.promoCode || '',
        partner.commissionRate || 10,
        partner.traderDiscount || 5,
        partner.payoutMethod || 'Binance Pay',
        partner.payoutDetails || '',
        partner.status || 'active',
        partner.isEmailVerified ? 1 : 0,
        partner.emailVerificationCode || null,
        toMySqlDateTime(partner.emailVerificationExpires),
        toMySqlDateTime(partner.emailVerifiedAt),
        partner.role || 'partner',
        partner.totalReferred || 0,
        partner.totalSales || 0,
        partner.totalCommissionEarned || 0,
        partner.totalCommissionPaid || 0,
        partner.pendingCommission || 0,
        partner.notes || '',
        partner.useCustomRate ? 1 : 0,
        toMySqlDateTime(partner.createdAt) || new Date(),
        toMySqlDateTime(partner.updatedAt) || new Date(),
        JSON.stringify(partner.customLinks || []),
        JSON.stringify(partner)
      ]);
    } else {
      await pool.query(`UPDATE partners SET
        name = ?, email = ?, password = ?, phone = ?, promoCode = ?, commissionRate = ?,
        traderDiscount = ?, payoutMethod = ?, payoutDetails = ?, status = ?,
        isEmailVerified = ?, emailVerificationCode = ?, emailVerificationExpires = ?,
        emailVerifiedAt = ?, role = ?, totalReferred = ?, totalSales = ?,
        totalCommissionEarned = ?, totalCommissionPaid = ?, pendingCommission = ?,
        notes = ?, useCustomRate = ?, updatedAt = ?, customLinks = ?, rawPartnerData = ?
        WHERE id = ?`, [
        partner.name || '',
        normEmail,
        partner.password || '',
        partner.phone || '',
        partner.promoCode || '',
        partner.commissionRate || 10,
        partner.traderDiscount || 5,
        partner.payoutMethod || 'Binance Pay',
        partner.payoutDetails || '',
        partner.status || 'active',
        partner.isEmailVerified ? 1 : 0,
        partner.emailVerificationCode || null,
        toMySqlDateTime(partner.emailVerificationExpires),
        toMySqlDateTime(partner.emailVerifiedAt),
        partner.role || 'partner',
        partner.totalReferred || 0,
        partner.totalSales || 0,
        partner.totalCommissionEarned || 0,
        partner.totalCommissionPaid || 0,
        partner.pendingCommission || 0,
        partner.notes || '',
        partner.useCustomRate ? 1 : 0,
        toMySqlDateTime(partner.updatedAt) || new Date(),
        JSON.stringify(partner.customLinks || []),
        JSON.stringify(partner),
        targetId
      ]);
    }
    return true;
  } catch (err) {
    // If error was about missing customLinks column, fallback to standard query
    if (err.message && (err.message.includes('customLinks') || err.message.includes('Unknown column'))) {
      try {
        const normEmail = partner.email ? partner.email.trim().toLowerCase() : '';
        const [existing] = await pool.query('SELECT id FROM partners WHERE id = ? OR (email != "" AND email = ?) LIMIT 1', [partner.id, normEmail]);
        const targetId = existing.length > 0 ? existing[0].id : partner.id;
        if (existing.length === 0) {
          await pool.query(`INSERT INTO partners (
            id, name, email, password, phone, promoCode, commissionRate, traderDiscount,
            payoutMethod, payoutDetails, status, isEmailVerified, emailVerificationCode,
            emailVerificationExpires, emailVerifiedAt, role, totalReferred, totalSales,
            totalCommissionEarned, totalCommissionPaid, pendingCommission, notes, useCustomRate,
            createdAt, updatedAt, rawPartnerData
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            partner.id, partner.name || '', normEmail, partner.password || '', partner.phone || '',
            partner.promoCode || '', partner.commissionRate || 10, partner.traderDiscount || 5,
            partner.payoutMethod || 'Binance Pay', partner.payoutDetails || '', partner.status || 'active',
            partner.isEmailVerified ? 1 : 0, partner.emailVerificationCode || null,
            toMySqlDateTime(partner.emailVerificationExpires), toMySqlDateTime(partner.emailVerifiedAt),
            partner.role || 'partner', partner.totalReferred || 0, partner.totalSales || 0,
            partner.totalCommissionEarned || 0, partner.totalCommissionPaid || 0, partner.pendingCommission || 0,
            partner.notes || '', partner.useCustomRate ? 1 : 0, toMySqlDateTime(partner.createdAt) || new Date(),
            toMySqlDateTime(partner.updatedAt) || new Date(), JSON.stringify(partner)
          ]);
        } else {
          await pool.query(`UPDATE partners SET
            name = ?, email = ?, password = ?, phone = ?, promoCode = ?, commissionRate = ?,
            traderDiscount = ?, payoutMethod = ?, payoutDetails = ?, status = ?,
            isEmailVerified = ?, emailVerificationCode = ?, emailVerificationExpires = ?,
            emailVerifiedAt = ?, role = ?, totalReferred = ?, totalSales = ?,
            totalCommissionEarned = ?, totalCommissionPaid = ?, pendingCommission = ?,
            notes = ?, useCustomRate = ?, updatedAt = ?, rawPartnerData = ?
            WHERE id = ?`, [
            partner.name || '', normEmail, partner.password || '', partner.phone || '', partner.promoCode || '',
            partner.commissionRate || 10, partner.traderDiscount || 5, partner.payoutMethod || 'Binance Pay',
            partner.payoutDetails || '', partner.status || 'active', partner.isEmailVerified ? 1 : 0,
            partner.emailVerificationCode || null, toMySqlDateTime(partner.emailVerificationExpires),
            toMySqlDateTime(partner.emailVerifiedAt), partner.role || 'partner', partner.totalReferred || 0,
            partner.totalSales || 0, partner.totalCommissionEarned || 0, partner.totalCommissionPaid || 0,
            partner.pendingCommission || 0, partner.notes || '', partner.useCustomRate ? 1 : 0,
            toMySqlDateTime(partner.updatedAt) || new Date(), JSON.stringify(partner), targetId
          ]);
        }
        return true;
      } catch (retryErr) {
        console.error('[DATABASE SAVE PARTNER RETRY ERROR]:', retryErr.message);
        return false;
      }
    }
    console.error('[DATABASE SAVE PARTNER ERROR]:', err.message);
    return false;
  }
}

async function deletePartner(id) {
  if (!isMySqlActive() || !id) return false;
  try {
    await pool.query('DELETE FROM partners WHERE id = ?', [id]);
    return true;
  } catch (err) {
    console.error('[DATABASE DELETE PARTNER ERROR]:', err.message);
    return false;
  }
}

// ==================== PROMO CODES CRUD ====================

async function getAllPromoCodes() {
  if (!isMySqlActive()) return null;
  const [rows] = await pool.query('SELECT * FROM promo_codes ORDER BY createdAt DESC');
  return rows.map(formatPromoCode);
}

async function getPromoCodeByCode(code) {
  if (!isMySqlActive() || !code) return null;
  const [rows] = await pool.query('SELECT * FROM promo_codes WHERE UPPER(code) = ? LIMIT 1', [code.trim().toUpperCase()]);
  return rows.length > 0 ? formatPromoCode(rows[0]) : null;
}

async function savePromoCode(promo) {
  if (!isMySqlActive() || !promo || !promo.id) return false;
  try {
    const cleanCode = promo.code ? promo.code.trim().toUpperCase() : '';
    const [existing] = await pool.query('SELECT id FROM promo_codes WHERE id = ? OR (code != "" AND UPPER(code) = ?) LIMIT 1', [promo.id, cleanCode]);

    const pkgIdsJson = promo.packageIds ? JSON.stringify(promo.packageIds) : JSON.stringify(['all']);

    if (existing.length === 0) {
      await pool.query(`INSERT INTO promo_codes (
        id, code, discountType, discountValue, packageId, packageIds,
        maxUses, usedCount, expiresAt, status, notes,
        isPartnerCode, partnerId, partnerName, createdAt, updatedAt, rawPromoData
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        promo.id,
        cleanCode,
        promo.discountType || 'percentage',
        promo.discountValue || 0,
        promo.packageId || 'all',
        pkgIdsJson,
        promo.maxUses !== undefined ? promo.maxUses : null,
        promo.usedCount || 0,
        toMySqlDateTime(promo.expiresAt),
        promo.status || 'active',
        promo.notes || '',
        promo.isPartnerCode ? 1 : 0,
        promo.partnerId || null,
        promo.partnerName || null,
        toMySqlDateTime(promo.createdAt) || new Date(),
        toMySqlDateTime(promo.updatedAt) || new Date(),
        JSON.stringify(promo)
      ]);
    } else {
      await pool.query(`UPDATE promo_codes SET
        code = ?, discountType = ?, discountValue = ?, packageId = ?, packageIds = ?,
        maxUses = ?, usedCount = ?, expiresAt = ?, status = ?, notes = ?,
        isPartnerCode = ?, partnerId = ?, partnerName = ?, updatedAt = ?, rawPromoData = ?
        WHERE id = ?`, [
        cleanCode,
        promo.discountType || 'percentage',
        promo.discountValue || 0,
        promo.packageId || 'all',
        pkgIdsJson,
        promo.maxUses !== undefined ? promo.maxUses : null,
        promo.usedCount || 0,
        toMySqlDateTime(promo.expiresAt),
        promo.status || 'active',
        promo.notes || '',
        promo.isPartnerCode ? 1 : 0,
        promo.partnerId || null,
        promo.partnerName || null,
        toMySqlDateTime(promo.updatedAt) || new Date(),
        JSON.stringify(promo),
        promo.id
      ]);
    }
    return true;
  } catch (err) {
    console.error('[DATABASE SAVE PROMO ERROR]:', err.message);
    return false;
  }
}

async function deletePromoCode(id) {
  if (!isMySqlActive() || !id) return false;
  try {
    await pool.query('DELETE FROM promo_codes WHERE id = ? OR UPPER(code) = ?', [id, id.toUpperCase()]);
    return true;
  } catch (err) {
    console.error('[DATABASE DELETE PROMO ERROR]:', err.message);
    return false;
  }
}

// ==================== PARTNER PAYOUTS CRUD ====================

async function getAllPartnerPayouts() {
  if (!isMySqlActive()) return null;
  const [rows] = await pool.query('SELECT * FROM partner_payouts ORDER BY requestedAt DESC');
  return rows.map(formatPartnerPayout);
}

async function savePartnerPayout(payout) {
  if (!isMySqlActive() || !payout || !payout.id) return false;
  try {
    const [existing] = await pool.query('SELECT id FROM partner_payouts WHERE id = ? LIMIT 1', [payout.id]);
    if (existing.length === 0) {
      await pool.query(`INSERT INTO partner_payouts (
        id, partnerId, partnerName, partnerEmail, partnerPromoCode, amount,
        paymentMethod, payoutAddress, status, adminNotes, rejectionReason,
        transactionProofUrl, requestedAt, paidAt, createdAt, rawPayoutData
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        payout.id,
        payout.partnerId || '',
        payout.partnerName || '',
        payout.partnerEmail || '',
        payout.partnerPromoCode || '',
        payout.amount || 0,
        payout.paymentMethod || 'Binance Pay',
        payout.payoutAddress || '',
        payout.status || 'pending',
        payout.adminNotes || null,
        payout.rejectionReason || null,
        payout.transactionProofUrl || null,
        toMySqlDateTime(payout.requestedAt) || new Date(),
        toMySqlDateTime(payout.paidAt),
        toMySqlDateTime(payout.createdAt) || new Date(),
        JSON.stringify(payout)
      ]);
    } else {
      await pool.query(`UPDATE partner_payouts SET
        partnerName = ?, partnerEmail = ?, partnerPromoCode = ?, amount = ?,
        paymentMethod = ?, payoutAddress = ?, status = ?, adminNotes = ?,
        rejectionReason = ?, transactionProofUrl = ?, paidAt = ?, rawPayoutData = ?
        WHERE id = ?`, [
        payout.partnerName || '',
        payout.partnerEmail || '',
        payout.partnerPromoCode || '',
        payout.amount || 0,
        payout.paymentMethod || 'Binance Pay',
        payout.payoutAddress || '',
        payout.status || 'pending',
        payout.adminNotes || null,
        payout.rejectionReason || null,
        payout.transactionProofUrl || null,
        toMySqlDateTime(payout.paidAt),
        JSON.stringify(payout),
        payout.id
      ]);
    }
    return true;
  } catch (err) {
    console.error('[DATABASE SAVE PARTNER PAYOUT ERROR]:', err.message);
    return false;
  }
}

async function deletePartnerPayout(id) {
  if (!isMySqlActive() || !id) return false;
  try {
    await pool.query('DELETE FROM partner_payouts WHERE id = ?', [id]);
    return true;
  } catch (err) {
    console.error('[DATABASE DELETE PARTNER PAYOUT ERROR]:', err.message);
    return false;
  }
}

// ==================== PARTNER SETTINGS CRUD ====================

async function getPartnerSettings() {
  if (!isMySqlActive()) return null;
  try {
    const [rows] = await pool.query("SELECT settingsData FROM partner_settings WHERE id = 'default' LIMIT 1");
    if (rows.length > 0 && rows[0].settingsData) {
      return typeof rows[0].settingsData === 'string' ? JSON.parse(rows[0].settingsData) : rows[0].settingsData;
    }
  } catch (e) {
    console.error('[DATABASE GET PARTNER SETTINGS ERROR]:', e.message);
  }
  return null;
}

async function savePartnerSettings(settings) {
  if (!isMySqlActive() || !settings) return false;
  try {
    const dataStr = JSON.stringify(settings);
    await pool.query(`INSERT INTO partner_settings (id, settingsData, updatedAt)
      VALUES ('default', ?, NOW())
      ON DUPLICATE KEY UPDATE settingsData = VALUES(settingsData), updatedAt = NOW()`, [dataStr]);
    return true;
  } catch (e) {
    console.error('[DATABASE SAVE PARTNER SETTINGS ERROR]:', e.message);
    return false;
  }
}

// ==================== PARTNER PROMO REQUESTS CRUD ====================

async function getAllPartnerPromoRequests() {
  if (!isMySqlActive()) return null;
  const [rows] = await pool.query('SELECT * FROM partner_promo_requests ORDER BY requestedAt DESC');
  return rows.map(formatPartnerPromoRequest);
}

async function savePartnerPromoRequest(r) {
  if (!isMySqlActive() || !r || !r.id) return false;
  try {
    const [existing] = await pool.query('SELECT id FROM partner_promo_requests WHERE id = ? LIMIT 1', [r.id]);
    if (existing.length === 0) {
      await pool.query(`INSERT INTO partner_promo_requests (
        id, partnerId, partnerName, partnerEmail, promoCode,
        requestedDiscount, status, adminFeedback, requestedAt, reviewedAt, rawRequestData
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        r.id,
        r.partnerId || '',
        r.partnerName || '',
        r.partnerEmail || '',
        r.promoCode || '',
        r.requestedDiscount || 5,
        r.status || 'pending',
        r.adminFeedback || null,
        toMySqlDateTime(r.requestedAt) || new Date(),
        toMySqlDateTime(r.reviewedAt),
        JSON.stringify(r)
      ]);
    } else {
      await pool.query(`UPDATE partner_promo_requests SET
        status = ?, adminFeedback = ?, reviewedAt = ?, rawRequestData = ?
        WHERE id = ?`, [
        r.status || 'pending',
        r.adminFeedback || null,
        toMySqlDateTime(r.reviewedAt) || new Date(),
        JSON.stringify(r),
        r.id
      ]);
    }
    return true;
  } catch (err) {
    console.error('[DATABASE SAVE PARTNER PROMO REQUEST ERROR]:', err.message);
    return false;
  }
}

// ==================== TRADER PAYOUTS CRUD ====================

async function getAllPayouts() {
  if (!isMySqlActive()) return null;
  const [rows] = await pool.query('SELECT * FROM payouts ORDER BY createdAt DESC');
  return rows.map(formatTraderPayout);
}

async function savePayout(payout) {
  if (!isMySqlActive() || !payout || (!payout.id && !payout.payoutId)) return false;
  try {
    const primaryId = payout.id || payout.payoutId;
    const [existing] = await pool.query('SELECT id FROM payouts WHERE id = ? OR payoutId = ? LIMIT 1', [primaryId, payout.payoutId || primaryId]);
    if (existing.length === 0) {
      await pool.query(`INSERT INTO payouts (
        id, userId, payoutId, amount, status, createdAt, updatedAt, rawPayoutData
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        primaryId,
        payout.userId || '',
        payout.payoutId || primaryId,
        payout.amount || 0,
        payout.status || 'pending',
        toMySqlDateTime(payout.createdAt) || new Date(),
        toMySqlDateTime(payout.updatedAt) || new Date(),
        JSON.stringify(payout)
      ]);
    } else {
      await pool.query(`UPDATE payouts SET
        amount = ?, status = ?, updatedAt = ?, rawPayoutData = ?
        WHERE id = ? OR payoutId = ?`, [
        payout.amount || 0,
        payout.status || 'pending',
        toMySqlDateTime(payout.updatedAt) || new Date(),
        JSON.stringify(payout),
        primaryId,
        payout.payoutId || primaryId
      ]);
    }
    return true;
  } catch (err) {
    console.error('[DATABASE SAVE PAYOUT ERROR]:', err.message);
    return false;
  }
}

async function deletePayout(id) {
  if (!isMySqlActive() || !id) return false;
  try {
    await pool.query('DELETE FROM payouts WHERE id = ? OR payoutId = ?', [id, id]);
    return true;
  } catch (err) {
    console.error('[DATABASE DELETE PAYOUT ERROR]:', err.message);
    return false;
  }
}

// ==================== PAYOUT SETTINGS CRUD ====================

async function getPayoutSettings() {
  if (!isMySqlActive()) return null;
  try {
    const [rows] = await pool.query("SELECT settingsData FROM payout_settings WHERE id = 'default' LIMIT 1");
    if (rows.length > 0 && rows[0].settingsData) {
      return typeof rows[0].settingsData === 'string' ? JSON.parse(rows[0].settingsData) : rows[0].settingsData;
    }
  } catch (e) {
    console.error('[DATABASE GET PAYOUT SETTINGS ERROR]:', e.message);
  }
  return null;
}

async function savePayoutSettings(settings) {
  if (!isMySqlActive() || !settings) return false;
  try {
    const dataStr = JSON.stringify(settings);
    await pool.query(`INSERT INTO payout_settings (id, settingsData, updatedAt)
      VALUES ('default', ?, NOW())
      ON DUPLICATE KEY UPDATE settingsData = VALUES(settingsData), updatedAt = NOW()`, [dataStr]);
    return true;
  } catch (e) {
    console.error('[DATABASE SAVE PAYOUT SETTINGS ERROR]:', e.message);
    return false;
  }
}

// ==================== LAUNCH PROMO CRUD ====================

async function getLaunchPromo() {
  if (!isMySqlActive()) return null;
  try {
    const [rows] = await pool.query("SELECT promoData FROM launch_promo WHERE id = 'default' LIMIT 1");
    if (rows.length > 0 && rows[0].promoData) {
      return typeof rows[0].promoData === 'string' ? JSON.parse(rows[0].promoData) : rows[0].promoData;
    }
  } catch (e) {
    console.error('[DATABASE GET LAUNCH PROMO ERROR]:', e.message);
  }
  return null;
}

async function saveLaunchPromo(promo) {
  if (!isMySqlActive() || !promo) return false;
  try {
    const dataStr = JSON.stringify(promo);
    await pool.query(`INSERT INTO launch_promo (id, promoData, updatedAt)
      VALUES ('default', ?, NOW())
      ON DUPLICATE KEY UPDATE promoData = VALUES(promoData), updatedAt = NOW()`, [dataStr]);
    return true;
  } catch (e) {
    console.error('[DATABASE SAVE LAUNCH PROMO ERROR]:', e.message);
    return false;
  }
}

// ==================== PROMO PRESETS CRUD ====================

async function getPromoPresets() {
  if (!isMySqlActive()) return null;
  try {
    const [rows] = await pool.query("SELECT presetsData FROM promo_presets WHERE id = 'default' LIMIT 1");
    if (rows.length > 0 && rows[0].presetsData) {
      return typeof rows[0].presetsData === 'string' ? JSON.parse(rows[0].presetsData) : rows[0].presetsData;
    }
  } catch (e) {
    console.error('[DATABASE GET PROMO PRESETS ERROR]:', e.message);
  }
  return null;
}

async function savePromoPresets(presets) {
  if (!isMySqlActive() || !presets) return false;
  try {
    const dataStr = JSON.stringify(presets);
    await pool.query(`INSERT INTO promo_presets (id, presetsData, updatedAt)
      VALUES ('default', ?, NOW())
      ON DUPLICATE KEY UPDATE presetsData = VALUES(presetsData), updatedAt = NOW()`, [dataStr]);
    return true;
  } catch (e) {
    console.error('[DATABASE SAVE PROMO PRESETS ERROR]:', e.message);
    return false;
  }
}

async function hydrateFromMySql(dataDir) {
  if (!isMySqlActive()) return false;
  try {
    const users = await getAllUsers();
    const challenges = await getAllChallenges();
    const submissions = await getAllSubmissions();
    const archive = await getAllArchiveLogs();

    if (users && users.length > 0) {
      const usersFile = path.join(dataDir, 'users.json');
      const permUsersFile = path.join(dataDir, 'users_permanent_store.json');
      // Merge with existing file to guarantee zero data loss
      let existingUsers = [];
      try {
        if (fs.existsSync(usersFile)) existingUsers = JSON.parse(fs.readFileSync(usersFile, 'utf8') || '[]');
      } catch (e) {}
      const userMap = new Map();
      existingUsers.forEach(u => { if (u && u.id) userMap.set(u.id, u); });
      users.forEach(u => { if (u && u.id) userMap.set(u.id, u); });
      const mergedUsers = Array.from(userMap.values());
      fs.writeFileSync(usersFile, JSON.stringify(mergedUsers, null, 2), 'utf8');
      fs.writeFileSync(permUsersFile, JSON.stringify(mergedUsers, null, 2), 'utf8');
    }

    if (challenges && challenges.length > 0) {
      const chFile = path.join(dataDir, 'challenges.json');
      const permChFile = path.join(dataDir, 'challenges_permanent_store.json');
      let existingCh = [];
      try {
        if (fs.existsSync(chFile)) existingCh = JSON.parse(fs.readFileSync(chFile, 'utf8') || '[]');
      } catch (e) {}
      const chMap = new Map();
      existingCh.forEach(c => { if (c && c.id) chMap.set(c.id, c); });
      challenges.forEach(c => { if (c && c.id) chMap.set(c.id, c); });
      const mergedCh = Array.from(chMap.values());
      fs.writeFileSync(chFile, JSON.stringify(mergedCh, null, 2), 'utf8');
      fs.writeFileSync(permChFile, JSON.stringify(mergedCh, null, 2), 'utf8');
    }

    if (submissions && submissions.length > 0) {
      const subFile = path.join(dataDir, 'submissions.json');
      let existingSub = [];
      try {
        if (fs.existsSync(subFile)) existingSub = JSON.parse(fs.readFileSync(subFile, 'utf8') || '[]');
      } catch (e) {}
      const subMap = new Map();
      existingSub.forEach(s => { if (s && s.id) subMap.set(s.id, s); });
      submissions.forEach(s => { if (s && s.id) subMap.set(s.id, s); });
      const mergedSub = Array.from(subMap.values());
      fs.writeFileSync(subFile, JSON.stringify(mergedSub, null, 2), 'utf8');
    }

    if (archive && archive.length > 0) {
      const arcFile = path.join(dataDir, 'user_archive.json');
      let existingArc = [];
      try {
        if (fs.existsSync(arcFile)) existingArc = JSON.parse(fs.readFileSync(arcFile, 'utf8') || '[]');
      } catch (e) {}
      const arcMap = new Map();
      existingArc.forEach(a => { if (a && a.archiveId) arcMap.set(a.archiveId, a); });
      archive.forEach(a => { if (a && a.archiveId) arcMap.set(a.archiveId, a); });
      const mergedArc = Array.from(arcMap.values());
      fs.writeFileSync(arcFile, JSON.stringify(mergedArc, null, 2), 'utf8');
    }

    // 5. Partners Hydration
    const partners = await getAllPartners();
    if (partners && partners.length > 0) {
      const pFile = path.join(dataDir, 'partners.json');
      const permPFile = path.join(dataDir, 'partners_permanent_store.json');
      let existing = [];
      try { if (fs.existsSync(pFile)) existing = JSON.parse(fs.readFileSync(pFile, 'utf8') || '[]'); } catch (e) {}
      const pMap = new Map();
      existing.forEach(p => { if (p && p.id) pMap.set(p.id, p); });
      partners.forEach(p => { if (p && p.id) pMap.set(p.id, p); });
      const merged = Array.from(pMap.values());
      fs.writeFileSync(pFile, JSON.stringify(merged, null, 2), 'utf8');
      fs.writeFileSync(permPFile, JSON.stringify(merged, null, 2), 'utf8');
    }

    // 6. Promo Codes Hydration
    const promos = await getAllPromoCodes();
    if (promos && promos.length > 0) {
      const prFile = path.join(dataDir, 'promo_codes.json');
      const permPrFile = path.join(dataDir, 'promo_codes_permanent_store.json');
      let existing = [];
      try { if (fs.existsSync(prFile)) existing = JSON.parse(fs.readFileSync(prFile, 'utf8') || '[]'); } catch (e) {}
      const prMap = new Map();
      existing.forEach(pr => { if (pr && (pr.id || pr.code)) prMap.set(pr.id || pr.code, pr); });
      promos.forEach(pr => { if (pr && (pr.id || pr.code)) prMap.set(pr.id || pr.code, pr); });
      const merged = Array.from(prMap.values());
      fs.writeFileSync(prFile, JSON.stringify(merged, null, 2), 'utf8');
      fs.writeFileSync(permPrFile, JSON.stringify(merged, null, 2), 'utf8');
    }

    // 7. Partner Payouts Hydration
    const ppayouts = await getAllPartnerPayouts();
    if (ppayouts && ppayouts.length > 0) {
      const ppFile = path.join(dataDir, 'partner_payouts.json');
      let existing = [];
      try { if (fs.existsSync(ppFile)) existing = JSON.parse(fs.readFileSync(ppFile, 'utf8') || '[]'); } catch (e) {}
      const ppMap = new Map();
      existing.forEach(p => { if (p && p.id) ppMap.set(p.id, p); });
      ppayouts.forEach(p => { if (p && p.id) ppMap.set(p.id, p); });
      const merged = Array.from(ppMap.values());
      fs.writeFileSync(ppFile, JSON.stringify(merged, null, 2), 'utf8');
    }

    // 8. Partner Settings Hydration
    const psettings = await getPartnerSettings();
    if (psettings && Object.keys(psettings).length > 0) {
      const psFile = path.join(dataDir, 'partner_settings.json');
      fs.writeFileSync(psFile, JSON.stringify(psettings, null, 2), 'utf8');
    }

    // 9. Partner Promo Requests Hydration
    const prequests = await getAllPartnerPromoRequests();
    if (prequests && prequests.length > 0) {
      const prqFile = path.join(dataDir, 'partner_promo_requests.json');
      let existing = [];
      try { if (fs.existsSync(prqFile)) existing = JSON.parse(fs.readFileSync(prqFile, 'utf8') || '[]'); } catch (e) {}
      const prqMap = new Map();
      existing.forEach(r => { if (r && r.id) prqMap.set(r.id, r); });
      prequests.forEach(r => { if (r && r.id) prqMap.set(r.id, r); });
      const merged = Array.from(prqMap.values());
      fs.writeFileSync(prqFile, JSON.stringify(merged, null, 2), 'utf8');
    }

    // 10. Trader Payouts Hydration
    const tpayouts = await getAllPayouts();
    if (tpayouts && tpayouts.length > 0) {
      const tpFile = path.join(dataDir, 'payouts.json');
      let existing = [];
      try { if (fs.existsSync(tpFile)) existing = JSON.parse(fs.readFileSync(tpFile, 'utf8') || '[]'); } catch (e) {}
      const tpMap = new Map();
      existing.forEach(p => { if (p && (p.id || p.payoutId)) tpMap.set(p.id || p.payoutId, p); });
      tpayouts.forEach(p => { if (p && (p.id || p.payoutId)) tpMap.set(p.id || p.payoutId, p); });
      const merged = Array.from(tpMap.values());
      fs.writeFileSync(tpFile, JSON.stringify(merged, null, 2), 'utf8');
    }

    // 11. Payout Settings Hydration
    const tpsettings = await getPayoutSettings();
    if (tpsettings && Object.keys(tpsettings).length > 0) {
      const tpsFile = path.join(dataDir, 'payout_settings.json');
      fs.writeFileSync(tpsFile, JSON.stringify(tpsettings, null, 2), 'utf8');
    }

    // 12. Launch Promo Hydration
    const lpromo = await getLaunchPromo();
    if (lpromo && Object.keys(lpromo).length > 0) {
      const lpFile = path.join(dataDir, 'launch_promo.json');
      fs.writeFileSync(lpFile, JSON.stringify(lpromo, null, 2), 'utf8');
    }

    // 13. Promo Presets Hydration
    const ppresets = await getPromoPresets();
    if (ppresets && Array.isArray(ppresets) && ppresets.length > 0) {
      const prsFile = path.join(dataDir, 'promo_presets.json');
      fs.writeFileSync(prsFile, JSON.stringify(ppresets, null, 2), 'utf8');
    }

    console.log('[DATABASE] ✅ Local safe cache hydrated with live MySQL data.');
    return true;
  } catch (err) {
    console.error('[DATABASE HYDRATION ERROR]:', err.message);
    return false;
  }
}

module.exports = {
  initDatabase,
  initSchema,
  autoMigrateFromJson,
  hydrateFromMySql,
  isMySqlConfigured,
  isMySqlActive,
  getAllUsers,
  getUserByEmail,
  getUserById,
  saveUser,
  deleteUser,
  getAllChallenges,
  getChallengeById,
  saveChallenge,
  deleteChallenge,
  getAllSubmissions,
  saveSubmission,
  deleteSubmission,
  logArchiveEntry,
  getAllArchiveLogs,
  // Affiliate / Partner Program
  getAllPartners,
  getPartnerById,
  getPartnerByEmail,
  getPartnerByPromoCode,
  savePartner,
  deletePartner,
  getAllPartnerPayouts,
  savePartnerPayout,
  deletePartnerPayout,
  getPartnerSettings,
  savePartnerSettings,
  getAllPartnerPromoRequests,
  savePartnerPromoRequest,
  // Promo Codes & Presets
  getAllPromoCodes,
  getPromoCodeByCode,
  savePromoCode,
  deletePromoCode,
  getLaunchPromo,
  saveLaunchPromo,
  getPromoPresets,
  savePromoPresets,
  // Payouts
  getAllPayouts,
  savePayout,
  deletePayout,
  getPayoutSettings,
  savePayoutSettings,
  getPool: () => pool
};
