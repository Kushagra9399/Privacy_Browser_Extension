/**
 * Command Executor - Executes actions received from the server
 * Handles all client-side interactions: clicks, scrolls, form fills, etc.
 */

class CommandExecutor {
    constructor() {
        this.executionHistory = [];
        this.maxHistorySize = 100;
        this.elementRegistry = null;
    }

    /** Execute one validated action from the agent session. */
    async executeAgentAction(action) {
        const startedAt = performance.now();
        const type = String(action.type || '').toLowerCase();

        try {
            if (!this.elementRegistry && type !== 'scroll' && type !== 'wait') {
                throw new Error('Agent element registry is not configured');
            }

            const element = action.element_id
                ? this.elementRegistry.resolveElement(action.element_id)
                : null;
            if (action.element_id && !element) {
                return { success: false, errorCode: 'element_not_found', errorMessage: `Element ${action.element_id} not found` };
            }
            if (element) {
                const validation = this.elementRegistry.validateReference(action.element_id, element);
                if (!validation.valid) {
                    return { success: false, errorCode: 'stale_element_reference', errorMessage: validation.reason };
                }
            }

            let result;
            switch (type) {
                case 'click': result = await this.executeClick({ ...action, target: 'element_id' }); break;
                case 'type': result = await this.executeType({ ...action, target: 'element_id' }); break;
                case 'clear': result = await this.executeType({ ...action, target: 'element_id', text: '' }); break;
                case 'focus': result = await this.executeFocus({ ...action, target: 'element_id' }); break;
                case 'select': result = await this.executeSelect({ ...action, target: 'element_id' }); break;
                case 'hover': result = await this.executeHover({ ...action, target: 'element_id' }); break;
                case 'scroll': result = await this.executeScroll(action); break;
                case 'wait': result = await this.executeWait({ duration: action.duration_ms || 500 }); break;
                case 'press_key': result = await this.executePressKey(element, action.key); break;
                case 'submit': result = await this.executeSubmit({ ...action, target: 'element_id' }); break;
                case 'navigate': result = await this.executeNavigate(action.url); break;
                case 'back': result = await this.executeHistory('back'); break;
                case 'forward': result = await this.executeHistory('forward'); break;
                case 'extract': result = await this.executeExtractData(action); break;
                default: return { success: false, errorCode: 'invalid_action', errorMessage: `Unsupported action: ${action.type}` };
            }

            const durationMs = Math.round(performance.now() - startedAt);
            this.recordExecution(action, result, durationMs, true);
            return { success: true, result, duration_ms: durationMs };
        } catch (error) {
            const durationMs = Math.round(performance.now() - startedAt);
            this.recordExecution(action, null, durationMs, false, error.message);
            return { success: false, errorCode: 'execution_error', errorMessage: error.message, duration_ms: durationMs };
        }
    }

    async executePressKey(element, key) {
        if (!element) throw new Error('Target element not found');
        element.focus();
        element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
        return { pressed: true, key };
    }

    async executeNavigate(url) {
        const navigationUrl = url || this.pendingNavigationUrl;
        Logger.log('EXECUTOR', 'Executing navigation', { url, resolvedUrl: navigationUrl });
        if (!navigationUrl) throw new Error('Navigation URL is required');
        window.location.assign(navigationUrl);
        await this.wait(500);
        return { navigated: true, url: navigationUrl };
    }

    async executeHistory(direction) {
        if (direction === 'back') window.history.back();
        else window.history.forward();
        await this.wait(500);
        return { navigated: true, direction };
    }

