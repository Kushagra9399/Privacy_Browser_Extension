#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_DIR="$ROOT_DIR/models/pii-ner"
MODEL_URL="https://huggingface.co/onnx-community/TinyBERT-finetuned-NER-ONNX/resolve/main/onnx/model_int8.onnx"
VOCAB_URL="https://huggingface.co/onnx-community/TinyBERT-finetuned-NER-ONNX/resolve/main/vocab.txt"

mkdir -p "$MODEL_DIR"

echo "Downloading TinyBERT INT8 NER model..."
curl -L --fail --retry 3 --output "$MODEL_DIR/model_int8.onnx" "$MODEL_URL"
echo "Downloading tokenizer vocabulary..."
curl -L --fail --retry 3 --output "$MODEL_DIR/vocab.txt" "$VOCAB_URL"

test -s "$MODEL_DIR/model_int8.onnx"
test -s "$MODEL_DIR/vocab.txt"
echo "PII NER model: $MODEL_DIR/model_int8.onnx"
echo "Tokenizer vocabulary: $MODEL_DIR/vocab.txt"
echo "The INT8 ONNX model is approximately 14.5 MB."