"""
Privacy Browser Agent - Production-Grade Agentic Server
Handles session management, Groq-powered agent reasoning, action validation, and privacy protection.

Architecture:
- Session-scoped state management (per user/browser)
- Groq LLM for agent reasoning
- Structured action validation with Pydantic
- DOM element verification with fingerprinting
- Step-by-step agent loop (one action at a time)
- Comprehensive PII protection
"""

import os
import sys
import json
import base64
import logging
import asyncio
import uuid
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta
from io import BytesIO
from enum import Enum

from fastapi import FastAPI, HTTPException, File, UploadFile, BackgroundTasks
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from pydantic import field_validator

# Image processing
from PIL import Image
import numpy as np

# Groq API
from groq import Groq

# Load environment variables
load_dotenv()

# ============================================================================
# CONFIGURATION
# ============================================================================

GROQ_API_KEY = os.getenv('GROQ_API_KEY', '')
GROQ_MODEL = os.getenv('GROQ_MODEL', 'mixtral-8x7b-32768')
SERVER_HOST = os.getenv('SERVER_HOST', '0.0.0.0')
SERVER_PORT = int(os.getenv('SERVER_PORT', '8000'))
LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
CORS_ORIGINS = os.getenv('CORS_ORIGINS', 'http://localhost:3000,chrome-extension://*').split(',')
MAX_AGENT_STEPS = int(os.getenv('MAX_AGENT_STEPS', '20'))
ACTION_TIMEOUT = int(os.getenv('ACTION_TIMEOUT', '30000'))  # ms
AGENT_TIMEOUT = int(os.getenv('AGENT_TIMEOUT', '60000'))   # ms
MIN_REDACTION_COVERAGE = float(os.getenv('MIN_REDACTION_COVERAGE', '0.8'))

# Setup logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Validate Groq API key
if not GROQ_API_KEY:
    logger.warning("GROQ_API_KEY not set. Agent reasoning will be disabled.")

# ============================================================================
# ENUMS
# ============================================================================

class ActionType(str, Enum):
    """Supported action types - ONLY these are allowed"""
    CLICK = "click"
    TYPE = "type"
    CLEAR = "clear"
    FOCUS = "focus"
    SELECT = "select"
    SCROLL = "scroll"
    PRESS_KEY = "press_key"
    HOVER = "hover"
    WAIT = "wait"
    NAVIGATE = "navigate"
    BACK = "back"
    FORWARD = "forward"
    EXTRACT = "extract"
    FINISH = "finish"
    @field_validator("type", mode="before")
    def normalize_action_type(cls, value):
        if isinstance(value, str):
            value = value.strip().lower()

            try:
                return ActionType(value)
            except ValueError:
                raise ValueError(
                    f"Invalid action type: {value}"
                )

        return value


class SessionStatus(str, Enum):
    """Session lifecycle states"""
    INITIALIZED = "initialized"
    OBSERVING = "observing"
    REASONING = "reasoning"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    ERROR = "error"


class ErrorCode(str, Enum):
    """Structured error codes"""
    STALE_ELEMENT_REFERENCE = "stale_element_reference"
    ELEMENT_NOT_FOUND = "element_not_found"
    ACTION_TIMEOUT = "action_timeout"
    INVALID_ACTION = "invalid_action"
    PRIVACY_VIOLATION = "privacy_violation"
    GROQ_ERROR = "groq_error"
    SESSION_NOT_FOUND = "session_not_found"
    MAX_STEPS_EXCEEDED = "max_steps_exceeded"
    NAVIGATION_DETECTED = "navigation_detected"
    EXECUTION_ERROR = "execution_error"


# ============================================================================
# DATA MODELS
# ============================================================================

class BoundingBox(BaseModel):
    """Element bounding box"""
    x: float
    y: float
    width: float
    height: float


class ElementMetadata(BaseModel):
    """Safe element metadata sent to agent (NO sensitive values)"""
    agent_element_id: str
    tag: str
    role: Optional[str] = None
    element_type: Optional[str] = None
    text_preview: Optional[str] = None
    placeholder: Optional[str] = None
    aria_label: Optional[str] = None
    visible: bool = True
    enabled: bool = True
    interactive: bool = False
    sensitive: bool = False
    sensitive_type: Optional[str] = None  # "password", "email", "credit_card", etc.
    bbox: BoundingBox
    
    class Config:
        use_enum_values = True