    /**
     * Execute a command received from the server
     */
    async execute(command) {
        try {
            const startTime = performance.now();
            
            Logger.log('EXECUTOR', `Executing command: ${command.type}`, command);

            let result = null;

            switch (command.type) {
                case 'click': result = await this.executeClick(command); break;
                case 'scroll': result = await this.executeScroll(command); break;
                case 'type': result = await this.executeType(command); break;
                case 'select': result = await this.executeSelect(command); break;
                case 'wait': result = await this.executeWait(command); break;
                case 'submit': result = await this.executeSubmit(command); break;
                case 'focus': result = await this.executeFocus(command); break;
                case 'hover': result = await this.executeHover(command); break;
                case 'screenshot': result = await this.executeScreenshot(command); break;
                case 'extract_data': result = await this.executeExtractData(command); break;
                default: throw new Error(`Unknown command type: ${command.type}`);
            }

            const duration = performance.now() - startTime;
            this.recordExecution(command, result, duration, true);

            return { success: true, result: result, duration: duration, timestamp: Date.now() };
        } catch (error) {
            Logger.error('EXECUTOR', `Command execution failed: ${command.type}`, error);
            this.recordExecution(command, null, 0, false, error.message);
            return { success: false, error: error.message, timestamp: Date.now() };
        }
    }

    /** Execute click command */
    async executeClick(command) {
        const { target, x, y } = command;
        let element = null;

        if (target === 'element_id') element = this.findElementById(command.element_id);
        else if (target === 'coordinates') element = document.elementFromPoint(x, y);
        else if (target === 'selector') element = document.querySelector(command.selector);
        else if (target === 'xpath') element = this.findElementByXPath(command.xpath);

        if (!element) throw new Error(`Element not found for click: ${JSON.stringify(command)}`);

        const initialRect = element.getBoundingClientRect();
        const initialCenterX = initialRect.left + initialRect.width / 2;
        const initialCenterY = initialRect.top + initialRect.height / 2;
        const outsideViewport =
            initialCenterX < 0 ||
            initialCenterY < 0 ||
            initialCenterX > window.innerWidth ||
            initialCenterY > window.innerHeight;

        if (outsideViewport) {
            element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
            await this.wait(100);
        }

        const validation = this.validateActionableElement(element, 'click');
        if (!validation.valid) {
            Logger.warn('EXECUTOR', `Blocked click: ${validation.reason}`, {
                rect: element.getBoundingClientRect().toJSON?.() || element.getBoundingClientRect(),
                viewport: { width: window.innerWidth, height: window.innerHeight }
            });
            return { clicked: false, blocked: true, errorCode: validation.errorCode, reason: validation.reason };
        }

        element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
        await this.wait(100);

        const postScrollValidation = this.validateActionableElement(element, 'click');
        if (!postScrollValidation.valid) {
            Logger.warn('EXECUTOR', `Blocked click after scroll: ${postScrollValidation.reason}`);
            return { clicked: false, blocked: true, errorCode: postScrollValidation.errorCode, reason: postScrollValidation.reason };
        }

        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        const rect = element.getBoundingClientRect();
        const clickX = rect.left + rect.width / 2;
        const clickY = rect.top + rect.height / 2;

        this.dispatchMouseEvent('mousemove', clickX, clickY);
        await this.wait(100);
        element.dispatchEvent(clickEvent);
        await this.wait(200);

        return { clicked: true, element: element.tagName, text: element.textContent?.substring(0, 100) || '' };
    }

    /**
     * Validate that a DOM element is currently actionable.
     * This is a local browser-side safety boundary between agent
     * perception and command execution.
     */
    validateActionableElement(element, actionType = 'click') {
        if (!element || !(element instanceof Element)) {
            return { valid: false, errorCode: 'invalid_element', reason: 'Target is not a valid DOM element' };
        }

        if (!element.isConnected) {
            return { valid: false, errorCode: 'detached_element', reason: 'Target element is no longer connected to the page' };
        }

        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
            return { valid: false, errorCode: 'not_actionable', reason: 'Target element is hidden or does not accept pointer events' };
        }

        if (element.hasAttribute('inert') || element.closest('[inert]')) {
            return { valid: false, errorCode: 'inert_element', reason: 'Target element is inside an inert UI region' };
        }

        if (
            element instanceof HTMLButtonElement ||
            element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement
        ) {
            if (element.disabled) {
                return { valid: false, errorCode: 'disabled_element', reason: 'Target form control is disabled' };
            }
        }

        if (element.getAttribute('aria-disabled') === 'true' || element.closest('[aria-disabled="true"]')) {
            return { valid: false, errorCode: 'aria_disabled_element', reason: 'Target element is marked aria-disabled' };
        }

