# Aqua Reward Farmer - Latest Shadow Audit (model v8)

- validatedCodeSha: b27abf5139c0b98c25de0f375f21157dd4d10c9f
- artifactGeneratedAt: 2026-08-20T06:31:58.695Z
- validationOnly: true
- liveCutoffBlock: 25794216
- historicalCutoffBlock: 25793767
- decision: **DO_NOT_TRADE**
- pair: none
- expectedNetUsdPerDay: 0.0000
- stressNetUsdPerDay: 0.0000
- confidence: LOW

## Failed gates

## Reasons
- wallet=0x9adf16a1a098c0832671fd93cd6ef668ad6654b1 nav=0.00 deployable=0.00 (nativeGasReserve=0.00 emergency=0.00)
- CAPITAL_GRID_EMPTY: no research capital levels (wallet unknown or deployable <= 0)
- eligibleActualCandidates=0
- CAPITAL_SELECTION: no eligible ACTUAL_WALLET regime (fail closed)
- VALIDATION_ONLY: no persistence-qualifying snapshot written (external ACCEPT pending)
- no candidates produced (no eligible pair data or no capital grid)
- QUALIFICATION_UNVERIFIED: haircut=0.6
- modelVersion=8 capital=0 (none) qualifyingSnapshots=0 span=0.0h (total snapshots=22, validationOnly excluded, hypothetical never qualifies)
- FAIL: need >= 3 qualifying snapshots (same modelVersion/configFingerprint/pair/fee/range/capitalUsd/capitalSource + wallet regime, all gates passing)

_Read-only shadow audit; no transaction was signed or broadcast. The artifact may be committed in a later audit-only commit; validatedCodeSha identifies the code commit that was validated._