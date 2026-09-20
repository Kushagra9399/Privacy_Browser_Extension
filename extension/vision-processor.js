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
     * Capture visible viewport as canvas
     */
    async captureViewport() {

        return this.perf.measureAsync(
            'CAPTURE',
            async () => {

                try {

                    const canvas =
                        await this.renderPageToCanvas();

                    return canvas;

                } catch (error) {

                    Logger.error(
                        'VISION',
                        'Failed to capture viewport',
                        error
                    );

                    return null;
                }
            }
        );
    }


    /**
     * Render page to canvas
     *
     * IMPORTANT:
     * OffscreenCanvas is used only as a rendering surface.
     * It does NOT automatically capture the browser viewport.
     *
     * We create an SVG snapshot of the visible DOM and render
     * that SVG into a canvas.
     */
    async renderPageToCanvas() {

        const width =
            Math.min(
                window.innerWidth || 1280,
                1280
            );

        const height =
            Math.min(
                window.innerHeight || 720,
                720
            );


        // --------------------------------------------------
        // Prefer OffscreenCanvas when available
        // --------------------------------------------------

        if (
            typeof OffscreenCanvas !== 'undefined' &&
            typeof createImageBitmap !== 'undefined'
        ) {

            try {

                return await this.renderWithOffscreenCanvas(
                    width,
                    height
                );

            } catch (error) {

                Logger.warn(
                    'VISION',
                    'OffscreenCanvas rendering failed, falling back to normal canvas',
                    error
                );
            }
        }


        // --------------------------------------------------
        // Fallback
        // --------------------------------------------------

        return await this.captureViewportSimple(
            width,
            height
        );
    }


    /**
     * Render DOM snapshot using OffscreenCanvas
     */
    async renderWithOffscreenCanvas(width, height) {

        const offscreenCanvas =
            new OffscreenCanvas(
                width,
                height
            );

        const ctx =
            offscreenCanvas.getContext('2d');

        if (!ctx) {
            throw new Error(
                'Could not create OffscreenCanvas 2D context'
            );
        }


        // --------------------------------------------------
        // Background
        // --------------------------------------------------

        let backgroundColor = 'white';

        try {

            if (document.body) {

                const computedStyle =
                    window.getComputedStyle(
                        document.body
                    );

                if (
                    computedStyle.backgroundColor &&
                    computedStyle.backgroundColor !==
                        'rgba(0, 0, 0, 0)'
                ) {

                    backgroundColor =
                        computedStyle.backgroundColor;
                }
            }

        } catch (error) {

            Logger.warn(
                'VISION',
                'Could not determine page background',
                error
            );
        }


        ctx.fillStyle = backgroundColor;
        ctx.fillRect(
            0,
            0,
            width,
            height
        );


        // --------------------------------------------------
        // Create SVG representation of DOM
        // --------------------------------------------------

        const svg =
            this.createDOMSnapshot(
                width,
                height
            );

        const blob =
            new Blob(
                [svg],
                {
                    type: 'image/svg+xml'
                }
            );


        const url =
            URL.createObjectURL(blob);


        try {

            // --------------------------------------------------
            // Convert SVG → ImageBitmap
            // --------------------------------------------------

            const response =
                await fetch(url);

            const svgBlob =
                await response.blob();

            const bitmap =
                await createImageBitmap(
                    svgBlob
                );


            // --------------------------------------------------
            // Draw SVG snapshot onto OffscreenCanvas
            // --------------------------------------------------

            ctx.drawImage(
                bitmap,
                0,
                0,
                width,
                height
            );


            bitmap.close();


            // --------------------------------------------------
            // Convert OffscreenCanvas to Blob
            // --------------------------------------------------

            const pngBlob =
                await offscreenCanvas.convertToBlob({
                    type: 'image/png'
                });


            // --------------------------------------------------
            // Convert Blob back to normal HTMLCanvasElement
            // --------------------------------------------------

            const finalCanvas =
                document.createElement('canvas');

            finalCanvas.width =
                width;

            finalCanvas.height =
                height;


            const finalCtx =
                finalCanvas.getContext('2d');

            if (!finalCtx) {

                throw new Error(
                    'Could not create final canvas context'
                );
            }


            const finalBitmap =
                await createImageBitmap(
                    pngBlob
                );


            finalCtx.drawImage(
                finalBitmap,
                0,
                0
            );


            finalBitmap.close();


            return finalCanvas;

        } finally {

            URL.revokeObjectURL(url);
        }
    }


    /**
     * Simple viewport capture using normal HTML canvas
     */
    async captureViewportSimple(
        width,
        height
    ) {

        const canvas =
            document.createElement('canvas');

        canvas.width =
            width;

        canvas.height =
            height;


        const ctx =
            canvas.getContext('2d');

        if (!ctx) {

            throw new Error(
                'Could not create canvas context'
            );
        }


        // --------------------------------------------------
        // Draw document background
        // --------------------------------------------------

        let backgroundColor = 'white';

        try {

            if (document.body) {

                const computedStyle =
                    window.getComputedStyle(
                        document.body
                    );

                if (
                    computedStyle.backgroundColor &&
                    computedStyle.backgroundColor !==
                        'rgba(0, 0, 0, 0)'
                ) {

                    backgroundColor =
                        computedStyle.backgroundColor;
                }
            }

        } catch (error) {

            Logger.warn(
                'VISION',
                'Could not determine background color',
                error
            );
        }


        ctx.fillStyle =
            backgroundColor;

        ctx.fillRect(
            0,
            0,
            width,
            height
        );


        // --------------------------------------------------
        // Create SVG snapshot
        // --------------------------------------------------

        const svg =
            this.createDOMSnapshot(
                width,
                height
            );


        const blob =
            new Blob(
                [svg],
                {
                    type: 'image/svg+xml'
                }
            );


        const url =
            URL.createObjectURL(blob);


        return new Promise(
            (resolve) => {

                const img =
                    new Image();


                img.onload = () => {

                    try {

                        ctx.drawImage(
                            img,
                            0,
                            0,
                            width,
                            height
                        );

                    } catch (error) {

                        Logger.warn(
                            'VISION',
                            'Failed to draw SVG image',
                            error
                        );
                    }


                    URL.revokeObjectURL(
                        url
                    );


                    resolve(canvas);
                };


                img.onerror = () => {

                    Logger.warn(
                        'VISION',
                        'Failed to render SVG, using basic canvas'
                    );


                    URL.revokeObjectURL(
                        url
                    );


                    resolve(canvas);
                };


                img.src =
                    url;
            }
        );
    }


    /**
     * Create SVG snapshot of DOM
     */
    createDOMSnapshot(
        width,
        height
    ) {

        let svg =
            `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;


        // --------------------------------------------------
        // Background
        // --------------------------------------------------

        svg +=
            `<rect width="${width}" height="${height}" fill="white"/>`;


        // --------------------------------------------------
        // Check body
        // --------------------------------------------------

        if (!document.body) {

            svg += '</svg>';

            return svg;
        }


        // --------------------------------------------------
        // Capture text and interactive elements
        // --------------------------------------------------

        const walker =
            document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT |
                NodeFilter.SHOW_ELEMENT,
                null,
                false
            );


        let node;


        while (
            (node = walker.nextNode())
        ) {

            // ==================================================
            // TEXT NODE
            // ==================================================

            if (
                node.nodeType ===
                Node.TEXT_NODE
            ) {

                const text =
                    node.textContent
                        .trim();


                if (
                    text &&
                    text.length > 0
                ) {

                    const parent =
                        node.parentElement;


                    if (!parent) {
                        continue;
                    }


                    // Ignore invisible elements
                    const parentStyle =
                        window.getComputedStyle(
                            parent
                        );


                    if (
                        parentStyle.display ===
                            'none' ||
                        parentStyle.visibility ===
                            'hidden'
                    ) {

                        continue;
                    }


                    const rect =
                        parent.getBoundingClientRect();


                    if (
                        rect.width > 0 &&
                        rect.height > 0 &&
                        rect.bottom > 0 &&
                        rect.top < height
                    ) {

                        const x =
                            Math.max(
                                0,
                                Math.round(rect.x)
                            );


                        const y =
                            Math.max(
                                0,
                                Math.round(rect.y)
                            );


                        const fontSize =
                            parseFloat(
                                parentStyle.fontSize
                            ) || 12;


                        const fontFamily =
                            parentStyle.fontFamily ||
                            'Arial';


                        const color =
                            parentStyle.color ||
                            'black';


                        // Prevent enormous text nodes
                        const safeText =
                            text.substring(
                                0,
                                200
                            );


                        svg +=
                            `<text x="${x}" y="${y + fontSize}" ` +
                            `font-family="${this.escapeXml(fontFamily)}" ` +
                            `font-size="${fontSize}" ` +
                            `fill="${this.escapeXml(color)}">` +
                            `${this.escapeXml(safeText)}` +
                            `</text>`;
                    }
                }
            }


            // ==================================================
            // ELEMENT NODE
            // ==================================================

            else if (
                node.nodeType ===
                Node.ELEMENT_NODE
            ) {

                const element =
                    node;


                const rect =
                    element.getBoundingClientRect();


                if (
                    rect.width <= 0 ||
                    rect.height <= 0
                ) {

                    continue;
                }


                // Ignore elements outside viewport
                if (
                    rect.bottom < 0 ||
                    rect.top > height
                ) {

                    continue;
                }


                const tagName =
                    element.tagName
                        .toLowerCase();


                const x =
                    Math.max(
                        0,
                        Math.round(rect.x)
                    );


                const y =
                    Math.max(
                        0,
                        Math.round(rect.y)
                    );


                const w =
                    Math.round(
                        rect.width
                    );


                const h =
                    Math.round(
                        rect.height
                    );


                // --------------------------------------------------
                // Interactive elements
                // --------------------------------------------------

                if (
                    [
                        'button',
                        'input',
                        'textarea',
                        'select',
                        'a'
                    ].includes(tagName)
                ) {

                    svg +=
                        `<rect x="${x}" y="${y}" ` +
                        `width="${w}" height="${h}" ` +
                        `fill="none" ` +
                        `stroke="blue" ` +
                        `stroke-width="1"/>`;
                }
            }
        }


        svg += '</svg>';

        return svg;
    }


    /**
     * Escape XML special characters
     */
    escapeXml(str) {

        return String(str).replace(
            /[<>&"']/g,
            (char) => {

                const entities = {

                    '<': '&lt;',
                    '>': '&gt;',
                    '&': '&amp;',
                    '"': '&quot;',
                    "'": '&apos;'
                };


                return entities[char];
            }
        );
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
                const entities = await this.localPiiNer.infer(
                    trimmed.slice(0, 2000)
                );

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
                Logger.warn(
                    'PRIVACY',
                    'Local NER inference failed for text node',
                    error
                );
            }

            processed++;
        }

        return redactions.filter(
            item => item.bbox.width > 0 && item.bbox.height > 0
        );
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
            const redactions = privacyFilter.analyzePage();

            const textPiiRedactions = await this.detectTextPii();
            redactions.push(...textPiiRedactions);

            // Vision detections are treated as additional local privacy signals.
            // Only detections explicitly classified as sensitive are accepted.
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

            const screenshot = await canvasToJpeg(
                redactedCanvas,
                0.7
            );

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