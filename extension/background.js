/**
 * Background Service Worker for Privacy Browser Agent
 * Handles extension lifecycle, tab management, and communication coordination
 */

class ExtensionManager {
    constructor() {
        this.activeTabs = new Map();
        this.config = null;
        this.setupListeners();
        Logger.log('BG', 'Extension Manager initialized');
    }

    setupListeners() {
        // Listen for content script ready messages
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            try {
                switch (request.type) {
                    case 'content_ready':
                        this.handleContentReady(sender.tab, sender.frameId);
                        sendResponse({ success: true });
                        break;
                    case 'processing_result':
                        this.handleProcessingResult(sender.tab, request.data);
                        sendResponse({ success: true });
                        break;
                    case 'offscreen_vision_request':
                        this.handleOffscreenVisionRequest(request)
                            .then((result) => sendResponse(result))
                            .catch((error) => {
                                Logger.error('BG', 'Offscreen vision request failed', error);
                                sendResponse({ success: false, error: error?.message || 'Offscreen vision request failed' });
                            });
                        return true;
                    case 'offscreen_vision_ready':
                        sendResponse({ success: true });
                        break;
                    default:
                        sendResponse({ success: true });
                }
            } catch (error) {
                Logger.error('BG', 'Message handling error', error);
                sendResponse({ error: error.message });
            }
        });

        chrome.runtime.onConnect.addListener((port) => {
            if (port.name !== 'privacy-browser-offscreen-ai') {
                return;
            }
            Logger.log('BG', 'Offscreen vision port connected');
        });

        chrome.tabs.onActivated.addListener((activeInfo) => {
            this.handleTabActivated(activeInfo.tabId);
        });

        chrome.tabs.onRemoved.addListener((tabId) => {
            this.activeTabs.delete(tabId);
        });

        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (changeInfo.status === 'complete') {
                // Could trigger processing on new pages
            }
        });

        chrome.runtime.onInstalled.addListener(() => {
            this.handleExtensionInstalled();
        });
    }

    async ensureOffscreenDocument() {
        const offscreenUrl = chrome.runtime.getURL('offscreen.html');
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [offscreenUrl]
        });

        if (existingContexts.length > 0) {
            return;
        }

        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['BLOBS'],
            justification: 'Run local ONNX vision inference outside webpage execution contexts.'
        });

        Logger.log('BG', 'Offscreen local vision document created');
    }

    async handleOffscreenVisionRequest(request) {
        await this.ensureOffscreenDocument();
        return this.sendOffscreenRequest({
            type: 'run_offscreen_vision',
            width: request.width,
            height: request.height,
            pixels: request.pixels
        }, 15000);
    }

    async sendOffscreenRequest(request, timeoutMs) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                resolve(result);
            };

            const timeout = setTimeout(() => {
                finish({ success: false, error: 'Offscreen local AI request timed out' });
            }, timeoutMs);

            const port = chrome.runtime.connect({
                name: 'privacy-browser-offscreen-ai'
            });

            port.onMessage.addListener((response) => {
                clearTimeout(timeout);
                finish(response || {
                    success: false,
                    error: 'No response from offscreen local AI'
                });
                port.disconnect();
            });

            port.onDisconnect.addListener(() => {
                clearTimeout(timeout);
                if (chrome.runtime.lastError) {
                    finish({
                        success: false,
                        error: chrome.runtime.lastError.message
                    });
                }
            });

            port.postMessage(request);
        });
    }

    handleContentReady(tab, frameId) {
        Logger.log('BG', `Content ready for tab ${tab.id}`, tab.url);
        if (!this.activeTabs.has(tab.id)) {
            this.activeTabs.set(tab.id, {
                url: tab.url,
                frameId: frameId,
                initialized: true,
                lastUpdate: Date.now()
            });
        }
    }

    handleProcessingResult(tab, data) {
        Logger.log('BG', `Processing result from tab ${tab.id}`, data);
        if (this.activeTabs.has(tab.id)) {
            const tabInfo = this.activeTabs.get(tab.id);
            tabInfo.lastResult = data;
            tabInfo.lastUpdate = Date.now();
        }
    }

    handleTabActivated(tabId) {
        Logger.log('BG', `Tab activated: ${tabId}`);
    }

    async handleExtensionInstalled() {
        Logger.log('BG', 'Extension installed');
        const defaultConfig = await Config.load();
        chrome.tabs.create({
            url: 'popup.html?mode=settings'
        });
    }

    getTabInfo(tabId) {
        return this.activeTabs.get(tabId) || null;
    }

    getAllActiveTabs() {
        return Array.from(this.activeTabs.entries()).map(([tabId, info]) => ({
            tabId,
            ...info
        }));
    }
}

let extensionManager = null;

if (typeof Logger === 'undefined') {
    var Logger = {
        log: (module, message, data) => {
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] [${module}] ${message}`, data || '');
        },
        error: (module, message, error) => {
            console.error(`[${module}] ${message}`, error || '');
        },
        warn: (module, message) => {
            console.warn(`[${module}] ${message}`);
        }
    };
}

if (typeof Config === 'undefined') {
    var Config = {
        DEFAULT: {
            SERVER_URL: 'http://localhost:8000',
            ENABLE_LOCAL_VISION: true,
            ENABLE_REDACTION: true,
            REDACTION_MODE: 'blur',
            PERFORMANCE: {
                maxScreenWidth: 1280,
                maxScreenHeight: 720,
                jpegQuality: 0.7,
                processingInterval: 2000
            }
        },
        async load() {
            return new Promise((resolve) => {
                chrome.storage.sync.get(this.DEFAULT, (config) => {
                    resolve(config);
                });
            });
        },
        async save(config) {
            return new Promise((resolve) => {
                chrome.storage.sync.set(config, resolve);
            });
        }
    };
}

extensionManager = new ExtensionManager();

setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;

    for (const [tabId, info] of extensionManager.activeTabs) {
        if (now - info.lastUpdate > maxAge) {
            extensionManager.activeTabs.delete(tabId);
        }
    }
}, 5 * 60 * 1000);

Logger.log('BG', 'Background service worker started');
