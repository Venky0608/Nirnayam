import React, { useState, useEffect, useRef } from "react";
import { signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";
import { doc, setDoc, getDoc, collection, addDoc, getDocs, query, orderBy, limit } from "firebase/firestore";
import { auth, provider, db } from "./firebase";

// ─── Storage ──────────────────────────────────────────────────────────────────
let _history = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const mono = "'DM Mono', monospace";
const syne = "'Syne', sans-serif";

const urgencyColor = (u) => ({ low: "#4ade80", medium: "#facc15", high: "#fb923c", critical: "#f87171" }[u] || "#888");
const confidenceColor = (c) => c >= 75 ? "#4ade80" : c >= 50 ? "#facc15" : "#f87171";

// ─── Firebase helpers ─────────────────────────────────────────────────────────
const saveProfile = async (uid, profile) => {
  await setDoc(doc(db, "users", uid), { profile, updatedAt: new Date().toISOString() }, { merge: true });
};

const loadProfile = async (uid) => {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() && snap.data().profile ? snap.data().profile : null;
};

const saveRating = async (uid, ratingData) => {
  await addDoc(collection(db, "users", uid, "ratings"), {
    ...ratingData,
    createdAt: new Date().toISOString(),
  });
};

const loadPersonalisationStats = async (uid) => {
  try {
    const q = query(collection(db, "users", uid, "ratings"), orderBy("createdAt", "desc"), limit(50));
    const snap = await getDocs(q);
    const ratings = snap.docs.map(d => d.data());
    if (ratings.length === 0) return null;

    // Group by category
    const grouped = {};
    ratings.forEach(r => {
      const cat = r.category || "General";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(r.stars);
    });

    const stats = {};
    Object.entries(grouped).forEach(([cat, stars]) => {
      const avg = stars.reduce((a, b) => a + b, 0) / stars.length;
      stats[cat] = { avg: Math.round(avg * 10) / 10, count: stars.length };
    });

    return { stats, total: ratings.length };
  } catch {
    return null;
  }
};

const buildPersonalisationContext = (personData) => {
  if (!personData || personData.total < 3) return "";
  const lines = Object.entries(personData.stats).map(([cat, data]) => {
    const quality = data.avg >= 4 ? "works well" : data.avg >= 3 ? "moderate results" : "often unsatisfying";
    return `${cat} advice: ${data.avg}/5 avg (${data.count} ratings) — ${quality} for this student`;
  });
  return `\n\nPERSONALISATION (learned from past ratings):\n${lines.join("\n")}\nAdjust your recommendations based on what has worked well for this student historically.`;
};

// ─── System prompt ────────────────────────────────────────────────────────────
const buildSystemPrompt = (profile, personData) => `You are Nirnayam — a sharp decision advisor for students grades 9-12. Break decision paralysis fast.

Profile: Grade ${profile.grade}${profile.stream ? ` ${profile.stream}` : ""} | Stress: ${profile.stressLevel}/10 | Time mgmt: ${profile.timeManagement}/10 | Priorities: ${profile.priorities.join(", ")} | Subjects: ${profile.allSubjects?.join(", ") || "?"} | Subject priority: ${profile.subjectPriority?.join(" > ") || "?"} | Learning pace: ${profile.learningStyle?.pace || "?"} | Revision time: ${profile.learningStyle?.revisionTime || "?"} | Distraction: ${profile.learningStyle?.distraction}/10 | Slow at doubts: ${profile.learningStyle?.doubtTime || "?"} | Extra: ${profile.additionalContext || "none"}${buildPersonalisationContext(personData)}

LANGUAGE: Handle spelling mistakes and casual language naturally. tmr=tomorrow, rn=now, stressed/freaking out=high stress, kinda worried=medium, chill=low. Never ask to rephrase.

CATEGORIES: Pick exactly one.
- Study: one subject/task now
- Activity: non-academic (rest, eat, sport, hang out, art)
- Split: divide time between two options
- Priority: multiple academic tasks, give order (X first, then Y)
Key: "study math or physics?" = Priority. "study or rest?" = Activity if exhausted.

RULES: One clear recommendation only. Direct like a smart older sibling. Use subject priority order to break ties. Flag urgency clearly. Be decisive and concise. Avoid vague phrases. Be specific and actionable.

Respond ONLY in this JSON, no preamble, no backticks:
{"decision":"one clear action","confidence":85,"urgency":"high","category":"Study","time_split":{"option_a":70,"option_b":30},"key_insight":"one thing that tips this","action_plan":["step 1","step 2","step 3"],"warning":"one thing to watch or null"}
urgency: low/medium/high/critical. category: Study/Activity/Split/Priority. time_split must add to 100.`;

// ─── API ──────────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_KEY;

const callNirnayam = async (situation, profile, personData) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: buildSystemPrompt(profile, personData) }] },
          contents: [{ role: "user", parts: [{ text: situation }] }],
          generationConfig: { maxOutputTokens: 5000, temperature: 0.7 }
        }),
      }
    );
    clearTimeout(timeout);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.candidates[0].content.parts[0].text;
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Request timed out. Try again.");
    throw err;
  }
};

// ─── Subject data ─────────────────────────────────────────────────────────────
const COMPULSORY = {
  "Grade 9": ["Math", "Science", "Social Studies", "English"],
  "Grade 10": ["Math", "Science", "Social Studies", "English"],
  "Science (PCM)": ["Physics", "Chemistry", "Math", "English"],
  "Science (PCB)": ["Physics", "Chemistry", "Biology", "English"],
  "Commerce": ["Accountancy", "Business Studies", "Economics", "English"],
  "Humanities": ["History", "Political Science", "Geography", "English"],
};

