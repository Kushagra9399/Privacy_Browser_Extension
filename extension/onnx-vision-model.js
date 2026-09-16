/**
 * Local ONNX Vision Model Integration
 *
 * Bridges the existing VisionProcessor with ONNX Runtime Web
 * without sending page pixels to the backend.
 *
 * Expected model:
 *   models/gui-detector/model.onnx
 *
 * The model accepts RGB image input and produces YOLO-style
 * object-detection output. The current parser handles the
 * model's multiple [x, y, w, h, objectness, classScore]
 * output heads and combines them before NMS.
 */

class LocalOnnxVisionModel {
    constructor() {
        this.session = null;
        this.inputName = null;
        this.inputWidth = 640;
        this.inputHeight = 640;
        this.confidenceThreshold = 0.25;
        this.modelPath = 'models/gui-detector/model.onnx';
        this.initialized = false;
        this.lastPreprocess = null;
    }

    async initialize() {
        if (!window.ort) {
            throw new Error('ONNX Runtime Web is not available');
        }

        const modelUrl = chrome.runtime.getURL(this.modelPath);
        const wasmPath = chrome.runtime.getURL(
            'node_modules/onnxruntime-web/dist/'
        );

        window.ort.env.wasm.wasmPaths = wasmPath;

        this.session = await window.ort.InferenceSession.create(
            modelUrl,
            {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all'
            }
        );

        const input = this.session.getInputs()[0];

        if (!input) {
            throw new Error('ONNX model has no input tensor');
        }

        this.inputName = input.name;

        if (Array.isArray(input.dims) && input.dims.length === 4) {
            const height = Number(input.dims[2]);
            const width = Number(input.dims[3]);

            if (Number.isFinite(width) && width > 0) {
                this.inputWidth = width;
            }

            if (Number.isFinite(height) && height > 0) {
                this.inputHeight = height;
            }
        }

        this.initialized = true;

        Logger.log(
            'VISION',
            `Local ONNX model loaded: ${this.modelPath} (${this.inputWidth}x${this.inputHeight})`
        );

        return true;
    }

    async infer(canvas) {
        if (!this.initialized || !this.session || !this.inputName) {
            return [];
        }

        const preprocessed = this.preprocess(canvas);
        this.lastPreprocess = preprocessed;

        const inputTensor = new window.ort.Tensor(
            'float32',
            preprocessed.tensor,
            [1, 3, this.inputHeight, this.inputWidth]
        );

        const outputs = await this.session.run({
            [this.inputName]: inputTensor
        });

        return this.parseOutputs(
            outputs,
            canvas.width,
            canvas.height,
            preprocessed
        );
    }

    preprocess(canvas) {
        const inputCanvas = document.createElement('canvas');
        inputCanvas.width = this.inputWidth;
        inputCanvas.height = this.inputHeight;

        const ctx = inputCanvas.getContext('2d', {
            willReadFrequently: true
        });

        if (!ctx) {
            throw new Error('Could not create ONNX preprocessing canvas');
        }

        const scale = Math.min(
            this.inputWidth / canvas.width,
            this.inputHeight / canvas.height
        );

        const resizedWidth = Math.max(
            1,
            Math.round(canvas.width * scale)
        );
        const resizedHeight = Math.max(
            1,
            Math.round(canvas.height * scale)
        );

        const offsetX = Math.floor(
            (this.inputWidth - resizedWidth) / 2
        );
        const offsetY = Math.floor(
            (this.inputHeight - resizedHeight) / 2
        );

        ctx.fillStyle = '#114F3A';
        ctx.fillRect(
            0,
            0,
            this.inputWidth,
            this.inputHeight
        );

        ctx.drawImage(
            canvas,
            0,
            0,
            canvas.width,
            canvas.height,
            offsetX,
            offsetY,
            resizedWidth,
            resizedHeight
        );

        const imageData = ctx.getImageData(
            0,
            0,
            this.inputWidth,
            this.inputHeight
        );

        const source = imageData.data;
        const planeSize = this.inputWidth * this.inputHeight;
        const tensor = new Float32Array(planeSize * 3);

        for (let y = 0; y < this.inputHeight; y++) {
            for (let x = 0; x < this.inputWidth; x++) {
                const sourceIndex =
                    (y * this.inputWidth + x) * 4;
                const targetIndex =
                    y * this.inputWidth + x;

                tensor[targetIndex] =
                    source[sourceIndex] / 255;
                tensor[planeSize + targetIndex] =
                    source[sourceIndex + 1] / 255;
                tensor[(planeSize * 2) + targetIndex] =
                    source[sourceIndex + 2] / 255;
            }
        }

        return {
            tensor,
            scale,
            offsetX,
            offsetY,
            resizedWidth,
            resizedHeight
        };
    }

