// Drama 3 台词助手 —— 情绪标签 + 拼音纠音
//
// 设计原则：
//   1. 在光标处插入，不是只往末尾追加
//   2. 选中文字后点「范围标签」会包住它（<whisper>...</whisper>）
//   3. 严格按官方语法分三类：点标签 / 范围标签 / 整体情绪
//   4. 搜索 + 键盘操作，标签多也不难找
//   5. 插入后焦点回到文本框，光标跳到插入内容之后，连点不打断
//   6. 面板可拖动，位置记住

const { app } = window.comfyAPI.app;

// 每一组：label 组名 / hint 用法说明 / color 颜色 / kind 点击行为 / items [英文标签, 中文名]
const GROUPS = [
  {
    label: "点标签 · 人声",
    hint: "放在光标处，只在那里响一声。例：好 [sighs] 就这样",
    color: "#4a7ab0",
    kind: "point",
    items: [
      ["sighs", "叹气"], ["Sighing", "长叹"], ["laughs", "笑"], ["Laughing", "大笑"],
      ["Chuckling", "轻笑"], ["sobs", "抽泣"], ["Sobbing", "啜泣"], ["Crying loudly", "大哭"],
      ["gasps", "倒吸气"], ["Gasping", "急吸气"], ["clears throat", "清嗓"], ["Clear throat", "咳嗽清嗓"],
      ["coughs", "咳嗽"], ["yawns", "打哈欠"], ["Yawning", "哈欠"], ["groans", "呻吟"],
      ["Groaning", "痛哼"], ["pants", "喘气"], ["Panting", "急喘"], ["sniffs", "吸鼻子"],
      ["Snoring", "打鼾"], ["hesitates", "迟疑"], ["breath", "换气"], ["breathless", "上气不接下气"],
    ],
  },
  {
    label: "点标签 · 停顿与音效",
    hint: "放在要停顿的地方，不是句首",
    color: "#4a8ab0",
    kind: "point",
    items: [
      ["pause", "短停顿"], ["long pause", "长停顿"], ["Pause", "停顿"],
      ["Audience laughter", "观众笑声"], ["Background laughter", "背景笑声"],
      ["Crowd laughter", "人群笑声"], ["applause", "掌声"], ["sigh", "叹息"],
    ],
  },
  {
    label: "范围标签",
    hint: "先选中文字，再点这里，会包住选中内容。没选中就插在光标处",
    color: "#7a5ab0",
    kind: "scope",
    items: [
      ["whisper", "耳语"], ["emphasis", "强调"], ["stress", "重读"],
      ["soft", "轻柔"], ["forceful", "有力"], ["slow", "放慢"], ["fast", "加快"],
    ],
  },
  {
    label: "情绪 · 基础",
    hint: "写在整句开头，管这一整句",
    color: "#6b8f4a",
    kind: "mood",
    items: [
      ["Happy", "开心"], ["Sad", "悲伤"], ["Angry", "愤怒"], ["Excited", "兴奋"],
      ["Calm", "平静"], ["Nervous", "紧张"], ["Confident", "自信"], ["Surprised", "惊讶"],
      ["Satisfied", "满意"], ["Delighted", "欣喜"], ["Scared", "害怕"], ["Worried", "担忧"],
    ],
  },
  {
    label: "情绪 · 进阶",
    hint: "更细腻的情绪，写在整句开头",
    color: "#7a9a52",
    kind: "mood",
    items: [
      ["Upset", "沮丧"], ["Frustrated", "挫败"], ["Depressed", "低落"], ["Empathetic", "共情"],
      ["Embarrassed", "尴尬"], ["Disgusted", "厌恶"], ["Moved", "感动"], ["Proud", "骄傲"],
      ["Relaxed", "放松"], ["Grateful", "感激"], ["Curious", "好奇"], ["Sarcastic", "讽刺"],
      ["Disdainful", "轻蔑"], ["Unhappy", "不开心"], ["Anxious", "焦虑"], ["Hysterical", "歇斯底里"],
      ["Indifferent", "冷淡"], ["Uncertain", "不确定"], ["Doubtful", "怀疑"], ["Confused", "困惑"],
      ["Disappointed", "失望"], ["Regretful", "后悔"], ["Guilty", "内疚"], ["Ashamed", "羞愧"],
      ["Jealous", "嫉妒"], ["Envious", "羡慕"], ["Hopeful", "充满希望"], ["Optimistic", "乐观"],
      ["Pessimistic", "悲观"], ["Nostalgic", "怀旧"], ["Lonely", "孤独"], ["Bored", "无聊"],
      ["Contemptuous", "鄙夷"], ["Sympathetic", "同情"], ["Compassionate", "怜悯"],
      ["Determined", "坚定"], ["Resigned", "认命"],
    ],
  },
  {
    label: "语气 · 声音特质",
    hint: "调整说话方式，写在整句开头",
    color: "#8a7a4a",
    kind: "mood",
    items: [
      ["Hurried tone", "急促语气"], ["Shouting", "大声喊"], ["Screaming", "尖叫"],
      ["Whispering", "低声说"], ["Soft tone", "柔和语气"], ["Breathy", "气声"],
      ["Warm", "温暖"], ["Whisper", "耳语"],
    ],
  },
];

