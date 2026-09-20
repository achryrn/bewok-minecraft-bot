# ISSUES.md — Bot Repair Project

This file documents all known issues identified via static analysis and prior debugging sessions. Each issue links to a corresponding fix task in TASKS.md.

**Last update: 2026-07-01** — I1–I11 fixed. See resolution notes.

---

## I1. Dead manager modules never wired into bot.js (VERIFIED — FIXED 2026-07-01)

`src/combat.js`, `src/inventory.js`, `src/blocks.js`, `src/survival.js`, `src/crafting.js` are fully built and tested but never imported or instantiated by `index.js` or `src/bot.js`. The bot runs without PVP, inventory management, block safety checks, survival monitoring, or crafting — despite having working code for all of them.

**Impact:** Bot cannot PVP, auto-eat beyond the basic plugin, use best-tool mining, detect lava hazards, flee hostiles, or craft items. User reports "cannot pvp" match this.

**Fix:** Wire all five managers in `bot.js._createBot()` and expose them on the bot instance for `brain.js` and `commands.js`.

**Resolution (2026-07-01):** All five managers imported, instantiated in `_createBot()`, exposed as `this.bot.combat`, `this.bot.inventoryManager`, `this.bot.blocks`, `this.bot.survival`, `this.bot.crafting`. SurvivalController started on spawn event, stopped on death.

---

## I2. Duplicate movement abstractions (VERIFIED — FIXED 2026-07-01)

Three movement systems exist:
1. `src/navigation.js` (NavigationController) — full collision recovery, stuck detection, wired in bot.js as `this.nav`
2. `src/movement.js` (MovementManager) — simple pathfinding, no recovery, NOT wired by anything
3. Inline `bot.pathfinder` calls in `src/brain.js` — raw mineflayer calls, bypasses both wrappers

**Impact:** Brain does not benefit from collision recovery (stuck detection, jump/dig recovery). Movement code is fragmented with no single point of control.

**Fix:** Delete `movement.js`. Rewire `brain.js` to use `this.nav` for all movement.

**Resolution (2026-07-01):** `src/movement.js` and `tests/unit/movement.test.js` deleted. Nothing imported them. Brain now uses `this.nav.goto()` and `this.nav.followEntity()` exclusively.

---

## I3. Brain ignores NavigationController (VERIFIED — FIXED 2026-07-01)

`bot.js:59` passes `this.nav` as 3rd argument: `new Brain(this.bot, this.config, this.nav)`. But `brain.js` constructor signature is `constructor(bot, config)` — the third argument is silently dropped. Every movement action (`move`, `mine`, `follow`, `attack`, `come`, `explore`) uses raw `this.bot.pathfinder.goto()` or `this.bot.pathfinder.setGoal()` directly.

**Impact:** Stuck recovery, jump-over-obstacles, dig-through, and timeout safety in NavigationController are completely bypassed.

**Fix:** Update brain.js constructor to accept and store `nav`. Replace all raw pathfinder calls with `this.nav.goto()`, `this.nav.followEntity()`, `this.nav.stop()`.

**Resolution (2026-07-01):** Constructor now `constructor(bot, config, nav)`. All movement actions migrated: `_actionMove`, `_actionMine`, `_actionFollow`, `_actionAttack`, `_actionCome`, `_actionExplore`, `cancelCurrentLoop`.

---

## I4. Commands.js references non-existent navigationController (VERIFIED — FIXED 2026-07-01)

`src/commands.js:288-292`:
```js
} else if (this.bot.navigationController) {
  this.bot.navigationController.goto(x, y, z)
```
`this.bot.navigationController` is never set anywhere. The actual nav instance is `this.nav` in `bot.js`. No property `navigationController` exists on the bot object.

**Impact:** `/goto` command falls through to "Navigation not available" even when nav is working.

**Fix:** Set `this.bot.navigationController = this.nav` in bot.js as an alias, or fix commands.js to use the correct property.

**Resolution (2026-07-01):** Bot.js now sets `this.bot.nav = this.nav` AND `this.bot.navigationController = this.nav`. Commands.js `/goto` handler updated to reference `this.bot.nav` directly.

---

## I5. Brain uses InventoryManager logic inline (VERIFIED — FIXED 2026-07-01)

