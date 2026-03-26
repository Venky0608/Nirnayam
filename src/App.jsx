import React, { useState, useEffect, useRef } from "react";

// ─── Storage helpers (in-memory, no localStorage) ───────────────────────────
let _profile = null;
let _history = [];

// ─── System prompt builder ───────────────────────────────────────────────────
const buildSystemPrompt = (profile) => `You are Nirnayam — a sharp decision advisor for students grades 9-12. Break decision paralysis fast.

Profile: Grade ${profile.grade}${profile.stream ? ` ${profile.stream}` : ""} | Stress: ${profile.stressLevel}/10 | Time mgmt: ${profile.timeManagement}/10 | Priorities: ${profile.priorities.join(", ")} | Subjects: ${profile.subjects?.join(", ") || "?"} | Subject priority: ${profile.subjectPriority?.join(" > ") || "?"} | Learning pace: ${profile.learningStyle?.pace || "?"} | Revision time: ${profile.learningStyle?.revisionTime || "?"} | Distraction: ${profile.learningStyle?.distraction}/10 | Slow at doubts: ${profile.learningStyle?.doubtTime || "?"} | Extra: ${profile.additionalContext || "none"}

LANGUAGE: Handle spelling mistakes and casual language naturally. tmr=tomorrow, rn=now, stressed/freaking out=high stress, kinda worried=medium, chill=low. Never ask to rephrase.

CATEGORIES — pick exactly one:
- Study: one subject/task now
- Activity: non-academic (rest, eat, sport, hang out, art)
- Split: divide time between two options
- Priority: multiple academic tasks — give order (X first, then Y)
Key: "study math or physics?" = Priority. "study or rest?" = Activity if exhausted.

RULES: One clear recommendation only. Direct like a smart older sibling. Use subject priority order to break ties. Flag urgency clearly.

Respond ONLY in this JSON, no preamble, no backticks:
{"decision":"one clear action","confidence":85,"urgency":"high","time_split":{"option_a":70,"option_b":30},"key_insight":"one thing that tips this","action_plan":["step 1","step 2","step 3"],"warning":"one thing to watch or null"}
urgency: low/medium/high/critical. time_split must add to 100.`;

// ─── API call ────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_KEY;

const callNirnayam = async (situation, profile) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: buildSystemPrompt(profile) }] },
          contents: [{ role: "user", parts: [{ text: situation }] }],
          generationConfig: { maxOutputTokens: 600, temperature: 0.7 }
        }),
      }
    );
    clearTimeout(timeout);
    const data = await response.json();
    const text = data.candidates[0].content.parts[0].text;
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Request timed out. Try again.");
    throw err;
  }
};

// ─── Subject lists by grade/stream ──────────────────────────────────────────
const SUBJECTS_BY_GRADE = {
  "Grade 9": ["Math", "Physics", "Chemistry", "Biology", "History", "Geography", "Political Science", "Economics", "English", "Hindi", "Kannada", "Sanskrit", "French", "Computer Science", "Artificial Intelligence"],
  "Grade 10": ["Math", "Physics", "Chemistry", "Biology", "History", "Geography", "Political Science", "Economics", "English", "Hindi", "Kannada", "Sanskrit", "French", "Computer Science", "Artificial Intelligence"],
  "Grade 11 - Science (PCM)": ["Physics", "Chemistry", "Math", "English", "Computer Science", "Economics", "Physical Education", "Psychology"],
  "Grade 11 - Science (PCB)": ["Physics", "Chemistry", "Biology", "English", "Math", "Computer Science", "Physical Education", "Psychology"],
  "Grade 11 - Commerce": ["Accountancy", "Business Studies", "Economics", "English", "Math", "Computer Science", "Entrepreneurship", "Physical Education"],
  "Grade 11 - Humanities": ["History", "Political Science", "Geography", "English", "Economics", "Psychology", "Sociology", "Fine Arts", "Physical Education"],
  "Grade 12 - Science (PCM)": ["Physics", "Chemistry", "Math", "English", "Computer Science", "Economics", "Physical Education", "Psychology"],
  "Grade 12 - Science (PCB)": ["Physics", "Chemistry", "Biology", "English", "Math", "Computer Science", "Physical Education", "Psychology"],
  "Grade 12 - Commerce": ["Accountancy", "Business Studies", "Economics", "English", "Math", "Computer Science", "Entrepreneurship", "Physical Education"],
  "Grade 12 - Humanities": ["History", "Political Science", "Geography", "English", "Economics", "Psychology", "Sociology", "Fine Arts", "Physical Education"],
};

