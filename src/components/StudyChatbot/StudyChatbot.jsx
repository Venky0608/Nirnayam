import React, { useState, useRef, useEffect } from "react";
import { streamChatResponse } from "./geminiChatService";
import "./StudyChatbot.css";

/**
 * Nirnayam Study Chatbot
 *
 * Scope for the Prometheus submission (deliberately cut down from full V2 spec):
 *  - Layer 2 (grade/stream adaptation): DONE — wired via profile prop
 *  - Layer 3 (general-purpose fallback): DONE — default behavior
 *  - Layer 1 (weak-topic awareness): NOT wired — needs the weak topic tracker first
 *  - Persistence: session-only (React state). Firestore persistence is a post-deadline follow-up.
 *
 * @param {{grade: string, stream: string, examTarget: string}} profile
 */
export default function StudyChatbot({ profile }) {
  const [messages, setMessages] = useState([
    {
      role: "model",
      text: "Find your true north. Ask me anything — a concept you're stuck on, a problem you want walked through, or where to start today.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    setError(null);
    const userMessage = { role: "user", text: trimmed };
    const nextMessages = [...messages, userMessage, { role: "model", text: "" }];
    setMessages(nextMessages);
    setInput("");
    setIsStreaming(true);

    try {
      let accumulated = "";
      await streamChatResponse(
        [...messages, userMessage],
        profile,
        (chunk) => {
          accumulated += chunk;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: "model", text: accumulated };
            return updated;
          });
        }
      );
    } catch (err) {
      setError("Couldn't reach the chatbot. Check your connection and try again.");
      setMessages((prev) => prev.slice(0, -1)); // drop the empty model bubble
    } finally {
      setIsStreaming(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="nirnayam-chat">
      <div className="nirnayam-chat__header">
        <span className="nirnayam-chat__compass">N</span>
        <div>
          <h2>Study Chatbot</h2>
          <p>Find your true north</p>
        </div>
      </div>

      <div className="nirnayam-chat__messages" ref={scrollRef}>
        {messages.map((m, i) => (
          <div key={i} className={`nirnayam-chat__bubble nirnayam-chat__bubble--${m.role}`}>
            {m.text || (isStreaming && i === messages.length - 1 ? <TypingDots /> : "")}
          </div>
        ))}
        {error && <div className="nirnayam-chat__error">{error}</div>}
      </div>

      <div className="nirnayam-chat__input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question, or tell me what to explain..."
          rows={1}
          disabled={isStreaming}
        />
        <button onClick={handleSend} disabled={isStreaming || !input.trim()}>
          {isStreaming ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="nirnayam-chat__typing">
      <span />
      <span />
      <span />
    </span>
  );
}
