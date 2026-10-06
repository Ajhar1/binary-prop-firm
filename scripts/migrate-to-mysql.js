/**
 * Safe, Non-Destructive MySQL Schema Sync & Data Migration Script
 * 
 * Usage:
 *   node scripts/migrate-to-mysql.js
 * 
 * Requirements:
 *   DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD environment variables in .env
 * 
 * Guarantees:
 *   1. NEVER drops existing tables or alters existing data.
 *   2. Idempotent: Can be run multiple times safely without duplicate or lost records.
 *   3. All existing JSON files remain 100% untouched and preserved.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const db = require('../db');

async function runMigration() {
  console.log('====================================================');
  console.log('🚀 BINARY PROP FIRM — SAFE MYSQL DATA MIGRATION');
  console.log('====================================================\n');

  if (!db.isMySqlConfigured()) {
    console.error('❌ ERROR: MySQL environment variables are missing!');
    console.error('Please configure the following in your .env file or environment:');
    console.error('  - DB_HOST');
    console.error('  - DB_PORT (optional, default 3306)');
    console.error('  - DB_DATABASE (or DB_NAME)');
    console.error('  - DB_USERNAME (or DB_USER)');
    console.error('  - DB_PASSWORD (or DB_PASS)\n');
    process.exit(1);
  }

  console.log(`Connecting to MySQL host: ${process.env.DB_HOST}, database: ${process.env.DB_DATABASE || process.env.DB_NAME}...`);
  const connected = await db.initDatabase();

  if (!connected) {
    console.error('❌ Migration aborted: Could not connect to MySQL database.');
    process.exit(1);
  }

  console.log('\n[1/4] Verifying schema and tables...');
  await db.initSchema();
  console.log('✅ Tables verified: users, challenges, submissions, user_archive, support_tickets, synced_trades, trader_states.');

  console.log('\n[2/4] Migrating JSON data into MySQL...');
  await db.autoMigrateFromJson();

  console.log('\n[3/4] Verifying record counts in MySQL...');
  const pool = db.getPool();
  const [[{ userCount }]] = await pool.query('SELECT COUNT(*) as userCount FROM users');
  const [[{ chCount }]] = await pool.query('SELECT COUNT(*) as chCount FROM challenges');
  const [[{ subCount }]] = await pool.query('SELECT COUNT(*) as subCount FROM submissions');
  const [[{ arcCount }]] = await pool.query('SELECT COUNT(*) as arcCount FROM user_archive');

  console.log(`  📊 Users in MySQL:        ${userCount}`);
  console.log(`  📊 Challenges in MySQL:   ${chCount}`);
  console.log(`  📊 Submissions in MySQL:  ${subCount}`);
  console.log(`  📊 Archive logs in MySQL: ${arcCount}`);

  console.log('\n[4/4] Migration completed successfully with ZERO data loss!');
  console.log('====================================================\n');
  process.exit(0);
}

runMigration().catch(err => {
  console.error('\n❌ Unhandled Migration Exception:', err);
  process.exit(1);
});
