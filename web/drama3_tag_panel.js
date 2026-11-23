// Drama 3 台词助手 —— 情绪标签 + 拼音纠音
//
// 设计原则：
//   1. 在光标处插入，不是只往末尾追加
//   2. 选中文字后点「范围标签」会包住它（<whisper>...</whisper>）
//   3. 严格按官方语法分三类：点标签 / 范围标签 / 整体情绪
//   4. 搜索 + 键盘操作，标签多也不难找
//   5. 插入后焦点回到文本框，光标跳到插入内容之后，连点不打断

const { app } = window.comfyAPI.app;

const GROUPS = {
  point: {
    label: "点标签",
    hint: "放在光标处，只在那里响一声。例：好 [sighs] 就这样",
    color: "#4a7ab0",
    items: [
      ["sighs", "叹气"], ["laughs", "笑"], ["chuckles", "轻笑"],
      ["gasps", "倒吸气"], ["clears throat", "清嗓"], ["coughs", "咳嗽"],
      ["yawns", "打哈欠"], ["sobs", "抽泣"], ["groans", "呻吟"],
      ["pants", "喘气"], ["sniffs", "吸鼻子"], ["hesitates", "迟疑"],
      ["pause", "短停顿"], ["long pause", "长停顿"], ["breath", "换气"],
    ],
  },
  scope: {
    label: "范围标签",
    hint: "先选中文字，再点这里，会包住选中内容。没选中就插在光标处",
    color: "#7a5ab0",
    items: [
      ["whisper", "耳语"], ["emphasis", "强调"], ["stress", "重读"],
      ["soft", "轻柔"], ["forceful", "有力"], ["slow", "放慢"],
      ["fast", "加快"],
    ],
  },
  mood: {
    label: "整体情绪",
    hint: "写在整句开头，管这一整句",
    color: "#6b8f4a",
    items: [
      ["平静", "平静"], ["愤怒", "愤怒"], ["悲伤", "悲伤"], ["开心", "开心"],
      ["焦虑", "焦虑"], ["疲惫", "疲惫"], ["温柔", "温柔"], ["冷淡", "冷淡"],
      ["兴奋", "兴奋"], ["紧张", "紧张"], ["讽刺", "讽刺"], ["坚定", "坚定"],
      ["委屈", "委屈"], ["撒娇", "撒娇"], ["妩媚", "妩媚"], ["清冷", "清冷"],
    ],
  },
};

