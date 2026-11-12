# souls-graybox — 类魂 Boss 战灰盒

帧数据驱动的 3D 类魂战斗原型。用来**调手感**，不是用来做游戏。

- 逻辑固定 60Hz 定步长，所有招式以「帧」为单位，120Hz 屏和 60Hz 屏手感完全一致
- 判定用圆柱近似 + 帧区间，不接物理引擎，改数值立刻生效
- 灰盒火柴人 + 判定线框 + 帧数据进度条，全部为「读招」服务
- 自带调参面板，改完立即生效，一键导出 JSON
- 美术资源通过 URL 参数外挂，**换模型不动任何战斗代码**

---

## 跑起来

```bash
cd souls-graybox
node serve.mjs          # 或 npm run dev
# 打开 http://localhost:5173
```

依赖已装好（`node_modules` 里有 three 0.169 + lil-gui）。重装：

```bash
npm install three@0.169.0 lil-gui@0.19.2
```

> 必须走 HTTP，不能双击 `index.html` —— `type="module"` + importmap 在 `file://` 下会被 CORS 拦。

## 操作

| 键 | 动作 |
|---|---|
| `W` `A` `S` `D` | 移动（屏幕前方恒为 Boss 方向） |
| `Shift` / `Space` | 翻滚（13f 无敌，可穿身） |
| `J` | 轻击（可接第二段） |
| `K` | 重击（削韧主力） |
| `L` | 格挡；按下后 8 帧内受击 = **弹反**（盾面白色高亮脉动 = 弹反窗） |
| 鼠标右键 | 锁定 / 解锁 |
| `F1` | 判定框显隐 |
| `F2` | 0.25x 慢放（读帧必备） |
| `F3` | 暂停 |
| `R` | 重开 |
| `P` | 导出当前帧表 JSON |

---

## 代码结构

```
index.html            外壳、importmap、HUD 样式
serve.mjs             零依赖静态服务器
src/frame-data.js     ★ 帧数据表 —— 战斗的全部真相
src/graybox.js        灰盒视觉 + 判定可视化（接美术后可整份丢弃）
src/asset-adapter.js  美术接入适配层（GLTF + 动作重定向）
src/main.js           定步长循环 / 状态机 / 判定 / AI / 相机 / 调参面板
tests/sim.test.mjs    帧表与判定的 headless 回归测试
tests/visual_check.py Playwright 截图验证（可选）
```

**铁律：`main.js` 里的逻辑不引用任何 three.js 场景对象**（除了给 mesh 同步 transform）。这样战斗可以脱离渲染跑回归测试。

---

## 怎么调手感

1. 按 `F2` 进 0.25x 慢放，按 `F1` 开判定框
2. 右侧面板改「起手帧 / 判定帧 / 收招帧」，看 HUD 上的进度条 `▁起手 █判定 ░收招`
3. 觉得「躲不掉」→ 降判定帧或加起手帧
4. 觉得「打得无聊」→ 降 `连段间隔`，加 `转身180°帧` 让穿身有收益
5. 满意了按 `P` 导出 JSON，替换 `src/frame-data.js` 里的数值

调参优先级：**连段间隔 > 转身帧 > 判定帧 > 伤害**。伤害是最不重要的那个。

---

## 脚部 IK（不滑步）

**问题**：腿由 `sin(clock)` 摆动，身体由速度移动，两者毫无关系 —— 跑起来脚在地上蹭。

**做法**（`src/footik.js`）：

1. **步态控制器**：支撑脚的坐标锁死在**世界空间**。身体走开、脚落后超过一个步幅，才抬脚迈下一步。速度越快，迈步越频繁，自动适配。
2. **两骨 IK**：给定髋和脚的世界位置，用余弦定理反解大腿/小腿角度。

```
d = |髋→踝|,  L1 = 大腿, L2 = 小腿
α = atan2(前, 下)                       // 髋→踝方向
β = acos((L1² + d² - L2²) / (2·L1·d))   // 大腿与髋→踝的夹角
大腿角 = α + β
膝内角 = acos((L1² + L2² - d²) / (2·L1·L2))
小腿角 = -(π - 膝内角)                   // 膝盖向前弯
```

脚够不到时 `d` 会被 clamp，腿伸直但不会崩。

**实测**（按住 W 跑动，45ms 采样）：

| 指标 | 数值 |
|---|---|
| 身体每采样位移 | 120.5 mm |
| 支撑脚漂移（p50） | **0.0 mm** |
| 支撑脚漂移（mean） | 6.5 mm |
| 摆动期占比 | 32% |

没有 IK 时支撑脚漂移会等于身体位移（120mm）。现在 p50 是 0，滑步基本消失。

