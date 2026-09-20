/**
 * Local ONNX Vision Model Integration
 *
 * Bridges the existing VisionProcessor with ONNX Runtime Web
 * without sending page pixels to the backend.
 *
 * Expected model:
 *   models/gui-detector/model.onnx
 *
 * The model accepts BGR float32 image input at 640x640 and produces
 * YuNet's multi-scale face-detection heads.
 */

class LocalOnnxVisionModel {
    constructor() {
        this.session = null;
        this.inputName = null;
        this.inputWidth = 640;
        this.inputHeight = 640;
        this.confidenceThreshold = 0.9;
        this.nmsThreshold = 0.3;
        this.topK = 5000;
        this.modelPath = 'models/face-detector/face_detection_yunet_2023mar.onnx';
        this.modelType = 'yunet';
        this.initialized = false;
        this.lastPreprocess = null;
        this.loggedOutputDiagnostics = false;
        this.isOffscreenContext =
            typeof location !== 'undefined' &&
            location.protocol === 'chrome-extension:';
    }

    async initialize() {
        // Content scripts intentionally do not initialize ONNX Runtime.
        // The model is loaded only inside the extension offscreen document,
        // which is outside the target webpage's execution context/CSP.
        if (!this.isOffscreenContext) {
            this.initialized = true;
            Logger.log(
                'VISION',
                'Local ONNX model will run through the extension offscreen document'
            );
            return true;
        }

        if (!window.ort) {
            throw new Error('ONNX Runtime Web is not available in offscreen context');
        }

        const modelUrl = chrome.runtime.getURL(this.modelPath);

        Logger.log(
            'VISION',
            'Loading local ONNX vision model: ' + this.modelPath
        );
        const wasmPath = chrome.runtime.getURL(
            'node_modules/onnxruntime-web/dist/'
        );

        window.ort.env.wasm.numThreads = 1;
        window.ort.env.wasm.proxy = false;
        window.ort.env.wasm.wasmPaths = wasmPath;

        Logger.log(
            'VISION',
            'Configuring ONNX Runtime Web for single-threaded WASM in offscreen document'
        );

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

        Logger.log(
            'VISION',
            'ONNX input: ' + input.name + ' ' + JSON.stringify(input.dims)
        );

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
            `Local ONNX model loaded in offscreen context: ${this.modelPath} (${this.inputWidth}x${this.inputHeight})`
        );

