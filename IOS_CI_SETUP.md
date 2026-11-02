# WYA iOS CI/CD Setup

## Required GitHub Secrets

The following secrets must be added to GitHub repo settings:

### Already Configured
- `APP_STORE_CONNECT_KEY` - API key content (.p8 file)
- `APP_STORE_CONNECT_KEY_ID` - Key ID
- `APP_STORE_CONNECT_ISSUER_ID` - Issuer ID

### Need to Add (from Mac with Xcode)

#### 1. Distribution Certificate
1. Open Keychain Access on Mac
2. Find "Apple Distribution: [Your Name/Company]" certificate
3. Right-click → Export → Save as .p12 with password
4. Convert to base64: `base64 -i certificate.p12 | pbcopy`
5. Add as `DISTRIBUTION_CERTIFICATE_BASE64` secret
6. Add password as `DISTRIBUTION_CERTIFICATE_PASSWORD` secret

#### 2. Provisioning Profile
1. Go to https://developer.apple.com/account/resources/profiles/list
2. Create new profile → App Store → Select "WYA" app
3. Download the .mobileprovision file
4. Convert to base64: `base64 -i profile.mobileprovision | pbcopy`
5. Add as `PROVISIONING_PROFILE_BASE64` secret

## Alternative: Use Xcode Cloud

If you prefer Apple's native CI:
1. Go to App Store Connect → Xcode Cloud
2. Connect your GitHub repo
3. Apple handles all signing automatically

## Workflow Triggers

- **Automatic**: Every push to `master` or `main`
- **Manual**: Go to Actions tab → iOS TestFlight Deploy → Run workflow
