/**
 * Local contextual PII NER detector.
 *
 * Runs the packaged pii-master-ner-m ONNX model entirely inside the
 * extension offscreen document. The tokenizer is loaded from the same
 * packaged tokenizer.json so model/tokenizer IDs cannot drift apart.
 */

class LocalPiiTokenizer {
    constructor() {
        this.vocab = new Map();
        this.merges = new Map();
        this.byteEncoder = new Map();
        this.byteDecoder = new Map();
        this.specialTokens = new Map();
        this.unkId = 50280;
        this.clsId = 50281;
        this.sepId = 50282;
        this.padId = 50283;
        this.maxLength = 512;
        this.initialized = false;
    }

    async initialize(tokenizerUrl) {
        const response = await fetch(tokenizerUrl);
        if (!response.ok) {
            throw new Error(`Could not load PII tokenizer: ${response.status}`);
        }

        const tokenizer = await response.json();
        const model = tokenizer?.model;

        if (!model || model.type !== 'BPE') {
            throw new Error(`Unsupported PII tokenizer model type: ${model?.type || 'unknown'}`);
        }

        for (const [token, id] of Object.entries(model.vocab || {})) {
            this.vocab.set(token, Number(id));
        }

        const mergeList = Array.isArray(model.merges) ? model.merges : [];
        mergeList.forEach((merge, rank) => {
            const pair = Array.isArray(merge)
                ? merge
                : String(merge).split(' ');

            if (pair.length !== 2) {
                return;
            }

            this.merges.set(
                this.mergeKey(pair[0], pair[1]),
                {
                    rank,
                    token: pair[0] + pair[1]
                }
            );
        });

        for (const added of tokenizer.added_tokens || []) {
            if (typeof added?.content === 'string' &&
                Number.isInteger(added.id)) {
                this.specialTokens.set(added.content, added.id);
            }
        }

        const specialIds = tokenizer?.post_processor?.special_tokens || {};
        this.clsId = this.resolveSpecialId('[CLS]', specialIds, this.clsId);
        this.sepId = this.resolveSpecialId('[SEP]', specialIds, this.sepId);
        this.padId = this.resolveSpecialId('[PAD]', specialIds, this.padId);
        this.unkId = this.resolveSpecialId('[UNK]', specialIds, this.unkId);

        this.buildByteMaps();

        this.maxLength =
            Number(tokenizer?.truncation?.max_length) ||
            this.maxLength;

        this.initialized = true;
        return true;
    }

    resolveSpecialId(name, specialIds, fallback) {
        const configured = specialIds?.[name]?.ids?.[0];
        if (Number.isInteger(configured)) {
            return configured;
        }

        const added = this.specialTokens.get(name);
        if (Number.isInteger(added)) {
            return added;
        }

        const vocabId = this.vocab.get(name);
        return Number.isInteger(vocabId) ? vocabId : fallback;
    }

    buildByteMaps() {
        const bytes = [];

        for (let value = 33; value <= 126; value++) {
            bytes.push(value);
        }

        for (let value = 161; value <= 172; value++) {
            bytes.push(value);
        }

        for (let value = 174; value <= 255; value++) {
            bytes.push(value);
        }

        const byteToChar = new Map();
        const charToByte = new Map();

        for (const value of bytes) {
            const character = String.fromCharCode(value);
            byteToChar.set(value, character);
            charToByte.set(character, value);
        }

        let extra = 0;

        for (let value = 0; value < 256; value++) {
            if (byteToChar.has(value)) {
                continue;
            }

            const character = String.fromCharCode(256 + extra);
            extra++;
            byteToChar.set(value, character);
            charToByte.set(character, value);
        }

        this.byteEncoder = byteToChar;
        this.byteDecoder = charToByte;
    }

    mergeKey(left, right) {
        return `${left}\\u0000${right}`;
    }

    byteLevelEncode(text) {
        const bytes = new TextEncoder().encode(text);
        let result = '';

        for (const byte of bytes) {
            result += this.byteEncoder.get(byte);
        }

        return result;
    }

