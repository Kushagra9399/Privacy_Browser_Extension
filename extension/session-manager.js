/**
 * Element Registry - Stable element identification for browser agent
 * 
 * Problem:
 * - DOM order changes, elements move, get hidden
 * - ID="el_1" based on order is unreliable
 * - LLM can't trust random selectors
 * 
 * Solution:
 * - Create stable "agent-el-XXX" IDs
 * - Map to actual DOM elements with fingerprinting
 * - Validate before every action
 * - Detect stale references
 */

class ElementRegistry {
    constructor() {
        // Map: agent-el-XXX → Element
        this.elementMap = new Map();
        
        // Map: agent-el-XXX → ElementFingerprint
        this.fingerprints = new Map();
        
        // Counter for ID generation
        this.elementCounter = 0;
        
        // Track element changes
        this.generationId = 0;
        
        Logger.log('REGISTRY', 'ElementRegistry initialized');
    }
    
    /**
     * Register interactive element and generate stable ID
     */
    registerElement(element) {
        // Skip non-interactive elements
        if (!isInteractiveElement(element)) {
            return null;
        }
        
        // Check if already registered
        const existingId = this.findRegisteredId(element);
        if (existingId) {
            if (!this.fingerprints.has(existingId)) {
                this.fingerprints.set(existingId, this.createFingerprint(element));
            }
            return existingId;
        }
        
        // Generate new ID
        const agentId = `agent-el-${++this.elementCounter}`;
        
        // Create fingerprint (safe structural properties only)
        const fingerprint = this.createFingerprint(element);
        
        // Store mapping
        try {
            this.elementMap.set(element, agentId);
            this.fingerprints.set(agentId, fingerprint);
        } catch (e) {
            Logger.warn('REGISTRY', 'Failed to register element', e);
            return null;
        }
        
        return agentId;
    }
    
    /**
     * Create fingerprint for element validation
     * Uses safe structural properties, NEVER sensitive values
     */
    createFingerprint(element) {
        const rect = element.getBoundingClientRect();
        
        return {
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute('type'),
            role: element.getAttribute('role'),
            // Safe ID/name/class hashes
            id_hash: this.hash(element.id || ''),
            name_hash: this.hash(element.name || ''),
            class_hash: this.hash(element.className || ''),
            // Structural position
            bbox_hash: this.hash(`${Math.round(rect.x)},${Math.round(rect.y)}`),
            // DOM position (not order)
            parent_tag: element.parentElement?.tagName.toLowerCase() || '',
            sibling_count: element.parentElement?.children.length || 0,
            // Interaction properties
            visible: rect.width > 0 && rect.height > 0,
            enabled: !element.disabled,
            generation: this.generationId
        };
    }
    
