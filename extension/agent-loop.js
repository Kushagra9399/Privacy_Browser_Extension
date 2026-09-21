/**
 * Agent Loop - High-level orchestration of agentic browser automation
 * 
 * This is the main execution loop that:
 * 1. Listens for user goals from popup
 * 2. Chooses local execution for simple goals or server reasoning for complex goals
 * 3. Repeatedly: observe/reason → execute → repeat
 * 4. Reports progress to popup
 * 5. Handles errors and termination
 */

class AgentLoopOrchestrator {
    constructor(sessionManager, commandExecutor) {
        this.sessionManager = sessionManager;
        this.commandExecutor = commandExecutor;
        this.isRunning = false;
        this.currentSessionId = null;
        this.stepCount = 0;
        this.maxSteps = 20;
        this.perf = new PerformanceMonitor();
        this.errorCount = 0;
        this.lastActionSignature = null;
        this.repeatedActionCount = 0;
        this.lastObservationSignature = null;
        this.noProgressCount = 0;
        
        Logger.log('LOOP', 'AgentLoopOrchestrator initialized');
    }
    
    /**
     * Start agent with user goal
     */
    async start(userGoal, serverUrl = 'http://localhost:8000') {
        if (this.isRunning) {
            Logger.warn('LOOP', 'Agent already running');
            return false;
        }
        
        try {
            Logger.log('LOOP', `Starting agent with goal: ${userGoal}`);
            
            // Configure session manager
            this.sessionManager.serverUrl = serverUrl;
            
            // Route simple tasks locally and reserve the backend for complex reasoning.
            const isComplex = this.isComplexGoal(userGoal);
            const sessionId = isComplex
                ? await this.sessionManager.startServerSession(userGoal)
                : await this.sessionManager.startLocalSession(userGoal);

            this.commandExecutor.elementRegistry = this.sessionManager.elementRegistry;
            this.currentSessionId = sessionId;
            this.stepCount = 0;
            this.errorCount = 0;
            this.lastActionSignature = null;
            this.repeatedActionCount = 0;
            this.lastObservationSignature = null;
            this.noProgressCount = 0;
            this.isRunning = true;
            
            Logger.log('LOOP', `Session created: ${sessionId}`);
            Logger.log('LOOP', `Execution mode: ${isComplex ? 'server' : 'local'}`);
            
            this.notifyPopup({
                type: 'agent_started',
                session_id: this.currentSessionId,
                goal: userGoal,
                max_steps: this.maxSteps
            });

            this.notifyPopup({
                type: 'agent_mode_selected',
                mode: isComplex ? 'server' : 'local'
            });
            
            // Start main loop
            this.agentLoop();
            
            return true;
        } catch (error) {
            Logger.error('LOOP', 'Failed to start agent', error);
            this.isRunning = false;
            return false;
        }
    }

    /**
     * Decide whether a goal needs server-side reasoning.
     *
     * This is intentionally conservative: ordinary browser interactions stay local,
     * while comparison, recommendation, summarization and multi-step reasoning are
     * escalated to the backend.
     */
    isComplexGoal(userGoal) {
        const goal = String(userGoal || '').trim().toLowerCase();
        if (!goal) return false;

        // The privacy architecture keeps perception local but delegates task
        // reasoning to the backend. Therefore normal user goals are server
        // reasoning tasks unless the goal is explicitly a local control action.
        const localOnlyPatterns = [
            /^(stop|pause|resume)\s+(processing|agent)$/,
            /^(get|show)\s+(status|agent status)$/
        ];

        if (localOnlyPatterns.some(pattern => pattern.test(goal))) {
            return false;
        }

        return true;
    }

