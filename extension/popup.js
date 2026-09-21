/**
 * Popup UI Controller for Privacy Browser Agent
 * Upgraded for agent-powered user queries
 */

class PopupController {
    constructor() {
        this.config = null;
        this.currentSessionId = null;
        this.agentRunning = false;
        this.currentStep = 0;
        this.maxSteps = 20;
        this.logs = [];
        this.maxLogs = 100;

        this.initializeUI();
        this.loadConfiguration();
        this.setupEventListeners();
        this.listenForAgentEvents();
        this.listenForPrivacyDebug();
        this.loadPrivacyDebug();
        this.loadLatestAgentEvent();
        this.loadAgentUiState();
    }

    initializeUI() {
        // Legacy UI elements
        this.legacyElements = {
            startBtn: document.getElementById('startBtn'),
            stopBtn: document.getElementById('stopBtn'),
            processBtn: document.getElementById('processBtn'),
            saveConfig: document.getElementById('saveConfig'),
            clearLogs: document.getElementById('clearLogs'),
            
            statusLabel: document.getElementById('statusLabel'),
            sessionId: document.getElementById('sessionId'),
            serverStatus: document.getElementById('serverStatus'),
            
            sensitiveCount: document.getElementById('sensitiveCount'),
            redactedCount: document.getElementById('redactedCount'),
            processingTime: document.getElementById('processingTime'),
            
            serverUrl: document.getElementById('serverUrl'),
            enableRedaction: document.getElementById('enableRedaction'),
            redactionMode: document.getElementById('redactionMode'),
            
            logContainer: document.getElementById('logContainer'),
            settingsLink: document.getElementById('settingsLink'),
            helpLink: document.getElementById('helpLink')
        };

        // NEW: Agent UI elements
        this.agentElements = {
            userGoalInput: document.getElementById('userGoal'),
            startAgentBtn: document.getElementById('startAgentBtn'),
            stopAgentBtn: document.getElementById('stopAgentBtn'),
            
            userGoalSection: document.getElementById('userGoalSection'),
            agentStatusSection: document.getElementById('agentStatusSection'),
            
            goalText: document.getElementById('goalText'),
            stepNumber: document.getElementById('stepNumber'),
            maxSteps: document.getElementById('maxSteps'),
            actionText: document.getElementById('actionText'),
            reasoningText: document.getElementById('reasoningText'),
            statusBadge: document.getElementById('statusBadge'),
            errorCount: document.getElementById('errorCount'),
            errorInfoItem: document.getElementById('errorInfoItem'),
            
            agentLogContainer: document.getElementById('agentLogContainer')
        };

        this.addLog('Popup initialized', 'info', 'legacy');
    }

