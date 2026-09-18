class LocalReasoningAgent {
    constructor() {
        this.modelId = 'Qwen2-0.5B-Instruct-q4f16_1-MLC';
        this.engine = null;
        this.initialization = null;
        this.initialized = false;
        this.maxNewTokens = 120;
    }

    async initialize() {
        if (this.initialized && this.engine) {
            return true;
        }

        if (!this.initialization) {
            this.initialization = this.loadModel();
        }

        return this.initialization;
    }

    async loadModel() {
        try {
            const CreateMLCEngine = window.CreateMLCEngine;

            if (typeof CreateMLCEngine !== 'function') {
                throw new Error(
                    'WebLLM runtime is not loaded; check transformers-loader.js and @mlc-ai/web-llm'
                );
            }

            if (typeof navigator !== 'undefined' && !navigator.gpu) {
                throw new Error(
                    'WebGPU is not available in this extension context. WebLLM requires WebGPU for this local reasoning model.'
                );
            }

            Logger.log(
                'LOCAL_AGENT',
                `Loading local WebLLM reasoning model ${this.modelId}`
            );

            this.engine = await CreateMLCEngine(this.modelId, {
                initProgressCallback: (progress) => {
                    Logger.log(
                        'LOCAL_AGENT',
                        `WebLLM model loading: ${progress?.text || progress?.progress || ''}`
                    );
                }
            });

            this.initialized = true;

            Logger.log(
                'LOCAL_AGENT',
                `Local WebLLM model ready: ${this.modelId}`
            );

            return true;
        } catch (error) {
            this.initialization = null;
            this.engine = null;
            this.initialized = false;

            Logger.error(
                'LOCAL_AGENT',
                'Failed to initialize local WebLLM reasoning model',
                error
            );

            throw error;
        }
    }

    async reason(goal, observation) {
        await this.initialize();

        const safeObservation = this.buildSafeObservation(observation);

        const messages = [
            {
                role: 'system',
                content: [
                    'You are the local reasoning engine for a privacy-preserving browser agent.',
                    'Choose exactly one next browser action from the supplied safe page state.',
                    'Use only the supplied goal and page elements.',
                    'Never invent an element_id.',
                    'Prefer an element whose visible text, aria label, placeholder, or role matches the goal.',
                    'Never select a sensitive element.',
                    'Return ONLY valid JSON with this schema:',
                    '{"type":"click|focus|type|scroll|finish","element_id":"...","text":"...","direction":"up|down","amount":500,"reason":"..."}',
                    'Only include fields relevant to the selected action.',
                    'If the goal is already satisfied, return type finish.',
                    'If no safe next action can be determined, return type finish.'
                ].join(' ')
            },
            {
                role: 'user',
                content: JSON.stringify({
                    goal: String(goal || ''),
                    page: safeObservation
                })
            }
        ];

        const response = await this.engine.chat.completions.create({
            messages,
            temperature: 0,
            max_tokens: this.maxNewTokens
        });

        const text = String(
            response?.choices?.[0]?.message?.content || ''
        ).trim();

        return this.parseAction(text, safeObservation.elements);
    }

    buildSafeObservation(observation) {
        const elements = Array.isArray(observation?.elements)
            ? observation.elements
            : [];

        return {
            url_path: String(observation?.url || '').split('?')[0].split('#')[0],
            title: String(observation?.title || '').substring(0, 160),
            viewport_width: observation?.viewport_width || 0,
            viewport_height: observation?.viewport_height || 0,
            elements: elements
                .filter(element =>
                    element &&
                    element.visible &&
                    element.enabled &&
                    !element.sensitive
                )
                .slice(0, 50)
                .map(element => ({
                    element_id: element.agent_element_id,
                    tag: element.tag,
                    role: element.role,
                    type: element.element_type,
                    text: String(element.text_preview || '').substring(0, 120),
                    aria_label: String(element.aria_label || '').substring(0, 120),
                    placeholder: String(element.placeholder || '').substring(0, 120),
                    bbox: element.bbox
                }))
        };
    }

    parseAction(rawText, elements) {
        const text = String(rawText || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);

        if (!jsonMatch) {
            return {
                type: 'finish',
                reason: 'Local WebLLM did not return valid JSON'
            };
        }

        let action;
        try {
            action = JSON.parse(jsonMatch[0]);
        } catch (error) {
            return {
                type: 'finish',
                reason: 'Local WebLLM returned malformed JSON'
            };
        }

        const type = String(action.type || '').toLowerCase();
        const allowedTypes = new Set([
            'click',
            'focus',
            'type',
            'scroll',
            'finish'
        ]);

        if (!allowedTypes.has(type)) {
            return {
                type: 'finish',
                reason: `Local WebLLM returned unsupported action type: ${type}`
            };
        }

        if (type === 'finish') {
            return {
                type: 'finish',
                reason: String(action.reason || 'Goal completed or no safe action was available')
            };
        }

        if (type === 'scroll') {
            const direction = String(action.direction || '').toLowerCase();
            if (!['up', 'down'].includes(direction)) {
                return {
                    type: 'finish',
                    reason: 'Local WebLLM returned an invalid scroll direction'
                };
            }

            return {
                type: 'scroll',
                direction,
                amount: Math.min(1000, Math.max(100, Number(action.amount) || 500)),
                reason: String(action.reason || 'Local reasoning selected a scroll action')
            };
        }

        const elementId = String(action.element_id || '');
        const element = elements.find(item => item.element_id === elementId);

        if (!element) {
            return {
                type: 'finish',
                reason: 'Local WebLLM selected an element that is not present in the safe observation'
            };
        }

        const result = {
            type,
            element_id: elementId,
            reason: String(action.reason || 'Action selected by local WebLLM')
        };

        if (type === 'type') {
            if (element.sensitive) {
                return {
                    type: 'finish',
                    reason: 'Refusing to type into a sensitive element'
                };
            }

            result.text = String(action.text || '');
            if (!result.text) {
                return {
                    type: 'finish',
                    reason: 'Local WebLLM returned an empty text action'
                };
            }
        }

        return result;
    }
}

window.LocalReasoningAgent = LocalReasoningAgent;