`src/inventory.js` has a complete `InventoryManager` class with `equipItem`, `tossItem`, `dropAll`, `equipSword`, `equipPickaxe`, `equipToolForBlock`, etc. But brain.js reimplements drop/equip/cycle logic inline without using it.

**Impact:** Code duplication. Features like `dropAll`, `equipToolForBlock`, `equipSword` exist but are unreachable.

**Fix:** Wire InventoryManager in bot.js, pass to brain, and have brain delegate drop/equip/cycle actions.

**Resolution (2026-07-01):** `_actionDrop` and `_actionEquip` now delegate to `this.bot.inventoryManager`. `_actionCycle` kept as-is (hotbar-specific, not an inventory manager concern).

---

## I6. Brain uses raw pathfinder.goto with no timeout (VERIFIED — FIXED 2026-07-01)

All `this.bot.pathfinder.goto()` calls in brain.js lack timeouts. If the pathfinder hangs (noPath, unreachable terrain), the promise never resolves, leaving the bot stuck indefinitely.

NavigationController's `goto()` has a 30s timeout and returns `false` on failure, but brain never uses it.

**Impact:** Bot freezes on unreachable terrain.

**Fix:** Use `this.nav.goto()` which has built-in timeout and recovery.

**Resolution (2026-07-01):** Resolved as part of I3 fix — all pathfinder calls replaced with `this.nav.goto()`.

---

## I7. SurvivalController not wired (VERIFIED — FIXED 2026-07-01)

`src/survival.js` has `SurvivalController` with auto-engage hostiles, flee-on-low-health, lava/void detection, and auto-eat coordination. None of it is wired.

**Impact:** Bot stands in lava, walks into void, never flees from hostiles at low health.

**Fix:** Wire SurvivalController in bot.js with references to combat and nav controllers.

**Resolution (2026-07-01):** Instantiated with `(bot, config, this.combat, this.nav)`. `start()` called on spawn event. `stop()` called on death. Event listeners for started/stopped wired.

---

## I8. CraftingManager not wired (VERIFIED — FIXED 2026-07-01)

`src/crafting.js` has `CraftingManager` with recipe lookup, table placement, and craftable-item listing. Brain's `_actionCraft` uses raw `this.bot.craft(item.id, n)`.

**Impact:** Cannot craft items that require a crafting table. No ingredient checking. Only works for 2x2 recipes.

**Fix:** Wire CraftingManager in bot.js. Have brain delegate craft actions.

**Resolution (2026-07-01):** CraftingManager instantiated in bot.js. `_actionCraft` now delegates to `this.bot.crafting.craft()` with fallback to raw path.

---

## I9. Botbridge channel never used (VERIFIED — FIXED 2026-07-01)

The companion Forge mod (`botbridge-1.0.0.jar`) defines `OreScanRequestPacket` / `OreScanResponsePacket` on a custom channel. The JS side never references these packets anywhere in `src/`.

**Impact:** Bot cannot request ore scans from the server-side mod.

**Fix:** Add a communication channel to send/receive botbridge packets. Requires defining a protodef schema and packet handler.

**Resolution (2026-07-01):** Created `src/botbridge.js` — JS-side handler for `botbridge:main` custom channel. Encodes/decodes packets directly (varInt packet ID + Minecraft-style wire format). `_actionFindOre` in brain.js now tries server-side scan via botbridge first, falls back to client-side chunk scan. Mod jar rebuilt from `forge-mod/` sources (Gradle build, Java 17), deployed to `production/botbridge-1.0.0.jar`. BotBridgeChannel successfully registered at startup (`[botbridge] Channel handler ready` confirmed live).

---

## I10. No docs/ directory or ISSUES/TASKS files (VERIFIED — FIXED 2026-07-01)

The files CLAUDE.md references (`docs/ISSUES.md`, `docs/TASKS.md`) do not exist. The project has no structured issue tracker or work plan.

**Impact:** Each session must re-derive the problem space.

**Fix:** Create these files.

**Resolution (2026-07-01):** Created `docs/` directory with `ISSUES.md` and `TASKS.md`.

---

## I11. Reconnect loop — stale bot + post-login FML3 handler (VERIFIED — FIXED 2026-07-01)

Two root causes interact to produce an infinite reconnect loop:

**Cause A — Stale bot reuse:** `_handleDisconnect()` called `setTimeout(() => this._createBot(), delay)` without ending the old bot. The old `_client` TCP socket stayed connected, resulting in two concurrent logins for "BewokBot" → server kicks the older one ("You logged in from another location") → kick triggers another disconnect → loop.

