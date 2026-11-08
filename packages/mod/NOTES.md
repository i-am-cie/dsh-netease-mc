# packages/mod — 实现笔记（NeoForge 21.8.52 / MC 1.21.8）

本目录是通道 B（游戏内 HTTP 桥）的 NeoForge 模组实现。

- modId：`netease_mc_link`
- 版本：`1.0.0`
- jar：`build/netease-mc-link-1.0.0.jar`
- Java 包：`com.dsh.mc.link`
- 契约：`docs/ARCHITECTURE.md` 第 5 节（HTTP 契约唯一真源）

## 1. 构建方式（无 Gradle、无网络）

本机没有 Gradle，且 `maven.neoforged.net` 会超时。所有编译依赖都已存在于游戏实例目录中，
因此 `build.ps1` 直接调用本机 JDK 22 的 `javac` 编译并打包：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packages\mod\build.ps1
# 或用 -GameDir / -JdkHome 覆盖默认路径
powershell -NoProfile -ExecutionPolicy Bypass -File packages\mod\build.ps1 -GameDir 'D:\netease_minecraft_neoforge'
```

脚本流程：定位 JDK22 → 定位官方命名的 Minecraft 类 jar → 收集 `libraries\**\*.jar` 生成
classpath（178 项）→ `javac --release 21` → 合并 `src/main/resources` → `jar --create` →
校验 jar 内 `META-INF/neoforge.mods.toml`、`META-INF/MANIFEST.MF`、6 个 class 是否存在且
toml 中 `modId`/`version` 正确 → 打印 SHA-256。

**JDK 工具链**：`D:\MCLDownload\ext\jre-v64-220420\jdk22\bin\javac.exe`（javac 22）。
产物 class major version = 65（Java 21 字节码，`--release 21`），游戏运行时 Java 22 可直接加载。

## 2. 编译期 javap 核对证据

> 所有 API 均先用 `javap` 核对 1.21.8 真实签名后才写代码，不凭记忆。以下为实际输出摘录。

### 2.1 事件类（NeoForge 21.8.52）

`neoforge-21.8.52-universal.jar` 内实际路径：

```text
net/neoforged/neoforge/event/server/ServerStartedEvent.class
net/neoforged/neoforge/event/server/ServerStoppingEvent.class
```

```text
$ javap -classpath ... net.neoforged.neoforge.event.server.ServerStartedEvent
public class net.neoforged.neoforge.event.server.ServerStartedEvent
        extends net.neoforged.neoforge.event.server.ServerLifecycleEvent {
  public net.neoforged.neoforge.event.server.ServerStartedEvent(net.minecraft.server.MinecraftServer);
}

$ javap -classpath ... net.neoforged.neoforge.event.server.ServerStoppingEvent
public class net.neoforged.neoforge.event.server.ServerStoppingEvent
        extends net.neoforged.neoforge.event.server.ServerLifecycleEvent { ... }

$ javap -classpath ... net.neoforged.neoforge.event.server.ServerLifecycleEvent
public net.minecraft.server.MinecraftServer getServer();
```

事件总线（`bus-8.0.5.jar` / `neoforge-universal.jar`）：

```text
$ javap net.neoforged.neoforge.common.NeoForge
public static final net.neoforged.bus.api.IEventBus EVENT_BUS;

$ javap net.neoforged.bus.api.IEventBus
public <T extends net.neoforged.bus.api.Event> void addListener(java.lang.Class<T>, java.util.function.Consumer<T>);
```

模组注解（`loader-9.0.18.jar`）：

```text
$ javap net.neoforged.fml.common.Mod
public interface net.neoforged.fml.common.Mod extends java.lang.annotation.Annotation {
  public abstract java.lang.String value();
  public abstract net.neoforged.api.distmarker.Dist[] dist();
}
```

构造器注入规则：`FMLModContainer.constructMod()` 字节码只允许 **恰好一个 public 构造器**，
支持参数类型 `IEventBus` / `ModContainer` / `FMLModContainer` / `Dist`。因此无参 public 构造器也合法
（本项目采用无参构造器 + 在构造器内 `NeoForge.EVENT_BUS.addListener(...)`）。

### 2.2 服务器线程调度

```text
$ javap net.minecraft.util.thread.BlockableEventLoop
public void execute(java.lang.Runnable);
public void executeIfPossible(java.lang.Runnable);
public <V> java.util.concurrent.CompletableFuture<V> submit(java.util.function.Supplier<V>);

