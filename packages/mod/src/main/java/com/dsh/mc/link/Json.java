package com.dsh.mc.link;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;

import java.util.LinkedHashMap;
import java.util.Map;

/** Small JSON helpers shared by the mod. Gson ships with Minecraft/NeoForge. */
final class Json {
    /** Compact writer (HTTP responses). */
    static final Gson GSON = new GsonBuilder()
            .serializeNulls()
            .disableHtmlEscaping()
            .create();

    /** Pretty writer (config file). */
    static final Gson PRETTY = new GsonBuilder()
            .setPrettyPrinting()
            .serializeNulls()
            .disableHtmlEscaping()
            .create();

    private Json() {
    }

    /** Ordered string-keyed map; used for every response object. */
    static Map<String, Object> map(Object... kv) {
        if (kv.length % 2 != 0) {
            throw new IllegalArgumentException("map() needs an even number of arguments");
        }
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    static Map<String, Object> ok(Object... kv) {
        Map<String, Object> m = map(kv);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", Boolean.TRUE);
        out.putAll(m);
        return out;
    }

    static Map<String, Object> error(String code, String message) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", Boolean.FALSE);
        out.put("error", map("code", code, "message", message));
        return out;
    }

    static JsonObject parseObject(String text) {
        try {
            JsonElement el = JsonParser.parseString(text);
            if (el == null || !el.isJsonObject()) {
                throw new ApiException(400, "bad_request", "request body must be a JSON object");
            }
            return el.getAsJsonObject();
        } catch (JsonSyntaxException e) {
            throw new ApiException(400, "bad_request", "invalid JSON body: " + e.getMessage());
        }
    }

    /** Returns a string field or {@code null} when absent / JSON null. */
    static String optString(JsonObject o, String key) {
        JsonElement el = o.get(key);
        if (el == null || el.isJsonNull()) {
            return null;
        }
        return el.getAsString();
    }

    static String requireString(JsonObject o, String key) {
        String v = optString(o, key);
        if (v == null || v.isBlank()) {
            throw new ApiException(400, "bad_request", "'" + key + "' is required");
        }
        return v;
    }

    static Double optDouble(JsonObject o, String key) {
        JsonElement el = o.get(key);
        if (el == null || el.isJsonNull()) {
            return null;
        }
        try {
            return el.getAsDouble();
        } catch (RuntimeException e) {
            throw new ApiException(400, "bad_request", "'" + key + "' must be a number");
        }
    }

    static Integer optInt(JsonObject o, String key) {
        Double d = optDouble(o, key);
        return d == null ? null : (int) Math.floor(d);
    }

    static Boolean optBoolean(JsonObject o, String key) {
        JsonElement el = o.get(key);
        if (el == null || el.isJsonNull()) {
            return null;
        }
        try {
            return el.getAsBoolean();
        } catch (RuntimeException e) {
            throw new ApiException(400, "bad_request", "'" + key + "' must be a boolean");
        }
    }
}