class PageObservation(BaseModel):
    """Page state observation sent to agent"""
    observation_id: str = Field(default_factory=lambda: f"obs_{uuid.uuid4().hex[:8]}")
    page_revision: int = 0
    url: str
    title: str
    viewport_width: int
    viewport_height: int
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    elements: List[ElementMetadata]
    screenshot_available: bool = False
    
    class Config:
        use_enum_values = True


class Action(BaseModel):
    """Action returned by Groq agent"""
    action_id: str = Field(default_factory=lambda: f"act_{uuid.uuid4().hex[:8]}")
    type: ActionType
    element_id: Optional[str] = None  # Must match an agent_element_id from observation
    text: Optional[str] = None  # For TYPE action
    direction: Optional[str] = None  # For SCROLL: "up", "down", "left", "right"
    amount: Optional[int] = None  # For SCROLL: pixels
    duration_ms: Optional[int] = None  # For WAIT: milliseconds
    key: Optional[str] = None  # For PRESS_KEY: "Enter", "Tab", etc.
    url: Optional[str] = None  # For NAVIGATE
    selector: Optional[str] = None  # For EXTRACT: what to extract
    reason: str = ""  # Why this action is being taken
    
    class Config:
        use_enum_values = True
    
    @field_validator('type')
    def validate_type(cls, v):
        if isinstance(v, str):
            try:
                return ActionType(v.lower())
            except ValueError:
                raise ValueError(f"Invalid action type: {v}")
        return v


class ActionResult(BaseModel):
    """Result of executing an action"""
    action_id: str
    success: bool
    error_code: Optional[ErrorCode] = None
    error_message: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    duration_ms: int = 0
    new_observation: Optional[PageObservation] = None


class AgentMessage(BaseModel):
    """Message sent to Groq agent"""
    role: str = "user"
    content: str


class GroqResponse(BaseModel):
    """Structured response from Groq"""
    status: str  # "CONTINUE", "FINISHED", "FAILED"
    reasoning_summary: str
    action: Optional[Action] = None
    message: Optional[str] = None


# ============================================================================
# SESSION MANAGEMENT
# ============================================================================

class AgentSession:
    """Maintains state for a single agent session"""
    
    def __init__(self, session_id: str, user_goal: str):
        self.session_id = session_id
        self.user_goal = user_goal
        self.created_at = datetime.utcnow()
        self.last_activity = datetime.utcnow()
        
        # State
        self.status = SessionStatus.INITIALIZED
        self.current_observation: Optional[PageObservation] = None
        self.previous_observation: Optional[PageObservation] = None
        
        # Action tracking
        self.action_history: List[Action] = []
        self.action_results: List[ActionResult] = []
        self.current_step = 0
        
        # Agent context
        self.conversation_history: List[AgentMessage] = []
        self.page_revision = 0
        
        # Error tracking
        self.errors: List[Dict[str, Any]] = []
        self.stale_element_count = 0
        
        logger.info(f"Session created: {session_id} - Goal: {user_goal}")
    
    def add_observation(self, observation: PageObservation):
        """Record page observation"""
        self.previous_observation = self.current_observation
        self.current_observation = observation
        self.page_revision += 1
        self.last_activity = datetime.utcnow()
        logger.info(f"[{self.session_id}] Observation recorded: {len(observation.elements)} elements")
    
    def add_action(self, action: Action):
        """Record planned action"""
        self.action_history.append(action)
        self.current_step += 1
        logger.info(f"[{self.session_id}] Step {self.current_step}: {action.type} on {action.element_id}")
    
    def add_action_result(self, result: ActionResult):
        """Record action result"""
        self.action_results.append(result)
        self.last_activity = datetime.utcnow()
        
        if not result.success:
            self.errors.append({
                'action_id': result.action_id,
                'error_code': result.error_code,
                'error_message': result.error_message,
                'timestamp': datetime.utcnow()
            })
            if result.error_code == ErrorCode.STALE_ELEMENT_REFERENCE:
                self.stale_element_count += 1
    
    def is_expired(self, ttl_seconds: int = 3600) -> bool:
        """Check if session has expired"""
        return (datetime.utcnow() - self.last_activity).total_seconds() > ttl_seconds
    
    def should_stop(self) -> bool:
        """Check if agent should stop (step limit, etc.)"""
        if self.current_step >= MAX_AGENT_STEPS:
            logger.warning(f"[{self.session_id}] Max steps ({MAX_AGENT_STEPS}) reached")
            return True
        if len(self.errors) > 5:
            logger.error(f"[{self.session_id}] Too many errors ({len(self.errors)})")
            return True
        if self.stale_element_count > 3:
            logger.warning(f"[{self.session_id}] Too many stale element references")
            return True
        return False


