/**
 * Privacy Filter - Detects and redacts sensitive/PII data
 * Evaluation Metric 2 & 3: Recall/Precision for sensitive data detection and redaction precision
 */

class PrivacyFilter {
    constructor(config = {}) {
        this.config = {
            detectPasswords: true,
            detectEmails: true,
            detectCreditCards: true,
            detectPhones: true,
            detectFaces: true,
            detectSSN: true,
            detectSensitiveInputs: true,
            redactionMode: 'blur', // 'blur', 'black', 'semantic'
            blurRadius: 15,
            ...config
        };

        this.redactionMap = new Map(); // Tracks redactions for later reference
        this.detectionStats = {
            totalElements: 0,
            sensitiveDetected: 0,
            redacted: 0
        };

        // Regex patterns for PII detection
        this.patterns = {
            email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
            phone: /(?:\+?\d{1,3}[\s.-]?)?(?:\d{3}[\s.-]?\d{3}[\s.-]?\d{4}|\d{5}[\s.-]?\d{5}|\d{10})/g,
            ssn: /\d{3}-\d{2}-\d{4}/g,
            creditCard: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
            zipCode: /\b\d{5}(?:-\d{4})?\b/g,
            ipAddress: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
        };

        // Sensitive input patterns (form fields that likely contain sensitive data)
        this.sensitiveInputPatterns = {
            password: /password|passwd|pwd|pass/i,
            creditCard: /card|cc|cardnum|cvv|cvc|expiry|exp_date/i,
            ssn: /ssn|social.security|taxpayer.id/i,
            phone: /phone|mobile|cellphone|telephone/i,
            email: /email|e-mail|mail/i,
            address: /address|street|city|state|zip|postal/i,
            dob: /date.of.birth|dob|birth|birthday/i,
            license: /license|drivers|dl|dlicense/i
        };
    }

    /**
     * Analyze page and create redaction mask
     */
    analyzePage() {
        const redactions = [];

        // Each analysis represents one page state. Do not carry counts
        // from previous observations into the current redaction mask.
        this.resetStats();

        // Check input elements
        document.querySelectorAll('input, textarea, select').forEach((el, idx) => {
            this.detectionStats.totalElements++;

            const sensitiveType = this.classifyInputElement(el);
            if (sensitiveType) {
                const rect = el.getBoundingClientRect();
                redactions.push({
                    id: `input_${idx}`,
                    type: sensitiveType,
                    bbox: {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height
                    },
                    reason: 'sensitive_input',
                    priority: 'high'
                });
                this.detectionStats.sensitiveDetected++;
            }
        });

        // Detect text content with PII
        const textRedactions = this.detectPIIInContent();
        redactions.push(...textRedactions);

        // Check for password fields that are filled
        document.querySelectorAll('input[type="password"]').forEach((el) => {
            if (el.value) {
                const rect = el.getBoundingClientRect();
                redactions.push({
                    type: 'password_value',
                    bbox: {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height
                    },
                    reason: 'password_filled',
                    priority: 'critical'
                });
                this.detectionStats.sensitiveDetected++;
            }
        });

        this.redactionMap.set(Date.now(), redactions);
        return redactions;
    }

    /**
     * Classify input element sensitivity
     */
    classifyInputElement(element) {
        const name = (element.name || '').toLowerCase();
        const id = (element.id || '').toLowerCase();
        const type = (element.getAttribute('type') || '').toLowerCase();
        const placeholder = (element.placeholder || '').toLowerCase();
        const ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();

        const combined = `${name} ${id} ${type} ${placeholder} ${ariaLabel}`;

        // Check patterns
        for (const [category, pattern] of Object.entries(this.sensitiveInputPatterns)) {
            if (pattern.test(combined)) {
                return category;
            }
        }

        return null;
    }

