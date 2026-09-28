/**
 * Privacy Browser Agent - Content Script
 * Main orchestration of client-side vision processing and privacy protection
 */

class PrivacyBrowserAgent {
    constructor() {
        this.visionProcessor = new VisionProcessor();
        this.privacyFilter = new PrivacyFilter();
        this.commandExecutor = new CommandExecutor();
        this.serverComm = null;
        this.config = null;

        this.isActive = false;
        this.processingInterval = null;
        this.lastProcessingTime = 0;
        this.perf = new PerformanceMonitor();

        Logger.log(
            'AGENT',
            'Privacy Browser Agent content script initialized'
        );
    }

    /**
     * Initialize the agent
     */
    async initialize() {
        try {
            Logger.log(
                'AGENT',
                'Initializing Privacy Browser Agent...'
            );

            // Load configuration
            this.config = await Config.load();
            console.log(
                'LOADED CONFIG:',
                JSON.stringify(this.config, null, 2)
            );

            Logger.log(
                'AGENT',
                'Configuration loaded',
                this.config
            );

            // Initialize server communication
            this.serverComm = new ServerComm(
                this.config.SERVER_URL || 'http://localhost:8000'
            );

            // Initialize vision processor
            const visionReady =
                await this.visionProcessor.initialize();

            // The agent loop is initialized before this content agent. Attach the
            // already initialized VisionProcessor so every observation uses the
            // same local privacy boundary.
            if (window.agentLoop?.sessionManager) {
                window.agentLoop.sessionManager.visionProcessor =
                    this.visionProcessor;
                Logger.log(
                    'AGENT',
                    'Agent loop connected to local vision processor'
                );
            }

            if (
                !visionReady &&
                this.config.ENABLE_LOCAL_VISION
            ) {
                Logger.warn(
                    'AGENT',
                    'Vision processor initialization failed, continuing without local vision'
                );
            }

            // Set up message listeners
            this.setupMessageListeners();

            // Set up page mutation observer
            this.setupMutationObserver();

            // Notify background script that content script is ready
            chrome.runtime
                .sendMessage({
                    type: 'content_ready',
                    url: window.location.href
                })
                .catch((err) => {
                    Logger.warn(
                        'AGENT',
                        'Failed to send ready message',
                        err
                    );
                });

            Logger.log(
                'AGENT',
                'Initialization complete'
            );

            return true;

        } catch (error) {
            Logger.error(
                'AGENT',
                'Initialization failed',
                error
            );

            return false;
        }
    }