class SessionManager:
    """Manages multiple agent sessions"""
    
    def __init__(self):
        self.sessions: Dict[str, AgentSession] = {}
        self.lock = asyncio.Lock()
    
    async def create_session(self, user_goal: str) -> str:
        """Create new session"""
        session_id = f"sess_{uuid.uuid4().hex[:12]}"
        async with self.lock:
            self.sessions[session_id] = AgentSession(session_id, user_goal)
        return session_id
    
    async def get_session(self, session_id: str) -> Optional[AgentSession]:
        """Get session by ID"""
        async with self.lock:
            session = self.sessions.get(session_id)
            if session and session.is_expired():
                del self.sessions[session_id]
                logger.info(f"Session expired and removed: {session_id}")
                return None
            return session
    
    async def cleanup_expired(self):
        """Remove expired sessions"""
        async with self.lock:
            expired = [sid for sid, sess in self.sessions.items() if sess.is_expired()]
            for sid in expired:
                del self.sessions[sid]
            if expired:
                logger.info(f"Cleaned up {len(expired)} expired sessions")


# ============================================================================
# GROQ AGENT
# ============================================================================

class GroqAgent:
    """LLM-powered agent using Groq API"""
    
    SYSTEM_PROMPT = """You are a professional browser automation agent. Your role is to help users accomplish their goals on web pages by planning and executing precise actions.

CRITICAL RULES:
1. You can ONLY use element IDs provided in the current observation. DO NOT invent or guess element IDs.
2. Element IDs have format: agent-el-XXX
3. Every action must include:
   - action type (from allowed types)
   - element_id IF the action operates on an element
   - reason explaining why you're taking this action
4. Return ONLY ONE action at a time, wrapped in valid JSON.
5. Never assume an action succeeded - you'll receive the result and can adjust.
6. If the element you need isn't available, re-observe or ask the user.
7. Never request or attempt to use passwords, credit cards, or sensitive data.
8. Stop when the user's goal is accomplished.
9. Always verify your observations before acting.

SUPPORTED ACTION TYPES:
- click: Click on an element
- type: Type text into a focused input (never passwords from server)
- clear: Clear an input field
- focus: Focus an element
- select: Select option in dropdown (provide text or value)
- scroll: Scroll page (direction: up/down/left/right, amount in pixels)
- press_key: Press keyboard key (Enter, Tab, Escape, etc.)
- hover: Hover over element
- wait: Wait for page to settle (duration_ms)
- navigate: Navigate to URL
- back: Browser back button
- forward: Browser forward button
- extract: Extract data from page (text, HTML, etc.)
- finish: Task complete

Always respond with valid JSON matching this format:
{
    "status": "CONTINUE" | "FINISHED" | "FAILED",
    "reasoning_summary": "Brief explanation of your decision",
    "action": {
        "type": "ACTION_TYPE",
        "element_id": "agent-el-123" (if needed),
        "text": "..." (for TYPE),
        "direction": "..." (for SCROLL),
        "amount": 500 (for SCROLL),
        "reason": "Why this action"
    },
    "message": "Any message to user (optional)"
}

For FINISHED: Return action of type FINISH with your final message.
For FAILED: Explain what couldn't be accomplished.
"""
    
    def __init__(self):
        self.client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None
        self.logger = logging.getLogger('GroqAgent')
    
    async def reason(
        self,
        session: AgentSession,
        observation: PageObservation,
        action_result: Optional[ActionResult] = None
    ) -> GroqResponse:
        """Reason about next action using Groq"""
        
        if not self.client:
            self.logger.error("Groq client not initialized")
            return GroqResponse(
                status="FAILED",
                reasoning_summary="Groq API not configured",
                message="Groq API key is not set in environment"
            )
        
        try:
            # Build observation text for LLM
            observation_text = self._format_observation(observation)
            
            # Build previous result if exists
            result_text = ""
            if action_result:
                result_text = f"\n\nPREVIOUS ACTION RESULT:\nAction: {session.action_history[-1].type}\nSuccess: {action_result.success}\nError: {action_result.error_message}\n"
            
            # Build user message
            user_message = f"""
USER GOAL: {session.user_goal}

CURRENT PAGE STATE:
{observation_text}

{result_text}

HISTORY: {len(session.action_history)} actions taken so far.

What is the next action you should take to accomplish the goal?
"""
            
            # Add to conversation history
            # session.conversation_history.append(AgentMessage(role="user", content=user_message))
            messages = [
                {"role": "system", "content": self.SYSTEM_PROMPT},
                {"role": "user", "content": user_message}
            ]
            # Call Groq API
            response = self.client.chat.completions.create(
                model=GROQ_MODEL,
                messages=messages,
                temperature=0.3,  # Lower temperature for reliability
                max_tokens=1000,
                response_format={"type": "json_object"}
            )
            
            # Parse response
            response_text = response.choices[0].message.content
            response_json = json.loads(response_text)
            print("Response Json")
            print(response_json)
            # Validate response
            groq_response = GroqResponse(**response_json)
            
            # Add to conversation history
            # session.conversation_history.append(AgentMessage(role="assistant", content=response_text))
            
            self.logger.info(f"[{session.session_id}] Groq reasoning: {groq_response.reasoning_summary}")
            
            return groq_response
        
        except json.JSONDecodeError as e:
            self.logger.error(f"Failed to parse Groq JSON response: {e}")
            return GroqResponse(
                status="FAILED",
                reasoning_summary="Failed to parse agent response",
                message=f"JSON parsing error: {str(e)}"
            )
        except Exception as e:
            self.logger.error(f"Groq API error: {e}", exc_info=True)
            return GroqResponse(
                status="FAILED",
                reasoning_summary="Groq API error",
                message=f"Error: {str(e)}"
            )
    
    def _format_observation(self, observation: PageObservation) -> str:
        """Format a compact observation for agent reasoning.

        Keep the prompt bounded because the Groq project has a strict TPM limit.
        Only useful interactive metadata is sent to the model; privacy decisions
        and raw pixels remain client-side.
        """
        lines = [
            f"URL: {observation.url[:160]}",
            f"TITLE: {observation.title[:160]}",
            f"VIEWPORT: {observation.viewport_width}x{observation.viewport_height}",
            f"ELEMENT COUNT: {len(observation.elements)}",
            "",
            "AVAILABLE INTERACTIVE ELEMENTS (MAX 60):",
        ]

        interactive = [elem for elem in observation.elements if elem.interactive]
        interactive.sort(key=lambda elem: (not elem.visible, elem.agent_element_id))

        for elem in interactive[:60]:
            parts = [
                f"ID={elem.agent_element_id}",
                f"TAG=<{elem.tag}>",
                f"VISIBLE={elem.visible}",
                f"ENABLED={elem.enabled}",
            ]

            if elem.role:
                parts.append(f"ROLE={str(elem.role)[:40]}")
            if elem.element_type:
                parts.append(f"TYPE={str(elem.element_type)[:30]}")
            if elem.text_preview:
                parts.append(f"TEXT=\"{str(elem.text_preview)[:60]}\"")
            if elem.placeholder:
                parts.append(f"PLACEHOLDER=\"{str(elem.placeholder)[:60]}\"")
            if elem.aria_label:
                parts.append(f"ARIA=\"{str(elem.aria_label)[:60]}\"")
            if elem.sensitive:
                parts.append(f"SENSITIVE={elem.sensitive_type or 'unknown'}")

            lines.append("  - " + " | ".join(parts))

        return "\n".join(lines)

