/**
 * Local Reasoning Agent
 *
 * Runs a small instruction-tuned language model inside the extension's
 * offscreen document. Page state is supplied as sanitized structural data.
 * No page observation is sent to the backend for this reasoning step.
 */

class LocalReasoningAgent {
    constructor() {
        this.modelId = 'onnx-community/Qwen2.5-0.5B-Instruct';
        this.generator = null;
        this.initialization = null;
        this.initialized = false;
        this.device = null;
        this.maxNewTokens = 120;
    }

    async initialize() {
        if (this.initialized && this.generator) {
            return true;
        }

        if (!this.initialization) {
            this.initialization = this.loadModel();
        }

        return this.initialization;
    }

    async loadModel() {
        try {
            const pipeline = window.TransformersPipeline;

            if (typeof pipeline !== 'function') {
                throw new Error(
                    'Transformers.js runtime is not loaded; check transformers-loader.js and node_modules/@huggingface/transformers'
                );
            }

            const hasWebGPU =
                typeof navigator !== 'undefined' &&
                !!navigator.gpu;

            this.device = hasWebGPU ? 'webgpu' : 'wasm';

            Logger.log(
                'LOCAL_AGENT',
                `Loading local reasoning model ${this.modelId} using ${this.device}`
            );

            this.generator = await pipeline(
                'text-generation',
                this.modelId,
                {
                    device: this.device,
                    dtype: 'q4',
                    progress_callback: (progress) => {
                        if (progress?.status === 'progress') {
                            Logger.log(
                                'LOCAL_AGENT',
                                `Reasoning model download: ${Math.round(progress.progress || 0)}%`
                            );
                        }
                    }
                }
            );

            this.initialized = true;

            Logger.log(
                'LOCAL_AGENT',
                `Local reasoning model ready: ${this.modelId}`
            );

            return true;
        } catch (error) {
            this.initialization = null;
            this.generator = null;
            this.initialized = false;

            Logger.error(
                'LOCAL_AGENT',
                'Failed to initialize local reasoning model',
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
                    'Your job is to choose exactly one next browser action from the current page state.',
                    'Use only the supplied goal and page elements.',
                    'Never invent an element_id.',
                    'Prefer an element whose visible text, aria label, placeholder, or role matches the goal.',
                    'Do not use sensitive elements.',
                    'Return ONLY valid JSON with this schema:',
                    '{"type":"click|focus|type|scroll|finish","element_id":"...","text":"...","direction":"up|down","amount":500,"reason":"..."}',
                    'Only include fields relevant to the selected action.',
                    'If the goal is already satisfied, return type finish.',
                    'If no safe next action can be determined from the supplied page state, return type finish.'
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

        const output = await this.generator(messages, {
            max_new_tokens: this.maxNewTokens,
            do_sample: false,
            temperature: 0
        });

        const generated = output?.[0]?.generated_text;
        const text = Array.isArray(generated)
            ? generated.at(-1)?.content || ''
            : String(generated || '');

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
                .slice(0, 120)
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
                reason: 'Local reasoning model did not return valid JSON'
            };
        }

        let action;
        try {
            action = JSON.parse(jsonMatch[0]);
        } catch (error) {
            return {
                type: 'finish',
                reason: 'Local reasoning model returned malformed JSON'
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
                reason: `Local reasoning returned unsupported action type: ${type}`
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
                    reason: 'Local reasoning returned an invalid scroll direction'
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
                reason: 'Local reasoning selected an element that is not present in the safe observation'
            };
        }

        const result = {
            type,
            element_id: elementId,
            reason: String(action.reason || 'Action selected by local reasoning')
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
                    reason: 'Local reasoning returned an empty text action'
                };
            }
        }

        return result;
    }
}

window.LocalReasoningAgent = LocalReasoningAgent;
