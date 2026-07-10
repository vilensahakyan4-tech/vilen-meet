# VILEN Meet

VILEN Meet is a clean Zoom/Teams-style meeting app.

## Features

- Create a meeting
- Join by code or invite link
- Branded call page
- Camera, microphone, chat, participants via Metered video room
- Return to home after leaving

## Run locally

```bash
npm start
```

Open `http://localhost:3000`.

## Required environment variables

- `METERED_APP_NAME` — for example `volna-chat-app`
- `METERED_SECRET_KEY` — from Metered Dashboard → Developers

Without these variables, the app UI still opens, but creating real rooms requires Metered credentials.
