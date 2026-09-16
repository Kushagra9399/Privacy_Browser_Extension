/**
 * Offscreen local AI worker.
 * Runs ONNX Runtime and Transformers.js under the extension origin instead
 * of the webpage origin.
 */

let visionModel = null;
let visionInitialization = null;
let reasoningAgent = null;
let reasoningInitialization = null;

async function getVisionModel() {
    if (visionModel?.initialized) {
        return visionModel;
    }

    if (!visionInitialization) {
        visionInitialization = (async () => {
            const model = new LocalOnnxVisionModel();
            await model.initialize();
            visionModel = model;
            return model;
        })();
    }

    return visionInitialization;
}

async function getReasoningAgent() {
    if (reasoningAgent?.initialized) {
        return reasoningAgent;
    }

    if (!reasoningInitialization) {
        reasoningInitialization = (async () => {
            if (typeof LocalReasoningAgent === 'undefined') {
                throw new Error('Local reasoning agent is not available');
            }

            const agent = new LocalReasoningAgent();
            await agent.initialize();
            reasoningAgent = agent;
            return agent;
        })();
    }

    return reasoningInitialization;
}

async function handleOffscreenRequest(request) {
    if (request.type === 'run_offscreen_vision') {
        const model = await getVisionModel();
        const width = Number(request.width);
        const height = Number(request.height);

        if (!Number.isFinite(width) || width <= 0 ||
            !Number.isFinite(height) || height <= 0) {
            throw new Error('Invalid offscreen vision dimensions');
        }

        if (!request.pixels || request.pixels.length !== width * height * 4) {
            throw new Error('Invalid offscreen vision pixel buffer');
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d', {
            willReadFrequently: true
        });

        if (!ctx) {
            throw new Error('Could not create offscreen canvas context');
        }

        const imageData = new ImageData(
            new Uint8ClampedArray(request.pixels),
            width,
            height
        );

        ctx.putImageData(imageData, 0, 0);

        const detections = await model.infer(canvas);

        return {
            success: true,
            detections
        };
    }

    if (request.type === 'run_offscreen_reasoning') {
        const agent = await getReasoningAgent();
        const action = await agent.reason(
            request.goal,
            request.observation
        );

        return {
            success: true,
            action
        };
    }

    return {
        success: false,
        error: `Unsupported offscreen request: ${request.type}`
    };
}

// Dedicated port: background service worker -> offscreen document.
// runtime.connect() does not connect to content scripts, preventing page-side
// listeners from accidentally answering internal local-AI requests.
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'privacy-browser-offscreen-ai') {
        return;
    }

    Logger.log('LOCAL_AGENT', 'Offscreen AI port connected');

    port.onMessage.addListener((request) => {
        handleOffscreenRequest(request)
            .then((response) => port.postMessage(response))
            .catch((error) => {
                const module = request.type === 'run_offscreen_vision'
                    ? 'VISION'
                    : 'LOCAL_AGENT';

                Logger.error(
                    module,
                    'Offscreen local AI request failed',
                    error
                );

                port.postMessage({
                    success: false,
                    error: error?.message || 'Offscreen local AI request failed'
                });
            });
    });
});

// Keep the existing one-time message API for direct offscreen requests.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request.type?.startsWith('run_offscreen_')) {
        return false;
    }

    handleOffscreenRequest(request)
        .then(sendResponse)
        .catch((error) => {
            Logger.error(
                request.type === 'run_offscreen_vision'
                    ? 'VISION'
                    : 'LOCAL_AGENT',
                'Offscreen local AI request failed',
                error
            );

            sendResponse({
                success: false,
                error: error?.message || 'Offscreen local AI request failed'
            });
        });

    return true;
});

Logger.log('LOCAL_AGENT', 'Offscreen local AI document loaded');
