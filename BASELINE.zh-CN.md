# Drama 3 基线 v3（2026-11-23 最终版）

**状态**：持续优化完成，性能超实时

---

## 一、性能基线

### 4 句批量（lines_at_once=4，主力用法）
| 轮次 | 耗时 | 音频 | 实时率 |
|---|---|---|---|
| 1 | 16.2s | 25.21s | **1.56×** |
| 2 | 18.3s | 27.75s | 1.52× |
| 3 | 14.0s | 18.95s | 1.35× |
| 4 | 18.1s | 24.35s | 1.35× |
| 5 | 16.1s | 21.75s | 1.35× |

**热态均值 1.39×，峰值 1.56×**

### 单句（10 秒级文本）
热态 0.90-1.13×

### 演进对比
| 版本 | 4句批量 |
|---|---|
| 基线 v1 | 1.30× |
| **v3（当前）** | **1.39×** |

### 横向对比
| 方案 | 性能 |
|---|---|
| Studio 原版 | 1.27 字/秒 |
| ComfyUI 原版 | 0.82 字/秒 |
| **ComfyUI 魔改 v3** | **1.39× 实时** |

---

## 二、资源占用

| 项目 | 数值 |
|---|---|
| 显存 | 15.25 GB / 16.3 GB（**93%，吃满**）|
| 专家缓存 | 8.24 GiB（全开）|
| 内存 | 物理剩 2-4 GB，提交余 36 GB |
| 页面文件 | 3-4% 使用（健康）|

---

## 三、核心改动清单

### 1. 专家缓存跨生成常驻（offload.py）

**原版**：每次生成结束销毁缓存和热表
```python
finally:
    self.cache.report()
    self.cache = None                          # 销毁
    comfy.model_management.soft_empty_cache()  # 清显存
```

**改后**：常驻模式保留缓存，热表累积
```python
finally:
    if self.persistent:
        self._clear_transient()   # 只清瞬态
    else:
        ...原逻辑...
```

开关：`DRAMA3_PERSISTENT_CACHE=1`

### 2. 先剥离专家再 load_state_dict（loader.py）

**原流程**：`load_state_dict` 装 30GB 专家 → 再复制到 pinned → 峰值 66GB

**改后**：先剥离专家键，模型只装 5.9GB，专家直接从 safetensors 张量建 pinned bank
```python
_expert_keys = [k for k in state.keys() if ".mlp.experts." in k]
expert_state = {k: state.pop(k) for k in _expert_keys}
result = model.load_state_dict(state, ...)   # 只 5.9GB
# 再用 expert_state 建 bank
layer.mlp.experts = experts.add_from_tensors(gu_w, gu_s, dn_w, dn_s)
```

配套新增 `ExpertStore.add_from_tensors()`

### 3. RAM 自适应（★重要教训）

**第一版错误判据**：用物理可用内存
```python
spare = avail - headroom          # 剩 0.8GB → 负数
ratio = 0.20 + 0.80 * healthy     # → 0.20，缓存压到 1.78 GiB
```
**后果**：显存只用 9.8GB（空着 6GB），白丢命中率

**正确判据**：页面文件使用率 + pages/sec
```python
swap_pct = psutil.swap_memory().percent
if swap_pct >= 40:   ratio = 0.35
elif swap_pct >= 25: ratio = 0.65
elif swap_pct >= 12: ratio = 0.85
else:                ratio = 1.0   # 健康，全开
```

**教训**：模型 pinned 30GB 后物理可用长期只剩 1-2GB，但 `pages/sec = 0`（不换页）
就是健康的。**不能用物理可用内存判断紧张程度。**

### 4. HALF_LIFE 可配置（offload.py）
```python
HALF_LIFE = int(os.environ.get("DRAMA3_HALF_LIFE", "128"))
```
实测 512 反而更慢（旧专家占位），128 最优。

---

## 四、关键实验结论

### ① 4 句 >> 8 句
| 组合 | 实时率 |
|---|---|
| 4 句 | **1.39×** |
| 8 句 | 0.48× |

原因：`session_rows = capacity * (5+width+(width>1))//6`
width=8 时 rows 是 2.33 倍，reserve 变大，显存缓存被挤小。

### ② 缓存越大 ≠ 越快（换页才是杀手）
| 场景 | 缓存 | 实时率 |
|---|---|---|
| 内存健康 | 8.24 GiB | 1.39× |
| 内存紧张 | 8.6 GiB | **0.25×**（灾难）|
| 内存紧张+收缩 | 1.55 GiB | 0.90× |

**一旦触发换页，PCIe 搬运和页面文件 IO 抢同一条总线。**

### ③ 7GB 显存也能跑
`--reserve-vram 9` 模拟 8G 卡（实际 7G）：
热态 0.82×，只比 16GB 慢 15%。

### ④ 混合 pin 不可行
CUDA kernel 报错：`All tensor arguments must be CUDA tensors or pinned CPU tensors`
必须整批 pinned 或整批 CUDA。

### ⑤ 不 pin 的代价
不 pin 可多出约 20 GiB 内存，但速度从 0.98× 降到 0.36×（慢 2.7 倍）。

---

## 五、启动方式

```powershell
$c='D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI'
$env:DRAMA3_PERSISTENT_CACHE='1'
Set-Location $c
& "$c\.venv\Scripts\python.exe" main.py --enable-manager --use-ck-attention --port 8188
```

**必须**：
- ✅ `--enable-manager --use-ck-attention`
- ✅ `DRAMA3_PERSISTENT_CACHE=1`

**禁止**：
- ❌ `--highvram`（把 32GB 专家塞 16GB 显存 → OOM）
- ❌ `--cache-ram`（与常驻冲突）

---

## 六、版本目录

```
G:\Drama3-Baseline-20261123\
├── drama3-original\      ← 原始未改
├── drama3-persistent\    ← v1：常驻缓存（1.30×）
├── drama3-v2-split\      ← v2：+ 剥离专家
├── drama3-v3\            ← v3：+ 页面文件判据（当前最优 1.39×）
├── 基线v1.md
└── README-OPENSOURCE.md
```

回退到原始版：
```powershell
Remove-Item "D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes\ComfyUI-Drama3\drama3" -Recurse -Force
Copy-Item "G:\Drama3-Baseline-20261123\drama3-original" "D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\custom_nodes\ComfyUI-Drama3\drama3" -Recurse
```

---

## 七、待优化（未验证）

1. **KV 量化**：参考 180B 的 `--kv int8`，可能再提
2. **W4A8 权重**：专家 30→18GB，需下 24.6GB
3. **跨会话热表持久化**：把 score 存盘，重启后恢复（未实现）
4. **冷启动优化**：第 1-2 轮慢（缓存重建），能否预热

---

## 八、环境

- GPU: RTX 5070 Ti 16GB（PCIe 4.0 x16 ≈ 32 GB/s，显存 896 GB/s，差 28 倍）
- RAM: 63.2 GB DDR5-6000
- 模型: 38.58 GB FP8 官方原权重（转换自 fishaudio/drama-3，0 精度损失）
- ComfyUI: v0.39.2 + ComfyUI-Drama3 节点
