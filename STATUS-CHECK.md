# WYA App Status Checklist

Last updated: 2026-11-04 (Session 410)

## Quick Status Check (Do These Now)

### 1. Check Email (gotsigns10@gmail.com)
Search for these subjects:
- [ ] "Your build is ready for testing" (TestFlight success)
- [ ] "Build failed" or "Codemagic build" (build failure)
- [ ] "App Store Connect" (any Apple notifications)

### 2. Check TestFlight App (iPhone)
1. Open TestFlight app on your iPhone
2. Look for "WYA - Live Vendor Map"
3. Status:
   - [ ] App appears → Ready to test!
   - [ ] App not there → Build didn't make it

### 3. Check App Store Connect (Web)
1. Go to: https://appstoreconnect.apple.com
2. Sign in: gotsigns10@gmail.com
3. Click "My Apps"
4. Find "WYA - Live Vendor Map"
5. Check:
   - [ ] App exists in list
   - [ ] Click app → TestFlight tab
   - [ ] Any builds listed?

---

## What We Know Is Done ✅

| Item | Status | Details |
|------|--------|---------|
| Apple Developer Program | ✅ | Team ID: 9V74TT48MV |
| App Store Connect API Key | ✅ | Key ID: 6T7FMU83Q3 |
| APNs Push Key | ✅ | Key ID: T9LGDGU82M |
| Bundle ID | ✅ | com.universoul.wya (YA7VH66YXF) |
| App in App Store Connect | ✅ | Created Nov 1 by Sergio |
| Codemagic configured | ✅ | Has API key |
| Build triggered | ⚠️ | Nov 1 - status unknown |

---

## If Build Failed (Common Fixes)

### Check Codemagic Dashboard
1. Go to: https://codemagic.io
2. Sign in with GitHub
3. Find wya-app project
4. Check build history
5. Look for red X (failed) or green check (success)

### Common Failure Reasons
| Error | Fix |
|-------|-----|
| "No signing certificate" | Need to re-generate in Apple Developer Portal |
| "Provisioning profile expired" | Delete old profiles, let Codemagic regenerate |
| "Bundle ID mismatch" | Verify com.universoul.wya in Xcode project |
| "Build timeout" | Increase timeout in codemagic.yaml |

---

## If No Build Exists (Start Fresh)

### Option A: Trigger from Codemagic UI
1. Go to codemagic.io
2. Find wya-app
3. Click "Start new build"
4. Select branch: master
5. Select workflow: ios-release
6. Click "Start"

### Option B: Trigger via Git Push
```bash
cd /root/universoul-ecosystem/wya-app
git commit --allow-empty -m "trigger: TestFlight build"
git push
```

---

## After TestFlight Works

### Test on Real iPhone
- [ ] Install from TestFlight
- [ ] Open app, sign in
- [ ] Toggle "I'm Open" as vendor
- [ ] Check map shows your location
- [ ] Drive around for 10-15 min
- [ ] Verify GPS updates work

### Submit to App Store
1. App Store Connect → Your App → App Store tab
2. Add screenshots (5 required)
3. Fill in description, keywords
4. Click "Submit for Review"
5. Wait 24-48 hours for Apple review

---

## Soul iOS App (Separate)

Soul iOS uses the SAME Apple Developer account but needs:
- [ ] Create app in App Store Connect (different from WYA)
- [ ] Bundle ID: com.universoul.soul
- [ ] Trigger Codemagic build

Soul iOS is independent from WYA - you can have both on TestFlight.

---

## Contacts

| Service | Login |
|---------|-------|
| App Store Connect | gotsigns10@gmail.com |
| Codemagic | GitHub (gotsigns10-cell) |
| Apple Developer | gotsigns10@gmail.com |

---

## Summary

**DO THIS NOW:**
1. Check email for build notifications
2. Open TestFlight on iPhone
3. Check App Store Connect for build status

**THEN TELL ME:**
- Did the WYA build make it to TestFlight?
- Any error messages?

I can help troubleshoot from there.
