import React, { useState, useEffect, useRef } from "react";
import { signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";
import { doc, setDoc, getDoc, collection, addDoc, getDocs, query, orderBy, limit } from "firebase/firestore";
import { auth, provider, db } from "./firebase";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const mono = "'DM Mono', monospace";
const syne = "'Syne', sans-serif";
const urgencyColor = (u) => ({ low: "#4ade80", medium: "#facc15", high: "#fb923c", critical: "#f87171" }[u] || "#888");
const confidenceColor = (c) => c >= 75 ? "#4ade80" : c >= 50 ? "#facc15" : "#f87171";

const getUrgencyLabel = (confidence) => {
  if (confidence >= 90) return { label: "critical", color: "#f87171" };
  if (confidence >= 80) return { label: "important", color: "#fb923c" };
  if (confidence >= 70) return { label: "moderate", color: "#facc15" };
  if (confidence >= 65) return { label: "low", color: "#4ade80" };
  return { label: "not sure", color: "#555" };
};

// ─── Click sound ──────────────────────────────────────────────────────────────
const playClick = () => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 800;
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.08);
  } catch {}
};

// ─── Firebase helpers ─────────────────────────────────────────────────────────
const saveProfile = async (uid, profile) => {
  await setDoc(doc(db, "users", uid), { profile, updatedAt: new Date().toISOString() }, { merge: true });
};
const loadProfile = async (uid) => {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() && snap.data().profile ? snap.data().profile : null;
};
const saveRating = async (uid, ratingData) => {
  await addDoc(collection(db, "users", uid, "ratings"), { ...ratingData, createdAt: new Date().toISOString() });
};
const loadPersonalisationStats = async (uid) => {
  try {
    const q = query(collection(db, "users", uid, "ratings"), orderBy("createdAt", "desc"), limit(100));
    const snap = await getDocs(q);
    const ratings = snap.docs.map(d => d.data());
    if (ratings.length === 0) return null;
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
  } catch { return null; }
};

const buildPersonalisationContext = (personData) => {
  if (!personData || personData.total === 0) return "";
  const lines = Object.entries(personData.stats).map(([cat, data]) => {
    const quality = data.avg >= 4 ? "works well" : data.avg >= 3 ? "moderate results" : "often unsatisfying";
    return `${cat} advice: ${data.avg}/5 avg (${data.count} ratings) — ${quality}`;
  });
  return `\n\nPERSONALISATION (${personData.total} ratings — always incorporate):\n${lines.join("\n")}\nAdjust recommendations based on what has historically worked well. Never ignore this.`;
};

// ─── System prompt ────────────────────────────────────────────────────────────
const buildSystemPrompt = (profile, personData) => `You are Nirnayam — a sharp decision advisor for students grades 9-12. Break decision paralysis fast.

Profile:
- Grade: ${profile.grade}${profile.stream ? ` (${profile.stream})` : ""}
- Academic goal: ${profile.academicGoal || "not specified"}${profile.competitiveExam ? ` — preparing for ${profile.competitiveExam}${profile.customExam ? ` (${profile.customExam})` : ""}` : ""}
- Stress sensitivity: ${profile.stressLevel}/10
- Time management: ${profile.timeManagement}/10
- Deadline response: ${profile.deadlineResponse || "not specified"}
- Priorities: ${profile.priorities?.join(", ") || "not specified"}
- Subjects: ${profile.allSubjects?.join(", ") || "not specified"}
- Subject priority: ${profile.subjectPriority?.join(" > ") || "not specified"}
- Learning pace: ${profile.learningStyle?.pace || "not specified"}
- Revision time per subject: ${profile.learningStyle?.revisionTime || "not specified"}
- Distraction level: ${profile.learningStyle?.distraction}/10
- Slow at doubts: ${profile.learningStyle?.doubtTime || "not specified"}
- Extracurriculars: ${profile.extracurriculars || "none"}
- Extra context: ${profile.additionalContext || "none"}${buildPersonalisationContext(personData)}

LANGUAGE: Handle spelling mistakes and casual language naturally. tmr=tomorrow, rn=now, stressed=high stress, kinda worried=medium, chill=low. Never ask to rephrase.

SCOPE: Only answer personal decision or conflict questions a student would face — study, rest, activity, time management, subject prioritisation. If asked something unrelated, return: {"decision":"I can only help with personal decisions and conflicts. Try describing a real situation you are facing.","confidence":0,"urgency":"low","category":"Restricted","time_split":{"option_a":100,"option_b":0,"option_a_label":"Nirnayam","option_b_label":"Other"},"key_insight":"Nirnayam is a decision advisor, not a general assistant","action_plan":["Describe a real conflict or decision you face","Be specific about your situation","Nirnayam will give you a clear recommendation"],"warning":null}

CATEGORIES: Study / Activity / Split / Priority

RULES: One clear recommendation. Direct like a smart older sibling. Use subject priority order to break ties. Factor in deadline response and learning pace. Be specific and actionable.

TIME SPLIT: Always include option_a_label and option_b_label describing what the two options actually are (e.g. "Study" and "Practice", "Rest" and "Revision").

Respond ONLY in this JSON, no preamble, no backticks:
{"decision":"one clear action","confidence":85,"urgency":"high","category":"Study","time_split":{"option_a":70,"option_b":30,"option_a_label":"Study","option_b_label":"Practice"},"key_insight":"one thing that tips this","action_plan":["step 1","step 2","step 3"],"warning":"one thing to watch or null"}
time_split values must be whole numbers and add to exactly 100.`;

// ─── API ──────────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_KEY;
const callNirnayam = async (situation, profile, personData) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ system_instruction: { parts: [{ text: buildSystemPrompt(profile, personData) }] }, contents: [{ role: "user", parts: [{ text: situation }] }], generationConfig: { maxOutputTokens: 5000, temperature: 0.7 } }) }
    );
    clearTimeout(timeout);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.candidates[0].content.parts[0].text;
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) { clearTimeout(timeout); if (err.name === "AbortError") throw new Error("Request timed out. Try again."); throw err; }
};

// ─── Voice helpers ────────────────────────────────────────────────────────────
const startSpeechRecognition = (onResult, onError, onStart, onEnd) => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { onError("Speech recognition is not supported on this browser. Try Chrome."); return null; }
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = "en-IN";
  recognition.onstart = onStart;
  recognition.onresult = (e) => {
    let interim = "";
    let final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    if (final) onResult(final, false);
    else if (interim) onResult(interim, true);
  };
  recognition.onerror = (e) => { onError(e.error === "no-speech" ? "No speech detected. Please try again." : "Couldn't understand. Please try again."); };
  recognition.onend = onEnd;
  recognition.start();
  return recognition;
};

