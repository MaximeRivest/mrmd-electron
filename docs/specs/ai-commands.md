# mrmd-electron AI Commands Specification

> AI-powered text and code transformation commands for mrmd-electron.

**Mission:** Provide context-aware AI transformations through a progressive quality/cost model (Juice Levels), enabling users to fix grammar, complete sentences, document code, and more.

**Depends on:** `mrmd-ai` for backend DSPy modules, `mrmd-editor` for editor integration.

---

## Architecture Overview

```output
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MRMD-ELECTRON AI COMMANDS                            │
└─────────────────────────────────────────────────────────────────────────────┘

    USER ACTION                    FRONTEND                      BACKEND
    ───────────                    ────────                      ───────

    Click button ──────────►  ┌──────────────┐
    (data-cmd="fix-grammar")  │  AI Panel    │
                              │  (index.html)│
                              └──────┬───────┘
                                     │
                                     ▼
                              ┌──────────────┐
                              │ AI_COMMANDS  │  ◄── Command Registry
                              │  {           │      (declarative config)
                              │   program,   │
                              │   resultField│
                              │   type,      │
                              │   buildParams│
                              │  }           │
                              └──────┬───────┘
                                     │
                                     ▼
                              ┌──────────────┐
                              │ getAiContext │  ◄── Context Extraction
                              │  {           │      (ai-integration.js)
                              │   selectedText,
                              │   localContext,      ±500 chars
                              │   documentContext    full doc
                              │  }           │
                              └──────┬───────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
         ▼                           ▼                           ▼
    ┌─────────┐               ┌─────────────┐             ┌───────────┐
    │ aiState │               │  aiClient   │────────────►│ FastAPI   │
    │ loading │               │  .execute() │   HTTP      │ server.py │
    │ shimmer │               └─────────────┘   POST      └─────┬─────┘
    └─────────┘                     │                           │
                                    │                           ▼
                              Headers:                    ┌───────────┐
                              X-Juice-Level: 1           │ PROGRAMS  │
                              X-Reasoning-Level: 1       │ registry  │
                                    │                    └─────┬─────┘
                                    │                          │
                                    │                          ▼
                                    │                    ┌───────────────┐
                                    │                    │ JuicedProgram │
                                    │                    │ (juice.py)    │
                                    │                    │               │
                                    │                    │ Selects LM:   │
                                    │                    │ 0: Grok 4.1   │
                                    │                    │ 1: Sonnet 4.5 │
                                    │                    │ 2: Gemini 3   │
                                    │                    │ 3: Opus 4.5   │
                                    │                    │ 4: Multi-LM   │
                                    │                    └───────┬───────┘
                                    │                            │
                                    │                            ▼
                                    │                    ┌───────────────┐
                                    │                    │ DSPy Module   │
                                    │                    │ (e.g.         │
                                    │                    │ FixGrammar-   │
                                    │                    │   Predict)    │
                                    │                    │               │
                                    │                    │ Uses:         │
                                    │                    │ DSPy Signature│
                                    │                    │ (prompt +     │
                                    │                    │  typed I/O)   │
                                    │                    └───────┬───────┘
                                    │                            │
                                    │                     LiteLLM│call
                                    │                            ▼
                                    │                    ┌───────────────┐
                                    │                    │     LLM       │
                                    │                    │ (Claude/Grok/ │
                                    │                    │  Gemini)      │
                                    │                    └───────┬───────┘
                                    │                            │
                                    ◄────────────────────────────┘
                                    │         JSON response:
                                    │         { fixed_text: "...",
                                    │           _model: "...",
                                    │           _juice_level: 1 }
                                    ▼
                              ┌─────────────┐
                              │ Apply to    │
                              │ Editor      │
                              │             │
                              │ type=replace│──► Replace selection
                              │ type=insert │──► Insert at cursor
                              └──────┬──────┘
                                     │
                                     ▼
                              ┌─────────────┐
                              │ aiState     │
                              │ pending     │  ◄── Blue shimmer + ✓/✕
                              │ shimmer     │
                              └──────┬──────┘
                                     │
         ┌───────────────────────────┴───────────────────────────┐
         │                                                       │
         ▼                                                       ▼
    ┌─────────┐                                           ┌─────────┐
    │ ACCEPT  │  Enter key                                │ REJECT  │  Escape
    │ ✓       │──────────────►  Finalize text             │ ✕       │──────────►  Restore
    └─────────┘                                           └─────────┘            original
```