function injectStyle() {
  if (document.getElementById("d3h-style")) return;
  const s = document.createElement("style");
  s.id = "d3h-style";
  s.textContent = `
.d3h-panel{position:fixed;z-index:99999;width:560px;max-height:640px;display:flex;flex-direction:column;
  background:#1a1a24;border:1px solid #4a6a8a;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.75);
  color:#ddd;font-size:13px;font-family:system-ui,"Microsoft YaHei",sans-serif;overflow:hidden}
.d3h-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#23232f;
  border-bottom:1px solid #35354a;cursor:move;user-select:none}
.d3h-head.dragging{background:#2d2d3f}
.d3h-grip{color:#5a5a70;font-size:14px;letter-spacing:1px;cursor:move}
.d3h-search{flex:1;background:#2a2a38;border:1px solid #40405a;border-radius:6px;color:#ddd;
  padding:5px 10px;font-size:12px;outline:none}
.d3h-search:focus{border-color:#5a8ac0}
.d3h-x{cursor:pointer;color:#888;font-size:20px;line-height:1;padding:0 4px}
.d3h-x:hover{color:#fff}
.d3h-body{overflow-y:auto;padding:10px 12px}
.d3h-body::-webkit-scrollbar{width:8px}
.d3h-body::-webkit-scrollbar-thumb{background:#3a3a4a;border-radius:4px}
.d3h-sec{margin-bottom:14px}
.d3h-sec:last-child{margin-bottom:0}
.d3h-title{font-size:12px;font-weight:600;margin-bottom:3px}
.d3h-hint{font-size:11px;color:#777;line-height:1.5;margin-bottom:7px}
.d3h-items{display:flex;flex-wrap:wrap;gap:5px}
.d3h-item{padding:4px 11px;background:#2a2a38;border:1px solid #40405a;border-radius:5px;
  cursor:pointer;font-size:12px;user-select:none;transition:all .12s}
.d3h-item:hover{color:#fff;transform:translateY(-1px)}
.d3h-toast{position:fixed;z-index:100001;left:50%;transform:translateX(-50%);top:30px;
  padding:7px 16px;border-radius:6px;font-size:12.5px;color:#dfe;background:#2d6b3f;
  box-shadow:0 4px 14px rgba(0,0,0,.55)}
.d3h-pinyin{display:flex;gap:6px;padding:8px 12px;background:#23232f;border-top:1px solid #35354a}
.d3h-pinyin input{flex:1;background:#2a2a38;border:1px solid #40405a;border-radius:5px;
  color:#ddd;padding:4px 9px;font-size:12px;outline:none}
.d3h-pinyin input:focus{border-color:#5a8ac0}
.d3h-pinyin button{background:#3d5a80;border:1px solid #5a8ac0;color:#dfe;border-radius:5px;
  padding:4px 12px;font-size:12px;cursor:pointer}
.d3h-pinyin button:hover{background:#4d6a90}
.d3h-count{font-size:11px;color:#666;padding:0 12px 8px;background:#23232f}
`;
  document.head.appendChild(s);
}

function toast(msg, ok = true) {
  document.querySelectorAll(".d3h-toast").forEach(t => t.remove());
  const t = document.createElement("div");
  t.className = "d3h-toast";
  t.style.background = ok ? "#2d6b3f" : "#6b3d2d";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1400);
}

