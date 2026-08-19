# Aqua Reward Farmer - Latest Shadow Audit (model v4)

- validatedCodeSha: cd9ba918030f49704fab8bc3eac0ad381fc2c1f6
- artifactGeneratedAt: 2026-08-19T10:38:53.619Z
- validationOnly: true
- liveCutoffBlock: 25788314
- historicalCutoffBlock: 25787866
- decision: **DO_NOT_TRADE**
- pair: none
- expectedNetUsdPerDay: 0.0000
- stressNetUsdPerDay: 0.0000
- confidence: LOW

## Failed gates
- current-fair-price-available: freshDepthQualifiedCurrentPrice=false
- range-path-reliable: RANGE_PATH_RELIABLE: realObs=3 bars=3/3 coverage=100.0% largestGap=360s segments=1 minCoverage=50% minBars=100
- confidence: confidence=LOW
- base-net-positive: net=-0.1057 usd/day
- stress-net-nonnegative: stressNet=-0.2113 usd/day

## Reasons
- VALIDATION_ONLY: no persistence-qualifying snapshot written (external ACCEPT pending)
- no candidate passes gates; best rejected: pair=0x111111111117dC0aa78b770fA6A738034120C302/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 net=-0.1057 stress=-0.2113 conf=LOW eligible=true markoutReliable=true gasKnown=true rangePathReliable=false
- GATE_FAIL: current-fair-price-available - freshDepthQualifiedCurrentPrice=false
- GATE_FAIL: range-path-reliable - RANGE_PATH_RELIABLE: realObs=3 bars=3/3 coverage=100.0% largestGap=360s segments=1 minCoverage=50% minBars=100
- GATE_FAIL: confidence - confidence=LOW
- GATE_FAIL: base-net-positive - net=-0.1057 usd/day
- GATE_FAIL: stress-net-nonnegative - stressNet=-0.2113 usd/day
- QUALIFICATION_UNVERIFIED: haircut=0.6
- modelVersion=4 qualifyingSnapshots=0 span=0.0h (total snapshots=17, validationOnly excluded)
- FAIL: need >= 3 qualifying snapshots (same modelVersion/configFingerprint/pair/regime, all gates passing)

_Read-only shadow audit; no transaction was signed or broadcast. The artifact may be committed in a later audit-only commit; validatedCodeSha identifies the code commit that was validated._