    /**
     * Main agent loop
     * Runs until the goal is achieved, a safety limit is reached, or repeated
     * actions/no-progress indicate that continuing would waste resources.
     */
    async agentLoop() {
        Logger.log('LOOP', 'Entering agent loop');
        
        while (this.isRunning && this.errorCount < 3) {
            try {
                if (this.stepCount >= this.maxSteps) {
                    Logger.warn('LOOP', `Maximum step limit reached: ${this.maxSteps}`);
                    this.notifyPopup({
                        type: 'agent_step_limit',
                        message: `Agent stopped after ${this.maxSteps} steps`
                    });
                    this.isRunning = false;
                    break;
                }

                this.stepCount++;
                Logger.log('LOOP', `=== STEP ${this.stepCount} ===`);
                
                // Notify popup of progress
                this.notifyPopup({
                    type: 'step_started',
                    step: this.stepCount,
                    max_steps: this.maxSteps
                });
                
                // Step 1: Observe current page state and obtain next action
                Logger.log('LOOP', 'Step 1: Observing page...');
                const observationBefore = this.getProgressSignature();
                const action = await this.perf.measureAsync('AGENT_STEP', async () => {
                    if (this.sessionManager.sessionMode === 'local') {
                        return this.getLocalAction();
                    }
                    return await this.sessionManager.observe();
                });
                
                if (!action) {
                    Logger.warn('LOOP', 'Observe returned no action');
                    this.errorCount++;
                    if (this.errorCount >= 3) {
                        this.stopForSafety('No action was produced repeatedly');
                        break;
                    }
                    await this.delay(500);
                    continue;
                }

                const actionGuard = this.checkActionRepetition(action);
                if (!actionGuard.allowed) {
                    this.stopForSafety(actionGuard.reason);
                    break;
                }
                
                Logger.log('LOOP', `Step 2: Received action: ${action.type}`);
                this.notifyPopup({
                    type: 'action_received',
                    action_type: action.type,
                    reason: action.reason || '',
                    reasoning_summary: action.reasoning_summary || ''
                });
                
                // Check for completion
                if (String(action.type).toLowerCase() === 'finish') {
                    Logger.log('LOOP', `Agent finished: ${action.reason}`);
                    this.notifyPopup({
                        type: 'agent_finished',
                        reason: action.reason
                    });
                    this.isRunning = false;
                    break;
                }
                
                // Step 3: Execute action on page
                Logger.log('LOOP', `Step 3: Executing action...`);
                const result = await this.executeActionSafely(action);
                
                if (!result.success || result.result?.blocked) {
                    const errorCode = result.errorCode || result.result?.errorCode || 'blocked_action';
                    const errorMessage = result.errorMessage || result.result?.reason || 'Action was blocked';
                    Logger.error('LOOP', `Action failed: ${errorCode}`);
                    this.errorCount++;
                    
                    this.notifyPopup({
                        type: 'action_failed',
                        error_code: errorCode,
                        error_message: errorMessage,
                        error_count: this.errorCount
                    });
                    
                    // Only server sessions report results to the backend.
                    if (this.sessionManager.sessionMode === 'server') {
                        await this.sessionManager.reportActionResult(
                            action,
                            false,
                            errorCode,
                            errorMessage
                        );
                    }
                    
                    // A blocked action is especially likely to repeat forever.
                    if (result.result?.blocked || this.errorCount >= 3) {
                        this.stopForSafety(`Action blocked or repeated: ${errorMessage}`);
                        break;
                    }
                    
                    continue;
                }
                
                // Reset error count on successful action
                this.errorCount = 0;
                
                Logger.log('LOOP', 'Action executed successfully');
                this.notifyPopup({
                    type: 'action_executed',
                    duration_ms: result.duration_ms
                });
                
                // Step 4: Report result only when backend reasoning is being used.
                if (this.sessionManager.sessionMode === 'server') {
                    Logger.log('LOOP', 'Step 4: Reporting result to server...');
                    await this.sessionManager.reportActionResult(
                        action,
                        true,
                        null,
                        null
                    );
                } else {
                    Logger.log('LOOP', 'Step 4: Local action complete; no server request');
                }

                // Detect validation errors such as invalid email/password fields
                // after a form interaction. This prevents blind retry loops.
                const validationError = this.detectPageValidationError();
                if (validationError) {
                    this.stopForSafety(`Page validation error: ${validationError}`);
                    break;
                }

                // Detect whether the action actually changed the observable page state.
                const observationAfter = this.getProgressSignature();
                if (observationBefore && observationAfter && observationBefore === observationAfter) {
                    this.noProgressCount++;
                } else {
                    this.noProgressCount = 0;
                }

                if (this.noProgressCount >= 3) {
                    this.stopForSafety('No observable page progress after repeated actions');
                    break;
                }
                
                // Small delay before next step
                await this.delay(300);
                
            } catch (error) {
                Logger.error('LOOP', 'Loop error', error);
                this.errorCount++;
                
                this.notifyPopup({
                    type: 'loop_error',
                    error_message: error.message
                });

                if (!this.sessionManager.isRunning) {
                    this.stopForSafety(`Session became inactive: ${error.message}`);
                    break;
                }

                if (this.errorCount >= 3) {
                    this.stopForSafety(`Repeated loop errors: ${error.message}`);
                    break;
                }
                
                await this.delay(1000);
            }
        }
        
        Logger.log('LOOP', 'Agent loop ended');
        this.isRunning = false;
        
        this.notifyPopup({
            type: 'agent_ended',
            steps_taken: this.stepCount,
            errors: this.errorCount
        });
    }

