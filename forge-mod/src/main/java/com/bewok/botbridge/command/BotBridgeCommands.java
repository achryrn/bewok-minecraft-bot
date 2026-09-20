package com.bewok.botbridge.command;

import com.bewok.botbridge.config.BotBridgeConfig;
import com.mojang.brigadier.CommandDispatcher;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraftforge.event.RegisterCommandsEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

import java.util.Set;

@Mod.EventBusSubscriber(modid = "botbridge", bus = Mod.EventBusSubscriber.Bus.FORGE)
public class BotBridgeCommands {

    @SubscribeEvent
    public static void onRegisterCommands(RegisterCommandsEvent event) {
        CommandDispatcher<CommandSourceStack> dispatcher = event.getDispatcher();

        dispatcher.register(Commands.literal("botbridge")
            .then(Commands.literal("whitelist")
                .then(Commands.literal("list")
                    .executes(ctx -> {
                        Set<String> whitelist = BotBridgeConfig.getWhitelistedBots();
                        ctx.getSource().sendSuccess(
                            () -> Component.literal("Whitelisted bots: " + String.join(", ", whitelist)),
                            false
                        );
                        return 1;
                    })
                )
            )
            .then(Commands.literal("help")
                .executes(ctx -> {
                    ctx.getSource().sendSuccess(
                        () -> Component.literal("BotBridge commands: /botbridge whitelist list"),
                        false
                    );
                    return 1;
                })
            )
        );
    }
}
