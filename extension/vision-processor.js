/**
 * Vision Processor - Handles local vision model inference and screen analysis
 * Evaluation Metric 1: Accuracy of visual context from screen
 * Evaluation Metric 4: Client side resource utilization
 */

class VisionProcessor {
    constructor() {
        this.model = null;
        this.localPiiNer = null;
        this.initialized = false;
        this.sessionId = `session_${Date.now()}`;
        this.perf = new PerformanceMonitor();
    }

    /**
     * Initialize the local vision processor.
     * ONNX Runtime is owned by the extension offscreen document.
     */
    async initialize() {
        try {
            Logger.log(
                'VISION',
                'Initializing vision processor...'
            );

            // ONNX Runtime runs in the extension offscreen document.
            // The content script keeps the local feature-extraction pipeline
            // and the LocalOnnxVisionModel bridge handles offscreen inference.
            this.initialized = true;

            try {
                this.localPiiNer = new LocalPiiNer();
                await this.localPiiNer.initialize();
                Logger.log(
                    'PRIVACY',
                    'Local PII NER detector initialized'
                );
            } catch (error) {
                this.localPiiNer = null;
                Logger.warn(
                    'PRIVACY',
                    'Local PII NER unavailable; deterministic privacy filters remain active',
                    error
                );
            }

            Logger.log(
                'VISION',
                'Vision processor initialized'
            );

            return true;

        } catch (error) {

            Logger.error(
                'VISION',
                'Failed to initialize vision processor',
                error
            );

            return false;
        }
    }