    /**
     * Hash a string (for safe comparison, not security)
     */
    hash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash);
    }
    
    /**
     * Find if element already has an ID
     */
    findRegisteredId(element) {
        return this.elementMap.get(element) || null;
    }
    
    /**
     * Resolve agent-el-XXX to actual DOM element
     */
    resolveElement(agentId) {
        for (const [element, id] of this.elementMap.entries()) {
            if (id === agentId) return element;
        }
        return null;
    }
    
    /**
     * Validate that agent-el-XXX still refers to correct element
     */
    validateReference(agentId, currentElement) {
        const fingerprint = this.fingerprints.get(agentId);
        if (!fingerprint) {
            return {
                valid: false,
                reason: 'ID_NOT_REGISTERED'
            };
        }
        
        // Check if generation changed (DOM rebuild)
        if (fingerprint.generation !== this.generationId) {
            return {
                valid: false,
                reason: 'GENERATION_MISMATCH'
            };
        }
        
        // Validate fingerprint matches
        const currentFingerprint = this.createFingerprint(currentElement);
        
        if (fingerprint.tag !== currentFingerprint.tag) {
            return {
                valid: false,
                reason: 'TAG_CHANGED'
            };
        }
        
        if (fingerprint.id_hash !== currentFingerprint.id_hash) {
            return {
                valid: false,
                reason: 'ID_CHANGED'
            };
        }
        
        if (fingerprint.name_hash !== currentFingerprint.name_hash) {
            return {
                valid: false,
                reason: 'NAME_CHANGED'
            };
        }
        
        // Position can change slightly, so only check if drastically different
        if (Math.abs(fingerprint.bbox_hash - currentFingerprint.bbox_hash) > 1000) {
            return {
                valid: false,
                reason: 'POSITION_CHANGED'
            };
        }
        
        // If we got here, it's probably still the same element
        return {
            valid: true
        };
    }
    
    /**
     * Invalidate all references due to major DOM change
     */
    invalidateGeneration() {
        this.generationId++;
        this.fingerprints.clear();
        Logger.log('REGISTRY', `Generation incremented to ${this.generationId}`);
    }
    
    /**
     * Get all registered elements for current page state
     */
    getAllElements() {
        const result = [];
        for (let [elem, id] of this.elementMap.entries()) {
            const fp = this.fingerprints.get(id);
            if (fp && fp.generation === this.generationId) {
                result.push({
                    agent_id: id,
                    element: elem,
                    fingerprint: fp
                });
            }
        }
        return result;
    }
    
    /**
     * Clear and rebuild from DOM
     */
    rebuild() {
        this.invalidateGeneration();
        
        // Re-register all interactive elements
        const interactiveElements = extractInteractiveDomElements();
        let registered = 0;
        
        for (const elem of interactiveElements) {
            if (this.registerElement(elem)) {
                registered++;
            }
        }
        
        Logger.log('REGISTRY', `Rebuilt registry: ${registered} elements`);
    }
}

/**
 * Session Manager - Manages agent session on client side
 */
class ClientSessionManager {
    constructor() {
        this.sessionId = null;
        this.serverUrl = 'http://localhost:8000';
        this.isRunning = false;
        this.currentGoal = null;
        this.observationCount = 0;
        this.sessionMode = 'server';
        this.privacyFilter = typeof PrivacyFilter !== 'undefined'
            ? new PrivacyFilter()
            : null;
        this.visionProcessor = null;
        this.elementRegistry = new ElementRegistry();
        this.perf = new PerformanceMonitor();
        
        Logger.log('SESSION', 'ClientSessionManager initialized');
    }
    
    /**
     * Start new agent session.
     *
     * Kept as a backwards-compatible entry point for the existing
     * AgentLoopOrchestrator. New routing code should explicitly choose
     * startLocalSession() or startServerSession().
     */
    async startSession(userGoal) {
        return this.startServerSession(userGoal);
    }

    /**
     * Start an agent session entirely in the browser.
     * No network request is made here.
     */
    async startLocalSession(userGoal) {
        this.currentGoal = userGoal;
        this.sessionMode = 'local';
        this.sessionId = `local_${uuid.v4().substring(0, 8)}`;
        this.observationCount = 0;
        this.isRunning = true;

        Logger.log('SESSION', `Local session started: ${this.sessionId}`);
        return this.sessionId;
    }

