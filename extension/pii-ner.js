/**
 * Local text PII NER detector.
 *
 * Runs an optional TinyBERT NER ONNX model in the extension offscreen
 * document. It never sends page text to the server.
 *
 * Expected assets:
 *   models/pii-ner/model_int8.onnx
 *   models/pii-ner/vocab.txt
 */

class LocalPiiNer {
    constructor() {
        this.session = null;
        this.inputNames = {};
        this.vocab = new Map();
        this.maxLength = 128;
        this.entityLabels = new Set([
            'PER',
            'PERSON',
            'LOC',
            'LOCATION',
            'ORG',
            'MISC'
        ]);
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
            'models/pii-ner/model_int8.onnx'
        );
        const vocabUrl = chrome.runtime.getURL(
            'models/pii-ner/vocab.txt'
        );

        const vocabResponse = await fetch(vocabUrl);
        if (!vocabResponse.ok) {
            throw new Error(`Could not load NER vocabulary: ${vocabResponse.status}`);
        }

        const vocabText = await vocabResponse.text();
        vocabText.split(/\\r?\\n/).forEach((token, index) => {
            if (token) {
                this.vocab.set(token, index);
            }
        });

        this.session = await window.ort.InferenceSession.create(
            modelUrl,
            {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all'
            }
        );

        for (const input of this.session.getInputs()) {
            this.inputNames[input.name.toLowerCase()] = input.name;
        }