# ============================================================================
# PRIVACY PROTECTION
# ============================================================================

class PrivacyProtector:
    """Ensures sensitive data never reaches the server/LLM"""
    
    SENSITIVE_PATTERNS = {
        'password': r'password|passwd|pwd|pass',
        'email': r'email|e-mail',
        'credit_card': r'card|cc|cardnum|cvv|cvc|expiry',
        'ssn': r'ssn|social.security',
        'phone': r'phone|mobile|cellphone',
        'address': r'address|street|city|zip|postal',
        'dob': r'date.of.birth|dob|birth|birthday',
    }
    
    def __init__(self):
        self.logger = logging.getLogger('PrivacyProtector')
    
    def sanitize_element(self, element_info: Dict[str, Any]) -> ElementMetadata:
        """Convert raw element info to safe metadata"""
        
        # Detect if sensitive
        sensitive_type = self._detect_sensitive_field(element_info)
        
        # Never include actual values for sensitive fields
        text_preview = element_info.get('text', '')
        if sensitive_type:
            text_preview = f"[{sensitive_type.upper()} REDACTED]"
        
        return ElementMetadata(
            agent_element_id=element_info.get('agent_element_id', 'unknown'),
            tag=element_info.get('tag', 'unknown'),
            role=element_info.get('role'),
            element_type=element_info.get('type'),
            text_preview=text_preview[:100] if text_preview else None,
            placeholder=element_info.get('placeholder', '')[:100] if element_info.get('placeholder') else None,
            aria_label=element_info.get('aria_label'),
            visible=element_info.get('visible', True),
            enabled=element_info.get('enabled', True),
            interactive=element_info.get('interactive', False),
            sensitive=bool(sensitive_type),
            sensitive_type=sensitive_type,
            bbox=BoundingBox(**element_info.get('bbox', {}))
        )
    
    def _detect_sensitive_field(self, element_info: Dict[str, Any]) -> Optional[str]:
        """Detect if field is sensitive"""
        
        # Input type is most reliable signal
        elem_type = element_info.get('type', '').lower()
        if elem_type == 'password':
            return 'password'
        if elem_type == 'email':
            return 'email'
        
        # Check name, id, placeholder, aria_label
        combined = " ".join([
            element_info.get('name', ''),
            element_info.get('id', ''),
            element_info.get('placeholder', ''),
            element_info.get('aria_label', '')
        ]).lower()
        
        for sens_type, pattern in self.SENSITIVE_PATTERNS.items():
            import re
            if re.search(pattern, combined):
                return sens_type
        
        return None