    setupEventListeners() {
        // Legacy controls
        this.legacyElements.startBtn.addEventListener('click', () => this.startMonitoring());
        this.legacyElements.stopBtn.addEventListener('click', () => this.stopMonitoring());
        this.legacyElements.processBtn.addEventListener('click', () => this.processNow());
        this.legacyElements.saveConfig.addEventListener('click', () => this.saveConfiguration());
        this.legacyElements.clearLogs.addEventListener('click', () => this.clearLogs('legacy'));

        // NEW: Agent controls
        this.agentElements.startAgentBtn.addEventListener('click', () => this.startAgentSession());
        this.agentElements.stopAgentBtn.addEventListener('click', () => this.stopAgentSession());
        
        // Allow Enter in textarea to start (Shift+Enter for newline)
        this.agentElements.userGoalInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.startAgentSession();
            }
        });

        this.legacyElements.settingsLink.addEventListener('click', (e) => {
            e.preventDefault();
            this.openSettings();
        });

        this.legacyElements.helpLink.addEventListener('click', (e) => {
            e.preventDefault();
            this.openHelp();
        });
    }

    /**
     * Listen for agent events from content script
     */
    listenForAgentEvents() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.type === 'agent_event') {
                this.handleAgentEvent(request);
                sendResponse({ received: true });
            }
        });
    }

    listenForPrivacyDebug() {
        chrome.runtime.onMessage.addListener((request) => {
            if (request.type === 'privacy_debug_update' && request.record) {
                this.renderPrivacyDebug(request.record);
            }
        });

        const clearButton = document.getElementById('clearPrivacyDebug');
        if (clearButton) {
            clearButton.addEventListener('click', async () => {
                await chrome.storage.session.remove('privacyDebugLastRequest');
                this.renderPrivacyDebug(null);
            });
        }
    }

    async loadLatestAgentEvent() {
        // Kept for compatibility with the previous persisted event key.
        try {
            const data = await chrome.storage.session.get('privacyDebugLastAgentEvent');
            if (data.privacyDebugLastAgentEvent) {
                this.applyAgentEvent(data.privacyDebugLastAgentEvent, false);
            }
        } catch (error) {
            // Popup can still operate without persisted state.
        }
    }

    async loadAgentUiState() {
        try {
            const response = await new Promise((resolve) => {
                chrome.runtime.sendMessage({ type: 'get_agent_ui_state' }, resolve);
            });

            const state = response?.state;
            if (!state) return;

            this.currentSessionId = state.sessionId || null;
            this.currentStep = Number(state.step || 0);
            this.maxSteps = Number(state.maxSteps || 20);
            this.agentRunning = !!state.running;

            this.agentElements.userGoalInput.value = state.goal || '';

            if (state.running || state.status !== 'idle') {
                this.renderAgentState(state);

                // Rebuild the visible activity history so reopening the popup
                // does not make the agent appear to have started from scratch.
                this.logs = [];
                for (const event of (state.events || [])) {
                    this.applyAgentEvent(event, false);
                }
            } else {
                this.updateUIForAgentEnd();
            }
        } catch (error) {
            // Background state is best-effort; never block the popup.
        }
    }

    renderAgentState(state) {
        this.agentElements.goalText.textContent = state.goal || '';
        this.agentElements.stepNumber.textContent = String(state.step || 0);
        this.agentElements.maxSteps.textContent = String(state.maxSteps || 20);
        this.agentElements.actionText.textContent = state.action || 'Waiting for agent...';
        this.agentElements.reasoningText.textContent =
            state.reasoning || 'Waiting for agent reasoning...';
        this.agentElements.errorCount.textContent = String(state.errors || 0);

        const statusMap = {
            running: ['Running', 'badge badge-running'],
            completed: ['✓ Completed', 'badge badge-completed'],
            stopped: ['⊘ Stopped', 'badge badge-stopped'],
            failed: ['✗ Failed', 'badge badge-failed'],
            idle: ['Idle', 'badge']
        };
        const [label, className] = statusMap[state.status] || statusMap.idle;
        this.agentElements.statusBadge.textContent = label;
        this.agentElements.statusBadge.className = className;

        this.agentElements.userGoalSection.style.display =
            state.running ? 'none' : 'block';
        this.agentElements.agentStatusSection.style.display = 'block';
        this.agentElements.startAgentBtn.disabled = !!state.running;
        this.agentElements.stopAgentBtn.disabled = !state.running;
        this.agentElements.errorInfoItem.style.display =
            Number(state.errors || 0) > 0 ? 'block' : 'none';

        if (state.events?.length) {
            this.agentElements.agentLogContainer.innerHTML = '';
        }
    }

    applyAgentEvent(event, writeLog = true) {
        if (!event) return;

        switch (event.type) {
            case 'agent_started':
                this.currentSessionId = event.session_id || this.currentSessionId;
                this.agentRunning = true;
                this.agentElements.goalText.textContent = event.goal || this.agentElements.goalText.textContent;
                this.agentElements.maxSteps.textContent = String(event.max_steps || this.maxSteps);
                this.agentElements.statusBadge.textContent = 'Running';
                this.agentElements.statusBadge.className = 'badge badge-running';
                break;
            case 'agent_mode_selected':
                break;
            case 'step_started':
                this.currentStep = event.step || this.currentStep;
                this.agentElements.stepNumber.textContent = String(this.currentStep);
                break;
            case 'action_received':
                this.agentElements.actionText.textContent =
                    `${event.action_type || 'Action'}${event.reason ? ': ' + event.reason : ''}`;
                this.agentElements.reasoningText.textContent =
                    event.reasoning_summary || event.reason || 'No reasoning summary provided.';
                break;
            case 'action_executed':
                this.agentElements.actionText.textContent = '✓ Executed';
                break;
            case 'action_failed':
                this.agentElements.actionText.textContent = `✗ Failed: ${event.error_code || 'action error'}`;
                this.agentElements.errorCount.textContent = String(event.error_count || 0);
                this.agentElements.errorInfoItem.style.display = 'block';
                break;
            case 'agent_finished':
                this.agentRunning = false;
                this.agentElements.actionText.textContent = 'Completed';
                this.agentElements.reasoningText.textContent = event.reason || this.agentElements.reasoningText.textContent;
                break;
            case 'agent_stopped':
                this.agentRunning = false;
                this.agentElements.actionText.textContent = 'Stopped';
                break;
            case 'agent_safety_stop':
                this.agentRunning = false;
                this.agentElements.actionText.textContent = 'Stopped for safety';
                this.agentElements.reasoningText.textContent = event.message || this.agentElements.reasoningText.textContent;
                break;
            case 'agent_error_limit':
                this.agentRunning = false;
                this.agentElements.actionText.textContent = 'Error limit reached';
                break;
            case 'agent_ended':
                this.agentRunning = false;
                break;
            case 'loop_error':
                this.agentElements.reasoningText.textContent =
                    event.error_message || this.agentElements.reasoningText.textContent;
                break;
        }

        if (writeLog) {
            if (event.type === 'step_started') {
                this.addLog(`Step ${event.step}: Starting`, 'step', 'agent');
            } else if (event.type === 'action_received') {
                this.addLog(
                    `Action: ${event.action_type}${event.reasoning_summary ? ' — ' + event.reasoning_summary : ''}`,
                    'action',
                    'agent'
                );
            }
        }
    }


    async loadPrivacyDebug() {
        try {
            const data = await chrome.storage.session.get('privacyDebugLastRequest');
            this.renderPrivacyDebug(data.privacyDebugLastRequest || null);
        } catch (error) {
            this.renderPrivacyDebug(null);
        }
    }

    renderPrivacyDebug(record) {
        const status = document.getElementById('privacyDebugStatus');
        const summary = document.getElementById('privacyDebugSummary');
        const json = document.getElementById('privacyDebugJson');
        const image = document.getElementById('privacyDebugImage');
        if (!status || !summary || !json || !image) return;

        if (!record) {
            status.textContent = 'Waiting for an outbound backend request...';
            summary.innerHTML = '';
            json.textContent = 'No request captured yet.';
            image.removeAttribute('src');
            return;
        }

        const observation = record.payload?.observation || {};
        const visual = observation.visual_context || {};
        const redactions = visual.redactionMask?.redactions || [];
        const elements = observation.elements || [];
        const sensitiveElements = elements.filter(item => item.sensitive);
        const screenshot = visual.screenshot?.data || '';
        const redactionMask = visual.redactionMask || {};
        const maskRedactions = redactionMask.redactions || [];

        status.textContent = `Captured ${record.endpoint} at ${new Date(record.timestamp).toLocaleTimeString()}`;
        summary.innerHTML = `
            <div><b>Payload size:</b> ${Number(record.bytes || 0).toLocaleString()} bytes</div>
            <div><b>Elements sent:</b> ${elements.length}</div>
            <div><b>Sensitive DOM elements:</b> ${sensitiveElements.length}</div>
            <div><b>Visual redactions applied:</b> ${redactions.length}</div>
            <div><b>Redaction mask received:</b> ${maskRedactions.length ? 'YES' : 'NO'}</div>
            <div><b>Screenshot included:</b> ${screenshot ? 'YES — redacted image' : 'NO'}</div>
            <div><b>Raw screenshot included:</b> NO</div>
        `;

        if (screenshot) {
            image.src = screenshot;
            image.style.display = 'block';
        } else {
            image.removeAttribute('src');
            image.style.display = 'none';
        }

        json.textContent = JSON.stringify(record.payload, null, 2);
    }

    /**
     * Handle events from the agent loop
     */
    handleAgentEvent(event) {
        this.applyAgentEvent(event, true);

        if (event.type === 'agent_finished' ||
            event.type === 'agent_stopped' ||
            event.type === 'agent_safety_stop' ||
            event.type === 'agent_error_limit' ||
            event.type === 'agent_ended') {
            this.agentRunning = false;
            this.updateUIForAgentEnd();
            this.renderAgentState({
                ...event,
                goal: this.agentElements.goalText.textContent,
                step: this.currentStep,
                maxSteps: this.maxSteps,
                status:
                    event.type === 'agent_finished' ? 'completed' :
                    event.type === 'agent_error_limit' ? 'failed' : 'stopped',
                action: this.agentElements.actionText.textContent,
                reasoning: this.agentElements.reasoningText.textContent,
                errors: Number(this.agentElements.errorCount.textContent || 0)
            });
        } else if (event.type === 'agent_started' || event.type === 'step_started' || event.type === 'action_received') {
            this.agentRunning = true;
            this.agentElements.userGoalSection.style.display = 'none';
            this.agentElements.agentStatusSection.style.display = 'block';
            this.agentElements.stopAgentBtn.disabled = false;
            this.agentElements.startAgentBtn.disabled = true;
        }
    }

    /**
     * Start agent with user goal
     */
    async startAgentSession() {
        const userGoal = this.agentElements.userGoalInput.value.trim();
        
        if (!userGoal) {
            alert('Please enter a goal for the agent');
            return;
        }

        if (this.agentRunning) {
            alert('Agent is already running');
            return;
        }

        try {
            this.addLog(`Starting agent: "${userGoal}"`, 'info', 'agent');

            // Get server URL from config
            const serverUrl = this.legacyElements.serverUrl.value || 'http://localhost:8000';

            // Send message to content script
            const response = await this.sendMessage({
                type: 'start_agent_session',
                goal: userGoal,
                serverUrl: serverUrl
            });

            if (!response || !response.success) {
                throw new Error(response?.error || 'Failed to start session');
            }

            this.currentSessionId = response.session_id;
            this.agentRunning = true;
            this.currentStep = 0;

            await new Promise((resolve) => {
                chrome.storage.session.set({
                    agentUiState: {
                        running: true,
                        sessionId: this.currentSessionId,
                        goal: userGoal,
                        step: 0,
                        maxSteps: this.maxSteps,
                        status: 'running',
                        action: 'Initializing...',
                        reasoning: 'Waiting for agent reasoning...',
                        errors: 0,
                        events: []
                    }
                }, resolve);
            });
            this.agentElements.errorCount.textContent = '0';
            this.agentElements.errorInfoItem.style.display = 'none';

            // Update UI to show agent is running
            this.updateUIForAgentStart();

            this.addLog(`Session created: ${this.currentSessionId}`, 'success', 'agent');

        } catch (error) {
            alert(`Failed to start agent: ${error.message}`);
            this.addLog(`Error: ${error.message}`, 'error', 'agent');
        }
    }

    /**
     * Stop agent session
     */
    async stopAgentSession() {
        if (!this.agentRunning) {
            return;
        }

        try {
            await this.sendMessage({
                type: 'stop_agent_session',
                session_id: this.currentSessionId
            });

            this.agentRunning = false;
            this.updateUIForAgentEnd();
            this.addLog('Agent stopped', 'info', 'agent');

        } catch (error) {
            this.addLog(`Error stopping agent: ${error.message}`, 'error', 'agent');
        }
    }

    /**
     * Update UI when agent starts
     */
    updateUIForAgentStart() {
        this.agentElements.userGoalSection.style.display = 'none';
        this.agentElements.agentStatusSection.style.display = 'block';
        
        this.agentElements.goalText.textContent = this.agentElements.userGoalInput.value;
        this.agentElements.actionText.textContent = 'Initializing...';
        if (this.agentElements.reasoningText) {
            this.agentElements.reasoningText.textContent = 'Waiting for agent reasoning...';
        }
        this.agentElements.statusBadge.textContent = 'Running';
        this.agentElements.statusBadge.className = 'badge badge-running';
        
        this.agentElements.startAgentBtn.disabled = true;
        this.agentElements.stopAgentBtn.disabled = false;

        // Clear agent logs
        this.agentElements.agentLogContainer.innerHTML = '';
        this.logs = [];
    }

    /**
     * Update UI when agent ends
     */
    updateUIForAgentEnd() {
        this.agentElements.userGoalSection.style.display = 'block';
        this.agentElements.agentStatusSection.style.display = 'block';

        this.agentElements.startAgentBtn.disabled = false;
        this.agentElements.stopAgentBtn.disabled = true;

        // Keep the previous goal visible so reopening the popup never looks like
        // a fresh/reset session.
    }

    /**
     * Update step display
     */
    updateStepDisplay() {
        this.agentElements.stepNumber.textContent = this.currentStep.toString();
    }

    /**
     * Send message to content script
     */
    sendMessage(message) {
        return new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
                        resolve(response || {});
                    }).catch(() => {
                        resolve({ success: false, error: 'Content script not ready' });
                    });
                } else {
                    resolve({ success: false, error: 'No active tab' });
                }
            });
        });
    }

    /**
     * Add log entry
     */
    addLog(message, level = 'info', section = 'legacy') {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = { timestamp, message, level, section };
        
        this.logs.push(logEntry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        // Render to appropriate log container
        if (section === 'agent' && this.agentElements.agentLogContainer) {
            this.renderAgentLog();
        } else if (section === 'legacy') {
            this.renderLegacyLog();
        }
    }

    /**
     * Render agent log
     */
    renderAgentLog() {
        const agentLogs = this.logs.filter(l => l.section === 'agent');
        const html = agentLogs.map(log => `
            <div class="log-entry log-${log.level}">
                <span class="log-time">${log.timestamp}</span>
                <span class="log-msg">${this.escapeHtml(log.message)}</span>
            </div>
        `).join('');

        this.agentElements.agentLogContainer.innerHTML = html;
        this.agentElements.agentLogContainer.scrollTop = this.agentElements.agentLogContainer.scrollHeight;
    }

    /**
     * Render legacy log
     */
    renderLegacyLog() {
        const legacyLogs = this.logs.filter(l => l.section === 'legacy');
        const html = legacyLogs.map(log => `
            <div class="log-entry log-${log.level}">
                <span class="log-time">${log.timestamp}</span>
                <span class="log-msg">${this.escapeHtml(log.message)}</span>
            </div>
        `).join('');

        this.legacyElements.logContainer.innerHTML = html;
        this.legacyElements.logContainer.scrollTop = this.legacyElements.logContainer.scrollHeight;
    }

    /**
     * Clear logs
     */
    clearLogs(section = 'all') {
        if (section === 'all') {
            this.logs = [];
        } else {
            this.logs = this.logs.filter(l => l.section !== section);
        }

        this.renderLegacyLog();
        if (this.agentElements.agentLogContainer) {
            this.renderAgentLog();
        }
    }

    /**
     * Load configuration from storage
     */
    loadConfiguration() {
        chrome.storage.sync.get({
            SERVER_URL: 'http://localhost:8000',
            ENABLE_REDACTION: true,
            REDACTION_MODE: 'blur'
        }, (items) => {
            this.legacyElements.serverUrl.value = items.SERVER_URL;
            this.legacyElements.enableRedaction.checked = items.ENABLE_REDACTION;
            this.legacyElements.redactionMode.value = items.REDACTION_MODE;
            this.addLog('Configuration loaded', 'info', 'legacy');
        });
    }

    /**
     * Save configuration
     */
    saveConfiguration() {
        const config = {
            SERVER_URL: this.legacyElements.serverUrl.value,
            ENABLE_REDACTION: this.legacyElements.enableRedaction.checked,
            REDACTION_MODE: this.legacyElements.redactionMode.value
        };

        chrome.storage.sync.set(config, () => {
            this.addLog('Configuration saved', 'success', 'legacy');
            alert('Settings saved successfully');
        });
    }

    /**
     * Start monitoring (legacy)
     */
    async startMonitoring() {
        this.addLog('Starting monitoring...', 'info', 'legacy');
        const response = await this.sendMessage({
            type: 'start_monitoring'
        });
        
        if (response && response.success) {
            this.legacyElements.startBtn.disabled = true;
            this.legacyElements.stopBtn.disabled = false;
            this.legacyElements.statusLabel.textContent = 'Active';
            this.legacyElements.statusLabel.className = 'status-active';
            this.addLog('Monitoring started', 'success', 'legacy');
        } else {
            this.addLog('Failed to start monitoring', 'error', 'legacy');
        }
    }

    /**
     * Stop monitoring (legacy)
     */
    async stopMonitoring() {
        this.addLog('Stopping monitoring...', 'info', 'legacy');
        const response = await this.sendMessage({
            type: 'stop_monitoring'
        });

        if (response && response.success) {
            this.legacyElements.startBtn.disabled = false;
            this.legacyElements.stopBtn.disabled = true;
            this.legacyElements.statusLabel.textContent = 'Inactive';
            this.legacyElements.statusLabel.className = 'status-inactive';
            this.addLog('Monitoring stopped', 'success', 'legacy');
        } else {
            this.addLog('Failed to stop monitoring', 'error', 'legacy');
        }
    }

    /**
     * Process now (legacy)
     */
    async processNow() {
        this.addLog('Processing screen...', 'info', 'legacy');
        const response = await this.sendMessage({
            type: 'process_now'
        });

        if (response && response.success) {
            this.addLog(`Processed: ${response.description}`, 'success', 'legacy');
        } else {
            this.addLog('Processing failed', 'error', 'legacy');
        }
    }

    /**
     * Open settings (placeholder)
     */
    openSettings() {
        alert('Advanced settings coming soon');
    }

    /**
     * Open help (placeholder)
     */
    openHelp() {
        alert('Help documentation: See PRODUCTION_UPGRADE.md');
    }

    /**
     * HTML escape for log display
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize when popup loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new PopupController();
    });
} else {
    new PopupController();
}