const GRADE_OPTIONS = ["Grade 9", "Grade 10", "Grade 11", "Grade 12"];
const STREAM_OPTIONS = ["Science (PCM)", "Science (PCB)", "Commerce", "Humanities"];

// ─── Onboarding questions ────────────────────────────────────────────────────
const QUESTIONS = [
  {
    id: "grade",
    question: "What grade are you in?",
    type: "choice",
    options: GRADE_OPTIONS,
  },
  {
    id: "stressLevel",
    question: "How much does stress affect you?",
    subtitle: "Be honest — this helps calibrate your advice",
    type: "scale",
    min: 1,
    max: 10,
    labels: ["Stress? What stress?", "Stress hits hard"],
  },
  {
    id: "timeManagement",
    question: "How's your time management?",
    subtitle: "On a normal school day",
    type: "scale",
    min: 1,
    max: 10,
    labels: ["I always run out of time", "I manage time well"],
  },
  {
    id: "priorities",
    question: "What matters most to you?",
    subtitle: "Pick all that apply",
    type: "multi",
    options: ["Academics", "Sports", "Music/Arts", "Social life", "Personal projects", "Family"],
  },
  {
    id: "subjects",
    question: "Which subjects do you take?",
    subtitle: "Pick all that apply",
    type: "subjects",
  },
  {
    id: "subjectPriority",
    question: "Rank your subjects by importance to you",
    subtitle: "Drag to reorder — top = most important",
    type: "rank",
  },
  {
    id: "learningStyle",
    question: "How do you learn?",
    subtitle: "Helps Nirnayam give smarter time estimates",
    type: "learning",
  },
  {
    id: "additionalContext",
    question: "Anything else Nirnayam should know about you?",
    subtitle: "Optional — exams coming up, specific goals, etc.",
    type: "text",
    optional: true,
  },
];

// ─── Colours ─────────────────────────────────────────────────────────────────
const urgencyColor = (u) => ({
  low: "#4ade80",
  medium: "#facc15",
  high: "#fb923c",
  critical: "#f87171",
}[u] || "#888");

const confidenceColor = (c) => c >= 75 ? "#4ade80" : c >= 50 ? "#facc15" : "#f87171";

// ─── Components ──────────────────────────────────────────────────────────────

