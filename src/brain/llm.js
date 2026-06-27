/**
 * llm.js
 *
 * LLM provider abstraction. Exports a single function: askLLM().
 *
 * Supports two providers, controlled by the LLM_PROVIDER env variable:
 *   - 'ollama'  (default) → calls local Ollama API using tool-calling format
 *   - 'claude'            → calls Anthropic Claude API using tool-use format
 *
 * Both providers return the same shape:  { action: string, args: object }
 *
 * DESIGN NOTE: Switching from Ollama to Claude requires only changing LLM_PROVIDER
 * in .env — zero code changes. The tool schemas in actions.js use Claude's schema
 * format, which Ollama also accepts (it's the same OpenAI-compatible standard).
 */

const Anthropic = require('@anthropic-ai/sdk');

const PROVIDER       = (process.env.LLM_PROVIDER   || 'ollama').toLowerCase();
const OLLAMA_URL     = process.env.OLLAMA_URL        || 'http://localhost:11434';
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL      || 'llama3.1';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY    || '';
const CLAUDE_MODEL   = 'claude-sonnet-4-6';

let consecutiveFallbacks = 0;

// Lazily initialise the Anthropic client only if Claude is actually used.
let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) {
    if (!CLAUDE_API_KEY || CLAUDE_API_KEY === 'your-claude-api-key-placeholder') {
      throw new Error(
        'CLAUDE_API_KEY is not set. Add your Anthropic API key to .env, or switch LLM_PROVIDER=ollama.'
      );
    }
    _anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });
  }
  return _anthropic;
}

// ─── Ollama provider ─────────────────────────────────────────────────────────

/**
 * Calls Ollama's /api/chat endpoint with tool-calling support.
 * Requires a model that supports tool calling (llama3.1 or later).
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {Array}  tools   - TOOL_SCHEMAS from actions.js
 * @returns {Promise<{action: string, args: object}>}
 */
async function askOllama(systemPrompt, userMessage, tools, targetAction = 'none') {
  // Convert Claude-style schema to Ollama/OpenAI tool format
  const ollamaTools = tools.map(t => ({
    type: 'function',
    function: {
      name:        t.name,
      description: t.description,
      parameters:  t.input_schema,
    },
  }));

  const body = {
    model:    OLLAMA_MODEL,
    stream:   false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage  },
    ],
    tools: ollamaTools,
  };

  let response;
  let attempt = 0;
  const maxRetries = 3;
  while (attempt <= maxRetries) {
    try {
      response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama API error ${response.status}: ${errText}`);
      }
      
      break; // Success
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        throw err;
      }
      const delayMs = Math.pow(2, attempt) * 1000;
      console.log(`[${new Date().toISOString()}] [ERROR] Ollama request failed: ${err.message}. Retrying in ${delayMs}ms (Attempt ${attempt}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  const data = await response.json();
  const msg  = data.message;

  // If the model returned a tool call, extract it
  if (msg?.tool_calls?.length > 0) {
    consecutiveFallbacks = 0;
    const call = msg.tool_calls[0];
    const fnName = call.function?.name;
    let fnArgs   = call.function?.arguments ?? {};

    // Ollama may return arguments as a JSON string — parse if needed
    if (typeof fnArgs === 'string') {
      try { fnArgs = JSON.parse(fnArgs); } catch { fnArgs = {}; }
    }

    return { action: fnName, args: fnArgs };
  }

  // Fallback: if the model returned plain text instead of a tool call,
  // treat it as a chat message (graceful degradation)
  const content = msg?.content?.trim();
  if (content) {
    console.log(`[${new Date().toISOString()}] [WARNING] Model did not return a tool_call. Raw content: "${content.slice(0, 100)}..."`);
    consecutiveFallbacks++;
    if (consecutiveFallbacks >= 3) {
      consecutiveFallbacks = 0;
      throw new Error('Model failed to produce a valid structured tool call 3 times in a row.');
    }
    
    const hasChat = tools.some(t => t.name === 'chat');
    if (hasChat) {
       return { action: 'chat', args: { message: content.slice(0, 200) } };
    } else if (targetAction !== 'none' && targetAction !== 'free_explore') {
       console.log(`[${new Date().toISOString()}] [WARNING] Chat is disabled. Falling back to target action: "${targetAction}"`);
       return { action: targetAction, args: {} };
    } else {
       return { action: 'idle', args: {} };
    }
  }

  consecutiveFallbacks = 0;
  return { action: 'idle', args: {} };
}

// ─── Claude provider ─────────────────────────────────────────────────────────

/**
 * Calls Anthropic Claude API with tool-use.
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {Array}  tools   - TOOL_SCHEMAS from actions.js (Claude-native format)
 * @returns {Promise<{action: string, args: object}>}
 */
async function askClaude(systemPrompt, userMessage, tools, targetAction = 'none') {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model:      CLAUDE_MODEL,
    max_tokens: 512,
    system:     systemPrompt,
    tools:      tools,
    tool_choice: { type: 'any' }, // Force tool use — the model must pick one
    messages: [
      { role: 'user', content: userMessage },
    ],
  });

  // Find the tool-use block in the response
  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (toolUse) {
    return { action: toolUse.name, args: toolUse.input ?? {} };
  }

  // Fallback to text if somehow no tool was called
  const textBlock = response.content.find(b => b.type === 'text');
  if (textBlock?.text) {
    const hasChat = tools.some(t => t.name === 'chat');
    if (hasChat) {
      return { action: 'chat', args: { message: textBlock.text.slice(0, 200) } };
    } else if (targetAction !== 'none' && targetAction !== 'free_explore') {
      return { action: targetAction, args: {} };
    }
  }

  return { action: 'idle', args: {} };
}

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Send a decision request to the configured LLM provider.
 *
 * @param {string} systemPrompt - The bot persona + rules prompt
 * @param {string} userMessage  - Serialised game state snapshot (JSON string)
 * @param {Array}  tools        - TOOL_SCHEMAS from actions.js
 * @returns {Promise<{action: string, args: object}>}
 */
async function askLLM(systemPrompt, userMessage, tools, targetAction = 'none') {
  if (PROVIDER === 'claude') {
    return askClaude(systemPrompt, userMessage, tools, targetAction);
  }
  return askOllama(systemPrompt, userMessage, tools, targetAction);
}

module.exports = { askLLM, PROVIDER, OLLAMA_MODEL, CLAUDE_MODEL };
