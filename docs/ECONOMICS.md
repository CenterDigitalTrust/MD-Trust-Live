# Economic scenarios

This is an illustrative model, not measured Twitch revenue or a forecast. It adapts the supplied project economics note and distinguishes the implemented per-session batching from a proposed platform-wide tree. USD/SOL values below are assumptions, not a current market quotation.

## Cost units

Device signatures and Merkle hashing do not incur a blockchain fee. They still consume device/server compute, storage and network resources. Solana anchoring incurs transaction fees. The documented base fee is 5,000 lamports per transaction signature; a one-signature transaction with no priority fee therefore uses 0.000005 SOL. Priority fees and additional transaction signatures change that cost. [Solana fee documentation](https://solana.com/docs/core/fees) (checked 2026-10-31).

| Assumed SOL price | Base-only cost per one-signature anchor |
| --- | --- |
| $70 | $0.00035 |
| $100 | $0.00050 |
| $200 | $0.00100 |

The Android ECDSA signature is not a separate Solana transaction signature. An anchor batches many already signed events into one root.

## Thirty-day scenarios

| Scenario | Anchors | $70/SOL | $100/SOL | $200/SOL |
| --- | ---: | ---: | ---: | ---: |
| One creator, four hours/day, one anchor/five minutes | 1,440 | $0.504 | $0.720 | $1.440 |
| Proposed shared platform root, one/five minutes, 24/7 | 8,640 | $3.024 | $4.320 | $8.640 |
| Proposed shared platform root, one/fifteen minutes, 24/7 | 2,880 | $1.008 | $1.440 | $2.880 |

These figures cover base network fees only. In the current implementation, independent sessions incur independent anchors. The shared-root scenarios require additional implementation and cannot be presented as today's total platform operating cost.

At an ideal five-second interval, one hour contains 720 pulses. Actual fixed-delay scheduling adds operation time, so observed counts vary. A million-leaf Merkle tree requires about twenty sibling hashes for a typical proof: roughly 640 bytes of hash material, excluding indices, serialization, signatures and other metadata.

## Service-price scenario requested by the project owner

Eligible events are unique, successfully attested business events such as completed giveaways or future verified donation receipts. Chat messages and recurring device pulses are excluded from this billing scenario. Deduplicate provider event IDs and payment lifecycle updates before counting any future donation event.

Let:

- `N` = annual eligible platform events (not established by the supplied documents).
- `a` = adoption/coverage fraction, assumed 0.10.
- `p` = revenue per attested event, assumed $0.003.
- `T` = annual anchor transactions under the actual batching policy.
- `f` = average total fee per anchor in SOL.
- `s` = assumed USD/SOL conversion.
- `H` = annual hosting, database, RPC, storage and bandwidth costs.
- `O` = other operating costs, including support, security, payment processing and staffing.

```text
attested_events = N * a
revenue = N * a * p
chain_cost = T * f * s
contribution_after_infrastructure = revenue - chain_cost - H
operating_result = revenue - chain_cost - H - O
operating_margin = operating_result / revenue  (when revenue > 0)
```

| Hypothetical annual eligible events N | 10% attested | Revenue at $0.003 |
| --- | ---: | ---: |
| 100,000,000 | 10,000,000 | $30,000 |
| 1,000,000,000 | 100,000,000 | $300,000 |
| 10,000,000,000 | 1,000,000,000 | $3,000,000 |

These volumes are sensitivity inputs, **not Twitch's 2025 event totals**. No substantiated 2025 count of the eligible event categories has been established here, so an actual annual Twitch profit or margin cannot be derived from them. Ownership of the application also does not itself establish billable demand or realized revenue.

## The supplied PDF model

The overview proposes 457.5 million annual eligible events and $0.005 per event. At 1%, 10% and 30% coverage, revenue is respectively $22,875, $228,750 and $686,250. Its supplied annual chain/rent budgets are $399, $2,349 and $7,047, and infrastructure budgets are $2,400, $14,400 and $36,000. Subtracting those assumed costs yields $20,076 (87.76%), $212,001 (92.68%) and $643,203 (93.72%) before other operating costs and taxes. These are scenario contributions, not proven company net profit.

At the owner's alternative $0.003 price and the same hypothetical 10% coverage, revenue is $137,250. Reusing the PDF's assumed $16,749 combined chain/infrastructure budget gives $120,501, or 87.80%, before other operating costs. Reusing that budget is a sensitivity exercise, not validation of its sizing.

The PDF separately quotes $0.000036 on-chain cost per event. That number does not reconcile with its annual chain/rent row: 45.75 million events times $0.000036 is $1,647, rather than $2,349. Extra rent or other costs would need an explicit breakdown. Its 99.28% figure follows only from `(0.005 - 0.000036) / 0.005`; it excludes infrastructure and operating costs and is not an overall company margin. The current implementation uses Memo anchors, so cost should be recomputed from actual session batches rather than an assumed compressed-tree tariff.

## Capacity assumptions that must be measured

One thousand simultaneously viewing panels at a three-second poll interval imply approximately 333 requests/second before caching and backoff. Measure request CPU, database writes, storage per event, egress, RPC quotas and peak concurrency using the deployed service. Provider prices and resource sizing must be attached to those measurements before assigning H.

Wallet reserve is working capital, not automatically a consumed fee; determine required balances from the configured network and account type. Automatic anchoring is disabled by default in the supplied configuration, so this document must not be used as a record of actual spending.
