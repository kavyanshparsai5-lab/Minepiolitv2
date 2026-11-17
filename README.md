# MinePilot AI — Java Edition

Control a real Minecraft **Java Edition** bot from your phone or PC. Enter the server address, port and a bot username, press **Connect**, then type plain instructions like `follow Steve`, `collect wood`, `craft 4 sticks` or `stop`.

- **Minecraft Java 1.18.1 and every newer version** this install's Mineflayer knows (currently up to 26.1). The server's version is detected automatically.
- Full bot: move, follow, explore, chat, mine, collect wood, craft, eat, `/register` + `/login`.
- Java only: no Bedrock code, no native modules, nothing compiled during install.
- Runs on **Android with Termux**, or on any PC/server with Node.js 18 or newer. Open the dashboard in Chrome at `http://localhost:3000`.

**Tested for real** (Paper servers in offline mode with AuthMeReloaded 5.7.0, driven through MinePilot's own API) on **1.18.1, 1.18.2, 1.20.4, 1.21.4** and **1.21.4 + ViaVersion 5.12.2**: connect, auto version, `/register` + `/login`, chat both ways, follow a player, collect wood, craft planks → sticks → crafting table → wooden pickaxe, mine stone, inventory, jump, goto, auto-reconnect after a kick, clear error on a closed port.

---

## 1. Install

### Android (Termux)

Get Termux from **F-Droid** or GitHub. The Play Store version is outdated. Then run:

Save `minepilot-ai-java.zip` to **Downloads**, then run these one at a time:

```sh
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git unzip
termux-setup-storage            # allow access to Downloads (tap "Allow")
unzip -o ~/storage/downloads/minepilot-ai-java.zip -d ~
cd ~/minepilot-ai
npm install
npm start
```

Then open **http://localhost:3000** in Chrome.

- `-o` overwrites an older MinePilot in `~/minepilot-ai` (your saved settings in `data/` are kept). `npm install` then removes the old Bedrock packages by itself.
- `npm install` downloads about 35 MB and uses about 540 MB of storage (most of it is Minecraft's block and item data for every version).
- Next time you only need `cd ~/minepilot-ai` and `npm start`.

### PC / Mac / Linux / VPS

Install Node.js 18+ from https://nodejs.org, unzip the project, then:

```sh
cd minepilot-ai
npm install
```

The project's `.npmrc` sets `ignore-scripts=true`, so nothing is compiled during install and the same steps work everywhere.

## 2. Start

```sh
npm start
```

Open **http://localhost:3000** in Chrome on the same device. On Termux, keep the Termux session open (you can pull down the notification and tap "Acquire wakelock" so Android doesn't pause it).

Stop with `Ctrl+C`.

## 3. Use it

1. Enter the server address, port (empty = 25565) and a bot username (3-16 letters, numbers or `_`). You can also paste `host:port` into the address box.
2. Press **Connect**. The terminal shows each step: ping, server version, join, spawn. The version is detected automatically (see *Versions* below). You can force one under *Advanced*.
3. If the server uses AuthMe or a similar plugin, MinePilot spots the `/register` or `/login` message and opens a password box. The password goes only to the server and is masked in all logs. Tick *Remember* to save it on this device for this server and bot name. It's only saved after the server confirms the login.
4. Type commands in **Assistant**. In Settings, set *Your in-game name* so `follow me` and `come here` work.

### Commands (deterministic — no AI needed)

| Command | What it does |
|---|---|
| `follow <player>` / `follow me` | Follows the player until `stop` |
| `come` / `come to <player>` | Walks to the player once |
| `stop` | Stops the current task (pathing, digging, crafting) |
| `collect wood [n]` | Finds trees within 64 blocks, mines `n` logs (default 4) and picks them up |
| `mine <block> [n]` | e.g. `mine 5 stone`, `mine iron ore`. Checks that it has the right tool first |
| `craft <item> [n]` | e.g. `craft planks`, `craft 4 sticks`, `craft crafting table`, `craft wooden pickaxe` |
| `inventory` | Lists what the bot carries |
| `say <message>` or `/anything` | Sends a chat message or a server command |
| `goto x y z` / `goto x z` | Walks to coordinates |
| `jump` | Jumps once and reports whether it actually left the ground |
| `explore [radius]` | Wanders to random reachable spots until `stop` |
| `eat` | Eats the best food it has. Auto-eat (Settings) does this at food ≤ 14 |
| `sleep` | Uses a bed within 32 blocks at night |
| `equip <item>`, `drop <item> [n]` | Hold or throw items |
| `status`, `players`, `help` | Health, food, position, who is online |
| `yes` / `no` | Answers the bot when it asks before using materials |

**Resource rules.** The bot checks its inventory before each task. If something is missing, it lists exactly what (`Missing: 2 × planks`). Before any extra work that uses materials, it asks first. For example, `craft wooden pickaxe` with only logs answers *"I need to: craft 4 planks → craft 1 crafting table → place a crafting table → craft … Go ahead? (yes / no)"*. Mining a block that needs a better tool gets the same treatment, with an offer to craft a wooden or stone pickaxe. Results are measured from the real inventory afterwards, never assumed. If the server restores blocks the bot breaks (spawn protection, land claims), the bot stops and tells you it lacks permission.

### Versions

- **Auto-detect (default):** MinePilot pings the server, reads its version and joins with the matching protocol, from **1.18.1** up to the newest version the installed Mineflayer supports (**26.1** in this build).
- **Older than 1.18.1:** you get a clear message (*"This server runs Minecraft 1.17.1 (protocol 756), which is older than 1.18.1…"*) and nothing tries to join.
- **Newer than this install knows:** you get a clear message telling you to update the Minecraft library (below).
- **ViaVersion / multi-version servers and proxies:** such servers answer a ping with whatever version the pinger claims to be. MinePilot pings twice and, when the answers differ, joins at the **server's own version**, so block, item and recipe names match the server exactly. The terminal says when this happens. Tested on Paper 1.21.4 + ViaVersion 5.12.2: it joined as 1.21.4, not as 26.1.
- **Manual version** (*Advanced → Version*): only 1.18.1+ versions are listed. If you pick one that differs from the server's, the terminal warns you.

**Newer Minecraft versions.** When Mojang releases a version newer than this install supports, update the library inside `~/minepilot-ai`:

```sh
npm install mineflayer@latest minecraft-data@latest minecraft-protocol@latest
```

### Optional AI helper

Settings → *AI helper*. Enter an OpenAI-compatible API base URL (default `https://api.openai.com/v1`), a model and an API key. When it's on, text the parser doesn't understand goes to that API, which can only answer with one of the built-in commands. The deterministic parser still decides what runs. It's off by default and nothing else depends on it. The key is stored in `data/secrets.json` (file mode 600) and is never sent to the dashboard or written to logs.

## 4. Environment variables (all optional)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Dashboard port |
| `HOST` | `127.0.0.1` | Interface to listen on. Use `0.0.0.0` to open the dashboard from another device on your Wi-Fi |
| `MINEPILOT_ACCESS_KEY` | random, saved in `data/config.json` | Key required for non-local browsers. Printed at start when `HOST` is not local |
| `MINEPILOT_LOCAL_AUTOLOGIN` | `1` | `0` = also require the key on the same device |
| `MINEPILOT_DATA_DIR` | `./data` | Where config, saved passwords and Microsoft sign-in tokens live |

Example: `HOST=0.0.0.0 PORT=8080 npm start`

## 5. Security

- The API needs a session cookie (HttpOnly, SameSite=Strict). Browsers on the same device get one automatically. Other devices must enter the access key.
- Every write request also needs the `X-MinePilot` header (CSRF guard). The WebSocket checks the session and Origin. Requests are rate-limited, JSON bodies are capped at 16 KB, and a strict Content-Security-Policy is set.
- All inputs are validated on the server: address, port, Java username rules, version (1.18.1+), password (no spaces, max 64), command length (max 256).
- Passwords are masked in logs and the dashboard. `/login x`, `/register x x` and any password typed this session become `******`. Nothing is saved unless you tick *Remember*. *Settings → Forget saved passwords* wipes them.

## 6. Testing it yourself

1. `npm test` runs the parser, validation and redaction tests.
2. Live test against your own server (this is how the release was tested):
   - Run a Java server in offline mode (`online-mode=false` in `server.properties`), e.g. Paper 1.18.2, 1.20.4 or 1.21.4. Optionally add AuthMeReloaded 5.7.0 (it works on all of these) to test `/register` and `/login`, and ViaVersion to test multi-version detection.
   - Start MinePilot, connect to `127.0.0.1:25565`, register when asked, then join with your own account (or a second bot) as "Steve".
   - Try `follow Steve`, `stop`, `collect wood` near trees, `craft planks`, `craft 4 sticks`, `craft wooden pickaxe` (answer `yes`), `mine 3 stone`, `inventory`, `say hi`.
   - Kick the bot from the console (`kick MinePilot`): it auto-reconnects and logs in with the saved password.
   - Connect to a wrong address (`no-such-server.invalid`) or a closed port: you get a clear error, not a fake "online".

## 7. Known limitations

- **Java Edition only.** Bedrock servers (usually port 19132) are not supported in this build; entering port 19132 gets a clear message saying so.
- **Versions:** Java 1.18.1 to 26.1. Tested live on 1.18.1, 1.18.2, 1.20.4, 1.21.4 (and 1.21.4 with ViaVersion). Versions in between use the same code and Mineflayer's own data, but were not each run on a live server here.
- **Microsoft (online-mode) accounts** use the official device-code sign-in built into Mineflayer. This wasn't tested with a real account. Most cracked/offline servers with AuthMe are the main case and were tested.
- **Servers with anti-bot or anti-cheat plugins** (captcha on join, "move to verify", bot filters) may kick the bot. Only use it where bots are allowed.
- **Pathing:** the bot doesn't place blocks to climb while walking unless you allow it in Settings. The one exception: after `mine`/`collect wood`, if it ended up more than 2 blocks below where it started (e.g. at the bottom of a shaft it dug), it climbs back up, placing a few of the dirt/cobblestone blocks it just mined if it has to. Logs high up in big trees can be out of reach and are skipped (the reply says how many it really got). With "Allow breaking blocks while walking" on, it may also mine blocks in its way, and those show up in the inventory report.
- **Crafting:** only recipes the server uses with standard ingredients. Smelting, brewing, smithing and villager trading aren't supported.
- **Survival:** auto-eat, `eat`, `sleep` and automatic respawn. There's no combat or mob defence.
- One bot at a time per MinePilot instance.
- Saved passwords and the AI key are stored in plain JSON (mode 600) on your device, not encrypted.

## Project layout

```
server/index.js          HTTP API, sessions, WebSocket
server/manager.js        connection lifecycle, auto-reconnect, command routing
server/drivers/java.js   Mineflayer driver (tasks, crafting planner, mining)
server/versions.js       1.18.1+ version rules, auto-detect, ViaVersion-aware ping
server/drivers/base.js   shared auth detection (/register, /login) and confirmations
server/commands.js       deterministic command parser
server/ai.js             optional OpenAI-compatible translator
server/store.js          config.json / secrets.json
server/validate.js, server/redact.js
public/                  dashboard (plain HTML/CSS/JS, no build step)
test/                    node --test unit tests
```
