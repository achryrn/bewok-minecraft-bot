package com.bewok.botbridge.network;

import com.bewok.botbridge.network.packets.OreScanRequestPacket;
import com.bewok.botbridge.network.packets.OreScanResponsePacket;
import net.minecraft.resources.ResourceLocation;
import net.minecraftforge.network.NetworkRegistry;
import net.minecraftforge.network.simple.SimpleChannel;

public class NetworkHandler {
    private static final String PROTOCOL_VERSION = "1";

    public static final SimpleChannel CHANNEL = NetworkRegistry.newSimpleChannel(
        new ResourceLocation("botbridge", "main"),
        () -> PROTOCOL_VERSION,
        s -> true,  // accept any client (including vanilla without the mod)
        s -> true   // accept any server version
    );

    private static int packetId = 0;

    public static void register() {
        CHANNEL.messageBuilder(OreScanRequestPacket.class, packetId++)
            .encoder(OreScanRequestPacket::encode)
            .decoder(OreScanRequestPacket::decode)
            .consumerMainThread(OreScanRequestPacket::handle)
            .add();

        CHANNEL.messageBuilder(OreScanResponsePacket.class, packetId++)
            .encoder(OreScanResponsePacket::encode)
            .decoder(OreScanResponsePacket::decode)
            .consumerMainThread(OreScanResponsePacket::handle)
            .add();
    }
}
