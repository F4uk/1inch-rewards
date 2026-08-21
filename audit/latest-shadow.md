# Aqua Reward Farmer - Latest Shadow Audit (model v8)

- validatedCodeSha: f86375db7e68464ac400e04a60074f8e44a87800
- artifactGeneratedAt: 2026-08-21T09:19:22.166Z
- validationOnly: true
- liveCutoffBlock: 25802253
- historicalCutoffBlock: 25801879
- decision: **DO_NOT_TRADE**
- pair: none
- expectedNetUsdPerDay: 0.0000
- stressNetUsdPerDay: 0.0000
- confidence: LOW

## Failed gates

## Reasons
- WALLET_CAPITAL_UNKNOWN: no wallet configured
- CAPITAL_GRID_EMPTY: no research capital levels (wallet unknown or deployable <= 0)
- eligibleActualCandidates=0
- CAPITAL_SELECTION: no eligible ACTUAL_WALLET regime (fail closed)
- VALIDATION_ONLY: no persistence-qualifying snapshot written (external ACCEPT pending)
- no candidates produced (no eligible pair data or no capital grid)
- QUALIFICATION_UNVERIFIED: haircut=0.6
- modelVersion=8 capital=0 (none) qualifyingSnapshots=0 span=0.0h (total snapshots=32, validationOnly excluded, hypothetical never qualifies)
- FAIL: need >= 3 qualifying snapshots (same modelVersion/configFingerprint/pair/fee/range/capitalUsd/capitalSource + wallet regime, all gates passing)

_Read-only shadow audit; no transaction was signed or broadcast. The artifact may be committed in a later audit-only commit; validatedCodeSha identifies the code commit that was validated._