#!/bin/bash

# 🔍 Version Consistency Audit Script
# Run this before any release to ensure all version references match

echo "🔍 Version Consistency Audit"
echo "=========================="

# Extract versions from every file the bump script writes, plus the
# hand-maintained plugin pins that must move at publish time.
PKG_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
SRC_VERSION=$(grep 'version:' src/index.ts | sed "s/.*version: *['\"]\\([^'\"]*\\)['\"].*/\\1/")
DOCKER_VERSION=$(grep 'version=' Dockerfile | sed 's/.*version="\([^"]*\)".*/\1/')
TEST_VERSION=$(grep 'version:' src/__tests__/index.test.ts | sed "s/.*version: *['\"]\\([^'\"]*\\)['\"].*/\\1/")
MCP_VERSION=$(grep '"version"' mcp.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
SERVER_VERSION=$(grep '"version"' server.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
MANIFEST_VERSION=$(grep '"version"' helpscout-mcp-extension/manifest.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
PLUGIN_PIN=$(grep -o 'help-scout-mcp-server@[0-9.]*' plugins/helpscout-navigator/.mcp.json | head -1 | cut -d@ -f2)

require_version() {
  local source="$1"
  local version="$2"

  if [ -z "$version" ]; then
    echo "❌ Could not parse version from $source"
    return 1
  fi
}

echo "📦 package.json:     $PKG_VERSION"
echo "🔧 src/index.ts:     $SRC_VERSION"
echo "🐳 Dockerfile:       $DOCKER_VERSION"
echo "🧪 Test file:        $TEST_VERSION"
echo "🔌 mcp.json:         $MCP_VERSION"
echo "🗂  server.json:      $SERVER_VERSION"
echo "📦 MCPB manifest:    $MANIFEST_VERSION"
echo "🧩 Plugin npx pin:   $PLUGIN_PIN"

PARSE_OK=true
require_version "package.json" "$PKG_VERSION" || PARSE_OK=false
require_version "src/index.ts" "$SRC_VERSION" || PARSE_OK=false
require_version "Dockerfile" "$DOCKER_VERSION" || PARSE_OK=false
require_version "src/__tests__/index.test.ts" "$TEST_VERSION" || PARSE_OK=false
require_version "mcp.json" "$MCP_VERSION" || PARSE_OK=false
require_version "server.json" "$SERVER_VERSION" || PARSE_OK=false
require_version "helpscout-mcp-extension/manifest.json" "$MANIFEST_VERSION" || PARSE_OK=false
require_version "plugins/helpscout-navigator/.mcp.json pin" "$PLUGIN_PIN" || PARSE_OK=false

if [ "$PARSE_OK" = false ]; then
  echo ""
  echo "📋 Fix version extraction before comparing versions."
  exit 1
fi

# Check for consistency
ALL_VERSIONS=("$PKG_VERSION" "$SRC_VERSION" "$DOCKER_VERSION" "$TEST_VERSION" "$MCP_VERSION" "$SERVER_VERSION" "$MANIFEST_VERSION" "$PLUGIN_PIN")
FIRST_VERSION=${ALL_VERSIONS[0]}
CONSISTENT=true

for version in "${ALL_VERSIONS[@]}"; do
  if [ "$version" != "$FIRST_VERSION" ]; then
    CONSISTENT=false
    break
  fi
done

echo ""
if [ "$CONSISTENT" = true ]; then
  echo "✅ All versions are consistent: $FIRST_VERSION"
  echo ""
  echo "🚀 Ready for release!"
  exit 0
else
  echo "❌ Version mismatch detected!"
  echo ""
  echo "🔧 Files that need updating:"
  
  if [ "$SRC_VERSION" != "$PKG_VERSION" ]; then
    echo "  - src/index.ts (currently: $SRC_VERSION, should be: $PKG_VERSION)"
  fi
  
  if [ "$DOCKER_VERSION" != "$PKG_VERSION" ]; then
    echo "  - Dockerfile (currently: $DOCKER_VERSION, should be: $PKG_VERSION)"
  fi
  
  if [ "$TEST_VERSION" != "$PKG_VERSION" ]; then
    echo "  - src/__tests__/index.test.ts (currently: $TEST_VERSION, should be: $PKG_VERSION)"
  fi
  
  echo ""
  echo "📋 Update these files manually, then run this script again."
  exit 1
fi
