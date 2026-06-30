/**
 * apiClient.js
 * ─────────────────────────────────────────────────────────────
 * OpenAI-compatible chat completion client.
 *
 * Supports:
 *   - Streaming (SSE) responses — text appears word-by-word
 *   - Non-streaming fallback
 *   - Any OpenAI-compatible endpoint (OpenAI, Anthropic proxy,
 *     Ollama, Groq, Together, etc.)
 *
 * All API calls go through the browser's `fetch()` — no Axios
 * dependency needed. In Electron, CORS is not an issue since
 * the renderer can reach any URL.
 * ─────────────────────────────────────────────────────────────
 */

/**
 * Call an OpenAI-compatible /chat/completions endpoint.
 *
 * @param {object} options
 * @param {string} options.baseUrl    - e.g. "https://api.openai.com/v1"
 * @param {string} options.apiKey     - Bearer token
 * @param {string} options.model      - e.g. "gpt-4o"
 * @param {Array}  options.messages   - OpenAI chat messages [{role, content}]
 * @param {boolean} [options.stream=true]  - Enable SSE streaming
 * @param {number} [options.maxTokens=4096] - max_tokens parameter
 * @param {number} [options.temperature=0.7]
 * @param {function} [options.onChunk]   - Called with each text delta (streaming)
 * @param {AbortSignal} [options.signal] - For cancellation
 * @returns {Promise<{ok: boolean, text: string, usage?: object, error?: string}>}
 */
export async function callLLM({
  baseUrl,
  apiKey,
  model,
  messages,
  stream = true,
  maxTokens = 4096,
  temperature = 0.7,
  onChunk,
  signal,
}) {
  // ─── Validate ───
  if (!baseUrl || !apiKey) {
    return { ok: false, text: '', error: 'API Key or Base URL is missing.' };
  }

  // Strip trailing slash and ensure /chat/completions path
  let url = baseUrl.replace(/\/+$/, '');
  if (!url.endsWith('/chat/completions')) {
    url += '/chat/completions';
  }

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream,
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Request was cancelled.'
      : `Network error: ${err.message}`;
    return { ok: false, text: '', error: msg };
  }

  // ─── Non-2xx response ───
  if (!response.ok) {
    let errorMsg = `HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      errorMsg += ` — ${errBody?.error?.message || errBody?.message || JSON.stringify(errBody)}`;
    } catch {
      try { errorMsg += ` — ${await response.text()}`; } catch { /* ignore */ }
    }
    return { ok: false, text: '', error: errorMsg };
  }

  // ─── Streaming path ───
  if (stream) {
    return await handleStreamResponse(response, onChunk);
  }

  // ─── Non-streaming path ───
  try {
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    const usage = data.usage;
    return { ok: true, text, usage };
  } catch (err) {
    return { ok: false, text: '', error: `Failed to parse response: ${err.message}` };
  }
}

/**
 * Handle an SSE streaming response from the API.
 * Reads the response body as a stream, parses SSE data frames,
 * extracts text deltas, and calls onChunk for each.
 */
async function handleStreamResponse(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by double newlines
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith(':')) continue;

        // "data: [DONE]" signals end of stream
        if (trimmed === 'data: [DONE]') continue;

        // Parse "data: {...json...}"
        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6));

            // Extract delta text
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              if (onChunk) onChunk(fullText);
            }
          } catch {
            // Ignore malformed JSON chunks
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim() && buffer.trim() !== 'data: [DONE]' && buffer.trim().startsWith('data: ')) {
      try {
        const json = JSON.parse(buffer.trim().slice(6));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          if (onChunk) onChunk(fullText);
        }
      } catch { /* ignore */ }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      return { ok: false, text: fullText, error: `Stream interrupted: ${err.message}` };
    }
  }

  return { ok: true, text: fullText };
}
