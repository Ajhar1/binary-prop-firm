---
trigger: always_on
---

# Database Safety & Production Data Integrity Rules

## 1. Absolute Immutability of Production Data
Strictly Prohibited: Never modify, delete, overwrite, or mock any production database files or JSON data files (e.g., users.json, challenges.json, user_archive.json, etc.).

## 2. Prohibition of Destructive Actions & Mock Seeders
Do not run any destructive commands, scripts, or seeders that might reset user accounts, create fake users, or alter active challenges.

## 3. Explicit Human Approval Requirement
Always ask for explicit human permission before updating any state, data structure, or database logic.
