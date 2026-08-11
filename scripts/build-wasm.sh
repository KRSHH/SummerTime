#!/usr/bin/env bash
# Builds the SummerTime P2P wasm package (multiplayer/browser-wasm/pkg).
#
# Single source of truth: used by `bun run build:wasm` locally AND by the
# GitHub Actions workflow (.github/workflows/build-wasm.yml). The pkg is a
# committed artifact — CI rebuilds and publishes it whenever the Rust code
# changes, and Vercel consumes it as a plain npm file: dependency.
set -euo pipefail
cd "$(dirname "$0")/.."

# ring compiles C code for wasm32-unknown-unknown and needs clang on PATH.
# Try the common install locations before failing (Windows git-bash, macOS
# Homebrew, Linux distro packaging).
if ! command -v clang >/dev/null 2>&1; then
  for dir in "/c/Program Files/LLVM/bin" "/usr/local/opt/llvm/bin" "/opt/homebrew/opt/llvm/bin" "/usr/lib/llvm/bin"; do
    if [ -x "$dir/clang" ]; then
      export PATH="$dir:$PATH"
      break
    fi
  done
fi
if ! command -v clang >/dev/null 2>&1; then
  echo "clang not found — install LLVM (needed to build ring for wasm32)" >&2
  exit 1
fi

wasm-pack build multiplayer/browser-wasm --release -t bundler -d pkg --weak-refs --reference-types

# wasm-pack writes pkg/.gitignore that would exclude the .wasm binary from
# git; the pkg is a committed artifact, so remove it.
rm -f multiplayer/browser-wasm/pkg/.gitignore

ls -lh multiplayer/browser-wasm/pkg/summer_browser_bg.wasm
