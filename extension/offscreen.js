/**
 * Offscreen local vision worker.
 * Runs ONNX Runtime under the extension origin instead of the webpage origin.
 */

let visionModel = null;
let visionInitialization = null;

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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type !== 'run_offscreen_vision') {
        return false;
    }

    (async () => {
        try {
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

            sendResponse({
                success: true,
                detections
            });
        } catch (error) {
            Logger.error(
                'VISION',
                'Offscreen ONNX inference failed',
                error
            );

            sendResponse({
                success: false,
                error: error?.message || 'Offscreen ONNX inference failed'
            });
        }
    })();

    return true;
});

Logger.log('VISION', 'Offscreen vision document loaded');
