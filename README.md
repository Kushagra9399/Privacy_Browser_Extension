# Privacy Browser Agent

A privacy-preserving browser agent that combines local browser-side perception and redaction with agentic task execution. Sensitive visual and DOM information is processed locally before any permitted context is sent to a backend reasoning service.

## Overview

The extension is designed around a local privacy boundary:

1. Capture the current browser state.
2. Detect sensitive content locally.
3. Redact sensitive visual regions and sanitize DOM metadata.
4. Build a privacy-safe observation.
5. Use agent reasoning to select the next browser action.
6. Validate and execute the action locally.
7. Repeat until the task finishes or a safety condition stops execution.

The current implementation supports multi-step sessions, stable element references, local ONNX-based privacy processing, server-side reasoning, action validation, and browser-side command execution.

## Architecture

```
Browser Extension
│
├── Content Script
│   ├── Page observation
│   ├── Element registry
│   ├── Privacy filtering
│   ├── Local ONNX vision / PII models
│   ├── Agent loop
│   └── Command execution
│
├── Offscreen AI Runtime
│   └── ONNX Runtime Web / local model execution
│
└── Backend
    ├── Session management
    ├── Privacy validation
    ├── Agent reasoning
    └── Action generation
```

The browser remains responsible for sensitive perception and action execution. The backend receives only the sanitized context required for reasoning.

## Key Features

- **Local privacy processing** using ONNX Runtime Web.
- **PII detection and redaction** for passwords, emails, phone numbers, credit cards, SSNs and contextual text.
- **Local face detection** using a packaged ONNX model.
- **Stable element identification** using browser-side element registration and fingerprints.
- **Multi-step agent loop** with observation, reasoning, execution and verification.
- **Session-scoped state** so separate agent sessions do not share task state.
- **Action safety checks** for stale, detached, hidden, disabled or otherwise non-actionable elements.
- **Natural-language task execution** through the agent loop.
- **Server-side reasoning boundary** so larger reasoning models can be used without moving raw sensitive browser state unnecessarily.
- **Local execution controls** for navigation, clicking, typing, selection, scrolling, keyboard actions and extraction.

## Project Structure

```
Privacy_Browser_Extension/
├── extension/
│   ├── manifest.json
│   ├── content.js
│   ├── background.js
│   ├── agent-loop.js
│   ├── session-manager.js
│   ├── command-executor.js
│   ├── privacy-filter.js
│   ├── vision-processor.js
│   ├── onnx-vision-model.js
│   ├── pii-ner.js
│   ├── agent-floating-ui.js
│   ├── popup.html
│   ├── popup.js
│   ├── popup.css
│   ├── utils.js
│   ├── offscreen.html
│   ├── offscreen.js
│   └── models/
│
└── server/
    ├── main.py
    ├── requirements.txt
    └── .env.example
```

## Local Privacy Models

The privacy layer is designed so raw sensitive content does not need to leave the browser.

Current local components include:

- **YuNet ONNX face detector** for local face detection.
- **Local PII NER ONNX model** for contextual text entities.
- **Deterministic DOM and pattern-based detection** for passwords, emails, phones, credit cards and other sensitive fields.
- **ONNX Runtime Web** for browser-side inference.

See `extension/models/README.md` for model setup and verification.

## Agent Execution Flow

```
User Goal
   ↓
Observe Browser State
   ↓
Local Privacy Detection
   ↓
Redact / Sanitize
   ↓
Agent Reasoning
   ↓
Generate One Action
   ↓
Validate Target Locally
   ↓
Execute Action
   ↓
Observe Updated State
   ↓
Repeat
```

The agent stops when the goal is completed, the safety limits are reached, repeated actions indicate no progress, or an action cannot be safely executed.

## Running Locally

### Backend

```bash
cd server
pip install -r requirements.txt
python main.py
```

The backend runs on `http://localhost:8000` by default.

Set the required environment variables in `server/.env`, including the configured reasoning provider/API key.

### Browser Extension

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository's `extension/` directory.
5. Start the backend if server-side reasoning is enabled.
6. Open the extension and provide a natural-language browser task.

## Privacy Boundary

The privacy design separates sensitive perception from agent reasoning.

### Kept local

- Raw screenshots and pixels used by local privacy processing.
- Sensitive input values.
- Local face detection.
- Local PII detection and redaction.
- Browser-side action execution.
- Element references and validation state.

### Sent for reasoning

Only the sanitized observation required by the agent is intended to cross the privacy boundary. Sensitive values are represented by safe metadata or redacted placeholders rather than their original contents.

This architecture does not claim that every possible form of sensitive information can be detected automatically. New detectors and validation layers should be added as the system evolves.

## Safety

The action executor validates targets before interacting with the page. It checks conditions such as:

- Element existence and connectivity.
- Visibility and pointer interaction.
- Disabled or inert state.
- Viewport and actionable position.
- Stable element references.
- Stale element references after DOM changes.

The agent loop also limits repeated failures and repeated actions to avoid uncontrolled execution.

## Development

Useful implementation areas:

- `extension/content.js` — browser integration and observation lifecycle.
- `extension/agent-loop.js` — multi-step orchestration.
- `extension/session-manager.js` — session state and element registry.
- `extension/command-executor.js` — browser action execution and validation.
- `extension/privacy-filter.js` — privacy detection and redaction.
- `extension/vision-processor.js` — local visual processing.
- `extension/onnx-vision-model.js` — ONNX model execution.
- `extension/pii-ner.js` — local contextual PII detection.
- `server/main.py` — backend sessions, privacy validation and reasoning.

## Future Enhancements

- **Privacy middleware for external AI agents:** expose the browser privacy layer as a reusable agent component that can sit between browser state and systems such as Claude-based agents, coding SDKs, or other autonomous agent runtimes.
- **Claude and coding-agent integration:** allow coding assistants and SDK-driven agents to interact with browser workflows while the extension enforces local privacy and redaction before context is shared.
- **Autonomous agent compatibility:** provide a standard observation/action interface so different agent frameworks can use the same privacy boundary.
- **Local-first reasoning:** move more planning and decision-making into browser-local models when hardware and model size permit.
- **Improved multimodal perception:** add stronger local OCR, document understanding and UI element detection.
- **Configurable privacy policies:** allow users or organizations to define additional sensitive-data classes and site-specific rules.
- **Human approval controls:** require confirmation before sensitive or irreversible actions.
- **Policy-aware execution:** enforce domain, action and data-sharing policies before an autonomous agent can act.
- **Model and provider abstraction:** support multiple local and remote reasoning providers without changing the browser-side privacy layer.
- **Enterprise deployment:** add centralized policy management, auditing and controlled deployment for organizational environments.

## License

MIT License.