    /**
     * Create a small, local-only signature of the current browser state.
     * It deliberately excludes field values and other sensitive page content.
     */
    getProgressSignature() {
        try {
            const active = document.activeElement;
            const focused = active ? `${active.tagName}:${active.id || active.getAttribute('name') || ''}` : '';
            const visibleInteractive = Array.from(document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="link"]'))
                .filter(element => {
                    const style = window.getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                })
                .slice(0, 80)
                .map(element => `${element.tagName}:${element.id || ''}:${element.getAttribute('aria-label') || element.textContent?.trim().substring(0, 40) || ''}`)
                .join('|');
            return `${location.pathname}|${window.scrollX}|${window.scrollY}|${focused}|${visibleInteractive}`;
        } catch (error) {
            Logger.debug('LOOP', 'Could not create progress signature', error?.message);
            return '';
        }
    }

    /**
     * Prevent the same action from being executed repeatedly on the same target.
     */
    checkActionRepetition(action) {
        const signature = JSON.stringify({
            type: String(action.type || '').toLowerCase(),
            element_id: action.element_id || null,
            target: action.target || null,
            selector: action.selector || null,
            direction: action.direction || null,
            key: action.key || null,
            textLength: typeof action.text === 'string' ? action.text.length : null
        });

        if (signature === this.lastActionSignature) {
            this.repeatedActionCount++;
        } else {
            this.lastActionSignature = signature;
            this.repeatedActionCount = 1;
        }

        if (this.repeatedActionCount >= 3) {
            return {
                allowed: false,
                reason: `Same action repeated ${this.repeatedActionCount} times without a new plan`
            };
        }

        return { allowed: true };
    }

    /**
     * Detect common browser-native and application validation errors locally.
     * No field values are sent anywhere.
     */
    detectPageValidationError() {
        const selectors = [
            ':invalid',
            '[aria-invalid="true"]',
            '.error',
            '.errors',
            '.error-message',
            '.field-error',
            '.validation-error',
            '[role="alert"]'
        ];

        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
                    continue;
                }

                const text = String(element.textContent || element.getAttribute('aria-label') || '').trim();
                if (text) {
                    return text.substring(0, 160);
                }

