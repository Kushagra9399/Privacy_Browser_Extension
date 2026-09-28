#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
MODEL_DIR="$ROOT_DIR/models/pii-master-ner-m"

MODEL_FILE="$MODEL_DIR/model.onnx"
EXTERNAL_DATA_FILE="$MODEL_DIR/model.onnx.data"
TOKENIZER_FILE="$MODEL_DIR/tokenizer.json"
CONFIG_FILE="$MODEL_DIR/config.json"

for file in "$MODEL_FILE" "$EXTERNAL_DATA_FILE" "$TOKENIZER_FILE" "$CONFIG_FILE"; do
    if [[ ! -s "$file" ]]; then
        echo "Missing required PII model asset: $file" >&2
        exit 1
    fi
done

echo "pii-master-ner-m assets are present."
echo "Model: $MODEL_FILE"
echo "External weights: $EXTERNAL_DATA_FILE"
echo "Tokenizer: $TOKENIZER_FILE"
echo "Config: $CONFIG_FILE"