const OPTIONAL = {
  "Grade 9": ["Hindi", "Kannada", "Tamil", "Sanskrit", "French", "Computer Science", "Artificial Intelligence", "Physical Education"],
  "Grade 10": ["Hindi", "Kannada", "Tamil", "Sanskrit", "French", "Computer Science", "Artificial Intelligence", "Physical Education"],
  "Science (PCM)": ["Computer Science", "Artificial Intelligence", "Economics", "Physical Education", "Psychology", "Biology"],
  "Science (PCB)": ["Math", "Computer Science", "Artificial Intelligence", "Physical Education", "Psychology", "Biotechnology"],
  "Commerce": ["Math", "Computer Science", "Artificial Intelligence", "Entrepreneurship", "Physical Education", "Psychology"],
  "Humanities": ["Economics", "Psychology", "Sociology", "Fine Arts", "Physical Education", "Computer Science", "Artificial Intelligence", "Math"],
};

const GRADE_OPTIONS = ["Grade 9", "Grade 10", "Grade 11", "Grade 12"];
const STREAM_OPTIONS = ["Science (PCM)", "Science (PCB)", "Commerce", "Humanities"];

// ─── Landing Page ─────────────────────────────────────────────────────────────
function LandingPage({ user, profile, onGoogleSignIn, onGuestStart, onContinue, authLoading }) {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setTimeout(() => setVisible(true), 100); }, []);

  const isReturning = user && profile;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", textAlign: "center", position: "relative" }}>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E")`, pointerEvents: "none" }} />

      <div style={{ position: "relative", zIndex: 1, opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(24px)", transition: "all 0.8s cubic-bezier(0.16, 1, 0.3, 1)", maxWidth: 520, width: "100%" }}>

        <div style={{ width: 60, height: 60, border: "1px solid #444", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 28px" }}>
          <div style={{ width: 22, height: 22, border: "1px solid #888", transform: "rotate(45deg)" }} />
        </div>

        <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: "0.2em", color: "#666", marginBottom: 14 }}>
          निर्णय · నిర్ణయం · ನಿರ್ಣಯ · முடிவு · Decision
        </div>

        <h1 style={{ width: "100%", display: "flex", justifyContent: "center", textAlign: "center", fontFamily: syne, fontSize: "clamp(40px, 11vw, 92px)", fontWeight: 800, margin: "0 0 8px", lineHeight: 0.9, letterSpacing: "-0.03em", color: "#fff", wordBreak: "keep-all" }}>
          Nirnayam
        </h1>

        <div style={{ fontFamily: mono, fontSize: 12, color: "#555", marginBottom: 28, letterSpacing: "0.1em" }}>
          Your student decision advisor
        </div>

        <div style={{ fontFamily: mono, fontSize: "clamp(15px, 2.8vw, 18px)", lineHeight: 2.3, color: "#bbb", margin: "0 0 32px", fontStyle: "italic", padding: "0 8px" }}>
          "Decisions, decisions to make,<br />
          conflicted and lost on the way,<br />
          so Nirnayam's advice you should take,<br />
          so we can be better than yesterday."
        </div>

        <div style={{ fontFamily: mono, fontSize: "clamp(13px, 2.2vw, 15px)", color: "#999", marginBottom: 16, lineHeight: 2, padding: "0 4px" }}>
          Nirnayam is an AI chatbot that helps students make better decisions — whether you're torn between basketball practice and studying, unsure whether to rest or keep grinding, or confused about which subject to tackle first. Just describe your situation, and Nirnayam gives you a clear, personalised answer.
        </div>

        {!expanded ? (
          <button onClick={() => setExpanded(true)} style={{ background: "transparent", border: "none", color: "#666", fontFamily: mono, fontSize: 13, cursor: "pointer", marginBottom: 36, textDecoration: "underline", WebkitTapHighlightColor: "transparent" }}>
            Why I built this →
          </button>
        ) : (
          <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 36, lineHeight: 1.9, textAlign: "left", background: "#0d0d0d", border: "1px solid #1e1e1e", borderRadius: 8, padding: "24px" }}>
            <p style={{ marginTop: 0, marginBottom: 16 }}>In students, the decision-making part of the brain is still developing. When tough choices come up, it's easy to make decisions you regret — or avoid the decision entirely and doomscroll. As a student myself, I've faced this many times.</p>
            <p style={{ marginBottom: 16 }}>So I built Nirnayam — an AI chatbot made specifically for students. Through a short onboarding process, it gets to know you well: your subjects, priorities, how stress affects you, and your learning style.</p>
            <p style={{ marginBottom: 16 }}>Nirnayam will give you a clear recommendation, show you how confident it is, provide a step-by-step action plan, and flag anything to watch out for. Rate each decision, and Nirnayam learns your patterns over time.</p>
            <p style={{ marginBottom: 16 }}>In the world of AI, let's use it for good. My dream is to use technology to help people — and this is a start.</p>
            <button onClick={() => setExpanded(false)} style={{ background: "transparent", border: "none", color: "#555", fontFamily: mono, fontSize: 12, cursor: "pointer", textDecoration: "underline", WebkitTapHighlightColor: "transparent" }}>Show less ↑</button>
          </div>
        )}

        {/* CTA section */}
        {isReturning ? (
          // Returning signed-in user with profile
          <div>
            <button onClick={onContinue} style={{ background: "#fff", color: "#000", border: "none", borderRadius: 5, padding: "17px 44px", fontFamily: mono, fontSize: 15, fontWeight: 500, cursor: "pointer", letterSpacing: "0.05em", transition: "all 0.2s", display: "block", margin: "0 auto 12px", WebkitTapHighlightColor: "transparent" }}
              onMouseEnter={e => { e.currentTarget.style.background = "#e5e5e5"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}
            >
              Continue as {user.displayName?.split(" ")[0]} →
            </button>
            <div style={{ fontFamily: mono, fontSize: 12, color: "#444", marginBottom: 8 }}>
              Signed in as {user.email}
            </div>
          </div>
        ) : user && !profile ? (
          // Signed in but no profile yet
          <div>
            <button onClick={onContinue} style={{ background: "#fff", color: "#000", border: "none", borderRadius: 5, padding: "17px 44px", fontFamily: mono, fontSize: 15, fontWeight: 500, cursor: "pointer", letterSpacing: "0.05em", display: "block", margin: "0 auto 12px", WebkitTapHighlightColor: "transparent" }}
              onMouseEnter={e => { e.currentTarget.style.background = "#e5e5e5"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}
            >
              Set up your profile →
            </button>
            <div style={{ fontFamily: mono, fontSize: 12, color: "#444" }}>Signed in as {user.email}</div>
          </div>
        ) : (
          // Not signed in
          <div>
            <button onClick={onGoogleSignIn} disabled={authLoading} style={{ background: "#fff", color: "#000", border: "none", borderRadius: 5, padding: "17px 44px", fontFamily: mono, fontSize: 15, fontWeight: 500, cursor: authLoading ? "not-allowed" : "pointer", letterSpacing: "0.05em", transition: "all 0.2s", display: "block", margin: "0 auto 12px", WebkitTapHighlightColor: "transparent", opacity: authLoading ? 0.6 : 1 }}
              onMouseEnter={e => { if (!authLoading) e.currentTarget.style.background = "#e5e5e5"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}
            >
              {authLoading ? "signing in..." : "Continue with Google"}
            </button>
            <button onClick={onGuestStart} style={{ background: "transparent", color: "#777", border: "1px solid #333", borderRadius: 5, padding: "13px 36px", fontFamily: mono, fontSize: 13, cursor: "pointer", letterSpacing: "0.05em", display: "block", margin: "0 auto 8px", WebkitTapHighlightColor: "transparent" }}>
              Continue without account
            </button>
            <div style={{ fontFamily: mono, fontSize: 11, color: "#2a2a2a", marginBottom: 4 }}>Sign in to save your profile and enable personalisation</div>
          </div>
        )}

        <div style={{ marginTop: 24, fontFamily: mono, fontSize: 12, color: "#333" }}>Free · No payment needed</div>

        {/* Creator credit */}
        <div style={{ marginTop: 32, fontFamily: mono, fontSize: 11, color: "#2a2a2a", letterSpacing: "0.05em" }}>
          Created by Venkat Sai Varanasi
        </div>
      </div>
    </div>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────────────────
function OnboardingPage({ onComplete, initialAnswers }) {
  const [step, setStep] = useState(0);
  const [stream, setStream] = useState(initialAnswers?.stream || "");
  const [dragIdx, setDragIdx] = useState(null);
  const [answers, setAnswers] = useState(initialAnswers || {
    grade: "", stressLevel: 5, timeManagement: 6,
    priorities: [], optionalSubjects: [], subjectPriority: [],
    learningStyle: { pace: "", revisionTime: "", distraction: 5, doubtTime: "" },
    additionalContext: ""
  });

  const QUESTIONS = [
    { id: "grade", question: "What grade are you in?", type: "choice", options: GRADE_OPTIONS },
    { id: "stressLevel", question: "How much does stress affect you?", subtitle: "Be honest — this helps calibrate your advice", type: "scale", min: 1, max: 10, labels: ["Stress? What stress?", "Stress hits hard"] },
    { id: "timeManagement", question: "How's your time management?", subtitle: "On a normal school day", type: "scale", min: 1, max: 10, labels: ["I always run out of time", "I manage time well"] },
    { id: "priorities", question: "What matters most to you?", subtitle: "Pick all that apply", type: "multi", options: ["Academics", "Sports", "Music/Arts", "Social life", "Personal projects", "Family"] },
    { id: "optionalSubjects", question: "Which additional subjects do you take?", subtitle: "Your core subjects are already included — pick any extras you study", type: "subjects" },
    { id: "subjectPriority", question: "Rank your subjects by importance", subtitle: "Drag to reorder · Use arrows on mobile — top = most important", type: "rank" },
    { id: "learningStyle", question: "How do you learn?", subtitle: "Helps Nirnayam give smarter time estimates", type: "learning" },
    { id: "additionalContext", question: "Anything else Nirnayam should know?", subtitle: "Optional — upcoming exams, specific goals, etc.", type: "text", optional: true },
  ];

  const q = QUESTIONS[step];
  const streamKey = (answers.grade === "Grade 9" || answers.grade === "Grade 10") ? answers.grade : stream;
  const compulsory = streamKey ? (COMPULSORY[streamKey] || []) : [];
  const optionalList = streamKey ? (OPTIONAL[streamKey] || []) : [];
  const allSubjects = [...compulsory, ...answers.optionalSubjects];
  const progress = (step / QUESTIONS.length) * 100;

  const canProceed = () => {
    if (q.optional) return true;
    if (q.type === "multi") return answers[q.id].length > 0;
    if (q.type === "choice") return answers[q.id] !== "";
    if (q.type === "subjects") {
      if ((answers.grade === "Grade 11" || answers.grade === "Grade 12") && !stream) return false;
      return true;
    }
    if (q.type === "rank") return answers.subjectPriority.length > 0;
    if (q.type === "learning") return answers.learningStyle.pace !== "" && answers.learningStyle.doubtTime !== "";
    return true;
  };

  const handleOptionalSubject = (sub) => {
    setAnswers(a => {
      const newOpt = a.optionalSubjects.includes(sub) ? a.optionalSubjects.filter(x => x !== sub) : [...a.optionalSubjects, sub];
      return { ...a, optionalSubjects: newOpt };
    });
  };

  const next = () => {
    if (q.id === "optionalSubjects") setAnswers(a => ({ ...a, subjectPriority: [...compulsory, ...a.optionalSubjects] }));
    if (step < QUESTIONS.length - 1) setStep(s => s + 1);
    else onComplete({ ...answers, stream, allSubjects });
  };

  const back = () => { if (step > 0) setStep(s => s - 1); };

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

  const moveItem = (from, to) => {
    if (to < 0 || to >= answers.subjectPriority.length) return;
    setAnswers(a => {
      const arr = [...a.subjectPriority];
      const item = arr.splice(from, 1)[0];
      arr.splice(to, 0, item);
      return { ...a, subjectPriority: arr };
    });
  };

  const btnStyle = (selected) => ({
    background: selected ? "#fff" : "transparent", color: selected ? "#000" : "#ccc",
    border: `1px solid ${selected ? "#fff" : "#2a2a2a"}`, borderRadius: 5,
    padding: "14px 16px", fontFamily: mono, fontSize: 14,
    cursor: "pointer", textAlign: "left", transition: "all 0.2s",
    WebkitTapHighlightColor: "transparent", minHeight: 50,
  });

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 20px" }}>
      <div style={{ width: "100%", maxWidth: 540 }}>
        <div style={{ marginBottom: 36 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <button onClick={back} disabled={step === 0} style={{ background: "transparent", border: "none", color: step === 0 ? "#1e1e1e" : "#777", fontFamily: mono, fontSize: 13, cursor: step === 0 ? "default" : "pointer", WebkitTapHighlightColor: "transparent", padding: "4px 0" }}>
              {step > 0 ? "← Back" : ""}
            </button>
            <span style={{ fontFamily: mono, fontSize: 12, color: "#444" }}>{step + 1} / {QUESTIONS.length}</span>
          </div>
          <div style={{ background: "#1a1a1a", borderRadius: 3, height: 3 }}>
            <div style={{ height: "100%", background: "#fff", borderRadius: 3, width: `${progress}%`, transition: "width 0.4s ease" }} />
          </div>
        </div>

        <div key={step} style={{ animation: "fadeIn 0.3s ease forwards" }}>
          <h2 style={{ fontFamily: syne, fontSize: "clamp(22px, 5vw, 30px)", fontWeight: 700, color: "#fff", margin: "0 0 8px", lineHeight: 1.2 }}>{q.question}</h2>
          {q.subtitle && <p style={{ fontFamily: mono, fontSize: 13, color: "#666", margin: "0 0 24px", lineHeight: 1.6 }}>{q.subtitle}</p>}
          {!q.subtitle && <div style={{ marginBottom: 24 }} />}

          {q.type === "choice" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {q.options.map(opt => <button key={opt} onClick={() => setAnswers(a => ({ ...a, [q.id]: opt }))} style={btnStyle(answers[q.id] === opt)}>{opt}</button>)}
            </div>
          )}

          {q.type === "scale" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 12, color: "#666", marginBottom: 16 }}>
                <span>{q.labels[0]}</span><span>{q.labels[1]}</span>
              </div>
              <input type="range" min={q.min} max={q.max} value={answers[q.id]} onChange={e => setAnswers(a => ({ ...a, [q.id]: Number(e.target.value) }))} style={{ width: "100%", accentColor: "#fff", cursor: "pointer" }} />
              <div style={{ textAlign: "center", marginTop: 16, fontFamily: syne, fontSize: 48, fontWeight: 800, color: "#fff" }}>{answers[q.id]}</div>
            </div>
          )}

          {q.type === "multi" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {q.options.map(opt => {
                const sel = answers[q.id].includes(opt);
                return <button key={opt} onClick={() => { const c = answers[q.id]; setAnswers(a => ({ ...a, [q.id]: sel ? c.filter(x => x !== opt) : [...c, opt] })); }} style={{ ...btnStyle(sel), padding: "12px 16px" }}>{opt}</button>;
              })}
            </div>
          )}

          {q.type === "subjects" && (
            <div>
              {(answers.grade === "Grade 11" || answers.grade === "Grade 12") && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontFamily: mono, fontSize: 11, color: "#555", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10 }}>Which stream are you in?</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {STREAM_OPTIONS.map(s => <button key={s} onClick={() => { setStream(s); setAnswers(a => ({ ...a, optionalSubjects: [] })); }} style={{ ...btnStyle(stream === s), padding: "12px 16px" }}>{s}</button>)}
                  </div>
                </div>
              )}
              {compulsory.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontFamily: mono, fontSize: 11, color: "#555", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10 }}>Core subjects — already included</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {compulsory.map(sub => <div key={sub} style={{ background: "#111", border: "1px solid #222", borderRadius: 5, padding: "10px 14px", fontFamily: mono, fontSize: 13, color: "#666" }}>{sub} ✓</div>)}
                  </div>
                </div>
              )}
              {optionalList.length > 0 && (
                <div>
                  <div style={{ fontFamily: mono, fontSize: 11, color: "#555", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10 }}>Additional subjects — pick any you study</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {optionalList.map(sub => <button key={sub} onClick={() => handleOptionalSubject(sub)} style={{ ...btnStyle(answers.optionalSubjects.includes(sub)), padding: "12px 14px" }}>{sub}</button>)}
                  </div>
                </div>
              )}
            </div>
          )}

          {q.type === "rank" && (
            <div>
              {answers.subjectPriority.length === 0 ? (
                <div style={{ fontFamily: mono, fontSize: 13, color: "#555" }}>No subjects selected. Go back and select your subjects.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {answers.subjectPriority.map((sub, i) => (
                    <div key={sub} draggable onDragStart={() => handleDragStart(i)} onDragOver={(e) => handleDragOver(e, i)} onDragEnd={handleDragEnd}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: dragIdx === i ? "#1e1e1e" : "#0d0d0d", border: `1px solid ${dragIdx === i ? "#444" : "#222"}`, borderRadius: 5, userSelect: "none", WebkitUserSelect: "none" }}
                    >
                      <span style={{ fontFamily: mono, fontSize: 12, color: "#444", minWidth: 22 }}>{i + 1}</span>
                      <span style={{ fontFamily: mono, fontSize: 14, color: "#ccc", flex: 1 }}>{sub}</span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <button onClick={() => moveItem(i, i - 1)} style={{ background: "transparent", border: "1px solid #222", borderRadius: 3, color: "#555", cursor: "pointer", fontSize: 12, padding: "2px 8px", WebkitTapHighlightColor: "transparent" }}>↑</button>
                        <button onClick={() => moveItem(i, i + 1)} style={{ background: "transparent", border: "1px solid #222", borderRadius: 3, color: "#555", cursor: "pointer", fontSize: 12, padding: "2px 8px", WebkitTapHighlightColor: "transparent" }}>↓</button>
                      </div>
                    </div>
                  ))}
                  <div style={{ fontFamily: mono, fontSize: 11, color: "#333", marginTop: 6 }}>Drag to reorder on desktop · Use arrows on mobile</div>
                </div>
              )}
            </div>
          )}

          {q.type === "learning" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <div>
                <div style={{ fontFamily: mono, fontSize: 13, color: "#777", marginBottom: 10 }}>How quickly do you grasp new concepts?</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {["Quick — I get things fast", "Moderate — I need a few attempts", "Slow — I need time to absorb properly"].map(opt => (
                    <button key={opt} onClick={() => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, pace: opt } }))} style={btnStyle(answers.learningStyle.pace === opt)}>{opt}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: mono, fontSize: 13, color: "#777", marginBottom: 10 }}>How long does revising one subject typically take you?</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {["Under 30 minutes", "Around 1 hour", "2+ hours"].map(opt => (
                    <button key={opt} onClick={() => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, revisionTime: opt } }))} style={btnStyle(answers.learningStyle.revisionTime === opt)}>{opt}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: mono, fontSize: 13, color: "#777", marginBottom: 10 }}>How easily do you get distracted while studying?</div>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 12, color: "#555", marginBottom: 12 }}>
                  <span>Rarely distracted</span><span>Constantly distracted</span>
                </div>
                <input type="range" min={1} max={10} value={answers.learningStyle.distraction} onChange={e => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, distraction: Number(e.target.value) } }))} style={{ width: "100%", accentColor: "#fff", cursor: "pointer" }} />
                <div style={{ textAlign: "center", marginTop: 12, fontFamily: syne, fontSize: 40, fontWeight: 800, color: "#fff" }}>{answers.learningStyle.distraction}</div>
              </div>
              <div>
                <div style={{ fontFamily: mono, fontSize: 13, color: "#777", marginBottom: 10 }}>Does clearing doubts usually take you a long time?</div>
                <div style={{ display: "flex", gap: 10 }}>
                  {["Yes, it takes a while", "No, I resolve them quickly"].map(opt => (
                    <button key={opt} onClick={() => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, doubtTime: opt } }))} style={{ ...btnStyle(answers.learningStyle.doubtTime === opt), flex: 1 }}>{opt}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {q.type === "text" && (
            <textarea value={answers.additionalContext || ""} onChange={e => setAnswers(a => ({ ...a, additionalContext: e.target.value }))} placeholder="e.g. Board exams in 3 months, aiming for 90%+"
              style={{ width: "100%", background: "#0d0d0d", border: "1px solid #2a2a2a", borderRadius: 5, color: "#ddd", fontFamily: mono, fontSize: 14, lineHeight: 1.7, padding: "16px", resize: "none", minHeight: 110, outline: "none", boxSizing: "border-box" }}
            />
          )}
        </div>

        <div style={{ marginTop: 36, display: "flex", justifyContent: "flex-end" }}>
          <button onClick={next} disabled={!canProceed()} style={{ background: canProceed() ? "#fff" : "#1a1a1a", color: canProceed() ? "#000" : "#333", border: "none", borderRadius: 5, padding: "15px 34px", fontFamily: mono, fontSize: 14, cursor: canProceed() ? "pointer" : "not-allowed", transition: "all 0.2s", WebkitTapHighlightColor: "transparent" }}>
            {step === QUESTIONS.length - 1 ? "Start using Nirnayam →" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Star Rating ──────────────────────────────────────────────────────────────
function StarRating({ result, situation, user, onGoogleSignIn, onRated }) {
  const [hovered, setHovered] = useState(0);
  const [selected, setSelected] = useState(0);
  const [showSignInPrompt, setShowSignInPrompt] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleRate = async (stars) => {
    setSelected(stars);
    if (!user) {
      setShowSignInPrompt(true);
      return;
    }
    try {
      await saveRating(user.uid, {
        stars,
        category: result.category || "General",
        decision: result.decision,
        situation: situation.slice(0, 200),
      });
      setSaved(true);
      if (onRated) onRated();
    } catch (e) {
      console.error("Failed to save rating:", e);
    }
  };

  if (saved) {
    return (
      <div style={{ background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 8, padding: "18px", marginTop: 10, textAlign: "center" }}>
        <div style={{ fontFamily: mono, fontSize: 13, color: "#4ade80" }}>Rating saved. Nirnayam is learning. ✓</div>
      </div>
    );
  }

  return (
    <div style={{ background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 8, padding: "18px", marginTop: 10 }}>
      <div style={{ fontFamily: mono, fontSize: 11, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12 }}>How did this advice work out?</div>

      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 10 }}>
        {[1, 2, 3, 4, 5].map(star => (
          <button key={star} onClick={() => handleRate(star)} onMouseEnter={() => setHovered(star)} onMouseLeave={() => setHovered(0)}
            style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 28, padding: "4px", WebkitTapHighlightColor: "transparent", transition: "transform 0.1s", transform: (hovered >= star || selected >= star) ? "scale(1.2)" : "scale(1)" }}
          >
            <span style={{ color: (hovered >= star || selected >= star) ? "#facc15" : "#333" }}>★</span>
          </button>
        ))}
      </div>

      <div style={{ fontFamily: mono, fontSize: 11, color: "#333", textAlign: "center" }}>
        {selected === 0 ? "Rate to help Nirnayam learn your patterns" : selected <= 2 ? "Got it — Nirnayam will adjust" : selected <= 3 ? "Thanks for the feedback" : "Great — Nirnayam will remember this works for you"}
      </div>

      {/* Sign-in prompt for guests */}
      {showSignInPrompt && (
        <div style={{ marginTop: 16, background: "#0a0a0a", border: "1px solid #222", borderRadius: 6, padding: "16px", textAlign: "center" }}>
          <div style={{ fontFamily: mono, fontSize: 13, color: "#aaa", marginBottom: 12, lineHeight: 1.7 }}>
            Sign in to enable personalisation.<br />
            <span style={{ color: "#666", fontSize: 12 }}>Your ratings train Nirnayam to learn your patterns over time.</span>
          </div>
          <button onClick={onGoogleSignIn} style={{ background: "#fff", color: "#000", border: "none", borderRadius: 4, padding: "10px 24px", fontFamily: mono, fontSize: 13, cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
            Sign in with Google
          </button>
          <button onClick={() => setShowSignInPrompt(false)} style={{ background: "transparent", border: "none", color: "#444", fontFamily: mono, fontSize: 12, cursor: "pointer", marginTop: 10, display: "block", margin: "10px auto 0", WebkitTapHighlightColor: "transparent" }}>
            Maybe later
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function MainApp({ profile, user, personData, onEditProfile, onSignOut, onGoogleSignIn, onGoToLanding, onPersonDataRefresh }) {
  const [situation, setSituation] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }, [situation]);

  const analyse = async () => {
    if (!situation.trim()) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await callNirnayam(situation, profile, personData);
      setResult(res);
      _history = [{ situation, result: res, time: new Date().toLocaleTimeString() }, ..._history.slice(0, 9)];
    } catch (e) {
      setError(e.message || "Something went wrong. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  if (showSettings) {
    return <SettingsPage profile={profile} user={user} personData={personData} onEditProfile={onEditProfile} onSignOut={onSignOut} onBack={() => setShowSettings(false)} onGoToLanding={onGoToLanding} />;
  }

  return (
    <div style={{ minHeight: "100vh", padding: "28px 20px", maxWidth: 660, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 32 }}>
        <div>
          <button onClick={onGoToLanding} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, WebkitTapHighlightColor: "transparent" }}>
            <div style={{ fontFamily: syne, fontSize: 26, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>Nirnayam</div>
          </button>
          <div style={{ fontFamily: mono, fontSize: 13, color: "#666", marginTop: 4 }}>
            {profile.grade}{profile.stream ? ` · ${profile.stream}` : ""} · stress {profile.stressLevel}/10
            {!user && <span style={{ color: "#333", marginLeft: 8 }}>· guest</span>}
            {personData && personData.total >= 3 && <span style={{ color: "#4ade80", marginLeft: 8 }}>· personalised</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowHistory(!showHistory)} style={{ background: "transparent", border: "1px solid #222", borderRadius: 4, padding: "9px 14px", fontFamily: mono, fontSize: 13, color: "#666", cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
            {showHistory ? "← back" : `history (${_history.length})`}
          </button>
          <button onClick={() => setShowSettings(true)} style={{ background: "transparent", border: "1px solid #222", borderRadius: 4, padding: "9px 14px", fontFamily: mono, fontSize: 13, color: "#666", cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
            settings
          </button>
        </div>
      </div>

      {showHistory ? (
        <HistoryView onSelect={(h) => { setSituation(h.situation); setResult(h.result); setShowHistory(false); }} />
      ) : (
        <>
          <div style={{ background: "#0d0d0d", border: "1px solid #1e1e1e", borderRadius: 8, marginBottom: 16, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid #111", fontFamily: mono, fontSize: 11, color: "#444", letterSpacing: "0.15em", textTransform: "uppercase" }}>
              What are you conflicted about?
            </div>
            <textarea ref={textareaRef} value={situation} onChange={e => setSituation(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) analyse(); }}
              placeholder={"Describe your full situation. The more detail, the better the advice.\n\ne.g. 'I have a Math exam in 2 days. Revision is mostly done but I'm stressed. Basketball finals are tomorrow and coach wants me at practice today. What should I do?'"}
              style={{ width: "100%", background: "transparent", border: "none", color: "#ddd", fontFamily: mono, fontSize: 14, lineHeight: 1.8, padding: "16px", resize: "none", minHeight: 140, outline: "none", boxSizing: "border-box" }}
            />
            <div style={{ borderTop: "1px solid #111", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: mono, fontSize: 12, color: "#2a2a2a" }}>{situation.length > 0 ? `${situation.length} chars` : "Ctrl+Enter to analyse"}</span>
              <button onClick={analyse} disabled={loading || !situation.trim()} style={{ background: loading || !situation.trim() ? "#1a1a1a" : "#fff", color: loading || !situation.trim() ? "#333" : "#000", border: "none", borderRadius: 5, padding: "11px 24px", fontFamily: mono, fontSize: 14, cursor: loading || !situation.trim() ? "not-allowed" : "pointer", transition: "all 0.2s", WebkitTapHighlightColor: "transparent" }}>
                {loading ? "thinking..." : "decide →"}
              </button>
            </div>
          </div>

          {loading && (
            <div style={{ padding: "40px 0", textAlign: "center", fontFamily: mono }}>
              <div style={{ color: "#555", fontSize: 14, animation: "pulse 1.5s ease-in-out infinite" }}>analysing your situation...</div>
              <div style={{ color: "#2a2a2a", fontSize: 12, marginTop: 8 }}>
                {personData && personData.total >= 3 ? `personalised based on ${personData.total} past ratings` : `calibrating to your stress level ${profile.stressLevel}/10`}
              </div>
            </div>
          )}

          {error && <div style={{ background: "#1a0a0a", border: "1px solid #2a1010", borderRadius: 6, padding: "14px 18px", fontFamily: mono, fontSize: 13, color: "#f87171" }}>{error}</div>}

          {result && (
            <>
              <ResultView result={result} />
              <StarRating result={result} situation={situation} user={user} onGoogleSignIn={onGoogleSignIn} onRated={onPersonDataRefresh} />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Settings Page ────────────────────────────────────────────────────────────
function SettingsPage({ profile, user, personData, onEditProfile, onSignOut, onBack, onGoToLanding }) {
  return (
    <div style={{ minHeight: "100vh", padding: "32px 20px", maxWidth: 540, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 40 }}>
        <button onClick={onBack} style={{ background: "transparent", border: "none", color: "#777", fontFamily: mono, fontSize: 13, cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>← Back</button>
        <div style={{ fontFamily: syne, fontSize: 22, fontWeight: 800, color: "#fff" }}>Settings</div>
      </div>

      {/* Account */}
      <div style={{ background: "#0d0d0d", border: "1px solid #1e1e1e", borderRadius: 8, padding: "20px", marginBottom: 12 }}>
        <div style={{ fontFamily: mono, fontSize: 10, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 14 }}>Account</div>
        {user ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              {user.photoURL && <img src={user.photoURL} alt="" style={{ width: 36, height: 36, borderRadius: "50%" }} />}
              <div>
                <div style={{ fontFamily: mono, fontSize: 14, color: "#ccc" }}>{user.displayName}</div>
                <div style={{ fontFamily: mono, fontSize: 12, color: "#555", marginTop: 2 }}>{user.email}</div>
              </div>
            </div>
            <button onClick={onSignOut} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: 4, padding: "10px 20px", fontFamily: mono, fontSize: 13, color: "#f87171", cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
              Sign out
            </button>
          </div>
        ) : (
          <div style={{ fontFamily: mono, fontSize: 13, color: "#666" }}>
            You're using Nirnayam as a guest. Sign in to save your profile and enable personalisation.
          </div>
        )}
      </div>

      {/* Personalisation stats */}
      {user && personData && personData.total > 0 && (
        <div style={{ background: "#0d0d0d", border: "1px solid #1e1e1e", borderRadius: 8, padding: "20px", marginBottom: 12 }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 14 }}>Personalisation — {personData.total} ratings</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {Object.entries(personData.stats).map(([cat, data]) => (
              <div key={cat} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: mono, fontSize: 13, color: "#888" }}>{cat}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", gap: 2 }}>
                    {[1, 2, 3, 4, 5].map(s => (
                      <span key={s} style={{ fontSize: 12, color: s <= Math.round(data.avg) ? "#facc15" : "#222" }}>★</span>
                    ))}
                  </div>
                  <span style={{ fontFamily: mono, fontSize: 12, color: "#555" }}>{data.avg}/5 ({data.count})</span>
                </div>
              </div>
            ))}
          </div>
          {personData.total < 3 && (
            <div style={{ fontFamily: mono, fontSize: 11, color: "#333", marginTop: 12 }}>Rate 3+ decisions to activate personalisation</div>
          )}
        </div>
      )}

      {/* Profile summary */}
      <div style={{ background: "#0d0d0d", border: "1px solid #1e1e1e", borderRadius: 8, padding: "20px", marginBottom: 12 }}>
        <div style={{ fontFamily: mono, fontSize: 10, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 14 }}>Your Profile</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            ["Grade", `${profile.grade}${profile.stream ? ` · ${profile.stream}` : ""}`],
            ["Stress sensitivity", `${profile.stressLevel}/10`],
            ["Time management", `${profile.timeManagement}/10`],
            ["Priorities", profile.priorities?.join(", ") || "—"],
            ["Subjects", profile.allSubjects?.join(", ") || "—"],
            ["Learning pace", profile.learningStyle?.pace || "—"],
          ].map(([label, val]) => (
            <div key={label} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span style={{ fontFamily: mono, fontSize: 12, color: "#444", minWidth: 140, flexShrink: 0 }}>{label}</span>
              <span style={{ fontFamily: mono, fontSize: 12, color: "#888", lineHeight: 1.5 }}>{val}</span>
            </div>
          ))}
        </div>
      </div>

      <button onClick={onEditProfile} style={{ width: "100%", background: "#fff", color: "#000", border: "none", borderRadius: 5, padding: "14px", fontFamily: mono, fontSize: 14, cursor: "pointer", WebkitTapHighlightColor: "transparent", marginBottom: 8 }}>
        Edit profile
      </button>
      <div style={{ fontFamily: mono, fontSize: 11, color: "#2a2a2a", textAlign: "center" }}>Editing will re-run the onboarding questionnaire</div>
    </div>
  );
}

// ─── Result View ──────────────────────────────────────────────────────────────
function ResultView({ result }) {
  return (
    <div style={{ animation: "fadeIn 0.4s ease forwards" }}>
      <div style={{ background: "#0c0c0c", border: "1px solid #1e1e1e", borderRadius: 8, padding: "22px", marginBottom: 10, borderLeft: `3px solid ${urgencyColor(result.urgency)}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontFamily: mono, fontSize: 11, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase" }}>Decision</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ background: urgencyColor(result.urgency) + "22", color: urgencyColor(result.urgency), fontFamily: mono, fontSize: 11, padding: "4px 11px", borderRadius: 3, textTransform: "uppercase" }}>{result.urgency}</span>
            <span style={{ color: confidenceColor(result.confidence), fontFamily: syne, fontSize: 22, fontWeight: 800 }}>{result.confidence}%</span>
          </div>
        </div>
        <div style={{ fontFamily: syne, fontSize: "clamp(19px, 3.5vw, 25px)", fontWeight: 700, color: "#fff", lineHeight: 1.3 }}>{result.decision}</div>
      </div>

      <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: 8, padding: "18px", marginBottom: 10 }}>
        <div style={{ fontFamily: mono, fontSize: 11, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12 }}>How to split your time</div>
        <div style={{ display: "flex", gap: 3, height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
          <div style={{ width: `${result.time_split?.option_a || 70}%`, background: "#fff", transition: "width 1s ease" }} />
          <div style={{ flex: 1, background: "#2a2a2a" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 13 }}>
          <span style={{ color: "#ccc" }}>Primary — {result.time_split?.option_a || 70}%</span>
          <span style={{ color: "#555" }}>Secondary — {result.time_split?.option_b || 30}%</span>
        </div>
      </div>

      <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: 8, padding: "18px", marginBottom: 10 }}>
        <div style={{ fontFamily: mono, fontSize: 11, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10 }}>Key insight</div>
        <div style={{ fontFamily: mono, fontSize: 15, color: "#bbb", lineHeight: 1.7, fontStyle: "italic" }}>"{result.key_insight}"</div>
      </div>

      <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: 8, padding: "18px", marginBottom: 10 }}>
        <div style={{ fontFamily: mono, fontSize: 11, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 14 }}>Action plan</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {result.action_plan?.map((step, i) => (
            <div key={i} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{ width: 28, height: 28, border: "1px solid #2a2a2a", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: mono, fontSize: 12, color: "#555" }}>{i + 1}</div>
              <span style={{ fontFamily: mono, fontSize: 14, color: "#ccc", lineHeight: 1.7 }}>{step}</span>
            </div>
          ))}
        </div>
      </div>

      {result.warning && result.warning !== "null" && (
        <div style={{ background: "#0f0a0a", border: "1px solid #2a1a1a", borderRadius: 8, padding: "14px 18px", display: "flex", gap: 12, alignItems: "flex-start" }}>
          <span style={{ color: "#fb923c", fontSize: 17, flexShrink: 0 }}>⚠</span>
          <span style={{ fontFamily: mono, fontSize: 14, color: "#888", lineHeight: 1.7 }}>{result.warning}</span>
        </div>
      )}
    </div>
  );
}

