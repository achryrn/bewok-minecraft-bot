# TASKS.md - Ordered Work Plan

Do not reorder. Each task depends on the one before it. Per CLAUDE.md rule 7, update ISSUES.md after each fix.

---

### T1: Wire all manager modules into bot.js

**Files:** `src/bot.js`

**What:**
- Import CombatManager, InventoryManager, BlockManager, SurvivalController, CraftingManager
- Instantiate in `_createBot()` after nav creation
- Expose as `this.combat`, `this.inventory`, `this.blocks`, `this.survival`, `this.crafting`
- Set `this.bot.navigationController = this.nav` for commands.js compat
- Set `this.bot.combat`, `this.bot.blocks`, `this.bot.inventoryManager`, `this.bot.crafting`, `this.bot.survival` for brain.js access
- Pass nav + combat to SurvivalController constructor
- Start SurvivalController on spawn event

**Resolves:** I1, partially I5, I7, I8

---

### T2: Delete src/movement.js (unused duplicate)

**Files:** `src/movement.js`, `tests/unit/movement.test.js`

**What:**
- Delete `src/movement.js` - nothing imports it
- Delete or update `tests/unit/movement.test.js` (keep test file if we want to preserve patterns, but module is dead)

**Resolves:** I2

---

### T3: Refactor brain.js - accept nav, use wired managers

**Files:** `src/brain.js`

**What:**
- Constructor accepts 3rd param `nav`, store as `this.nav`
- `_actionMove`: replace `this.bot.pathfinder.goto()` with `this.nav.goto(x, y, z)`
- `_actionMine`: replace raw pathfinder.goto with `this.nav.goto()`
- `_actionFollow`: replace `setGoal(new GoalFollow(...))` with `this.nav.followEntity(entity)`
- `_actionAttack`: use `this.bot.combat` for attack, `this.nav.followEntity()` for chase
- `_actionCome`: replace raw pathfinder.goto with `this.nav.goto()`
- `_actionExplore`: replace raw pathfinder.goto with `this.nav.goto()`
- `_actionDrop`: delegate to `this.bot.inventoryManager` methods
- `_actionEquip`: delegate to `this.bot.inventoryManager.equipItem()`
- `_actionCycle`: keep as-is (hotbar specific)
- `_actionCraft`: delegate to `this.bot.crafting`
- `cancelCurrentLoop`: call `this.nav.stop()`
- `_actionStop`: call `this.nav.stop()`

**Resolves:** I3, I5, I6

---

### T4: Fix commands.js nav reference

**Files:** `src/commands.js`

**What:**
- Change `this.bot.navigationController` check to `this.nav` or ensure alias exists (T1 already sets it)

**Resolves:** I4

---

### T5: Update tests

**Files:** `tests/unit/bot.test.js`, `tests/unit/brain.test.js`, `tests/unit/combat.test.js` (add integrations)

**What:**
- bot.test.js: assert all managers constructed, SurvivalController started on spawn
- brain.test.js: mock nav, update constructor calls, verify nav methods called for move/follow/come/explore/attack

---

### T6: Run tests and fix failures

**Command:** `npx jest --verbose`

Iterate until all pass.

---

### T7: Sync to production/

**What:** Copy changed src/ files and tests to production/

---

### T8: Update CLAUDE.md known-facts section

**What:** Remove "suspected" annotations for confirmed-fixed issues. Add summary of what was wired.

---

### T9: Build botbridge mod and create JS channel handler (NEW - 2026-07-01)

**Files:** `forge-mod/src/main/java/`, `src/botbridge.js`, `src/bot.js`, `src/brain.js`

**What:**
- Build forge mod jar from Java sources via ForgeGradle (Java 17)
- Create `src/botbridge.js` - JS-side `BotBridgeChannel` class for `botbridge:main` custom channel packets
- Wire channel in `bot.js._createBot()` as `this.bot.botbridge`
- Update `_actionFindOre` in brain.js to try server-side scan through botbridge first, fall back to client-side chunk scan

**Resolves:** I9
---

### T10: Build the agent stack: llm, memory, context, planner, reflector, executor

**Files:** src/llm.js, src/memory.js, src/context.js, src/planner.js, src/reflector.js, src/executor.js (all new)

