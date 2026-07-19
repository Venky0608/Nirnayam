// geminiChatService.js
// Streaming Gemini chat for Nirnayam's Study Chatbot.
// Uses a SEPARATE API key from the decision-engine (Nirnayam's `decide`/`plan` logic)
// so chatbot traffic never throttles the core features.

const GEMINI_CHAT_KEY = import.meta.env.VITE_GEMINI_CHAT_KEY;
const MODEL = "gemini-2.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_CHAT_KEY}`;

/**
 * Builds the system instruction that grounds every chatbot response
 * in the student's grade, stream, and exam target.
 * (Layer 1 — weak-topic awareness — is NOT wired in yet; see SETUP_STEPS.md.)
 */
function buildSystemPrompt(profile) {
  const { grade, stream, examTarget } = profile;

  return `You are the Nirnayam Study Chatbot — a focused, encouraging AI tutor for Indian competitive exam students. Your slogan is "Find Your True North": help the student cut through confusion and get a clear, correct answer.

Student context:
- Grade: ${grade}
- Stream: ${stream}
- Exam target: ${examTarget}

Rules:
- Pitch every explanation at ${examTarget}-appropriate depth. Don't oversimplify for a serious aspirant, and don't assume knowledge they haven't covered yet at grade ${grade} level.
- Be direct and concise. Prefer worked examples and step-by-step reasoning over long prose.
- If a question is ambiguous, ask ONE clarifying question rather than guessing.
- Stay encouraging but never sugarcoat mistakes — correct them clearly and explain why.
- You are not a general chatbot. Redirect off-topic conversation (unrelated to study, exam prep, or the student's academic wellbeing) back to studying, gently.`;
}

/**
 * Streams a chat response from Gemini.
 * @param {Array<{role: 'user'|'model', text: string}>} history - full conversation so far
 * @param {{grade: string, stream: string, examTarget: string}} profile - student profile for context
 * @param {(chunk: string) => void} onChunk - called with each new text chunk as it streams in
 * @returns {Promise<string>} the full assembled response text
 */
export async function streamChatResponse(history, profile, onChunk) {
  const contents = history.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.text }],
  }));

  const body = {
    system_instruction: {
      parts: [{ text: buildSystemPrompt(profile) }],
    },
    contents,
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 1024,
    },
  };

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Gemini stream failed: ${response.status} ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line for next chunk

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(jsonStr);
        const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          fullText += text;
          onChunk(text);
        }
      } catch {
        // incomplete JSON chunk — skip, next read will complete it
      }
    }
  }

  return fullText;
}
