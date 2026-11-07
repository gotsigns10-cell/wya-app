# WYA Android Setup Guide
## Session 402 | 2026-11-02

---

## Current State

- iOS app exists with Capacitor (`ios/` directory)
- No Android directory yet
- Capacitor config already supports both platforms
- Web app at wya.digisigns.link

---

## Step 1: Add Android Platform

```bash
cd /root/universoul-ecosystem/wya-app
npx cap add android
npx cap sync android
```

This creates the `android/` directory with:
- `app/` - Main Android app module
- `build.gradle` - Project build config
- `gradle/` - Gradle wrapper
- `settings.gradle` - Module settings

---

## Step 2: Configure Android App

### Update `android/app/build.gradle`

```gradle
android {
    namespace 'com.universoul.wya'
    compileSdk 34

    defaultConfig {
        applicationId "com.universoul.wya"
        minSdk 24
        targetSdk 34
        versionCode 1
        versionName "1.0.0"
    }
}
```

### Add Android-specific config to `capacitor.config.json`

```json
{
  "android": {
    "backgroundColor": "#0a0a0a",
    "allowMixedContent": false,
    "captureInput": true,
    "webContentsDebuggingEnabled": false
  }
}
```

---

## Step 3: Play Store Setup

### Prerequisites
1. Google Play Developer account ($25 one-time)
2. App listing created in Play Console
3. Service account with Play Console API access

### Create Service Account
1. Go to Google Cloud Console → IAM
2. Create service account: `wya-android-ci`
3. Download JSON key file
4. Grant "Service Account User" role in Play Console

### Secrets Required (GitHub)
```
ANDROID_KEYSTORE_BASE64     # Base64-encoded .jks keystore
ANDROID_KEYSTORE_PASSWORD   # Keystore password
ANDROID_KEY_ALIAS           # Key alias (usually "upload")
ANDROID_KEY_PASSWORD        # Key password
PLAY_SERVICE_ACCOUNT_JSON   # Service account JSON for Play Console
```

---

## Step 4: GitHub Actions Workflow

Create `.github/workflows/android-playstore.yml`:

```yaml
name: Android Play Store

on:
  push:
    branches: [master]
    paths:
      - 'src/**'
      - 'public/**'
      - 'android/**'
      - 'capacitor.config.json'
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Setup Java
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'

      - name: Install dependencies
        run: npm ci

      - name: Sync Capacitor
        run: npx cap sync android

      - name: Decode keystore
        run: |
          echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 -d > android/app/upload-keystore.jks

      - name: Build release AAB
        working-directory: android
        run: |
          ./gradlew bundleRelease \
            -Pandroid.injected.signing.store.file=$PWD/app/upload-keystore.jks \
            -Pandroid.injected.signing.store.password=${{ secrets.ANDROID_KEYSTORE_PASSWORD }} \
            -Pandroid.injected.signing.key.alias=${{ secrets.ANDROID_KEY_ALIAS }} \
            -Pandroid.injected.signing.key.password=${{ secrets.ANDROID_KEY_PASSWORD }}

      - name: Upload to Play Store (Internal)
        uses: r0adkll/upload-google-play@v1
        with:
          serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
          packageName: com.universoul.wya
          releaseFiles: android/app/build/outputs/bundle/release/app-release.aab
          track: internal
          status: completed
```

---

## Step 5: Create Signing Keystore

```bash
# Generate upload keystore (do this once)
keytool -genkey -v -keystore wya-upload.jks -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass YOUR_PASSWORD -keypass YOUR_PASSWORD \
  -dname "CN=WYA App, OU=Mobile, O=Universoul LLC, L=Santa Barbara, ST=CA, C=US"

# Encode for GitHub secret
base64 -i wya-upload.jks > wya-upload.jks.b64
```

---

## Step 6: Play Store Listing

Required assets:
- **App icon**: 512x512 PNG
- **Feature graphic**: 1024x500 PNG
- **Screenshots**: 2-8 per device type
  - Phone: 1080x1920 or 1440x2560
  - Tablet (optional): 1200x1920
- **Short description**: 80 chars max
- **Full description**: 4000 chars max

### Privacy Policy
Host at: `wya.digisigns.link/privacy`

### Content Rating
Complete IARC questionnaire in Play Console

---

## Rollout Plan

1. **Internal Testing** - Upload first AAB, test on team devices
2. **Closed Testing** - Invite beta testers (100-500)
3. **Open Testing** - Public beta (optional)
4. **Production** - Full release

---

## Quick Commands

```bash
# Add Android platform
cd /root/universoul-ecosystem/wya-app
npx cap add android

# Sync changes
npx cap sync android

# Open in Android Studio
npx cap open android

# Build debug APK
cd android && ./gradlew assembleDebug

# Build release AAB
cd android && ./gradlew bundleRelease
```

---

## Notes

- Android uses AAB (Android App Bundle) for Play Store
- APK still supported for internal distribution
- Google Play App Signing handles final signing
- Internal track = immediate distribution (no review)
- Production track = 1-3 day review
