# 用浏览器启动参数榨取核显性能

针对这台机器：**Intel UHD Graphics（核显）**，`ANGLE/Direct3D11`，驱动 31.0.101.4502。
实测结论：这个场景的帧数几乎全部卡在**像素填充率**上，AO 一项就占 ~45%，所以浏览器层的目标是
「让合成和 WebGL 都真的走 GPU + 换一个更快的图形后端」。

## 一键启动

```
双击 tools\run-hw.bat
```

或者带参数：

| 命令 | 含义 |
|---|---|
| `tools\run-hw.bat` | 默认 `--use-angle=vulkan` |
| `tools\run-hw.bat d3d11` | 用 D3D11 后端（更稳，兼容性最好） |
| `tools\run-hw.bat none` | 不加 `--use-angle`，用浏览器默认值（对照组） |

脚本会：自动找 Chrome（没有就用 Edge）→ 用一个**独立 profile** 启动 → 直接打开
`http://127.0.0.1:5173/`。独立 profile 的好处是参数一定生效，也不会干扰你日常的浏览器窗口。

## 用到的参数

| 参数 | 作用 | 在核显上的预期 |
|---|---|---|
| `--use-angle=vulkan` | 走 Vulkan 而不是 D3D11 的 ANGLE 转换层 | 常见 +5~15%（Intel 核显上驱动路径更短） |
| `--enable-zero-copy` | 合成阶段少一次显存拷贝 | +3~8%，4K 下更明显 |
| `--enable-gpu-rasterization` | 页面合成交给 GPU，而不是 CPU 光栅化 | 减少 UI/HUD 的 CPU 占用 |
| `--ignore-gpu-blocklist` | 驱动被列进 blocklist 时也强制开硬件加速 | 避免悄悄掉回软件渲染 |
| `--user-data-dir=...` | 独立配置目录 | 不是性能参数，是为了让上面几条稳定生效 |

没有加的：`--disable-frame-rate-limit`（会解除 60 帧上限，测极限帧数用，平时开反而发热）、
`--disable-gpu-vsync`（同上）。

## 怎么验证真的生效

1. 新开的窗口里访问 `chrome://gpu`（Edge 是 `edge://gpu`）
2. 看 **Graphics Feature Status**：`Compositing`、`WebGL`、`WebGL2` 都应该是
   `Hardware accelerated`
3. 看 **GL_RENDERER**：应该出现 `ANGLE (Intel, Vulkan ...)`；如果变成
   `SwiftShader` / `llvmpipe`，说明掉了软件渲染，换成 `d3d11` 再试
4. 回到游戏页面，左下角 HUD 显示 `FPS` 和 `画质`；`window.__gpu` 里也能读到渲染器字符串

## 怎么对比

依次跑 `run-hw.bat none` → `d3d11` → `vulkan`，每次进游戏站同一个位置看 HUD 的 FPS：

| 后端 | FPS（1400×800，高画质，AO 全开） |
|---|---|
| 默认 | 以你实测为准 |
| d3d11 | — |
| vulkan | — |

选最快的那一档，以后就用它启动。

## 如果游戏跑在 DSH 桌面应用里

那就不是 Chrome 的参数，而是 **DSH 快捷方式的目标**后面追加同样的参数，例如：

```
"...\DeepSeek Harness.exe" --use-angle=vulkan --enable-zero-copy --enable-gpu-rasterization --ignore-gpu-blocklist
```

改完完全退出应用再启动才会生效。

## 别忘了游戏内的两个真正杠杆

浏览器参数最多再要 10~15%；这台核显上真正有效的是：

```
?q=high&ao=half     AO 半分辨率：19 → 25 fps（推荐默认）
?q=high&ao=0        AO 全关：19 → 33 fps（画面变平）
?res=0.8            内部分辨率 0.8 倍：约 +25%，配合 FXAA 损失小于关 AO
```

## 回滚

关掉那个窗口即可；参数只对本次启动的进程有效，`tools\run-hw.bat` 删掉也不会影响项目。
独立 profile 目录在 `%LOCALAPPDATA%\souls-demo-hw-profile`，想清干净直接删这个文件夹。

---

## 解锁垂直同步（高刷新 / 高帧率）

```
双击 tools\run-hw-nosync.bat
```

它在 `run-hw.bat` 的基础上多两条参数：

| 参数 | 作用 |
|---|---|
| `--disable-gpu-vsync` | 关闭浏览器内部的 vsync 等待 |
| `--disable-frame-rate-limit` | 取消 rAF 的 60/刷新率上限 |

实测（RTX 4060 + Vulkan，1920×1080，高画质）：

| 模式 | FPS |
|---|---|
| 正常（垂直同步） | 60 |
| **解锁后** | **189 ~ 246（中位 240）** |

### 要注意的三件事

1. **逻辑帧不变**：战斗是 60 Hz 定步长（`STEP = 1/60`），解锁后只是渲染更快，
   招式帧数、判定窗口、手感完全不受影响——变的是画面流畅度和输入延迟。
2. **会撕裂**：没有 vsync 也没有 G-Sync 的话，水平撕裂会出现，快速转镜头时最明显。
3. **发热和耗电**：GPU 会跑满，笔记本风扇会响、电池掉得快。日常玩建议用
   `run-hw.bat`（锁 60），只在测性能或录高帧素材时用这个。

### 想折中

如果你的屏幕是 144 Hz / 165 Hz，直接开系统的「高性能/高刷新」+ `run-hw.bat` 就够，
rAF 会跑满屏幕刷新率；`run-hw-nosync.bat` 只在这种情况才有意义：屏幕 60 Hz 但你想
让 GPU 跑到 240 帧来测极限。
