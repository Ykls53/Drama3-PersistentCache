# Drama3 专家缓存常驻补丁

> 让 [ComfyUI-Drama3](https://github.com/PedroMarinhoDev/ComfyUI-Drama3) 的专家缓存跨生成常驻，
> 使用计数累积成热表。思路同 llama.cpp 的 `--moe-expert-cache`、Strata 的 `expert-profile`。
>
> Keeps the expert cache and its warm table alive across generations.

[English](README.md) | **简体中文**

---

## 问题

Drama 3 是 35B MoE 语音模型。256 专家 × 40 层 = 10,240 个专家，约 30 GiB。
16GB 显卡装不下，必须放主机内存、按需走 PCIe 搬运。

原版每次生成结束都销毁专家缓存和热表：

```python
# drama3/offload.py, session() 的 finally 块
finally:
    self.cache.report()
    self.cache = None                          # 缓存 + 热表全丢
    comfy.model_management.soft_empty_cache()  # 显存也清空
```

后果：

- 每次生成要重建 8 GiB 显存缓存
- 每次生成要重新学「哪些专家热」（`score` 从零开始）
- **单句约 35 秒，连续跑永远不快**

---

## 补丁做了什么

### 1. 缓存常驻

`SlotPool` 内部本来就在统计每个专家的使用次数（`score`，每 `HALF_LIFE`
个 pass 衰减一半）。只要缓存不被销毁，这个计数就会累积，自动变成热表。

开关：`DRAMA3_PERSISTENT_CACHE=1`

### 2. 先剥离专家再加载

原流程同时持有**两份 30 GiB**：

```
load_state_dict  -> 模型持有 30 GB 专家
experts.add()    -> 再复制一份到 pinned 内存   （峰值 66 GB！）
```

修正后：

```
剥离专家键        -> 模型只装 5.9 GB 非专家
add_from_tensors  -> 直接从 safetensors 张量建 pinned bank
```

### 3. 按换页压力自适应

**重要教训**：不要用「物理可用内存」判断紧张程度。

专家 pinned 30 GiB 后，物理可用长期只剩 1–2 GB —— 但只要 `pages/sec = 0`
就是健康的。我之前按物理内存判断，把显存缓存压到 1.78 GiB，
结果**显存空着 6 GB 不用**，白丢命中率。

正确判据：**页面文件使用率**

```python
swap_pct = psutil.swap_memory().percent
if   swap_pct >= 40: ratio = 0.35   # 真紧张
elif swap_pct >= 25: ratio = 0.65
elif swap_pct >= 12: ratio = 0.85
else:                ratio = 1.0    # 健康，缓存全开
```

---

## 实测结果

RTX 5070 Ti 16GB + 63GB DDR5-6000，FP8 权重（38.58 GB，官方原样）。

### 4 句批量

| 轮次 | 耗时 | 音频 | 实时率 |
|---|---|---|---|
| 1 | 16.2 s | 25.21 s | **1.56×** |
| 2 | 18.3 s | 27.75 s | 1.52× |
| 3 | 14.0 s | 18.95 s | 1.35× |
| 4 | 18.1 s | 24.35 s | 1.35× |
| 5 | 16.1 s | 21.75 s | 1.35× |

**热态均值 1.39×，峰值 1.56× —— 超实时。**

### 横向对比

| 方案 | 速度 |
|---|---|
| Drama3-Studio（原版） | 1.27 字/秒 |
| ComfyUI-Drama3（未打补丁） | 0.82 字/秒 |
| **ComfyUI-Drama3 + 本补丁** | **1.39× 实时** |

### 资源占用

| 项目 | 数值 |
|---|---|
| 显存 | 15.25 / 16.3 GB（93%）|
| 专家缓存 | 8.24 GiB（全开）|
| 页面文件 | 3–4%（健康）|

---

## 反直觉发现

### 4 句比 8 句快 3 倍

| lines_at_once | 实时率 |
|---|---|
| 4 | **1.39×** |
| 8 | 0.48× |

`session_rows = capacity * (5 + width + (width > 1)) // 6` —— width 8 时
reserve 是 2.33 倍，显存缓存被挤小。

### 缓存大不等于快

| 场景 | 缓存 | 实时率 |
|---|---|---|
| 内存健康 | 8.24 GiB | 1.39× |
| 内存紧张 | 8.6 GiB | **0.25×**（灾难）|
| 内存紧张 + 收缩缓存 | 1.55 GiB | 0.90× |

一旦系统换页，PCIe 搬运和页面文件 IO 抢同一条总线。

### 7GB 显存也能跑

用 `--reserve-vram 9` 模拟 8GB 卡：**热态 0.82×**，只比 16GB 慢 15%。

---

## 安装

### 1. 前置

- ComfyUI（实测 v0.39.2；节点 README 要求 0.40+）
- [`PedroMarinhoDev/ComfyUI-Drama3`](https://github.com/PedroMarinhoDev/ComfyUI-Drama3)
- 转换后的 FP8 权重（38.58 GB，见下）
- **建议 64 GB 系统内存** —— 专家要 pin 30 GiB 在主机内存
- NVIDIA 显卡，最低 7 GB 显存（建议 16 GB）

### 2. 转换官方权重

```bash
# FP8 直通：原字节，不重新量化（零精度损失）
python tools/convert.py model <hf_dir> <out.safetensors> --format fp8 --dense bf16 --device cpu

python tools/convert.py codec <hf_dir>/codec.pth <out_codec.safetensors> --device cpu
```

> **`--device cpu` 是必须的。** 默认 `cuda:0` 会在第 31 层触发 `c10.dll`
> 段错误，尽管 FP8 路径根本不用 GPU。

### 3. 打补丁

```bash
cp -r drama3/* <ComfyUI>/custom_nodes/ComfyUI-Drama3/drama3/
```

### 4. 启动

```bash
export DRAMA3_PERSISTENT_CACHE=1        # Windows: set DRAMA3_PERSISTENT_CACHE=1
python main.py --enable-manager --use-ck-attention --port 8188
```

⚠️ **不要加 `--highvram`** —— 它会把 32GB 专家塞进 16GB 显存，立刻 OOM。

---

## 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `DRAMA3_PERSISTENT_CACHE` | 关 | `1` 缓存跨生成保留 |
| `DRAMA3_RAM_ADAPTIVE` | 开 | `0` 关闭按页面文件的自适应 |
| `DRAMA3_HALF_LIFE` | `128` | 使用计数的半衰期。实测 512 **更慢** |

---

## 改动清单

### `drama3/offload.py`

```python
import os   # 新增

# 半衰期可配置
HALF_LIFE = int(os.environ.get("DRAMA3_HALF_LIFE", "128"))

class ExpertStore:
    def __init__(...):
        self.persistent = False          # 新增
        self._pin_budget = None          # 新增
        self._pinned_bytes = 0           # 新增
        self._pin_exhausted = False      # 新增

    def add_from_tensors(self, gu_w, gu_s, dn_w, dn_s):
        """直接从 safetensors 张量建 pinned bank。"""   # 新增

    @contextlib.contextmanager
    def session(self, ...):
        # 常驻模式复用缓存
        if self.persistent and self.cache is not None:
            self._setup_session_flags(device, cpu_decode, cpu_experts)
            try:
                yield
            finally:
                self._clear_transient()
            return
        ...
        try:
            yield
        finally:
            if self.persistent:
                self._clear_transient()      # 保留 cache 与热表
            else:
                self.cache.report()
                self.cache = None
                comfy.model_management.soft_empty_cache()

    def _ram_aware_budget(self, budget, device):
        """按页面文件压力（而非空闲内存）决定显存缓存大小。"""  # 新增
```

### `drama3/loader.py`

```python
# 先剥离专家，再 load_state_dict
_expert_keys = [k for k in state.keys() if ".mlp.experts." in k]
if _expert_keys and experts_in_ram:
    expert_state = {k: state.pop(k) for k in _expert_keys}
result = model.load_state_dict(state, ...)   # 只 5.9 GB

# 用剥离出的张量直接建 pinned bank
for layer_i, layer in enumerate(model.model.layers):
    prefix = f"model.layers.{layer_i}.mlp.experts."
    layer.mlp.experts = experts.add_from_tensors(
        expert_state[prefix + "gate_up_weight"],
        expert_state[prefix + "gate_up_scale"],
        expert_state[prefix + "down_weight"],
        expert_state[prefix + "down_scale"])
```

---

## 已知限制

1. **重启后热表清零** —— 需要约 3–5 轮重新累积
2. **显存常驻 15 GB** —— 与其他模型同时运行会冲突
3. **混合 pin 不可行** —— CUDA grouped kernel 要求所有张量要么是 CUDA tensor，
   要么是 pinned CPU tensor
4. **不 pin 慢 2.7 倍**（0.36× vs 0.98×）—— 想要速度就不能省这一步

---

## 致谢

- [PedroMarinhoDev/ComfyUI-Drama3](https://github.com/PedroMarinhoDev/ComfyUI-Drama3) —— 基础实现
- [Fish Audio](https://fish.audio/) —— Drama 3 模型
- [llama.cpp RFC #28248](https://github.com/ggml-org/llama.cpp/discussions/28248) —— 持久专家池思路

## 许可

跟随上游项目。原创部分 MIT；`codec.py` 等改编自 Fish Speech 的部分
遵循 Fish Audio Community License。

---

## v4 更新（2026-11-23）：解码器显存修复

### 问题：长语音解码失败

```
RuntimeError: Expected all tensors to be on the same device,
but found at least two devices, cuda:0 and cpu!
```

日志里能看到关键一行：

```
loaded partially; 1426.85 MB usable, 1414.85 MB loaded,
77.80 MB offloaded
```

**codec 只差 78 MB 装不进显存，被 offload 回 CPU**，于是模型参数一半在 GPU 一半在 CPU。

### 根因

常驻专家缓存会把显存吃满（这是性能优化的目的），但 `Drama3Decode` 需要完整加载 1.5 GB 的 codec。
ComfyUI 的 `load_models_gpu` 在显存不足时只加载一部分，不报错，直到前向计算时才炸。

**长语音时更严重**：`DECODE_FRAME_BYTES = 5.3 MB/帧`，长 take 的 window 更大，需要的显存更多。

### 修复

**`nodes.py` — decode 前主动腾显存**

```python
def decode(codec, codes, gap=0.0):
    ...
    need = window * DECODE_FRAME_BYTES
    _free_for_codec(codec, need)          # 新增
    comfy.model_management.load_models_gpu([codec.patcher], memory_required=need)
    ...
```

```python
def _free_for_codec(codec, need_bytes):
    """确保 codec 能整块进显存。不够就按需要卸载别人的模型。"""
    free = comfy.model_management.get_free_memory(codec.patcher.load_device)
    if free >= need_bytes:
        return
    comfy.model_management.free_memory(need_bytes, codec.patcher.load_device)
    # 常驻专家缓存不会自己让位，显式清掉（下次生成会重建，热表还在）
    from .drama3.offload import _ACTIVE_STORES
    for store in _ACTIVE_STORES:
        if getattr(store, "cache", None) is not None:
            store.cache = None
    comfy.model_management.soft_empty_cache()
```

**`drama3/offload.py` — 登记活跃实例**

```python
_ACTIVE_STORES = []        # 新增，供 nodes.py 找到要释放的缓存

class ExpertStore:
    def __init__(...):
        ...
        _ACTIVE_STORES.append(self)   # 新增
```

### 效果

| 测试 | 修复前 | 修复后 |
|---|---|---|
| 短句（2 句） | ✅ | ✅ 40.7s |
| **长句（120 字，自动拆分）** | ❌ 解码失败 | ✅ 92.2s |
| 长句第二次 | ❌ | ✅ **22.1s** |

**不需要 `--reserve-vram` 了**，代码自己腾。

### 顺带说明：自动拆分/合并本来就存在

`split_long_text=True`（默认开）会让长文本按 **300 字节（约 100 汉字）** 自动切块，
每块带上一块上下文生成，最后自动拼接。不用额外做。

## 附带：中文情绪标签面板

`web/drama3_tag_panel.js` 给 `Drama3Generate` 节点加了一个「🏷 插入情绪标签」按钮，
点开是 **80 个分类标签**（基础情绪 12 / 进阶情绪 37 / 声音语气 14 / 人声 11 / 音效停顿 6），
点一下追加到台词末尾。标签表提取自 Drama3-Studio。
---

## v6 更正（重要）

v4 的修复**没有真正生效**，原因是判断条件写错了：

```python
if free >= need_bytes:   # ← get_free_memory 把可回收缓存也算作空闲
    return               # ← 于是永远提前返回，释放逻辑从不执行
```

### 正确做法

不看 `get_free_memory`，**直接检查 codec 的参数是否真在 GPU 上**：

```python
def _codec_fully_loaded(codec):
    """codec 的参数是否全部在 load_device 上（没有 offload 回 CPU 的）。"""
    dev = codec.patcher.load_device
    for param in codec.patcher.model.parameters():
        if param.device.type != dev.type:
            return False
    return True

def _free_for_codec(codec, need_bytes):
    if _codec_fully_loaded(codec):
        return                      # 已经全在 GPU，不用动
    comfy.model_management.free_memory(need_bytes, codec.patcher.load_device)
    for store in _ACTIVE_STORES:    # 清常驻专家缓存，下次生成会重建
        store.cache = None
    comfy.model_management.soft_empty_cache()
```

### 实测（RTX 5070 Ti 16GB）

| 测试 | v4 | v6 |
|---|---|---|
| 长台词（含 7 个标签，约 200 字） | ❌ 解码失败 | ✅ 54.2 s |
| 短句 | ❌ | ✅ 24.1 s |

### 还有一个坑：改完必须重启

Python 模块加载到内存后不会重读文件。**改完代码不重启服务，跑的还是旧逻辑** —— v4 那次就是因为这个，日志里连一行释放记录都没有。
---

## 台词助手（v7）

`web/drama3_tag_panel.js` 给 `Drama3Generate` 节点加一个「🏷 台词助手（标签 / 拼音）」按钮。

### 严格按官方三种语法分组

官方文档（REFERENCE.md）说明标签是**自由自然语言，没有固定词表**，但语法分三类：

| 类型 | 语法 | 作用范围 | 面板里的组 |
|---|---|---|---|
| 点标签 | `[cue]` | **只在那个位置响一声** | 点标签（15 个） |
| 范围标签 | `<cue>...</cue>` | **只包住那几个字** | 范围标签（7 个） |
| 导演笔记 | 自然语言描述 | 管整句 | 整体情绪（16 个） |

**关键点**：`[Whisper]` 写在行首是**点标签**，只在那个位置响一声耳语就没了 —— 这就是很多人觉得「没效果」的原因。
要整句耳语必须用 `<whisper>...</whisper>` 包起来。

### 人机工学设计

1. **光标处插入**，不是只往末尾追加
2. **选中文字后点范围标签，会包住选中内容**；没选中就插一对空标签
3. **整体情绪自动跳到当前行行首**
4. **插入后焦点回文本框，光标停在插入内容之后** —— 可以连续点击
5. **搜索框置顶并自动聚焦**，打「耳」「叹」「whisper」都能筛
6. **拼音纠音按字数校验**：选 2 个字给 3 个拼音会报错提示

### 组合示例：整体耳语 + 前半平静 + 后半疑问

```
<whisper>[平静] 主人，这是测试音色。[Curious] 你觉得如何？</whisper>
```

- `<whisper>...</whisper>` 包住整句 → 整体耳语
- `[平静]` 在第一个分句前
- `[Curious]` 在第二个分句前

### 拼音纠音用法

1. 在台词里**选中要纠音的汉字**（如「重要」）
2. 底部输入框填拼音，**一个字一个音节、空格分开**：`zhong4 yao4`
3. 点「应用」或按回车

结果：
```
<|phoneme_start|>zhong4<|phoneme_end|><|phoneme_start|>yao4<|phoneme_end|>的事情。
```

规则（官方）：小写拼音、声调数字在音节末尾（`ma1`–`ma5`，5 是轻声）、标点留在标签外面。

### 一个踩过的坑

第一版点不动，原因是选区保存逻辑错了：只在 textarea 有焦点时才记录，但一点按钮焦点就跑了，选区永远是 `[0,0]`。

**改成无条件读取 textarea 自己的 `selectionStart`**（textarea 失焦后仍保留选区）就正常了。

### 实测

| 功能 | 结果 |
|---|---|
| 点标签 | `你好世界这 [sighs] 是一个测试句子。` ✅ 插在光标处 |
| 范围标签 | `这是一<whisper>句悄</whisper>悄话。` ✅ 正好包住选中的 2 字 |
| 整体情绪 | `[愤怒] 第二行台词。` ✅ 自动跳到行首 |
| 拼音纠音 | `<|phoneme_start|>zhong4<|phoneme_end|>...` ✅ 逐字打标 |