        return true;
    }

    async infer(text) {
        if (!this.isOffscreenContext) {
            const response = await chrome.runtime.sendMessage({
                type: 'offscreen_pii_request',
                text
            });
            if (!response?.success) {
                throw new Error(response?.error || 'Offscreen PII inference failed');
            }
            return Array.isArray(response.entities) ? response.entities : [];
        }
        return this.detect(text);
    }

    async detect(text) {
        if (!this.session || !text?.trim()) {
            return [];
        }

        const tokens = this.tokenize(text);
        if (!tokens.length) {
            return [];
        }

        const inputIds = new BigInt64Array(this.maxLength);
        const attentionMask = new BigInt64Array(this.maxLength);
        const tokenTypeIds = new BigInt64Array(this.maxLength);

        const clsId = this.vocab.get('[CLS]') ?? 101;
        const sepId = this.vocab.get('[SEP]') ?? 102;
        const padId = this.vocab.get('[PAD]') ?? 0;

        inputIds.fill(BigInt(padId));
        attentionMask.fill(0n);
        tokenTypeIds.fill(0n);

        let position = 0;
        inputIds[position] = BigInt(clsId);
        attentionMask[position] = 1n;
        position++;

        const usable = tokens.slice(0, this.maxLength - 2);

        for (const token of usable) {
            inputIds[position] = BigInt(token.id);
            attentionMask[position] = 1n;
            position++;
        }

        inputIds[position] = BigInt(sepId);
        attentionMask[position] = 1n;

        const makeTensor = (name, data) => {
            const input = this.session.getInputs().find(
                item => item.name === name
            );
            if (!input) {
                return null;
            }

            return new window.ort.Tensor(
                input.type === 'int64' ? 'int64' : 'int64',
                data,
                [1, this.maxLength]
            );
        };

        const feeds = {};
        const inputIdName =
            this.inputNames['input_ids'] ||
            this.session.getInputs()[0]?.name;
        const attentionName =
            this.inputNames['attention_mask'];
        const tokenTypeName =
            this.inputNames['token_type_ids'];

        if (!inputIdName) {
            throw new Error('NER model has no input_ids tensor');
        }

        feeds[inputIdName] = makeTensor(
            inputIdName,
            inputIds
        );

        if (attentionName) {
            feeds[attentionName] = makeTensor(
                attentionName,
                attentionMask
            );
        }

        if (tokenTypeName) {
            feeds[tokenTypeName] = makeTensor(
                tokenTypeName,
                tokenTypeIds
            );
        }

        const outputs = await this.session.run(feeds);
        const logits = this.findLogits(outputs);

        if (!logits) {
            throw new Error('NER model logits output was not found');
        }

        return this.decodeLogits(
            logits,
            usable,
            position
        );
    }

    findLogits(outputs) {
        for (const tensor of Object.values(outputs)) {
            if (tensor?.dims?.length === 3) {
                return tensor;
            }
        }

        return null;
    }

    decodeLogits(tensor, tokens, activeLength) {
        const dims = tensor.dims;
        const sequenceLength = dims[1];
        const labelCount = dims[2];
        const data = tensor.data;
        const entities = [];
        let current = null;

        for (let position = 1; position < Math.min(sequenceLength - 1, activeLength); position++) {
            const offset = position * labelCount;
            let bestIndex = 0;
            let bestScore = -Infinity;

            for (let label = 0; label < labelCount; label++) {
                const score = Number(data[offset + label]);
                if (score > bestScore) {
                    bestScore = score;
                    bestIndex = label;
                }
            }

            const labelName = this.labelFromId(bestIndex);
            const token = tokens[position - 1];

            if (!token || !this.isEntityLabel(labelName)) {
                if (current) {
                    entities.push(current);
                    current = null;
                }
                continue;
            }

            const prefix = labelName.split('-')[0];
            const entityType = labelName.includes('-')
                ? labelName.split('-').slice(1).join('-')
                : labelName;

            if (!current || prefix === 'B' || current.type !== entityType) {
                if (current) {
                    entities.push(current);
                }

                current = {
                    type: entityType,
                    start: token.start,
                    end: token.end,
                    confidence: this.softmaxMax(
                        data,
                        offset,
                        labelCount
                    )
                };
            } else {
                current.end = token.end;
                current.confidence = Math.min(
                    current.confidence,
                    this.softmaxMax(data, offset, labelCount)
                );
            }
        }

        if (current) {
            entities.push(current);
        }

        return entities;
    }

    labelFromId(id) {
        const labels = [
            'O',
            'B-MISC',
            'I-MISC',
            'B-PER',
            'I-PER',
            'B-ORG',
            'I-ORG',
            'B-LOC',
            'I-LOC'
        ];

        return labels[id] || 'O';
    }

    isEntityLabel(label) {
        const type = label.replace(/^[BI]-/, '');
        return this.entityLabels.has(type);
    }

    softmaxMax(data, offset, count) {
        let maxLogit = -Infinity;

        for (let i = 0; i < count; i++) {
            maxLogit = Math.max(
                maxLogit,
                Number(data[offset + i])
            );
        }

        let sum = 0;
        for (let i = 0; i < count; i++) {
            sum += Math.exp(
                Number(data[offset + i]) - maxLogit
            );
        }

        return sum > 0
            ? 1 / sum
            : 0;
    }

    tokenize(text) {
        const tokens = [];
        const parts = text.match(/\\S+/g) || [];

        for (const part of parts) {
            const start = text.indexOf(
                part,
                tokens.length
                    ? tokens[tokens.length - 1].end
                    : 0
            );

            if (start < 0) {
                continue;
            }

            let cursor = start;
            const pieces = this.wordPiece(part);

            for (const piece of pieces) {
                const clean = piece.token.replace(/^##/, '');
                const pieceStart = text.indexOf(
                    clean,
                    cursor
                );

                if (pieceStart < 0) {
                    continue;
                }

                tokens.push({
                    id: piece.id,
                    start: pieceStart,
                    end: pieceStart + clean.length
                });

                cursor = pieceStart + clean.length;
            }
        }

        return tokens;
    }

    wordPiece(word) {
        const result = [];
        let start = 0;

        while (start < word.length) {
            let end = word.length;
            let match = null;

            while (start < end) {
                let candidate = word.slice(start, end);

                if (start > 0) {
                    candidate = `##${candidate}`;
                }

                const id = this.vocab.get(candidate);

                if (id !== undefined) {
                    match = {
                        token: candidate,
                        id
                    };
                    break;
                }

                end--;
            }

            if (!match) {
                const unknownId = this.vocab.get('[UNK]');
                if (unknownId === undefined) {
                    return result;
                }

                result.push({
                    token: word.slice(start),
                    id: unknownId
                });
                break;
            }

            result.push(match);
            start = end;
        }

        return result;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LocalPiiNer };
}
