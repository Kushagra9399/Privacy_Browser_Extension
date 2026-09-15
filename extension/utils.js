/**
 * Shared Utilities for Privacy Browser Agent
 */

class Logger {
    static log(module, message, data = null) {
        const timestamp = new Date().toISOString();
        const logMsg = `[${timestamp}] [${module}] ${message}`;
        console.log(logMsg, data || '');
    }

    static error(module, message, error = null) {
        console.error(`[${module}] ${message}`, error || '');
    }

    static warn(module, message) {
        console.warn(`[${module}] ${message}`);
    }
}

/**
 * Configuration Manager for Privacy Agent
 */
class Config {
    static DEFAULT = {
        SERVER_URL: 'http://localhost:8000',
        ENABLE_LOCAL_VISION: true,
        ENABLE_REDACTION: true,
        REDACTION_MODE: 'blur', // blur, black, semantic
        PRIVACY_FILTERS: {
            detectPasswords: true,
            detectEmails: true,
            detectCreditCards: true,
            detectPhones: true,
            detectFaces: true,
            detectSensitiveInputs: true
        },
        PERFORMANCE: {
            maxScreenWidth: 1280,
            maxScreenHeight: 720,
            jpegQuality: 0.7,
            processingInterval: 2000 // ms
        },
        TIMEOUT: {
            visionModel: 5000,
            serverRequest: 10000
        }
    };

    static async load() {
        return new Promise((resolve) => {
            chrome.storage.sync.get(this.DEFAULT, (config) => {
                resolve(config);
            });
        });
    }

    static async getServerUrl() {
        const config = await this.load();
        return (config.SERVER_URL || this.DEFAULT.SERVER_URL).replace(/\/$/, '');
    }

    static async save(config) {
        return new Promise((resolve) => {
            chrome.storage.sync.set(config, resolve);
        });
    }
}

/**
 * Performance Monitor for tracking latency
 */
class PerformanceMonitor {
    constructor() {
        this.metrics = {};
    }

    start(label) {
        this.metrics[label] = performance.now();
    }

    end(label) {
        if (this.metrics[label]) {
            const duration = performance.now() - this.metrics[label];
            Logger.log('PERF', `${label}: ${duration.toFixed(2)}ms`);
            return duration;
        }
        return 0;
    }

    async measureAsync(label, asyncFn) {
        this.start(label);
        const result = await asyncFn();
        this.end(label);
        return result;
    }
}

/**
 * Element Information Extractor
 */
function getElementInfo(element, index) {
    const rect = element.getBoundingClientRect();
    
    // Check if element is visible
    const isVisible = rect.width > 0 && rect.height > 0 && 
                      window.getComputedStyle(element).visibility !== 'hidden';

    const elementInfo = {
        element_id: `el_${index}`,
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || null,
        id: element.id || null,
        class: element.className || null,
        name: element.getAttribute('name') || null,
        text: (element.innerText?.trim() || element.value || '').substring(0, 100),
        placeholder: element.getAttribute('placeholder') || null,
        ariaLabel: element.getAttribute('aria-label') || null,
        ariaDescribedBy: element.getAttribute('aria-describedby') || null,
        autocomplete: element.getAttribute('autocomplete') || null,
        role: element.getAttribute('role') || null,
        dataTestId: element.getAttribute('data-testid') || null,
        title: element.getAttribute('title') || null,
        bbox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        },
        isVisible: isVisible,
        isInteractive: isInteractiveElement(element)
    };

    return elementInfo;
}

/**
 * Check if an element is interactive
 */
function isInteractiveElement(element) {
    const interactiveTags = ['button', 'a', 'input', 'textarea', 'select', 'label'];
    const tag = element.tagName.toLowerCase();
    
    if (interactiveTags.includes(tag)) return true;
    if (element.onclick || element.getAttribute('role') === 'button') return true;
    if (element.hasAttribute('data-clickable')) return true;
    
    return false;
}

/**
 * Extract all interactive elements from the page
 */
function extractPageStructure() {
    const selectors = [
        'button',
        'a',
        'input',
        'textarea',
        'select',
        '[role="button"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[onclick]',
        '[data-clickable]'
    ];

    const elements = [];
    const seen = new Set();

    selectors.forEach(selector => {
        try {
            document.querySelectorAll(selector).forEach((el, idx) => {
                // Avoid duplicates
                if (!seen.has(el)) {
                    seen.add(el);
                    const info = getElementInfo(el, elements.length);
                    elements.push(info);
                }
            });
        } catch (e) {
            Logger.warn('EXTRACT', `Invalid selector: ${selector}`);
        }
    });

    return elements;
}

/**
 * Extract the actual DOM nodes used by the agent registry.
 */
