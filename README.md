# Drama3 Persistent Expert Cache

> Persistent expert cache for [ComfyUI-Drama3](https://github.com/PedroMarinhoDev/ComfyUI-Drama3).
> Keeps the expert cache and its warm table alive across generations, the same idea as
> llama.cpp's `--moe-expert-cache` and Strata's `expert-profile`.
>
> 让 Drama 3 的专家缓存跨生成常驻，使用计数累积成热表。
> 思路同 llama.cpp 的 `--moe-expert-cache`、Strata 的 `expert-profile`。

**English** | [简体中文](README.zh-CN.md)

---

## The Problem / 问题

Drama 3 is a 35B MoE speech model. Its 256 experts × 40 layers = 10,240 experts
weigh about 30 GiB. On a 16 GB card they must live in host RAM and be streamed
over PCIe as needed.

原版每次生成结束都会销毁专家缓存和热表：

```python
# drama3/offload.py, session()'s finally block
finally:
    self.cache.report()
    self.cache = None                          # cache + warm table dropped
    comfy.model_management.soft_empty_cache()  # VRAM cleared too
```

Consequences / 后果：

- Every generation rebuilds an 8 GiB VRAM cache
- Every generation relearns which experts are hot (`score` starts from zero)
- **A single line takes ~35 s; repeated runs never get faster**

---

## What This Patch Does / 补丁做了什么

### 1. Persistent cache / 缓存常驻

`SlotPool` already counts each expert's uses (`score`, halving every `HALF_LIFE`
passes). Keeping the cache alive lets that count accumulate — it becomes a warm
table for free.

`SlotPool` 内部本来就有专家使用计数。只要缓存不被销毁，计数就会累积，自动变成热表。

Switch / 开关：`DRAMA3_PERSISTENT_CACHE=1`

### 2. Split experts before loading / 先剥离专家再加载

Original flow holds **two copies of 30 GiB** at once:

```
load_state_dict  -> model holds 30 GB experts
experts.add()    -> copies them into pinned memory   (peak 66 GB!)
```

Fixed flow / 修正后：

```
strip expert keys -> model loads only 5.9 GB
experts.add_from_tensors() -> build pinned banks straight from safetensors
```

### 3. RAM adaptivity by paging pressure / 按换页压力自适应

**Key lesson / 重要教训**: do **not** judge memory pressure by free physical RAM.

After 30 GiB of experts are pinned, free physical RAM sits at 1–2 GB forever —
but that is healthy if `pages/sec` is 0. Judging by it cost us 6 GB of unused VRAM.

**不能用「物理可用内存」判断紧张程度。** 专家 pinned 后物理可用长期只剩 1-2 GB，
但 `pages/sec = 0` 就是健康的。

Correct signal / 正确判据: **page file usage**

```python
swap_pct = psutil.swap_memory().percent
if   swap_pct >= 40: ratio = 0.35   # real pressure
elif swap_pct >= 25: ratio = 0.65
elif swap_pct >= 12: ratio = 0.85
else:                ratio = 1.0    # healthy, cache fully open
```

---

## Measured Results / 实测结果

RTX 5070 Ti 16 GB + 63 GB DDR5-6000, FP8 weights (38.58 GB, official).

### Batch of 4 lines / 4 句批量

| Run | Time | Audio | Real-time factor |
|---|---|---|---|
| 1 | 16.2 s | 25.21 s | **1.56×** |
| 2 | 18.3 s | 27.75 s | 1.52× |
| 3 | 14.0 s | 18.95 s | 1.35× |
| 4 | 18.1 s | 24.35 s | 1.35× |
| 5 | 16.1 s | 21.75 s | 1.35× |

**Hot average 1.39×, peak 1.56× — faster than real time.**

### Against alternatives / 横向对比

| Setup | Speed |
|---|---|
| Drama3-Studio (original) | 1.27 chars/s |
| ComfyUI-Drama3 (unpatched) | 0.82 chars/s |
| **ComfyUI-Drama3 + this patch** | **1.39× real time** |

### Resources / 资源占用

| Item | Value |
|---|---|
| VRAM | 15.25 / 16.3 GB (93%) |
| Expert cache | 8.24 GiB (fully open) |
| Page file | 3–4% (healthy) |

---

## Counter-intuitive Findings / 反直觉发现

### 4 lines beat 8 lines by 3× / 4 句比 8 句快 3 倍

| lines_at_once | Real-time |
|---|---|
| 4 | **1.39×** |
| 8 | 0.48× |

`session_rows = capacity * (5 + width + (width > 1)) // 6` — with width 8 the
reserve is 2.33× larger, squeezing the VRAM cache.

### A bigger cache is not always faster / 缓存大不等于快

| Situation | Cache | Real-time |
|---|---|---|
| Healthy RAM | 8.24 GiB | 1.39× |
| RAM pressure | 8.6 GiB | **0.25×** (disaster) |
| RAM pressure + shrunk cache | 1.55 GiB | 0.90× |

Once the system pages, PCIe transfers and page-file I/O fight for the same bus.

### It runs on 7 GB of VRAM / 7GB 显存也能跑

