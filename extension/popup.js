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
        switch (event.type) {
            case 'step_started':
                this.currentStep = event.step;
                this.updateStepDisplay();
                this.addLog(`Step ${event.step}: Starting`, 'step', 'agent');
                break;

            case 'action_received':
                this.agentElements.actionText.textContent =
                    `${event.action_type}${event.reason ? ': ' + event.reason : ''}`;
                if (this.agentElements.reasoningText) {
                    this.agentElements.reasoningText.textContent =
                        event.reasoning_summary || event.reason || 'No reasoning summary provided.';
                }
                this.addLog(
                    `Action: ${event.action_type}${event.reasoning_summary ? ' — ' + event.reasoning_summary : ''}`,
                    'action',
                    'agent'
                );
                break;

            case 'action_executed':
                this.agentElements.actionText.textContent = '✓ Executed';
                this.addLog(`Action executed (${event.duration_ms}ms)`, 'success', 'agent');
                break;

            case 'action_failed':
                this.agentElements.actionText.textContent = `✗ Failed: ${event.error_code}`;
                this.agentElements.errorInfoItem.style.display = 'block';
                this.agentElements.errorCount.textContent = event.error_count;
                this.addLog(`Action failed: ${event.error_code}`, 'error', 'agent');
                break;

            case 'agent_finished':
                this.agentRunning = false;
                this.updateUIForAgentEnd();
                this.agentElements.statusBadge.textContent = '✓ Completed';
                this.agentElements.statusBadge.className = 'badge badge-completed';
                this.addLog(`Agent finished: ${event.reason}`, 'success', 'agent');
                break;

            case 'agent_error_limit':
                this.agentRunning = false;
                this.updateUIForAgentEnd();
                this.agentElements.statusBadge.textContent = '✗ Error limit';
                this.agentElements.statusBadge.className = 'badge badge-failed';
                this.addLog(`Agent stopped: ${event.message}`, 'error', 'agent');
                break;

            case 'agent_stopped':
                this.agentRunning = false;
                this.updateUIForAgentEnd();
                this.agentElements.statusBadge.textContent = '⊘ Stopped';
                this.agentElements.statusBadge.className = 'badge badge-stopped';
                this.addLog('Agent stopped by user', 'info', 'agent');
                break;

            case 'agent_ended':
                this.addLog(
                    `Agent session ended (${event.steps_taken} steps, ${event.errors} errors)`,
                    'info',
                    'agent'
                );
                break;

            case 'loop_error':
                this.addLog(`Error: ${event.error_message}`, 'error', 'agent');
                break;
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
        this.agentElements.agentStatusSection.style.display = 'none';
        
        this.agentElements.startAgentBtn.disabled = false;
        this.agentElements.stopAgentBtn.disabled = true;

        // User can start another goal
        this.agentElements.userGoalInput.focus();
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