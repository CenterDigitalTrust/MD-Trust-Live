# Donation receipt roadmap

Donation attestation is a planned integration. The current signed activity journal and FairDrop implementation do not ingest payments or prove that a donation settled.

A future implementation should authenticate provider callbacks, deduplicate the provider's immutable event IDs, represent settlement and reversal states explicitly, and sign one receipt for the relevant business transition. Receipt hashes can then enter the existing proof pipeline. Private payment details should remain outside public proofs.

Acceptance requires provider sandbox and production verification, retry/replay handling, refund and chargeback behavior, access controls and evidence-export checks. A payment UI or a chat message alone is insufficient evidence of settlement.