// FIX 4: onerror handler added
const speakText = (text, onStart, onEnd) => {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-IN";
  utterance.rate = 0.95;
  utterance.pitch = 1;
  if (onStart) utterance.onstart = onStart;
  if (onEnd) utterance.onend = onEnd;
  utterance.onerror = () => { if (onEnd) onEnd(); };
  window.speechSynthesis.speak(utterance);
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
  "Grade 9": ["Hindi", "Kannada", "Tamil", "Malayalam", "Sanskrit", "French", "Computer Science", "Artificial Intelligence", "Physical Education"],
  "Grade 10": ["Hindi", "Kannada", "Tamil", "Malayalam", "Sanskrit", "French", "Computer Science", "Artificial Intelligence", "Physical Education"],
  "Science (PCM)": ["Computer Science", "Artificial Intelligence", "Economics", "Physical Education", "Psychology", "Biology"],
  "Science (PCB)": ["Math", "Computer Science", "Artificial Intelligence", "Physical Education", "Psychology", "Biotechnology"],
  "Commerce": ["Math", "Computer Science", "Artificial Intelligence", "Entrepreneurship", "Physical Education", "Psychology"],
  "Humanities": ["Economics", "Psychology", "Sociology", "Fine Arts", "Physical Education", "Computer Science", "Artificial Intelligence", "Math"],
};
const GRADE_OPTIONS = ["Grade 9", "Grade 10", "Grade 11", "Grade 12"];
const STREAM_OPTIONS = ["Science (PCM)", "Science (PCB)", "Commerce", "Humanities"];

// FIX: Competitive exams for ALL grades
const COMPETITIVE_EXAMS_ALL = ["JEE Main", "JEE Advanced", "NEET", "BITSAT", "CUET", "IPMAT", "CLAT", "CA Foundation", "KCET", "MHT CET", "VITEEE", "Other"];
const COMPETITIVE_EXAMS = {
  "Science (PCM)": ["JEE Main", "JEE Advanced", "BITSAT", "VITEEE", "MHT CET", "KCET", "Other"],
  "Science (PCB)": ["NEET", "AIIMS", "JIPMER", "Other"],
  "Commerce": ["CA Foundation", "IPMAT", "CUET", "NPAT (NMIMS)", "SET (Symbiosis)", "CLAT", "Other"],
  "Humanities": ["CUET", "CLAT", "AILET", "NIFT", "NID DAT", "Other"],
  "Grade 9": COMPETITIVE_EXAMS_ALL,
  "Grade 10": COMPETITIVE_EXAMS_ALL,
};

// ─── Step labels for timeline ─────────────────────────────────────────────────
const STEP_LABELS = ["Grade", "Subjects", "Priority", "Goal", "Pressure", "Learning", "About You"];

// ─── PWA install prompt ───────────────────────────────────────────────────────
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; });

// ─── Landing Page ─────────────────────────────────────────────────────────────
function LandingPage({ user, profile, onGoogleSignIn, onGuestStart, onContinue, authLoading }) {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [installable, setInstallable] = useState(!!deferredPrompt);

  useEffect(() => {
    setTimeout(() => setVisible(true), 100);
    const handler = () => setInstallable(true);
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const isReturning = user && profile;

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") { deferredPrompt = null; setInstallable(false); }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", textAlign: "center", position: "relative" }}>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E")`, pointerEvents: "none" }} />
      <div style={{ position: "relative", zIndex: 1, opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(24px)", transition: "all 0.8s cubic-bezier(0.16, 1, 0.3, 1)", maxWidth: 520, width: "100%" }}>
        <div style={{ width: 60, height: 60, border: "1px solid #444", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 28px" }}>
          <div style={{ width: 22, height: 22, border: "1px solid #888", transform: "rotate(45deg)" }} />
        </div>
        <div style={{ fontFamily: mono, fontSize: "clamp(10px, 2.2vw, 12px)", letterSpacing: "0.15em", color: "#666", marginBottom: 14, lineHeight: 1.8 }}>
          निर्णय · నిర్ణయం · ನಿರ್ಣಯ · முடிவு · നിർണ്ണയം · Decision
        </div>
        <h1 style={{ width: "100%", display: "flex", justifyContent: "center", textAlign: "center", fontFamily: syne, fontSize: "clamp(40px, 11vw, 92px)", fontWeight: 800, margin: "0 0 8px", lineHeight: 0.9, letterSpacing: "-0.03em", color: "#fff", wordBreak: "keep-all" }}>
          Nirnayam
        </h1>
        <div style={{ fontFamily: mono, fontSize: 12, color: "#555", marginBottom: 28, letterSpacing: "0.1em" }}>Your student decision advisor</div>
        <div style={{ fontFamily: mono, fontSize: "clamp(14px, 2.5vw, 16px)", lineHeight: 2.3, color: "#bbb", margin: "0 0 28px", fontStyle: "italic", padding: "0 8px" }}>
          "Decisions, decisions to make,<br />
          conflicted and lost on the way,<br />
          so Nirnayam's advice you should take,<br />
          so we can be better than yesterday."
        </div>
        <div style={{ fontFamily: mono, fontSize: "clamp(13px, 2.2vw, 15px)", color: "#999", marginBottom: 16, lineHeight: 2, padding: "0 4px" }}>
          Nirnayam is an AI chatbot that helps students make better decisions — whether you're torn between basketball practice and studying, unsure whether to rest or keep grinding, or confused about which subject to tackle first.
        </div>
        {!expanded ? (
          <button onClick={() => setExpanded(true)} style={{ background: "transparent", border: "none", color: "#666", fontFamily: mono, fontSize: 13, cursor: "pointer", marginBottom: 32, textDecoration: "underline", WebkitTapHighlightColor: "transparent" }}>
            Why I built this →
          </button>
        ) : (
          <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 32, lineHeight: 1.9, textAlign: "left", background: "#0d0d0d", border: "1px solid #1e1e1e", borderRadius: 8, padding: "24px" }}>
            <p style={{ marginTop: 0, marginBottom: 16 }}>In students, the decision-making part of the brain is still developing. When tough choices come up, it's easy to make decisions you regret — or avoid the decision entirely and doomscroll. As a student myself, I've faced this many times.</p>
            <p style={{ marginBottom: 16 }}>So I built Nirnayam. Through a short onboarding, it gets to know you well: your subjects, priorities, how stress affects you, and your learning style. All you need to do is describe your situation honestly.</p>
            <p style={{ marginBottom: 16 }}>Nirnayam gives you a clear recommendation, a confidence score, a step-by-step action plan, and flags anything to watch out for. Rate each decision and it learns your patterns over time.</p>
            <p style={{ marginBottom: 16 }}>In the world of AI, let's use it for good. This is a start.</p>
            <button onClick={() => setExpanded(false)} style={{ background: "transparent", border: "none", color: "#555", fontFamily: mono, fontSize: 12, cursor: "pointer", textDecoration: "underline", WebkitTapHighlightColor: "transparent" }}>Show less ↑</button>
          </div>
        )}

        {installable && (
          <button onClick={handleInstall} style={{ background: "transparent", color: "#4ade80", border: "1px solid #4ade80", borderRadius: 5, padding: "10px 24px", fontFamily: mono, fontSize: 13, cursor: "pointer", display: "block", margin: "0 auto 20px", WebkitTapHighlightColor: "transparent" }}>
            ↓ Install Nirnayam as an App
          </button>
        )}

        {isReturning ? (
          <div>
            <button onClick={onContinue} style={{ background: "#fff", color: "#000", border: "none", borderRadius: 5, padding: "16px 44px", fontFamily: mono, fontSize: 15, fontWeight: 500, cursor: "pointer", display: "block", margin: "0 auto 12px", WebkitTapHighlightColor: "transparent" }}
              onMouseEnter={e => { e.currentTarget.style.background = "#e5e5e5"; }} onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}>
              Continue as {user.displayName?.split(" ")[0]} →
            </button>
            <div style={{ fontFamily: mono, fontSize: 12, color: "#444" }}>Signed in as {user.email}</div>
          </div>
        ) : user && !profile ? (
          <div>
            <button onClick={onContinue} style={{ background: "#fff", color: "#000", border: "none", borderRadius: 5, padding: "16px 44px", fontFamily: mono, fontSize: 15, fontWeight: 500, cursor: "pointer", display: "block", margin: "0 auto 12px", WebkitTapHighlightColor: "transparent" }}
              onMouseEnter={e => { e.currentTarget.style.background = "#e5e5e5"; }} onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}>
              Set up your profile →
            </button>
            <div style={{ fontFamily: mono, fontSize: 12, color: "#444" }}>Signed in as {user.email}</div>
          </div>
        ) : (
          <div>
            <button onClick={onGoogleSignIn} disabled={authLoading} style={{ background: "#fff", color: "#000", border: "none", borderRadius: 5, padding: "16px 44px", fontFamily: mono, fontSize: 15, fontWeight: 500, cursor: authLoading ? "not-allowed" : "pointer", display: "block", margin: "0 auto 12px", WebkitTapHighlightColor: "transparent", opacity: authLoading ? 0.6 : 1 }}
              onMouseEnter={e => { if (!authLoading) e.currentTarget.style.background = "#e5e5e5"; }} onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}>
              {authLoading ? "signing in..." : "Continue with Google"}
            </button>
            <button onClick={onGuestStart} style={{ background: "transparent", color: "#777", border: "1px solid #333", borderRadius: 5, padding: "12px 36px", fontFamily: mono, fontSize: 13, cursor: "pointer", display: "block", margin: "0 auto 10px", WebkitTapHighlightColor: "transparent" }}>
              Continue without account
            </button>
            {/* FIX: Visible guest warning on landing */}
            <div style={{ fontFamily: mono, fontSize: 12, color: "#555", lineHeight: 1.7, marginTop: 4 }}>
              ⚠ Guest mode — your profile won't be saved if you close the tab.<br />
              <span style={{ color: "#2a2a2a" }}>Sign in to save your profile and enable personalisation.</span>
            </div>
          </div>
        )}
        <div style={{ marginTop: 20, fontFamily: mono, fontSize: 12, color: "#333" }}>Free · No payment needed</div>
        <div style={{ marginTop: 28, fontFamily: mono, fontSize: 11, color: "#2a2a2a", letterSpacing: "0.05em" }}>Created by Venkat Sai Varanasi</div>
      </div>
    </div>
  );
}