$ javap net.minecraft.server.MinecraftServer
（继承自 ReentrantBlockableEventLoop<TickTask>，故具备 execute(Runnable)）
public boolean isRunning();
public net.minecraft.server.players.PlayerList getPlayerList();
public net.minecraft.commands.Commands getCommands();
public net.minecraft.commands.CommandSourceStack createCommandSourceStack();
public final net.minecraft.server.level.ServerLevel overworld();
public net.minecraft.world.level.storage.WorldData getWorldData();
```

实现：HTTP 线程只做 JSON/参数解析，所有世界访问通过
`server.execute(() -> ...)`（`CompletableFuture` 回传 + 超时）投递到服务器线程；HTTP 线程绝不直接
调用世界对象，也不在 tick 线程里做长任务。

### 2.3 命令执行与输出捕获

```text
$ javap net.minecraft.commands.CommandSourceStack
public net.minecraft.commands.CommandSourceStack(net.minecraft.commands.CommandSource,
    net.minecraft.world.phys.Vec3, net.minecraft.world.phys.Vec2,
    net.minecraft.server.level.ServerLevel, int, java.lang.String,
    net.minecraft.network.chat.Component, net.minecraft.server.MinecraftServer,
    net.minecraft.world.entity.Entity);
public net.minecraft.commands.CommandSourceStack withLevel(net.minecraft.server.level.ServerLevel);
public net.minecraft.commands.CommandSourceStack withPosition(net.minecraft.world.phys.Vec3);
public net.minecraft.commands.CommandSourceStack withRotation(net.minecraft.world.phys.Vec2);

$ javap net.minecraft.commands.CommandSource
public abstract void sendSystemMessage(net.minecraft.network.chat.Component);
public abstract boolean acceptsSuccess();
public abstract boolean acceptsFailure();
public abstract boolean shouldInformAdmins();

$ javap net.minecraft.commands.Commands
public void performPrefixedCommand(net.minecraft.commands.CommandSourceStack, java.lang.String);
```

实现：构造一个匿名的 `CommandSource`（收集 `sendSystemMessage` 文本，`acceptsSuccess/Failure=true`），
再用 `new CommandSourceStack(source, pos, rot, level, 4 /* 权限 4 = 控制台级 */, "netease-mc-link",
Component.literal("netease-mc-link"), server, null)` 执行命令。`/command`、`/action` 都走这条路径，
返回捕获到的 `output`。**注意**：`performPrefixedCommand` 返回 `void`，且执行期的失败（如目标不存在）
也会以 feedback 文本进入 `output`；因此 HTTP 层 `ok:true` 只表示"命令被受理并执行"，命令本身的
失败信息在 `output` 里（见 §5 风险）。

### 2.4 读状态 / 玩家 / 世界

```text
$ javap net.minecraft.server.level.ServerPlayer
public net.minecraft.server.level.ServerLevel level();          // 协变返回 ServerLevel
public net.minecraft.commands.CommandSourceStack createCommandSourceStack();
public net.minecraft.server.level.ServerPlayerGameMode gameMode; // public 字段

$ javap net.minecraft.server.level.ServerPlayerGameMode
public net.minecraft.world.level.GameType getGameModeForPlayer();

