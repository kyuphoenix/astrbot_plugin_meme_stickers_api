# astrbot_plugin_meme_stickers_api

> 🚀 **Meme Stickers 表情包制作 API 轻量版**  
> 面向 AstrBot 设计，**无需本地安装 `skia-python` 与底层 C++ 图形库 (`libEGL.so.1` / `libGL.so.1`)**，彻底解决 Docker / 无头服务器安装环境报错难题！

---

## ✨ 核心特性

- 🪶 **极致轻量**：仅依赖纯 Python 异步网络库 `httpx`，插件体积不到 100KB，安装仅需 1 秒。
- 🛡️ **零环境报错**：彻底摆脱 `skia-python` 依赖，不再需要安装系统级 `libegl1`、`libgl1`、`fontconfig`。无论是轻量 Alpine Docker、Termux 还是资源受限的云服务器，均能开箱即用。
- ⚡ **Serverless 云端渲染**：绘图逻辑由部署在 Node.js（基于 `@napi-rs/canvas`）或 Vercel Serverless 的后端服务驱动，秒级并发响应。
- 🎮 **双模式体验**：
  - **一键快捷生成**：直接发送 `/pjsk 1 早上好` 或 `/pjsk 早上好` 即可秒出图。
  - **交互式向导**：直接发送 `/pjsk` 或 `/arc`，机器人会交互引导选择分类、表情并输入文字。
- 🎨 **高级排版参数**：支持自定义字号 (`-s`)、旋转角度 (`-r`)、文字颜色 (`-c`)、描边颜色 (`-C`)、对齐方式 (`-a`) 与坐标定位 (`-x`/`-y`)。

---

## 🛠️ 配置说明 (`_conf_schema.json`)

在 AstrBot Web 控制台的插件配置面板中可直接修改：

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `server_url` | `string` | `http://127.0.0.1:3000` | 渲染后端地址（本地 Node 服务或已部署的 Vercel / 云函数直链） |
| `quote_reply` | `bool` | `true` | 是否在发送表情包时引用触发消息 |
| `timeout` | `int` | `15` | 网络请求超时时间（秒，范围 5~60） |
| `default_format`| `string` | `png` | 默认生成图片格式 (`png` 或 `jpeg`) |

---

## 📖 指令列表

### 1. 快捷制作指令
- `/pjsk <贴纸名> <文本>`：使用指定 pjsk 贴纸生成，例如 `/pjsk 1 早上好` 或 `/pjsk hsk_01 打工人集合`
- `/pjsk <文本>`：使用默认贴纸快速生成，例如 `/pjsk 开摆`
- `/pjsk`：进入交互式制作向导
- `/arc <贴纸名> <文本>`：Arcaea 贴纸快捷制作
- `/arc`：进入 Arcaea 交互式制作向导

### 2. 主指令 (`/meme-stickers`)
- `/meme-stickers help`：查看帮助文档
- `/meme-stickers status`：测试与后端的连通性，查看渲染引擎、在线延迟、贴纸总数及 Playground 地址
- `/meme-stickers list`：获取后端支持的所有贴纸包列表与分类数量
- `/meme-stickers generate <pack_slug> <sticker_name> <text> [参数]`：跨贴纸包生成表情

### 3. 高级排版参数
在任意生成指令后追加参数即可生效：
```text
-s, --font-size <字号>        例如: -s 48
-r, --rotate <角度>           例如: -r 15
-a, --align <left|center|right> 例如: -a right
-c, --color <颜色>            例如: -c #ff5500 或 -c 255,85,0
-C, --stroke-color <颜色>     例如: -C #ffffff
-W, --stroke-width <倍数>     例如: -W 0.25
-x <坐标>, -y <坐标>          例如: -x 120 -y 80
-f, --format <png|jpeg>       例如: -f jpeg
```

---

## 🌐 配套 Node.js / Serverless 渲染后端

本插件依赖 `meme-stickers-node` 服务端提供渲染支持：
- **本地运行**：
  ```bash
  cd meme-stickers-node
  pnpm install
  pnpm start
  # 服务将在 http://127.0.0.1:3000 启动
  ```
- **Serverless 部署**：
  直接将 `meme-stickers-node` 项目导入 Vercel 或其他平台，一键免费上线为公共 API 服务。
- **Playground 在线体验**：
  访问 `http://<server_url>/playground` 即可使用纯前端实时渲染的交互式表情包生成器。