**注意两个坑**：

- `hips.worldToLocal()` 依赖 `matrixWorld`，调用前必须 `group.updateMatrixWorld(true)`，否则拿到的是上一帧的位置。
- 渲染帧率高于逻辑帧时会出现 `moved = 0` 的空帧，直接拿它算速度会误判成「停住了」，脚被瞬间拉回身侧。速度必须做低通平滑（`dt * 10`）。

**关闭条件**：翻滚 / 死亡时 IK 自动停用，腿交回姿态系统（否则会试图把脚钉在地面，人却已经滚出去了）。

参数在 `FootIK` 构造函数里：`swingTime` 0.14s、`liftHeight` 0.15m、`minStep/maxStep` 0.30/1.30m。

---

## 帧数上限

分三层，别混为一谈。**逻辑层没有上限**——`totalFrames()` 就是三个数相加，JS 的 Number 也不会溢出。真正卡住你的是下面这三层。

### ① UI 滑块上限（`src/frame-data.js` 的 `LIMITS`）

| 项 | 范围 |
|---|---|
| 起手帧 `startup` | 1 – 300 |
| 判定帧 `active` | 0 – 90 |
| 收招帧 `recovery` | 0 – 300 |

合起来单招最长 690 帧（11.5 秒）。想更长得改 `LIMITS` 里的数字，或者导 JSON 改完再导回来。

### ② 设计软上限（超过只警告，不阻止）

| 项 | 阈值 | 超了会怎样 |
|---|---|---|
| 起手 | 150f（2.5s） | 玩家会以为游戏卡死，开始乱按 |
| 判定 | 20f | 「明明躲开了还是被打」 |
| 总帧 | 240f（4s） | **8 帧输入缓冲过期**，收招结束前按的键全丢 |

启动时 `validateAll()` 把这些打到 console，调参面板每个招式下方有「→ 总帧」「→ 检查」两行只读项，越界直接标 `⚠`。

### ③ 物理上限：动画拉伸倍率

接真模型时，剪辑要被 `timeScale` 拉伸到帧表长度：

```
timeScale = clipDuration × 60 / 总帧
```

假设一条 1.2 秒的挥砍剪辑：

| 总帧 | timeScale | 观感 |
|---|---|---|
| 63 | 1.14 | 正常 |
| 120 | 0.60 | 略慢，可接受 |
| 180 | 0.40 | 接近下限 |
| 240 | 0.30 | 明显慢动作，假 |
| 300 | 0.24 | 幻灯片 |

低于 **0.35** 就别硬拉了。解法是把动作分段：起手姿势保持（一次性 clip 播到最后一帧 freeze）、蓄力循环（一段 loop 子动画）、爆发（短 clip）。这也是魂系大招为什么都有「举武器蓄力」的循环动作——不是美术爱炫，是帧数据需要时间。

`animationScale(move, clipSeconds)` 可以直接算这个倍率，接模型前先核一下。

### 两个容易忽略的坑

**hitstop 会拉长实际时长**。63 帧的横扫命中冻结 5 帧，玩家体感是 68 帧。算「一整套连段多久」的时候要加进去。

**二阶段的加速把 `frame` 变成非整数**。现在实现是 `boss.frame += 1.25`，判定窗口按 `frame >= startup && frame < startup + active` 判断，非整数会让每段判定的实际长度在 ±1 帧之间浮动。想精确就改成整数累加（每 4 帧多走 1 帧），代价是动画有轻微顿挫。

---

## 接入自己的美术资源

### 原理

模型只是**表现层**，帧表是权威。替换模型时：

- 判定框尺寸、帧数据、AI 全部不动
- 动画剪辑被 `timeScale` 拉伸到帧表长度，而不是反过来改帧表
- 灰盒 `group` 保留为 transform 锚点，只替换它的子节点

### 五步

**① 放模型**

```
souls-graybox/assets/hero.glb
souls-graybox/assets/boss.glb
```

要求：Humanoid 骨架，骨骼 ≤ 64，米制单位，带 AnimationClip。

**② 动作在 Blender 里命名，对齐 `DEFAULT_CLIP_MAP`**

`src/asset-adapter.js` 里的映射表：

```js
export const DEFAULT_CLIP_MAP = {
  idle:     'idle',
  move:     'run',
  roll:     'roll',
  hitstun:  'hit',
  dead:     'death',
  block:    'block',
  p_light1: 'attack1',    // 玩家轻击 1
  p_light2: 'attack2',
  p_heavy:  'attack_h',
  b_sweep:  'sweep',      // Boss 横扫
  b_slam:   'slam',
  b_charge: 'charge',
  b_roar:   'roar',
};
```

