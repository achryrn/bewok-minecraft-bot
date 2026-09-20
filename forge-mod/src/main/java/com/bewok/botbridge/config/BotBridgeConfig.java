package com.bewok.botbridge.config;

import net.minecraftforge.common.ForgeConfigSpec;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

public class BotBridgeConfig {
    private static final ForgeConfigSpec.Builder BUILDER = new ForgeConfigSpec.Builder();

    private static final ForgeConfigSpec.ConfigValue<List<? extends String>> WHITELISTED_BOTS =
        BUILDER.comment("Usernames allowed to bypass mod channel negotiation checks")
            .defineList("whitelistedBots", List.of("Bot"), o -> o instanceof String);

    private static final ForgeConfigSpec.IntValue ORE_SCAN_MAX_RADIUS =
        BUILDER.comment("Maximum radius (blocks) the server will scan per ore-scan request")
            .defineInRange("oreScanMaxRadius", 64, 8, 256);

    public static final ForgeConfigSpec SPEC = BUILDER.build();

    public static Set<String> getWhitelistedBots() {
        return WHITELISTED_BOTS.get().stream().collect(Collectors.toSet());
    }

    public static int getOreScanMaxRadius() {
        return ORE_SCAN_MAX_RADIUS.get();
    }
}
