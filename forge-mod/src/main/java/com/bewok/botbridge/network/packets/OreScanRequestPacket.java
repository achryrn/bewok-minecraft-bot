package com.bewok.botbridge.network.packets;

import com.bewok.botbridge.config.BotBridgeConfig;
import com.bewok.botbridge.network.NetworkHandler;
import net.minecraft.core.BlockPos;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraftforge.network.NetworkEvent;
import net.minecraftforge.registries.ForgeRegistries;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.function.Supplier;

public class OreScanRequestPacket {
    private final String oreId;
    private final int centerX;
    private final int centerY;
    private final int centerZ;
    private final int radius;

    public OreScanRequestPacket(String oreId, int centerX, int centerY, int centerZ, int radius) {
        this.oreId = oreId;
        this.centerX = centerX;
        this.centerY = centerY;
        this.centerZ = centerZ;
        this.radius = radius;
    }

    public static void encode(OreScanRequestPacket packet, FriendlyByteBuf buf) {
        buf.writeUtf(packet.oreId);
        buf.writeInt(packet.centerX);
        buf.writeInt(packet.centerY);
        buf.writeInt(packet.centerZ);
        buf.writeVarInt(packet.radius);
    }

    public static OreScanRequestPacket decode(FriendlyByteBuf buf) {
        return new OreScanRequestPacket(
            buf.readUtf(),
            buf.readInt(),
            buf.readInt(),
            buf.readInt(),
            buf.readVarInt()
        );
    }

    public static void handle(OreScanRequestPacket packet, Supplier<NetworkEvent.Context> ctx) {
        ctx.get().enqueueWork(() -> {
            ServerPlayer player = ctx.get().getSender();
            if (player == null) return;
            ServerLevel level = player.serverLevel();

            int radius = Math.min(packet.radius, BotBridgeConfig.getOreScanMaxRadius());
            BlockPos center = new BlockPos(packet.centerX, packet.centerY, packet.centerZ);
            Block targetBlock = ForgeRegistries.BLOCKS.getValue(new ResourceLocation(packet.oreId));
            if (targetBlock == null || targetBlock == net.minecraft.world.level.block.Blocks.AIR) return;

            List<BlockPos> found = new ArrayList<>();
            int chunkRadius = (radius >> 4) + 1;
            int centerChunkX = center.getX() >> 4;
            int centerChunkZ = center.getZ() >> 4;

            for (int cx = -chunkRadius; cx <= chunkRadius; cx++) {
                for (int cz = -chunkRadius; cz <= chunkRadius; cz++) {
                    LevelChunk chunk = level.getChunk(centerChunkX + cx, centerChunkZ + cz);
                    int worldX = (centerChunkX + cx) * 16;
                    int worldZ = (centerChunkZ + cz) * 16;
                    for (int dx = 0; dx < 16; dx++) {
                        for (int dz = 0; dz < 16; dz++) {
                            for (int y = level.getMinBuildHeight(); y < level.getMaxBuildHeight(); y++) {
                                BlockPos pos = new BlockPos(worldX + dx, y, worldZ + dz);
                                if (level.getBlockState(pos).getBlock() == targetBlock) {
                                    if (pos.distSqr(center) <= (double) radius * radius) {
                                        found.add(pos);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            found.sort(java.util.Comparator.comparingDouble(p -> p.distSqr(center)));
            List<BlockPos> capped = found.size() > 256 ? found.subList(0, 256) : found;

            NetworkHandler.CHANNEL.send(
                net.minecraftforge.network.PacketDistributor.PLAYER.with(() -> player),
                new OreScanResponsePacket(capped)
            );
        });
        ctx.get().setPacketHandled(true);
    }
}
