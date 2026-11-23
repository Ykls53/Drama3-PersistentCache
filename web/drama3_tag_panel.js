// Drama 3 情绪标签快捷面板
// 给 Drama3Generate 节点加一个「🏷 插入情绪标签」按钮，点开分类面板，点标签追加到 text 末尾。
// 标签表提取自 Drama3-Studio 的 i18n.js（中文为准）。

const { app } = window.comfyAPI.app;

console.log("[Drama3-TagPanel] 脚本已加载");

const TAG_GROUPS = {
  "基础情绪": [
    ["Happy", "开心"], ["Sad", "悲伤"], ["Angry", "愤怒"], ["Excited", "兴奋"],
    ["Calm", "平静"], ["Nervous", "紧张"], ["Confident", "自信"], ["Surprised", "惊讶"],
    ["Satisfied", "满意"], ["Delighted", "欣喜"], ["Scared", "害怕"], ["Worried", "担忧"],
  ],
  "进阶情绪": [
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
  "声音与语气": [
    ["Hurried tone", "急促语气"], ["Shouting", "大声喊"], ["Screaming", "尖叫"],
    ["Whispering", "低声说"], ["Soft tone", "柔和语气"], ["Breathy", "气声"],
    ["Warm", "温暖"], ["Whisper", "耳语"], ["Emphasis", "强调"], ["Soft", "轻柔"],
    ["Faster", "加快"], ["Slower", "放慢"], ["Stress", "重读"], ["Forceful", "有力"],
  ],
  "人声": [
    ["Laughing", "大笑"], ["Chuckling", "轻笑"], ["Sobbing", "抽泣"], ["Crying loudly", "大哭"],
    ["Sighing", "叹气"], ["Groaning", "呻吟"], ["Panting", "喘气"], ["Gasping", "倒吸气"],
    ["Yawning", "打哈欠"], ["Snoring", "打鼾"], ["Clear throat", "清嗓"],
  ],
  "音效与停顿": [
    ["Short pause", "短停顿"], ["Long pause", "长停顿"], ["Pause", "停顿"],
    ["Audience laughter", "观众笑声"], ["Background laughter", "背景笑声"], ["Crowd laughter", "人群笑声"],
  ],
};

function injectStyle() {
  if (document.getElementById("drama3-tag-style")) return;
  const s = document.createElement("style");
  s.id = "drama3-tag-style";
  s.textContent = `
    .d3-panel { position: fixed; z-index: 99999;
      width: 460px; max-height: 500px; overflow-y: auto;
      background: #1e1e28; border: 1px solid #5a8ac0; border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0,0,0,.7); padding: 12px; color: #ddd;
      font-size: 13px; font-family: system-ui, "Microsoft YaHei", sans-serif; }
    .d3-panel h4 { margin: 10px 0 6px; font-size: 12px; color: #7ab; font-weight: 600; }
    .d3-panel h4:first-of-type { margin-top: 4px; }
    .d3-item { display: inline-block; margin: 3px 4px 3px 0; padding: 4px 10px;
      background: #2a2a35; border: 1px solid #404050; border-radius: 5px;
      cursor: pointer; font-size: 12px; user-select: none; transition: .12s; }
    .d3-item:hover { background: #3d5a80; border-color: #5a8ac0; color: #fff; }
    .d3-close { float: right; cursor: pointer; color: #888; font-size: 20px; line-height: 1; }
    .d3-close:hover { color: #fff; }
    .d3-hint { color: #777; font-size: 11px; margin-bottom: 8px; line-height: 1.6; }
    .d3-toast { position: fixed; z-index: 100000; left: 50%; transform: translateX(-50%);
      top: 40px; background: #2d6b3f; color: #dfd; padding: 8px 18px; border-radius: 6px;
      font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,.5); }
  `;
  document.head.appendChild(s);
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "d3-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1200);
}

app.registerExtension({
  name: "Drama3.TagPanel",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "Drama3Generate") return;
    console.log("[Drama3-TagPanel] 已挂钩 Drama3Generate");
    injectStyle();

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const node = this;
      const textWidget = this.widgets?.find((w) => w.name === "text");
      if (!textWidget) {
        console.warn("[Drama3-TagPanel] 找不到 text widget");
        return r;
      }

      let panel = null;
      let docHandler = null;

      const closePanel = () => {
        if (panel) { panel.remove(); panel = null; }
        if (docHandler) {
          document.removeEventListener("pointerdown", docHandler, true);
          docHandler = null;
        }
      };

      const insertTag = (en) => {
        const cur = textWidget.value || "";
        const sep = (!cur || cur.endsWith("\n") || cur.endsWith(" ")) ? "" : " ";
        textWidget.value = cur + sep + "[" + en + "] ";
        if (textWidget.callback) textWidget.callback(textWidget.value);
        if (app.graph) app.graph.setDirtyCanvas(true, true);
        toast("已插入 [" + en + "]");
      };

      const buildPanel = () => {
        const p = document.createElement("div");
        p.className = "d3-panel";
        ["pointerdown", "mousedown", "click"].forEach((ev) =>
          p.addEventListener(ev, (e) => e.stopPropagation()));

        const close = document.createElement("span");
        close.className = "d3-close";
        close.textContent = "×";
        close.onclick = closePanel;
        p.appendChild(close);

        const hint = document.createElement("div");
        hint.className = "d3-hint";
        hint.textContent = "点标签追加到台词末尾 · 行首管整句，句中只管那个位置";
        p.appendChild(hint);

        for (const group in TAG_GROUPS) {
          const h = document.createElement("h4");
          h.textContent = group;
          p.appendChild(h);
          const items = TAG_GROUPS[group];
          for (let i = 0; i < items.length; i++) {
            const en = items[i][0], zh = items[i][1];
            const b = document.createElement("span");
            b.className = "d3-item";
            b.textContent = zh;
            b.title = "插入 [" + en + "]";
            b.onclick = function (e) {
              e.preventDefault();
              e.stopPropagation();
              insertTag(en);
            };
            p.appendChild(b);
          }
        }
        return p;
      };

      const openPanel = (anchorRect) => {
        closePanel();
        panel = buildPanel();
        document.body.appendChild(panel);
        if (anchorRect) {
          panel.style.left = Math.max(10, Math.min(anchorRect.left, window.innerWidth - 480)) + "px";
          panel.style.top = Math.max(10, Math.min(anchorRect.bottom + 6, window.innerHeight - 520)) + "px";
        } else {
          panel.style.left = "240px";
          panel.style.top = "140px";
        }
        setTimeout(function () {
          docHandler = function (e) {
            if (panel && !panel.contains(e.target)) closePanel();
          };
          document.addEventListener("pointerdown", docHandler, true);
        }, 0);
      };

      // 用 ComfyUI 自带的 addWidget（0.39.2 支持）
      try {
        const w = this.addWidget("button", "🏷 插入情绪标签", null, () => {
          const cv = app.canvas && app.canvas.canvas;
          openPanel(cv ? cv.getBoundingClientRect() : null);
        });
        if (w) {
          w.serialize = false;
          console.log("[Drama3-TagPanel] 按钮已添加");
        } else {
          console.warn("[Drama3-TagPanel] addWidget 返回空");
        }
      } catch (e) {
        console.error("[Drama3-TagPanel] addWidget 失败:", e);
        // 回退：直接 push 一个自定义 widget
        this.widgets.push({
          type: "button",
          name: "🏷 插入情绪标签",
          value: "",
          serialize: false,
          options: { serialize: false },
          draw(ctx, n, widgetWidth, y, H) {
            ctx.save();
            ctx.fillStyle = "#2d4a6b";
            ctx.strokeStyle = "#5a8ac0";
            ctx.lineWidth = 1;
            const x = 15, w2 = widgetWidth - 30, h = H - 4;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x, y + 2, w2, h, 5);
            else ctx.rect(x, y + 2, w2, h);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = "#cde";
            ctx.font = "12px system-ui, 'Microsoft YaHei', sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("🏷 插入情绪标签", x + w2 / 2, y + 2 + h / 2);
            ctx.restore();
          },
          mouse(e, pos, n) {
            if (e.type === "pointerdown") {
              const cv = app.canvas && app.canvas.canvas;
              openPanel(cv ? cv.getBoundingClientRect() : null);
              return true;
            }
            return false;
          },
        });
      }

      return r;
    };
  },
});