        if (actionType === 'click') {
            const tagName = element.tagName.toLowerCase();
            const role = (element.getAttribute('role') || '').toLowerCase();
            const hasHref = tagName === 'a' && element.hasAttribute('href');
            const hasClickHandler = element.hasAttribute('onclick') || typeof element.onclick === 'function';
            const isNativeButton = ['button', 'input'].includes(tagName);
            const isCustomInteractive = ['button', 'link', 'menuitem', 'option', 'tab'].includes(role);

            if (!isNativeButton && !hasHref && !hasClickHandler && !isCustomInteractive) {
                return {
                    valid: false,
                    errorCode: 'non_interactive_element',
                    reason: 'Target has no native or explicit interactive semantics'
                };
            }
        }

        if (actionType === 'type') {
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                if (element.readOnly) {
                    return { valid: false, errorCode: 'readonly_element', reason: 'Target input is read-only' };
                }
            }
        }

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return { valid: false, errorCode: 'zero_size_element', reason: 'Target element has no visible area' };
        }

        if (actionType === 'click') {
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            if (centerX < 0 || centerY < 0 || centerX > window.innerWidth || centerY > window.innerHeight) {
                return { valid: false, errorCode: 'outside_viewport', reason: 'Target click point is outside the viewport' };
            }

            const topElement = document.elementFromPoint(centerX, centerY);
            if (topElement && topElement !== element && !element.contains(topElement)) {
                return { valid: false, errorCode: 'covered_element', reason: 'Target is covered by another element at its click point' };
            }
        }

        return { valid: true, reason: 'Target is currently actionable' };
    }

    async executeScroll(command) {
        const { direction, amount, smooth = true } = command;
        const scrollAmount = amount || 300;
        const behavior = smooth ? 'smooth' : 'auto';
        if (direction === 'down') window.scrollBy({ top: scrollAmount, behavior });
        else if (direction === 'up') window.scrollBy({ top: -scrollAmount, behavior });
        else if (direction === 'left') window.scrollBy({ left: -scrollAmount, behavior });
        else if (direction === 'right') window.scrollBy({ left: scrollAmount, behavior });
        if (smooth) await this.wait(500); else await this.wait(100);
        return { scrolled: true, direction, scrollTop: window.scrollY, scrollLeft: window.scrollX };
    }

    async executeType(command) {
        const { target, text, element_id, selector, delay = 50 } = command;
        let element = null;
        if (target === 'element_id') element = this.findElementById(element_id);
        else if (target === 'selector') element = document.querySelector(selector);
        if (!element || !['input', 'textarea'].includes(element.tagName.toLowerCase())) throw new Error('Target element is not an input field');
        const validation = this.validateActionableElement(element, 'type');
        if (!validation.valid) return { typed: false, blocked: true, errorCode: validation.errorCode, reason: validation.reason };
        element.focus();
        await this.wait(100);
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        for (let i = 0; i < text.length; i++) {
            element.value += text[i];
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            if (delay > 0) await this.wait(delay);
        }
        element.blur();
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true, textLength: text.length, element: element.tagName };
    }

    async executeSelect(command) {
        const { target, selector, value, label, element_id } = command;
        let element = null;
        if (target === 'element_id') element = this.findElementById(element_id);
        else if (target === 'selector') element = document.querySelector(selector);
        if (!element || element.tagName.toLowerCase() !== 'select') throw new Error('Target element is not a select');
        const validation = this.validateActionableElement(element, 'select');
        if (!validation.valid) return { selected: false, blocked: true, errorCode: validation.errorCode, reason: validation.reason };
        let option = null;
        if (value) option = Array.from(element.options).find(o => o.value === value);
        else if (label) option = Array.from(element.options).find(o => o.textContent === label);
        if (!option) throw new Error(`Option not found: value=${value}, label=${label}`);
        element.value = option.value;
        element.dispatchEvent(new Event('change', { bubbles: true }));
        await this.wait(200);
        return { selected: true, value: element.value, label: option.textContent };
    }

    async executeSubmit(command) {
        const { target, element_id, selector } = command;
        let element = null;
        if (target === 'element_id') element = this.findElementById(element_id);
        else if (target === 'selector') element = document.querySelector(selector);
        else if (target === 'form') element = document.querySelector('form');
        if (!element) throw new Error('Form element not found');
        const validation = this.validateActionableElement(element, 'submit');
        if (!validation.valid) return { submitted: false, blocked: true, errorCode: validation.errorCode, reason: validation.reason };
        const form = element.tagName.toLowerCase() === 'form' ? element : element.closest('form');
        if (!form) throw new Error('Element is not a form');
        form.submit();
        await this.wait(1000);
        return { submitted: true, form: form.id || form.name || 'unnamed' };
    }

    async executeFocus(command) {
        const { target, element_id, selector } = command;
        let element = null;
        if (target === 'element_id') element = this.findElementById(element_id);
        else if (target === 'selector') element = document.querySelector(selector);
        if (!element) throw new Error('Element not found');
        const validation = this.validateActionableElement(element, 'focus');
        if (!validation.valid) return { focused: false, blocked: true, errorCode: validation.errorCode, reason: validation.reason };
        element.focus();
        await this.wait(100);
        return { focused: true, element: element.tagName };
    }

    async executeHover(command) {
        const { target, element_id, selector, x, y } = command;
        let element = null;
        if (target === 'element_id') element = this.findElementById(element_id);
        else if (target === 'selector') element = document.querySelector(selector);
        else if (target === 'coordinates') element = document.elementFromPoint(x, y);
        if (!element) throw new Error('Element not found');
        const validation = this.validateActionableElement(element, 'hover');
        if (!validation.valid) return { hovered: false, blocked: true, errorCode: validation.errorCode, reason: validation.reason };
        const rect = element.getBoundingClientRect();
        const hoverX = rect.left + rect.width / 2;
        const hoverY = rect.top + rect.height / 2;
        this.dispatchMouseEvent('mouseenter', hoverX, hoverY);
        this.dispatchMouseEvent('mouseover', hoverX, hoverY);
        await this.wait(300);
        return { hovered: true, element: element.tagName };
    }

    async executeWait(command) {
        const { duration, condition } = command;
        if (duration) { await this.wait(duration); return { waited: true, duration }; }
        if (condition === 'page_load') { await this.waitForPageLoad(); return { waited: true, condition: 'page_load' }; }
        return { waited: false };
    }

    async executeScreenshot(command) {
        const processor = new VisionProcessor();
        const result = await processor.processScreen();
        return { screenshot: result ? result.screenshot : null, success: result !== null };
    }

    async executeExtractData(command) {
        const { selector, attribute } = command;
        if (selector) {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`Element not found: ${selector}`);
            if (attribute) return { data: element.getAttribute(attribute), type: 'attribute' };
            return { data: element.textContent, type: 'text' };
        }
        const formData = {};
        document.querySelectorAll('input, textarea, select').forEach((el) => {
            if (el.name) formData[el.name] = el.value;
        });
        return { data: formData, type: 'form_data' };
    }

    findElementById(elementId) {
        if (this.elementRegistry && elementId?.startsWith('agent-el-')) return this.elementRegistry.resolveElement(elementId);
        const parts = elementId.split('_');
        if (parts[0] === 'el') {
            const index = parseInt(parts[1]);
            const allElements = document.querySelectorAll('*');
            return allElements[index] || null;
        }
        return document.getElementById(elementId);
    }

    findElementByXPath(xpath) {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue;
    }

    dispatchMouseEvent(eventType, x, y) {
        const element = document.elementFromPoint(x, y);
        if (element) {
            const event = new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
            element.dispatchEvent(event);
        }
    }

    wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    waitForPageLoad() {
        return new Promise((resolve) => {
            if (document.readyState === 'complete') resolve();
            else window.addEventListener('load', resolve, { once: true });
        });
    }

    recordExecution(command, result, duration, success, error = null) {
        this.executionHistory.push({ command: command.type, timestamp: Date.now(), duration, success, error, fullCommand: command });
        if (this.executionHistory.length > this.maxHistorySize) this.executionHistory = this.executionHistory.slice(-this.maxHistorySize);
    }

    getHistory() { return this.executionHistory; }
    clearHistory() { this.executionHistory = []; }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { CommandExecutor };
