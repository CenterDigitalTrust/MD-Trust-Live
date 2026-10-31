# MDTL1 implementation decisions

Protocol decisions for the current MDTL1 implementation. See ARCHITECTURE.md for the data flow.

1. Canonical JSON recursively sorts keys by UTF-16 code units, emits valid JSON escapes, accepts null/bool/string/arrays/objects and safe integers only (absolute value <= 2^53-1). Reject unsupported values, unpaired surrogates and negative zero. No floating point values.
2. P-256 keys are SPKI DER/base64. Sign SHA256withECDSA over MDTL1 newline plus canonical header. Signature is DER/base64. The signature text is part of event hash; an already acknowledged event must be retried byte-for-byte, not re-signed.
3. Every accepted SESSION_START/PULSE consumes one nonce bound to session/channel/device and returns a fresh nonce. TTL 45 seconds. Exact duplicate seq/hash is idempotent and returns current session state. Another event at that seq is a conflict. Nonce and event updates are atomic.
4. Retained challenge evidence is checked against historical received_at, not current wall clock. Expired unsent pulses are discarded; the app fetches a fresh challenge and signs a fresh event at the still-uncommitted seq. The server never changes seq for a rejected event.
5. Signed request body hashes use canonical JSON, with empty string for an absent body. Request paths include the exact query string. Mutating operations need idempotency or replay protection as appropriate.
6. Green means verified app activity plus a fresh positive Twitch live check. Helix failures produce WAITING, never green. Missing pulse 15–90 seconds is WAITING; beyond 90 seconds OFFLINE with reason signal_timeout. Test mode is clearly labeled SIMULATED and never presented as a live Twitch proof.
7. Store session public key snapshot, expected head and count. Verify all persisted events against the stored head. A database administrator can rewrite both unanchored history and metadata; only independent anchored commitments constrain this. An export without an independently checked anchor establishes internal consistency only.
8. Reject unauthorized invalid submissions without allowing anonymous attackers to turn the shield red. Persisted chain corruption does produce DATA_MISMATCH.
9. Giveaway commit-reveal proves consistency with the frozen list, not unbiased randomness against a malicious operator/streamer. Selective abort and collusion remain possible without an external randomness beacon. State these limits in UI/docs.
10. No wallet keys are borrowed from MDFP. Use separate credentials and explicit cluster configuration. Default development network is devnet.
11. Foreground work is user-started, visible, stoppable; Android service declarations must match its actual use. Physical-device validation remains a release gate.