    bpe(symbols) {
        let pieces = symbols.map((symbol, index) => ({
            symbol,
            byteStart: index,
            byteEnd: index + 1
        }));

        while (pieces.length > 1) {
            let bestIndex = -1;
            let bestRank = Infinity;

            for (let index = 0; index < pieces.length - 1; index++) {
                const merge = this.merges.get(
                    this.mergeKey(
                        pieces[index].symbol,
                        pieces[index + 1].symbol
                    )
                );

                if (merge && merge.rank < bestRank) {
                    bestRank = merge.rank;
                    bestIndex = index;
                }
            }

            if (bestIndex < 0) {
                break;
            }

            const left = pieces[bestIndex];
            const right = pieces[bestIndex + 1];

            pieces.splice(
                bestIndex,
                2,
                {
                    symbol: left.symbol + right.symbol,
                    byteStart: left.byteStart,
                    byteEnd: right.byteEnd
                }
            );
        }

        return pieces;
    }

    preTokenize(text) {
        const regex =
            /(?:'s|'t|'re|'ve|'m|'ll|'d)| ?[\p{L}]+| ?[\p{N}]+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

        const parts = [];
        let match;

        while ((match = regex.exec(text)) !== null) {
            parts.push({
                text: match[0],
                start: match.index,
                end: match.index + match[0].length
            });
        }

        return parts;
    }

    buildByteBoundaries(text) {
        const boundaries = [0];
        let byteOffset = 0;
        const encoder = new TextEncoder();

        for (const character of text) {
            byteOffset += encoder.encode(character).length;
            boundaries.push(byteOffset);
        }

        return boundaries;
    }

    byteToCharStart(boundaries, byteOffset) {
        let low = 0;
        let high = boundaries.length - 1;

        while (low < high) {
            const middle = Math.floor((low + high + 1) / 2);
            if (boundaries[middle] <= byteOffset) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }

        return low;
    }

    byteToCharEnd(boundaries, byteOffset) {
        let low = 0;
        let high = boundaries.length - 1;

        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (boundaries[middle] >= byteOffset) {
                high = middle;
            } else {
                low = middle + 1;
            }
        }

        return low;
    }

    trimOffset(text, start, end) {
        while (start < end && /\s/u.test(text[start])) {
            start++;
        }

        while (end > start && /\s/u.test(text[end - 1])) {
            end--;
        }

        return { start, end };
    }

    tokenize(text) {
        if (!this.initialized || !text) {
            return [];
        }

        const normalizedText =
            typeof text.normalize === 'function'
                ? text.normalize('NFC')
                : text;

        const normalizedToOriginal =
            normalizedText === text
                ? null
                : this.buildNormalizationMap(text, normalizedText);

        const tokens = [];

        for (const part of this.preTokenize(normalizedText)) {
            const byteEncoded = this.byteLevelEncode(part.text);
            const pieces = this.bpe(Array.from(byteEncoded));
            const boundaries = this.buildByteBoundaries(part.text);

            for (const piece of pieces) {
                let start = part.start +
                    this.byteToCharStart(boundaries, piece.byteStart);
                let end = part.start +
                    this.byteToCharEnd(boundaries, piece.byteEnd);

                ({ start, end } = this.trimOffset(
                    normalizedText,
                    start,
                    end
                ));

                if (normalizedToOriginal) {
                    start = normalizedToOriginal[start] ?? start;
                    end = normalizedToOriginal[end] ?? end;
                }

                const id = this.vocab.get(piece.symbol);

                if (!Number.isInteger(id)) {
                    continue;
                }

                tokens.push({ id, start, end });
            }
        }

        return tokens;
    }

    buildNormalizationMap(original, normalized) {
        const map = new Array(normalized.length + 1);
        map[0] = 0;
        let normalizedCursor = 0;

        for (let originalCursor = 0; originalCursor < original.length;) {
            const character = original[originalCursor];
            const nextOriginalCursor =
                originalCursor + character.length;
            const normalizedPrefix =
                original.slice(0, nextOriginalCursor).normalize('NFC');

            while (
                normalizedCursor < normalizedPrefix.length &&
                normalizedCursor < map.length
            ) {
                map[normalizedCursor] = nextOriginalCursor;
                normalizedCursor++;
            }

            originalCursor = nextOriginalCursor;
        }

        map[normalized.length] = original.length;

        for (let index = 1; index < map.length; index++) {
            if (map[index] === undefined) {
                map[index] = map[index - 1];
            }
        }

        return map;
    }
}