---

## 1. Command Registry

The command registry defines all available AI commands declaratively.

### 1.1 Interface

```typescript
interface CommandDefinition {
  program: string;                    // Backend DSPy module name
  resultField: string;                // Response field to extract
  type: 'insert' | 'replace';         // How to apply result
  requiresSelection: boolean;         // Needs text selected?
  codeOnly?: boolean;                 // Only in code cells?
  insertAtEnd?: boolean;              // Insert at document end?
  buildParams: (ctx: AiContext, lang?: string) => Record<string, any>;
}

interface AiContext {
  textBeforeCursor: string;           // ~500 chars before cursor
  textAfterCursor: string;            // ~500 chars after cursor
  localContext: string;               // ±500 chars around selection
  selectedText: string;               // Currently selected text
  cursorPos: number;                  // Cursor position in doc
  selectionFrom: number;              // Selection start
  selectionTo: number;                // Selection end
  documentContext: string;            // Full document content
}
```

### 1.2 Registry Definition

Location: `index.html:4900-5034`

```javascript
const AI_COMMANDS = {
  'fix-grammar': {
    program: 'FixGrammarPredict',
    resultField: 'fixed_text',
    type: 'replace',
    requiresSelection: true,
    buildParams: (ctx) => ({
      text_to_fix: ctx.selectedText,
      local_context: ctx.localContext,
      document_context: ctx.documentContext,
    }),
  },

  'fix-transcription': {
    program: 'FixTranscriptionPredict',
    resultField: 'fixed_text',
    type: 'replace',
    requiresSelection: true,
    buildParams: (ctx) => ({
      text_to_fix: ctx.selectedText,
      local_context: ctx.localContext,
      document_context: ctx.documentContext,
    }),
  },

  'finish-sentence': {
    program: 'FinishSentencePredict',
    resultField: 'completion',
    type: 'insert',
    requiresSelection: false,
    buildParams: (ctx) => ({
      text_before_cursor: ctx.textBeforeCursor,
      local_context: ctx.localContext,
      document_context: ctx.documentContext,
    }),
  },

  'finish-paragraph': {
    program: 'FinishParagraphPredict',
    resultField: 'completion',
    type: 'insert',
    requiresSelection: false,
    buildParams: (ctx) => ({
      text_before_cursor: ctx.textBeforeCursor,
      local_context: ctx.localContext,
      document_context: ctx.documentContext,
    }),
  },

  'finish-code-line': {
    program: 'FinishCodeLinePredict',
    resultField: 'completion',
    type: 'insert',
    requiresSelection: false,
    codeOnly: true,
    buildParams: (ctx, lang) => ({
      code_before_cursor: ctx.textBeforeCursor,
      language: lang || 'python',
      local_context: ctx.localContext,
      document_context: ctx.documentContext,
    }),
  },

  'finish-code-section': {
    program: 'FinishCodeSectionPredict',
    resultField: 'completion',
    type: 'insert',
    requiresSelection: false,
    codeOnly: true,
    buildParams: (ctx, lang) => ({
      code_before_cursor: ctx.textBeforeCursor,
      language: lang || 'python',
      local_context: ctx.localContext,
      document_context: ctx.documentContext,
    }),
  },

  'document-code': {
    program: 'DocumentCodePredict',
    resultField: 'documented_code',
    type: 'replace',
    requiresSelection: true,
    codeOnly: true,
    buildParams: (ctx, lang) => ({
      code: ctx.selectedText,
      language: lang || 'python',
      local_context: ctx.localContext,
      document_context: ctx.documentContext,
    }),
  },

  'add-types': {
    program: 'AddTypeHintsPredict',
    resultField: 'typed_code',
    type: 'replace',
    requiresSelection: true,
    codeOnly: true,
    buildParams: (ctx, lang) => ({
      code: ctx.selectedText,
      language: lang || 'python',
      local_context: ctx.localContext,
      document_context: ctx.documentContext,
    }),
  },

  'improve-names': {
    program: 'ImproveNamesPredict',
    resultField: 'improved_code',
    type: 'replace',
    requiresSelection: true,
    codeOnly: true,
    buildParams: (ctx, lang) => ({
      code: ctx.selectedText,
      language: lang || 'python',
      local_context: ctx.localContext,
      document_context: ctx.documentContext,
    }),
  },

  'refactor': {
    program: 'RefactorCodePredict',
    resultField: 'refactored_code',
    type: 'replace',
    requiresSelection: true,
    codeOnly: true,
    buildParams: (ctx, lang) => ({
      code: ctx.selectedText,
      language: lang || 'python',
      local_context: ctx.localContext,
      document_context: ctx.documentContext,
    }),
  },

  'document-continue': {
    program: 'DocumentResponsePredict',
    resultField: 'continuation',
    type: 'insert',
    requiresSelection: false,
    insertAtEnd: true,
    buildParams: (ctx) => ({
      document_so_far: ctx.documentContext,
    }),
  },
};
```