app.registerExtension({
  name: "Drama3.LineHelper",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "Drama3Generate") return;
    injectStyle();

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const node = this;
      const w = (this.widgets || []).find(x => x.name === "text");
      if (!w) return r;

      const ta = () => w.inputEl || w.element;
      let panel = null;
      let docDown = null;
      let savedSel = [0, 0];

      const close = () => {
        if (panel) {
          if (panel._d3hKey) document.removeEventListener("keydown", panel._d3hKey, true);
          panel._d3hCleanup?.();
          panel.remove();
          panel = null;
        }
        if (docDown) { document.removeEventListener("pointerdown", docDown, true); docDown = null; }
      };

      // textarea 即使失焦也会保留自己的 selectionStart/End，所以无条件读最可靠
      const rememberSel = () => {
        const el = ta();
        if (!el) return;
        const s = el.selectionStart, e = el.selectionEnd;
        if (typeof s === "number" && typeof e === "number") savedSel = [s, e];
      };

      const commit = (newVal, caret) => {
        w.value = newVal;
        const elNow = ta();
        if (elNow) elNow.value = newVal;
        if (w.callback) w.callback(newVal);
        app.graph?.setDirtyCanvas(true, true);
        setTimeout(() => {
          const el = ta();
          if (el) {
            el.focus();
            const pos = Math.min(caret, el.value.length);
            el.setSelectionRange(pos, pos);
            savedSel = [pos, pos];
          }
        }, 0);
      };

      const curSel = () => {
        const el = ta();
        return (el && typeof el.selectionStart === "number")
          ? [el.selectionStart, el.selectionEnd]
          : savedSel;
      };

      // 点标签：光标处
      const insertPoint = (cue) => {
        const val = w.value || "";
        const [a, b] = curSel();
        const tag = `[${cue}]`;
        const before = val.slice(0, a), after = val.slice(b);
        const pad = (before && !/\s$/.test(before)) ? " " : "";
        const pad2 = (after && !/^\s/.test(after)) ? " " : "";
        commit(before + pad + tag + pad2 + after, a + pad.length + tag.length);
        toast(`已插入 ${tag}`);
      };

      // 范围标签：包住选中
      const insertScope = (cue) => {
        const val = w.value || "";
        const [a, b] = curSel();
        const sel = val.slice(a, b);
        const open = `<${cue}>`, closeT = `</${cue}>`;
        if (sel) {
          commit(val.slice(0, a) + open + sel + closeT + val.slice(b),
                 a + open.length + sel.length + closeT.length);
          toast(`已包裹「${sel}」`);
        } else {
          commit(val.slice(0, a) + open + closeT + val.slice(a), a + open.length);
          toast(`已插入 ${open}${closeT}，把要改的字放进中间`);
        }
      };

      // 整体情绪：当前行行首
      const insertMood = (cue) => {
        const val = w.value || "";
        const [a] = curSel();
        const lineStart = val.lastIndexOf("\n", Math.max(0, a - 1)) + 1;
        const tag = `[${cue}] `;
        commit(val.slice(0, lineStart) + tag + val.slice(lineStart), a + tag.length);
        toast(`已在行首加 ${tag.trim()}`);
      };

      // 拼音纠音
      const applyPinyin = (pinyinStr) => {
        const val = w.value || "";
        const [a, b] = curSel();
        const sel = val.slice(a, b);
        if (!sel) { toast("先在台词里选中要纠音的汉字", false); return; }
        const syllables = pinyinStr.trim().split(/\s+/).filter(Boolean);
        const chars = Array.from(sel).filter(c => !/\s/.test(c));
        if (syllables.length !== chars.length) {
          toast(`选了 ${chars.length} 个字，给了 ${syllables.length} 个拼音，数量要一致`, false);
          return;
        }
        let packed = "";
        for (const syl of syllables) packed += `<|phoneme_start|>${syl}<|phoneme_end|>`;
        commit(val.slice(0, a) + packed + val.slice(b), a + packed.length);
        toast(`已给 ${chars.length} 个字加音素`);
      };

      const buildPanel = () => {
        const root = document.createElement("div");
        root.className = "d3h-panel";
        ["pointerdown", "mousedown", "click", "wheel"].forEach(ev =>
          root.addEventListener(ev, e => e.stopPropagation()));

        const head = document.createElement("div");
        head.className = "d3h-head";
        const grip = document.createElement("span");
        grip.className = "d3h-grip";
        grip.textContent = "⠿";
        grip.title = "拖我移动面板";
        const search = document.createElement("input");
        search.className = "d3h-search";
        search.placeholder = "🔍 搜标签（如 耳语 / 叹 / whisper）…";
        const x = document.createElement("span");
        x.className = "d3h-x";
        x.textContent = "×";
        x.onclick = close;
        head.append(grip, search, x);
        root.appendChild(head);

        const body = document.createElement("div");
        body.className = "d3h-body";

        const sections = [];
        for (const grp of GROUPS) {
          const sec = document.createElement("div");
          sec.className = "d3h-sec";
          const t = document.createElement("div");
          t.className = "d3h-title";
          t.style.color = grp.color;
          t.textContent = grp.label;
          const h = document.createElement("div");
          h.className = "d3h-hint";
          h.textContent = grp.hint;
          const wrap = document.createElement("div");
          wrap.className = "d3h-items";

          for (const [cue, name] of grp.items) {
            const b = document.createElement("span");
            b.className = "d3h-item";
            b.textContent = name;
            b.title = grp.kind === "scope" ? `<${cue}>…</${cue}>` : `[${cue}]`;
            b.dataset.search = `${name} ${cue}`.toLowerCase();
            b.onclick = (e) => {
              e.preventDefault();
              rememberSel();
              if (grp.kind === "point") insertPoint(cue);
              else if (grp.kind === "scope") insertScope(cue);
              else insertMood(cue);
            };
            wrap.appendChild(b);
          }
          sec.append(t, h, wrap);
          body.appendChild(sec);
          sections.push(sec);
        }
        root.appendChild(body);

        const count = document.createElement("div");
        count.className = "d3h-count";
        const total = GROUPS.reduce((n, g) => n + g.items.length, 0);
        count.textContent = `共 ${total} 个标签 · 拖⠿移动 · 点×或按 Esc 关闭`;
        root.appendChild(count);

        const py = document.createElement("div");
        py.className = "d3h-pinyin";
        const pyIn = document.createElement("input");
        pyIn.placeholder = "拼音纠音：选中汉字后填音节，如 zhong4 yao4";
        const pyBtn = document.createElement("button");
        pyBtn.textContent = "应用";
        pyBtn.onclick = () => { rememberSel(); applyPinyin(pyIn.value || ""); };
        pyIn.onkeydown = (e) => {
          if (e.key === "Enter") { e.preventDefault(); rememberSel(); applyPinyin(pyIn.value || ""); }
        };
        py.append(pyIn, pyBtn);
        root.appendChild(py);

        search.oninput = () => {
          const q = search.value.trim().toLowerCase();
          for (const sec of sections) {
            let any = false;
            sec.querySelectorAll(".d3h-item").forEach(el => {
              const hit = !q || el.dataset.search.includes(q);
              el.style.display = hit ? "" : "none";
              if (hit) any = true;
            });
            sec.style.display = any ? "" : "none";
          }
        };

        // 拖动：按住把手或头部空白
        let dragging = false, ox = 0, oy = 0;
        const onMove = (e) => {
          if (!dragging) return;
          e.preventDefault();
          const w2 = root.offsetWidth, h2 = root.offsetHeight;
          root.style.left = Math.max(0, Math.min(e.clientX - ox, innerWidth - w2)) + "px";
          root.style.top = Math.max(0, Math.min(e.clientY - oy, innerHeight - h2)) + "px";
        };
        const endDrag = () => {
          if (!dragging) return;
          dragging = false;
          head.classList.remove("dragging");
          try {
            localStorage.setItem("d3h-pos", JSON.stringify({
              left: root.style.left, top: root.style.top,
            }));
          } catch (_) {}
        };
        const startDrag = (e) => {
          if (e.target === search || e.target === x) return;
          dragging = true;
          head.classList.add("dragging");
          const rc = root.getBoundingClientRect();
          ox = e.clientX - rc.left;
          oy = e.clientY - rc.top;
          e.preventDefault();
          e.stopPropagation();
        };
        grip.addEventListener("mousedown", startDrag);
        head.addEventListener("mousedown", startDrag);
        window.addEventListener("mousemove", onMove, true);
        window.addEventListener("mouseup", endDrag, true);
        root._d3hCleanup = () => {
          window.removeEventListener("mousemove", onMove, true);
          window.removeEventListener("mouseup", endDrag, true);
          if (root._d3hKey) document.removeEventListener("keydown", root._d3hKey, true);
        };

        setTimeout(() => search.focus(), 30);
        return root;
      };

      const openPanel = () => {
        rememberSel();
        if (panel) { close(); return; }
        panel = buildPanel();
        document.body.appendChild(panel);
        let restored = false;
        try {
          const saved = JSON.parse(localStorage.getItem("d3h-pos") || "null");
          if (saved && saved.left && saved.top) {
            panel.style.left = saved.left;
            panel.style.top = saved.top;
            restored = true;
          }
        } catch (_) {}
        if (!restored) {
          panel.style.left = Math.max(10, innerWidth - 600) + "px";
          panel.style.top = "80px";
        }
        // ★ 不做「点外面自动关闭」。
        // 原因：ComfyUI 0.39.2 把文本框画在 canvas 上，textarea 是 0×0 的隐藏层，
        // 点台词框（单击/双击/拖选）时 e.target 永远是 CANVAS，跟"点空白画布"无法区分，
        // 一定会误关。改成手动关：点 × 或按 Esc。
        setTimeout(() => {
          const onKey = (e) => {
            if (e.key === "Escape") { close(); }
          };
          document.addEventListener("keydown", onKey, true);
          root._d3hKey = onKey;
        }, 0);
      };

      const el = ta();
      if (el) {
        ["keyup", "mouseup", "click", "select"].forEach(ev =>
          el.addEventListener(ev, rememberSel));
      }

      try {
        const bw = this.addWidget("button", "🏷 台词助手（标签 / 拼音）", null, openPanel);
        if (bw) bw.serialize = false;
      } catch (e) {
        console.error("[Drama3] 加按钮失败", e);
      }

      return r;
    };
  },
});