    /**
     * Capture the actual browser viewport through the background service
     * worker. The raw screenshot stays inside the extension until redaction.
     */
    async captureViewport() {
        return this.perf.measureAsync('CAPTURE', async () => {
            try {
                const response = await new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage(
                        { type: 'capture_visible_tab' },
                        (result) => {
                            if (chrome.runtime.lastError) {
                                reject(new Error(chrome.runtime.lastError.message));
                                return;
                            }
                            if (!result?.success || !result.dataUrl) {
                                reject(new Error(result?.error || 'Browser screenshot capture failed'));
                                return;
                            }
                            resolve(result);
                        }
                    );
                });

                const canvas = await this.dataUrlToCanvas(response.dataUrl);
                if (!canvas) throw new Error('Captured screenshot could not be decoded');

                Logger.log('VISION', `Captured actual browser viewport: ${canvas.width}x${canvas.height}`);
                return canvas;
            } catch (error) {
                Logger.error('VISION', 'Failed to capture actual browser viewport', error);
                return null;
            }
        });
    }

    async dataUrlToCanvas(dataUrl) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = image.naturalWidth || image.width;
                    canvas.height = image.naturalHeight || image.height;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    if (!ctx) {
                        reject(new Error('Could not create screenshot canvas context'));
                        return;
                    }
                    ctx.drawImage(image, 0, 0);
                    resolve(canvas);
                } catch (error) {
                    reject(error);
                }
            };
            image.onerror = () => reject(new Error('Failed to decode browser screenshot'));
            image.src = dataUrl;
        });
    }

    /**
     * DOM and Range coordinates use CSS pixels while native screenshots may
     * use device pixels. Map all DOM-derived privacy boxes accordingly.
     */
    scaleViewportRedactions(redactions, canvas) {
        if (!Array.isArray(redactions) || !canvas) return redactions || [];

        const viewportWidth = Math.max(1, window.innerWidth || canvas.width);
        const viewportHeight = Math.max(1, window.innerHeight || canvas.height);
        const scaleX = canvas.width / viewportWidth;
        const scaleY = canvas.height / viewportHeight;

        return redactions.map((redaction) => {
            if (!redaction?.bbox) return redaction;
            return {
                ...redaction,
                bbox: {
                    x: redaction.bbox.x * scaleX,
                    y: redaction.bbox.y * scaleY,
                    width: redaction.bbox.width * scaleX,
                    height: redaction.bbox.height * scaleY
                }
            };
        });
    }

    /**
     * Extract visual features from canvas
     */
    async extractFeatures(canvas) {

        return this.perf.measureAsync(
            'FEATURES',
            async () => {

                if (!canvas) {

                    throw new Error(
                        'Canvas is null'
                    );
                }


                const ctx =
                    canvas.getContext('2d');


                if (!ctx) {

                    throw new Error(
                        'Could not get canvas context'
                    );
                }


                const imageData =
                    ctx.getImageData(
                        0,
                        0,
                        canvas.width,
                        canvas.height
                    );


                // Calculate basic visual features
                const features = {

                    canvas: {

                        width:
                            canvas.width,

                        height:
                            canvas.height,

                        aspectRatio:
                            canvas.height !== 0
                                ? canvas.width /
                                  canvas.height
                                : 0
                    },


                    colors:
                        this.analyzeColors(
                            imageData
                        ),


                    regions:
                        this.detectRegions(
                            imageData
                        ),


                    complexity:
                        this.calculateComplexity(
                            imageData
                        )
                };


                return features;
            }
        );
    }


    /**
     * Analyze color distribution
     */
    analyzeColors(imageData) {

        const data =
            imageData.data;

        let whitePixels = 0;
        let darkPixels = 0;


        for (
            let i = 0;
            i < data.length;
            i += 4
        ) {

            const r =
                data[i];

            const g =
                data[i + 1];

            const b =
                data[i + 2];


            const luminance =
                (
                    r * 299 +
                    g * 587 +
                    b * 114
                ) / 1000;


            if (luminance > 200) {
                whitePixels++;
            }


            if (luminance < 50) {
                darkPixels++;
            }
        }


        const totalPixels =
            data.length / 4;


        return {

            whiteRatio:
                totalPixels > 0
                    ? whitePixels /
                      totalPixels
                    : 0,

            darkRatio:
                totalPixels > 0
                    ? darkPixels /
                      totalPixels
                    : 0
        };
    }


    /**
     * Detect visual regions
     */
    detectRegions(imageData) {

        const data =
            imageData.data;

        const regions = [];

        let currentRegion = null;


        for (
            let i = 0;
            i < data.length;
            i += 4
        ) {

            const luminance =
                (
                    data[i] * 299 +
                    data[i + 1] * 587 +
                    data[i + 2] * 114
                ) / 1000;


            const pixelIndex =
                i / 4;


            if (luminance < 100) {

                if (!currentRegion) {

                    currentRegion = {

                        startPixel:
                            pixelIndex,

                        pixels: 0
                    };
                }


                currentRegion.pixels++;

            } else if (
                currentRegion
            ) {

                regions.push(
                    currentRegion
                );

                currentRegion = null;
            }
        }


        // Handle region reaching end
        if (currentRegion) {

            regions.push(
                currentRegion
            );
        }


        return regions

            .map((r) => ({

                size:
                    r.pixels,

                intensity:
                    'high'
            }))

            .slice(
                0,
                10
            );
    }


    /**
     * Calculate visual complexity
     */
    calculateComplexity(imageData) {

        const data =
            imageData.data;

        let variance = 0;


        for (
            let i = 0;
            i < data.length;
            i += 4
        ) {

            const r =
                data[i];

            const g =
                data[i + 1];

            const b =
                data[i + 2];


            const avg =
                (r + g + b) / 3;


            variance +=
                Math.pow(
                    avg - 128,
                    2
                );
        }


        const pixelCount =
            data.length / 4;


        if (pixelCount === 0) {
            return 0;
        }


        variance /=
            pixelCount;


        return Math.sqrt(
            variance
        ) / 255;
    }


    /**
     * Analyze page structure combined with vision
     */
    async analyzePageStructure() {

        return this.perf.measureAsync(
            'ANALYZE',
            async () => {

                const elements =
                    extractPageStructure();


                const analysis = {

                    totalElements:
                        elements.length,

                    interactiveElements:
                        elements.filter(
                            e =>
                                e.isInteractive
                        ).length,

                    visibleElements:
                        elements.filter(
                            e =>
                                e.isVisible
                        ).length,

                    elements:
                        elements,

                    pageTitle:
                        document.title,

                    url:
                        window.location.href,

                    timestamp:
                        Date.now()
                };


                return analysis;
            }
        );
    }


    async detectTextPii() {
        if (!this.localPiiNer) {
            return [];
        }

        const redactions = [];
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT
        );

        let node;
        let processed = 0;
        let nodesWithNerResults = 0;
        let totalNerEntities = 0;

        while ((node = walker.nextNode()) && processed < 80) {
            const text = node.textContent || '';
            const trimmed = text.trim();

            if (!trimmed || trimmed.length < 3) {
                continue;
            }

            const parent = node.parentElement;
            if (!parent) {
                continue;
            }

            const style = window.getComputedStyle(parent);
            if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.opacity === '0'
            ) {
                continue;
            }

            const parentRect = parent.getBoundingClientRect();
            if (
                parentRect.width <= 0 ||
                parentRect.height <= 0 ||
                parentRect.bottom <= 0 ||
                parentRect.top >= window.innerHeight
            ) {
                continue;
            }

            try {
                const nerText = trimmed.slice(0, 2000);
                const entities = await this.localPiiNer.infer(nerText);

                if (entities.length > 0) {
                    nodesWithNerResults++;
                    totalNerEntities += entities.length;
                    Logger.log('PRIVACY', 'Local NER detected entities in visible text', {
                        nodeIndex: processed,
                        textLength: nerText.length,
                        entities: entities.map(entity => ({
                            type: entity.type,
                            start: entity.start,
                            end: entity.end,
                            confidence: Number(entity.confidence?.toFixed?.(4) || entity.confidence || 0)
                        }))
                    });
                }

                for (const entity of entities) {
                    const start = Number(entity.start);
                    const end = Number(entity.end);

                    if (
                        !Number.isInteger(start) ||
                        !Number.isInteger(end) ||
                        start < 0 ||
                        end <= start ||
                        end > trimmed.length
                    ) {
                        continue;
                    }

                    const rawStart = text.indexOf(trimmed);
                    if (rawStart < 0) {
                        continue;
                    }

                    const range = document.createRange();
                    range.setStart(
                        node,
                        rawStart + start
                    );
                    range.setEnd(
                        node,
                        rawStart + end
                    );

                    const rects = Array.from(
                        range.getClientRects()
                    );

                    for (const rect of rects) {
                        if (
                            rect.width <= 0 ||
                            rect.height <= 0
                        ) {
                            continue;
                        }

                        redactions.push({
                            id: `ner_${Date.now()}_${redactions.length}`,
                            type: String(entity.type || 'PII').toLowerCase(),
                            bbox: {
                                x: Math.max(0, rect.x),
                                y: Math.max(0, rect.y),
                                width: Math.min(
                                    rect.width,
                                    window.innerWidth - Math.max(0, rect.x)
                                ),
                                height: Math.min(
                                    rect.height,
                                    window.innerHeight - Math.max(0, rect.y)
                                )
                            },
                            confidence: Number(entity.confidence) || 0,
                            reason: 'local_ner_sensitive_text',
                            priority: 'high'
                        });
                    }

                    range.detach?.();
                }
            } catch (error) {
                Logger.error(
                    'PRIVACY',
                    'Local NER inference failed for text node',
                    error
                );
            }

            processed++;
        }

        const validRedactions = redactions.filter(
            item => item.bbox.width > 0 && item.bbox.height > 0
        );

        Logger.log('PRIVACY', 'Local NER scan complete', {
            processedTextNodes: processed,
            nodesWithNerResults,
            totalNerEntities,
            validRedactions: validRedactions.length
        });

        return validRedactions;
    }

    /**
     * Process a complete screen
     * Capture + privacy filtering + feature extraction
     */
    async processScreen() {
        try {
            Logger.log('VISION', 'Starting screen processing...');

            const canvas = await this.captureViewport();

            if (!canvas) {
                Logger.error('VISION', 'Failed to capture viewport');
                return null;
            }

            // Run local vision on the raw local canvas first. The raw pixels
            // remain inside the browser and are never sent to the server.
            const features = await this.extractFeatures(canvas);

            const privacyFilter = new PrivacyFilter();
            let redactions = privacyFilter.analyzePage();

            const textPiiRedactions = await this.detectTextPii();
            redactions.push(...textPiiRedactions);

            // DOM/NER coordinates are CSS-pixel viewport coordinates. Convert
            // them to the native screenshot's device-pixel coordinate space.
            redactions = this.scaleViewportRedactions(redactions, canvas);

            const visionRedactions = privacyFilter.convertVisionDetections(
                features?.uiDetections || [],
                canvas.width,
                canvas.height
            );

            redactions.push(...visionRedactions);

            const redactionMask = privacyFilter.createRedactionMask(
                redactions,
                canvas.width,
                canvas.height
            );

            // Redaction happens before any screenshot serialization/network path.
            const redactedCanvas = privacyFilter.applyRedactionsToCanvas(
                canvas,
                redactions
            );

            const pageStructure = await this.analyzePageStructure();

            const screenshot = await canvasToPng(redactedCanvas);

            Logger.log('VISION', 'Screen processing complete', {
                sensitiveElementsDetected: redactionMask?.redactions?.length || 0,
                visualSensitiveDetections: visionRedactions.length,
                localNerDetections: textPiiRedactions.length,
                screenshotSize: screenshot?.size || 0
            });

            return {
                screenshot,
                redactionMask,
                features: {
                    ...features,
                    // Do not expose raw visual detections as server context.
                    uiDetections: undefined
                },
                pageStructure,
                timestamp: Date.now()
            };
        } catch (error) {
            Logger.error('VISION', 'Error during screen processing', error);
            return null;
        }
    }

    /**
     * Get session information
     */
    getSessionInfo() {

        return {

            sessionId:
                this.sessionId,

            initialized:
                this.initialized,

            timestamp:
                Date.now()
        };
    }
}


// ================================================================
// Export for Node/CommonJS environments
// ================================================================

if (
    typeof module !== 'undefined' &&
    module.exports
) {

    module.exports = {
        VisionProcessor
    };
}