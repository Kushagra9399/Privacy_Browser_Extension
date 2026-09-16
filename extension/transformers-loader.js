/**
 * Loads Transformers.js as an extension-owned ES module and exposes only
 * the pipeline function needed by the local reasoning agent.
 */

import { pipeline } from './node_modules/@huggingface/transformers/dist/transformers.web.js';

window.TransformersPipeline = pipeline;

Logger.log('LOCAL_AGENT', 'Transformers.js runtime loaded');
