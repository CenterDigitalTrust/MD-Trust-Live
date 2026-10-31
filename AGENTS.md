# MD Trust Live

Work in small reviewable stages; test and commit each stage.
Write tests before cryptographic implementations. Never weaken failing crypto tests.
Never commit credentials or device private keys. Provide .env.example.
Verify Twitch APIs against official documentation. Bundle panel dependencies; only Twitch helper may load remotely.
Shared Dart/TypeScript vectors live in docs/test-vectors.json.
Prove signed app activity and integrity, not video truth or video-to-device binding.
Keep MD Vault integration optional. Do not invent its contract.
Keep existing MDFP services separate from this project's deployment.
Use typed code, explanatory function comments, and meaningful error handling.
