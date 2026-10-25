---
trigger: always_on
---

# Database Safety & Production Data Integrity Rules

## 1. Absolute Immutability of Production Data
Strictly Prohibited: Never modify, delete, overwrite, or mock any production database files or JSON data files (e.g., users.json, challenges.json, user_archive.json, partners.json, promo_codes.json, payouts.json, etc.).

## 2. Prohibition of Destructive Actions & Mock Seeders
Do not run any destructive commands, scripts, or seeders that might reset user accounts, affiliate/partner records, promo codes, or active challenges. Under NO circumstance should promo codes or partner data be overwritten with empty arrays or dummy defaults.

## 3. Affiliate/Partner & Promo Code Protection
Affiliate accounts, referral tracking histories, partner earnings, wallets, commission levels, and Admin Discount Promo Codes must NEVER be dropped, seeded, modified, or overwritten during any feature updates. All dynamic JSON data files must remain untracked in `.gitignore`.

## 4. Explicit Human Approval Requirement
Always ask for explicit human permission before updating any state, data structure, or database logic.
