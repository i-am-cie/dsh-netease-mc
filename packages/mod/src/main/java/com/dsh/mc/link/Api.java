package com.dsh.mc.link;

import com.google.gson.JsonObject;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.PlayerChatMessage;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec2;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * All world / player / command operations.
 *
 * <p><b>Threading contract:</b> every method in this class touches live server objects and MUST be
 * invoked on the server thread (see {@link HttpBridge#runOnServer}). No method here is safe to call
 * from an HTTP handler thread directly.</p>
 *
 * <p>Every API verified against 1.21.8 official-named classes (see NOTES.md for javap evidence).</p>
 */
final class Api {
    private static final int MAX_BLOCKS_RADIUS = 16;
    private static final int MAX_BLOCKS_LIMIT = 500;
    private static final int MAX_ENTITIES_RADIUS = 64;
    private static final int MAX_ENTITIES_LIMIT = 200;
    private static final int MAX_CHAT_LENGTH = 256;

    private final MinecraftServer server;

    Api(MinecraftServer server) {
        this.server = server;
    }

    // ------------------------------------------------------------------ state

    Map<String, Object> state(String playerName) {
        ServerPlayer p = requirePlayer(playerName);
        ServerLevel level = p.level();
        long dayTime = level.getDayTime();

        Map<String, Object> player = Json.map(
                "name", p.getGameProfile().getName(),
                "uuid", p.getUUID().toString(),
                "x", round(p.getX()),
                "y", round(p.getY()),
                "z", round(p.getZ()),
                "yaw", round(p.getYRot()),
                "pitch", round(p.getXRot()),
                "health", round(p.getHealth()),
                "food", p.getFoodData().getFoodLevel(),
                "gamemode", p.gameMode.getGameModeForPlayer().getSerializedName(),
                "dimension", level.dimension().location().toString(),
                "level", p.experienceLevel,
                "exp", round(p.experienceProgress));

        String weather = level.isThundering() ? "thunder" : (level.isRaining() ? "rain" : "clear");
        Map<String, Object> world = Json.map(
                "time", dayTime,
                "day", dayTime / 24000L + 1L,
                "weather", weather,
                "difficulty", server.getWorldData().getDifficulty().getSerializedName());

        List<Object> players = new ArrayList<>();
        for (ServerPlayer other : server.getPlayerList().getPlayers()) {
            players.add(Json.map(
                    "name", other.getGameProfile().getName(),
                    "x", round(other.getX()),
                    "y", round(other.getY()),
                    "z", round(other.getZ()),
                    "health", round(other.getHealth())));
        }

        return Json.ok("player", player, "world", world, "players", players);
    }

    // -------------------------------------------------------------- inventory

    Map<String, Object> inventory(String playerName, boolean includeEmpty) {
        ServerPlayer p = requirePlayer(playerName);
        Inventory inv = p.getInventory();
        List<Object> slots = new ArrayList<>();
        for (int slot = 0; slot < inv.getContainerSize(); slot++) {
            ItemStack stack = inv.getItem(slot);
            if (stack.isEmpty()) {
                if (includeEmpty) {
                    slots.add(Json.map("slot", slot, "empty", Boolean.TRUE));
                }
                continue;
            }
            Map<String, Object> item = Json.map(
                    "slot", slot,
                    "name", itemId(stack),
                    "displayName", stack.getHoverName().getString(),
                    "count", stack.getCount());
            if (stack.isDamageableItem()) {
                item.put("durability", stack.getMaxDamage() - stack.getDamageValue());
            }
            slots.add(item);
        }
        // "slots" is the primary key; "inventory" is an alias kept for bridge-side compatibility.
        return Json.ok(
                "player", p.getGameProfile().getName(),
                "slots", slots,
                "inventory", slots);
    }

    // ------------------------------------------------------------------ block

    Map<String, Object> block(int x, int y, int z) {
        ServerLevel level = defaultLevel();
        BlockPos pos = new BlockPos(x, y, z);
        BlockState state = level.getBlockState(pos);

        Map<String, Object> props = new LinkedHashMap<>();
        Map<Property<?>, Comparable<?>> values = state.getValues();
        List<Property<?>> properties = new ArrayList<>(values.keySet());
        properties.sort(Comparator.comparing((Property<?> property) -> property.getName()));
        for (Property<?> property : properties) {
            props.put(property.getName(), String.valueOf(values.get(property)));
        }

        Map<String, Object> blockEntity = null;
        BlockEntity be = level.getBlockEntity(pos);
        if (be != null) {
            ResourceLocation beId = BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(be.getType());
            blockEntity = Json.map(
                    "id", beId == null ? be.getType().toString() : beId.toString(),
                    "type", be.getType().toString());
        }

        return Json.ok(
                "x", x,
                "y", y,
                "z", z,
                "id", blockId(state),
                "properties", props,
                "solid", !state.getCollisionShape(level, pos).isEmpty(),
                "blockEntity", blockEntity);
    }

    // ----------------------------------------------------------------- blocks

    Map<String, Object> blocks(String playerName, int radius, String blockFilter, int limit) {
        ServerPlayer p = requirePlayer(playerName);
        ServerLevel level = p.level();
        BlockPos center = p.blockPosition();

        int r = clamp(radius, 1, MAX_BLOCKS_RADIUS);
        int lim = clamp(limit, 1, MAX_BLOCKS_LIMIT);
        String filter = null;
        if (blockFilter != null && !blockFilter.isBlank()) {
            filter = normalizeRegistryId(blockFilter, "block");
            if (!BuiltInRegistries.BLOCK.containsKey(ResourceLocation.parse(filter))) {
                throw new ApiException(400, "unknown_block", "unknown block id: " + blockFilter);
            }
        }

        List<Map<String, Object>> found = new ArrayList<>();
        for (int dx = -r; dx <= r; dx++) {
            for (int dy = -r; dy <= r; dy++) {
                for (int dz = -r; dz <= r; dz++) {
                    BlockPos pos = center.offset(dx, dy, dz);
                    BlockState state = level.getBlockState(pos);
                    if (state.isAir()) {
                        continue;
                    }
                    String id = blockId(state);
                    if (filter != null && !id.equals(filter)) {
                        continue;
                    }
                    found.add(Json.map(
                            "x", pos.getX(),
                            "y", pos.getY(),
                            "z", pos.getZ(),
                            "id", id,
                            "distance", round(Math.sqrt((double) dx * dx + (double) dy * dy + (double) dz * dz))));
                }
            }
        }

        found.sort(Comparator.comparingDouble((Map<String, Object> m) -> ((Number) m.get("distance")).doubleValue()));
        if (found.size() > lim) {
            found = new ArrayList<>(found.subList(0, lim));
        }
        return Json.ok(
                "blocks", found,
                "count", found.size(),
                "radius", r,
                "limit", lim,
                "block", filter);
    }

    // --------------------------------------------------------------- entities

    Map<String, Object> entities(String playerName, int radius, String typeFilter, int limit) {
        ServerPlayer self = requirePlayer(playerName);
        ServerLevel level = self.level();

        int r = clamp(radius, 1, MAX_ENTITIES_RADIUS);
        int lim = clamp(limit, 1, MAX_ENTITIES_LIMIT);
        String filter = null;
        if (typeFilter != null && !typeFilter.isBlank()) {
            filter = normalizeRegistryId(typeFilter, "entity type");
            if (!BuiltInRegistries.ENTITY_TYPE.containsKey(ResourceLocation.parse(filter))) {
                throw new ApiException(400, "unknown_entity_type", "unknown entity type: " + typeFilter);
            }
        }

        double x = self.getX();
        double y = self.getY();
        double z = self.getZ();
        AABB box = new AABB(x - r, y - r, z - r, x + r, y + r, z + r);
        final String typeFilterFinal = filter;
        List<Entity> raw = level.getEntities((Entity) null, box, e -> e != self
                && !e.isSpectator()
                && (typeFilterFinal == null || entityTypeId(e).equals(typeFilterFinal)));

        List<Map<String, Object>> out = new ArrayList<>();
        for (Entity e : raw) {
            double dx = e.getX() - x;
            double dy = e.getY() - y;
            double dz = e.getZ() - z;
            out.add(Json.map(
                    "id", e.getId(),
                    "name", e.getName().getString(),
                    "type", entityTypeId(e),
                    "x", round(e.getX()),
                    "y", round(e.getY()),
                    "z", round(e.getZ()),
                    "distance", round(Math.sqrt(dx * dx + dy * dy + dz * dz))));
        }
        out.sort(Comparator.comparingDouble((Map<String, Object> m) -> ((Number) m.get("distance")).doubleValue()));
        if (out.size() > lim) {
            out = new ArrayList<>(out.subList(0, lim));
        }
        return Json.ok("entities", out, "count", out.size(), "radius", r, "limit", lim);
    }

    // ---------------------------------------------------------------- command

    Map<String, Object> command(String command) {
        String cmd = stripSlash(command);
        if (cmd.isEmpty()) {
            throw new ApiException(400, "bad_request", "command is empty");
        }
        if (cmd.length() > 32767) {
            throw new ApiException(400, "bad_request", "command is too long");
        }

        ServerPlayer p = firstPlayerOrNull();
        ServerLevel level = p != null ? p.level() : server.overworld();
        Vec3 pos = p != null ? p.position() : Vec3.ZERO;
        Vec2 rot = p != null ? new Vec2(p.getYRot(), p.getXRot()) : Vec2.ZERO;

        List<String> output = execute(cmd, level, pos, rot);
        return Json.ok("command", cmd, "output", output);
    }

    // ------------------------------------------------------------------- chat

    Map<String, Object> chat(String message) {
        if (message == null || message.isEmpty()) {
            throw new ApiException(400, "bad_request", "'message' is required");
        }
        if (message.length() > MAX_CHAT_LENGTH) {
            throw new ApiException(400, "bad_request", "message exceeds " + MAX_CHAT_LENGTH + " characters");
        }
        ServerPlayer p = requirePlayer(null);
        String name = p.getGameProfile().getName();

        // Unsigned player chat: PlayerList#broadcastChatMessage(PlayerChatMessage, ServerPlayer, ChatType.Bound)
        // handles unsigned messages by logging "Not Secure" and delivering them (verified in bytecode).
        PlayerChatMessage chatMessage = PlayerChatMessage.unsigned(p.getUUID(), message);
        ChatType.Bound bound = ChatType.bind(ChatType.CHAT, p);
        server.getPlayerList().broadcastChatMessage(chatMessage, p, bound);
        return Json.ok("player", name, "message", message, "delivered", "chat");
    }

    // ----------------------------------------------------------------- action

    Map<String, Object> action(JsonObject body) {
        String type = Json.requireString(body, "type").trim().toLowerCase(Locale.ROOT);
        String playerName = Json.optString(body, "player");
        String cmd;

        switch (type) {
            case "tp" -> {
                ServerPlayer who = requirePlayer(playerName);
                String to = Json.optString(body, "to");
                if (to != null && !to.isBlank()) {
                    ServerPlayer target = requirePlayer(to);
                    cmd = "tp " + who.getGameProfile().getName() + " " + target.getGameProfile().getName();
                } else {
                    Double x = Json.optDouble(body, "x");
                    Double y = Json.optDouble(body, "y");
                    Double z = Json.optDouble(body, "z");
                    if (x == null || y == null || z == null) {
                        throw new ApiException(400, "bad_request",
                                "tp requires either 'to' (online player) or all of x/y/z");
                    }
                    cmd = "tp " + who.getGameProfile().getName() + " " + fmt(x) + " " + fmt(y) + " " + fmt(z);
                }
            }
            case "give" -> {
                ServerPlayer who = requirePlayer(playerName);
                ResourceLocation item = requireRegistryId(body, "item", "item", BuiltInRegistries.ITEM);
                Integer count = Json.optInt(body, "count");
                int n = count == null ? 1 : clamp(count, 1, 6400);
                cmd = "give " + who.getGameProfile().getName() + " " + item + " " + n;
            }
            case "setblock" -> {
                Double x = Json.optDouble(body, "x");
                Double y = Json.optDouble(body, "y");
                Double z = Json.optDouble(body, "z");
                if (x == null || y == null || z == null) {
                    throw new ApiException(400, "bad_request", "setblock requires x/y/z");
                }
                ResourceLocation block = requireRegistryId(body, "block", "block", BuiltInRegistries.BLOCK);
                cmd = "setblock " + fmt(x) + " " + fmt(y) + " " + fmt(z) + " " + block;
            }
            case "summon" -> {
                ResourceLocation entity = requireRegistryId(body, "entity", "entity type", BuiltInRegistries.ENTITY_TYPE);
                Double x = Json.optDouble(body, "x");
                Double y = Json.optDouble(body, "y");
                Double z = Json.optDouble(body, "z");
                if (x == null || y == null || z == null) {
                    ServerPlayer p = requirePlayer(playerName);
                    x = p.getX();
                    y = p.getY();
                    z = p.getZ();
                }
                cmd = "summon " + entity + " " + fmt(x) + " " + fmt(y) + " " + fmt(z);
            }
            case "time" -> {
                String value = Json.requireString(body, "value").trim().toLowerCase(Locale.ROOT);
                if (!value.equals("day") && !value.equals("noon") && !value.equals("night")
                        && !value.equals("midnight") && !value.matches("\\d+")) {
                    throw new ApiException(400, "bad_request",
                            "time value must be day|noon|night|midnight or a non-negative tick count");
                }
                cmd = "time set " + value;
            }
            case "weather" -> {
                String value = Json.requireString(body, "value").trim().toLowerCase(Locale.ROOT);
                if (!value.equals("clear") && !value.equals("rain") && !value.equals("thunder")) {
                    throw new ApiException(400, "bad_request", "weather value must be clear|rain|thunder");
                }
                Integer duration = Json.optInt(body, "duration");
                cmd = "weather " + value;
                if (duration != null) {
                    cmd += " " + clamp(duration, 1, 1_000_000);
                }
            }
            case "gamemode" -> {
                String value = Json.requireString(body, "value").trim().toLowerCase(Locale.ROOT);
                GameType gameType;
                try {
                    gameType = GameType.byName(value);
                } catch (IllegalArgumentException e) {
                    gameType = null;
                }
                if (gameType == null) {
                    throw new ApiException(400, "bad_request",
                            "gamemode must be survival|creative|adventure|spectator");
                }
                ServerPlayer who = requirePlayer(playerName);
                cmd = "gamemode " + gameType.getSerializedName() + " " + who.getGameProfile().getName();
            }
            case "effect" -> {
                ResourceLocation effect = requireRegistryId(body, "effect", "effect", BuiltInRegistries.MOB_EFFECT);
                Integer duration = Json.optInt(body, "duration");
                Integer amplifier = Json.optInt(body, "amplifier");
                int secs = clamp(duration == null ? 30 : duration, 1, 1_000_000);
                int amp = clamp(amplifier == null ? 0 : amplifier, 0, 255);
                ServerPlayer who = requirePlayer(playerName);
                cmd = "effect give " + who.getGameProfile().getName() + " " + effect + " " + secs + " " + amp + " true";
            }
            case "kill" -> {
                ServerPlayer who = requirePlayer(playerName);
                cmd = "kill " + who.getGameProfile().getName();
            }
            default -> throw new ApiException(400, "unsupported_action",
                    "unsupported action type '" + type + "'; expected one of "
                            + "tp|give|setblock|summon|time|weather|gamemode|effect|kill");
        }

        ServerPlayer context = firstPlayerOrNull();
        ServerLevel level = context != null ? context.level() : server.overworld();
        Vec3 pos = context != null ? context.position() : Vec3.ZERO;
        Vec2 rot = context != null ? new Vec2(context.getYRot(), context.getXRot()) : Vec2.ZERO;

        List<String> output = execute(cmd, level, pos, rot);
        return Json.ok("type", type, "command", cmd, "output", output);
    }

    // ---------------------------------------------------------------- helpers

    /**
     * Runs a command as a synthetic console source with permission level 4, capturing every
     * success/failure feedback line. Must be called on the server thread.
     */
    private List<String> execute(String command, ServerLevel level, Vec3 pos, Vec2 rot) {
        CaptureSource source = new CaptureSource();
        CommandSourceStack stack = new CommandSourceStack(
                source,
                pos,
                rot,
                level,
                4,
                "netease-mc-link",
                Component.literal("netease-mc-link"),
                server,
                null);
        server.getCommands().performPrefixedCommand(stack, command);
        return source.lines;
    }

    private ServerPlayer requirePlayer(String playerName) {
        List<ServerPlayer> players = server.getPlayerList().getPlayers();
        if (players.isEmpty()) {
            throw new ApiException(409, "no_player", "no player is currently online");
        }
        if (playerName == null || playerName.isBlank()) {
            return players.get(0);
        }
        for (ServerPlayer p : players) {
            if (p.getGameProfile().getName().equalsIgnoreCase(playerName)) {
                return p;
            }
        }
        throw new ApiException(404, "player_not_found", "no online player named '" + playerName + "'");
    }

    private ServerPlayer firstPlayerOrNull() {
        List<ServerPlayer> players = server.getPlayerList().getPlayers();
        return players.isEmpty() ? null : players.get(0);
    }

    private ServerLevel defaultLevel() {
        ServerPlayer p = firstPlayerOrNull();
        return p != null ? p.level() : server.overworld();
    }

    private static String blockId(BlockState state) {
        ResourceLocation id = BuiltInRegistries.BLOCK.getKey(state.getBlock());
        return id == null ? state.getBlock().toString() : id.toString();
    }

    private static String itemId(ItemStack stack) {
        ResourceLocation id = BuiltInRegistries.ITEM.getKey(stack.getItem());
        return id == null ? stack.getItem().toString() : id.toString();
    }

    private static String entityTypeId(Entity entity) {
        ResourceLocation id = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType());
        return id == null ? entity.getType().toString() : id.toString();
    }

    private static String normalizeRegistryId(String raw, String what) {
        if (raw == null || raw.isBlank()) {
            throw new ApiException(400, "bad_request", what + " is required");
        }
        String s = raw.trim().toLowerCase(Locale.ROOT);
        if (!s.contains(":")) {
            s = "minecraft:" + s;
        }
        ResourceLocation rl = ResourceLocation.tryParse(s);
        if (rl == null) {
            throw new ApiException(400, "bad_request", "invalid " + what + " id: " + raw);
        }
        return rl.toString();
    }

    private static ResourceLocation requireRegistryId(JsonObject body, String key, String what,
                                                      net.minecraft.core.Registry<?> registry) {
        String raw = Json.requireString(body, key);
        String normalized = normalizeRegistryId(raw, what);
        ResourceLocation rl = ResourceLocation.parse(normalized);
        if (!registry.containsKey(rl)) {
            throw new ApiException(400, "unknown_" + what.replace(' ', '_'),
                    "unknown " + what + " id: " + raw);
        }
        return rl;
    }

    private static String stripSlash(String command) {
        String cmd = command == null ? "" : command.trim();
        while (cmd.startsWith("/")) {
            cmd = cmd.substring(1);
        }
        return cmd.trim();
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static double round(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }

    private static String fmt(double value) {
        if (value == Math.rint(value) && Math.abs(value) < 1.0e15) {
            return Long.toString((long) value);
        }
        return String.format(Locale.ROOT, "%.3f", value);
    }

    /** Collects command feedback (success and failure) for {@code /command} and {@code /action}. */
    private static final class CaptureSource implements CommandSource {
        final List<String> lines = new ArrayList<>();

        @Override
        public void sendSystemMessage(Component component) {
            String line = component == null ? "" : component.getString();
            if (!line.isEmpty()) {
                lines.add(line);
            }
        }

        @Override
        public boolean acceptsSuccess() {
            return true;
        }

        @Override
        public boolean acceptsFailure() {
            return true;
        }

        @Override
        public boolean shouldInformAdmins() {
            return false;
        }
    }
}
