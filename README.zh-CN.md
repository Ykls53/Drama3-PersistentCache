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
