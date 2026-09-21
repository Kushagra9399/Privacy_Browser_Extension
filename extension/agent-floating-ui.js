(() => {
    'use strict';

    const HOST_ID = '__privacy_browser_agent_floating_ui__';
    const POSITION_KEY = 'agentFloatingUiPosition';

    class AgentFloatingUI {
        constructor() {
            this.host = null;
            this.shadow = null;
            this.panel = null;
            this.minimized = false;
            this.state = {
                running: false,
                sessionId: null,
                goal: '',
                step: 0,
                maxSteps: 20,
                status: 'idle',
                action: 'Waiting for agent...',
                reasoning: 'Start an agent task to see its reasoning here.',
                errors: 0
            };
            this.drag = null;
        }

        async init() {
            if (document.getElementById(HOST_ID)) return;

            await this.restorePosition();

            const mount = () => {
                if (!document.body || document.getElementById(HOST_ID)) return;
                this.create();
                this.bindRuntimeMessages();
                this.loadCurrentState();
            };

            if (document.body) {
                mount();
            } else {
                document.addEventListener('DOMContentLoaded', mount, { once: true });
            }
        }

        create() {
            this.host = document.createElement('div');
            this.host.id = HOST_ID;
            this.host.style.cssText = [
                'position:fixed',
                'left:20px',
                'bottom:20px',
                'width:360px',
                'height:auto',
                'z-index:2147483647',
                'pointer-events:none','display:none'
            ].join(';');

            this.shadow = this.host.attachShadow({ mode: 'closed' });
            const style = document.createElement('style');
            style.textContent = this.getStyles();

            this.panel = document.createElement('div');
            this.panel.className = 'panel';
            this.panel.innerHTML = this.getMarkup();

            this.shadow.append(style, this.panel);
            document.body.appendChild(this.host);

            this.bindControls();
            this.applyPosition();
            this.render();
        }

        getMarkup() {
            return `
                <section class="widget" aria-label="Privacy Browser Agent">
                    <header class="header" data-drag-handle>
                        <div class="brand">
                            <span class="status-dot"></span>
                            <div>
                                <div class="title">Privacy Browser Agent</div>
                                <div class="subtitle">On-device agent</div>
                            </div>
                        </div>
                        <div class="header-actions">
                            <button class="icon-btn minimize" title="Minimize">−</button>
                        </div>
                    </header>

                    <div class="body">
                        <div class="goal"></div>

                        <div class="status-row">
                            <span class="status"></span>
                            <span class="step"></span>
                            <span class="errors"></span>
                        </div>

                        <div class="card">
                            <div class="label">CURRENT ACTION</div>
                            <div class="action"></div>
                        </div>

                        <div class="card reasoning-card">
                            <div class="label">REASONING</div>
                            <div class="reasoning"></div>
                        </div>

                        <button class="stop">Stop agent</button>
                    </div>
                </section>

                <button class="minimized" title="Open Privacy Browser Agent">
                    <span class="mini-dot"></span>
                </button>
            `;
        }

        bindControls() {
            const $ = (selector) => this.shadow.querySelector(selector);

            $('.minimize').addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.setMinimized(true);
            });

            $('.minimized').addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.setMinimized(false);
            });

            $('.stop').addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();

                $('.stop').disabled = true;
                $('.stop').textContent = 'Stopping...';

                try {
                    if (window.agentLoop && typeof window.agentLoop.stop === 'function') {
                        await window.agentLoop.stop();
                    } else {
                        throw new Error('Agent loop is not available');
                    }
                } catch (error) {
                    console.warn('[AGENT_UI] Failed to stop agent', error);
                    $('.stop').disabled = false;
                    $('.stop').textContent = 'Stop agent';
                }
            });

            const handle = $('[data-drag-handle]');
            handle.addEventListener('pointerdown', (event) => this.startDrag(event));
        }

        bindRuntimeMessages() {
            chrome.runtime.onMessage.addListener((message) => {
                if (message?.type !== 'agent_event') return;
                this.applyEvent(message);
            });
        }

        async loadCurrentState() {
            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'get_agent_ui_state'
                });

                if (response?.success && response.state) {
                    this.state = {
                        ...this.state,
                        ...response.state
                    };
                    this.render();

                    if (this.state.running || (this.state.goal && this.state.status !== 'idle')) {
                        this.show();
                    }
                }
            } catch (error) {
                console.debug('[AGENT_UI] State restore failed', error);
            }
        }

        applyEvent(event) {
            switch (event.type) {
                case 'agent_started':
                    this.state = {
                        ...this.state,
                        running: true,
                        sessionId: event.session_id || this.state.sessionId,
                        goal: event.goal || this.state.goal,
                        step: 0,
                        maxSteps: event.max_steps || 20,
                        status: 'running',
                        action: 'Initializing...',
                        reasoning: 'Waiting for agent reasoning...',
                        errors: 0
                    };
                    this.show();
                    break;

                case 'step_started':
                    this.state.running = true;
                    this.state.status = 'running';
                    this.state.step = event.step ?? this.state.step;
                    this.state.maxSteps = event.max_steps || this.state.maxSteps;
                    break;

                case 'action_received':
                    this.state.running = true;
                    this.state.status = 'running';
                    this.state.action = event.action_type || this.state.action;
                    this.state.reasoning =
                        event.reasoning_summary ||
                        event.reason ||
                        this.state.reasoning;
                    break;

                case 'action_failed':
                    this.state.errors = event.error_count ?? this.state.errors;
                    this.state.action = `Failed: ${event.error_code || 'action error'}`;
                    break;

                case 'action_executed':
                    this.state.action = 'Executed';
                    break;

                case 'agent_finished':
                    this.state.running = false;
                    this.state.status = 'completed';
                    this.state.action = 'Completed';
                    this.state.reasoning = event.reason || this.state.reasoning;
                    break;

                case 'agent_stopped':
                    this.state.running = false;
                    this.state.status = 'stopped';
                    this.state.action = 'Stopped';
                    break;

                case 'agent_safety_stop':
                    this.state.running = false;
                    this.state.status = 'stopped';
                    this.state.action = 'Stopped for safety';
                    this.state.reasoning = event.message || this.state.reasoning;
                    break;

                case 'agent_error_limit':
                    this.state.running = false;
                    this.state.status = 'failed';
                    this.state.action = 'Error limit reached';
                    break;

                case 'agent_step_limit':
                    this.state.running = false;
                    this.state.status = 'stopped';
                    this.state.action = 'Step limit reached';
                    this.state.reasoning = event.message || this.state.reasoning;
                    break;

                case 'loop_error':
                    this.state.errors = Math.max(this.state.errors || 0, 1);
                    this.state.reasoning = event.error_message || this.state.reasoning;
                    break;

                case 'agent_ended':
                    this.state.running = false;
                    if (this.state.status === 'running') this.state.status = 'completed';
                    break;
            }

            this.render();
        }

        render() {
            if (!this.panel) return;

            const $ = (selector) => this.shadow.querySelector(selector);
            const status = this.state.status || 'idle';

            $('.status').textContent = this.getStatusText(status);
            $('.step').textContent = this.state.maxSteps
                ? `Step ${this.state.step || 0}/${this.state.maxSteps}`
                : '';
            $('.errors').textContent = this.state.errors
                ? `Errors ${this.state.errors}`
                : '';
            $('.goal').textContent = this.state.goal || 'No active task';
            $('.action').textContent = this.state.action || 'Waiting...';
            $('.reasoning').textContent =
                this.state.reasoning || 'Waiting for agent reasoning...';

            const dot = $('.status-dot');
            dot.className = `status-dot ${status}`;
            $('.mini-dot').className = `mini-dot ${status}`;

            const stop = $('.stop');
            stop.disabled = !this.state.running;
            stop.textContent = this.state.running ? 'Stop agent' : 'Agent not running';

            this.host.classList.toggle('is-running', !!this.state.running);
        }

        getStatusText(status) {
            return {
                idle: 'Idle',
                running: 'Running',
                completed: 'Completed',
                stopped: 'Stopped',
                failed: 'Failed'
            }[status] || status;
        }

        setMinimized(value) {
            this.minimized = value;
            this.host.classList.toggle('minimized-state', value);
            this.persistPosition();
        }

        show() {
            this.host.style.display = 'block';
        }

        startDrag(event) {
            if (event.button !== 0) return;

            event.preventDefault();
            event.stopPropagation();

            const rect = this.host.getBoundingClientRect();
            this.drag = {
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top
            };

            event.currentTarget.setPointerCapture?.(event.pointerId);

            const move = (moveEvent) => {
                if (!this.drag) return;
                moveEvent.preventDefault();
                moveEvent.stopPropagation();

                const width = this.host.offsetWidth;
                const height = this.host.offsetHeight;
                const left = Math.max(
                    8,
                    Math.min(
                        window.innerWidth - width - 8,
                        moveEvent.clientX - this.drag.offsetX
                    )
                );
                const top = Math.max(
                    8,
                    Math.min(
                        window.innerHeight - height - 8,
                        moveEvent.clientY - this.drag.offsetY
                    )
                );

                this.host.style.left = `${left}px`;
                this.host.style.top = `${top}px`;
                this.host.style.right = 'auto';
                this.host.style.bottom = 'auto';
            };

            const end = (upEvent) => {
                upEvent.preventDefault();
                upEvent.stopPropagation();
                this.drag = null;
                document.removeEventListener('pointermove', move, true);
                document.removeEventListener('pointerup', end, true);
                this.persistPosition();
            };

            document.addEventListener('pointermove', move, true);
            document.addEventListener('pointerup', end, true);
        }

        async restorePosition() {
            try {
                const data = await chrome.storage.local.get(POSITION_KEY);
                const position = data?.[POSITION_KEY];
                if (position) {
                    this.savedPosition = position;
                }
            } catch (error) {
                console.debug('[AGENT_UI] Position restore failed', error);
            }
        }

        async persistPosition() {
            try {
                await chrome.storage.local.set({
                    [POSITION_KEY]: {
                        left: this.host.style.left,
                        top: this.host.style.top,
                        minimized: this.minimized
                    }
                });
            } catch (error) {
                console.debug('[AGENT_UI] Position save failed', error);
            }
        }

        applyPosition() {
            const position = this.savedPosition;
            if (!position) return;

            if (position.left && position.top) {
                this.host.style.left = position.left;
                this.host.style.top = position.top;
                this.host.style.right = 'auto';
                this.host.style.bottom = 'auto';
            }

            if (typeof position.minimized === 'boolean') {
                this.minimized = position.minimized;
                this.host.classList.toggle('minimized-state', this.minimized);
            }
        }

        getStyles() {
            return `
                :host { all: initial; }
                * { box-sizing: border-box; }
                .panel {
                    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    color: #111827;
                    font-size: 13px;
                    pointer-events: auto;
                }
                .widget {
                    width: 360px;
                    border: 1px solid rgba(15, 23, 42, .12);
                    border-radius: 16px;
                    background: rgba(255, 255, 255, .97);
                    box-shadow: 0 14px 45px rgba(15, 23, 42, .20);
                    overflow: hidden;
                    backdrop-filter: blur(12px);
                }
                .header {
                    height: 58px;
                    padding: 0 12px 0 14px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    cursor: grab;
                    user-select: none;
                    border-bottom: 1px solid #eef0f4;
                }
                .header:active { cursor: grabbing; }
                .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
                .status-dot, .mini-dot {
                    width: 9px;
                    height: 9px;
                    border-radius: 50%;
                    display: block;
                    background: #9ca3af;
                    flex: 0 0 auto;
                }
                .status-dot.running, .mini-dot.running { background: #16a34a; box-shadow: 0 0 0 4px rgba(22,163,74,.12); }
                .status-dot.completed, .mini-dot.completed { background: #2563eb; }
                .status-dot.stopped, .mini-dot.stopped { background: #f59e0b; }
                .status-dot.failed, .mini-dot.failed { background: #dc2626; }
                .title { font-weight: 700; font-size: 13px; line-height: 17px; }
                .subtitle { color: #6b7280; font-size: 11px; line-height: 14px; }
                .header-actions { display: flex; }
                button { font: inherit; }
                .icon-btn {
                    width: 30px; height: 30px; border: 0; border-radius: 8px;
                    background: transparent; cursor: pointer; font-size: 20px; color: #4b5563;
                }
                .icon-btn:hover { background: #f3f4f6; }
                .body { padding: 12px; }
                .goal {
                    padding: 9px 10px;
                    border-radius: 10px;
                    background: #f6f7f9;
                    color: #374151;
                    font-weight: 600;
                    line-height: 18px;
                    max-height: 54px;
                    overflow: auto;
                    overflow-wrap: anywhere;
                }
                .status-row {
                    display: flex;
                    gap: 8px;
                    align-items: center;
                    margin: 9px 1px;
                    color: #6b7280;
                    font-size: 11px;
                }
                .status-row .status { color: #111827; font-weight: 700; }
                .status-row span:not(:first-child)::before { content: "•"; margin-right: 8px; color: #d1d5db; }
                .card {
                    border: 1px solid #eef0f4;
                    border-radius: 11px;
                    padding: 10px;
                    margin-top: 8px;
                    background: #fff;
                }
                .label { color: #9ca3af; font-size: 9px; font-weight: 800; letter-spacing: .08em; margin-bottom: 5px; }
                .action, .reasoning { line-height: 17px; overflow-wrap: anywhere; }
                .reasoning-card { max-height: 105px; overflow: auto; }
                .reasoning { color: #4b5563; }
                .stop {
                    width: 100%;
                    margin-top: 10px;
                    height: 34px;
                    border: 0;
                    border-radius: 9px;
                    background: #111827;
                    color: #fff;
                    font-weight: 700;
                    cursor: pointer;
                }
                .stop:disabled { background: #e5e7eb; color: #9ca3af; cursor: default; }
                .minimized {
                    display: none;
                    width: 52px; height: 52px;
                    border: 1px solid rgba(15,23,42,.12);
                    border-radius: 50%;
                    background: rgba(255,255,255,.97);
                    box-shadow: 0 10px 30px rgba(15,23,42,.22);
                    cursor: pointer;
                    align-items: center;
                    justify-content: center;
                }
                .minimized .mini-dot { width: 13px; height: 13px; }
                :host(.minimized-state) .widget { display: none; }
                :host(.minimized-state) .minimized { display: flex; }
            `;
        }
    }

    const boot = () => {
        if (!window.__privacyBrowserAgentFloatingUI) {
            window.__privacyBrowserAgentFloatingUI = new AgentFloatingUI();
            window.__privacyBrowserAgentFloatingUI.init();
        }
    };

    boot();
})();
