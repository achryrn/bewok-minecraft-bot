# BotBridge - Companion Forge Server Mod

A Forge 1.20.1 mod that enables a JavaScript mineflayer bot to connect to modded servers.

## What It Does

1. **Whitelist bypass** - Lets the bot join even when mods have `required: true` network channels
2. **Ore scanning** - Server-side chunk scan for ore positions (bot requests, server scans ALL loaded chunks)
3. **Configuration** - `/botbridge whitelist list` command in-game

## Installation

1. **Build or download** the JAR from `build/libs/botbridge-1.0.0.jar`
2. **Place it** in your server's `mods/` folder
3. **Restart** the server
4. **Configure** `config/botbridge-server.toml`:
```toml
[botbridge]
    # Bot usernames allowed past mod channel checks
    whitelistedBots = ["Bot", "BewokBot"]
    # Max ore scan radius in blocks
    oreScanMaxRadius = 64
```

## Build from Source

Requires Java 17 + Forge MDK 1.20.1 (provides `gradlew`).

```bash
# 1. Download Forge MDK for 1.20.1 from:
#    https://files.minecraftforge.net/net/minecraftforge/forge/index_1.20.1.html
#    Click "Mdk" to download the zip

# 2. Extract MDK, then copy BotBridge source over it:
unzip forge-1.20.1-47.4.10-mdk.zip -d ../botbridge-build
cp -r src/* ../botbridge-build/src/
cp build.gradle ../botbridge-build/

# 3. Build:
cd ../botbridge-build
./gradlew build
```

Output: `build/libs/botbridge-1.0.0.jar`

## In-Game Commands

| Command | Permission | Description |
|---------|-----------|-------------|
| `/botbridge whitelist list` | Anyone | List whitelisted bot usernames |
| `/botbridge whitelist reload` | OP (level 2) | Reload config from disk |

## Files

```
forge-mod/
+-- build.gradle
+-- src/main/java/com/bewok/botbridge/
|   +-- BotBridgeMod.java          - Mod entry point
|   +-- config/
|   |   +-- BotBridgeConfig.java   - Server config (whitelist, ore scan radius)
|   +-- events/
|   |   +-- PlayerNegotiationHandler.java - Whitelist bypass
|   +-- network/
|   |   +-- NetworkHandler.java    - SimpleChannel registration
|   |   +-- packets/
|   |       +-- OreScanRequestPacket.java  - Bot->Server ore scan request
|   |       +-- OreScanResponsePacket.java - Server->Bot scan results
|   +-- command/
|       +-- BotBridgeCommands.java - In-game command registration
+-- src/main/resources/
    +-- META-INF/mods.toml
    +-- pack.mcmeta
```
