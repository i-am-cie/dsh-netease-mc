package com.dsh.mc.link;

import com.google.gson.JsonObject;
import net.neoforged.fml.loading.FMLPaths;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.HexFormat;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Loads/creates {@code <gameDir>/config/netease_mc_link.json}.
 *
 * <p>First launch: generates a 32-byte random token and writes it next to the game config so the
 * bridge (packages/bridge) can read it. The token is also printed to the game log.</p>
 */
final class LinkConfig {
    private static final Logger LOG = LoggerFactory.getLogger("netease_mc_link");
    static final String FILE_NAME = "netease_mc_link.json";

    static final int DEFAULT_PORT = 38210;
    static final String DEFAULT_BIND = "127.0.0.1";

    private static final Pattern TOKEN_PATTERN = Pattern.compile("[0-9a-fA-F]{16,128}");
    private static final Pattern BIND_PATTERN = Pattern.compile(
            "127\\.0\\.0\\.1|localhost|::1|0:0:0:0:0:0:0:1");

    final int port;
    final String bind;
    final String token;
    final boolean allowCommands;
    final boolean allowChat;
    final boolean allowActions;
    final Path file;

    private LinkConfig(int port, String bind, String token,
                       boolean allowCommands, boolean allowChat, boolean allowActions, Path file) {
        this.port = port;
        this.bind = bind;
        this.token = token;
        this.allowCommands = allowCommands;
        this.allowChat = allowChat;
        this.allowActions = allowActions;
        this.file = file;
    }

    static LinkConfig loadOrCreate() throws IOException {
        Path dir = FMLPaths.CONFIGDIR.get();
        Files.createDirectories(dir);
        Path file = dir.resolve(FILE_NAME);

        JsonObject obj = new JsonObject();
        boolean existed = Files.exists(file);
        boolean rewrite = false;

        if (existed) {
            try {
                String text = Files.readString(file, StandardCharsets.UTF_8);
                if (!text.isBlank()) {
                    JsonObject parsed = Json.parseObject(text);
                    obj = parsed;
                }
            } catch (Throwable t) {
                Path backup = file.resolveSibling(FILE_NAME + ".broken-"
                        + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")));
                try {
                    Files.move(file, backup);
                } catch (IOException ignored) {
                    // best effort only
                }
                LOG.warn("[netease_mc_link] config file was unreadable ({}); backed up to {} and regenerating defaults",
                        t.toString(), backup);
                obj = new JsonObject();
                rewrite = true;
            }
        }

        Integer portCfg = optInt(obj, "port");
        int port = portCfg == null ? DEFAULT_PORT : portCfg;
        if (port < 1 || port > 65535) {
            LOG.warn("[netease_mc_link] invalid port {} in config; falling back to {}", port, DEFAULT_PORT);
            port = DEFAULT_PORT;
            rewrite = true;
        }

        String bind = optString(obj, "bind");
        if (bind == null || bind.isBlank()) {
            bind = DEFAULT_BIND;
            rewrite = true;
        } else if (!BIND_PATTERN.matcher(bind.trim().toLowerCase(Locale.ROOT)).matches()) {
            LOG.warn("[netease_mc_link] refusing non-loopback bind '{}'; forcing {}", bind, DEFAULT_BIND);
            bind = DEFAULT_BIND;
            rewrite = true;
        }

        String token = optString(obj, "token");
        if (token == null || !TOKEN_PATTERN.matcher(token.trim()).matches()) {
            token = HexFormat.of().formatHex(randomBytes(32));
            LOG.warn("[netease_mc_link] generated a new API token (first run or invalid config)");
            rewrite = true;
        }

        Boolean cmds = optBoolean(obj, "allowCommands");
        Boolean chat = optBoolean(obj, "allowChat");
        Boolean acts = optBoolean(obj, "allowActions");
        boolean allowCommands = cmds == null || cmds;
        boolean allowChat = chat == null || chat;
        boolean allowActions = acts == null || acts;
        if (cmds == null) {
            rewrite = true;
        }
        if (chat == null) {
            rewrite = true;
        }
        if (acts == null) {
            rewrite = true;
        }

        JsonObject out = new JsonObject();
        out.addProperty("port", port);
        out.addProperty("bind", bind);
        out.addProperty("token", token);
        out.addProperty("allowCommands", allowCommands);
        out.addProperty("allowChat", allowChat);
        out.addProperty("allowActions", allowActions);
        out.addProperty("_comment", "Local-only HTTP bridge for dsh-netease-mc. Keep this token secret; "
                + "it grants console-level control of the running Minecraft server.");

        if (rewrite || !existed) {
            String json = Json.PRETTY.toJson(out);
            Files.writeString(file, json + System.lineSeparator(), StandardCharsets.UTF_8);
            LOG.info("[netease_mc_link] wrote config to {}", file);
        }

        return new LinkConfig(port, bind, token, allowCommands, allowChat, allowActions, file);
    }

    private static byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        new java.security.SecureRandom().nextBytes(b);
        return b;
    }

    private static String optString(JsonObject o, String key) {
        try {
            return Json.optString(o, key);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static Integer optInt(JsonObject o, String key) {
        try {
            return Json.optInt(o, key);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static Boolean optBoolean(JsonObject o, String key) {
        try {
            return Json.optBoolean(o, key);
        } catch (RuntimeException e) {
            return null;
        }
    }
}
