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
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
EOF

echo "📦 Đã đóng gói thành công bundle: $APP_BUNDLE"

APPLICATIONS_DIR="/Applications"
if [ -d "$APPLICATIONS_DIR" ] && [ -w "$APPLICATIONS_DIR" ]; then
  rm -rf "$APPLICATIONS_DIR/WebMCP Vault.app"
  cp -R "$APP_BUNDLE" "$APPLICATIONS_DIR/WebMCP Vault.app"
  echo "🚀 Đã đồng bộ cài đặt vào $APPLICATIONS_DIR/WebMCP Vault.app"
fi