function LandingPage({ onStart }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { setTimeout(() => setVisible(true), 100); }, []);

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "40px 24px",
      textAlign: "center",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Background grain */}
      <div style={{
        position: "fixed", inset: 0, zIndex: 0,
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E")`,
        pointerEvents: "none",
      }} />

      <div style={{
        position: "relative", zIndex: 1,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(24px)",
        transition: "all 0.8s cubic-bezier(0.16, 1, 0.3, 1)",
        maxWidth: 560,
      }}>
        {/* Logo mark */}
        <div style={{
          width: 56, height: 56,
          border: "1px solid #333",
          borderRadius: "50%",
          display: "flex", alignItems: "center", justifyContent: "center",
          margin: "0 auto 32px",
        }}>
          <div style={{
            width: 20, height: 20,
            border: "1px solid #666",
            transform: "rotate(45deg)",
          }} />
        </div>

        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 11, letterSpacing: "0.3em", color: "#444",
          textTransform: "uppercase", marginBottom: 20,
        }}>
          निर्णय · Decision
        </div>

        <h1 style={{
          fontFamily: "'Syne', sans-serif",
          fontSize: "clamp(48px, 10vw, 80px)",
          fontWeight: 800, margin: "0 0 24px",
          lineHeight: 0.95, letterSpacing: "-0.03em", color: "#fff",
        }}>
          Nirnayam
        </h1>

        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 13, lineHeight: 2, color: "#555",
          margin: "0 0 16px", fontStyle: "italic",
        }}>
          "Decisions, decisions to make,<br />
          conflicted and lost on the way,<br />
          so Nirnayam's advice you should take,<br />
          so we can be better than yesterday."
        </div>

        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 12, color: "#333", marginBottom: 48, lineHeight: 1.8,
        }}>
          An AI built for students who freeze when it matters most.<br />
          Tell it your conflict. Get a clear answer. Act.
        </div>

        <button
          onClick={onStart}
          style={{
            background: "#fff", color: "#000", border: "none",
            borderRadius: 3, padding: "14px 36px",
            fontFamily: "'DM Mono', monospace", fontSize: 13,
            fontWeight: 500, cursor: "pointer", letterSpacing: "0.05em",
            transition: "all 0.2s",
          }}
          onMouseEnter={e => { e.target.style.background = "#e5e5e5"; }}
          onMouseLeave={e => { e.target.style.background = "#fff"; }}
        >
          Set up your profile →
        </button>

        <div style={{
          marginTop: 24, fontFamily: "'DM Mono', monospace",
          fontSize: 11, color: "#2a2a2a",
        }}>
          Takes ~2 minutes. No account needed.
        </div>
      </div>
    </div>
  );
}