# ============================================================================
# INITIALIZE GLOBAL INSTANCES
# ============================================================================

session_manager = SessionManager()
groq_agent = GroqAgent()
privacy_protector = PrivacyProtector()

# ============================================================================
# FASTAPI APP
# ============================================================================

app = FastAPI(
    title="Privacy Browser Agent Server",
    description="Production-grade agentic browser automation with privacy protection",
    version="2.0.0"
)

# Configure CORS carefully
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://github.com",
        "https://www.github.com",
    ],
    allow_origin_regex=r"chrome-extension://.*|moz-extension://.*", 
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# ============================================================================
# REQUEST/RESPONSE MODELS
# ============================================================================

class StartAgentRequest(BaseModel):
    """Request to start agent session"""
    user_goal: str
    page_context: Optional[Dict[str, Any]] = None


class StartAgentResponse(BaseModel):
    """Response with session ID"""
    success: bool
    session_id: str
    message: str


class ObserveRequest(BaseModel):
    """Observation from browser"""
    session_id: str
    observation: PageObservation


class ActionResultRequest(BaseModel):
    """Action result from browser"""
    session_id: str
    result: ActionResult


class GetActionResponse(BaseModel):
    """Next action for browser to execute"""
    success: bool
    action: Optional[Action] = None
    error_code: Optional[ErrorCode] = None
    error_message: Optional[str] = None
    session_status: str


# ============================================================================
# API ENDPOINTS
# ============================================================================

@app.get("/health")
async def health():
    """Health check"""
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}


@app.get("/api/info")
async def info():
    """Server info"""
    return {
        "name": "Privacy Browser Agent Server",
        "version": "2.0.0",
        "groq_configured": bool(GROQ_API_KEY),
        "capabilities": [
            "agentic_reasoning",
            "session_management",
            "privacy_protection",
            "element_verification",
            "action_validation"
        ]
    }


@app.post("/api/agent/start", response_model=StartAgentResponse)
async def start_agent(request: StartAgentRequest):
    """
    Start new agent session
    
    Request:
    {
        "user_goal": "Log in to my account",
        "page_context": {...optional page info...}
    }
    
    Response:
    {
        "success": true,
        "session_id": "sess_abc123...",
        "message": "Session created, awaiting initial observation"
    }
    """
    try:
        session_id = await session_manager.create_session(request.user_goal)
        logger.info(f"Agent session started: {session_id}")
        
        return StartAgentResponse(
            success=True,
            session_id=session_id,
            message="Session created. Send initial observation via /api/agent/observe"
        )
    except Exception as e:
        logger.error(f"Failed to start agent: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/agent/observe")