function extractInteractiveDomElements() {
    const selectors = [
        'button', 'a', 'input', 'textarea', 'select',
        '[role="button"]', '[role="link"]', '[role="menuitem"]',
        '[onclick]', '[data-clickable]'
    ];
    const elements = [];
    const seen = new Set();

    selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((element) => {
            if (!seen.has(element)) {
                seen.add(element);
                elements.push(element);
            }
        });
    });

    return elements;
}

/**
 * Convert Canvas to JPEG/WebP for efficiency
 */
async function canvasToJpeg(canvas, quality = 0.7) {
    return new Promise((resolve) => {
        canvas.toBlob((blob) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                resolve({
                    data: reader.result,
                    size: blob.size,
                    type: 'image/jpeg'
                });
            };
            reader.readAsDataURL(blob);
        }, 'image/jpeg', quality);
    });
}

/**
 * Resize image for efficient processing
 */
function resizeCanvas(canvas, maxWidth, maxHeight) {
    const ratio = Math.min(maxWidth / canvas.width, maxHeight / canvas.height);
    
    if (ratio >= 1) return canvas; // No resize needed
    
    const resized = document.createElement('canvas');
    resized.width = canvas.width * ratio;
    resized.height = canvas.height * ratio;
    
    const ctx = resized.getContext('2d');
    ctx.drawImage(canvas, 0, 0, resized.width, resized.height);
    
    return resized;
}

/**
 * Communication helper for client-server
 */
class ServerComm {
    constructor(serverUrl) {
        this.serverUrl = serverUrl;
        this.requestId = 0;
    }

    /**
     * Sanitize text before it crosses the browser/server privacy boundary.
     * This is a defense-in-depth layer; visual redaction must already happen
     * before a screenshot is accepted for server processing.
     */
    sanitizeNetworkText(value) {
        return String(value || '')
            .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED]')
            .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED]')
            .replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[REDACTED]')
            .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[REDACTED]');
    }

    /**
     * Sanitize page structure metadata without changing its DOM action IDs.
     */
    sanitizePageStructure(pageStructure) {
        if (!pageStructure || typeof pageStructure !== 'object') {
            return pageStructure;
        }

        const sanitizeValue = (value, key = '') => {
            if (typeof value === 'string') {
                if (key === 'url') {
                    try {
                        const parsed = new URL(value);
                        return `${parsed.origin}${parsed.pathname}`;
                    } catch (error) {
                        return this.sanitizeNetworkText(value);
                    }
                }
                return this.sanitizeNetworkText(value);
            }

            if (Array.isArray(value)) {
                return value.map(item => sanitizeValue(item));
            }

            if (value && typeof value === 'object') {
                const result = {};
                for (const [childKey, childValue] of Object.entries(value)) {
                    result[childKey] = sanitizeValue(childValue, childKey);
                }
                return result;
            }

            return value;
        };

        return sanitizeValue(pageStructure);
    }

    /**
     * Enforce the local privacy boundary for visual requests.
     * A screenshot is never sent unless the local vision pipeline supplied
     * a redaction mask alongside it.
     */
    prepareRequestData(endpoint, data) {
        if (endpoint !== '/api/process-screen') {
            return data;
        }

        if (!data || typeof data !== 'object') {
            throw new Error('Privacy boundary rejected visual request: invalid payload');
        }

        if (!data.screenshot) {
            throw new Error('Privacy boundary rejected visual request: screenshot is missing');
        }

        if (!data.redactionMask || !Array.isArray(data.redactionMask.redactions)) {
            throw new Error('Privacy boundary rejected visual request: local redaction mask is missing');
        }

        return {
            ...data,
            pageStructure: this.sanitizePageStructure(data.pageStructure),
            privacy: {
                localRedactionApplied: true,
                redactionCount: data.redactionMask.redactions.length,
                boundary: 'client'
            }
        };
    }

    async sendRequest(endpoint, data, timeout = 10000) {
        this.requestId++;
        const reqId = this.requestId;
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            const safeData = this.prepareRequestData(endpoint, data);

            const response = await fetch(`${this.serverUrl}${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Request-ID': reqId.toString()
                },
                body: JSON.stringify(safeData),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Server error: ${response.status} ${response.statusText}`);
            }

            return await response.json();
        } catch (error) {
            Logger.error('COMM', `Request failed to ${endpoint}`, error);
            throw error;
        }
    }

    async processScreen(screenshot, pageStructure, redactionMask) {
        return this.sendRequest('/api/process-screen', {
            screenshot: screenshot,
            pageStructure: pageStructure,
            redactionMask: redactionMask,
            timestamp: Date.now()
        });
    }

    async executeAction(action) {
        return this.sendRequest('/api/execute', {
            action: action,
            timestamp: Date.now()
        });
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        Logger,
        Config,
        PerformanceMonitor,
        getElementInfo,
        extractPageStructure,
        canvasToJpeg,
        resizeCanvas,
        ServerComm
    };
}