$ javap net.minecraft.world.entity.player.Player
public com.mojang.authlib.GameProfile getGameProfile();
public net.minecraft.world.entity.player.Inventory getInventory();
public net.minecraft.world.food.FoodData getFoodData();
public int experienceLevel;        // public 字段
public float experienceProgress;   // public 字段（没有 getter）

$ javap net.minecraft.world.level.Level
public long getDayTime();
public boolean isRaining();
public boolean isThundering();
public net.minecraft.resources.ResourceKey<net.minecraft.world.level.Level> dimension();
public net.minecraft.world.level.block.state.BlockState getBlockState(net.minecraft.core.BlockPos);
public net.minecraft.world.level.block.entity.BlockEntity getBlockEntity(net.minecraft.core.BlockPos);

$ javap net.minecraft.world.level.storage.WorldData
public abstract net.minecraft.world.Difficulty getDifficulty();
```

**坑**：`Level` **没有** `getDifficulty()`；难度在 `MinecraftServer#getWorldData().getDifficulty()`。
`Dimension` 用 `level.dimension().location().toString()`（`ResourceKey#location()`）。

### 2.5 方块 / 实体

```text
$ javap net.minecraft.world.level.block.state.BlockBehaviour$BlockStateBase
public net.minecraft.world.level.block.Block getBlock();
public net.minecraft.core.Holder<net.minecraft.world.level.block.Block> getBlockHolder();
public boolean isSolid();          // 1.21.8 已标记 @Deprecated（见 §5）——实现改用碰撞形状判断
public boolean isAir();

$ javap net.minecraft.world.level.block.state.StateHolder
public java.util.Map<Property<?>, java.lang.Comparable<?>> getValues();  // BlockState 的属性表

$ javap net.minecraft.world.level.block.entity.BlockEntity
public net.minecraft.world.level.block.entity.BlockEntityType<?> getType();

$ javap net.minecraft.core.Registry
public abstract net.minecraft.resources.ResourceLocation getKey(T);
public abstract boolean containsKey(net.minecraft.resources.ResourceLocation);

$ javap net.minecraft.core.registries.BuiltInRegistries
BLOCK / ITEM / ENTITY_TYPE / BLOCK_ENTITY_TYPE / MOB_EFFECT 均为 Registry

$ javap net.minecraft.world.phys.AABB
public net.minecraft.world.phys.AABB(double, double, double, double, double, double);

$ javap net.minecraft.world.level.Level
public java.util.List<net.minecraft.world.entity.Entity> getEntities(
    net.minecraft.world.entity.Entity, net.minecraft.world.phys.AABB,
    java.util.function.Predicate<? super net.minecraft.world.entity.Entity>);
```

`/block` 的 `solid` 语义：`BlockState#isSolid()` 在 1.21.8 已过时，改用
`!state.getCollisionShape(level, pos).isEmpty()`（碰撞形状非空即实体阻挡），语义等价且无过时警告。

### 2.6 聊天（以玩家身份发言）

```text
$ javap net.minecraft.network.chat.PlayerChatMessage
public static net.minecraft.network.chat.PlayerChatMessage unsigned(java.util.UUID, java.lang.String);
public boolean hasSignature();

$ javap net.minecraft.network.chat.ChatType
public static net.minecraft.network.chat.ChatType$Bound bind(
    net.minecraft.resources.ResourceKey<net.minecraft.network.chat.ChatType>,
    net.minecraft.world.entity.Entity);
public static final net.minecraft.resources.ResourceKey<net.minecraft.network.chat.ChatType> CHAT;

$ javap net.minecraft.server.players.PlayerList
public void broadcastChatMessage(net.minecraft.network.chat.PlayerChatMessage,
    net.minecraft.server.level.ServerPlayer, net.minecraft.network.chat.ChatType$Bound);
```