    parseOutputs(
        outputs,
        canvasWidth,
        canvasHeight,
        preprocessInfo
    ) {
        const detections = [];

        for (const output of Object.values(outputs)) {
            if (!output || !output.data || !output.dims) {
                continue;
            }

            const data = output.data;
            const dims = output.dims;
            let rows;
            let columns;

            if (dims.length === 3) {
                rows = dims[1];
                columns = dims[2];
            } else if (dims.length === 2) {
                rows = dims[0];
                columns = dims[1];
            } else {
                Logger.warn(
                    'VISION',
                    `Unsupported ONNX output shape: ${JSON.stringify(dims)}`
                );
                continue;
            }

            if (columns < 6) {
                Logger.warn(
                    'VISION',
                    `Unsupported ONNX detection output columns: ${columns}`
                );
                continue;
            }

            for (let row = 0; row < rows; row++) {
                const offset = row * columns;

                const cx = Number(data[offset]);
                const cy = Number(data[offset + 1]);
                const width = Number(data[offset + 2]);
                const height = Number(data[offset + 3]);

                if (![cx, cy, width, height].every(Number.isFinite)) {
                    continue;
                }

                let confidence;
                let classId = 0;

                if (columns === 6) {
                    const objectness = Number(data[offset + 4]);
                    const classScore = Number(data[offset + 5]);

                    if (!Number.isFinite(objectness) ||
                        !Number.isFinite(classScore)) {
                        continue;
                    }

                    confidence = objectness * classScore;
                } else {
                    const objectness = Number(data[offset + 4]);
                    let bestClassScore = 0;

                    for (let c = 5; c < columns; c++) {
                        const score = Number(data[offset + c]);

                        if (score > bestClassScore) {
                            bestClassScore = score;
                            classId = c - 5;
                        }
                    }

                    confidence = objectness * bestClassScore;
                }

                if (!Number.isFinite(confidence) ||
                    confidence < this.confidenceThreshold) {
                    continue;
                }

                const modelLeft = cx - width / 2;
                const modelTop = cy - height / 2;
                const modelRight = cx + width / 2;
                const modelBottom = cy + height / 2;

                const scale = preprocessInfo?.scale || 1;
                const offsetX = preprocessInfo?.offsetX || 0;
                const offsetY = preprocessInfo?.offsetY || 0;

                const left = Math.max(
                    0,
                    (modelLeft - offsetX) / scale
                );
                const top = Math.max(
                    0,
                    (modelTop - offsetY) / scale
                );
                const right = Math.min(
                    canvasWidth,
                    (modelRight - offsetX) / scale
                );
                const bottom = Math.min(
                    canvasHeight,
                    (modelBottom - offsetY) / scale
                );

                if (right <= left || bottom <= top) {
                    continue;
                }

                detections.push({
                    classId,
                    className: 'interactive_element',
                    confidence,
                    bbox: {
                        x: left,
                        y: top,
                        width: right - left,
                        height: bottom - top
                    }
                });
            }
        }

        return this.nonMaximumSuppression(detections);
    }

    nonMaximumSuppression(detections) {
        const sorted = [...detections].sort(
            (a, b) => b.confidence - a.confidence
        );
        const kept = [];

        while (sorted.length > 0) {
            const current = sorted.shift();
            kept.push(current);

            for (let i = sorted.length - 1; i >= 0; i--) {
                if (this.iou(current.bbox, sorted[i].bbox) > 0.45) {
                    sorted.splice(i, 1);
                }
            }
        }

        return kept.slice(0, 100);
    }

    iou(a, b) {
        const left = Math.max(a.x, b.x);
        const top = Math.max(a.y, b.y);
        const right = Math.min(
            a.x + a.width,
            b.x + b.width
        );
        const bottom = Math.min(
            a.y + a.height,
            b.y + b.height
        );

        const intersectionWidth = Math.max(0, right - left);
        const intersectionHeight = Math.max(0, bottom - top);
        const intersection =
            intersectionWidth * intersectionHeight;

        const areaA = a.width * a.height;
        const areaB = b.width * b.height;
        const union = areaA + areaB - intersection;

        return union > 0 ? intersection / union : 0;
    }
}


/**
 * Integrate the local detector into the existing VisionProcessor.
 * The existing DOM/feature pipeline remains intact.
 */
(() => {
    if (typeof VisionProcessor === 'undefined') {
        Logger.error(
            'VISION',
            'VisionProcessor is not available for ONNX integration'
        );
        return;
    }

    const originalInitialize =
        VisionProcessor.prototype.initialize;
    const originalExtractFeatures =
        VisionProcessor.prototype.extractFeatures;

    VisionProcessor.prototype.initialize = async function () {
        const baseReady =
            await originalInitialize.call(this);

        if (!baseReady) {
            return false;
        }

        try {
            this.localOnnxModel = new LocalOnnxVisionModel();
            await this.localOnnxModel.initialize();
            return true;
        } catch (error) {
            Logger.warn(
                'VISION',
                'Local ONNX model is unavailable; continuing with existing local feature extraction',
                error
            );

            this.localOnnxModel = null;
            return true;
        }
    };

    VisionProcessor.prototype.extractFeatures = async function (canvas) {
        const features =
            await originalExtractFeatures.call(this, canvas);

        if (!this.localOnnxModel) {
            return features;
        }

        try {
            features.uiDetections =
                await this.localOnnxModel.infer(canvas);
        } catch (error) {
            Logger.warn(
                'VISION',
                'Local ONNX inference failed for this frame',
                error
            );

            features.uiDetections = [];
        }

        return features;
    };
})();
