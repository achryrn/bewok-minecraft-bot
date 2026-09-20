# minecraft-bot

[![CI](https://github.com/achryrn/bewok-minecraft-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/achryrn/bewok-minecraft-bot/actions/workflows/ci.yml)

I am a self-improving Minecraft bot built with mineflayer. I join cracked and
offline-mode servers, understand natural-language requests, and complete
multi-step tasks on my own. My brain is a suite of cooperating agents: a
planner decides what to do, an executor carries out every action with retry
and failsafe handling, and a reflector learns from what goes wrong so I do
better next time.

## Launching me

Double-click start-bot.bat and I handle the rest:

1. Node.js is checked first (install the LTS from https://nodejs.org if needed).
2. Dependencies install automatically on the first run (a few minutes).
3. I connect to the server configured in config.json and say hello in chat.
4. Every launch is logged to logs\bot.log. If anything fails, the window stays
   open so you can read the error.

Press Ctrl+C in my window to stop me. To check my configuration and the
server version without connecting, run: node index.js --smoke

## Running the tests

Double-click test.bat. Jest cannot resolve mapped network drives such as Z:,
so the runner copies the project to a local folder under %LOCALAPPDATA% and
runs the unit suite there: 288 tests across 20 suites. The same suite runs in
CI on Node 20, 22, and 24.

## Talking to me in-game

- Address me with a trigger word: bot mine 16 oak logs
- Use natural language: hey bot, build me a 7x7 cobblestone platform
- Slash commands: /help, /status, /inventory, /mine stone 8, /goto x y z,
  /build platform cobblestone 7, /follow Steve, /memory, /stop
- Whisper to me directly; whispers are always treated as a direct request.

## Repository layout

| Path            | Purpose                                      |
|-----------------|----------------------------------------------|
| start-bot.bat   | double-click launcher                        |
| test.bat        | double-click test runner                     |
| config.json     | server, auth, brain, memory, retry settings  |
| data/           | runtime state (memory.json, task-state.json) |
| logs/           | launch logs (bot.log)                        |
| src/            | bot code (brain, agents, ui, managers)       |
| forge-mod/      | source of the bridge mod (compiled botbridge-1.0.0.jar) |
| production/     | synced deploy copy (identical layout)        |

## Configuration

- auth: "offline" lets me join cracked and offline-mode servers; no premium
  account is required.
- versionAutoDetect: true makes me ping the server and connect with its
  version, falling back to the "version" value in config.json when the ping
  fails.
- brain.provider: "claude" uses the Claude Code CLI installed on this machine
  (claudePath). Keep the CLI up to date for the best results.
- memory.enabled: true lets me learn from failures and remember places; my
  lessons are stored in data/memory.json.

To point me at another server, edit host, port, and username in config.json,
then double-click start-bot.bat again.
<!-- last-verified: 2026-09-20 02:59 UTC -->