function OnboardingPage({ onComplete }) {
  const [step, setStep] = useState(0);
  const [stream, setStream] = useState("");
  const [dragIdx, setDragIdx] = useState(null);
  const [answers, setAnswers] = useState({
    grade: "", stressLevel: 5, timeManagement: 6,
    priorities: [], subjects: [], subjectPriority: [],
    learningStyle: { pace: "", revisionTime: "", distraction: 5, doubtTime: "" },
    additionalContext: ""
  });

  const q = QUESTIONS[step];

  // Get subject list based on grade + stream
  const getSubjectList = () => {
    const g = answers.grade;
    if (g === "Grade 9" || g === "Grade 10") return SUBJECTS_BY_GRADE[g] || [];
    if ((g === "Grade 11" || g === "Grade 12") && stream) {
      return SUBJECTS_BY_GRADE[`${g} - ${stream}`] || [];
    }
    return [];
  };

  const progress = (step / QUESTIONS.length) * 100;

  const canProceed = () => {
    if (q.optional) return true;
    const val = answers[q.id];
    if (q.type === "multi") return val.length > 0;
    if (q.type === "choice") return val !== "";
    if (q.type === "subjects") {
      const needsStream = answers.grade === "Grade 11" || answers.grade === "Grade 12";
      if (needsStream && !stream) return false;
      return answers.subjects.length > 0;
    }
    if (q.type === "rank") return answers.subjectPriority.length > 0;
    if (q.type === "learning") return answers.learningStyle.pace !== "" && answers.learningStyle.doubtTime !== "";
    return true;
  };

  const handleChoice = (opt) => setAnswers(a => ({ ...a, [q.id]: opt }));
  const handleScale = (val) => setAnswers(a => ({ ...a, [q.id]: val }));
  const handleMulti = (opt) => {
    setAnswers(a => {
      const curr = a[q.id];
      return { ...a, [q.id]: curr.includes(opt) ? curr.filter(x => x !== opt) : [...curr, opt] };
    });
  };
  const handleSubject = (sub) => {
    setAnswers(a => {
      const curr = a.subjects;
      const newSubs = curr.includes(sub) ? curr.filter(x => x !== sub) : [...curr, sub];
      return { ...a, subjects: newSubs, subjectPriority: newSubs };
    });
  };

  // Drag to rank
  const handleDragStart = (i) => setDragIdx(i);
  const handleDragOver = (e, i) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === i) return;
    setAnswers(a => {
      const arr = [...a.subjectPriority];
      const item = arr.splice(dragIdx, 1)[0];
      arr.splice(i, 0, item);
      setDragIdx(i);
      return { ...a, subjectPriority: arr };
    });
  };
  const handleDragEnd = () => setDragIdx(null);

  const next = () => {
    if (step < QUESTIONS.length - 1) setStep(s => s + 1);
    else onComplete({ ...answers, stream });
  };

  const btnStyle = (selected) => ({
    background: selected ? "#fff" : "transparent",
    color: selected ? "#000" : "#666",
    border: `1px solid ${selected ? "#fff" : "#222"}`,
    borderRadius: 3, padding: "12px 16px",
    fontFamily: "'DM Mono', monospace", fontSize: 12,
    cursor: "pointer", textAlign: "left", transition: "all 0.2s",
  });

  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", padding: "40px 24px",
    }}>
      <div style={{ width: "100%", maxWidth: 520 }}>
        {/* Progress */}
        <div style={{ marginBottom: 40 }}>
          <div style={{
            display: "flex", justifyContent: "space-between",
            fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#333", marginBottom: 10,
          }}>
            <span>Setting up your profile</span>
            <span>{step + 1} / {QUESTIONS.length}</span>
          </div>
          <div style={{ background: "#1a1a1a", borderRadius: 2, height: 2 }}>
            <div style={{
              height: "100%", background: "#fff", borderRadius: 2,
              width: `${progress}%`, transition: "width 0.4s ease",
            }} />
          </div>
        </div>

        <div key={step} style={{ animation: "fadeIn 0.3s ease forwards" }}>
          <h2 style={{
            fontFamily: "'Syne', sans-serif",
            fontSize: "clamp(20px, 4vw, 28px)", fontWeight: 700,
            color: "#fff", margin: "0 0 8px", lineHeight: 1.2,
          }}>
            {q.question}
          </h2>
          {q.subtitle && (
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#444", margin: "0 0 28px" }}>
              {q.subtitle}
            </p>
          )}
          {!q.subtitle && <div style={{ marginBottom: 28 }} />}

          {/* Choice */}
          {q.type === "choice" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {q.options.map(opt => (
                <button key={opt} onClick={() => handleChoice(opt)} style={btnStyle(answers[q.id] === opt)}>
                  {opt}
                </button>
              ))}
            </div>
          )}

          {/* Scale */}
          {q.type === "scale" && (
            <div>
              <div style={{
                display: "flex", justifyContent: "space-between",
                fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#333", marginBottom: 16,
              }}>
                <span>{q.labels[0]}</span><span>{q.labels[1]}</span>
              </div>
              <input
                type="range" min={q.min} max={q.max} value={answers[q.id]}
                onChange={e => handleScale(Number(e.target.value))}
                style={{ width: "100%", accentColor: "#fff", cursor: "pointer" }}
              />
              <div style={{
                textAlign: "center", marginTop: 16,
                fontFamily: "'Syne', sans-serif", fontSize: 36, fontWeight: 800, color: "#fff",
              }}>
                {answers[q.id]}
              </div>
            </div>
          )}

          {/* Multi */}
          {q.type === "multi" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {q.options.map(opt => {
                const selected = answers[q.id].includes(opt);
                return (
                  <button key={opt} onClick={() => handleMulti(opt)} style={btnStyle(selected)}>
                    {opt}
                  </button>
                );
              })}
            </div>
          )}

          {/* Subjects — grade-aware */}
          {q.type === "subjects" && (
            <div>
              {(answers.grade === "Grade 11" || answers.grade === "Grade 12") && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: 10,
                    color: "#333", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10,
                  }}>
                    Which stream?
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {STREAM_OPTIONS.map(s => (
                      <button key={s} onClick={() => { setStream(s); setAnswers(a => ({ ...a, subjects: [], subjectPriority: [] })); }}
                        style={btnStyle(stream === s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {getSubjectList().length > 0 && (
                <div>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: 10,
                    color: "#333", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10,
                  }}>
                    Pick your subjects
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {getSubjectList().map(sub => (
                      <button key={sub} onClick={() => handleSubject(sub)}
                        style={btnStyle(answers.subjects.includes(sub))}>
                        {sub}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Rank — drag to reorder */}
          {q.type === "rank" && (
            <div>
              {answers.subjectPriority.length === 0 ? (
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#333" }}>
                  No subjects selected. Go back and pick your subjects first.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {answers.subjectPriority.map((sub, i) => (
                    <div
                      key={sub}
                      draggable
                      onDragStart={() => handleDragStart(i)}
                      onDragOver={(e) => handleDragOver(e, i)}
                      onDragEnd={handleDragEnd}
                      style={{
                        display: "flex", alignItems: "center", gap: 14,
                        padding: "12px 16px",
                        background: dragIdx === i ? "#1a1a1a" : "#0f0f0f",
                        border: "1px solid #222", borderRadius: 3,
                        cursor: "grab", transition: "background 0.15s",
                      }}
                    >
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#333", minWidth: 20 }}>
                        {i + 1}
                      </span>
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#aaa", flex: 1 }}>
                        {sub}
                      </span>
                      <span style={{ color: "#2a2a2a", fontSize: 12 }}>⠿</span>
                    </div>
                  ))}
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#2a2a2a", marginTop: 8 }}>
                    Drag to reorder
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Learning style */}
          {q.type === "learning" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              {/* Pace */}
              <div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#444", marginBottom: 10 }}>
                  How quickly do you grasp new concepts?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {["Quick — I get things fast", "Moderate — I need a few attempts", "Slow — I need time to absorb properly"].map(opt => (
                    <button key={opt}
                      onClick={() => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, pace: opt } }))}
                      style={btnStyle(answers.learningStyle.pace === opt)}>
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Revision time */}
              <div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#444", marginBottom: 10 }}>
                  How long does revising one subject typically take you?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {["Under 30 minutes", "Around 1 hour", "2+ hours"].map(opt => (
                    <button key={opt}
                      onClick={() => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, revisionTime: opt } }))}
                      style={btnStyle(answers.learningStyle.revisionTime === opt)}>
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Distraction */}
              <div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#444", marginBottom: 10 }}>
                  How easily do you get distracted while studying?
                </div>
                <div style={{
                  display: "flex", justifyContent: "space-between",
                  fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#333", marginBottom: 10,
                }}>
                  <span>Rarely distracted</span><span>Constantly distracted</span>
                </div>
                <input type="range" min={1} max={10}
                  value={answers.learningStyle.distraction}
                  onChange={e => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, distraction: Number(e.target.value) } }))}
                  style={{ width: "100%", accentColor: "#fff", cursor: "pointer" }}
                />
                <div style={{
                  textAlign: "center", marginTop: 10,
                  fontFamily: "'Syne', sans-serif", fontSize: 28, fontWeight: 800, color: "#fff",
                }}>
                  {answers.learningStyle.distraction}
                </div>
              </div>

              {/* Doubt time */}
              <div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#444", marginBottom: 10 }}>
                  Does clearing doubts usually take you a long time?
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  {["Yes, it takes a while", "No, I resolve them quickly"].map(opt => (
                    <button key={opt}
                      onClick={() => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, doubtTime: opt } }))}
                      style={{ ...btnStyle(answers.learningStyle.doubtTime === opt), flex: 1 }}>
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Text */}
          {q.type === "text" && (
            <textarea
              value={answers[q.id]}
              onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
              placeholder="e.g. Board exams in 3 months, aiming for 90%+"
              style={{
                width: "100%", background: "#111", border: "1px solid #222",
                borderRadius: 3, color: "#e5e5e5",
                fontFamily: "'DM Mono', monospace", fontSize: 13,
                lineHeight: 1.7, padding: "16px", resize: "none",
                minHeight: 100, outline: "none", boxSizing: "border-box",
              }}
            />
          )}
        </div>

        {/* Next */}
        <div style={{ marginTop: 40, display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={next}
            disabled={!canProceed()}
            style={{
              background: canProceed() ? "#fff" : "#1a1a1a",
              color: canProceed() ? "#000" : "#333",
              border: "none", borderRadius: 3, padding: "12px 28px",
              fontFamily: "'DM Mono', monospace", fontSize: 13,
              cursor: canProceed() ? "pointer" : "not-allowed", transition: "all 0.2s",
            }}
          >
            {step === QUESTIONS.length - 1 ? "Start using Nirnayam →" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MainApp({ profile }) {
  const [situation, setSituation] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }, [situation]);

  const analyse = async () => {
    if (!situation.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await callNirnayam(situation, profile);
      setResult(res);
      _history = [{ situation, result: res, time: new Date().toLocaleTimeString() }, ..._history.slice(0, 9)];
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", padding: "32px 24px", maxWidth: 620, margin: "0 auto" }}>
      {/* Header */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        marginBottom: 40,
      }}>
        <div>
          <div style={{
            fontFamily: "'Syne', sans-serif",
            fontSize: 22, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em",
          }}>
            Nirnayam
          </div>
          <div style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 11, color: "#333", marginTop: 4,
          }}>
            {profile.grade} · stress {profile.stressLevel}/10 · {profile.priorities.slice(0, 2).join(", ")}
          </div>
        </div>
        <button
          onClick={() => setShowHistory(!showHistory)}
          style={{
            background: "transparent", border: "1px solid #1e1e1e",
            borderRadius: 3, padding: "6px 14px",
            fontFamily: "'DM Mono', monospace", fontSize: 11,
            color: "#444", cursor: "pointer",
          }}
        >
          {showHistory ? "← back" : `history (${_history.length})`}
        </button>
      </div>

      {showHistory ? (
        <HistoryView onSelect={(h) => { setSituation(h.situation); setResult(h.result); setShowHistory(false); }} />
      ) : (
        <>
          {/* Input */}
          <div style={{
            background: "#0f0f0f", border: "1px solid #1e1e1e",
            borderRadius: 4, marginBottom: 16, overflow: "hidden",
          }}>
            <div style={{
              padding: "12px 16px",
              borderBottom: "1px solid #111",
              fontFamily: "'DM Mono', monospace",
              fontSize: 10, color: "#2a2a2a", letterSpacing: "0.2em",
              textTransform: "uppercase",
            }}>
              What are you conflicted about?
            </div>
            <textarea
              ref={textareaRef}
              value={situation}
              onChange={e => setSituation(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) analyse(); }}
              placeholder="e.g. I have a class test tomorrow but basketball tournament practice is today evening. I've revised 60% of the syllabus. I'm moderately stressed..."
              style={{
                width: "100%", background: "transparent", border: "none",
                color: "#e5e5e5", fontFamily: "'DM Mono', monospace",
                fontSize: 13, lineHeight: 1.8, padding: "16px",
                resize: "none", minHeight: 130, outline: "none",
                boxSizing: "border-box",
              }}
            />
            <div style={{
              borderTop: "1px solid #111", padding: "10px 16px",
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#2a2a2a" }}>
                Ctrl+Enter to analyse
              </span>
              <button
                onClick={analyse}
                disabled={loading || !situation.trim()}
                style={{
                  background: loading || !situation.trim() ? "#1a1a1a" : "#fff",
                  color: loading || !situation.trim() ? "#333" : "#000",
                  border: "none", borderRadius: 3, padding: "8px 20px",
                  fontFamily: "'DM Mono', monospace", fontSize: 12,
                  cursor: loading || !situation.trim() ? "not-allowed" : "pointer",
                  transition: "all 0.2s",
                }}
              >
                {loading ? "thinking..." : "decide →"}
              </button>
            </div>
          </div>

          {/* Loading state */}
          {loading && (
            <div style={{
              padding: "40px 0", textAlign: "center",
              fontFamily: "'DM Mono', monospace",
            }}>
              <div style={{ color: "#333", fontSize: 12, animation: "pulse 1.5s ease-in-out infinite" }}>
                analysing your situation...
              </div>
              <div style={{ color: "#1e1e1e", fontSize: 10, marginTop: 8 }}>
                calibrating to your stress level {profile.stressLevel}/10
              </div>
            </div>
          )}

          {error && (
            <div style={{
              background: "#1a0a0a", border: "1px solid #2a1010",
              borderRadius: 3, padding: "14px 16px",
              fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#f87171",
            }}>
              {error}
            </div>
          )}

          {/* Result */}
          {result && <ResultView result={result} />}
        </>
      )}
    </div>
  );
}

function ResultView({ result }) {
  return (
    <div style={{ animation: "fadeIn 0.4s ease forwards" }}>
      {/* Decision — hero */}
      <div style={{
        background: "#0c0c0c", border: "1px solid #1e1e1e",
        borderRadius: 4, padding: "24px", marginBottom: 12,
        borderLeft: `3px solid ${urgencyColor(result.urgency)}`,
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between",
          alignItems: "center", marginBottom: 16,
        }}>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: 10,
            color: "#333", letterSpacing: "0.2em", textTransform: "uppercase",
          }}>
            Decision
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{
              background: urgencyColor(result.urgency) + "22",
              color: urgencyColor(result.urgency),
              fontFamily: "'DM Mono', monospace", fontSize: 10,
              padding: "3px 10px", borderRadius: 2,
              textTransform: "uppercase", letterSpacing: "0.1em",
            }}>
              {result.urgency}
            </span>
            <span style={{
              color: confidenceColor(result.confidence),
              fontFamily: "'Syne', sans-serif",
              fontSize: 18, fontWeight: 800,
            }}>
              {result.confidence}%
            </span>
          </div>
        </div>
        <div style={{
          fontFamily: "'Syne', sans-serif",
          fontSize: "clamp(18px, 3vw, 24px)",
          fontWeight: 700, color: "#fff", lineHeight: 1.3,
        }}>
          {result.decision}
        </div>
      </div>

      {/* Time split */}
      <div style={{
        background: "#0f0f0f", border: "1px solid #1a1a1a",
        borderRadius: 4, padding: "20px", marginBottom: 12,
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: 10,
          color: "#333", letterSpacing: "0.2em", textTransform: "uppercase",
          marginBottom: 14,
        }}>
          How to split your time
        </div>
        <div style={{ display: "flex", gap: 4, height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
          <div style={{
            width: `${result.time_split.option_a}%`,
            background: "#fff", borderRadius: "4px 0 0 4px",
            transition: "width 1s ease",
          }} />
          <div style={{
            width: `${result.time_split.option_b}%`,
            background: "#2a2a2a", borderRadius: "0 4px 4px 0",
          }} />
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between",
          fontFamily: "'DM Mono', monospace", fontSize: 11,
        }}>
          <span style={{ color: "#aaa" }}>Primary task — {result.time_split.option_a}%</span>
          <span style={{ color: "#333" }}>Secondary — {result.time_split.option_b}%</span>
        </div>
      </div>

      {/* Key insight */}
      <div style={{
        background: "#0f0f0f", border: "1px solid #1a1a1a",
        borderRadius: 4, padding: "20px", marginBottom: 12,
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: 10,
          color: "#333", letterSpacing: "0.2em", textTransform: "uppercase",
          marginBottom: 10,
        }}>
          Key insight
        </div>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: 13,
          color: "#aaa", lineHeight: 1.7, fontStyle: "italic",
        }}>
          "{result.key_insight}"
        </div>
      </div>

      {/* Action plan */}
      <div style={{
        background: "#0f0f0f", border: "1px solid #1a1a1a",
        borderRadius: 4, padding: "20px", marginBottom: 12,
      }}>
        <div style={{
          fontFamily: "'DM Mono', monospace", fontSize: 10,
          color: "#333", letterSpacing: "0.2em", textTransform: "uppercase",
          marginBottom: 14,
        }}>
          Action plan
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {result.action_plan.map((step, i) => (
            <div key={i} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{
                width: 22, height: 22, border: "1px solid #222",
                borderRadius: "50%", display: "flex",
                alignItems: "center", justifyContent: "center",
                flexShrink: 0,
                fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#444",
              }}>
                {i + 1}
              </div>
              <span style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 13, color: "#bbb", lineHeight: 1.6,
              }}>
                {step}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Warning */}
      {result.warning && (
        <div style={{
          background: "#0f0a0a", border: "1px solid #2a1a1a",
          borderRadius: 4, padding: "16px 20px",
          display: "flex", gap: 12, alignItems: "flex-start",
        }}>
          <span style={{ color: "#fb923c", fontSize: 14, flexShrink: 0 }}>⚠</span>
          <span style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 12, color: "#666", lineHeight: 1.6,
          }}>
            {result.warning}
          </span>
        </div>
      )}
    </div>
  );
}