`PlayerList` 私有实现里 `verifyChatTrusted(message)` 只影响日志里是否标记 "Not Secure"，未签名消息
仍会被广播（`javap -p -c` 已确认），因此用 `PlayerChatMessage.unsigned(uuid, msg)` +
`ChatType.bind(ChatType.CHAT, player)` + `broadcastChatMessage` 实现"以玩家身份发言"，聊天栏显示为
真实的 `<玩家名> 消息`。副作用是服务器日志会将该条消息记录为 unsigned/"Not Secure"。

### 2.7 配置目录与 JDK 内置 HTTP 服务器

```text
$ javap net.neoforged.fml.loading.FMLPaths     // loader-9.0.18.jar
public static final net.neoforged.fml.loading.FMLPaths GAMEDIR;
public static final net.neoforged.fml.loading.FMLPaths CONFIGDIR;
public java.nio.file.Path get();
```

HTTP 使用 JDK 自带的 `com.sun.net.httpserver.HttpServer`（`jdk.httpserver` 模块，JDK 22 内置，
无额外依赖、无需联网），已用 `javac --release 21` 实测可编译。监听地址来自配置，且配置层强制
只接受 loopback（`127.0.0.1` / `localhost` / `::1`），否则回落 `127.0.0.1` 并写日志。

## 3. 交付物

```text
packages/mod/
  build.ps1
  README.md
  NOTES.md
  src/main/java/com/dsh/mc/link/
    NeteaseMcLink.java   @Mod 入口 / 事件注册 / 生命周期
    LinkConfig.java      config/netease_mc_link.json（token 生成、端口、开关）
    HttpBridge.java      HttpServer、鉴权、路由、server 线程调度
    Api.java             状态/背包/方块/实体/命令/聊天/动作的全部实现
    Json.java            Gson 封装与响应结构
    ApiException.java    错误码 ↔ HTTP 状态
  src/main/resources/META-INF/neoforge.mods.toml
  build/netease-mc-link-1.0.0.jar   （构建产物）
```

`neoforge.mods.toml` 的 `loaderVersion="[3,)"` 取自 `neoforge-21.8.52-universal.jar` 内自带的
`META-INF/neoforge.mods.toml`（NeoForge 自身声明 `loaderVersion="[3,]"`），依赖声明
`neoforge [21.8,)`、`minecraft [1.21.8]`。

## 4. 关键实现决策

| 主题 | 决策 |
|---|---|
| 事件 | `ServerStartedEvent` 启动 HTTP；`ServerStoppingEvent` 停止。单机退世界/再进世界可重复启停。 |
| 端口 | 默认 `127.0.0.1:38210`；`config/netease_mc_link.json` 的 `port`/`bind` 可改；端口占用只记 error 不影响游戏。 |
| Token | 首次启动生成 32 字节随机十六进制 token，写入 config 并打印到游戏日志；请求需 `Authorization: Bearer <token>` 或 `X-MC-Token: <token>`；`/health` 免鉴权。 |
| 线程 | 所有世界访问经 `MinecraftServer#execute` + `CompletableFuture.get(timeout)`；读 10s、命令/动作 15s，超时返回 HTTP 504 `timeout`。 |
| 权限 | 命令用权限等级 4 的合成 `CommandSourceStack`（控制台级）；玩家/坐标上下文取当前在线玩家，无玩家时用主世界原点。 |
| 错误 | 统一 `{ok:false,error:{code,message}}`；错误码含 `unauthorized`(401)、`not_found`(404)、`method_not_allowed`(405)、`bad_request`(400)、`unknown_block`/`unknown_item`/`unknown_entity_type`/`unknown_effect`、`player_not_found`(404)、`no_player`(409)、`policy_denied`(403)、`server_not_ready`(503)、`timeout`(504)、`payload_too_large`(413)、`unsupported_action`、`internal`(500)。 |
| 可配置开关 | `allowCommands` / `allowChat` / `allowActions`（默认 true）。 |
| 背包 | `slots` 为主键，同时提供 `inventory` 别名（同一数组），便于 bridge 两种字段名都能读到。 |
| 附近方块 | 默认半径 8、上限 16；跳过空气；按距离升序；上限 500。 |
| 附近实体 | 默认半径 16、上限 64；排除自己与旁观者；按距离升序；上限 200。 |
| `/block` 维度 | 无 dimension 参数：取第一个在线玩家所在维度，无玩家时主世界（契约未定义维度参数）。 |