### 1.3 Command Categories

| Category | Commands | Description |
|----------|----------|-------------|
| **Text** | fix-grammar, fix-transcription, finish-sentence, finish-paragraph | Natural language editing |
| **Code** | finish-code-line, finish-code-section, document-code, add-types, improve-names, refactor | Code transformations |
| **Document** | document-continue | Continue writing document |

---

## 2. Juice Level System

Progressive quality/cost model for AI responses.

### 2.1 Levels

```typescript
enum JuiceLevel {
  QUICK = 0,      // Grok 4.1 on Groq (fast & cheap)
  BALANCED = 1,   // Claude Sonnet 4.5
  DEEP = 2,       // Gemini 3 Pro with thinking
  MAXIMUM = 3,    // Claude Opus 4.5 with high thinking
  ULTIMATE = 4,   // Multi-model synthesis
}

enum ReasoningLevel {
  OFF = 0,        // No extended thinking
  MINIMAL = 1,    // 1024 token budget
  LOW = 2,        // 4096 token budget
  MEDIUM = 3,     // 8192 token budget
  HIGH = 4,       // 16384 token budget
  MAXIMUM = 5,    // 32768 token budget
}
```

### 2.2 UI Controls

Location: `index.html:2120-2194`

```html
<!-- Juice Level Controls -->
<div class="ai-juice-controls">
  <button class="ai-juice-btn" data-juice="0">0 ⚡</button>
  <button class="ai-juice-btn" data-juice="1">1 ⚖️</button>
  <button class="ai-juice-btn" data-juice="2">2 🧠</button>
  <button class="ai-juice-btn" data-juice="3">3 🚀</button>
  <button class="ai-juice-btn" data-juice="4">4 🔥</button>
</div>

<!-- Reasoning Level Controls -->
<div class="ai-reasoning-controls">
  <button class="ai-reasoning-btn" data-reasoning="0">0</button>
  <button class="ai-reasoning-btn" data-reasoning="1">1</button>
  <button class="ai-reasoning-btn" data-reasoning="2">2</button>
  <button class="ai-reasoning-btn" data-reasoning="3">3</button>
  <button class="ai-reasoning-btn" data-reasoning="4">4</button>
  <button class="ai-reasoning-btn" data-reasoning="5">5</button>
</div>
```

---

## 3. AI Client

HTTP client for communicating with the mrmd-ai backend.

### 3.1 Interface

