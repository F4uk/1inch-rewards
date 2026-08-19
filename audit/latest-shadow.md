# Aqua Reward Farmer - Latest Shadow Audit (model v6)

- validatedCodeSha: 44b048fa29fa4b6ef8a8826465435034014729eb
- artifactGeneratedAt: 2026-08-19T16:43:26.113Z
- validationOnly: true
- liveCutoffBlock: 25790132
- historicalCutoffBlock: 25789683
- decision: **DO_NOT_TRADE**
- pair: none
- expectedNetUsdPerDay: 0.0000
- stressNetUsdPerDay: 0.0000
- confidence: LOW

## Failed gates

## Reasons
- WALLET_CAPITAL_UNKNOWN: no wallet configured
- CAPITAL_GRID_EMPTY: no research capital levels (wallet unknown or deployable <= 0)
- VALIDATION_ONLY: no persistence-qualifying snapshot written (external ACCEPT pending)
- no candidates produced (no eligible pair data or no capital grid)
- QUALIFICATION_UNVERIFIED: haircut=0.6
- modelVersion=6 capital=0 (none) qualifyingSnapshots=0 span=0.0h (total snapshots=19, validationOnly excluded, hypothetical never qualifies)
- FAIL: need >= 3 qualifying snapshots (same modelVersion/configFingerprint/pair/fee/range/capitalUsd/capitalSource + wallet regime, all gates passing)

_Read-only shadow audit; no transaction was signed or broadcast. The artifact may be committed in a later audit-only commit; validatedCodeSha identifies the code commit that was validated._