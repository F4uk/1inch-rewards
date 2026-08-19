# Aqua Reward Farmer - Latest Shadow Audit (model v3)

- headSha: 20072a35dc09d6276f95372095a7cb33f8ed4c09
- timestamp: 2026-08-19T06:14:47.000Z
- liveCutoffBlock: 25787294
- historicalCutoffBlock: 25786844
- decision: **DO_NOT_TRADE**
- pair: none
- expectedNetUsdPerDay: 0.0000
- stressNetUsdPerDay: 0.0000
- confidence: LOW

## Failed gates
- denominator-coverage-complete: campaign=Provide liquidity to stablecoin markets on 1inch Aqua - Season 1 (USDC rewards) markets=42 configured=2 observed=142 otherGroup=99 unresolved=0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2 DENOMINATOR_COVERAGE_INCOMPLETE
- current-fair-price-available: freshDepthQualifiedCurrentPrice=false
- confidence: confidence=LOW

## Reasons
- DENOMINATOR_COVERAGE_INCOMPLETE(ETH_LST): campaign=Provide liquidity to ETH & LST markets on 1inch Aqua - Season 1 (USDC rewards) markets=15 configured=6 observed=142 otherGroup=128 unresolved=0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2 DENOMINATOR_COVERAGE_INCOMPLETE
- DENOMINATOR_COVERAGE_INCOMPLETE(STABLE): campaign=Provide liquidity to stablecoin markets on 1inch Aqua - Season 1 (USDC rewards) markets=42 configured=2 observed=142 otherGroup=99 unresolved=0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2 DENOMINATOR_COVERAGE_INCOMPLETE
- no candidate passes gates; best rejected: pair=0x111111111117dC0aa78b770fA6A738034120C302/0xdAC17F958D2ee523a2206206994597C13D831ec7 net=179.9208 stress=116.0781 conf=LOW eligible=true markoutReliable=true gasKnown=true
- GATE_FAIL: denominator-coverage-complete - campaign=Provide liquidity to stablecoin markets on 1inch Aqua - Season 1 (USDC rewards) markets=42 configured=2 observed=142 otherGroup=99 unresolved=0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2 DENOMINATOR_COVERAGE_INCOMPLETE
- GATE_FAIL: current-fair-price-available - freshDepthQualifiedCurrentPrice=false
- GATE_FAIL: confidence - confidence=LOW
- QUALIFICATION_UNVERIFIED: haircut=0.6
- modelVersion=3 qualifyingSnapshots=0 span=0.0h (total snapshots=14)
- FAIL: need >= 3 qualifying snapshots (same modelVersion/configFingerprint/pair/regime, all gates passing)

_Read-only shadow audit; no transaction was signed or broadcast._