**Cause B — Post-login FML3 handler spam:** `forgeHandshake3.js` registers a `login_plugin_request` handler at setup time but never removes it after LoginSuccess. When other server mods (PlasmoVoice, SkinRestorer, etc.) send `login_plugin_request` packets after the handshake, the handler tries to parse them as FML3 loginwrapper packets, responds with incorrect message ID formatting → "Recieved unexpected index 0/1 in client reply" errors on the server side.

**Impact:** Bot never stays connected for more than ~30 seconds. Reconnect counter keeps incrementing until maxReconnectAttempts reached, then gives up. Server console fills with "unexpected index" errors.

**Fixes:** 
- `_handleDisconnect()` now fully cleans up old bot: removes all listeners, calls `bot.end()`, nulls all references before scheduling reconnect.
- `forgeHandshake3.js` handler function named `onFmlLoginPluginRequest` so `forge.js` can find and remove it by `.name`.
- `forge.js` now removes the FML3 handler on `login_success` event, preventing post-login packet interference.

**Server console confirmation:** After fix, "unexpected index" errors ceased and bot stayed connected indefinitely (20+ minute session confirmed).
---

## I12. Version hopping — no way to follow servers that change MC versions (FIXED 2026-09-20)

Bot version came only from config.json (hardcoded version "1.20.1"). Cracked/offline server networks frequently expose different MC versions behind one IP, so a fixed version meant failed or wrong-protocol connections.

Fix: new src/versioning.js — pings the server (minecraft-protocol), normalizes the reported version string ("Requires MC 1.20.1", "Paper 1.20.1", "1.20.1-Fabric ..." etc.), clamps to a minecraft-data-supported version, and falls back to the configured version on ping failure (verified live: ECONNRESET → clean config-fallback to 1.20.1). Wired into BotManager.start(); config.versionAutoDetect toggles it.

## I13. Brain was a single stateless Claude call — no planning, retry, memory or full context (FIXED 2026-09-20)

The old brain passed a tiny hand-picked state snapshot to one Claude CLI call per message, interpreted one action, and forgot everything between messages. Failures were not retried, long tasks could silently hang, and the model had no idea it was "really" in the world.

Fix: rebuilt as a multi-agent orchestrator:
- src/planner.js — planner agent: full live context + memory + history → {reply, plan[], remember[]} (legacy {action,args} still accepted),
- src/executor.js — retry/timeout/classify/failsafe wrapper for every action,
- src/reflector.js — learns lessons + locations from deaths/failures/stuck events,
- src/memory.js — persistent JSON memory (facts, lessons, locations, history, stats),
- src/context.js — FULL context builder (vitals, position, biome, time, weather, dimension, gamemode, inventory, equipment, XP, effects, entities, nearby blocks, task, memory) + first-person narrative for immersion,
- src/llm.js — pluggable LLM client with envelope unwrapping, markdown-free JSON extraction and bounded retries.

## I14. Bot UI was raw chat handlers with no formatting/routing (FIXED 2026-09-20)

CommandHandler + Brain were called directly from bot.js with duplicated chat listeners; messages were not chunked, no welcome/help, dual command registries.

Fix: src/chat.js is now the single UI layer (still ChatManager-compatible): routes "/" shortcuts to the external CommandHandler, everything else to the Brain natural-language path, whispers are "direct" NL (no trigger word needed), replies are line-split safely, welcome message on spawn. src/commands.js gained aliases, grouped single-line help, usage strings, /memory and /about.

## I15. Hardcoded Windows-only claude spawn with 15s timeout and no retry (FIXED 2026-09-20)

brain.js spawned cmd.exe /c claude with timeout inside spawn() and no retry. src/llm.js now owns the subprocess with a real kill-timer, envelope unwrapping, validation-driven retries, and a configurable provider hook.

## I16. Test suite could not run on the mapped network drive (FIXED — infra note)

Jest mis-resolved rootDir when the project lives on a network-mapped Z: drive (UNC mix-ups → "No tests found"). Workaround used during development: a local mirror (mcbot-work) with a real node_modules install; source of truth remains Z:\MCBot\minecraft-bot. Production copy in production/ keeps the suite runnable from a local path.