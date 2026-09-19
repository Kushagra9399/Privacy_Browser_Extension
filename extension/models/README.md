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

The ONNX model is intentionally not fetched at runtime from a third-party URL.
It must be packaged with the extension before loading the extension.

Source:
https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