```typescript
interface AiClient {
  baseUrl: string;
  juiceLevel: number;
  reasoningLevel: number;

  execute(
    program: string,
    params: Record<string, any>,
    options?: { signal?: AbortSignal }
  ): Promise<Record<string, any>>;

  executeStream(
    program: string,
    params: Record<string, any>,
    callbacks: {
      onStatus?: (status: string) => void;
      onModelStart?: (model: string) => void;
      onModelComplete?: (model: string, result: any) => void;
      onResult?: (result: any) => void;
    }
  ): Promise<void>;

  cancel(requestId: string): void;
  cancelAll(): void;
}
```

### 3.2 Implementation

Location: `index.html:5040-5174`

```javascript
aiClient = {
  baseUrl: null,
  juiceLevel: 1,
  reasoningLevel: 1,

  async execute(program, params, options = {}) {
    const response = await fetch(`${this.baseUrl}/${program}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Juice-Level': String(this.juiceLevel),
        'X-Reasoning-Level': String(this.reasoningLevel),
      },
      body: JSON.stringify(params),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new Error(`AI request failed: ${response.status}`);
    }

    return response.json();
  },

  async executeStream(program, params, callbacks) {
    const response = await fetch(`${this.baseUrl}/${program}/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Juice-Level': String(this.juiceLevel),
        'X-Reasoning-Level': String(this.reasoningLevel),
      },
      body: JSON.stringify(params),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      const lines = text.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          switch (data.type) {
            case 'status':
              callbacks.onStatus?.(data.message);
              break;
            case 'model_start':
              callbacks.onModelStart?.(data.model);
              break;
            case 'model_complete':
              callbacks.onModelComplete?.(data.model, data.result);
              break;
            case 'result':
              callbacks.onResult?.(data.result);
              break;
          }
        }
      }
    }
  },
};
```

---

## 4. Editor Integration

CodeMirror integration for visual feedback and state management.

### 4.1 AI State

Location: `mrmd-editor/src/ai-integration.js:79-163`

```typescript
interface AiOperation {
  id: string;                  // 'ai-1234567890-abc123'
  type: 'insert' | 'replace';
  from: number;                // Start position
  to: number;                  // End position
  originalText?: string;       // For revert on reject
  newText?: string;            // AI result
  status: 'loading' | 'pending' | 'accepted' | 'rejected';
  startTime: number;
  onCancel?: () => void;
}

interface AiState {
  operations: Map<string, AiOperation>;
  juiceLevel: number;
}
```

```javascript
export const aiState = StateField.define({
  create() {
    return {
      operations: new Map(),
      juiceLevel: 0,
    };
  },

  update(state, tr) {
    for (const effect of tr.effects) {
      if (effect.is(startAiOperation)) {
        // Add new operation with status: 'loading'
      }
      if (effect.is(completeAiOperation)) {
        // Update operation with newText, status: 'pending'
      }
      if (effect.is(cancelAiOperation)) {
        // Remove operation
      }
      if (effect.is(acceptAiChange)) {
        // Finalize text, remove operation
      }
      if (effect.is(rejectAiChange)) {
        // Restore original text, remove operation
      }
    }
    return state;
  }
});
```

### 4.2 Visual Feedback

| State | Display | Controls |
|-------|---------|----------|
| `loading` | Shimmer dots `...` | Cancel button (×) |
| `pending` | Blue shimmer background | Accept (✓) / Reject (×) |
| `replace` | Strikethrough on original | Accept (✓) / Reject (×) |

### 4.3 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Accept pending change at cursor |
| `Escape` | Reject/cancel operation at cursor |
| `Mod-Shift-Enter` | Accept all pending changes |
| `Mod-Shift-Escape` | Reject all and restore originals |

### 4.4 Context Extraction

Location: `mrmd-editor/src/ai-integration.js:689-720`

```javascript
export function getAiContext(view, contextSize = 500) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const content = doc.toString();
  const cursorPos = sel.head;
  const selFrom = sel.from;
  const selTo = sel.to;
  const length = content.length;

  return {
    textBeforeCursor: content.slice(Math.max(0, cursorPos - contextSize), cursorPos),
    textAfterCursor: content.slice(cursorPos, Math.min(length, cursorPos + contextSize)),
    localContext: content.slice(
      Math.max(0, selFrom - contextSize),
      Math.min(length, selTo + contextSize)
    ),
    selectedText: content.slice(selFrom, selTo),
    cursorPos,
    selectionFrom: selFrom,
    selectionTo: selTo,
    documentContext: content,
  };
}
```

---

## 5. Backend Server

FastAPI server running DSPy modules.

### 5.1 Program Registry

Location: `mrmd-ai/src/mrmd_ai/server.py:63-95`

```python
PROGRAMS = {
    # Finish
    "FinishSentencePredict": FinishSentencePredict,
    "FinishParagraphPredict": FinishParagraphPredict,
    "FinishCodeLinePredict": FinishCodeLinePredict,
    "FinishCodeSectionPredict": FinishCodeSectionPredict,
    # Fix
    "FixGrammarPredict": FixGrammarPredict,
    "FixTranscriptionPredict": FixTranscriptionPredict,
    # Code transformations
    "DocumentCodePredict": DocumentCodePredict,
    "AddTypeHintsPredict": AddTypeHintsPredict,
    "ImproveNamesPredict": ImproveNamesPredict,
    "RefactorCodePredict": RefactorCodePredict,
    # Document
    "DocumentResponsePredict": DocumentResponsePredict,
}
```

### 5.2 Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/programs` | List available programs |
| `GET` | `/juice` | Get juice level capabilities |
| `GET` | `/reasoning` | Get reasoning level descriptions |
| `POST` | `/{program_name}` | Execute program (synchronous) |
| `POST` | `/{program_name}/stream` | Execute with SSE progress |

### 5.3 Request Handler

Location: `mrmd-ai/src/mrmd_ai/server.py:221-286`

```python
@app.post("/{program_name}")
async def run_program(program_name: str, request: Request):
    # Extract levels from headers
    juice_level = int(request.headers.get("X-Juice-Level", "0"))
    reasoning_level = int(request.headers.get("X-Reasoning-Level", "0"))

    # Get program class
    program_class = PROGRAMS.get(program_name)
    if not program_class:
        raise HTTPException(404, f"Unknown program: {program_name}")

    # Get cached JuicedProgram
    juiced_program = get_program(program_name, juice_level, reasoning_level)

    # Parse request body
    params = await request.json()

    # Run in thread pool (DSPy is blocking)
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        _executor,
        lambda: juiced_program(**params)
    )

    # Extract and return result
    response = extract_result(result)
    response["_model"] = juiced_program.model_name
    response["_juice_level"] = juice_level
    return response
```

---

## 6. DSPy Modules

Each command has a corresponding DSPy module and signature.

### 6.1 Module Structure

Location: `mrmd-ai/src/mrmd_ai/modules/*.py`

```python
class FixGrammarPredict(dspy.Module):
    def __init__(self):
        super().__init__()
        self.predictor = dspy.Predict(FixGrammarSignature)

    def forward(
        self,
        text_to_fix: str,
        local_context: str,
        document_context: Optional[str] = None,
    ) -> dspy.Prediction:
        result = self.predictor(
            document_context=document_context,
            local_context=local_context,
            text_to_fix=text_to_fix,
        )
        return result
```

### 6.2 Signature Structure

Location: `mrmd-ai/src/mrmd_ai/signatures/*.py`

```python
class FixGrammarSignature(dspy.Signature):
    """
    You are helping a user fix text in a markdown notebook. Your task is to
    correct grammar, spelling, and punctuation errors in the selected text.

    You will receive:
    - document_context: The full notebook content for understanding terminology
    - local_context: The current paragraph/section for immediate context
    - text_to_fix: The exact text that needs fixing

    Output the corrected version. Make minimal changes - only fix actual errors.
    Preserve the original meaning, tone, and formatting.

    IMPORTANT: Preserve ALL whitespace including leading/trailing newlines.
    """

    document_context: Optional[str] = dspy.InputField(
        desc="The full notebook/document for understanding terminology and style",
        default=None,
    )
    local_context: str = dspy.InputField(
        desc="The current paragraph or section for immediate context"
    )
    text_to_fix: str = dspy.InputField(
        desc="The exact text to fix - preserve all whitespace"
    )
    fixed_text: str = dspy.OutputField(
        desc="The corrected text - MUST preserve exact whitespace structure"
    )
```

---

## 7. Execution Flow

Complete flow from user action to result:

```
1. USER TRIGGERS COMMAND
   ├─ Clicks AI panel button with data-cmd="fix-grammar"
   ├─ Or: Keyboard shortcut (if configured)
   └─ Event: executeAiCommand('fix-grammar')

2. CONTEXT EXTRACTION
   ├─ Call: mrmd.default.ai.getAiContext(view)
   ├─ Extract: selectedText, textBeforeCursor, localContext, documentContext
   └─ Validate: Check requiresSelection, codeOnly constraints

3. BUILD REQUEST
   ├─ Get command config: AI_COMMANDS['fix-grammar']
   ├─ Build params using buildParams(context, language)
   └─ Create operation ID: 'ai-{timestamp}-{random}'

4. SHOW LOADING STATE
   ├─ Dispatch: startAiOperation effect
   ├─ Update: aiState with new operation (status: 'loading')
   └─ Display: Shimmer dots "..." with cancel button

5. HTTP REQUEST TO BACKEND
   ├─ POST http://127.0.0.1:{PORT}/FixGrammarPredict
   ├─ Headers: X-Juice-Level, X-Reasoning-Level
   └─ Body: { text_to_fix, local_context, document_context }

6. BACKEND PROCESSING
   ├─ Get cached JuicedProgram(FixGrammarPredict, juice, reasoning)
   ├─ Configure LM based on juice level
   ├─ Execute: predictor(FixGrammarSignature)
   │   ├─ DSPy constructs prompt from signature docstring
   │   ├─ Sends to LM via LiteLLM
   │   └─ Parses response into Prediction object
   └─ Return: { fixed_text: "...", _model: "...", _juice_level: N }

7. APPLY RESULT
   ├─ Extract result field: result.fixed_text
   ├─ Dispatch: completeAiOperation effect with newText
   ├─ Insert/replace text in editor
   └─ Update: aiState operation (status: 'pending')

8. SHOW PENDING STATE
   ├─ Display: Blue shimmer on new text
   ├─ Show: Accept (✓) and Reject (×) buttons
   └─ Wait: User decision

9. USER ACCEPTS/REJECTS
   ├─ Accept: Dispatch acceptAiChange → Remove operation, keep text
   └─ Reject: Dispatch rejectAiChange → Restore original text
```

---

## 8. Server Startup

The AI server is started by the main process.

Location: `main.js`

```javascript
async function ensureAiServer() {
  const port = await findFreePort();
  const aiPackageDir = resolvePackageDir('mrmd-ai');

  const proc = spawn('uv', [
    'run', '--project', aiPackageDir,
    'mrmd-ai-server', '--port', port.toString(),
  ], {
    cwd: aiPackageDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  await waitForPort(port);
  return { proc, port };
}
```

Frontend connection:

```javascript
electronAPI.getAi().then(result => {
  if (result.success) {
    aiClient.baseUrl = `http://127.0.0.1:${result.port}`;
  }
});
```

---

## 9. Adding a New Command

### Step 1: Backend Signature

Create `mrmd-ai/src/mrmd_ai/signatures/my_command.py`:

```python
class MyCommandSignature(dspy.Signature):
    """
    Detailed instructions for the LLM.
    Describe the task, constraints, and output format.
    """

    input_field: str = dspy.InputField(desc="Description")
    local_context: str = dspy.InputField(desc="Surrounding context")
    document_context: Optional[str] = dspy.InputField(desc="Full document", default=None)
    output_field: str = dspy.OutputField(desc="Description of output")