class LocalPiiNer {
    constructor() {
        this.session = null;
        this.inputNames = {};
        this.inputMetadata = {};
        this.tokenizer = null;
        this.labelNames = ['O'];
        this.maxLength = 512;
        this.minConfidence = 0.5;
        this.loggedInferenceDiagnostics = false;
        this.isOffscreenContext =
            typeof location !== 'undefined' &&
            location.protocol === 'chrome-extension:';
    }

    async initialize() {
        if (!this.isOffscreenContext) {
            return true;
        }

        if (!window.ort) {
            throw new Error('ONNX Runtime Web is unavailable');
        }

        const modelUrl = chrome.runtime.getURL(
            'models/pii-master-ner-m/model.onnx'
        );
        const externalDataUrl = chrome.runtime.getURL(
            'models/pii-master-ner-m/model.onnx.data'
        );
        const tokenizerUrl = chrome.runtime.getURL(
            'models/pii-master-ner-m/tokenizer.json'
        );
        const configUrl = chrome.runtime.getURL(
            'models/pii-master-ner-m/config.json'
        );

        const [configResponse, tokenizer] = await Promise.all([
            fetch(configUrl),
            (async () => {
                const instance = new LocalPiiTokenizer();
                await instance.initialize(tokenizerUrl);
                return instance;
            })()
        ]);

        if (!configResponse.ok) {
            throw new Error(
                `Could not load PII model config: ${configResponse.status}`
            );
        }

        const modelConfig = await configResponse.json();
        this.tokenizer = tokenizer;
        this.labelNames =
            Array.isArray(modelConfig?.label_names) &&
            modelConfig.label_names.length > 0
                ? modelConfig.label_names
                : ['O'];

        this.maxLength =
            Number(modelConfig?.config?.max_length) ||
            Number(modelConfig?.max_length) ||
            tokenizer.maxLength ||
            512;

        this.minConfidence =
            Number.isFinite(Number(modelConfig?.min_confidence))
                ? Number(modelConfig.min_confidence)
                : 0.5;

        Logger.log('PRIVACY', 'Loading pii-master-ner-m ONNX model');

        const sessionOptions = {
            graphOptimizationLevel: 'all',
            externalData: [
                {
                    path: 'model.onnx.data',
                    data: externalDataUrl
                }
            ]
        };

        try {
            if (!navigator.gpu) {
                throw new Error('WebGPU is not available in this context');
            }

            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                throw new Error('WebGPU adapter is unavailable');
            }

            this.session = await window.ort.InferenceSession.create(
                modelUrl,
                {
                    ...sessionOptions,
                    executionProviders: ['webgpu']
                }
            );

            Logger.log(
                'PRIVACY',
                'pii-master-ner-m WebGPU initialized successfully'
            );
        } catch (webgpuError) {
            Logger.warn(
                'PRIVACY',
                'PII NER WebGPU initialization failed; falling back to WASM',
                webgpuError
            );

            this.session = await window.ort.InferenceSession.create(
                modelUrl,
                {
                    ...sessionOptions,
                    executionProviders: ['wasm']
                }
            );

            Logger.log(
                'PRIVACY',
                'pii-master-ner-m WASM fallback initialized successfully'
            );
        }

        for (const inputName of this.session.inputNames || []) {
            this.inputNames[inputName.toLowerCase()] = inputName;
        }

        for (const metadata of this.session.inputMetadata || []) {
            if (metadata?.name) {
                this.inputMetadata[metadata.name] = metadata;
            }
        }

        Logger.log('PRIVACY', 'pii-master-ner-m loaded', {
            model: 'pii-master-ner-m',
            maxLength: this.maxLength,
            labelCount: this.labelNames.length,
            inputs: this.session.inputNames || [],
            outputs: this.session.outputNames || []
        });

