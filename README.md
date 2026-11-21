# 浮空要塞 · 类魂 Boss 战 Demo

一个用 Three.js 和 Electron 构建的第三人称 Boss 战原型。玩家在浮空要塞中和 Boss 交战，可以练习连击、格挡、弹反和翻滚，也能用慢放、判定框和帧数据面板调试战斗节奏。

## 快速开始

建议使用 Node.js 24 和 npm。在项目根目录安装依赖后，任选一种入口。

```powershell
npm install
```

| 入口 | 启动方式 |
| --- | --- |
| Windows 桌面版 | `npm run app`，也可以双击 [一键启动.bat](tools/一键启动.bat) |
| 浏览器版 | `npm run dev`，访问 [localhost:5173](http://localhost:5173/) |
| 独立擒拿调试 | `npm run app:grab`，或访问 [浏览器调试入口](http://localhost:5173/?grabTest=1) |

浏览器版需要支持 WebGL 2，并通过本地 HTTP 服务打开。首次进入时等角色模型和动作加载完成，再点击战斗画面捕获鼠标。Windows PowerShell 若拦截 `npm.ps1`，可用 `npm.cmd` 执行同样的命令。

## 默认操作

| 按键 | 动作 |
| --- | --- |
| `W` `A` `S` `D` | 移动。自由视角下以镜头为参考，锁定时以 Boss 方位为参考 |
| 移动鼠标 | 转动自由视角 |
| 鼠标中键 | 锁定或解锁 Boss |
| 鼠标左键 | 轻击，最多四段 |
| `F` | 重击，最多三段 |
| 鼠标右键 | 格挡。格挡开头的短窗口可触发弹反 |
| 左 `Shift` 或 `Space` | 翻滚 |
| `Esc` 或右下角「设置」 | 打开设置，调整键位、鼠标灵敏度、视场角和画质 |
| `R` | 重开战斗 |
| `F1` | 显示或隐藏判定框 |
| `F2` | 在正常速度和 0.25 倍慢放之间切换 |
| `F3` | 暂停或继续 |
| `P` | 导出帧表 JSON |

## 战斗机制

- **连击和判定**　战斗逻辑以 60 Hz 固定步长运行。招式按起手、命中窗口和收招计帧，攻击和受击区用圆柱近似。命中会触发短暂停顿，并按招式结算伤害、削韧和硬直。
- **Boss 选招**　AI 根据距离、朝向、冷却和近期出招记录，从横扫、下劈、重剑连斩与破防擒拿中选招。贴身压力和玩家的攻击起手也会影响 Boss 的后撤、格挡和闪避。
- **破防擒拿**　Boss 身上先亮起红光，再突进抓人。命中后会举起玩家，玩家在空中挣扎约 1.5 秒，随后被抛空并侧踢击飞。玩家会因冲击弯成 V 形，撞墙后停下。存活时先倒地挣扎约 1.4 秒，再用约 2 秒起身并恢复操作。格挡会被抓住，翻滚的无敌窗口可避开抓取。
- **死亡**　死亡只结算一次，动作结束后保持倒地。玩家死亡后 Boss 会收手，尸体退出命中和推挤判定。按 `R` 可以重开。

## 调试与调参

### 普通战斗

在设置的「硬件与调试」中开启「帧数据调参」。右侧面板可调整出招时序、伤害、Boss 转身和近战特效。用 `F1` 打开判定框、`F2` 慢放，再对照 HUD 的当前状态和帧计数。面板改动即时生效，按 `P` 可导出当前 `CFG` 和 `MOVES`。

普通模式会自动保存调参。使用 `npm run dev` 时，服务端保存到 `data/tuning.json`，服务端不可用时使用当前浏览器来源的本地存储。要恢复代码里的默认参数，先在「调参存档」中清除存档，再刷新页面。桌面版的图形后端和垂直同步可在设置里调整，应用后会重启窗口。

### 擒拿专项

通过启动命令、`?grabTest=1`，或普通模式右侧的「调试 → 打开擒拿调试」进入。这个场景只测试擒拿，Boss 等待手动出招。

1. 选择「场地中央」或「近墙」，调整起始距离。
2. 按 `G` 施放擒拿，按 `R` 复位。按 `Tab` 可释放鼠标以操作面板。
3. 用 `F2` 慢放，或点「单步一帧」检查抓取范围、举起、侧踢触点和撞墙位置。
4. 预警帧数、突进抓取帧数、突进距离、抓取半径、方向锁定时机及伤害在下次施放时生效。按 `P` 导出擒拿参数，点「返回正常对战」退出。

专项面板的临时改动作用在本次页面会话。要修改正式招式默认值，编辑 [`src/frame-data.js`](src/frame-data.js) 中的 `MOVES.b_grab` 和 `GRAB_TIMING`。倒地挣扎、起身采样和骨骼姿态在 [`src/grab-combo.js`](src/grab-combo.js) 中调整。

## 模型与动画

默认加载 `assets/player/player.glb` 和 `assets/boss_model_v2.glb`。可以在浏览器入口用查询参数对比模型或切到灰盒。

| 参数 | 用途 |
| --- | --- |
| `?graybox=1` | 使用程序化角色和姿态，方便单看走位及判定 |
| `p` / `b` | 替换玩家 / Boss 的 GLB 路径 |
| `ph` / `bh` | 玩家 / Boss 的目标模型身高，单位为米 |
| `ps` / `bs` | 玩家 / Boss 的模型缩放参数 |
| `py` / `by` | 玩家 / Boss 的朝向修正，单位为弧度 |
| `anim=0` | 跳过额外的动画包 |
| `noweapon=1` | 跳过武器模型挂载 |

换模型后可用判定框检查体型和命中范围。剪辑映射、骨架重定向、武器挂点和 Boss 脚底贴地在 [`src/asset-adapter.js`](src/asset-adapter.js) 中处理。

## 代码导航

| 路径 | 内容 |
| --- | --- |
| [`src/main.js`](src/main.js) | 战斗循环、角色状态、Boss AI、镜头和调参入口 |
| [`src/frame-data.js`](src/frame-data.js) | 默认招式参数、擒拿时序与帧表校验 |
| [`src/grab-combo.js`](src/grab-combo.js) | 抓举、挣扎、侧踢、撞墙和起身的姿态与动画衔接 |
| [`src/pose.js`](src/pose.js)、[`src/footik.js`](src/footik.js) | 灰盒姿态与脚部 IK |
| [`src/settings.js`](src/settings.js) | 画质、镜头与按键设置 |
| [`assets/anims/`](assets/anims/) | Boss 动作和擒拿、起身的动画轨道 |
| [`electron/main.cjs`](electron/main.cjs)、[`serve.mjs`](serve.mjs) | 桌面入口与浏览器开发服务 |

## 验证

```powershell
node --test tests/sim.test.mjs
npm run app:smoke
```

`sim.test.mjs` 检查帧表、位移曲线和判定几何。当前脚本还有 3 条沿用旧选招规则的 AI 断言，涉及已移除的怒吼及远距离选招，运行时会报告失败。

`npm run app:smoke` 会启动 Electron、输出图形环境信息并生成 `docs/electron-smoke.png`。验证擒拿时，可以分别在场地中央和近墙检查命中、翻滚躲避、撞墙停下、起身恢复操作，以及致死后 Boss 是否停手。

## 资源来源

- 格挡与弹反特效来自 XsxB-Slash 的 `parry_fable` 示例。[资源来源](assets/vfx/parry/SOURCE.txt) · [许可证](assets/vfx/parry/LICENSE)
- `Sword_Heavy_Combo` 来自 Quaternius 的 Universal Animation Library 2 Standard。[资源说明与许可证](assets/anims/Sword_Heavy_Combo.LICENSE.txt)