// ─── History View ─────────────────────────────────────────────────────────────
function HistoryView({ onSelect }) {
  if (_history.length === 0) {
    return <div style={{ textAlign: "center", padding: "60px 0", fontFamily: mono, fontSize: 14, color: "#2a2a2a" }}>No decisions yet this session.</div>;
  }
  return (
    <div>
      <div style={{ fontFamily: mono, fontSize: 11, color: "#2a2a2a", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 16 }}>This session</div>
      {_history.map((h, i) => (
        <div key={i} onClick={() => onSelect(h)} style={{ background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 6, padding: "14px 16px", marginBottom: 8, cursor: "pointer" }}
          onMouseEnter={e => e.currentTarget.style.borderColor = "#333"}
          onMouseLeave={e => e.currentTarget.style.borderColor = "#1a1a1a"}
        >
          <div style={{ fontFamily: mono, fontSize: 13, color: "#777", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 6 }}>{h.situation}</div>
          <div style={{ display: "flex", gap: 16, fontFamily: mono, fontSize: 12, color: "#333" }}>
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
  const [screen, setScreen] = useState("loading");
  const [profile, setProfile] = useState(null);
  const [user, setUser] = useState(null);
  const [personData, setPersonData] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);

  const refreshPersonData = async (uid) => {
    const data = await loadPersonalisationStats(uid);
    setPersonData(data);
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setAuthLoading(false);
      if (firebaseUser) {
        setUser(firebaseUser);
        try {
          const savedProfile = await loadProfile(firebaseUser.uid);
          if (savedProfile) {
            setProfile(savedProfile);
            await refreshPersonData(firebaseUser.uid);
          }
        } catch (e) {
          console.error(e);
        }
        setScreen("landing");
      } else {
        setUser(null);
        setProfile(null);
        setPersonData(null);
        setScreen("landing");
      }
    });
    return () => unsub();
  }, []);

  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      console.error(e);
      setAuthLoading(false);
    }
  };

  const handleOnboardingComplete = async (newProfile) => {
    setProfile(newProfile);
    if (user) {
      try {
        await saveProfile(user.uid, newProfile);
      } catch (e) {
        console.error(e);
      }
    }
    setScreen("app");
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setProfile(null);
    setPersonData(null);
    setScreen("landing");
  };

  return (
    <div style={{ minHeight: "100vh", background: "#080808", color: "#e5e5e5" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&family=Syne:wght@700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] { -webkit-appearance: none; height: 4px; background: #1e1e1e; border-radius: 4px; width: 100%; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 24px; height: 24px; background: #fff; border-radius: 50%; cursor: pointer; }
        input[type=range]::-moz-range-thumb { width: 24px; height: 24px; background: #fff; border-radius: 50%; cursor: pointer; border: none; }
        textarea { outline: none; -webkit-tap-highlight-color: transparent; }
        button { -webkit-tap-highlight-color: transparent; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #080808; }
        ::-webkit-scrollbar-thumb { background: #1e1e1e; border-radius: 2px; }
      `}</style>

      {screen === "loading" && (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontFamily: mono, fontSize: 13, color: "#333", animation: "pulse 1.5s ease-in-out infinite" }}>loading...</div>
        </div>
      )}

      {screen === "landing" && (
        <LandingPage
          user={user}
          profile={profile}
          onGoogleSignIn={handleGoogleSignIn}
          onGuestStart={() => setScreen("onboarding")}
          onContinue={() => {
            if (profile) setScreen("app");
            else setScreen("onboarding");
          }}
          authLoading={authLoading}
        />
      )}

      {screen === "onboarding" && (
        <OnboardingPage onComplete={handleOnboardingComplete} initialAnswers={profile} />
      )}

      {screen === "app" && profile && (
        <MainApp
          profile={profile}
          user={user}
          personData={personData}
          onEditProfile={() => setScreen("onboarding")}
          onSignOut={handleSignOut}
          onGoogleSignIn={handleGoogleSignIn}
          onGoToLanding={() => setScreen("landing")}
          onPersonDataRefresh={() => user && refreshPersonData(user.uid)}
        />
      )}
    </div>
  );
}
