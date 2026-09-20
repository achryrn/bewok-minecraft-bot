package com.bewok.botbridge.events;

import com.bewok.botbridge.config.BotBridgeConfig;
import net.minecraftforge.event.entity.player.PlayerEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

import java.util.Set;

@Mod.EventBusSubscriber(modid = "botbridge")
public class PlayerNegotiationHandler {

    @SubscribeEvent
    public static void onPlayerLogin(PlayerEvent.PlayerLoggedInEvent event) {
        String username = event.getEntity().getGameProfile().getName();
        // Logged in — whitelist check already passed via EntityJoinLevelEvent
    }
}