```

### Step 2: Backend Module

Create `mrmd-ai/src/mrmd_ai/modules/my_command.py`:

```python
class MyCommandPredict(dspy.Module):
    def __init__(self):
        super().__init__()
        self.predictor = dspy.Predict(MyCommandSignature)

    def forward(self, input_field: str, local_context: str,
                document_context: Optional[str] = None) -> dspy.Prediction:
        return self.predictor(
            input_field=input_field,
            local_context=local_context,
            document_context=document_context,
        )
```

### Step 3: Register in Server

Edit `mrmd-ai/src/mrmd_ai/server.py`:

```python
from .modules.my_command import MyCommandPredict

PROGRAMS = {
    # ... existing programs
    "MyCommandPredict": MyCommandPredict,
}
```

### Step 4: Frontend Config

Edit `index.html`:

```javascript
AI_COMMANDS['my-command'] = {
  program: 'MyCommandPredict',
  resultField: 'output_field',
  type: 'replace',  // or 'insert'
  requiresSelection: true,
  buildParams: (ctx) => ({
    input_field: ctx.selectedText,
    local_context: ctx.localContext,
    document_context: ctx.documentContext,
  }),
};
```

### Step 5: Add UI Button

Edit `index.html` in the AI panel section:

```html
<div class="ai-cmd" data-cmd="my-command">
  <span class="ai-cmd-label">My Command</span>
  <span class="ai-cmd-hint">selection</span>