        return true;
    }

    async infer(text) {
        if (!this.isOffscreenContext) {
            const response = await chrome.runtime.sendMessage({
                type: 'run_offscreen_pii',
                text
            });

            if (!response?.success) {
                throw new Error(
                    response?.error || 'Offscreen PII inference failed'
                );
            }

            return Array.isArray(response.entities)
                ? response.entities
                : [];
        }

        return this.detect(text);
    }

    tensorTypeForInput(inputName) {
        const metadata = this.inputMetadata[inputName];
        const type = String(metadata?.type || '').toLowerCase();

        if (type.includes('int32')) {
            return 'int32';
        }

        return 'int64';
    }

    createInputTensor(inputName, values) {
        const tensorType = this.tensorTypeForInput(inputName);

        if (tensorType === 'int32') {
            return new window.ort.Tensor(
                'int32',
                Int32Array.from(values),
                [1, this.maxLength]
            );
        }

        return new window.ort.Tensor(
            'int64',
            BigInt64Array.from(
                values,
                value => BigInt(value)
            ),
            [1, this.maxLength]
        );
    }

    buildFeeds(tokens) {
        const inputIds = new Array(this.maxLength).fill(
            this.tokenizer.padId
        );
        const attentionMask = new Array(this.maxLength).fill(0);
        const tokenTypeIds = new Array(this.maxLength).fill(0);

        inputIds[0] = this.tokenizer.clsId;
        attentionMask[0] = 1;

        const usable = tokens.slice(
            0,
            this.maxLength - 2
        );

        for (let index = 0; index < usable.length; index++) {
            inputIds[index + 1] = usable[index].id;
            attentionMask[index + 1] = 1;
        }

        const separatorIndex = usable.length + 1;
        inputIds[separatorIndex] = this.tokenizer.sepId;
        attentionMask[separatorIndex] = 1;

        const feeds = {};
        const inputNames = this.session.inputNames || [];

        if (inputNames.length === 0) {
            throw new Error('PII model exposes no input tensors');
        }

        for (const inputName of inputNames) {
            const normalized = inputName.toLowerCase();

            if (
                normalized === 'input_ids' ||
                normalized === 'ids' ||
                normalized === 'input'
            ) {
                feeds[inputName] =
                    this.createInputTensor(
                        inputName,
                        inputIds
                    );
                continue;
            }

            if (
                normalized === 'attention_mask' ||
                normalized === 'attention'
            ) {
                feeds[inputName] =
                    this.createInputTensor(
                        inputName,
                        attentionMask
                    );
                continue;
            }

            if (
                normalized === 'token_type_ids' ||
                normalized === 'token_type'
            ) {
                feeds[inputName] =
                    this.createInputTensor(
                        inputName,
                        tokenTypeIds
                    );
                continue;
            }

            if (inputNames.length === 1) {
                feeds[inputName] =
                    this.createInputTensor(
                        inputName,
                        inputIds
                    );
            }
        }

        if (Object.keys(feeds).length === 0) {
            feeds[inputNames[0]] =
                this.createInputTensor(
                    inputNames[0],
                    inputIds
                );
        }

        return {
            feeds,
            usable,
            activeLength: separatorIndex + 1
        };
    }

    findLogits(outputs) {
        for (const name of ['logits', 'output']) {
            if (outputs[name]?.dims?.length === 3) {
                return outputs[name];
            }
        }

        for (const tensor of Object.values(outputs)) {
            if (tensor?.dims?.length === 3) {
                return tensor;
            }
        }

        return null;
    }

    async detect(text) {
        if (!this.session || !this.tokenizer || !text?.trim()) {
            return [];
        }

        const tokens = this.tokenizer.tokenize(text);

        if (!tokens.length) {
            return [];
        }

        const {
            feeds,
            usable,
            activeLength
        } = this.buildFeeds(tokens);

        const outputs = await this.session.run(feeds);
        const logits = this.findLogits(outputs);

        if (!logits) {
            throw new Error(
                'pii-master-ner-m logits output was not found'
            );
        }

        if (!this.loggedInferenceDiagnostics) {
            Logger.log(
                'PRIVACY',
                'pii-master-ner-m inference tensors',
                {
                    textLength: text.length,
                    tokenCount: usable.length,
                    activeLength,
                    outputTensors: Object.fromEntries(
                        Object.entries(outputs).map(
                            ([name, tensor]) => [
                                name,
                                {
                                    dims: tensor?.dims || null,
                                    length: tensor?.data?.length || 0
                                }
                            ]
                        )
                    )
                }
            );
        }

        const entities = this.decodeLogits(
            logits,
            usable,
            activeLength
        );

        if (entities.length > 0) {
            Logger.log(
                'PRIVACY',
                'pii-master-ner-m detected local PII',
                {
                    detectedCount: entities.length,
                    entities: entities.map(entity => ({
                        type: entity.type,
                        text: text.slice(
                            entity.start,
                            entity.end
                        ),
                        start: entity.start,
                        end: entity.end,
                        confidence: Number(
                            entity.confidence.toFixed(4)
                        )
                    }))
                }
            );
        } else {
            Logger.log(
                'PRIVACY',
                'pii-master-ner-m found no PII candidates',
                {
                    textLength: text.length
                }
            );
        }

        if (!this.loggedInferenceDiagnostics) {
            Logger.log(
                'PRIVACY',
                'pii-master-ner-m decoded result',
                {
                    entities: entities.map(entity => ({
                        type: entity.type,
                        start: entity.start,
                        end: entity.end,
                        confidence: Number(
                            entity.confidence.toFixed(4)
                        )
                    }))
                }
            );

            this.loggedInferenceDiagnostics = true;
        }

        return entities;
    }

    decodeLogits(tensor, tokens, activeLength) {
        const dims = tensor.dims || [];
        const sequenceLength = Number(dims[1]);
        const labelCount = Number(dims[2]);

        if (
            !Number.isFinite(sequenceLength) ||
            !Number.isFinite(labelCount) ||
            labelCount <= 0
        ) {
            throw new Error(
                `Unsupported PII logits shape: ${JSON.stringify(dims)}`
            );
        }

        const data = tensor.data;
        const entities = [];
        let current = null;

        const limit = Math.min(
            sequenceLength - 1,
            activeLength - 1,
            tokens.length + 1
        );

        for (
            let position = 1;
            position < limit;
            position++
        ) {
            const offset = position * labelCount;
            let bestIndex = 0;
            let bestScore = -Infinity;

            for (
                let label = 0;
                label < labelCount;
                label++
            ) {
                const score =
                    Number(data[offset + label]);

                if (score > bestScore) {
                    bestScore = score;
                    bestIndex = label;
                }
            }

            const labelName =
                this.labelNames[bestIndex] || 'O';
            const token = tokens[position - 1];

            if (
                !token ||
                labelName === 'O' ||
                !/^[BI]-/u.test(labelName)
            ) {
                if (current) {
                    entities.push(current);
                    current = null;
                }
                continue;
            }

            const prefix = labelName.slice(0, 1);
            const entityType = labelName.slice(2);
            const confidence = this.softmaxMax(
                data,
                offset,
                labelCount
            );

            if (confidence < this.minConfidence) {
                if (current) {
                    entities.push(current);
                    current = null;
                }
                continue;
            }

            if (
                !current ||
                prefix === 'B' ||
                current.type !== entityType
            ) {
                if (current) {
                    entities.push(current);
                }

                current = {
                    type: entityType,
                    start: token.start,
                    end: token.end,
                    confidence
                };
            } else {
                current.end = token.end;
                current.confidence =
                    Math.min(
                        current.confidence,
                        confidence
                    );
            }
        }

        if (current) {
            entities.push(current);
        }

        return this.mergeOverlappingEntities(
            entities
        );
    }

    mergeOverlappingEntities(entities) {
        const sorted = [...entities].sort(
            (a, b) =>
                a.start - b.start ||
                b.end - a.end
        );
        const merged = [];

        for (const entity of sorted) {
            const previous =
                merged[merged.length - 1];

            if (
                previous &&
                entity.start < previous.end
            ) {
                if (entity.end > previous.end) {
                    previous.end = entity.end;
                }

                previous.confidence = Math.max(
                    previous.confidence,
                    entity.confidence
                );
                continue;
            }

            merged.push({ ...entity });
        }

        return merged;
    }

    softmaxMax(data, offset, count) {
        let maxLogit = -Infinity;

        for (let index = 0; index < count; index++) {
            maxLogit = Math.max(
                maxLogit,
                Number(data[offset + index])
            );
        }

        let sum = 0;

        for (let index = 0; index < count; index++) {
            sum += Math.exp(
                Number(data[offset + index]) -
                maxLogit
            );
        }

        return sum > 0 ? 1 / sum : 0;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        LocalPiiNer,
        LocalPiiTokenizer
    };
}
