#!/bin/bash
# Build cursor-sidecar with the system Swift compiler. No SPM, no Xcode
# project — one file, one binary.
set -euo pipefail
cd "$(dirname "$0")"
swiftc -O main.swift -o cursor-sidecar
echo "built ./cursor-sidecar"
