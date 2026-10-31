# Product vision and presentation notes

The owner supplied two English presentation PDFs: **Digital_Trust_Live_Hackathon.pdf** (8 pages) and **Digital_Trust_Live_Overview_EN.pdf** (12 pages). This document captures their purpose while distinguishing the published implementation from proposed capabilities. The README and protocol specification describe the implemented behavior.

## Purpose

The decks present a verifiable activity layer for creators, viewers, giveaway participants, sponsors and future fundraising workflows. The intended experience is a Twitch-native panel where viewers can inspect evidence without managing a crypto wallet. Creators pair an Android signer; the backend verifies its journal and can anchor batches on Solana.

The central journey is **sign -> batch -> anchor -> verify**. The project was developed with OpenAI Codex and demonstrated on the owner's Twitch channel in Hosted Test. Seven-language support lowers the interface barrier for international communities.

## Presentation claims mapped to this repository

| Topic in the PDFs | Published implementation / interpretation |
| --- | --- |
| Android mobile signer | Implemented with Android Keystore P-256 signing; the repository does not establish hardware-backed security on every device |
| Twitch viewer and configuration UI | Implemented panel, configuration and mobile entry points |
| Live activity badge | Checks device journal and Twitch live state; does not authenticate video content or identify bots |
| Verifiable giveaway | Implemented FairDrop commitments, frozen entries, deterministic result and proof data |
| Merkle roots on Solana | Implemented per-session ranges using Memo transactions; automatic scheduling disabled by default |
| Compressed on-chain tree / 16.7-million capacity | Presentation architecture proposal; not the implemented Memo anchoring mechanism |
| EventSub and automatic provider-event collection | Future integration; current activity originates from the signed companion workflow |
| iOS, Secure Enclave and App Attest | Roadmap, not shipped in this Android repository |
| Periodic Play Integrity / guaranteed emulator exclusion | Not established by this implementation |
| Fundraising goals, donation receipts, polls and rewards | Proposed integrations; not active receipt ingestion |
| PubSub distribution and edge-cache savings | Scale proposals; current viewer status uses polling |
| VOD archive and formal audit reports | Product proposals; not available functionality |
| 15 ms proof checks / 99.7% fewer RPC calls | Presentation estimates without a reproducible benchmark supplied here |

A device signature records the activity of the signing application. It does not prove human presence, original video, absence of viewbots or the validity of a payment. FairDrop makes the documented committed draw reproducible; claims about broader fraud reduction require measured pilots.

## Proposed commercial packages

The presentations explore a free allowance of 1,000 events/month, Streamer Pro at $19/month (a $49 tier in the overview), charity support at $0.0025/event, and Brand Shield campaigns at $499-$2,500. These are planning proposals, not live products, implemented quotas or checkout options. The proposed VOD, branding, payment and reporting features need implementation before those packages can be offered.

The decks also explore external billing and Twitch Bits. Any such implementation needs a current platform-policy review; this repository does not claim approval of a particular monetization route. The noncommercial repository license does not grant downstream commercial operating rights.

## Economic evidence

The overview's 457.5-million annual useful-event volume is a model input, not an established Twitch statistic. Its fraud-loss and value-saved appendix explicitly describes unaudited hypotheses. We preserve that meaning without presenting the proposed loss figures as measured outcomes or claiming that signed device activity eliminates bot fraud.

See [ECONOMICS.md](ECONOMICS.md) for arithmetic, sensitivity scenarios, implementation-specific costs and the distinction between infrastructure contribution and company profit.