GLB 里的剪辑叫什么，就改右边的值。名字对不上就不会播动画（不会崩，只是站着不动）。

**③ 带参数打开**

```
http://localhost:5173/?p=assets/hero.glb&ps=1.0&py=3.1416&b=assets/boss.glb&bs=2.6
```

| 参数 | 含义 | 默认 |
|---|---|---|
| `p` / `b` | 玩家 / Boss 模型路径 | 无（走灰盒） |
| `ps` / `bs` | 模型缩放 | 1.0 / 2.6 |
| `py` / `by` | 朝向修正（弧度） | π（Mixamo 系通用） |

**④ 校准尺寸**

打开后如果模型悬空或陷地：调 `ps` / `bs`，目标是模型头顶对齐灰盒高度 —— 玩家 1.95m，Boss 4.6m。也可以改 `attachTo(group, offsetY)` 的第二个参数微调 Y 偏移。

**⑤ 校准朝向**

模型背对镜头 = `py` 差 π。Mixamo/Kenney 都是 +Z 前向，GLTF 是 -Z，所以默认 `π` 通常对。Quaternius 可能要 `0`。

### 换成真模型后必查清单

| 检查项 | 症状 | 修法 |
|---|---|---|
| 动画不动 | 模型站着不动 | 剪辑名和 `CLIP_MAP` 对不上；开控制台看 `gltf.animations` 名字 |
| 动作太快 | 挥砍 8 帧就结束，读不了招 | `timeScale` 已自动拉伸；若仍太快，加大 `startup` |
| 动作太慢 | 收招拖沓 | 减 `recovery`，别改动画 |
| 关节扭曲 | 肘部塌陷 | 导出前 Blender 里 `Limit Total = 4` 限制骨骼权重 |
| 判定比视觉大 | 明明没打到却掉血 | 判定框在 `frame-data.js` 里独立配置，不跟模型缩放走，手动改 `hitbox.radius` |
| 脚穿地 / 悬空 | 模型底部位置不对 | 调 `bs` 或 `attachTo` 的 offsetY |
| 材质过曝 | 白花花 | 加 Draco/KTX2 后检查色彩空间，或降 `toneMappingExposure` |

### 导出参数（Blender → GLB）

```
Format:            glTF Binary (.glb)
Transform:         +Y Up, Apply Modifiers
Data > Mesh:       UVs ✓ Normals ✓ Tangents ✓
Data > Skinning:   ✓  （每顶点骨骼影响 ≤ 4）
Data > Animation:  Actions ✓
Compression:       Draco（Position 14 / Normal 10 / UV 12 / Generic 12）
```

贴图转 KTX2：

```bash
npx gltf-transform optimize in.glb out.glb --texture-compress ktx2 --texture-size 1024
```

---

## 当前实现了什么 / 还没实现

**已有**
- 固定步长逻辑帧、输入缓冲（8f）、翻滚穿身
- 双向判定、hitstop、受击硬直分级、削韧、弹反、格挡破防
- 格挡：盾面弧 + 弹反窗高亮 + 半速移动 + 帧号倒计时
- Boss 权重轮盘 AI（距离分区 + 冷却 + 三连禁止）、二阶段提速
- 帧数据进度条、判定框、慢放、暂停、导出

**没有（按需加）**
- 回放录制（建议第一个加，调参效率翻倍）
- 多段连招的位移取消（攻击中翻滚）
- 背刺 / 处决动画
- 音效（受击音必须对齐判定帧，见 README 末尾）
- 移动端虚拟摇杆

---

## 加音效时的硬要求

音效**必须**由逻辑帧触发，不能由渲染帧或 setTimeout：

```js
// 在活跃判定帧的第一帧播
if (attacker.frame === move.startup && move.active > 0) {
  audio.play(move.sfx, ctx.currentTime + 0.01);  // Web Audio 精确调度
}
```

用 `AudioContext.currentTime` 排期，不要 `new Audio().play()` —— 后者有 20–50ms 不确定延迟，会让整个手感「发软」。

---

## 回归测试

```bash
node tests/sim.test.mjs          # 帧表 / 判定几何 / AI 权重，16 项断言
python tests/check.py            # Playwright：截图 + console + 格挡 soak（可选）
```

`check.py` 会做一次格挡 soak：按住 `L` 挨打 9 秒，比对 HP 变化验证减伤。
格挡减伤 80%，所以掉血应该约等于「几次命中的伤害 × 0.2」。

改了帧表或判定后跑一遍，防止把「每个距离都有招可选」「三连禁止生效」这类规则改坏。