        return true;
    }

    async infer(canvas) {
        if (!this.initialized) {
            return [];
        }

        if (!this.isOffscreenContext) {
            return this.inferThroughOffscreenDocument(canvas);
        }

        if (!this.session || !this.inputName) {
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

        if (!this.loggedOutputDiagnostics) {
            Logger.log(
                'VISION',
                'ONNX inference completed',
                Object.fromEntries(
                    Object.entries(outputs).map(([name, tensor]) => [
                        name,
                        tensor?.dims || null
                    ])
                )
            );
            this.loggedOutputDiagnostics = true;
        }

        return this.parseOutputs(
            outputs,
            canvas.width,
            canvas.height,
            preprocessed
        );
    }

    async inferThroughOffscreenDocument(canvas) {
        const ctx = canvas.getContext('2d', {
            willReadFrequently: true
        });

        if (!ctx) {
            throw new Error('Could not read canvas pixels for offscreen inference');
        }

        const imageData = ctx.getImageData(
            0,
            0,
            canvas.width,
            canvas.height
        );

        const response = await chrome.runtime.sendMessage({
            type: 'offscreen_vision_request',
            width: canvas.width,
            height: canvas.height,
            pixels: Array.from(imageData.data)
        });

        if (!response?.success) {
            throw new Error(
                response?.error || 'Offscreen vision inference failed'
            );
        }

        return Array.isArray(response.detections)
            ? response.detections
            : [];
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

        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, this.inputWidth, this.inputHeight);

        ctx.drawImage(
            canvas,
            0,
            0,
            canvas.width,
            canvas.height,
            0,
            0,
            this.inputWidth,
            this.inputHeight
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

        // OpenCV's YuNet implementation feeds BGR float pixels in the
        // original 0-255 range. Canvas provides RGB, so convert RGB -> BGR.
        for (let y = 0; y < this.inputHeight; y++) {
            for (let x = 0; x < this.inputWidth; x++) {
                const sourceIndex = (y * this.inputWidth + x) * 4;
                const targetIndex = y * this.inputWidth + x;

                const r = source[sourceIndex];
                const g = source[sourceIndex + 1];
                const b = source[sourceIndex + 2];

                tensor[targetIndex] = b;
                tensor[planeSize + targetIndex] = g;
                tensor[(planeSize * 2) + targetIndex] = r;
            }
        }

        return {
            tensor,
            scaleX: canvas.width / this.inputWidth,
            scaleY: canvas.height / this.inputHeight
        };
    }

    parseYuNetOutputs(outputs, canvasWidth, canvasHeight, preprocessInfo) {
        const detections = [];
        const strides = [8, 16, 32];

        const outputByName = new Map(
            Object.entries(outputs).map(([name, tensor]) => [name, tensor])
        );

        for (const stride of strides) {
            const clsTensor = outputByName.get(`cls_${stride}`);
            const objTensor = outputByName.get(`obj_${stride}`);
            const bboxTensor = outputByName.get(`bbox_${stride}`);
            const kpsTensor = outputByName.get(`kps_${stride}`);

            if (!clsTensor || !objTensor || !bboxTensor || !kpsTensor) {
                Logger.warn(
                    'VISION',
                    `YuNet outputs missing for stride ${stride}`
                );
                continue;
            }

            const cls = clsTensor.data;
            const obj = objTensor.data;
            const bbox = bboxTensor.data;
            const kps = kpsTensor.data;

            const gridWidth = Math.ceil(this.inputWidth / stride);
            const gridHeight = Math.ceil(this.inputHeight / stride);
            const expectedCount = gridWidth * gridHeight;
            const count = Math.min(
                expectedCount,
                cls.length,
                obj.length,
                Math.floor(bbox.length / 4),
                Math.floor(kps.length / 10)
            );

            for (let index = 0; index < count; index++) {
                let clsScore = Number(cls[index]);
                let objScore = Number(obj[index]);

                if (!Number.isFinite(clsScore) ||
                    !Number.isFinite(objScore)) {
                    continue;
                }

                clsScore = Math.max(0, Math.min(1, clsScore));
                objScore = Math.max(0, Math.min(1, objScore));

                const confidence = Math.sqrt(clsScore * objScore);

                if (confidence < this.confidenceThreshold) {
                    continue;
                }

                const row = Math.floor(index / gridWidth);
                const column = index % gridWidth;
                const bboxOffset = index * 4;

                const cx =
                    (column + Number(bbox[bboxOffset])) * stride;
                const cy =
                    (row + Number(bbox[bboxOffset + 1])) * stride;
                const width =
                    Math.exp(Number(bbox[bboxOffset + 2])) * stride;
                const height =
                    Math.exp(Number(bbox[bboxOffset + 3])) * stride;

                if (![cx, cy, width, height].every(Number.isFinite) ||
                    width <= 0 || height <= 0) {
                    continue;
                }

                const modelLeft = cx - width / 2;
                const modelTop = cy - height / 2;
                const scaleX = preprocessInfo?.scaleX || 1;
                const scaleY = preprocessInfo?.scaleY || 1;

                const left = modelLeft * scaleX;
                const top = modelTop * scaleY;
                const scaledWidth = width * scaleX;
                const scaledHeight = height * scaleY;

                const clipped = this.clipToCanvas(
                    canvasWidth,
                    canvasHeight,
                    left,
                    top,
                    scaledWidth,
                    scaledHeight
                );

                if (clipped.width <= 0 || clipped.height <= 0) {
                    continue;
                }

                const landmarks = [];
                const kpsOffset = index * 10;

                for (let point = 0; point < 5; point++) {
                    landmarks.push({
                        x: (
                            Number(kps[kpsOffset + point * 2]) + column
                        ) * stride * scaleX,
                        y: (
                            Number(kps[kpsOffset + point * 2 + 1]) + row
                        ) * stride * scaleY
                    });
                }

                detections.push({
                    classId: 0,
                    className: 'face',
                    label: 'face',
                    confidence,
                    bbox: clipped,
                    landmarks
                });
            }
        }

        return this.nonMaximumSuppression(
            detections,
            this.nmsThreshold
        ).slice(0, this.topK);
    }


    clipToCanvas(canvasWidth, canvasHeight, x, y, width, height) {
        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const right = Math.min(canvasWidth, x + width);
        const bottom = Math.min(canvasHeight, y + height);

        return {
            x: left,
            y: top,
            width: Math.max(0, right - left),
            height: Math.max(0, bottom - top)
        };
    }

    parseOutputs(
        outputs,
        canvasWidth,
        canvasHeight,
        preprocessInfo
    ) {
        if (this.modelType === 'yunet') {
            return this.parseYuNetOutputs(
                outputs,
                canvasWidth,
                canvasHeight,
                preprocessInfo
            );
        }

        const detections = [];

        for (const [outputName, output] of Object.entries(outputs)) {
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

            if (!this.loggedOutputDiagnostics) {
                let minValue = Infinity;
                let maxValue = -Infinity;

                for (let i = 0; i < data.length; i++) {
                    const value = Number(data[i]);

                    if (!Number.isFinite(value)) {
                        continue;
                    }

                    if (value < minValue) {
                        minValue = value;
                    }

                    if (value > maxValue) {
                        maxValue = value;
                    }
                }

                const sampleRows = [];
                const sampleRowCount = Math.min(rows, 5);

                for (let row = 0; row < sampleRowCount; row++) {
                    const offset = row * columns;
                    const rowValues = [];

                    for (let column = 0; column < columns; column++) {
                        rowValues.push(Number(data[offset + column]));
                    }

                    sampleRows.push(rowValues);
                }

                Logger.log(
                    'VISION',
                    `ONNX output ${outputName}: shape=${JSON.stringify(dims)}, min=${minValue}, max=${maxValue}, sample=${JSON.stringify(sampleRows)}`
                );
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

        this.loggedOutputDiagnostics = true;

        return this.nonMaximumSuppression(detections);
    }

    nonMaximumSuppression(detections, threshold = 0.45) {
        const sorted = [...detections].sort(
            (a, b) => b.confidence - a.confidence
        );
        const kept = [];

        while (sorted.length > 0) {
            const current = sorted.shift();
            kept.push(current);

            for (let i = sorted.length - 1; i >= 0; i--) {
                if (this.iou(current.bbox, sorted[i].bbox) > threshold) {
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
 * Integrate the local face detector into the existing VisionProcessor.
 * DOM/regex privacy detection remains the first deterministic layer.
 */
(() => {
    if (typeof VisionProcessor === 'undefined') {
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
