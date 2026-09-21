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
                    case 'offscreen_pii_request':
                        this.handleOffscreenPiiRequest(request)
                            .then((result) => sendResponse(result))
                            .catch((error) => {
                                Logger.error('BG', 'Offscreen PII request failed', error);
                                sendResponse({ success: false, error: error?.message || 'Offscreen PII request failed' });
                            });
                        return true;
                    case 'capture_visible_tab':
                        this.captureVisibleTab(sender?.tab?.windowId)
                            .then((dataUrl) => sendResponse({ success: true, dataUrl }))
                            .catch((error) => {
                                Logger.error('BG', 'Visible tab capture failed', error);
                                sendResponse({
                                    success: false,
                                    error: error?.message || 'Visible tab capture failed'
                                });
                            });
                        return true;
                    case 'offscreen_vision_ready':
                        sendResponse({ success: true });
                        break;
                    case 'get_agent_ui_state':
                        this.getAgentUiState()
                            .then((state) => sendResponse({ success: true, state }))
                            .catch((error) => sendResponse({ success: false, error: error?.message || 'Failed to load agent state' }));
                        return true;
                    case 'clear_agent_ui_state':
                        this.clearAgentUiState()
                            .then(() => sendResponse({ success: true }))
                            .catch((error) => sendResponse({ success: false, error: error?.message || 'Failed to clear agent state' }));
                        return true;
                    default:
                        sendResponse({ success: true });
                }
            } catch (error) {
                Logger.error('BG', 'Message handling error', error);
                sendResponse({ error: error.message });
            }
        });

        chrome.runtime.onConnect.addListener((port) => {
            if (port.name === 'privacy-browser-popup') {
                let popupTabId = null;

                port.onMessage.addListener((message) => {
                    if (message?.type !== 'popup_open' || !Number.isInteger(message.tabId)) {
                        return;
                    }

                    popupTabId = message.tabId;
                    popupPorts.set(popupTabId, port);

                    chrome.tabs.sendMessage(popupTabId, {
                        type: 'popup_open'
                    }).catch(() => {});
                });

                port.onDisconnect.addListener(() => {
                    if (popupTabId == null) return;

                    if (popupPorts.get(popupTabId) === port) {
                        popupPorts.delete(popupTabId);
                    }

                    chrome.tabs.sendMessage(popupTabId, {
                        type: 'popup_closed'
                    }).catch(() => {});
                });

                return;
            }

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

    async captureVisibleTab(windowId) {
        if (!chrome.tabs?.captureVisibleTab) {
            throw new Error('chrome.tabs.captureVisibleTab is unavailable');
        }

        const options = { format: 'png' };
        return windowId == null
            ? await chrome.tabs.captureVisibleTab(options)
            : await chrome.tabs.captureVisibleTab(windowId, options);
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

    async handleOffscreenPiiRequest(request) {
        await this.ensureOffscreenDocument();

        const text = typeof request.text === 'string'
            ? request.text.slice(0, 12000)
            : '';

        return this.sendOffscreenRequest({
            type: 'run_offscreen_pii',
            text
        }, 10000);
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

    async getAgentUiState() {
        const data = await chrome.storage.session.get('agentUiState');
        return data.agentUiState || {
            running: false,
            sessionId: null,
            goal: '',
            step: 0,
            maxSteps: 20,
            status: 'idle',
            action: 'Waiting for agent...',
            reasoning: 'Start an agent task to see its reasoning here.',
            errors: 0,
            events: []
        };
    }

    async clearAgentUiState() {
        await chrome.storage.session.remove('agentUiState');
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


// Serialize agent UI state writes so rapid events cannot overwrite each other.
let agentUiStateWriteChain = Promise.resolve();
const popupPorts = new Map();

// Privacy debug bridge
chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'privacy_debug_capture' && message.record) {
        chrome.storage.session.set({
            privacyDebugLastRequest: message.record
        }).then(() => {
            return chrome.runtime.sendMessage({
                type: 'privacy_debug_update',
                record: message.record
            }).catch(() => {});
        }).catch((error) => {
            console.warn('[PRIVACY_DEBUG] Failed to store or broadcast outbound payload', error);
        });
        return;
    }

    if (message?.type === 'agent_event' && message.event_type) {
        agentUiStateWriteChain = agentUiStateWriteChain.then(async () => {
            try {
                const data = await chrome.storage.session.get('agentUiState');
                const previous = data.agentUiState || {
                    running: false,
                    sessionId: null,
                    goal: '',
                    step: 0,
                    maxSteps: 20,
                    status: 'idle',
                    action: 'Waiting for agent...',
                    reasoning: 'Start an agent task to see its reasoning here.',
                    errors: 0,
                    events: []
                };

                const event = {
                    ...message,
                    type: message.event_type,
                    timestamp: message.timestamp || new Date().toISOString()
                };

                const next = {
                    ...previous,
                    events: [...(previous.events || []), event].slice(-100)
                };

                switch (message.type) {
                    case 'agent_started':
                        next.running = true;
                        next.status = 'running';
                        next.sessionId = message.session_id || next.sessionId;
                        next.goal = message.goal || next.goal;
                        next.step = 0;
                        next.maxSteps = message.max_steps || 20;
                        next.action = 'Initializing...';
                        next.reasoning = 'Waiting for agent reasoning...';
                        next.errors = 0;
                        break;
                    case 'agent_mode_selected':
                        next.mode = message.mode;
                        break;
                    case 'step_started':
                        next.running = true;
                        next.status = 'running';
                        next.step = message.step || next.step;
                        next.maxSteps = message.max_steps || next.maxSteps;
                        break;
                    case 'action_received':
                        next.running = true;
                        next.status = 'running';
                        next.action = message.action_type || next.action;
                        next.reasoning = message.reasoning_summary || message.reason || next.reasoning;
                        break;
                    case 'action_failed':
                        next.running = true;
                        next.status = 'running';
                        next.errors = message.error_count ?? next.errors;
                        next.action = `Failed: ${message.error_code || 'action error'}`;
                        break;
                    case 'action_executed':
                        next.action = 'Executed';
                        break;
                    case 'agent_finished':
                        next.running = false;
                        next.status = 'completed';
                        next.action = 'Completed';
                        next.reasoning = message.reason || next.reasoning;
                        break;
                    case 'agent_stopped':
                        next.running = false;
                        next.status = 'stopped';
                        next.action = 'Stopped';
                        break;
                    case 'agent_safety_stop':
                        next.running = false;
                        next.status = 'stopped';
                        next.action = 'Stopped for safety';
                        next.reasoning = message.message || next.reasoning;
                        break;
                    case 'agent_error_limit':
                        next.running = false;
                        next.status = 'failed';
                        next.action = 'Error limit reached';
                        break;
                    case 'agent_ended':
                        next.running = false;
                        if (next.status === 'running') next.status = 'completed';
                        break;
                    case 'loop_error':
                        next.errors = Math.max(next.errors || 0, 1);
                        next.reasoning = message.error_message || next.reasoning;
                        break;
                }

                await chrome.storage.session.set({
                    privacyDebugLastAgentEvent: event,
                    agentUiState: next
                });

                // Broadcast live agent events back to the originating tab.
                // The floating UI runs inside the page and must not depend on
                // the extension popup remaining open.
                if (sender?.tab?.id != null) {
                    chrome.tabs.sendMessage(sender.tab.id, {
                        ...event,
                        type: 'agent_event'
                    }).catch(() => {});
                }

                // Also update the extension popup while it is open.
                // The popup is a separate extension page and does not receive
                // tab-targeted messages automatically.
                chrome.runtime.sendMessage({
                    type: 'agent_event',
                    ...event
                }).catch(() => {});
            } catch (error) {
                console.warn('[AGENT_UI] Failed to persist agent state', error);
            }
        });
    }
});
