#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_DIR="$ROOT_DIR/models/face-detector"
MODEL_FILE="$MODEL_DIR/face_detection_yunet_2023mar.onnx"
MODEL_URL="https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"

mkdir -p "$MODEL_DIR"

echo "Downloading YuNet face detector..."
curl -L --fail --retry 3 --output "$MODEL_FILE" "$MODEL_URL"

if [[ ! -s "$MODEL_FILE" ]]; then
    echo "Model download failed or produced an empty file." >&2
    exit 1
fi

MODEL_SIZE="$(stat -c%s "$MODEL_FILE" 2>/dev/null || stat -f%z "$MODEL_FILE")"
echo "Downloaded: $MODEL_FILE"
echo "Size: $MODEL_SIZE bytes"
echo "Expected model size is approximately 233 KB."
echo "Verify the model before committing it to Git."
