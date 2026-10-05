# LIFELONG TRADERS VAULT - SECURITY & RECOVERY PROTOCOL

This directory is the supreme immutable store of registered traders on Binary Prop Firm.
Master Security Password: AJHAR1

Every registered trader is saved in:
1. `master_registered_traders_vault.json`: Full array of registered users.
2. `traders/trader_<userId>.json`: Individual isolated record for every trader.
3. `vault_audit_log.jsonl`: Immutable append-only audit trail.

This data is guarded by server-level locks:
- No user can be deleted without providing master password `AJHAR1`.
- Any restart or redeployment restores missing records automatically from this vault.