    /**
     * Build page metadata that is safe to send to the backend.
     * Query parameters and fragments are removed because they can contain PII.
     */
    getSanitizedPageContext() {
        if (!this.privacyFilter) {
            throw new Error('Privacy boundary unavailable: refusing network request');
        }

        // Run local privacy analysis before any server communication.
        const redactions = this.privacyFilter.analyzePage();

        const safeTitle = String(document.title || '')
            .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED]')
            .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED]')
            .replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[REDACTED]')
            .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[REDACTED]');

        return {
            origin: window.location.origin,
            path: window.location.pathname,
            title: safeTitle,
            privacy: {
                analysisCompleted: true,
                redactionCount: redactions.length,
                localOnly: true
            }
        };
    }

    /**
     * Start an agent session on the backend.
     */
    async startServerSession(userGoal) {
        try {
            this.currentGoal = userGoal;
            this.sessionMode = 'server';
            Logger.log('SESSION', `Starting server session with goal: ${userGoal}`);
            
            // Request session from server
            const response = await fetch(`${this.serverUrl}/api/agent/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_goal: userGoal,
                    page_context: this.getSanitizedPageContext()
                })
            });
            
            if (!response.ok) {
                throw new Error(`Server error: ${response.statusText}`);
            }
            
            const data = await response.json();
            this.sessionId = data.session_id;
            this.observationCount = 0;
            this.isRunning = true;
            
            Logger.log('SESSION', `Server session started: ${this.sessionId}`);
            return this.sessionId;
        } catch (error) {
            Logger.error('SESSION', 'Failed to start server session', error);
            throw error;
        }
    }
    
    /**
     * Send observation and get next action
     */
    async observe() {
        if (!this.sessionId || !this.isRunning) {
            throw new Error('Session not active');
        }
        
        try {
            return await this.perf.measureAsync('OBSERVE_CYCLE', async () => {
                // Build observation
                const observation = await this.buildObservation();

                const requestPayload = {
                    session_id: this.sessionId,
                    observation
                };
                const requestBody = JSON.stringify(requestPayload);

                await this.recordPrivacyDebugRequest('/api/agent/observe', requestBody);

                Logger.log('SESSION', `Sending observation ${observation.observation_id}`);
                
                // Send the exact same serialized body captured by the privacy inspector.
                const response = await fetch(`${this.serverUrl}/api/agent/observe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: requestBody
                });
                
                if (!response.ok) {
                    throw new Error(`Server error: ${response.statusText}`);
                }
                
                const data = await response.json();
                
                if (!data.success) {
                    const errorMessage =
                        data.error_message ||
                        'Server failed to produce an action';

                    Logger.error(
                        'SESSION',
                        `Agent session failed: ${errorMessage}`
                    );

                    this.isRunning = false;

                    throw new Error(
                        `Agent session failed: ${errorMessage}`
                    );
                }
                
                if (data.action) {
                    Logger.log('SESSION', `Received action: ${data.action.type}`);
                }
                
                return data.action;
            });
        } catch (error) {
            Logger.error('SESSION', 'Observation failed', error);
            throw error;
        }
    }
    
    /**
     * Build current page observation
     */
    async buildObservation() {
        const rect = document.documentElement.getBoundingClientRect();

        // Always build the safe DOM observation locally.
        const allElements = extractInteractiveDomElements();
        const elements = [];

        for (const elem of allElements) {
            const agentId = this.elementRegistry.registerElement(elem);
            if (!agentId) continue;

            const sensitiveType = this.detectSensitive(elem);

            elements.push({
                agent_element_id: agentId,
                tag: elem.tagName.toLowerCase(),
                role: elem.getAttribute('role'),
                element_type: elem.getAttribute('type'),
                text_preview: sensitiveType
                    ? '[REDACTED]'
                    : this.sanitizeObservationText(elem.textContent?.substring(0, 100) || ''),
                placeholder: sensitiveType
                    ? '[REDACTED]'
                    : this.sanitizeObservationText(elem.getAttribute('placeholder') || ''),
                aria_label: sensitiveType
                    ? '[REDACTED]'
                    : this.sanitizeObservationText(elem.getAttribute('aria-label') || ''),
                visible: elem.offsetParent !== null,
                enabled: !elem.disabled,
                interactive: true,
                sensitive: !!sensitiveType,
                sensitive_type: sensitiveType,
                bbox: {
                    x: elem.getBoundingClientRect().left,
                    y: elem.getBoundingClientRect().top,
                    width: elem.getBoundingClientRect().width,
                    height: elem.getBoundingClientRect().height
                }
            });
        }

        let visualContext = null;

        if (this.visionProcessor) {
            try {
                Logger.log('SESSION', 'Running local privacy/vision pipeline before server observation');

                const result = await this.visionProcessor.processScreen();

                if (result) {
                    visualContext = {
                        screenshot: result.screenshot,
                        redactionMask: result.redactionMask,
                        canvas: result.features?.canvas || null,
                        colors: result.features?.colors || null,
                        regions: result.features?.regions || null,
                        complexity: result.features?.complexity || null,
                        timestamp: result.timestamp
                    };

                    Logger.log('SESSION', 'Local privacy/vision pipeline completed', {
                        redactions: result.redactionMask?.redactions?.length || 0,
                        screenshotSize: result.screenshot?.size || 0
                    });
                }
            } catch (error) {
                Logger.error('SESSION', 'Local privacy/vision pipeline failed; refusing to send raw visual context', error);
            }
        }

        return {
            observation_id: `obs_${uuid.v4().substring(0, 8)}`,
            page_revision: this.observationCount++,
            url: window.location.origin + window.location.pathname,
            title: this.sanitizeObservationText(document.title || ''),
            viewport_width: window.innerWidth,
            viewport_height: window.innerHeight,
            timestamp: new Date().toISOString(),
            elements,
            screenshot_available: !!visualContext?.screenshot,
            visual_context: visualContext
        };
    }
    /**
     * Store the exact outbound JSON payload locally for privacy inspection.
     * This never sends debug data to the backend; it uses extension session storage only.
     */
    async recordPrivacyDebugRequest(endpoint, requestBody) {
        try {
            const serialized = String(requestBody || '');
            const payload = JSON.parse(serialized);
            const record = {
                endpoint,
                timestamp: new Date().toISOString(),
                bytes: new Blob([serialized]).size,
                payload
            };

            await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    type: 'privacy_debug_capture',
                    record
                }, () => {
                    void chrome.runtime.lastError;
                    resolve();
                });
            });

            Logger.log('PRIVACY_DEBUG', 'Captured exact outbound backend payload through extension background', {
                endpoint,
                bytes: record.bytes,
                screenshotPresent: !!payload?.observation?.visual_context?.screenshot,
                redactionCount: payload?.observation?.visual_context?.redactionMask?.redactions?.length || 0
            });
        } catch (error) {
            Logger.warn('PRIVACY_DEBUG', 'Could not capture outbound payload for inspection', error);
        }
    }

    /**
     * Remove common PII patterns from observation metadata.
     * This operates entirely inside the browser.
     */
    sanitizeObservationText(value) {
        return String(value || '')
            .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED]')
            .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED]')
            .replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[REDACTED]')
            .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[REDACTED]');
    }
    
    /**
     * Detect if element contains sensitive data
     */
    detectSensitive(elem) {
        const type = (elem.getAttribute('type') || '').toLowerCase();
        if (type === 'password') return 'password';
        if (type === 'email') return 'email';
        
        const combined = [
            elem.name || '',
            elem.id || '',
            elem.getAttribute('placeholder') || '',
            elem.getAttribute('aria-label') || ''
        ].join(' ').toLowerCase();
        
        if (combined.includes('password') || combined.includes('pass')) return 'password';
        if (combined.includes('email')) return 'email';
        if (combined.includes('card') || combined.includes('cc') || combined.includes('cvv')) return 'credit_card';
        if (combined.includes('ssn') || combined.includes('social')) return 'ssn';
        if (combined.includes('phone')) return 'phone';
        
        return null;
    }
    
    /**
     * Report action result
     */
    async reportActionResult(action, success, errorCode = null, errorMessage = null, newObservation = null) {
        if (!this.sessionId) return;
        
        try {
            const response = await fetch(`${this.serverUrl}/api/agent/action-result`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session_id: this.sessionId,
                    result: {
                        action_id: action.action_id,
                        success: success,
                        error_code: errorCode,
                        error_message: errorMessage,
                        result: {},
                        duration_ms: 0,
                        new_observation: newObservation
                    }
                })
            });
            
            if (!response.ok) {
                Logger.warn('SESSION', `Failed to report result: ${response.statusText}`);
            }
        } catch (error) {
            Logger.error('SESSION', 'Failed to report action result', error);
        }
    }
    
    /**
     * Stop session
     */
    async stopSession() {
        if (!this.sessionId) return;
        
        try {
            if (this.sessionMode === 'server') {
                await fetch(`${this.serverUrl}/api/agent/stop`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: this.sessionId })
                });
            }
            
            this.isRunning = false;
            Logger.log('SESSION', `${this.sessionMode === 'server' ? 'Server' : 'Local'} session stopped`);
        } catch (error) {
            Logger.error('SESSION', 'Failed to stop session', error);
        }
    }
}

/**
 * UUID helper
 */
const uuid = {
    v4: function() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
};