</div>
```

---

## 10. Command Summary

| Command ID | Program | Input | Output | Type |
|------------|---------|-------|--------|------|
| `fix-grammar` | FixGrammarPredict | Selection | fixed_text | replace |
| `fix-transcription` | FixTranscriptionPredict | Selection | fixed_text | replace |
| `finish-sentence` | FinishSentencePredict | Cursor | completion | insert |
| `finish-paragraph` | FinishParagraphPredict | Cursor | completion | insert |
| `finish-code-line` | FinishCodeLinePredict | Cursor (code) | completion | insert |
| `finish-code-section` | FinishCodeSectionPredict | Cursor (code) | completion | insert |
| `document-code` | DocumentCodePredict | Selection (code) | documented_code | replace |
| `add-types` | AddTypeHintsPredict | Selection (code) | typed_code | replace |
| `improve-names` | ImproveNamesPredict | Selection (code) | improved_code | replace |
| `refactor` | RefactorCodePredict | Selection (code) | refactored_code | replace |
| `document-continue` | DocumentResponsePredict | Full doc | continuation | insert |

---

## 11. File Locations

```
mrmd-electron/
├── index.html
│   ├── :2120-2194  AI panel UI (juice/reasoning controls, command buttons)
│   ├── :4900-5034  AI_COMMANDS registry
│   └── :5040-5174  aiClient implementation
└── main.js         Server startup (ensureAiServer)

mrmd-editor/src/
├── ai-integration.js
│   ├── :79-163     aiState StateField
│   ├── :689-720    getAiContext()
│   └── decorations, widgets, keymap
└── shell/
    ├── ai-client.js    AiClient class
    └── ai-menu.js      AI menu component

mrmd-ai/src/mrmd_ai/
├── server.py           FastAPI server, PROGRAMS registry
├── juice.py            JuiceLevel, ReasoningLevel, JuicedProgram
├── modules/
│   ├── finish.py       Finish*Predict modules
│   ├── fix.py          Fix*Predict modules
│   └── code.py         Code transformation modules
└── signatures/
    ├── finish.py       Finish*Signature definitions
    ├── fix.py          Fix*Signature definitions
    └── code.py         Code*Signature definitions
```
