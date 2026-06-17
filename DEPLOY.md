# Deploy Bot to Railway (Free)

## Step 1 — Create Railway account
Go to https://railway.app and sign up with GitHub (free).

## Step 2 — Deploy
1. Click **New Project** → **Deploy from GitHub repo**
2. Push the `discord-bot` folder to a GitHub repo, or use **Deploy from local** and drag the folder in
3. Railway auto-detects Node.js and runs `npm start`

## Step 3 — Set environment variables
In Railway → your project → **Variables**, add:

| Key | Value |
|-----|-------|
| DISCORD_TOKEN | your bot token |
| HTTP_SECRET | ABCDEFGHJKLMNPQRSTUVWXYZ23456789 |
| GUILD_ID | 1509342018038665276 |
| VERIFY_CHANNEL_ID | 1516263240479408249 |
| ROLE_REMOVE_ID | 1509366589068279880 |
| ROLE_GIVE_ID | 1516422293729972354 |

Railway sets PORT automatically — do NOT add it manually.

## Step 4 — Get your public URL
Railway gives you a URL like `https://qb-multicharacter-bot-production.railway.app`
Copy it.

## Step 5 — Update config.lua on your FiveM server
Open `qb-multicharacter/config.lua` and set:
```lua
Config.BotUrl = "https://qb-multicharacter-bot-production.railway.app"
```
Then restart the resource: `restart qb-multicharacter`

## Done!
No firewall changes needed. FiveM calls out to Railway, Railway handles Discord.