Simulated an 8 GB card with `--reserve-vram 9`: **0.82× hot**, only 15% slower
than 16 GB.

---

## Install / 安装

### 1. Requirements / 前置

- ComfyUI (tested on v0.39.2; the node README asks for 0.40+)
- [`PedroMarinhoDev/ComfyUI-Drama3`](https://github.com/PedroMarinhoDev/ComfyUI-Drama3)
- Converted FP8 weights (38.58 GB, see below)
- **64 GB system RAM recommended** — experts pin 30 GiB in host memory
- NVIDIA GPU, 7 GB VRAM minimum (16 GB recommended)

### 2. Convert the official weights / 转换官方权重

```bash
# FP8 pass-through: original bytes, nothing re-quantised (zero precision loss)
python tools/convert.py model <hf_dir> <out.safetensors> --format fp8 --dense bf16 --device cpu

python tools/convert.py codec <hf_dir>/codec.pth <out_codec.safetensors> --device cpu
```

> **`--device cpu` is mandatory.** The default `cuda:0` crashes with a
> `c10.dll` access violation at layer 31 even though the FP8 path never touches
> the GPU.
>
> **`--device cpu` 是必须的。** 默认 `cuda:0` 会在第 31 层触发 `c10.dll` 段错误，
> 尽管 FP8 路径根本不用 GPU。

### 3. Apply the patch / 打补丁

```bash
cp -r drama3/* <ComfyUI>/custom_nodes/ComfyUI-Drama3/drama3/
```

### 4. Launch / 启动

```bash
export DRAMA3_PERSISTENT_CACHE=1        # Windows: set DRAMA3_PERSISTENT_CACHE=1
python main.py --enable-manager --use-ck-attention --port 8188
```

⚠️ **Never add `--highvram`** — it forces all 32 GB of experts into 16 GB of VRAM
and OOMs immediately.
⚠️ **不要加 `--highvram`** — 它会把 32GB 专家塞进 16GB 显存，立刻 OOM。

---

## Environment Variables / 环境变量

| Variable | Default | Meaning |
|---|---|---|
| `DRAMA3_PERSISTENT_CACHE` | off | `1` keeps the expert cache across generations |
| `DRAMA3_RAM_ADAPTIVE` | on | `0` disables page-file-based cache sizing |
| `DRAMA3_HALF_LIFE` | `128` | Passes over which a use count halves. 512 measured **slower** |

---

## Changes / 改动清单

### `drama3/offload.py`

```python
import os   # added

# configurable half-life
HALF_LIFE = int(os.environ.get("DRAMA3_HALF_LIFE", "128"))

class ExpertStore:
    def __init__(...):
        self.persistent = False          # added
        self._pin_budget = None          # added
        self._pinned_bytes = 0           # added
        self._pin_exhausted = False      # added

    def add_from_tensors(self, gu_w, gu_s, dn_w, dn_s):
        """Build a pinned bank straight from safetensors tensors."""   # added

    @contextlib.contextmanager
    def session(self, ...):
        # reuse the cache in persistent mode
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
                self._clear_transient()      # keep cache + warm table
            else:
                self.cache.report()
                self.cache = None
                comfy.model_management.soft_empty_cache()

    def _ram_aware_budget(self, budget, device):
        """Size the VRAM cache from page-file pressure, not free RAM."""  # added
```

### `drama3/loader.py`

```python
# strip experts before load_state_dict
_expert_keys = [k for k in state.keys() if ".mlp.experts." in k]
if _expert_keys and experts_in_ram:
    expert_state = {k: state.pop(k) for k in _expert_keys}
result = model.load_state_dict(state, ...)   # 5.9 GB only

# build pinned banks from the stripped tensors
for layer_i, layer in enumerate(model.model.layers):
    prefix = f"model.layers.{layer_i}.mlp.experts."
    layer.mlp.experts = experts.add_from_tensors(
        expert_state[prefix + "gate_up_weight"],
        expert_state[prefix + "gate_up_scale"],
        expert_state[prefix + "down_weight"],
        expert_state[prefix + "down_scale"])
```

---

## Known Limitations / 已知限制

1. **Warm table resets on restart** — takes ~3–5 runs to reach peak again
2. **VRAM stays occupied** (15 GB) — conflicts with other models running at once
3. **Mixed pinning is impossible** — CUDA grouped kernels require every tensor
   to be either a CUDA tensor or a pinned CPU tensor
4. **Unpinned mode is 2.7× slower** (0.36× vs 0.98×) — pinning is not optional
   if you want speed

---

## Credits / 致谢

- [PedroMarinhoDev/ComfyUI-Drama3](https://github.com/PedroMarinhoDev/ComfyUI-Drama3) — base implementation
- [Fish Audio](https://fish.audio/) — Drama 3 model
- [llama.cpp RFC #28248](https://github.com/ggml-org/llama.cpp/discussions/28248) — persistent expert pool inspiration

## License

Follows the upstream project. Original work MIT; `codec.py` and other parts
adapted from Fish Speech remain under the Fish Audio Community License.
