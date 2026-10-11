# AI Agent for YouTube (Chrome extension)

An AI panel that sits right under the YouTube player and does three things with the video you have open:

1. **Summarize**: get the information without watching. TL;DR, key points with clickable timestamps, notable details, and who the video is for. Optionally tell it what you care about ("just the pricing part").
2. **Explain**: understand the video in terms you already know. Type "explain it like I'm a rock climber" and every concept comes back as a climbing analogy, with a note on where the analogy breaks.
3. **Ask an expert**: pick a lens ("a vocal coach analyzing live performances") and get the commentary that person would give, pointed at specific moments. Ask a question or let it free-comment.

Answers stream in as they are written. Every timestamp in an answer is clickable and seeks the player. Follow-up questions keep the thread going, and each video's chat is saved so it is still there when you come back (🗑 clears it).

## No setup needed

By default it uses **Chrome's built-in AI** (Gemini Nano), which runs on your own computer: free, no API key, and the video's content never leaves your device. The first time you press Go, Chrome downloads the model (a few GB, once). It needs 22 GB of free disk space plus a graphics card with more than 4 GB of memory or 16 GB of RAM. Long videos are condensed into timestamped notes first so they fit the small on-device model. If your computer can't run it, the panel says so and points you to the option below.

## Or bring your own model

For stronger answers, or on computers that can't run the built-in AI, pick one of these in the settings page:

- Anthropic (Claude)
- OpenAI (GPT)
- Google Gemini (free tier is fine for testing)
- Any OpenAI-compatible endpoint: Ollama, LM Studio, OpenRouter, Groq, etc.

Your key is stored in Chrome's local extension storage and is only ever sent to the provider you picked.

## Install (unpacked)

1. Unzip this folder somewhere permanent.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder.
4. Open any YouTube video and press **Go**. That's it: it uses Chrome's built-in AI by default.
   To use your own API key instead, click the extension's toolbar icon (or ⚙ in the panel), choose a provider, paste your key, pick a model, click **Test connection**, then **Save**. Chrome asks once for permission to reach that provider; choose **Allow**. (The install prompt only lists youtube.com, because access to an AI provider is requested only for the one you pick.)
5. Open any YouTube video. The panel appears at the top of the right column, above the related videos. Click the header to expand or collapse it.

For Ollama or another local server, pick "Custom OpenAI-compatible endpoint", enter something like `http://localhost:11434/v1`, leave the key blank, and set the model to whatever you have pulled (e.g. `llama3.1`). Chrome will ask once for permission to reach that host. Ollama needs `OLLAMA_ORIGINS="chrome-extension://*"` set so it accepts requests from an extension.

## How it works

- `content.js` runs on youtube.com. It fetches the watch page and reads the caption track list. YouTube now only serves captions to requests signed by its own player, so if a direct download comes back empty, the extension briefly toggles CC and picks up the player's signed caption request instead (restoring your CC setting afterwards). The transcript is merged into 20-second blocks with timestamps and sent along with the title, tags, and description, which help the model correct names that auto-captions mishear. It injects the panel at the top of the right-hand column (`#secondary`, above related videos), falling back to under the player when the layout has no sidebar, and listens for YouTube's `yt-navigate-finish` event so the panel switches to the right chat when you click into another video without a reload.
- `background.js` is the service worker. It holds the provider adapters and makes the API calls, because content scripts cannot call third-party hosts directly.
- `options.html/js` is the settings page.

If a video has no captions, the agent falls back to the title and description and says why.

## Privacy

No server, no analytics. Your key, settings, and chat history stay in Chrome's local storage; video content and prompts go only to the AI provider you pick. See [PRIVACY.md](PRIVACY.md).

## License

Copyright 2026 Arsalan Ghogari. Source available under the [PolyForm Strict License 1.0.0](LICENSE): you may install and use this extension for noncommercial purposes. You may not modify it, redistribute it, or build new works from it. For any other use, contact the author.

## Files

```
manifest.json     MV3 manifest
background.js     provider adapters + message routing
content.js        transcript fetch, panel UI, prompts
panel.css         panel styles (light + dark)
options.html/js   settings page
icons/            toolbar icons
```

## Ideas for next steps

- Keyboard shortcut to toggle the panel
- Right-click "explain this moment" using the current playhead time
