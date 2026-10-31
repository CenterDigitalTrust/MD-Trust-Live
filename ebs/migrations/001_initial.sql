BEGIN;
CREATE TABLE IF NOT EXISTS channels (
 channel_id text PRIMARY KEY CHECK (channel_id ~ '^[0-9]+$'),
 device_id text UNIQUE,
 device_pubkey_spki text,
 paired_at bigint
);
CREATE TABLE IF NOT EXISTS pair_codes (
 code_hash text PRIMARY KEY,
 channel_id text NOT NULL REFERENCES channels(channel_id),
 expires_at bigint NOT NULL,
 UNIQUE(channel_id)
);
CREATE TABLE IF NOT EXISTS sessions (
 session_id uuid PRIMARY KEY,
 channel_id text NOT NULL REFERENCES channels(channel_id),
 device_id text NOT NULL,
 device_pubkey_spki text NOT NULL,
 started_at bigint NOT NULL,
 ended_at bigint,
 head_hash text NOT NULL DEFAULT repeat('0',64),
 event_count integer NOT NULL DEFAULT 0 CHECK(event_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session ON sessions(channel_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS challenges (
 nonce text PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES sessions(session_id),
 issued_at bigint NOT NULL,
 consumed_seq integer
);
CREATE TABLE IF NOT EXISTS events (
 session_id uuid NOT NULL REFERENCES sessions(session_id),
 seq integer NOT NULL CHECK(seq >= 0),
 type text NOT NULL,
 header_json jsonb NOT NULL,
 payload_json jsonb NOT NULL,
 event_hash text NOT NULL,
 signature text NOT NULL,
 received_at bigint NOT NULL,
 challenge_issued_at bigint NOT NULL,
 PRIMARY KEY(session_id,seq)
);
CREATE TABLE IF NOT EXISTS giveaways (
 giveaway_id uuid PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES sessions(session_id),
 prize text NOT NULL,
 seed_commit text NOT NULL,
 state text NOT NULL CHECK(state IN ('OPEN','FROZEN','LOCKED','REVEALED','COMPLETE','CANCELLED')),
 entries_hash text,
 entries_count integer,
 seed text,
 winner_index integer,
 winner_user_key text
);
CREATE TABLE IF NOT EXISTS entries (
 giveaway_id uuid NOT NULL REFERENCES giveaways(giveaway_id),
 user_key text NOT NULL CHECK(user_key ~ '^[0-9]+$'),
 display_name text,
 entered_at bigint NOT NULL,
 PRIMARY KEY(giveaway_id,user_key)
);
CREATE TABLE IF NOT EXISTS anchors (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES sessions(session_id),
 from_seq integer NOT NULL,
 to_seq integer NOT NULL,
 merkle_root text NOT NULL,
 tx_signature text UNIQUE,
 cluster text NOT NULL,
 created_at bigint NOT NULL,
 UNIQUE(session_id,from_seq,to_seq)
);
CREATE TABLE IF NOT EXISTS request_receipts (
 request_hash text PRIMARY KEY,
 expires_at bigint NOT NULL,
 response_json jsonb NOT NULL
);
COMMIT;