// ─── Onboarding Timeline ──────────────────────────────────────────────────────
function OnboardingTimeline({ currentStep, totalSteps, labels }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        {labels.map((label, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minWidth: 0 }}>
            <div style={{
              width: 24, height: 24, borderRadius: "50%",
              background: i < currentStep ? "#fff" : i === currentStep ? "#fff" : "#1a1a1a",
              border: `1px solid ${i <= currentStep ? "#fff" : "#2a2a2a"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: mono, fontSize: 10,
              color: i <= currentStep ? "#000" : "#444",
              marginBottom: 6, flexShrink: 0,
              transition: "all 0.3s ease",
            }}>
              {i < currentStep ? "✓" : i + 1}
            </div>
            <span style={{
              fontFamily: mono,
              fontSize: "clamp(7px, 1.3vw, 10px)",
              color: i === currentStep ? "#fff" : i < currentStep ? "#555" : "#2a2a2a",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "100%",
              textAlign: "center",
              transition: "color 0.3s ease",
            }}>{label}</span>
          </div>
        ))}
      </div>
      <div style={{ background: "#1a1a1a", borderRadius: 3, height: 2 }}>
        <div style={{ height: "100%", background: "#fff", borderRadius: 3, width: `${(currentStep / (totalSteps - 1)) * 100}%`, transition: "width 0.4s ease" }} />
      </div>
    </div>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────────────────
function OnboardingPage({ onComplete, initialAnswers, user }) {
  const [step, setStep] = useState(0);
  const [stream, setStream] = useState(initialAnswers?.stream || "");
  const [dragIdx, setDragIdx] = useState(null);
  const [answers, setAnswers] = useState(initialAnswers || {
    grade: "", academicGoal: "", competitiveExam: "", customExam: "",
    stressLevel: 5, timeManagement: 6, deadlineResponse: "",
    priorities: [], optionalSubjects: [], subjectPriority: [],
    learningStyle: { pace: "", revisionTime: "", distraction: 5, doubtTime: "" },
    extracurriculars: "", additionalContext: ""
  });

  const streamKey = (answers.grade === "Grade 9" || answers.grade === "Grade 10") ? answers.grade : stream;
  const compulsory = streamKey ? (COMPULSORY[streamKey] || []) : [];
  const optionalList = streamKey ? (OPTIONAL[streamKey] || []) : [];
  const allSubjects = [...compulsory, ...answers.optionalSubjects];
  const examList = streamKey ? (COMPETITIVE_EXAMS[streamKey] || COMPETITIVE_EXAMS_ALL) : COMPETITIVE_EXAMS_ALL;
  const showCompetitiveExam = answers.academicGoal === "Crack a competitive exam";

  const QUESTIONS = [
    { id: "grade_stream", label: "Grade", question: "What grade are you in?", subtitle: "Select your grade and stream if applicable", type: "grade_stream" },
    { id: "stream_subjects", label: "Subjects", question: "What subjects do you study?", subtitle: "Select any additional subjects you take", type: "subjects" },
    { id: "subjectPriority", label: "Priority", question: "Rank your subjects by importance", subtitle: "Drag and Drop OR Use arrows — top = most important", type: "rank" },
    { id: "goal", label: "Goal", question: "What is your main academic goal?", subtitle: showCompetitiveExam ? "Select your goal and which exam you're targeting" : "This shapes every piece of advice Nirnayam gives you", type: "goal" },
    { id: "pressure", label: "Pressure", question: "How do you handle pressure?", subtitle: "Be honest — this calibrates your advice", type: "pressure" },
    { id: "learningStyle", label: "Learning", question: "How do you learn?", subtitle: "Helps Nirnayam give smarter time estimates", type: "learning" },
    { id: "about", label: "About You", question: "Tell us a bit more about you", subtitle: "Optional — the more context, the better the advice", type: "about", optional: true },
  ];

  const q = QUESTIONS[step];
  const isLastStep = step === QUESTIONS.length - 1;

  const canProceed = () => {
    if (!q) return true;
    if (q.optional) return true;
    if (q.id === "grade_stream") {
      if (!answers.grade) return false;
      if ((answers.grade === "Grade 11" || answers.grade === "Grade 12") && !stream) return false;
      return true;
    }
    if (q.id === "stream_subjects") return true;
    if (q.type === "rank") return answers.subjectPriority.length > 0;
    if (q.id === "goal") return answers.academicGoal !== "";
    if (q.id === "pressure") return answers.deadlineResponse !== "";
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
    if (q.id === "stream_subjects") setAnswers(a => ({ ...a, subjectPriority: [...compulsory, ...a.optionalSubjects] }));
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
    playClick();
    setAnswers(a => {
      const arr = [...a.subjectPriority];
      const item = arr.splice(from, 1)[0];
      arr.splice(to, 0, item);
      return { ...a, subjectPriority: arr };
    });
  };

  const btnStyle = (selected) => ({
    background: selected ? "#fff" : "transparent",
    color: selected ? "#000" : "#e0e0e0",
    border: `1px solid ${selected ? "#fff" : "#3a3a3a"}`,
    borderRadius: 5, padding: "15px 16px",
    fontFamily: mono, fontSize: 14,
    cursor: "pointer", textAlign: "left", transition: "all 0.2s",
    WebkitTapHighlightColor: "transparent", minHeight: 52,
  });

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 20px" }}>
      <div style={{ width: "100%", maxWidth: 560 }}>
        {step === 0 && (
          <div style={{ fontFamily: mono, fontSize: 13, color: "#777", textAlign: "center", marginBottom: 28, lineHeight: 1.8, padding: "14px 20px", border: "1px solid #1e1e1e", borderRadius: 6, background: "#0a0a0a" }}>
            Answer these questions honestly, so Nirnayam can get to know you and make the best decisions for you.
          </div>
        )}

        <OnboardingTimeline currentStep={step} totalSteps={QUESTIONS.length} labels={STEP_LABELS} />

        <div key={step} style={{ animation: "fadeIn 0.3s ease forwards" }}>
          <h2 style={{ fontFamily: syne, fontSize: "clamp(24px, 5.5vw, 34px)", fontWeight: 700, color: "#fff", margin: "0 0 10px", lineHeight: 1.2 }}>{q.question}</h2>
          {q.subtitle && <p style={{ fontFamily: mono, fontSize: 14, color: "#888", margin: "0 0 26px", lineHeight: 1.7 }}>{q.subtitle}</p>}
          {!q.subtitle && <div style={{ marginBottom: 26 }} />}

          {/* Step 1: Grade + Stream */}
          {q.id === "grade_stream" && (
            <div>
              <div style={{ fontFamily: mono, fontSize: 12, color: "#666", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12 }}>Grade</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 24 }}>
                {GRADE_OPTIONS.map(opt => (
                  <button key={opt} onClick={() => { setAnswers(a => ({ ...a, grade: opt, optionalSubjects: [] })); if (opt === "Grade 9" || opt === "Grade 10") setStream(""); }}
                    style={{ ...btnStyle(answers.grade === opt), flex: "1 1 calc(50% - 5px)" }}>{opt}</button>
                ))}
              </div>
              {(answers.grade === "Grade 11" || answers.grade === "Grade 12") && (
                <div>
                  <div style={{ fontFamily: mono, fontSize: 12, color: "#666", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12 }}>Stream</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {STREAM_OPTIONS.map(s => (
                      <button key={s} onClick={() => { setStream(s); setAnswers(a => ({ ...a, optionalSubjects: [] })); }}
                        style={{ ...btnStyle(stream === s), flex: "1 1 calc(50% - 5px)" }}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 2: Subjects */}
          {q.id === "stream_subjects" && (
            <div>
              {compulsory.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontFamily: mono, fontSize: 12, color: "#666", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12 }}>Core subjects — already included</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {compulsory.map(sub => <div key={sub} style={{ background: "#111", border: "1px solid #2a2a2a", borderRadius: 5, padding: "11px 14px", fontFamily: mono, fontSize: 13, color: "#777" }}>{sub} ✓</div>)}
                  </div>
                </div>
              )}
              {optionalList.length > 0 && (
                <div>
                  <div style={{ fontFamily: mono, fontSize: 12, color: "#666", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12 }}>Additional subjects — pick any you study</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {optionalList.map(sub => <button key={sub} onClick={() => handleOptionalSubject(sub)} style={{ ...btnStyle(answers.optionalSubjects.includes(sub)), padding: "11px 14px" }}>{sub}</button>)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Rank */}
          {q.type === "rank" && (
            <div>
              {answers.subjectPriority.length === 0 ? (
                <div style={{ fontFamily: mono, fontSize: 14, color: "#666" }}>No subjects selected. Go back and select your subjects.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {answers.subjectPriority.map((sub, i) => (
                    <div key={sub} draggable onDragStart={() => handleDragStart(i)} onDragOver={(e) => handleDragOver(e, i)} onDragEnd={handleDragEnd}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "15px 16px", background: dragIdx === i ? "#1e1e1e" : "#0d0d0d", border: `1px solid ${dragIdx === i ? "#444" : "#2a2a2a"}`, borderRadius: 5, cursor: "grab", userSelect: "none", WebkitUserSelect: "none" }}>
                      <span style={{ fontFamily: mono, fontSize: 13, color: "#555", minWidth: 24 }}>{i + 1}</span>
                      <span style={{ fontFamily: mono, fontSize: 15, color: "#ddd", flex: 1 }}>{sub}</span>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <button onClick={() => moveItem(i, i - 1)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: 3, color: "#666", cursor: "pointer", fontSize: 13, padding: "4px 10px", WebkitTapHighlightColor: "transparent" }}>↑</button>
                        <button onClick={() => moveItem(i, i + 1)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: 3, color: "#666", cursor: "pointer", fontSize: 13, padding: "4px 10px", WebkitTapHighlightColor: "transparent" }}>↓</button>
                      </div>
                    </div>
                  ))}
                  <div style={{ fontFamily: mono, fontSize: 11, color: "#333", marginTop: 4 }}>☰ Drag and Drop OR use ↑↓ arrows to reorder</div>
                </div>
              )}
            </div>
          )}

          {/* Step 4: Goal + Exam */}
          {q.id === "goal" && (
            <div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: showCompetitiveExam ? 24 : 0 }}>
                {["Score well in board exams", "Crack a competitive exam", "Maintain my current grades", "Improve in specific subjects", "No specific goal right now"].map(opt => (
                  <button key={opt} onClick={() => setAnswers(a => ({ ...a, academicGoal: opt, competitiveExam: "", customExam: "" }))} style={btnStyle(answers.academicGoal === opt)}>{opt}</button>
                ))}
              </div>
              {showCompetitiveExam && (
                <div style={{ animation: "fadeIn 0.3s ease forwards" }}>
                  <div style={{ fontFamily: mono, fontSize: 12, color: "#666", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12, marginTop: 8 }}>Which exam?</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {examList.map(opt => (
                      <button key={opt} onClick={() => setAnswers(a => ({ ...a, competitiveExam: opt, customExam: "" }))}
                        style={{ ...btnStyle(answers.competitiveExam === opt), padding: "11px 14px" }}>{opt}</button>
                    ))}
                  </div>
                  {/* FIX: "Other" text field */}
                  {answers.competitiveExam === "Other" && (
                    <input type="text" value={answers.customExam || ""} onChange={e => setAnswers(a => ({ ...a, customExam: e.target.value }))}
                      placeholder="Type your exam name..."
                      style={{ marginTop: 12, width: "100%", background: "#0d0d0d", border: "1px solid #2a2a2a", borderRadius: 5, color: "#ddd", fontFamily: mono, fontSize: 14, padding: "14px 16px", outline: "none", boxSizing: "border-box" }}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 5: Pressure */}
          {q.id === "pressure" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
              <div>
                <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 6 }}>How much does stress affect you?</div>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 12, color: "#555", marginBottom: 12 }}>
                  <span>Barely</span><span>Hits hard</span>
                </div>
                <input type="range" min={1} max={10} value={answers.stressLevel} onChange={e => setAnswers(a => ({ ...a, stressLevel: Number(e.target.value) }))} style={{ width: "100%", accentColor: "#fff", cursor: "pointer" }} />
                <div style={{ textAlign: "center", marginTop: 8, fontFamily: syne, fontSize: 40, fontWeight: 800, color: "#fff" }}>{answers.stressLevel}</div>
              </div>
              <div>
                <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 6 }}>How's your time management on a normal school day?</div>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 12, color: "#555", marginBottom: 12 }}>
                  <span>Always behind</span><span>Always on track</span>
                </div>
                <input type="range" min={1} max={10} value={answers.timeManagement} onChange={e => setAnswers(a => ({ ...a, timeManagement: Number(e.target.value) }))} style={{ width: "100%", accentColor: "#fff", cursor: "pointer" }} />
                <div style={{ textAlign: "center", marginTop: 8, fontFamily: syne, fontSize: 40, fontWeight: 800, color: "#fff" }}>{answers.timeManagement}</div>
              </div>
              <div>
                <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 12 }}>How do you respond to deadlines?</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {["They push me to work harder", "They stress me out badly", "A bit of both"].map(opt => (
                    <button key={opt} onClick={() => setAnswers(a => ({ ...a, deadlineResponse: opt }))} style={btnStyle(answers.deadlineResponse === opt)}>{opt}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 6: Learning */}
          {q.type === "learning" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <div>
                <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 12 }}>How quickly do you grasp new concepts?</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {["Quick — I get things fast", "Moderate — I need a few attempts", "Slow — I need time to absorb properly"].map(opt => (
                    <button key={opt} onClick={() => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, pace: opt } }))} style={btnStyle(answers.learningStyle.pace === opt)}>{opt}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 12 }}>How long does revising one subject typically take?</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {["Under 30 minutes", "Around 1 hour", "2+ hours"].map(opt => (
                    <button key={opt} onClick={() => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, revisionTime: opt } }))} style={btnStyle(answers.learningStyle.revisionTime === opt)}>{opt}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 6 }}>How easily do you get distracted while studying?</div>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 12, color: "#555", marginBottom: 12 }}>
                  <span>Rarely</span><span>Constantly</span>
                </div>
                <input type="range" min={1} max={10} value={answers.learningStyle.distraction} onChange={e => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, distraction: Number(e.target.value) } }))} style={{ width: "100%", accentColor: "#fff", cursor: "pointer" }} />
                <div style={{ textAlign: "center", marginTop: 8, fontFamily: syne, fontSize: 40, fontWeight: 800, color: "#fff" }}>{answers.learningStyle.distraction}</div>
              </div>
              <div>
                <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 12 }}>Does clearing doubts usually take you a long time?</div>
                <div style={{ display: "flex", gap: 10 }}>
                  {["Yes, it takes a while", "No, I resolve them quickly"].map(opt => (
                    <button key={opt} onClick={() => setAnswers(a => ({ ...a, learningStyle: { ...a.learningStyle, doubtTime: opt } }))} style={{ ...btnStyle(answers.learningStyle.doubtTime === opt), flex: 1 }}>{opt}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 7: About */}
          {q.id === "about" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <div>
                <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 12 }}>What matters most to you? <span style={{ color: "#444" }}>(pick all that apply)</span></div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {["Academics", "Sports", "Music/Arts", "Social life", "Personal projects", "Family"].map(opt => {
                    const sel = (answers.priorities || []).includes(opt);
                    return <button key={opt} onClick={() => { const c = answers.priorities || []; setAnswers(a => ({ ...a, priorities: sel ? c.filter(x => x !== opt) : [...c, opt] })); }} style={{ ...btnStyle(sel), padding: "13px 16px" }}>{opt}</button>;
                  })}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 8 }}>Extracurriculars with fixed schedules? <span style={{ color: "#444" }}>(optional)</span></div>
                <textarea value={answers.extracurriculars || ""} onChange={e => setAnswers(a => ({ ...a, extracurriculars: e.target.value }))} placeholder="e.g. Basketball practice Mon/Wed/Fri 5–7pm"
                  style={{ width: "100%", background: "#0d0d0d", border: "1px solid #2a2a2a", borderRadius: 5, color: "#ddd", fontFamily: mono, fontSize: 14, lineHeight: 1.7, padding: "14px 16px", resize: "none", minHeight: 80, outline: "none", boxSizing: "border-box" }} />
              </div>
              <div>
                <div style={{ fontFamily: mono, fontSize: 14, color: "#888", marginBottom: 8 }}>Anything else Nirnayam should know? <span style={{ color: "#444" }}>(optional)</span></div>
                <textarea value={answers.additionalContext || ""} onChange={e => setAnswers(a => ({ ...a, additionalContext: e.target.value }))} placeholder="e.g. Board exams in 3 months, aiming for 90%+"
                  style={{ width: "100%", background: "#0d0d0d", border: "1px solid #2a2a2a", borderRadius: 5, color: "#ddd", fontFamily: mono, fontSize: 14, lineHeight: 1.7, padding: "14px 16px", resize: "none", minHeight: 80, outline: "none", boxSizing: "border-box" }} />
              </div>
            </div>
          )}
        </div>

        {isLastStep && !user && (
          <div style={{ fontFamily: mono, fontSize: 12, color: "#555", marginTop: 20, padding: "10px 14px", border: "1px solid #1a1a1a", borderRadius: 5, lineHeight: 1.7 }}>
            ⚠ You're continuing as a guest. Your profile won't be saved if you refresh or close the tab.
          </div>
        )}

        {/* FIX: Back button at bottom */}
        <div style={{ marginTop: 24, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button onClick={back} disabled={step === 0} style={{ background: "transparent", border: "none", color: step === 0 ? "#1e1e1e" : "#888", fontFamily: mono, fontSize: 14, cursor: step === 0 ? "default" : "pointer", WebkitTapHighlightColor: "transparent", padding: "4px 0" }}>
            {step > 0 ? "← Back" : ""}
          </button>
          <button onClick={next} disabled={!canProceed()} style={{ background: canProceed() ? "#fff" : "#1a1a1a", color: canProceed() ? "#000" : "#333", border: "none", borderRadius: 5, padding: "15px 34px", fontFamily: mono, fontSize: 14, cursor: canProceed() ? "pointer" : "not-allowed", transition: "all 0.2s", WebkitTapHighlightColor: "transparent" }}>
            {isLastStep ? "Start using Nirnayam →" : "Next →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Voice Input Button ───────────────────────────────────────────────────────
function VoiceInputButton({ onTranscript, onError }) {
  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState("");
  const recognitionRef = useRef(null);

  const toggle = () => {
    if (listening) { recognitionRef.current?.stop(); return; }
    recognitionRef.current = startSpeechRecognition(
      (transcript, isInterim) => {
        if (isInterim) setInterimText(transcript);
        else { onTranscript(transcript); setInterimText(""); setListening(false); }
      },
      (err) => { onError(err); setListening(false); setInterimText(""); },
      () => setListening(true),
      () => { setListening(false); setInterimText(""); }
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <button onClick={toggle} title={listening ? "Tap to stop" : "Tap to speak your situation"} style={{
        background: listening ? "#f87171" : "transparent",
        border: `1px solid ${listening ? "#f87171" : "#333"}`,
        borderRadius: 5, padding: "10px 14px",
        fontFamily: mono, fontSize: 13,
        color: listening ? "#000" : "#666",
        cursor: "pointer", transition: "all 0.2s",
        WebkitTapHighlightColor: "transparent",
        display: "flex", alignItems: "center", gap: 6,
        animation: listening ? "pulse 1s ease-in-out infinite" : "none",
      }}>
        <span style={{ fontSize: 16 }}>{listening ? "⏹" : "🎙"}</span>
        <span>{listening ? "listening..." : "speak"}</span>
      </button>
      {interimText && (
        <div style={{ fontFamily: mono, fontSize: 11, color: "#555", fontStyle: "italic", paddingLeft: 2 }}>"{interimText}"</div>
      )}
    </div>
  );
}

// ─── Voice Output Button ──────────────────────────────────────────────────────
function VoiceOutputButton({ result }) {
  const [speaking, setSpeaking] = useState(false);

  const toggle = () => {
    if (speaking) { window.speechSynthesis?.cancel(); setSpeaking(false); return; }
    const text = `Decision: ${result.decision}. Key insight: ${result.key_insight}. Action plan: ${result.action_plan?.join(". ")}.${result.warning && result.warning !== "null" ? ` Warning: ${result.warning}` : ""}`;
    try { speakText(text, () => setSpeaking(true), () => setSpeaking(false)); }
    catch { setSpeaking(false); }
  };

  if (!window.speechSynthesis) return null;
  return (
    <button onClick={toggle} style={{
      background: speaking ? "#4ade80" : "transparent",
      border: `1px solid ${speaking ? "#4ade80" : "#2a2a2a"}`,
      borderRadius: 4, padding: "6px 12px",
      fontFamily: mono, fontSize: 12,
      color: speaking ? "#000" : "#555",
      cursor: "pointer", transition: "all 0.2s",
      WebkitTapHighlightColor: "transparent",
      display: "flex", alignItems: "center", gap: 6,
    }}>
      <span>{speaking ? "⏹" : "🔊"}</span>
      <span>{speaking ? "stop" : "listen to advice"}</span>
    </button>
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
    if (!user) { setShowSignInPrompt(true); return; }
    try {
      await saveRating(user.uid, { stars, category: result.category || "General", decision: result.decision, situation: situation.slice(0, 200) });
      setSaved(true);
      if (onRated) onRated();
    } catch (e) { console.error(e); }
  };

  if (saved) return (
    <div style={{ background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 8, padding: "16px", marginTop: 10, textAlign: "center" }}>
      <div style={{ fontFamily: mono, fontSize: 13, color: "#4ade80" }}>Rating saved — Nirnayam is learning your patterns ✓</div>
    </div>
  );

  return (
    <div style={{ background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 8, padding: "18px", marginTop: 10 }}>
      <div style={{ fontFamily: mono, fontSize: 11, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12 }}>How did this advice work out?</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 10 }}>
        {[1, 2, 3, 4, 5].map(star => (
          <button key={star} onClick={() => handleRate(star)} onMouseEnter={() => setHovered(star)} onMouseLeave={() => setHovered(0)}
            style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 32, padding: "4px", WebkitTapHighlightColor: "transparent", transition: "transform 0.1s", transform: (hovered >= star || selected >= star) ? "scale(1.2)" : "scale(1)" }}>
            <span style={{ color: (hovered >= star || selected >= star) ? "#facc15" : "#2a2a2a" }}>★</span>
          </button>
        ))}
      </div>
      <div style={{ fontFamily: mono, fontSize: 12, color: "#444", textAlign: "center" }}>
        {selected === 0 ? "Rate to help Nirnayam learn your patterns" : selected <= 2 ? "Got it — Nirnayam will adjust" : selected <= 3 ? "Thanks for the feedback" : "Great — Nirnayam will remember this works"}
      </div>
      {showSignInPrompt && (
        <div style={{ marginTop: 16, background: "#0a0a0a", border: "1px solid #222", borderRadius: 6, padding: "16px", textAlign: "center" }}>
          <div style={{ fontFamily: mono, fontSize: 13, color: "#aaa", marginBottom: 12, lineHeight: 1.7 }}>
            Sign in to enable personalisation.<br />
            <span style={{ color: "#666", fontSize: 12 }}>Your ratings train Nirnayam to learn your patterns over time.</span>
          </div>
          <button onClick={onGoogleSignIn} style={{ background: "#fff", color: "#000", border: "none", borderRadius: 4, padding: "10px 24px", fontFamily: mono, fontSize: 13, cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>Sign in with Google</button>
          <button onClick={() => setShowSignInPrompt(false)} style={{ background: "transparent", border: "none", color: "#444", fontFamily: mono, fontSize: 12, cursor: "pointer", display: "block", margin: "10px auto 0", WebkitTapHighlightColor: "transparent" }}>Maybe later</button>
        </div>
      )}
    </div>
  );
}

// ─── Result Skeleton ──────────────────────────────────────────────────────────
function ResultSkeleton() {
  const shimmer = { background: "linear-gradient(90deg, #111 25%, #1a1a1a 50%, #111 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", borderRadius: 4 };
  return (
    <div style={{ animation: "fadeIn 0.3s ease forwards" }}>
      <style>{`@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }`}</style>
      <div style={{ background: "#0c0c0c", border: "1px solid #1e1e1e", borderRadius: 8, padding: "22px", marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ ...shimmer, height: 16, width: 120 }} />
          <div style={{ ...shimmer, height: 22, width: 48 }} />
        </div>
        <div style={{ ...shimmer, height: 28, width: "90%", marginBottom: 10 }} />
        <div style={{ ...shimmer, height: 20, width: "70%" }} />
      </div>
      <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: 8, padding: "18px", marginBottom: 10 }}>
        <div style={{ ...shimmer, height: 12, width: 140, marginBottom: 16 }} />
        <div style={{ ...shimmer, height: 8, width: "100%", marginBottom: 10 }} />
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div style={{ ...shimmer, height: 12, width: 80 }} />
          <div style={{ ...shimmer, height: 12, width: 80 }} />
        </div>
      </div>
      <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: 8, padding: "18px", marginBottom: 10 }}>
        <div style={{ ...shimmer, height: 12, width: 100, marginBottom: 14 }} />
        <div style={{ ...shimmer, height: 16, width: "85%", marginBottom: 8 }} />
        <div style={{ ...shimmer, height: 16, width: "60%" }} />
      </div>
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
  const [voiceError, setVoiceError] = useState(null);
  const [history, setHistory] = useState([]);
  const [showEditConfirm, setShowEditConfirm] = useState(false);
  const textareaRef = useRef(null);
  const analysingRef = useRef(false);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }, [situation]);

  const analyse = async () => {
    if (!situation.trim() || analysingRef.current) return;
    analysingRef.current = true;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await callNirnayam(situation, profile, personData);
      setResult(res);
      setHistory(prev => [{ situation, result: res, time: new Date().toLocaleTimeString() }, ...prev.slice(0, 9)]);
    } catch (e) {
      setError(e.message || "Something went wrong. Check your connection and try again.");
    } finally { setLoading(false); analysingRef.current = false; }
  };

  if (showSettings) return (
    <SettingsPage profile={profile} user={user} personData={personData}
      onEditProfile={() => { setShowSettings(false); setShowEditConfirm(true); }}
      onSignOut={onSignOut} onBack={() => setShowSettings(false)} onGoToLanding={onGoToLanding} />
  );

  const urgencyInfo = result ? getUrgencyLabel(result.confidence) : null;
  const rawA = result?.time_split?.option_a ?? 70;
  const rawB = result?.time_split?.option_b ?? 30;
  const total = rawA + rawB;
  const splitA = total > 0 ? Math.round((rawA / total) * 100) : 70;
  const splitB = 100 - splitA;
  const labelA = result?.time_split?.option_a_label || "Primary";
  const labelB = result?.time_split?.option_b_label || "Secondary";

  return (
    <div style={{ minHeight: "100vh", padding: "20px 16px", maxWidth: 660, margin: "0 auto" }}>

      {/* FIX: Edit profile confirmation dialog */}
      {showEditConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "#0d0d0d", border: "1px solid #2a2a2a", borderRadius: 10, padding: 28, maxWidth: 380, width: "100%", textAlign: "center" }}>
            <div style={{ fontFamily: syne, fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 12 }}>Edit your profile?</div>
            <div style={{ fontFamily: mono, fontSize: 13, color: "#888", lineHeight: 1.8, marginBottom: 24 }}>This will re-run the onboarding. Your ratings and personalisation data won't be affected.</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button onClick={() => setShowEditConfirm(false)} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: 5, padding: "12px 24px", fontFamily: mono, fontSize: 13, color: "#888", cursor: "pointer" }}>Cancel</button>
              <button onClick={() => { setShowEditConfirm(false); onEditProfile(); }} style={{ background: "#fff", border: "none", borderRadius: 5, padding: "12px 24px", fontFamily: mono, fontSize: 13, color: "#000", cursor: "pointer" }}>Yes, edit profile</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ textAlign: "center", marginBottom: 12 }}>
          <button onClick={onGoToLanding} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, WebkitTapHighlightColor: "transparent" }}>
            <div style={{ fontFamily: syne, fontSize: 28, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>Nirnayam</div>
          </button>
          <div style={{ fontFamily: mono, fontSize: 12, color: "#555", marginTop: 3 }}>
            {profile.grade}{profile.stream ? ` · ${profile.stream}` : ""}
            {!user && <span style={{ color: "#2a2a2a", marginLeft: 6 }}>· guest</span>}
            {personData && personData.total > 0 && <span style={{ color: "#4ade80", marginLeft: 6 }}>· personalised ({personData.total})</span>}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          {/* FIX: Settings with arrow hint */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <button onClick={() => setShowSettings(true)} style={{ background: "transparent", border: "1px solid #1e1e1e", borderRadius: 4, padding: "8px 14px", fontFamily: mono, fontSize: 12, color: "#666", cursor: "pointer", WebkitTapHighlightColor: "transparent", display: "flex", alignItems: "center", gap: 5 }}>
              ⚙ settings
            </button>
            <div style={{ fontFamily: mono, fontSize: 10, color: "#2a2a2a", paddingLeft: 2 }}>↑ change profile here</div>
          </div>
          <button onClick={() => setShowHistory(!showHistory)} style={{ background: "transparent", border: "1px solid #1e1e1e", borderRadius: 4, padding: "8px 14px", fontFamily: mono, fontSize: 12, color: "#666", cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
            {showHistory ? "← back" : `history (${history.length})`}
          </button>
        </div>
      </div>

      {showHistory ? (
        <HistoryView history={history} onSelect={(h) => { setSituation(h.situation); setResult(h.result); setShowHistory(false); }} />
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
            <div style={{ borderTop: "1px solid #111", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
              <VoiceInputButton onTranscript={(t) => setSituation(prev => prev ? prev + " " + t : t)} onError={(e) => setVoiceError(e)} />
              <button onClick={analyse} disabled={loading || !situation.trim()} style={{ background: loading || !situation.trim() ? "#1a1a1a" : "#fff", color: loading || !situation.trim() ? "#333" : "#000", border: "none", borderRadius: 5, padding: "11px 24px", fontFamily: mono, fontSize: 14, cursor: loading || !situation.trim() ? "not-allowed" : "pointer", transition: "all 0.2s", WebkitTapHighlightColor: "transparent" }}>
                {loading ? "thinking..." : "decide →"}
              </button>
            </div>
          </div>

          {voiceError && (
            <div style={{ background: "#1a0a0a", border: "1px solid #2a1010", borderRadius: 6, padding: "10px 14px", fontFamily: mono, fontSize: 12, color: "#f87171", marginBottom: 10 }}>{voiceError}</div>
          )}

          {/* FIX: Loading skeleton instead of abrupt pop */}
          {loading && <ResultSkeleton />}

          {error && <div style={{ background: "#1a0a0a", border: "1px solid #2a1010", borderRadius: 6, padding: "14px 18px", fontFamily: mono, fontSize: 13, color: "#f87171" }}>{error}</div>}

          {result && !loading && (
            <>
              <ResultView result={result} urgencyInfo={urgencyInfo} splitA={splitA} splitB={splitB} labelA={labelA} labelB={labelB} />
              <StarRating result={result} situation={situation} user={user} onGoogleSignIn={onGoogleSignIn} onRated={onPersonDataRefresh} />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Settings Page ────────────────────────────────────────────────────────────
function SettingsPage({ profile, user, personData, onEditProfile, onSignOut, onBack }) {
  return (
    <div style={{ minHeight: "100vh", padding: "32px 20px", maxWidth: 540, margin: "0 auto" }}>
      <div style={{ fontFamily: syne, fontSize: 22, fontWeight: 800, color: "#fff", marginBottom: 32 }}>Settings</div>

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
            <button onClick={onSignOut} style={{ background: "transparent", border: "1px solid #2a2a2a", borderRadius: 4, padding: "10px 20px", fontFamily: mono, fontSize: 13, color: "#f87171", cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>Sign out</button>
          </div>
        ) : (
          <div style={{ fontFamily: mono, fontSize: 13, color: "#666" }}>You're using Nirnayam as a guest. Sign in to save your profile and enable personalisation.</div>
        )}
      </div>

      {user && personData && personData.total > 0 && (
        <div style={{ background: "#0d0d0d", border: "1px solid #1e1e1e", borderRadius: 8, padding: "20px", marginBottom: 12 }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 14 }}>Personalisation — {personData.total} ratings</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {Object.entries(personData.stats).map(([cat, data]) => (
              <div key={cat} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: mono, fontSize: 13, color: "#888" }}>{cat}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ display: "flex", gap: 2 }}>
                    {[1, 2, 3, 4, 5].map(s => <span key={s} style={{ fontSize: 12, color: s <= Math.round(data.avg) ? "#facc15" : "#222" }}>★</span>)}
                  </div>
                  <span style={{ fontFamily: mono, fontSize: 12, color: "#555" }}>{data.avg}/5 ({data.count})</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: mono, fontSize: 11, color: "#333", marginTop: 12 }}>
            {personData.total < 5 ? `${5 - personData.total} more ratings to fully activate personalisation` : "Personalisation active — improving with every rating"}
          </div>
        </div>
      )}

      <div style={{ background: "#0d0d0d", border: "1px solid #1e1e1e", borderRadius: 8, padding: "20px", marginBottom: 12 }}>
        <div style={{ fontFamily: mono, fontSize: 10, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 14 }}>Your Profile</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            ["Grade", `${profile.grade}${profile.stream ? ` · ${profile.stream}` : ""}`],
            ["Goal", profile.academicGoal || "—"],
            ["Stress", `${profile.stressLevel}/10`],
            ["Deadlines", profile.deadlineResponse || "—"],
            ["Subjects", profile.allSubjects?.join(", ") || "—"],
            ["Learning pace", profile.learningStyle?.pace || "—"],
          ].map(([label, val]) => (
            <div key={label} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span style={{ fontFamily: mono, fontSize: 12, color: "#444", minWidth: 120, flexShrink: 0 }}>{label}</span>
              <span style={{ fontFamily: mono, fontSize: 12, color: "#888", lineHeight: 1.5 }}>{val}</span>
            </div>
          ))}
        </div>
      </div>

      <button onClick={onEditProfile} style={{ width: "100%", background: "#fff", color: "#000", border: "none", borderRadius: 5, padding: "14px", fontFamily: mono, fontSize: 14, cursor: "pointer", WebkitTapHighlightColor: "transparent", marginBottom: 8 }}>
        Edit profile
      </button>
      <div style={{ fontFamily: mono, fontSize: 11, color: "#2a2a2a", textAlign: "center", marginBottom: 28 }}>Editing will re-run the onboarding questionnaire</div>

      {/* FIX: Back button at bottom of settings */}
      <button onClick={onBack} style={{ background: "transparent", border: "1px solid #1e1e1e", borderRadius: 4, padding: "10px 20px", fontFamily: mono, fontSize: 13, color: "#666", cursor: "pointer", WebkitTapHighlightColor: "transparent", display: "block", margin: "0 auto" }}>← Back</button>
    </div>
  );
}

// ─── Result View ──────────────────────────────────────────────────────────────
function ResultView({ result, urgencyInfo, splitA, splitB, labelA, labelB }) {
  return (
    <div style={{ animation: "fadeIn 0.4s ease forwards" }}>
      <div style={{ background: "#0c0c0c", border: "1px solid #1e1e1e", borderRadius: 8, padding: "22px", marginBottom: 10, borderLeft: `3px solid ${urgencyInfo?.color || "#888"}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontFamily: mono, fontSize: 11, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase" }}>Decision</div>
            <span style={{ background: (urgencyInfo?.color || "#888") + "22", color: urgencyInfo?.color || "#888", fontFamily: mono, fontSize: 11, padding: "3px 10px", borderRadius: 3, textTransform: "uppercase" }}>{urgencyInfo?.label}</span>
          </div>
          <span style={{ color: confidenceColor(result.confidence), fontFamily: syne, fontSize: 22, fontWeight: 800 }}>{result.confidence}%</span>
        </div>
        <div style={{ fontFamily: syne, fontSize: "clamp(19px, 3.5vw, 25px)", fontWeight: 700, color: "#fff", lineHeight: 1.3, marginBottom: 14 }}>{result.decision}</div>
        <VoiceOutputButton result={result} />
      </div>

      {/* FIX: Time split with real labels */}
      <div style={{ background: "#0f0f0f", border: "1px solid #1a1a1a", borderRadius: 8, padding: "18px", marginBottom: 10 }}>
        <div style={{ fontFamily: mono, fontSize: 11, color: "#444", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12 }}>How to split your time</div>
        <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
          <div style={{ width: `${splitA}%`, background: "#fff", transition: "width 1s ease" }} />
          <div style={{ width: `${splitB}%`, background: "#2a2a2a" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: mono, fontSize: 13 }}>
          <span style={{ color: "#ccc" }}>{labelA} — {splitA}%</span>
          <span style={{ color: "#555" }}>{labelB} — {splitB}%</span>
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
function HistoryView({ history, onSelect }) {
  if (history.length === 0) return <div style={{ textAlign: "center", padding: "60px 0", fontFamily: mono, fontSize: 14, color: "#2a2a2a" }}>No decisions yet this session.</div>;
  return (
    <div>
      <div style={{ fontFamily: mono, fontSize: 11, color: "#2a2a2a", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 16 }}>This session</div>
      {history.map((h, i) => (
        <div key={i} onClick={() => onSelect(h)} style={{ background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 6, padding: "14px 16px", marginBottom: 8, cursor: "pointer" }}
          onMouseEnter={e => e.currentTarget.style.borderColor = "#333"}
          onMouseLeave={e => e.currentTarget.style.borderColor = "#1a1a1a"}>
          <div style={{ fontFamily: mono, fontSize: 13, color: "#777", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 6 }}>{h.situation}</div>
          <div style={{ display: "flex", gap: 16, fontFamily: mono, fontSize: 12, color: "#333" }}>
            <span>{h.result.confidence}%</span>
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
          if (savedProfile) { setProfile(savedProfile); await refreshPersonData(firebaseUser.uid); }
        } catch (e) { console.error(e); }
        setScreen("landing");
      } else {
        setUser(null); setProfile(null); setPersonData(null);
        setScreen("landing");
      }
    });
    return () => unsub();
  }, []);

  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    try { await signInWithPopup(auth, provider); }
    catch (e) { console.error(e); setAuthLoading(false); }
  };

  const handleOnboardingComplete = async (newProfile) => {
    setProfile(newProfile);
    if (user) { try { await saveProfile(user.uid, newProfile); } catch (e) { console.error(e); } }
    setScreen("app");
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setProfile(null); setPersonData(null); setScreen("landing");
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
      {screen === "landing" && <LandingPage user={user} profile={profile} onGoogleSignIn={handleGoogleSignIn} onGuestStart={() => setScreen("onboarding")} onContinue={() => { if (profile) setScreen("app"); else setScreen("onboarding"); }} authLoading={authLoading} />}
      {screen === "onboarding" && <OnboardingPage onComplete={handleOnboardingComplete} initialAnswers={profile} user={user} />}
      {screen === "app" && profile && <MainApp profile={profile} user={user} personData={personData} onEditProfile={() => setScreen("onboarding")} onSignOut={handleSignOut} onGoogleSignIn={handleGoogleSignIn} onGoToLanding={() => setScreen("landing")} onPersonDataRefresh={() => user && refreshPersonData(user.uid)} />}
    </div>
  );
}