## 5. 遇到的坑与未验证项（重要）

### 坑

1. **磁盘上的 `versions\1.21.8\1.21.8.jar` 不是官方命名**。
   `javap -classpath versions\1.21.8\1.21.8.jar net.minecraft.server.MinecraftServer` 显示
   `extends bwc<anb>`、方法名为 `a/b/u()` 等（混淆/SRG 成员名）。真正的 Mojang 官方命名
   （`getPlayerList()`、`execute()`、`createCommandSourceStack()`）在
   `libraries\net\minecraft\client\1.21.8-20250717.133445\client-1.21.8-20250717.133445-srg.jar` 中
   （文件名带 `-srg` 但成员名是官方名，NeoForge 21.8.52 运行时即使用这套名字）。
   `build.ps1` 因此：
   - 把 `*-srg.jar` 放在 classpath 第一位；
   - 排除 `*-slim.jar`（混淆）和 `versions\1.21.8\1.21.8.jar`（未加入 classpath），避免同名类被错误解析。
2. **javac @argfile 在 Windows 上会把 `\` 当转义符**。最初 argfile 里写
   `C:\Users\...\Api.java`，javac 报 `找不到文件: C:Users18744...`。解决：argfile 中所有路径
   统一替换为 `/`（`C:/Users/...`），classpath 同样处理。
3. **classpath 中的 MIXIN 注解处理器会被自动启用**，产生 `SpongePowered MIXIN Annotation Processor`
   噪音。构建加 `-proc:none`（本项目不用 mixin）。
4. **`BlockState#isSolid()` 在 1.21.8 已 @Deprecated**；改用碰撞形状判断（见 §2.5）。
5. **`Level` 没有 `getDifficulty()`**，难度从 `WorldData` 取（见 §2.4）。
6. **`CommandSourceStack#sendSuccess/sendFailure` 最终都落到 `CommandSource#sendSystemMessage`**，
   所以无法仅靠自定义 `CommandSource` 区分命令成功/失败；`/command` 的 `ok` 语义见下。

### 未验证项（须由 Lead 真机验证）

- **本模组未在真机加载验证**。本次交付只保证：用本机 JDK22 + 游戏实例现有 jar 编译通过、
  jar 结构/metadata 校验通过、`jdeps --missing-deps` 无缺失依赖；未启动游戏、未验证 NeoForge
  实际加载与 HTTP 端点行为。
- 真机上需确认：模组被加载（日志出现 `[netease_mc_link] v1.0.0 constructing` 与
  `listening on 127.0.0.1:38210`）；`config/netease_mc_link.json` 生成；`curl /health` 与
  `curl -H "X-MC-Token: ..." /state` 可用；网易客户端是否拦截第三方 NeoForge 模组（ARCHITECTURE §2
  已声明无官方保证）。
- `/command` 的 `ok:true` 表示命令被受理；命令语法/执行错误会以文本出现在 `output` 数组中。
  若 bridge 需要严格的成功/失败区分，可在 bridge 侧预校验命令或后续在模组侧解析一次 dispatcher。
- 单机游戏处于暂停菜单时，服务器 tick 可能被挂起，此时依赖 `execute` 的端点会返回 504 `timeout`；
  `/health` 不受影响（不访问服务器线程）。以真机行为为准。
- `PlayerChatMessage.unsigned` 在部分开启聊天签名校验的服务器配置下可能被过滤；本模组面向本地
  单机/局域网联机实例，未在严格签名服务器验证。
- NeoForge 21.8.52 是否接受 `loaderVersion="[3,)"` 已按 NeoForge 自身 toml 对齐，但仍以真机加载日志为准。
