# Nirnayam

**Find Your True North.**

Nirnayam is an AI companion for students — part decision advisor, part study tutor, part daily planner — built to cut through the two things that eat every student's day: *not knowing what to do next*, and *not understanding what they're staring at*.

🔗 **Live app:** [nirnayam.vercel.app](https://nirnayam.vercel.app)

---

## Why Nirnayam

Every student hits the same wall on repeat: *"Do I finish this chemistry homework or revise for tomorrow's physics test?"* — and right behind it, *"...and I don't even get this concept yet."*

Most study apps pick one of those problems. Nirnayam was built to solve both in the same conversation, with a personality that actually knows the student — their grade, their stream, their stress levels, how they learn — instead of giving the same generic advice to everyone who opens the app.

---

## Core Features

### 🧭 AI Decision Engine
Torn between two things? Tell Nirnayam what's on your plate and it returns a structured, reasoned plan — not vague encouragement.

- Personalized to a full student profile: grade, stream, subjects, exam target, stress sensitivity, time management, learning pace, and teaching style preferences captured during onboarding
- Every response includes a **confidence score**, an **urgency rating**, a **time-split recommendation**, a **sequenced action plan**, and a **key insight** that explains the "why"
- Reasoning rules bake in real study-science principles: quick wins first, concept gaps treated as high priority near exams, subject priority used only as a tiebreaker — never a fixed rule
- **Personalization loop** — rate how advice actually worked out, and future recommendations adapt to what's historically helped that student
- **Voice output** — have any decision read back out loud

### 💬 AI Study Chatbot
A tutor that actually teaches the way the student learns, not the way a textbook does.

- Full conversational memory — follow-up questions and doubts build on what was already discussed, instead of starting from zero every message
- Auto-routes between "explain this concept" and "help me decide" using an intent classifier, so one chat box handles both jobs seamlessly
- Teaching style is fully personalized — analogies, step-by-step breakdowns, exam-focused framing, challenge mode, and more, blended adaptively per question rather than forced into every answer
- Clean **Markdown + LaTeX rendering** for real math — fractions, integrals, matrices, all rendered properly instead of as raw text
- **Snap a photo of a question** — paste an image directly into the chat (or use the camera on mobile) alongside your own notes, and Nirnayam reads and answers it
- **Voice input** for hands-free question asking

### 📅 Daily Planner, XP & Rebirth System
Turns "stuff I should probably do" into a game worth showing up for.

- Add tasks manually, or **send an entire decision-engine action plan straight to today's planner** — with a confirmation step so nothing gets added without a final look
- Every completed task earns XP, with a visible level bar and a **named title** at every level — 50 handcrafted titles from *Wanderer* at Level 1 to *Nirnayam* at the max
- **Rebirth system**: hit Level 50 and choose to reset the cycle — XP-per-task goes up permanently, the 50 titles cycle again, and a rebirth badge marks how many times you've done it. Lifetime XP is tracked forever, independent of resets
- Current title shown right in the header and Settings — the app reflects your streak everywhere, not just on one screen

### 👤 Personalized, Judgment-Free Onboarding
A guided six-step profile setup captures grade, stream, subjects (with smart core/elective splitting), academic goals, stress and time-management sensitivity, learning pace, teaching-style preferences, and any extracurricular constraints — all used to shape every response the app gives afterward.

### 🔐 Flexible Access
- Full functionality without an account — try everything as a guest
- Sign in with Google to save your profile, unlock personalization, and persist planner/XP progress across devices
- Installable as a PWA — add it to your home screen like a native app

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React (Vite) |
| AI | Google Gemini (`gemini-3.1-flash-lite`) — separate API keys for the decision engine and the study chatbot, so heavy chat traffic never throttles core decision-making |
| Auth & Data | Firebase Authentication (Google Sign-In), Cloud Firestore |
| Math rendering | `react-markdown`, `remark-gfm`, `remark-math`, `rehype-katex`, KaTeX |
| Voice | Web Speech API (recognition + synthesis) |
| Icons | `lucide-react` |
| Hosting | Vercel |

---

## How It's Structured

- **Onboarding → Profile**: a one-time questionnaire builds a rich student profile, stored in Firestore and injected into every AI call as context
- **Intent Router**: a lightweight classification pass on every message decides whether it's a *decision* question, a *study* question, or both — and routes accordingly, in parallel where needed
- **Decision Engine**: a dedicated Gemini call with a strict reasoning ruleset returns structured JSON, rendered into the decision card UI
- **Study Chatbot**: a separate streaming Gemini call carries full conversation history (including any attached image) and a teaching-style-aware system prompt
- **Planner + XP**: stored per-user in Firestore (`plannerTasks` subcollection + an `xp` field on the user doc), with all leveling and rebirth logic client-side and guarded against double-awarding XP

---

## Environment Variables

```
VITE_GEMINI_KEY        # Decision engine API key
VITE_GEMINI_CHAT_KEY   # Study chatbot + intent classifier API key
```

Plus standard Firebase config (`apiKey`, `authDomain`, `projectId`, etc.) in `src/firebase.js`.

---

## Roadmap

- Google Calendar integration for the daily planner
- Weak-topic tracking fed back into the decision engine's reasoning
- Performance insights via report card / PDF upload

---

**Created by Venkat Sai Varanasi**