    /**
     * Detect PII in visible text content
     */
    detectPIIInContent() {
        const redactions = [];
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        let node;
        while (node = walker.nextNode()) {
            const text = node.textContent;

            // Check for emails
            if (this.config.detectEmails) {
                const emailMatches = text.matchAll(this.patterns.email);
                for (const match of emailMatches) {
                    const rect = this.getTextNodeBounds(node, match.index, match[0].length);
                    if (rect) {
                        redactions.push({
                            type: 'email',
                            text: match[0],
                            bbox: rect,
                            reason: 'pii_email',
                            priority: 'high'
                        });
                        this.detectionStats.sensitiveDetected++;
                    }
                }
            }

            // Check for phone numbers
            if (this.config.detectPhones) {
                const phoneMatches = text.matchAll(this.patterns.phone);
                for (const match of phoneMatches) {
                    const rect = this.getTextNodeBounds(node, match.index, match[0].length);
                    if (rect) {
                        redactions.push({
                            type: 'phone',
                            text: match[0],
                            bbox: rect,
                            reason: 'pii_phone',
                            priority: 'high'
                        });
                        this.detectionStats.sensitiveDetected++;
                    }
                }
            }

            // Check for SSN
            if (this.config.detectSSN) {
                const ssnMatches = text.matchAll(this.patterns.ssn);
                for (const match of ssnMatches) {
                    const rect = this.getTextNodeBounds(node, match.index, match[0].length);
                    if (rect) {
                        redactions.push({
                            type: 'ssn',
                            text: match[0],
                            bbox: rect,
                            reason: 'pii_ssn',
                            priority: 'critical'
                        });
                        this.detectionStats.sensitiveDetected++;
                    }
                }
            }

            // Check for credit cards
            if (this.config.detectCreditCards) {
                const ccMatches = text.matchAll(this.patterns.creditCard);
                for (const match of ccMatches) {
                    const rect = this.getTextNodeBounds(node, match.index, match[0].length);
                    if (rect && this.isValidCreditCard(match[0])) {
                        redactions.push({
                            type: 'credit_card',
                            text: match[0],
                            bbox: rect,
                            reason: 'pii_creditcard',
                            priority: 'critical'
                        });
                        this.detectionStats.sensitiveDetected++;
                    }
                }
            }
        }

        return redactions;
    }

    /**
     * Get bounds of text within a text node
     */
    getTextNodeBounds(textNode, startOffset, length) {
        try {
            const range = document.createRange();
            range.setStart(textNode, startOffset);
            range.setEnd(textNode, startOffset + length);
            const rect = range.getBoundingClientRect();

            if (rect.width > 0 && rect.height > 0) {
                return {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                };
            }
        } catch (e) {
            // Silently handle bounds calculation errors
        }
        return null;
    }

    /**
     * Validate credit card using Luhn algorithm
     */
    isValidCreditCard(cardNumber) {
        const cleaned = cardNumber.replace(/[\s-]/g, '');
        if (!/^\d{13,19}$/.test(cleaned)) return false;

        let sum = 0;
        let isEven = false;

        for (let i = cleaned.length - 1; i >= 0; i--) {
            let digit = parseInt(cleaned[i], 10);

            if (isEven) {
                digit *= 2;
                if (digit > 9) digit -= 9;
            }

            sum += digit;
            isEven = !isEven;
        }

        return sum % 10 === 0;
    }

    /**
     * Convert local vision detections into privacy redactions.
     * Only known sensitive classes are accepted. Unknown UI detections are
     * never treated as PII automatically.
     */
    convertVisionDetections(detections, canvasWidth, canvasHeight) {
        const sensitiveClasses = new Set([
            'face',
            'person_face',
            'id_card',
            'passport',
            'drivers_license',
            'signature',
            'qr_code',
            'barcode',
            'credit_card',
            'sensitive_document'
        ]);

        if (!Array.isArray(detections)) {
            return [];
        }

        const redactions = [];

        for (const detection of detections) {
            const type = String(
                detection?.className || detection?.label || ''
            ).toLowerCase().trim();
            const bbox = detection?.bbox;

            if (!sensitiveClasses.has(type) || !bbox) {
                continue;
            }

            const clipped = this.clipToCanvas(
                { width: canvasWidth, height: canvasHeight },
                Number(bbox.x) || 0,
                Number(bbox.y) || 0,
                Number(bbox.width) || 0,
                Number(bbox.height) || 0
            );

            if (clipped.width <= 0 || clipped.height <= 0) {
                continue;
            }

            redactions.push({
                id: `vision_${Date.now()}_${redactions.length}`,
                type,
                bbox: clipped,
                confidence: Number(detection.confidence) || 0,
                reason: 'local_vision_sensitive_detection',
                priority: 'critical'
            });
        }

        this.detectionStats.sensitiveDetected += redactions.length;
        return redactions;
    }