function injectStyle() {
  if (document.getElementById("d3h-style")) return;
  const s = document.createElement("style");
  s.id = "d3h-style";
  s.textContent = `
.d3h-panel{position:fixed;z-index:99999;width:520px;max-height:580px;display:flex;flex-direction:column;
  background:#1a1a24;border:1px solid #4a6a8a;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.75);
  color:#ddd;font-size:13px;font-family:system-ui,"Microsoft YaHei",sans-serif;overflow:hidden}
.d3h-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#23232f;border-bottom:1px solid #35354a}
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
.d3h-item.hit{background:#3d5a80;border-color:#6a9acd;color:#fff}
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

      // textarea 是真实 DOM，能拿光标
      const ta = () => w.inputEl || w.element;
      let panel = null;
      let docDown = null;
      let savedSel = [0, 0];

      const close = () => {
        if (panel) { panel.remove(); panel = null; }
        if (docDown) { document.removeEventListener("pointerdown", docDown, true); docDown = null; }
      };

      // textarea 即使失焦也会保留自己的 selectionStart/End，所以无条件读一次最可靠。
      // 用户点了按钮 → 焦点离开 textarea，但选区还在它自己身上。
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
        // 焦点回文本框，光标放到插入内容之后
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

      // 点标签：插在光标处
      const insertPoint = (cue) => {
        const el = ta();
        const val = w.value || "";
        const [a, b] = (el && typeof el.selectionStart === "number")
          ? [el.selectionStart, el.selectionEnd]
          : savedSel;
        const tag = `[${cue}]`;
        const before = val.slice(0, a);
        const after = val.slice(b);
        const pad = (before && !/\s$/.test(before)) ? " " : "";
        const pad2 = (after && !/^\s/.test(after)) ? " " : "";
        commit(before + pad + tag + pad2 + after, a + pad.length + tag.length);
        close();
      };

      // 范围标签：有选中就包住，没选中就插空的标签对
      const insertScope = (cue) => {
        const el = ta();
        const val = w.value || "";
        const [a, b] = (el && typeof el.selectionStart === "number")
          ? [el.selectionStart, el.selectionEnd]
          : savedSel;
        const sel = val.slice(a, b);
        const open = `<${cue}>`;
        const closeT = `</${cue}>`;
        let out, caret;
        if (sel) {
          out = val.slice(0, a) + open + sel + closeT + val.slice(b);
          caret = a + open.length + sel.length + closeT.length;
          toast(`已包裹：${sel.length} 个字`);
        } else {
          out = val.slice(0, a) + open + closeT + val.slice(a);
          caret = a + open.length;
          toast(`已插入 ${open}${closeT}，把要改的文字放进中间`);
        }
        commit(out, caret);
        close();
      };

      // 整体情绪：写在句首（当前行开头）
      const insertMood = (cue) => {
        const el = ta();
        const val = w.value || "";
        const [a] = el && document.activeElement === el
          ? [el.selectionStart ?? 0, el.selectionEnd ?? 0]
          : savedSel;
        // 找到当前行的起点
        const lineStart = val.lastIndexOf("\n", Math.max(0, a - 1)) + 1;
        const tag = `[${cue}] `;
        const out = val.slice(0, lineStart) + tag + val.slice(lineStart);
        commit(out, a + tag.length);
        close();
      };

      // 拼音纠音：给选中的字加音素标记
      const applyPinyin = (pinyinStr) => {
        const el = ta();
        const val = w.value || "";
        const [a, b] = (el && typeof el.selectionStart === "number")
          ? [el.selectionStart, el.selectionEnd]
          : savedSel;
        const sel = val.slice(a, b);
        if (!sel) { toast("先在台词里选中要纠音的汉字", false); return; }

        // 拼音按空格分开，一个汉字一个音节
        const syllables = pinyinStr.trim().split(/\s+/).filter(Boolean);
        const chars = Array.from(sel).filter(c => !/\s/.test(c));
        if (syllables.length !== chars.length) {
          toast(`选了 ${chars.length} 个字，但给了 ${syllables.length} 个拼音，数量要一致`, false);
          return;
        }
        let packed = "";
        for (const syl of syllables) {
          packed += `<|phoneme_start|>${syl}<|phoneme_end|>`;
        }
        const out = val.slice(0, a) + packed + val.slice(b);
        commit(out, a + packed.length);
        close();
      };

      const buildPanel = () => {
        const root = document.createElement("div");
        root.className = "d3h-panel";
        ["pointerdown", "mousedown", "click", "wheel"].forEach(ev =>
          root.addEventListener(ev, e => e.stopPropagation()));

        // 头部：搜索
        const head = document.createElement("div");
        head.className = "d3h-head";
        const search = document.createElement("input");
        search.className = "d3h-search";
        search.placeholder = "🔍 搜标签（如 耳语 / 叹 / whisper）…";
        const x = document.createElement("span");
        x.className = "d3h-x";
        x.textContent = "×";
        x.onclick = close;
        head.append(search, x);
        root.appendChild(head);

        // 主体
        const body = document.createElement("div");
        body.className = "d3h-body";

        const sections = {};
        for (const [key, grp] of Object.entries(GROUPS)) {
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
            b.title = key === "scope" ? `<${cue}>…</${cue}>` :
                      key === "point" ? `[${cue}]` : `[${cue}]`;
            b.dataset.search = `${name} ${cue}`.toLowerCase();
            b.onclick = (e) => {
              e.preventDefault();
              rememberSel();
              if (key === "point") insertPoint(cue);
              else if (key === "scope") insertScope(cue);
              else insertMood(cue);
            };
            wrap.appendChild(b);
          }
          sec.append(t, h, wrap);
          body.appendChild(sec);
          sections[key] = sec;
        }
        root.appendChild(body);

        // 底部：拼音纠音
        const py = document.createElement("div");
        py.className = "d3h-pinyin";
        const pyIn = document.createElement("input");
        pyIn.placeholder = "拼音纠音：选中汉字后填音节，如 zhong4 yao4";
        const pyBtn = document.createElement("button");
        pyBtn.textContent = "应用";
        pyBtn.onclick = () => {
          rememberSel();
          applyPinyin(pyIn.value || "");
        };
        pyIn.onkeydown = (e) => {
          if (e.key === "Enter") { e.preventDefault(); rememberSel(); applyPinyin(pyIn.value || ""); }
        };
        py.append(pyIn, pyBtn);
        root.appendChild(py);

        // 搜索过滤
        search.oninput = () => {
          const q = search.value.trim().toLowerCase();
          for (const [key, grp] of Object.entries(GROUPS)) {
            const sec = sections[key];
            let any = false;
            sec.querySelectorAll(".d3h-item").forEach(el => {
              const hit = !q || el.dataset.search.includes(q);
              el.style.display = hit ? "" : "none";
              if (hit) any = true;
            });
            sec.style.display = any ? "" : "none";
          }
        };
        setTimeout(() => search.focus(), 30);
        return root;
      };

      const openPanel = () => {
        rememberSel();
        if (panel) { close(); return; }
        panel = buildPanel();
        document.body.appendChild(panel);
        const el = ta();
        const rect = el?.getBoundingClientRect();
        if (rect) {
          panel.style.left = Math.max(10, Math.min(rect.left, innerWidth - 540)) + "px";
          panel.style.top = Math.max(10, Math.min(rect.top, innerHeight - 600)) + "px";
        } else {
          panel.style.left = "220px";
          panel.style.top = "120px";
        }
        setTimeout(() => {
          docDown = (e) => { if (panel && !panel.contains(e.target)) close(); };
          document.addEventListener("pointerdown", docDown, true);
        }, 0);
      };

      // 记住用户最后一次在文本框里的选区
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
