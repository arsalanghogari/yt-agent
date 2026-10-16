# Privacy Policy: Study Pal for YouTube

Last updated: 2026-10-15

Study Pal for YouTube is a browser extension that runs entirely in your browser. It has no server of its own, and the developer does not collect, receive, or store any of your data.

## What the extension handles

- **Your settings** (which AI to use, and if you choose a provider: your API key, model and endpoint URL; plus your preferences) are stored in Chrome's local extension storage on your device.
- **Video content**: when you ask for a summary, explanation, or commentary, the extension reads the open video's title, channel, description, tags, and captions from youtube.com.
- **Your study deck**: flashcards you make are kept in Chrome's local extension storage on your device, with when each is next due for review. Removing the extension deletes them.
- **Your prompts and chat history**: what you type, and the answers you get, are saved per video in Chrome's local extension storage on your device so they are there when you return. The 🗑 button deletes a video's chat. Removing the extension deletes everything.

## Where data is sent

By default the extension uses Chrome's built-in AI, which runs on your own computer: the video content and your prompts are processed on your device and are not sent anywhere.

If you instead choose an AI provider in settings (for example Anthropic, OpenAI, Google Gemini, or a custom endpoint you enter), the video content and your prompts are sent only to that provider, using your own API key. That provider's privacy policy applies to what it receives. Nothing is sent anywhere else.

## Flashcards and Quizlet

When you click **Send to Quizlet**, the flashcards are saved briefly in Chrome's local extension storage and copied to your clipboard, then Quizlet's create-set page opens in your browser and the extension fills the cards in there. This happens in your own browser, in your own Quizlet session: the extension never reads, stores or sends your Quizlet login, and the cards are removed from extension storage once they've been filled in (or after 10 minutes). **Download for Anki** saves a text file on your computer.

## What the extension does not do

- No analytics, tracking, or advertising.
- No selling or sharing of data.
- No access to websites other than youtube.com, quizlet.com (only to fill in flashcards you send there), the AI provider you picked, and any custom endpoint you approve.

## Contact

Questions: open an issue at https://github.com/arsalanghogari/yt-agent/issues
