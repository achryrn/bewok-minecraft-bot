package com.bewok.botbridge.network.packets;

import net.minecraft.core.BlockPos;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraftforge.network.NetworkEvent;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

public class OreScanResponsePacket {
    private final List<BlockPos> positions;

    public OreScanResponsePacket(List<BlockPos> positions) {
        this.positions = positions;
    }

    public static void encode(OreScanResponsePacket packet, FriendlyByteBuf buf) {
        buf.writeVarInt(packet.positions.size());
        for (BlockPos pos : packet.positions) {
            buf.writeInt(pos.getX());
            buf.writeInt(pos.getY());
            buf.writeInt(pos.getZ());
        }
    }

    public static OreScanResponsePacket decode(FriendlyByteBuf buf) {
        int count = buf.readVarInt();
        List<BlockPos> positions = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            positions.add(new BlockPos(buf.readInt(), buf.readInt(), buf.readInt()));
        }
        return new OreScanResponsePacket(positions);
    }

    public static void handle(OreScanResponsePacket packet, Supplier<NetworkEvent.Context> ctx) {
        ctx.get().setPacketHandled(true);
    }

    public List<BlockPos> getPositions() {
        return positions;
    }
}
