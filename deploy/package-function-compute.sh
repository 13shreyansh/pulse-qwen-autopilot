#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
archive_path="$repo_root/dist/pulse-qwen-agent-source.zip"

mkdir -p "$repo_root/dist"
rm -f "$archive_path"
cd "$repo_root"
zip -qr "$archive_path" backend \
  -x 'backend/tests/*' 'backend/__pycache__*' 'backend/**/__pycache__*' 'backend/**/*.pyc'

echo "$archive_path"
