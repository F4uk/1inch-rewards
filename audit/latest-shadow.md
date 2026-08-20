# Aqua Reward Farmer - Latest Shadow Audit (model v8)

- validatedCodeSha: ed07cbc2e9466b24d5b65f3ff34048fb49f38f59
- artifactGeneratedAt: 2026-08-20T07:48:50.714Z
- validationOnly: true
- liveCutoffBlock: 25794630
- historicalCutoffBlock: 25794182
- decision: **DO_NOT_TRADE**
- pair: none
- expectedNetUsdPerDay: 0.0000
- stressNetUsdPerDay: 0.0000
- confidence: LOW

## Failed gates
- denominator-pricing-coverage: groupFillCountCoverage=94.46% oneInchAmountCoverage=94.83% min=95% (both required; huge unpriced fills must never be masked)
- current-fair-price-available: freshDepthQualifiedCurrentPrice=false
- confidence: confidence=LOW
- base-net-positive: net=-0.1317 usd/day
- stress-net-nonnegative: stressNet=-4.4123 usd/day
- gas-reserve-known: GAS_RESERVE_UNKNOWN: nav=441.59 relevant=441.59 nativeGasReserve=0.00 GAS_RESERVE_INSUFFICIENT_NATIVE_ETH emergency=0.00 excluded=0.00 unpriced=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee:ETH deployable=441.59
- wallet-assets-priced: WALLET_ASSET_PRICE_UNKNOWN: ETH

## Reasons
- wallet=0x9adf16a1a098c0832671fd93cd6ef668ad6654b1 nav=441.59 deployable=441.59 (nativeGasReserve=0.00 emergency=0.00)
- eligibleActualCandidates=0
- CAPITAL_SELECTION: no eligible ACTUAL_WALLET regime (fail closed)
- VALIDATION_ONLY: no persistence-qualifying snapshot written (external ACCEPT pending)
- no eligible ACTUAL_WALLET candidate; best rejected: pair=0x111111111117dC0aa78b770fA6A738034120C302/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 requested=44.16 (ACTUAL_WALLET) net=-0.1317 stress=-4.4123 qualified=false
- GATE_FAIL: denominator-pricing-coverage - groupFillCountCoverage=94.46% oneInchAmountCoverage=94.83% min=95% (both required; huge unpriced fills must never be masked)
- GATE_FAIL: current-fair-price-available - freshDepthQualifiedCurrentPrice=false
- GATE_FAIL: confidence - confidence=LOW
- GATE_FAIL: base-net-positive - net=-0.1317 usd/day
- GATE_FAIL: stress-net-nonnegative - stressNet=-4.4123 usd/day
- GATE_FAIL: gas-reserve-known - GAS_RESERVE_UNKNOWN: nav=441.59 relevant=441.59 nativeGasReserve=0.00 GAS_RESERVE_INSUFFICIENT_NATIVE_ETH emergency=0.00 excluded=0.00 unpriced=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee:ETH deployable=441.59
- GATE_FAIL: wallet-assets-priced - WALLET_ASSET_PRICE_UNKNOWN: ETH
- QUALIFICATION_UNVERIFIED: haircut=0.6
- modelVersion=8 capital=0 (none) qualifyingSnapshots=0 span=0.0h (total snapshots=23, validationOnly excluded, hypothetical never qualifies)
- FAIL: need >= 3 qualifying snapshots (same modelVersion/configFingerprint/pair/fee/range/capitalUsd/capitalSource + wallet regime, all gates passing)

_Read-only shadow audit; no transaction was signed or broadcast. The artifact may be committed in a later audit-only commit; validatedCodeSha identifies the code commit that was validated._
