# Aqua Reward Farmer - Latest Shadow Audit (model v5)

- validatedCodeSha: 515a8cd35025def7ac222fc6de4729ecefb19402
- artifactGeneratedAt: 2026-08-19T11:44:53.083Z
- validationOnly: true
- liveCutoffBlock: 25788666
- historicalCutoffBlock: 25788217
- decision: **DO_NOT_TRADE**
- pair: none
- expectedNetUsdPerDay: 0.0000
- stressNetUsdPerDay: 0.0000
- confidence: LOW

## Failed gates
- current-fair-price-available: freshDepthQualifiedCurrentPrice=false
- markout-reliable: MARKOUT_UNRELIABLE: missing horizons 1800 required=60,300,1800
- range-path-reliable: RANGE_PATH_RELIABLE: realObs=6 bars=26/589 coverage=4.4% largestGap=172620s segments=2 returnCount=24 minCoverage=50% minBars=100
- confidence: confidence=LOW
- base-net-positive: net=-0.1127 usd/day
- stress-net-nonnegative: stressNet=-0.2254 usd/day

## Reasons
- VALIDATION_ONLY: no persistence-qualifying snapshot written (external ACCEPT pending)
- no candidate passes gates; best rejected: pair=0x111111111117dC0aa78b770fA6A738034120C302/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 net=-0.1127 stress=-0.2254 conf=LOW eligible=true markoutReliable=false gasKnown=true rangePathReliable=false
- GATE_FAIL: current-fair-price-available - freshDepthQualifiedCurrentPrice=false
- GATE_FAIL: markout-reliable - MARKOUT_UNRELIABLE: missing horizons 1800 required=60,300,1800
- GATE_FAIL: range-path-reliable - RANGE_PATH_RELIABLE: realObs=6 bars=26/589 coverage=4.4% largestGap=172620s segments=2 returnCount=24 minCoverage=50% minBars=100
- GATE_FAIL: confidence - confidence=LOW
- GATE_FAIL: base-net-positive - net=-0.1127 usd/day
- GATE_FAIL: stress-net-nonnegative - stressNet=-0.2254 usd/day
- QUALIFICATION_UNVERIFIED: haircut=0.6
- modelVersion=5 qualifyingSnapshots=0 span=0.0h (total snapshots=18, validationOnly excluded)
- FAIL: need >= 3 qualifying snapshots (same modelVersion/configFingerprint/pair/regime, all gates passing)

_Read-only shadow audit; no transaction was signed or broadcast. The artifact may be committed in a later audit-only commit; validatedCodeSha identifies the code commit that was validated._