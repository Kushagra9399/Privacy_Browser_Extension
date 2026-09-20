# Local privacy vision models

The extension keeps raw pixels local. The privacy vision layer is intentionally
separate from the GUI detector.

## Required model

Place the OpenCV Zoo YuNet ONNX face detector at:

models/face-detector/face_detection_yunet_2023mar.onnx

Expected model:
OpenCV Zoo YuNet face detector, 2023-03 release.

The detector returns face boxes only. It does not perform face recognition or
identity matching.

## Runtime

The extension runs ONNX Runtime Web in the offscreen document using WASM first.
This avoids making WebGPU a privacy-path dependency.

## PII strategy

PII is not inferred from the screenshot by a single large model.

The local privacy boundary combines:
- DOM input semantics for passwords and sensitive forms
- local regex/Luhn detection for emails, phones, SSNs and credit cards
- local vision for faces
- future local NER/object detectors for contextual text PII and document objects

Unknown vision classes are ignored and can never become redactions automatically.

## Adding the model

From the repository root:

```bash
cd extension
bash download-privacy-models.sh
```

This downloads:

```text
extension/models/face-detector/face_detection_yunet_2023mar.onnx
```

Verify the SHA256 without any Python dependency:

```bash
sha256sum models/face-detector/face_detection_yunet_2023mar.onnx
```

Expected SHA256:

```text
8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4
```

Optional ONNX graph verification:

```bash
python3 -m pip install onnx
python3 verify-yunet.py
```

The ONNX model is intentionally not fetched at runtime from a third-party URL.
It must be packaged with the extension before loading the extension.

Source:
https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet


## Optional local PII NER model

The contextual text detector is optional and runs entirely in the extension
offscreen document.

From the extension directory:

```bash
bash download-pii-model.sh
```

It creates:

```text
models/pii-ner/model_int8.onnx
models/pii-ner/vocab.txt
```

The NER layer complements, rather than replaces, deterministic detection.
Passwords, emails, phone numbers, credit cards and SSNs continue to use DOM
semantics and regex/Luhn checks.

For NER entities, the content script creates a DOM Range over the detected
local text span and converts that Range to screen coordinates before the
screenshot is serialized. The detected text itself is never sent to the
server.