    /**
     * Start continuous screen processing
     */
    startProcessing() {
        if (this.isActive) {
            Logger.warn(
                'AGENT',
                'Processing already active'
            );
            return;
        }

        if (!this.config) {
            Logger.error(
                'AGENT',
                'Cannot start processing: configuration is not loaded'
            );
            return;
        }

        const processingInterval =
            this.config?.PERFORMANCE?.processingInterval || 5000;

        Logger.log(
            'AGENT',
            `Starting continuous screen processing with interval: ${processingInterval}ms`
        );

        this.isActive = true;

        this.processingInterval = setInterval(() => {
            this.processScreenCycle();
        }, processingInterval);

        // Process immediately
        this.processScreenCycle();
    }
    /**
     * Stop continuous screen processing
     */
    stopProcessing() {
        if (!this.isActive) {
            return;
        }

        Logger.log(
            'AGENT',
            'Stopping screen processing'
        );

        this.isActive = false;

        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }
    }

    /**
     * Single screen processing cycle
     */
    async processScreenCycle() {

        // --------------------------------------------------
        // Make sure configuration is available
        // --------------------------------------------------

        if (!this.config) {
            Logger.error(
                'AGENT',
                'Cannot process screen: configuration is not loaded'
            );

            return;
        }

        const processingInterval =
            this.config?.PERFORMANCE?.processingInterval || 5000;

        // --------------------------------------------------
        // Prevent concurrent processing
        // --------------------------------------------------

        if (
            performance.now() - this.lastProcessingTime <
            processingInterval
        ) {
            return;
        }

        this.lastProcessingTime = performance.now();

        try {

            await this.perf.measureAsync(
                'CYCLE',
                async () => {

                // Rest of your existing code...
                    // --------------------------------------------------
                    // STEP 1: Capture and process screen
                    // --------------------------------------------------

                    Logger.log(
                        'AGENT',
                        'Processing screen...'
                    );

                    const processResult =
                        await this.visionProcessor.processScreen();

                    if (!processResult) {

                        Logger.warn(
                            'AGENT',
                            'Screen processing returned null'
                        );

                        return;
                    }

                    // --------------------------------------------------
                    // STEP 2: Send to server if configured
                    // --------------------------------------------------

                    if (this.config.SERVER_URL) {

                        try {

                            const sessionInfo =
                                this.visionProcessor.getSessionInfo();

                            const serverResponse =
                                await this.serverComm.sendRequest(
                                    '/api/process-screen',
                                    {
                                        screenshot:
                                            processResult.screenshot,

                                        pageStructure:
                                            processResult.pageStructure,

                                        redactionMask:
                                            processResult.redactionMask,

                                        sessionId:
                                            sessionInfo.sessionId
                                    },
                                    this.config.TIMEOUT.serverRequest
                                );

                            // --------------------------------------------------
                            // STEP 3: Execute commands from server
                            // --------------------------------------------------

                            if (
                                serverResponse &&
                                Array.isArray(
                                    serverResponse.commands
                                ) &&
                                serverResponse.commands.length > 0
                            ) {

                                Logger.log(
                                    'AGENT',
                                    `Received ${serverResponse.commands.length} commands from server`
                                );

                                await this.executeServerCommands(
                                    serverResponse.commands
                                );
                            }

                            // --------------------------------------------------
                            // STEP 4: Notify popup/background
                            // --------------------------------------------------

                            chrome.runtime
                                .sendMessage({
                                    type: 'processing_result',

                                    data: {
                                        success: true,

                                        commandsExecuted:
                                            serverResponse &&
                                            Array.isArray(
                                                serverResponse.commands
                                            )
                                                ? serverResponse.commands.length
                                                : 0,

                                        redactionStats:
                                            processResult
                                                .redactionMask
                                                ?.stats || {}
                                    }
                                })
                                .catch((err) => {

                                    Logger.warn(
                                        'AGENT',
                                        'Failed to send result message',
                                        err
                                    );

                                });

                        } catch (serverError) {

                            Logger.error(
                                'AGENT',
                                'Server communication error',
                                serverError
                            );

                            // Notify background/popup that server processing failed
                            chrome.runtime
                                .sendMessage({
                                    type: 'processing_result',

                                    data: {
                                        success: false,
                                        error:
                                            serverError?.message ||
                                            'Server communication failed'
                                    }
                                })
                                .catch((err) => {

                                    Logger.warn(
                                        'AGENT',
                                        'Failed to send server error message',
                                        err
                                    );

                                });
                        }

                    } else {

                        Logger.warn(
                            'AGENT',
                            'SERVER_URL is not configured'
                        );

                        chrome.runtime
                            .sendMessage({
                                type: 'processing_result',

                                data: {
                                    success: false,
                                    error:
                                        'Server URL is not configured'
                                }
                            })
                            .catch((err) => {

                                Logger.warn(
                                    'AGENT',
                                    'Failed to send configuration error message',
                                    err
                                );

                            });
                    }
                }
            );

        } catch (error) {

            Logger.error(
                'AGENT',
                'Processing cycle error',
                error
            );

            // Notify background/popup of processing failure
            chrome.runtime
                .sendMessage({
                    type: 'processing_result',

                    data: {
                        success: false,
                        error:
                            error?.message ||
                            'Screen processing failed'
                    }
                })
                .catch((err) => {

                    Logger.warn(
                        'AGENT',
                        'Failed to send processing error message',
                        err
                    );

                });
        }
    }

    /**
     * Execute commands from server
     */
    async executeServerCommands(commands) {

        if (!Array.isArray(commands)) {
            return;
        }

        for (const command of commands) {

            try {

                const result =
                    await this.commandExecutor.execute(
                        command
                    );

                Logger.log(
                    'AGENT',
                    `Command executed: ${command.type}`,
                    result
                );

                // Small delay between commands
                await new Promise((resolve) => {
                    setTimeout(resolve, 500);
                });

            } catch (error) {

                Logger.error(
                    'AGENT',
                    `Failed to execute command: ${command.type}`,
                    error
                );
            }
        }
    }

    /**
     * Set up message listeners for communication
     *
     * IMPORTANT:
     * We use ONE message listener for the content script.
     */
    setupMessageListeners() {

        chrome.runtime.onMessage.addListener(
            (request, sender, sendResponse) => {

                try {

                    switch (request.type) {

                        // ==================================================
                        // START PROCESSING
                        // ==================================================

                        case 'start_processing':

                            (async () => {

                                try {

                                    const initializedAgent =
                                        await initializeAgent();

                                    if (!initializedAgent) {

                                        sendResponse({
                                            success: false,
                                            error: 'Agent initialization failed'
                                        });

                                        return;
                                    }

                                    initializedAgent.startProcessing();

                                    sendResponse({
                                        success: true,
                                        message: 'Processing started'
                                    });

                                } catch (error) {

                                    Logger.error(
                                        'AGENT',
                                        'start_processing failed',
                                        error
                                    );

                                    sendResponse({
                                        success: false,
                                        error:
                                            error?.message ||
                                            'Failed to start processing'
                                    });
                                }

                            })();

                            return true;

                        case 'start_agent_session':
                            (async () => {
                                try {
                                    const initializedAgent = await initializeAgent();
                                    if (!initializedAgent || !globalAgentLoop) {
                                        sendResponse({ success: false, error: 'Agent loop is not available' });
                                        return;
                                    }
                                    const started = await globalAgentLoop.start(
                                        request.goal,
                                        request.serverUrl || this.config?.SERVER_URL || 'http://localhost:8000'
                                    );
                                    sendResponse({
                                        success: started,
                                        session_id: globalAgentLoop.currentSessionId,
                                        error: started ? undefined : 'Failed to start agent session'
                                    });
                                } catch (error) {
                                    sendResponse({ success: false, error: error.message });
                                }
                            })();
                            return true;

                        case 'stop_agent_session':
                            (async () => {
                                try {
                                    if (globalAgentLoop) await globalAgentLoop.stop();
                                    sendResponse({ success: true });
                                } catch (error) {
                                    sendResponse({ success: false, error: error.message });
                                }
                            })();
                            return true;
                        // ==================================================
                        // STOP PROCESSING
                        // ==================================================

                        case 'stop_processing':

                            this.stopProcessing();

                            sendResponse({
                                success: true,
                                message: 'Processing stopped'
                            });

                            // Synchronous response
                            return false;


                        // ==================================================
                        // PROCESS NOW
                        // ==================================================

                        case 'process_now':
                            (async () => {

                                try {

                                    const initializedAgent =
                                        await initializeAgent();

                                    if (!initializedAgent) {

                                        sendResponse({
                                            success: false,
                                            error: 'Agent initialization failed'
                                        });

                                        return;
                                    }

                                    await initializedAgent.processScreenCycle();

                                    sendResponse({
                                        success: true,
                                        message: 'Processing cycle completed'
                                    });

                                } catch (error) {

                                    Logger.error(
                                        'AGENT',
                                        'process_now failed',
                                        error
                                    );

                                    sendResponse({
                                        success: false,
                                        error:
                                            error?.message ||
                                            'Processing cycle failed'
                                    });
                                }

                            })();

                            return true;
                        // ==================================================
                        // EXECUTE COMMAND
                        // ==================================================

                        case 'execute_command':

                            this.commandExecutor
                                .execute(request.command)

                                .then((result) => {

                                    sendResponse({
                                        success: true,
                                        result: result
                                    });

                                })

                                .catch((error) => {

                                    Logger.error(
                                        'AGENT',
                                        'Command execution failed',
                                        error
                                    );

                                    sendResponse({
                                        success: false,
                                        error:
                                            error?.message ||
                                            'Command execution failed'
                                    });

                                });

                            // Async response
                            return true;


                        // ==================================================
                        // GET PAGE STRUCTURE
                        // ==================================================

                        case 'get_page_structure':

                            Promise.resolve(
                                extractPageStructure()
                            )

                                .then((structure) => {

                                    sendResponse({
                                        success: true,
                                        structure: structure
                                    });

                                })

                                .catch((error) => {

                                    Logger.error(
                                        'AGENT',
                                        'Page structure extraction failed',
                                        error
                                    );

                                    sendResponse({
                                        success: false,
                                        error:
                                            error?.message ||
                                            'Page structure extraction failed'
                                    });

                                });

                            // Async response
                            return true;


                        // ==================================================
                        // ANALYZE PAGE
                        // ==================================================

                        case 'ANALYZE_PAGE':

                            try {

                                const result =
                                    analyzePage();

                                sendResponse(result);

                            } catch (error) {

                                Logger.error(
                                    'AGENT',
                                    'Page analysis failed',
                                    error
                                );

                                sendResponse({
                                    success: false,
                                    error:
                                        error?.message ||
                                        'Page analysis failed'
                                });
                            }

                            // Synchronous response
                            return false;


                        // ==================================================
                        // GET STATUS
                        // ==================================================

                        case 'get_status':

                            sendResponse({
                                success: true,

                                isActive:
                                    this.isActive,

                                sessionId:
                                    this.visionProcessor
                                        .getSessionInfo()
                                        .sessionId,

                                privacyStats:
                                    this.privacyFilter.getStats()
                            });

                            // Synchronous response
                            return false;


                        // ==================================================
                        // UPDATE CONFIG
                        // ==================================================

                        case 'update_config':

                            Config.save(request.config)

                                .then(() => {

                                    this.config =
                                        request.config;

                                    this.serverComm =
                                        new ServerComm(
                                            this.config.SERVER_URL || 'http://localhost:8000'
                                        );

                                    sendResponse({
                                        success: true,
                                        message:
                                            'Configuration updated'
                                    });

                                })

                                .catch((error) => {

                                    Logger.error(
                                        'AGENT',
                                        'Config update failed',
                                        error
                                    );

                                    sendResponse({
                                        success: false,
                                        error:
                                            error?.message ||
                                            'Configuration update failed'
                                    });

                                });

                            // Async response
                            return true;


                        // ==================================================
                        // UNKNOWN MESSAGE
                        // ==================================================

                        case 'popup_open':
                        case 'popup_closed':
                            // Popup lifecycle messages are consumed by the
                            // floating UI. The content agent does not need to
                            // treat them as agent commands.
                            sendResponse({ success: true });
                            return false;

                        default:

                            Logger.warn(
                                'AGENT',
                                `Unknown request type: ${request.type}`
                            );

                            sendResponse({
                                success: false,
                                error:
                                    `Unknown request type: ${request.type}`
                            });

                            return false;
                    }

                } catch (error) {

                    Logger.error(
                        'AGENT',
                        'Message handler error',
                        error
                    );

                    sendResponse({
                        success: false,
                        error:
                            error?.message ||
                            'Message handler error'
                    });

                    // Synchronous error response
                    return false;
                }
            }
        );
    }

    /**
     * Set up mutation observer for DOM changes
     */
    setupMutationObserver() {

        const observer =
            new MutationObserver((mutations) => {

                // Flag for page content changes
                if (this.isActive) {

                    // Trigger processing on next cycle
                    // instead of immediately
                    // to avoid excessive processing

                }
            });

        if (document.body) {

            observer.observe(
                document.body,
                {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: [
                        'value',
                        'class',
                        'style'
                    ],
                    characterData: false
                }
            );

        } else {

            Logger.warn(
                'AGENT',
                'document.body not available for MutationObserver'
            );
        }
    }
}


