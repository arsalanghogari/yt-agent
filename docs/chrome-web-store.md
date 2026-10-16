# Chrome Web Store submission: Study Pal for YouTube 2.0.0

Everything to paste into the developer dashboard, tab by tab. Upload a new package to the existing item (the old "AI Agent for YouTube" listing); the name updates from the manifest.

## Files

| Field | File (in ~/Downloads) |
|---|---|
| Package | `study-pal-2.0.0.zip` |
| Store icon (128×128) | `yt-agent-store-icon.png` |
| Screenshots (1280×800) | `study-pal-screenshot-1.png`, `-2.png`, `-3.png` |

Build the package from the repo root (only the files the extension needs):

```
zip -r ../study-pal-2.0.0.zip manifest.json background.js content.js quizlet.js notes.html notes.js options.html options.js panel.css icons LICENSE
```

## Store listing tab

**Category:** Education (or Productivity → Tools)
**Language:** English

**Description:**

```
Study Pal turns any YouTube video into a study session. A panel next to the video reads its captions and helps you actually learn it: ask questions, get study notes, make flashcards, quiz yourself, and review every day.

FREE, NO SETUP

Works the moment you install it. Study Pal uses Chrome's built-in AI, which runs on your own computer: no account, no API key, no cost, and the video's content never leaves your device. (The first time, Chrome downloads its AI model once. Needs a reasonably recent computer.)

WHAT YOU GET

• Chat – Ask anything about the video and get a tutor-style answer. Every timestamp is clickable and jumps the video to that moment.
• Notes – Study notes in seconds: overview, key ideas, key terms, examples and what to remember. Save them as a PDF.
• Flashcards – Cards you flip right next to the video, each linking back to where it's explained. Send them to Quizlet or Anki in one click.
• Quiz – A multiple-choice quiz on what the video teaches. Miss a question and Study Pal shows you the part to rewatch.
• Daily review – Your flashcards from every video, shown when they're due (spaced repetition), so you remember them long-term.

Each tab keeps its own conversation, and everything is saved per video, so it's there when you come back.

WANT SHARPER ANSWERS?

Connect your own Claude, ChatGPT or Gemini API key, or a local model through Ollama or LM Studio, in settings. Your key stays in your browser and is only sent to the provider you choose.

PRIVATE BY DESIGN

No account, no tracking, no analytics, and no server of our own.
```

## Privacy practices tab

**Single purpose:**

```
A study companion for YouTube: on watch pages it uses the open video's captions, title and description to answer the student's questions, write study notes, make flashcards and quizzes, and schedule flashcard reviews. By default the AI is Chrome's built-in on-device model; users can optionally connect an AI provider with their own API key. Flashcards can be exported to Quizlet or Anki.
```

**storage justification:**

```
Saves the user's settings on their own device (which AI to use; if they choose a provider, its API key, model and endpoint; answer language), each video's conversations per tab so they're there when the user returns, and their flashcard review deck with when each card is next due. Study notes are stored briefly to open the printable notes page. Nothing in storage is sent to the developer.
```

**Host permission justification:**

```
https://www.youtube.com/* – The content script adds the Study Pal panel to YouTube watch pages and reads the open video's title, description, tags and captions, which the answers, notes, flashcards and quizzes are based on.

https://quizlet.com/* – Only used when the user clicks "Send to Quizlet": a content script fills the user's flashcards into Quizlet's own create-set page in their browser, for them to check and save. It does nothing on Quizlet otherwise, and never reads or sends Quizlet login details.

Optional https://*/*, http://localhost/*, http://127.0.0.1/* – Not granted at install. Only if the user chooses an AI provider in settings and clicks Save, the extension asks Chrome for access to that one provider (api.openai.com, api.anthropic.com or generativelanguage.googleapis.com) or the single custom endpoint address they entered, such as a local Ollama server. The user approves that one host in Chrome's prompt; their request, with the video's captions and details, is sent only there.
```

**Remote code:** No, I am not using remote code.

**Data usage – tick:**
- Authentication information (the user's own API key, if they add one, is stored locally and sent only to their chosen provider)
- Personal communications (questions and answers, saved locally; sent only to the user's chosen provider if they use one)
- Website content (the video's captions and details)

Leave everything else unticked. Tick all three certifications.

**Privacy policy URL:**

```
https://github.com/arsalanghogari/yt-agent/blob/main/PRIVACY.md
```

## Distribution tab

Public, all regions.

## Notes for the reviewer (if asked)

```
No account or setup is needed: open any YouTube video with captions and the Study Pal panel appears in the right-hand column. By default it uses Chrome's built-in AI (Prompt API); on first use Chrome downloads the model. Quizlet access is only used after the user clicks "Send to Quizlet". AI provider hosts are optional permissions requested only when the user saves a provider in settings.
```

## Before submitting

- Load the zip unpacked once and try each tab on a real video (Chat, Notes → Save as PDF, Flashcards → Send to Quizlet, Quiz, Review).
- The update adds quizlet.com access, so existing users get a one-time prompt to re-enable the extension.
