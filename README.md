# 🧠 Nirnayam — AI Decision Advisor for Students

> *"Nirnayam" means **decision** in Telegu.*

**Live Demo:** [nirnayam.vercel.app](https://nirnayam.vercel.app) &nbsp;|&nbsp; Built by [@Venky0608](https://github.com/Venky0608)

---

## The Problem

Imagine you're a student in Class 11. You have a board exam in three months, a JEE mock on Saturday, and you still haven't decided whether to drop a subject you're struggling with. You don't know how to split your time. You don't know if your goal is realistic. You don't know who to ask.

Your teachers are busy. Your parents want what's best for you but don't know the syllabus. A career counselor costs money your family may not have. And your friends are just as confused as you are.

This is the reality for the overwhelming majority of students in India — and across the world. High-stakes decisions get made on guesswork, on peer pressure, or not made at all. The result: wasted time, wrong paths, and a lot of unnecessary stress.

**Nirnayam exists to change that.**

---

## What Is Nirnayam?

Nirnayam is an AI-powered student decision advisor — a web app that acts as a personal mentor you can talk to anytime, for free, about anything related to your academic life and future.

It doesn't just answer questions. It helps you *think through* problems. You describe your situation — your goals, your constraints, your confusion — and Nirnayam gives you structured, honest, practical guidance. Not vague motivation. Not generic tips. Real, contextual advice built around *your* specific situation.

Whether you're a JEE aspirant trying to figure out study hours, a student torn between PCM and PCB, someone trying to balance coaching with school, or a teenager who simply doesn't know what they want — Nirnayam meets you where you are.

---

## How It Actually Helps Students

Most students have no one to turn to when they're confused — not about a subject, but about *decisions*. Which subjects to focus on this week. Whether their study plan makes sense. How to split limited time across too many things. These aren't questions Google can answer, because the answer depends on *your* specific situation.

That's what Nirnayam is for. You describe your situation in plain language — your subjects, your schedule, what you're struggling with — and the AI advisor responds with structured, practical guidance tailored to what you actually said. Not generic study tips. Not motivational fluff. A real response to your real problem.

### 🗣️ Just Talk to It
There's no form to fill or category to select. You just describe what's going on — "I have a Maths test on Friday and haven't started Calculus yet, but I also have Physics homework due tomorrow" — and Nirnayam thinks through it with you. What to tackle first, how to split the time you have left, what's realistic.

Voice input is supported too, so you don't even have to type. Speak your question and get a response read back to you — useful when you're tired or on your phone.

### ⏱️ Time Split Visualizer
When the conversation involves how to divide your time, Nirnayam generates a **visual multi-segment bar** that shows the breakdown across subjects or tasks as color-coded proportions. It's easier to react to a visual than a list of numbers — you can immediately see if something feels off and ask it to adjust.

---

## Features

| Feature | What It Does |
|---|---|
| 🤖 **AI Advisor (Gemini 2.5 Flash)** | Understands your situation and gives structured, contextual guidance |
| 🗣️ **Voice Input & Output** | Speak your question instead of typing — especially useful on mobile |
| ⏱️ **Time Split Visualizer** | Multi-segment color bar showing how your time is distributed across subjects/tasks |
| 🔐 **User Authentication** | Firebase Auth so your session and history stay private to you |
| 💾 **Persistent Storage** | Firestore saves your conversations so you can pick up where you left off |
| 📱 **Fully Responsive** | Works cleanly on phone, tablet, and desktop — designed for students on the go |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React (Vite) |
| AI Model | Gemini 2.5 Flash (Google AI) |
| Authentication | Firebase Authentication |
| Database | Cloud Firestore |
| Voice I/O | Web Speech API |
| Deployment | Vercel |

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- A Google Gemini API key ([get one here](https://aistudio.google.com/app/apikey))
- A Firebase project ([set one up here](https://console.firebase.google.com/))

### Installation

```bash
git clone https://github.com/Venky0608/nirnayam.git
cd nirnayam
npm install
```

### Environment Variables

Create a `.env` file in the root:

```env
VITE_GEMINI_API_KEY=your_gemini_api_key
VITE_FIREBASE_API_KEY=your_firebase_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
```

### Run Locally

```bash
npm run dev
```

App runs at `http://localhost:5173` by default.

---

## 🏗️ Project Structure

```
nirnayam/
├── src/
│   ├── components/       # UI components (Advisor, TimeSplit, VoiceInput, Auth...)
│   ├── firebase.js       # Firebase config & initialization
│   ├── App.jsx           # Root component & routing
│   └── main.jsx          # Entry point
├── public/
├── .env                  # Environment variables (not committed)
└── vite.config.js
```

---

## 🔧 Key Engineering Decisions

- **Switched from Anthropic/Puter.js → Gemini API** — Anthropic's API isn't accessible browser-side without a backend proxy; Gemini's client SDK works directly in React.
- **Upgraded to `gemini-2.5-flash`** — resolved persistent 429 quota errors on the free tier that were causing the advisor to fail under load.
- **Multi-segment time split bar** — replaced a plain single-color bar with a proportional multi-segment display so students can visually compare subject allocations at a glance.
- **Voice I/O via Web Speech API** — added for mobile accessibility; many students find it easier to speak their situation than type it out.
- **Firebase for auth + storage** — keeps the app stateful across sessions without needing a custom backend, keeping infra simple and free to run.

---

## 👤 Author

**Venky** — Student, developer, and builder from Bengaluru, India. Currently in Class 11, building real things to understand AI from the inside out.

- GitHub: [@Venky0608](https://github.com/Venky0608)
- Live App: [nirnayam.vercel.app](https://nirnayam.vercel.app)

---

## 📄 License

MIT — fork it, build on it, make it better.