                if (element.matches(':invalid')) {
                    return 'A form field is invalid';
                }
            }
        }

        return null;
    }

    /**
     * Stop immediately when continuing would waste resources or repeat an unsafe action.
     */
    stopForSafety(reason) {
        Logger.warn('LOOP', `Stopping agent for safety: ${reason}`);
        this.notifyPopup({
            type: 'agent_safety_stop',
            message: reason
        });
        this.isRunning = false;
    }

    /**
     * Generate a simple browser action locally from the current DOM.
     * This is deliberately lightweight and does not send page data to a server.
     */
    getLocalAction() {
        const goal = String(this.sessionManager.currentGoal || '').trim().toLowerCase();
        const observation = this.sessionManager.buildObservation();
        const elements = observation.elements || [];

        // Scroll requests can be handled without any DOM reasoning.
        if (/\b(scroll|go)\b.*\bdown\b/.test(goal)) {
            return {
                type: 'scroll',
                direction: 'down',
                amount: 500,
                reason: 'Simple scroll request handled locally'
            };
        }

        if (/\b(scroll|go)\b.*\bup\b/.test(goal)) {
            return {
                type: 'scroll',
                direction: 'up',
                amount: 500,
                reason: 'Simple scroll request handled locally'
            };
        }

        // Extract the target phrase for click/focus goals.
        const targetMatch = goal.match(/\b(?:click|press|open|focus)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+button)?$/i);
        if (targetMatch) {
            const target = targetMatch[1]
                .replace(/\s+button$/i, '')
                .trim();
            const targetElement = this.findLocalElement(elements, target);

            if (targetElement) {
                return {
                    type: /\bfocus\b/i.test(goal) ? 'focus' : 'click',
                    element_id: targetElement.agent_element_id,
                    reason: 'Simple DOM interaction handled locally'
                };
            }

            return {
                type: 'finish',
                reason: `Could not find a visible element matching "${target}" locally`
            };
        }

        // Search goals: type the requested query into a visible search-like input.
        const searchMatch = goal.match(/\bsearch\s+(?:for\s+|the\s+)?["']?(.+?)["']?$/i);
        if (searchMatch) {
            const query = searchMatch[1].trim();
            const searchElement = elements.find(element => {
                const haystack = [
                    element.element_type,
                    element.placeholder,
                    element.aria_label,
                    element.text_preview
                ].filter(Boolean).join(' ').toLowerCase();
                return element.visible && !element.sensitive &&
                    /search|query|keyword/.test(haystack) &&
                    ['input', 'textarea'].includes(String(element.tag || '').toLowerCase());
            });

            if (searchElement) {
                return {
                    type: 'type',
                    element_id: searchElement.agent_element_id,
                    text: query,
                    reason: 'Simple search request handled locally'
                };
            }

            return {
                type: 'finish',
                reason: 'No visible non-sensitive search input found locally'
            };
        }

        // If no safe local rule matches, stop instead of guessing or contacting the backend.
        return {
            type: 'finish',
            reason: 'Goal requires reasoning beyond the local simple-task rules'
        };
    }

    /**
     * Find the best matching visible, non-sensitive DOM element.
     */
    findLocalElement(elements, target) {
        const normalizedTarget = String(target || '').trim().toLowerCase();
        if (!normalizedTarget) return null;

        const candidates = elements.filter(element =>
            element.visible &&
            element.enabled &&
            !element.sensitive
        );

        const exact = candidates.find(element => {
            const values = [element.text_preview, element.aria_label, element.placeholder]
                .filter(Boolean)
                .map(value => String(value).trim().toLowerCase());
            return values.some(value => value === normalizedTarget);
        });
        if (exact) return exact;

        return candidates.find(element => {
            const values = [element.text_preview, element.aria_label, element.placeholder]
                .filter(Boolean)
                .map(value => String(value).toLowerCase());
            return values.some(value => value.includes(normalizedTarget));
        }) || null;
    }
    
    /**
     * Execute action with error handling and validation
     */
    async executeActionSafely(action) {
        const startTime = performance.now();
        
        try {
            // Validate action before execution
            if (!action.type) {
                return {
                    success: false,
                    errorCode: 'invalid_action',
                    errorMessage: 'Action type is missing'
                };
            }
            
            // Execute via command executor
            const result = await this.commandExecutor.executeAgentAction(action);
            
            const duration = performance.now() - startTime;
            
            if (!result) {
                return {
                    success: false,
                    errorCode: 'execution_error',
                    errorMessage: 'Command executor returned null',
                    duration_ms: Math.round(duration)
                };
            }
            
            return {
                ...result,
                duration_ms: Math.round(duration)
            };
            
        } catch (error) {
            const duration = performance.now() - startTime;
            
            Logger.error('LOOP', 'Action execution error', error);
            
            return {
                success: false,
                errorCode: 'execution_error',
                errorMessage: error.message,
                duration_ms: Math.round(duration)
            };
        }
    }
    
    /**
     * Stop agent gracefully
     */
    async stop() {
        Logger.log('LOOP', 'Stopping agent...');
        this.isRunning = false;
        
        if (this.currentSessionId) {
            await this.sessionManager.stopSession();
        }
        
        this.notifyPopup({
            type: 'agent_stopped'
        });
    }
    
    /**
     * Notify popup of agent status/events
     */
    notifyPopup(event) {
        try {
            chrome.runtime.sendMessage({
                ...event,
                type: 'agent_event',
                event_type: event.type
            }).catch((err) => {
                // Popup might not be open, that's OK
                Logger.debug('LOOP', 'Popup message failed', err?.message);
            });
        } catch (error) {
            // Ignore if popup is closed
        }
    }
    
    /**
     * Utility: sleep
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Get current status
     */
    getStatus() {
        return {
            running: this.isRunning,
            session_id: this.currentSessionId,
            step: this.stepCount,
            max_steps: this.maxSteps,
            errors: this.errorCount,
            repeated_action_count: this.repeatedActionCount,
            no_progress_count: this.noProgressCount
        };
    }
}

/**
 * Global agent loop instance
 */
let globalAgentLoop = null;

/**
 * Initialize agent loop and attach to global scope
 */
function initializeAgentLoop() {
    if (!globalAgentLoop && typeof ClientSessionManager !== 'undefined' && typeof CommandExecutor !== 'undefined') {
        const sessionMgr = new ClientSessionManager();
        const cmdExecutor = new CommandExecutor();

        // Reuse the already initialized VisionProcessor so agent observations
        // pass through the same local privacy boundary before network access.
        if (typeof agent !== 'undefined' && agent?.visionProcessor) {
            sessionMgr.visionProcessor = agent.visionProcessor;
        }
        globalAgentLoop = new AgentLoopOrchestrator(sessionMgr, cmdExecutor);
        
        Logger.log('LOOP', 'Global agent loop initialized');
        
        // Make available globally
        window.agentLoop = globalAgentLoop;
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeAgentLoop);
} else {
    initializeAgentLoop();
}