function HistoryView({ onSelect }) {
  if (_history.length === 0) {
    return (
      <div style={{
        textAlign: "center", padding: "60px 0",
        fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#2a2a2a",
      }}>
        No decisions yet. Make your first one.
      </div>
    );
  }

  return (
    <div>
      <div style={{
        fontFamily: "'DM Mono', monospace", fontSize: 10,
        color: "#2a2a2a", letterSpacing: "0.2em",
        textTransform: "uppercase", marginBottom: 16,
      }}>
        Past decisions
      </div>
      {_history.map((h, i) => (
        <div
          key={i}
          onClick={() => onSelect(h)}
          style={{
            background: "#0f0f0f", border: "1px solid #1a1a1a",
            borderRadius: 3, padding: "14px 16px", marginBottom: 8,
            cursor: "pointer", transition: "border-color 0.2s",
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = "#333"}
          onMouseLeave={e => e.currentTarget.style.borderColor = "#1a1a1a"}
        >
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#666",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            marginBottom: 6,
          }}>
            {h.situation}
          </div>
          <div style={{
            display: "flex", gap: 16,
            fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#2a2a2a",
          }}>
            <span>{h.result.confidence}% confidence</span>
            <span style={{ color: urgencyColor(h.result.urgency) }}>{h.result.urgency}</span>
            <span>{h.time}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function Nirnayam() {
  const [screen, setScreen] = useState("landing");
  const [puterReady, setPuterReady] = useState(typeof puter !== "undefined");

  useEffect(() => {
    if (_profile) setScreen("app");
    if (typeof puter !== "undefined") { setPuterReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://js.puter.com/v2/";
    script.onload = () => setPuterReady(true);
    document.head.appendChild(script);
  }, []);

  return (
    <div style={{
      minHeight: "100vh",
      background: "#080808",
      color: "#e5e5e5",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&family=Syne:wght@700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] { -webkit-appearance: none; height: 2px; background: #222; border-radius: 2px; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; background: #fff; border-radius: 50%; cursor: pointer; }
        textarea { outline: none; }
        button { transition: opacity 0.2s; }
        button:hover { opacity: 0.85; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }
      `}</style>

      {screen === "landing" && (
        <LandingPage onStart={() => setScreen("onboarding")} />
      )}
      {screen === "onboarding" && (
        <OnboardingPage onComplete={(profile) => {
          _profile = profile;
          setScreen("app");
        }} />
      )}
      {screen === "app" && _profile && (
        <MainApp profile={_profile} />
      )}
    </div>
  );
}
