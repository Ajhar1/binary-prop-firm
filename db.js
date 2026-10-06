/**
 * Enterprise MySQL Database Connection & Data Access Layer
 * Supports:
 * 1. Native mysql2/promise Connection Pool using process.env
 * 2. Automatic non-destructive schema migration (CREATE TABLE IF NOT EXISTS)
 * 3. Automatic JSON-to-MySQL initial data migration
 * 4. Dual-mode fallback: If MySQL is not configured (e.g. local dev), falls back safely to JSON store
 * 5. Double Safety Mirroring: Writes to MySQL as primary and mirrors to permanent JSON vault
 */

const mysql = require('mysql2/promise');
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
  return Boolean(DB_HOST && DB_DATABASE && DB_USERNAME);
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
      connectionLimit: 10,
      maxIdle: 5,
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
  ];

  for (const q of queries) {
    await pool.query(q);
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
  getPool: () => pool
};
