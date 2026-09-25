# Local privacy vision models

The extension keeps raw pixels local. The privacy vision layer is intentionally
separate from the GUI detector.

## Face detector

Place the OpenCV Zoo YuNet face detector at:

\`models/face-detector/face_detection_yunet_2023mar.onnx\`

The detector returns face boxes only. It does not perform face recognition or
identity matching.

## PII NER model

The contextual text detector uses the packaged \`pii-master-ner-m\` model:

\`models/pii-master-ner-m/model.onnx\`
\`models/pii-master-ner-m/model.onnx.data\`
\`models/pii-master-ner-m/tokenizer.json\`
\`models/pii-master-ner-m/config.json\`

The ONNX model uses external weights, so \`model.onnx.data\` must remain beside
\`model.onnx\` and must not be renamed.

The model exposes 111 BIO labels covering contextual PII categories such as
names, addresses, account numbers, API keys, credentials, contact details,
identifiers and financial data. The label list is loaded from \`config.json\`
rather than hard-coded in the runtime.

The tokenizer is loaded from the packaged \`tokenizer.json\`. It is a
ByteLevel BPE tokenizer with NFC normalization and the \`[CLS]\`, \`[SEP]\`
and \`[PAD]\` template defined by the model's tokenizer configuration. This
keeps token IDs aligned with the new ONNX model.

## Runtime

The extension runs ONNX Runtime Web in the offscreen document. The PII model
tries WebGPU first and falls back to WASM when WebGPU initialization fails.

The NER model complements, rather than replaces, deterministic detection.
Passwords, emails, phone numbers, credit cards and SSNs continue to use DOM
semantics and regex/Luhn checks.

For NER entities, the content script creates a DOM Range over the detected
local text span and converts that Range to screen coordinates before the
screenshot is serialized. The detected text itself is never sent to the
server.

## Verify the packaged assets

From the extension directory:

\`bash download-pii-model.sh\`

The script verifies that all four required \`pii-master-ner-m\` assets are
present. It does not download a third-party model at runtime.