async def observe(request: ObserveRequest):
    """
    Submit page observation
    Browser sends current DOM state, extension-generated element IDs
    Server reasons about next action
    """
    try:
        # Get session
        session = await session_manager.get_session(request.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        
        # Record observation
        session.add_observation(request.observation)
        session.status = SessionStatus.OBSERVING
        
        # Check for stop conditions
        if session.should_stop():
            session.status = SessionStatus.FAILED
            return GetActionResponse(
                success=False,
                error_code=ErrorCode.MAX_STEPS_EXCEEDED,
                error_message=f"Reached max steps ({MAX_AGENT_STEPS})",
                session_status=session.status.value
            )
        
        # Get action result from previous action (if any)
        action_result = None
        if session.action_results:
            action_result = session.action_results[-1]
        
        # Reason with Groq
        session.status = SessionStatus.REASONING
        groq_response = await groq_agent.reason(session, request.observation, action_result)
        
        if groq_response.status == "FINISHED":
            session.status = SessionStatus.COMPLETED
            return GetActionResponse(
                success=True,
                action=Action(
                    type=ActionType.FINISH,
                    reason=groq_response.message or "Task completed"
                ),
                session_status=session.status.value
            )
        
        if groq_response.status == "FAILED":
            session.status = SessionStatus.FAILED
            return GetActionResponse(
                success=False,
                error_message=groq_response.message,
                session_status=session.status.value
            )
        
        # Validate action
        if not groq_response.action:
            logger.error(f"Groq returned no action: {groq_response}")
            return GetActionResponse(
                success=False,
                error_code=ErrorCode.GROQ_ERROR,
                error_message="Groq returned invalid response",
                session_status=session.status.value
            )
        
        action = groq_response.action
        
        # Validate element reference if needed
        if action.element_id and action.type not in [ActionType.SCROLL, ActionType.WAIT, ActionType.NAVIGATE, ActionType.FINISH]:
            # Verify element exists in current observation
            element_ids = [e.agent_element_id for e in request.observation.elements]
            if action.element_id not in element_ids:
                logger.error(f"Invalid element reference: {action.element_id}")
                return GetActionResponse(
                    success=False,
                    error_code=ErrorCode.ELEMENT_NOT_FOUND,
                    error_message=f"Element {action.element_id} not found in observation",
                    session_status=session.status.value
                )
        
        # Record action
        session.add_action(action)
        session.status = SessionStatus.EXECUTING
        
        logger.info(f"[{session.session_id}] Returning action: {action.type}")
        
        return GetActionResponse(
            success=True,
            action=action,
            session_status=session.status.value
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Observation processing failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/agent/action-result")
async def action_result(request: ActionResultRequest):
    """
    Submit action execution result
    Browser reports whether action succeeded or failed
    Server updates session state and continues agent loop
    """
    try:
        session = await session_manager.get_session(request.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        
        # Record result
        session.add_action_result(request.result)
        
        # Update observation if provided
        if request.result.new_observation:
            session.add_observation(request.result.new_observation)
        
        logger.info(f"[{session.session_id}] Action result: {request.result.success}")
        
        return {
            "success": True,
            "message": "Result recorded"
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Result processing failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/agent/stop")
async def stop_agent(data: Dict[str, str]):
    """Stop agent session"""
    try:
        session = await session_manager.get_session(data.get("session_id"))
        if session:
            session.status = SessionStatus.COMPLETED
            logger.info(f"Session stopped: {session.session_id}")
        
        return {"success": True}
    except Exception as e:
        logger.error(f"Failed to stop agent: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/agent/status/{session_id}")
async def get_status(session_id: str):
    """Get session status"""
    try:
        session = await session_manager.get_session(session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        
        return {
            "session_id": session.session_id,
            "goal": session.user_goal,
            "status": session.status.value,
            "step": session.current_step,
            "max_steps": MAX_AGENT_STEPS,
            "actions_taken": len(session.action_history),
            "errors": len(session.errors),
            "created_at": session.created_at.isoformat(),
            "last_activity": session.last_activity.isoformat()
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/analytics")
async def analytics():
    """Get server analytics"""
    return {
        "active_sessions": len(session_manager.sessions),
        "timestamp": datetime.utcnow().isoformat()
    }


# ============================================================================
# STARTUP/SHUTDOWN
# ============================================================================

@app.on_event("startup")
async def startup():
    """Server startup"""
    logger.info("="*60)
    logger.info("Privacy Browser Agent Server v2.0")
    logger.info("="*60)
    logger.info(f"Groq Model: {GROQ_MODEL}")
    logger.info(f"Max Agent Steps: {MAX_AGENT_STEPS}")
    logger.info(f"Min Redaction Coverage: {MIN_REDACTION_COVERAGE}")
    logger.info(f"CORS Origins: {CORS_ORIGINS}")
    logger.info("Server ready for connections")


@app.on_event("shutdown")
async def shutdown():
    """Server shutdown"""
    logger.info(f"Server shutting down. Sessions: {len(session_manager.sessions)}")


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(
        app,
        host=SERVER_HOST,
        port=SERVER_PORT,
        log_level=LOG_LEVEL.lower()
    )
