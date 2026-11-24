#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_BUNDLE="$BUILD_DIR/WebMCP Vault.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

echo "🔨 Đang biên dịch WebMCP Vault native macOS binary..."
clang -O2 \
  -framework Cocoa \
  -framework WebKit \
  -framework Carbon \
  -framework ApplicationServices \
  -fobjc-arc \
  "$SCRIPT_DIR/WebMCPVaultApp.m" \
  -o "$MACOS_DIR/WebMCP Vault"

chmod +x "$MACOS_DIR/WebMCP Vault"

SOURCE_ICON=""
if [ -f "$PKG_DIR/webmcp-vault-extension/store-assets/store-icon-128x128.png" ]; then
  SOURCE_ICON="$PKG_DIR/webmcp-vault-extension/store-assets/store-icon-128x128.png"
elif [ -f "$PKG_DIR/webmcp-vault-extension/dist/icons/icon128.png" ]; then
  SOURCE_ICON="$PKG_DIR/webmcp-vault-extension/dist/icons/icon128.png"
fi

if [ -n "$SOURCE_ICON" ] && command -v sips >/dev/null 2>&1; then
  TMP_WORK="$(mktemp -d "${TMPDIR:-/tmp}/WebMCPVault.XXXXXX")"
  trap 'rm -rf "$TMP_WORK"' EXIT
  ICONSET_DIR="$TMP_WORK/AppIcon.iconset"
  mkdir -p "$ICONSET_DIR"
  for sz in 16 32 128 256 512; do
    sips -z "$sz" "$sz" "$SOURCE_ICON" --out "$ICONSET_DIR/icon_${sz}x${sz}.png" >/dev/null 2>&1 || true
    sips -z $((sz * 2)) $((sz * 2)) "$SOURCE_ICON" --out "$ICONSET_DIR/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || true
  done
  if command -v iconutil >/dev/null 2>&1; then
    iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/AppIcon.icns" 2>/dev/null || true
  fi
fi

cat << 'EOF' > "$CONTENTS/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>WebMCP Vault</string>
    <key>CFBundleIdentifier</key>
    <string>io.webmcp.vault.app</string>
    <key>CFBundleName</key>
    <string>WebMCP Vault</string>
    <key>CFBundleDisplayName</key>
    <string>WebMCP Vault</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSAppleEventsUsageDescription</key>
    <string>WebMCP Vault uses Accessibility to autofill credentials into active apps.</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
EOF

xattr -cr "$APP_BUNDLE" 2>/dev/null || true
SIGN_ID="${CODESIGN_IDENTITY:-}"
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null | awk '/^[[:space:]]*[0-9]+\)/ {print $2; exit}')"
fi
SIGN_ID="${SIGN_ID:--}"
echo "🔏 Signing bundle with identity: $SIGN_ID"
codesign --force --deep --identifier "io.webmcp.vault.app" --sign "$SIGN_ID" "$APP_BUNDLE"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -u "$APP_BUNDLE" >/dev/null 2>&1 || true
fi

echo "📦 Đã đóng gói thành công bundle: $APP_BUNDLE"

APPLICATIONS_DIR="/Applications"
if [ -d "$APPLICATIONS_DIR" ] && [ -w "$APPLICATIONS_DIR" ]; then
  rm -rf "$APPLICATIONS_DIR/WebMCP Vault.app"
  cp -R "$APP_BUNDLE" "$APPLICATIONS_DIR/WebMCP Vault.app"
  if [ -x "$LSREGISTER" ]; then
    "$LSREGISTER" -f "$APPLICATIONS_DIR/WebMCP Vault.app" >/dev/null 2>&1 || true
  fi
  echo "🚀 Đã đồng bộ cài đặt vào $APPLICATIONS_DIR/WebMCP Vault.app"
  if [ "${WEBMCP_VAULT_NO_RELOAD:-0}" != "1" ]; then
    UID_NUM="$(id -u)"
    TRAY_PLIST="$HOME/Library/LaunchAgents/io.webmcp-vault.tray.plist"
    if launchctl print "gui/$UID_NUM/io.webmcp-vault.tray" >/dev/null 2>&1; then
      launchctl kickstart -k "gui/$UID_NUM/io.webmcp-vault.tray"
    elif [ -f "$TRAY_PLIST" ] && launchctl print "gui/$UID_NUM" >/dev/null 2>&1; then
      if pgrep -x "WebMCP Vault" >/dev/null 2>&1; then
        killall "WebMCP Vault"
        sleep 0.3
      fi
      launchctl bootstrap "gui/$UID_NUM" "$TRAY_PLIST"
    elif pgrep -f "WebMCP Vault.app/Contents/MacOS/WebMCP Vault" >/dev/null 2>&1; then
      if [ -z "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ] && [ "$(/bin/launchctl managername)" = "Aqua" ]; then
        killall "WebMCP Vault"
        sleep 0.3
        open -g -a "$APPLICATIONS_DIR/WebMCP Vault.app" --args --tray
      else
        echo "❌ ERR_MACOS_NON_AQUA_KEYCHAIN_BLOCKED: Non-Aqua/SSH session without LaunchAgent: refusing raw 'open -g -a WebMCP Vault.app' in Background." >&2
        exit 1
      fi
    fi
  fi
fi
