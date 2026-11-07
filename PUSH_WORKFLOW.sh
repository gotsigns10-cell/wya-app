#!/bin/bash
# WYA App - Push Workflow File
# Run this script when you can authorize the GitHub device flow

set -e

echo "=== WYA iOS Workflow Push Helper ==="
echo ""

# Generate device code
echo "Step 1: Generating GitHub device code..."
RESPONSE=$(curl -s -X POST "https://github.com/login/device/code" \
  -H "Accept: application/json" \
  -d "client_id=178c6fc778ccc68e1d6a&scope=repo,workflow,read:org")

USER_CODE=$(echo "$RESPONSE" | jq -r '.user_code')
DEVICE_CODE=$(echo "$RESPONSE" | jq -r '.device_code')

echo ""
echo "============================================"
echo "  ENTER THIS CODE AT github.com/login/device"
echo ""
echo "    CODE: $USER_CODE"
echo ""
echo "============================================"
echo ""

# Open browser
if command -v xdg-open &>/dev/null; then
  xdg-open "https://github.com/login/device" 2>/dev/null &
elif command -v open &>/dev/null; then
  open "https://github.com/login/device" &
fi

# Poll for completion
echo "Waiting for you to enter the code..."
while true; do
  sleep 5
  RESULT=$(curl -s -X POST "https://github.com/login/oauth/access_token" \
    -H "Accept: application/json" \
    -d "client_id=178c6fc778ccc68e1d6a&device_code=${DEVICE_CODE}&grant_type=urn:ietf:params:oauth:grant-type:device_code")

  ERROR=$(echo "$RESULT" | jq -r '.error // empty')
  TOKEN=$(echo "$RESULT" | jq -r '.access_token // empty')

  if [ -n "$TOKEN" ]; then
    echo ""
    echo "SUCCESS! Authorized."

    # Update gh CLI with new token
    echo "$TOKEN" | gh auth login --with-token

    # Push workflow
    cd /root/universoul-ecosystem/wya-app
    git remote set-url origin https://github.com/gotsigns10-cell/wya-app.git
    git push origin master

    echo ""
    echo "=== WORKFLOW PUSHED! ==="
    echo "GitHub Actions will now build the iOS app."
    echo "Check: https://github.com/gotsigns10-cell/wya-app/actions"
    exit 0
  elif [ "$ERROR" = "expired_token" ]; then
    echo "Code expired. Please run this script again."
    exit 1
  elif [ "$ERROR" = "access_denied" ]; then
    echo "Authorization denied. Please try again."
    exit 1
  fi
done
