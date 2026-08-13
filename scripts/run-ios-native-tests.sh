#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "iOS native tests skipped: macOS is required"
  exit 0
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_file="$repository_root/modules/mobile-data-tunnel/ios/IOSDataStream.swift"
test_file="$repository_root/modules/mobile-data-tunnel/swift-tests/main.swift"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/mhub-ios-native.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

swiftc -swift-version 5 -typecheck "$source_file"
swiftc -swift-version 5 "$source_file" "$test_file" -o "$temporary_directory/ios-native-tests"
"$temporary_directory/ios-native-tests"