**What:**
- src/llm.js - plumbable LLM client (claude CLI Windows path preserved) with envelope unwrap, JSON extraction, bounded retries, hard timeout.
- src/memory.js - persistent JSON memory: facts, deduped lessons, locations, bounded chat history, stats.
- src/context.js - FULL live context (vitals/pos/biome/time/weather/dimension/inventory/equipment/XP/effects/entities/blocks/task/memory) + first-person narrative.
- src/planner.js - planner agent: persona system prompt + context + memory + history -> {reply, plan[], remember[]}; legacy {action,args} accepted.
- src/reflector.js - rule-based self-improvement: deaths, failures, stuck, ore finds -> lessons + locations.
- src/executor.js - withRetry / withTimeout / classifyError / dispatch for every action.

**Resolves:** I13, I15

### T11: Refactor brain.js into the multi-agent orchestrator

**Files:** src/brain.js

**What:**
- Plumb memory/llm/planner/reflector/executor into the Brain.
- handleChat: intent -> full context -> planner -> memory write-back -> reply -> step-by-step plan execution with retries/failsafe.
- Instant stop-word and status shortcuts (no model round-trip).
- Whispers supported via handleChat(..., {direct:true}).
- Keep legacy spawnClaudeQuery / executeCommand / _buildBotState / _stripMarkdown API for compat.
- Actions: pure chat, memory-backed remember/recall, wait/jump/sprint/sneak/greet added; existing actions keep passing tests.

**Resolves:** I13

### T12: Refactor the UI layer

**Files:** src/chat.js, src/commands.js, src/bot.js

**What:**
- src/chat.js = single ChatManager UI: slash -> external CommandHandler, NL -> Brain, whispers = direct NL, line-safe replies, welcome message; keeps register/unregister/handleCommand/say/whisper + message/whisper events.
- src/commands.js = aliases, single-line grouped help, per-command usage, /memory and /about; keeps /help first line starting with "Commands:".
- src/bot.js = wire UI (hub for all chat), version detection in start(), bot._forgeHandler / _fabricHandler aliases, debug-gated packet logs, welcome on spawn.

**Resolves:** I14

### T13: Flexible version hopping

**Files:** src/versioning.js (new), src/bot.js, src/config.js, config.json

**What:**
- detectServerVersion() pings and normalizes the server version string.
- closestSupportedVersion() clamps to minecraft-data supported versions.
- resolveBotVersion() picks detected > configured fallback; bot connects with the resolved version.
- config.versionAutoDetect (default true) toggles the ping.

**Resolves:** I12

### T14: Tests for the new stack

**Files:** tests/unit/versioning.test.js, tests/unit/memory.test.js, tests/unit/llm.test.js, tests/unit/planner.test.js, tests/unit/executor.test.js, tests/unit/context.test.js; updated tests/unit/config.test.js, tests/unit/brain.test.js, tests/unit/commands.test.js

**What:** 282 unit tests green (20 suites). Run: local mirror due to I16.

**Resolves:** I16

### T15: Sync to production/ and refresh docs

**What:** Copy index.js, config.json, package.json, jest.config.js, src/, tests/, docs/ into production/.
### T16: Double-click launcher + smoke self-check (DONE 2026-09-20)

**Files:** launch.ps1, start-bot.bat, index.js (--smoke flag)

**What:**
- launch.ps1: node/npm presence checks, one-time auto npm install, data/ + logs/ creation, Ctrl+C-friendly run with logs\bot.log tee, exit-code reporting.
- start-bot.bat: double-click shim; keeps the window open on failure.
- index.js --smoke: config + server version ping self-check that never connects; verified exit 0 on the real config.

**Resolves:** I16 (operationally)

### T17: Runtime state tidied into data/ + local test runner (DONE 2026-09-20)

**Files:** src/task.js (mkdir-safe persistence), src/config.js / config.json (data/ paths), test.ps1, test.bat, README.md, .gitignore, production/package.json rename

**What:**
- task-state.json and memory.json now live in data/ (auto-created) so the root stays clean; logs land in logs/.
- test.bat runs the suite from a self-bootstrapping local copy at %LOCALAPPDATA%\minecraft-bot-tests (Jest cannot resolve mapped drives like Z:).
- README.md documents the double-click quickstart; .gitignore excludes node_modules/data/logs/coverage.
- Regenerable root coverage/ artifact removed.
### T18: ASCII-only text + professional first-person rewording (DONE 2026-09-20)

**What:**
- All source, docs, and config converted to plain ASCII: no em/en dashes, no
  arrows, no box-drawing characters.
- Bot voice reworded to professional first person: welcome message, offline
  fallback reply, and a 'professional tone / ASCII only / no emojis' rule
  added to the planner system prompt.
- README.md rewritten in first person from the bot's perspective.
