# minecraft-bot

A self-improving Minecraft bot (mineflayer) with a natural-language "brain"
(Claude CLI), full live game context, retry/failsafe action execution,
persistent self-improvement memory, and automatic server-version detection -
built for cracked / offline-mode servers (auth: "offline").

[![CI](https://github.com/achryrn/bewok-minecraft-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/achryrn/bewok-minecraft-bot/actions/workflows/ci.yml)

## Quick start (double-click)

1. Make sure Node.js LTS is installed: https://nodejs.org
   (any recently-installed Node 18/20/22/24 works).
2. Double-click start-bot.bat :

   - First run: installs dependencies automatically (a few minutes),
   - then connects to the server in config.json and runs,
   - logs every launch to logs\bot.log,
   - if something fails, the window stays open and shows the error.

3. To stop the bot: press Ctrl+C in its window.

Optional self-check: run "node index.js --smoke" (or launch.ps1 -Smoke) to
validate the config and ping the server for its Minecraft version WITHOUT
connecting.

## Tests

Double-click test.bat - it copies the project to a local folder (necessary
because Jest cannot resolve mapped network drives like Z:) and runs the full
unit suite (288 tests / 20 suites).

## Talking to the bot in-game

- Plain chat with a trigger word:  bot mine 16 oak logs
- Or casual language:  hey bot, build me a 7x7 cobblestone platform
- Slash shortcuts: /help, /status, /inventory, /mine stone 8, /goto x y z,
  /build platform cobblestone 7, /follow Steve, /memory, /stop
- Whispers (/msg <bot> ...) are always "direct" - no trigger word needed.

## Files & folders

| Path            | Purpose                                     |
|-----------------|---------------------------------------------|
| start-bot.bat   | double-click launcher                       |
| test.bat        | double-click test runner                    |
| config.json     | server, auth, brain, memory, retry settings |
| data/           | runtime state (memory.json, task-state.json)|
| logs/           | launch logs (bot.log)                       |
| src/            | bot code (brain, agents, ui, managers)      |
| production/     | synced deploy copy (identical layout)       |

## Config highlights

- auth: "offline" - cracked/offline-mode servers (no premium account needed).
- versionAutoDetect: true - pings the server and connects with ITS version
  (flexible version hopping); falls back to "version" on ping failure.
- brain.provider: "claude" - uses the Claude Code CLI installed on this PC
  (claudePath). Keep a recent CLI version installed for the smartest behavior.
- memory.enabled: true - the bot learns from failures and remembers places;
  lessons are stored in data/memory.json.

Need a different server? Edit host / port / username in config.json and
double-click start-bot.bat again.