package com.dsh.mc.link;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

/**
 * Local-only HTTP endpoint for the DSH bridge (see docs/ARCHITECTURE.md §5).
 *
 * <p>Design rules:</p>
 * <ul>
 *   <li>binds to loopback only (config validated by {@link LinkConfig});</li>
 *   <li>constant-time token compare ({@code Authorization: Bearer} or {@code X-MC-Token});
 *       {@code GET /health} is the only unauthenticated endpoint;</li>
 *   <li>every handler that touches the world is marshalled onto the server thread via
 *       {@link MinecraftServer#execute(Runnable)} and awaited with a timeout, so an HTTP thread
 *       never touches live world objects and never blocks the tick while waiting itself.</li>
 * </ul>
 */
public final class HttpBridge {
    private static final Logger LOG = LoggerFactory.getLogger("netease_mc_link");
    static final String MC_VERSION = "1.21.8";

    private static final int MAX_BODY_BYTES = 1 << 20;
    private static final long READ_TIMEOUT_MS = 10_000L;
    private static final long COMMAND_TIMEOUT_MS = 15_000L;

    private final MinecraftServer server;
    private final LinkConfig config;
    private final Api api;
    private final HttpServer http;
    private final ExecutorService executor;
    private volatile boolean running;

    HttpBridge(MinecraftServer server) throws IOException {
        this.server = server;
        this.config = LinkConfig.loadOrCreate();
        this.api = new Api(server);

        InetAddress address = InetAddress.getByName(config.bind);
        this.http = HttpServer.create(new InetSocketAddress(address, config.port), 0);
        this.executor = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "netease-mc-link-http");
            thread.setDaemon(true);
            return thread;
        });
        this.http.createContext("/", this::handle);
        this.http.setExecutor(this.executor);
        LOG.info("[netease_mc_link] token (config: {}): {}", config.file, config.token);
    }

    void start() {
        this.http.start();
        this.running = true;
        LOG.info("[netease_mc_link] listening on {}:{} (loopback only)", config.bind, config.port);
    }

    void stop() {
        this.running = false;
        this.http.stop(0);
        this.executor.shutdownNow();
    }

    String bindAddress() {
        return config.bind;
    }

    int port() {
        return config.port;
    }

    // ------------------------------------------------------------------ HTTP

    private void handle(HttpExchange exchange) {
        String method = exchange.getRequestMethod();
        String path = normalizePath(exchange.getRequestURI().getPath());
        try {
            if ("/health".equals(path)) {
                requireMethod(exchange, "GET");
                respond(exchange, 200, Json.ok(
                        "mod", NeteaseMcLink.MOD_ID,
                        "mc", MC_VERSION,
                        "port", config.port));
                return;
            }

            if (!running) {
                throw new ApiException(503, "server_not_ready", "the Minecraft server is shutting down");
            }
            authenticate(exchange);

            Map<String, String> query = parseQuery(exchange);
            switch (path) {
                case "/state" -> {
                    requireMethod(exchange, "GET");
                    String player = blankToNull(query.get("player"));
                    respond(exchange, 200, runOnServer(READ_TIMEOUT_MS, () -> api.state(player)));
                }
                case "/inventory" -> {
                    requireMethod(exchange, "GET");
                    String player = blankToNull(query.get("player"));
                    boolean includeEmpty = boolParam(query, "includeEmpty", false);
                    respond(exchange, 200, runOnServer(READ_TIMEOUT_MS,
                            () -> api.inventory(player, includeEmpty)));
                }
                case "/block" -> {
                    requireMethod(exchange, "GET");
                    int x = requiredInt(query, "x");
                    int y = requiredInt(query, "y");
                    int z = requiredInt(query, "z");
                    respond(exchange, 200, runOnServer(READ_TIMEOUT_MS, () -> api.block(x, y, z)));
                }
                case "/blocks" -> {
                    requireMethod(exchange, "GET");
                    String player = blankToNull(query.get("player"));
                    int radius = intParam(query, "radius", 8);
                    String block = blankToNull(query.get("block"));
                    int limit = intParam(query, "limit", 100);
                    respond(exchange, 200, runOnServer(READ_TIMEOUT_MS,
                            () -> api.blocks(player, radius, block, limit)));
                }
                case "/entities" -> {
                    requireMethod(exchange, "GET");
                    String player = blankToNull(query.get("player"));
                    int radius = intParam(query, "radius", 16);
                    String type = blankToNull(query.get("type"));
                    int limit = intParam(query, "limit", 100);
                    respond(exchange, 200, runOnServer(READ_TIMEOUT_MS,
                            () -> api.entities(player, radius, type, limit)));
                }
                case "/command" -> {
                    requireMethod(exchange, "POST");
                    requireCommandsAllowed();
                    JsonObject body = readBody(exchange);
                    String command = Json.requireString(body, "command");
                    respond(exchange, 200, runOnServer(COMMAND_TIMEOUT_MS, () -> api.command(command)));
                }
                case "/chat" -> {
                    requireMethod(exchange, "POST");
                    requireChatAllowed();
                    JsonObject body = readBody(exchange);
                    String message = Json.requireString(body, "message");
                    respond(exchange, 200, runOnServer(READ_TIMEOUT_MS, () -> api.chat(message)));
                }
                case "/action" -> {
                    requireMethod(exchange, "POST");
                    requireActionsAllowed();
                    JsonObject body = readBody(exchange);
                    respond(exchange, 200, runOnServer(COMMAND_TIMEOUT_MS, () -> api.action(body)));
                }
                default -> throw new ApiException(404, "not_found", "unknown endpoint: " + path);
            }
        } catch (ApiException e) {
            safeRespond(exchange, e.status, Json.error(e.code, e.getMessage()));
        } catch (Throwable t) {
            LOG.error("[netease_mc_link] unhandled error for {} {}", method, path, t);
            safeRespond(exchange, 500, Json.error("internal", String.valueOf(t)));
        } finally {
            try {
                exchange.close();
            } catch (Throwable ignored) {
                // response already written
            }
        }
    }

    private void requireCommandsAllowed() {
        if (!config.allowCommands) {
            throw new ApiException(403, "policy_denied",
                    "/command is disabled (allowCommands=false in config/netease_mc_link.json)");
        }
    }

    private void requireChatAllowed() {
        if (!config.allowChat) {
            throw new ApiException(403, "policy_denied",
                    "/chat is disabled (allowChat=false in config/netease_mc_link.json)");
        }
    }

    private void requireActionsAllowed() {
        if (!config.allowActions) {
            throw new ApiException(403, "policy_denied",
                    "/action is disabled (allowActions=false in config/netease_mc_link.json)");
        }
    }

    // --------------------------------------------------------------- on tick

    private Map<String, Object> runOnServer(long timeoutMs, Supplier<Map<String, Object>> operation) {
        MinecraftServer current = this.server;
        if (current == null || !current.isRunning()) {
            throw new ApiException(503, "server_not_ready", "the Minecraft server is not running");
        }

        CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
        current.execute(() -> {
            try {
                future.complete(operation.get());
            } catch (Throwable t) {
                future.completeExceptionally(t);
            }
        });

        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            throw new ApiException(504, "timeout",
                    "the server thread did not complete the operation within " + timeoutMs + " ms");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ApiException(500, "interrupted", "request was interrupted");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof ApiException apiException) {
                throw apiException;
            }
            throw new ApiException(500, "internal",
                    "server-side error: " + (cause == null ? "unknown" : cause.toString()), cause);
        }
    }

    // ---------------------------------------------------------------- helpers

    private void authenticate(HttpExchange exchange) {
        String provided = null;
        String authorization = exchange.getRequestHeaders().getFirst("Authorization");
        if (authorization != null) {
            String trimmed = authorization.trim();
            if (trimmed.regionMatches(true, 0, "Bearer ", 0, 7)) {
                provided = trimmed.substring(7).trim();
            }
        }
        if (provided == null) {
            provided = exchange.getRequestHeaders().getFirst("X-MC-Token");
        }
        if (provided != null) {
            provided = provided.trim();
        }

        byte[] expected = config.token.getBytes(StandardCharsets.UTF_8);
        if (provided == null || !MessageDigest.isEqual(provided.getBytes(StandardCharsets.UTF_8), expected)) {
            throw new ApiException(401, "unauthorized",
                    "missing or invalid token; send 'Authorization: Bearer <token>' or 'X-MC-Token: <token>' "
                            + "using the token from <gameDir>/config/netease_mc_link.json");
        }
    }

    private static void requireMethod(HttpExchange exchange, String expected) {
        if (!expected.equalsIgnoreCase(exchange.getRequestMethod())) {
            throw new ApiException(405, "method_not_allowed",
                    "expected " + expected + " for " + exchange.getRequestURI().getPath());
        }
    }

    private static String normalizePath(String path) {
        if (path == null || path.isEmpty()) {
            return "/";
        }
        if (path.length() > 1 && path.endsWith("/")) {
            return path.substring(0, path.length() - 1);
        }
        return path;
    }

    private static Map<String, String> parseQuery(HttpExchange exchange) {
        Map<String, String> params = new LinkedHashMap<>();
        String raw = exchange.getRequestURI().getRawQuery();
        if (raw == null || raw.isEmpty()) {
            return params;
        }
        for (String pair : raw.split("&")) {
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String key = eq < 0 ? pair : pair.substring(0, eq);
            String value = eq < 0 ? "" : pair.substring(eq + 1);
            params.put(decode(key), decode(value));
        }
        return params;
    }

    private static String decode(String value) {
        return URLDecoder.decode(value, StandardCharsets.UTF_8);
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    private static int intParam(Map<String, String> query, String key, int defaultValue) {
        String raw = query.get(key);
        if (raw == null || raw.isBlank()) {
            return defaultValue;
        }
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            throw new ApiException(400, "bad_request", "query parameter '" + key + "' must be an integer");
        }
    }

    private static int requiredInt(Map<String, String> query, String key) {
        String raw = query.get(key);
        if (raw == null || raw.isBlank()) {
            throw new ApiException(400, "bad_request", "query parameter '" + key + "' is required");
        }
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            throw new ApiException(400, "bad_request", "query parameter '" + key + "' must be an integer");
        }
    }

    private static boolean boolParam(Map<String, String> query, String key, boolean defaultValue) {
        String raw = query.get(key);
        if (raw == null || raw.isBlank()) {
            return defaultValue;
        }
        return switch (raw.trim().toLowerCase(Locale.ROOT)) {
            case "1", "true", "yes", "on" -> true;
            case "0", "false", "no", "off" -> false;
            default -> throw new ApiException(400, "bad_request",
                    "query parameter '" + key + "' must be a boolean");
        };
    }

    private JsonObject readBody(HttpExchange exchange) throws IOException {
        byte[] raw;
        try (InputStream in = exchange.getRequestBody()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > MAX_BODY_BYTES) {
                    throw new ApiException(413, "payload_too_large",
                            "request body exceeds " + MAX_BODY_BYTES + " bytes");
                }
                out.write(buffer, 0, read);
            }
            raw = out.toByteArray();
        }
        if (raw.length == 0) {
            throw new ApiException(400, "bad_request", "request body must be a JSON object");
        }
        return Json.parseObject(new String(raw, StandardCharsets.UTF_8));
    }

    private void respond(HttpExchange exchange, int status, Map<String, Object> payload) throws IOException {
        byte[] bytes = Json.GSON.toJson(payload).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private void safeRespond(HttpExchange exchange, int status, Map<String, Object> payload) {
        try {
            respond(exchange, status, payload);
        } catch (IOException e) {
            LOG.debug("[netease_mc_link] failed to write error response", e);
        }
    }
}