    /**
     * Apply redactions to canvas
     */
    applyRedactionsToCanvas(canvas, redactions) {
        const ctx = canvas.getContext('2d');
        ctx.save();

        redactions.forEach(redaction => {
            const { bbox, type } = redaction;

            // Expand bbox slightly for safety
            const padding = 2;
            const x = bbox.x - padding;
            const y = bbox.y - padding;
            const width = bbox.width + (padding * 2);
            const height = bbox.height + (padding * 2);

            // Ensure coordinates are within canvas
            const clipped = this.clipToCanvas(canvas, x, y, width, height);

            if (clipped.width <= 0 || clipped.height <= 0) {
                return;
            }

            if (this.config.redactionMode === 'blur') {
                this.applyBlur(ctx, clipped.x, clipped.y, clipped.width, clipped.height);
            } else if (this.config.redactionMode === 'black') {
                this.applyBlack(ctx, clipped.x, clipped.y, clipped.width, clipped.height);
            } else if (this.config.redactionMode === 'semantic') {
                this.applySemanticObfuscation(ctx, clipped.x, clipped.y, clipped.width, clipped.height, type);
            }
        });

        ctx.restore();
        this.detectionStats.redacted = redactions.length;
        return canvas;
    }

    /**
     * Clip coordinates to canvas bounds
     */
    clipToCanvas(canvas, x, y, width, height) {
        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const right = Math.min(canvas.width, x + width);
        const bottom = Math.min(canvas.height, y + height);

        return {
            x: left,
            y: top,
            width: Math.max(0, right - left),
            height: Math.max(0, bottom - top)
        };
    }

    /**
     * Apply blur effect to the existing pixels in the redaction area
     */
    applyBlur(ctx, x, y, width, height) {
        if (width <= 0 || height <= 0) return;

        // Use a separate canvas as the filtered source. Drawing a canvas onto
        // itself with ctx.filter is unreliable and can leave PII readable.
        const blurCanvas = document.createElement('canvas');
        blurCanvas.width = Math.ceil(width);
        blurCanvas.height = Math.ceil(height);

        const blurCtx = blurCanvas.getContext('2d');
        if (!blurCtx) return;

        blurCtx.filter = `blur(${this.config.blurRadius}px)`;
        blurCtx.drawImage(
            ctx.canvas,
            x, y, width, height,
            0, 0, blurCanvas.width, blurCanvas.height
        );
        blurCtx.filter = 'none';

        ctx.drawImage(
            blurCanvas,
            0, 0, blurCanvas.width, blurCanvas.height,
            x, y, width, height
        );
    }

    /**
     * Apply black box
     */
    applyBlack(ctx, x, y, width, height) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(x, y, width, height);
    }

    /**
     * Apply semantic obfuscation (pattern overlay)
     */
    applySemanticObfuscation(ctx, x, y, width, height, type) {
        ctx.fillStyle = '#CCCCCC';
        ctx.fillRect(x, y, width, height);

        // Add a semantic marker
        ctx.fillStyle = '#666666';
        ctx.font = '10px Arial';
        ctx.fillText(`[${type.toUpperCase()}]`, x + 2, y + 12);
    }

    /**
     * Create metadata mask for server (without visual data)
     */
    createRedactionMask(redactions, canvasWidth, canvasHeight) {
        return {
            canvas: {
                width: canvasWidth,
                height: canvasHeight
            },
            redactions: redactions.map(r => ({
                type: r.type,
                bbox: r.bbox,
                reason: r.reason,
                priority: r.priority
            })),
            stats: { ...this.detectionStats },
            timestamp: Date.now()
        };
    }

    /**
     * Get statistics
     */
    getStats() {
        return { ...this.detectionStats };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.detectionStats = {
            totalElements: 0,
            sensitiveDetected: 0,
            redacted: 0
        };
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PrivacyFilter };
}
