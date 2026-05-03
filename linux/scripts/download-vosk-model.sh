#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

model_name="${1:-vosk-model-small-en-us-0.15}"
model_url="${CLICKY_VOSK_MODEL_URL:-https://alphacephei.com/vosk/models/${model_name}.zip}"
target_dir="models/vosk-model-small-en-us"
tmp_dir="$(mktemp -d)"
archive_path="$tmp_dir/model.zip"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

mkdir -p models

echo "Downloading ${model_name} from ${model_url}"
curl -fL "$model_url" -o "$archive_path"

rm -rf "$target_dir"
unzip -q "$archive_path" -d "$tmp_dir"

extracted_dir="$(find "$tmp_dir" -maxdepth 1 -mindepth 1 -type d -name 'vosk-model-*' | head -n 1)"
if [[ -z "${extracted_dir}" ]]; then
  echo "Unable to find extracted Vosk model directory" >&2
  exit 1
fi

mv "$extracted_dir" "$target_dir"

echo "Vosk model installed at $target_dir"