// ================================================================
// PAGE ANALYSIS HELPERS
// ================================================================

/**
 * Extract interactive elements
 */
function extractInteractiveElements() {

    const elements = document.querySelectorAll(
        'input, textarea, button, select, a'
    );

    return Array.from(elements)

        .filter((element) => {

            const rect =
                element.getBoundingClientRect();

            return (
                rect.width > 0 &&
                rect.height > 0
            );

        })

        .map((element, index) =>
            getElementInfo(element, index)
        );
}


/**
 * Detect sensitive elements
 */
function detectSensitiveElements(elements) {

    return elements.map((element) => {

        let sensitive = false;
        let reason = null;

        const type =
            (element.type || '')
                .toLowerCase();

        const name =
            (element.name || '')
                .toLowerCase();

        const placeholder =
            (element.placeholder || '')
                .toLowerCase();

        const autocomplete =
            (element.autocomplete || '')
                .toLowerCase();


        // Password
        if (type === 'password') {

            sensitive = true;
            reason = 'password';
        }


        // Email
        else if (
            type === 'email' ||
            autocomplete.includes('email') ||
            name.includes('email') ||
            placeholder.includes('email')
        ) {

            sensitive = true;
            reason = 'email';
        }


        // Phone
        else if (
            type === 'tel' ||
            autocomplete.includes('tel') ||
            name.includes('phone') ||
            name.includes('mobile')
        ) {

            sensitive = true;
            reason = 'phone';
        }


        // Credit card
        else if (
            autocomplete.includes('cc-number') ||
            name.includes('card')
        ) {

            sensitive = true;
            reason = 'credit_card';
        }


        return {
            ...element,
            sensitive,
            reason
        };
    });
}


/**
 * Analyze page
 */
function analyzePage() {

    const elements =
        extractInteractiveElements();

    const analyzed =
        detectSensitiveElements(elements);

    return {
        success: true,
        url: window.location.href,
        title: document.title,
        timestamp: Date.now(),
        elements: analyzed
    };
}


// ================================================================
// INITIALIZATION
// ================================================================

let agent = null;
let agentInitializationPromise = null;

/**
 * Initialize agent
 */
async function initializeAgent() {

    if (agentInitializationPromise) {
        return agentInitializationPromise;
    }

    agentInitializationPromise = (async () => {

        if (agent) {
            return agent;
        }

        agent = new PrivacyBrowserAgent();

        const success = await agent.initialize();

        if (!success) {
            Logger.error(
                'AGENT',
                'Agent initialization failed'
            );

            return null;
        }

        return agent;

    })();

    return agentInitializationPromise;
}

/**
 * Initialize when DOM is ready
 */
if (document.readyState === 'loading') {

    document.addEventListener(
        'DOMContentLoaded',
        initializeAgent,
        { once: true }
    );

} else {

    initializeAgent();
}


Logger.log(
    'AGENT',
    'Content script loaded'
);