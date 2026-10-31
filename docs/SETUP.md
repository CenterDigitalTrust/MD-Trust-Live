# Development and deployment

Use Node.js 24 or later, npm, PostgreSQL 16, Flutter/Dart compatible with `app/pubspec.yaml`, JDK 17 and Android SDK 35. On Windows, an ASCII-only build path avoids toolchain path issues.

## Backend and extension

```bash
set -euo pipefail
npm ci
cp .env.example .env
# Configure the database and Twitch application/extension credentials in .env.
npm test
npm run check
npx vite build --config panel/vite.config.js
node --env-file=.env --experimental-strip-types tools/migrate.ts
npm start
```

Use the exact script names in `package.json` if adapting this sequence. The server must have its database configured before migration. Keep `.env` local and provide production secrets through the deployment secret mechanism.

The extension's `config.html`, `panel.html` and `mobile.html` are separate entry points. Build with the deployment's `VITE_EBS_URL`, upload the contents of `panel/dist` to the Twitch Extension version, and configure Twitch's allowed backend domains. Use the extension client ID and extension shared secret for extension authentication; an OAuth client secret serves a different purpose.

For Hosted Test, configure the extension's version metadata, privacy policy and allowed testers in Twitch Developer Console, then install and activate the panel on the test channel. Production distribution requires Twitch review/release.

## Android

```bash
set -euo pipefail
cd app
flutter pub get
flutter analyze
flutter test
flutter build apk --release --dart-define=EBS_URL=https://api.digitaltrust.living/twitch
```

Review Android signing configuration before distribution: a successful release build does not establish a production signing identity. Provision the operator's release keystore outside source control. The companion is paired through the extension configuration page; viewers do not configure developer credentials.

## Solana

Configure the RPC network and backend signing wallet privately. Leave `ANCHOR_ENABLED=false` until the operator has verified the intended network, funding, fee limits and recovery process. A configured wallet does not by itself enable automatic anchoring. Inspect the anchoring and export tools before invoking operational actions.
