package com.bewok.botbridge;

import com.bewok.botbridge.config.BotBridgeConfig;
import com.bewok.botbridge.network.NetworkHandler;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.event.lifecycle.FMLCommonSetupEvent;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import net.minecraftforge.fml.config.ModConfig;

@Mod("botbridge")
public class BotBridgeMod {
    public BotBridgeMod() {
        FMLJavaModLoadingContext.get().getModEventBus().addListener(this::commonSetup);
        net.minecraftforge.fml.ModLoadingContext.get()
            .registerConfig(ModConfig.Type.SERVER, BotBridgeConfig.SPEC);
    }

    private void commonSetup(final FMLCommonSetupEvent event) {
        NetworkHandler.register();
    }
}
