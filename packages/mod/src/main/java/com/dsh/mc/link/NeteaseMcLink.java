package com.dsh.mc.link;

import net.minecraft.server.MinecraftServer;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * NeoForge entry point for the in-game HTTP bridge (通道 B).
 *
 * <p>Wiring verified against NeoForge 21.8.52 / MC 1.21.8:
 * <ul>
 *   <li>events: {@code net.neoforged.neoforge.event.server.ServerStartedEvent} /
 *       {@code ServerStoppingEvent} (both extend {@code ServerLifecycleEvent#getServer()})</li>
 *   <li>bus: {@code net.neoforged.neoforge.common.NeoForge.EVENT_BUS.addListener(Class, Consumer)}</li>
 * </ul>
 * The HTTP server only starts once a world/server exists and stops on server shutdown so that
 * entering/leaving a world is safe.
 */
@Mod(NeteaseMcLink.MOD_ID)
public final class NeteaseMcLink {
    public static final String MOD_ID = "netease_mc_link";
    public static final String VERSION = "1.0.0";
    private static final Logger LOG = LoggerFactory.getLogger("netease_mc_link");

    private volatile HttpBridge bridge;

    public NeteaseMcLink() {
        LOG.info("[netease_mc_link] v{} constructing (MC 1.21.8 / NeoForge 21.8.x)", VERSION);
        IEventBus bus = NeoForge.EVENT_BUS;
        bus.addListener(ServerStartedEvent.class, this::onServerStarted);
        bus.addListener(ServerStoppingEvent.class, this::onServerStopping);
    }

    private void onServerStarted(ServerStartedEvent event) {
        MinecraftServer server = event.getServer();
        synchronized (this) {
            stopBridge("restart");
            try {
                HttpBridge started = new HttpBridge(server);
                started.start();
                this.bridge = started;
                LOG.info("[netease_mc_link] HTTP bridge listening on http://{}:{}",
                        started.bindAddress(), started.port());
            } catch (Throwable t) {
                LOG.error("[netease_mc_link] failed to start HTTP bridge; the game keeps running without it. "
                        + "Check config/netease_mc_link.json (port may be in use).", t);
            }
        }
    }

    private void onServerStopping(ServerStoppingEvent event) {
        synchronized (this) {
            stopBridge("server stopping");
        }
    }

    private void stopBridge(String reason) {
        HttpBridge b = this.bridge;
        if (b != null) {
            this.bridge = null;
            try {
                b.stop();
                LOG.info("[netease_mc_link] HTTP bridge stopped ({})", reason);
            } catch (Throwable t) {
                LOG.warn("[netease_mc_link] error while stopping HTTP bridge", t);
            }
        }
    }
}
