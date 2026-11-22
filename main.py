import asyncio
import base64
from dataclasses import dataclass
from pathlib import Path
import tempfile
import time
from typing import Optional, Dict, Any, List

import httpx

try:
    from astrbot.api.web import request, json_response, error_response
except ImportError:
    request, json_response, error_response = None, None, None

if json_response is None:
    try:
        from aiohttp import web
        def json_response(data, status_code=200):
            return web.json_response(data, status=status_code)
        def error_response(msg, status_code=400):
            return web.json_response({"status": "error", "message": str(msg)}, status=status_code)
    except Exception:
        def json_response(data, status_code=200):
            return data
        def error_response(msg, status_code=400):
            return {"status": "error", "message": str(msg)}

try:
    from astrbot.api.event import filter, AstrMessageEvent
    from astrbot.api.all import AstrBotConfig
    from astrbot.api.star import Context, Star, StarTools
    from astrbot.api import logger
    import astrbot.api.message_components as Comp
except ImportError:
    # Stubs for local testing without AstrBot installed
    class Star:
        def __init__(self, context=None):
            self.context = context
    class Context:
        pass
    class AstrBotConfig(dict):
        pass
    class StarTools:
        @classmethod
        def get_data_dir(cls, *args, **kwargs):
            return Path(tempfile.gettempdir())
    class Comp:
        class Reply:
            def __init__(self, id): self.id = id
        class Plain:
            def __init__(self, text): self.text = text
        class Image:
            @classmethod
            def fromFileSystem(cls, path): return f"[Image: {path}]"
    class filter:
        class EventMessageType:
            ALL = "all"
            GROUP_MESSAGE = "group"
            PRIVATE_MESSAGE = "private"
        @staticmethod
        def command(*args, **kwargs):
            return lambda fn: fn
        @staticmethod
        def event_message_type(*args, **kwargs):
            return lambda fn: fn
    class AstrMessageEvent:
        pass
    import logging
    logger = logging.getLogger("astrbot_plugin_meme_stickers_api")


HELP_TEXT = """✨ Meme Stickers API (Node.js/Serverless 轻量版) ✨
指令列表：
/meme-stickers help                 - 查看此帮助说明
/meme-stickers status               - 查看 Node.js 渲染后端服务运行状态与延迟
/meme-stickers list                 - 查看后端支持的贴纸包列表与分类
/meme-stickers generate <pack> <sticker> <text> [参数] - 指定贴纸生成表情包
/pjsk [sticker] <text>              - 快捷制作 Project Sekai 贴纸 (支持一键生成或交互模式)
/arc [sticker] <text>               - 快捷制作 Arcaea 贴纸

支持的高级生成参数：
-s <字号>    -r <旋转角度>    -a <left|center|right>
-c <文字颜色> -C <描边颜色>    -x <X坐标>    -y <Y坐标>
""".strip()


@dataclass
class SessionState:
    mode: str
    step: str
    pack_slug: Optional[str] = None
    category: Optional[str] = None
    sticker_name: Optional[str] = None
    targets: Optional[List[str]] = None
    expires_at: float = 0.0
    invalid_count: int = 0


class MemeStickersApiPlugin(Star):
    SESSION_TIMEOUT_SECONDS = 90
    sessions: Dict[str, SessionState] = {}
    _terminated: bool = False

    def __init__(self, context: Context, config: Optional[AstrBotConfig] = None, *args, **kwargs):
        super().__init__(context)
        self.config = config or {}
        raw_url = str(self.config.get("server_url") or "http://127.0.0.1:3000").strip()
        self.server_url = raw_url.rstrip("/")
        self.quote_reply = bool(self.config.get("quote_reply", True))
        self.timeout = float(self.config.get("timeout", 15))
        self.default_format = str(self.config.get("default_format", "png")).lower()
        
        self.sessions = {}
        self._terminated = False
        self._packs_cache: Optional[Dict[str, Any]] = None
        self._packs_cache_time: float = 0.0
        self._cache_ttl: float = 300.0  # 缓存 5 分钟
        self.PLUGIN_NAME = "astrbot_plugin_meme_stickers_api"
        # 若是本地地址，禁用系统环境变量代理以避免 127.0.0.1 请求被本地梯子拦截
        self._is_local = "127.0.0.1" in self.server_url or "localhost" in self.server_url
        self._register_web_apis()

    async def initialize(self) -> None:
        self._terminated = False
        if not hasattr(self, "sessions") or self.sessions is None:
            self.sessions = {}

    async def terminate(self) -> None:
        self._terminated = True
        if hasattr(self, "sessions") and self.sessions:
            self.sessions.clear()

    def _get_sessions(self) -> Dict[str, SessionState]:
        if not hasattr(self, "sessions") or self.sessions is None:
            self.sessions = {}
        return self.sessions

    def _create_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=self.timeout, trust_env=not self._is_local)

    def _sid(self, event: AstrMessageEvent) -> str:
        gid = getattr(event, "get_group_id", lambda: "")()
        uid = getattr(event, "get_sender_id", lambda: "")()
        return f"{gid}:{uid}"

    @staticmethod
    def _now() -> float:
        return time.time()

    def _new_session(self, **kwargs) -> SessionState:
        return SessionState(expires_at=self._now() + self.SESSION_TIMEOUT_SECONDS, **kwargs)

    def _touch_session(self, st: SessionState):
        st.expires_at = self._now() + self.SESSION_TIMEOUT_SECONDS

    @staticmethod
    def _is_exit(txt: str) -> bool:
        return txt.lower() in {
            "0", "q", "quit", "exit", "cancel",
            "退出", "取消", "算了", "不弄了", "关闭", "结束", "退出制作"
        }

    @staticmethod
    def _is_back(txt: str) -> bool:
        return txt.lower() in {"r", "b", "back", "return", "返回", "上一级", "上一步"}

    def _plain(self, event: AstrMessageEvent, text: str):
        if self.quote_reply and hasattr(event, "message_obj") and hasattr(event.message_obj, "message_id"):
            reply = Comp.Reply(id=event.message_obj.message_id)
            return event.chain_result([reply, Comp.Plain(text)])
        return event.plain_result(text)

    async def _send_image(self, event: AstrMessageEvent, data: bytes, suffix: str = "api", ext: str = "png"):
        p = Path(tempfile.gettempdir()) / f"meme_{suffix}_{id(event)}_{time.time_ns()}.{ext}"
        p.write_bytes(data)
        try:
            if self.quote_reply and hasattr(event, "message_obj") and hasattr(event.message_obj, "message_id"):
                reply = Comp.Reply(id=event.message_obj.message_id)
                img = Comp.Image.fromFileSystem(str(p))
                yield event.chain_result([reply, img])
                return
            yield event.image_result(str(p))
        finally:
            p.unlink(missing_ok=True)

    async def _fetch_packs(self, force: bool = False) -> Dict[str, Any]:
        now = self._now()
        if not force and self._packs_cache and (now - self._packs_cache_time < self._cache_ttl):
            return self._packs_cache

        url = f"{self.server_url}/api/packs"
        async with self._create_client() as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
            packs = data.get("data", {})
            self._packs_cache = packs
            self._packs_cache_time = now
            return packs

    async def _call_generate_api(self, payload: dict) -> bytes:
        url = f"{self.server_url}/api/generate"
        async with self._create_client() as client:
            resp = await client.post(url, json=payload)
            if resp.status_code != 200:
                try:
                    err_json = resp.json()
                    err_msg = err_json.get("message") or err_json.get("error") or resp.text
                except Exception:
                    err_msg = resp.text
                raise RuntimeError(f"渲染服务返回错误 ({resp.status_code}): {err_msg}")

            res_json = resp.json()
            if res_json.get("status") != "ok":
                raise RuntimeError(res_json.get("message", "未知生成错误"))

            data_uri = res_json.get("data", {}).get("data_uri", "")
            if not data_uri or "," not in data_uri:
                raise RuntimeError("渲染服务未返回合法的图片数据")

            _, b64_data = data_uri.split(",", 1)
            return base64.b64decode(b64_data)

    async def _call_grid_api(self, pack_slug: str, category: Optional[str] = None) -> bytes:
        url = f"{self.server_url}/api/grid"
        params = {"pack": pack_slug, "format": "jpeg"}
        if category:
            params["category"] = category
        # 网格渲染需加载多张贴纸，给予更充裕的超时时间（至少 45s）
        timeout = max(45.0, self.timeout * 2)
        async with httpx.AsyncClient(timeout=timeout, trust_env=not self._is_local) as client:
            resp = await client.get(url, params=params)
            if resp.status_code != 200:
                try:
                    err = resp.json()
                    msg = err.get("message") or resp.text
                except Exception:
                    msg = resp.text
                raise RuntimeError(f"预览网格生成失败 ({resp.status_code}): {msg}")
            return resp.content

    @staticmethod
    def _parse_generate_args(tokens: List[str]) -> tuple[dict, List[str]]:
        opts, text_parts = {}, []
        i = 0
        while i < len(tokens):
            t = tokens[i]
            if t in {"-A", "--auto-resize"}:
                opts["auto_resize"] = True
                i += 1
                continue
            if t in {"-N", "--no-auto-resize"}:
                opts["auto_resize"] = False
                i += 1
                continue
            if t in {"-s", "--font-size", "--size"} and i + 1 < len(tokens):
                opts["font_size"] = tokens[i + 1]
                i += 2
                continue
            if t in {"-r", "--rotate"} and i + 1 < len(tokens):
                opts["text_rotate_degrees"] = tokens[i + 1]
                i += 2
                continue
            if t in {"-a", "--align"} and i + 1 < len(tokens):
                opts["text_align"] = tokens[i + 1]
                i += 2
                continue
            if t in {"-c", "--color"} and i + 1 < len(tokens):
                opts["text_color"] = tokens[i + 1]
                i += 2
                continue
            if t in {"-C", "--stroke", "--stroke-color"} and i + 1 < len(tokens):
                opts["stroke_color"] = tokens[i + 1]
                i += 2
                continue
            if t in {"-W", "--stroke-width"} and i + 1 < len(tokens):
                opts["stroke_width_factor"] = tokens[i + 1]
                i += 2
                continue
            if t in {"-x", "--x"} and i + 1 < len(tokens):
                opts["text_x"] = tokens[i + 1]
                i += 2
                continue
            if t in {"-y", "--y"} and i + 1 < len(tokens):
                opts["text_y"] = tokens[i + 1]
                i += 2
                continue
            if t in {"-f", "--format"} and i + 1 < len(tokens):
                opts["image_format"] = tokens[i + 1].lower()
                i += 2
                continue
            text_parts.append(t)
            i += 1
        return opts, text_parts

    @filter.command("meme-stickers", alias={"stickers", "ms"})
    async def meme_stickers_cmd(self, event: AstrMessageEvent):
        """Meme Stickers API 主命令"""
        if hasattr(event, "stop_event"):
            event.stop_event()

        msg = event.get_message_str().strip()
        parts = msg.split()
        args = parts[1:] if len(parts) > 1 else []
        sub = args[0].lower() if args else "help"

        if sub in {"help", "帮助", "菜单"}:
            yield self._plain(event, HELP_TEXT)
            return

        if sub in {"status", "状态", "ping"}:
            t0 = time.time()
            try:
                url = f"{self.server_url}/api/status"
                async with self._create_client() as client:
                    resp = await client.get(url)
                    latency = int((time.time() - t0) * 1000)
                    resp.raise_for_status()
                    data = resp.json()

                engine = data.get("engine", "@napi-rs/canvas")
                platform = data.get("platform", "Node.js (Serverless)")
                p_count = data.get("packs_count", 0)
                s_count = data.get("stickers_count", 0)

                status_info = (
                    f"✅ Meme Stickers 渲染后端在线\n"
                    f"🌐 服务地址: {self.server_url}\n"
                    f"⚡ 响应延迟: {latency} ms\n"
                    f"🎨 渲染引擎: {engine}\n"
                    f"📦 贴纸库: {p_count} 个贴纸包，共 {s_count} 张表情\n"
                    f"🔗 Playground 游乐场: {self.server_url}/"
                )
                yield self._plain(event, status_info)
            except Exception as e:
                yield self._plain(
                    event,
                    f"❌ 无法连接到表情包渲染服务！\n"
                    f"服务地址: {self.server_url}\n"
                    f"错误信息: {type(e).__name__}: {e}\n"
                    f"请检查 Node.js 渲染服务是否已启动，并在插件配置中确认 server_url 是否正确。"
                )
            return

        if sub in {"list", "packs", "列表"}:
            try:
                packs = await self._fetch_packs(force=True)
                if not packs:
                    yield self._plain(event, "渲染后端暂无可用贴纸包。")
                    return
                lines = ["📦 可用贴纸包列表:"]
                for i, (slug, pack) in enumerate(packs.items(), 1):
                    pname = pack.get("name", slug)
                    cats = pack.get("categories", {})
                    st_total = sum(len(items) for items in cats.values())
                    lines.append(f"{i}. [{slug}] {pname} ({len(cats)} 个分类, {st_total} 个表情)")
                lines.append("\n使用 /pjsk 或 /arc 进入制作，或 /meme-stickers generate <pack> <sticker> <text>")
                yield self._plain(event, "\n".join(lines))
            except Exception as e:
                yield self._plain(event, f"获取贴纸包列表失败: {e}")
            return

        if sub == "generate":
            if len(args) == 1:
                # 交互式制作模式，默认针对 pjsk
                async for r in self._handle_shortcut_cmd(event, "pjsk"):
                    yield r
                return
            if len(args) == 2:
                # /meme-stickers generate <pack_slug> 交互式制作
                async for r in self._handle_shortcut_cmd(event, args[1]):
                    yield r
                return
            if len(args) < 4:
                yield self._plain(event, "用法: /meme-stickers generate [pack_slug] 或 /meme-stickers generate <pack_slug> <贴纸名> <文本> [参数]")
                return

            pack_slug = args[1]
            sticker_name = args[2]
            raw_extra = args[3:]
            opts, text_parts = self._parse_generate_args(raw_extra)
            text = " ".join(text_parts).strip()
            if not text:
                yield self._plain(event, "请输入要绘制的表情包文本")
                return

            payload = {
                "pack_slug": pack_slug,
                "sticker_name": sticker_name,
                "text": text,
                "image_format": opts.get("image_format", self.default_format),
                **opts,
            }

            try:
                img_data = await self._call_generate_api(payload)
                async for r in self._send_image(event, img_data, f"gen_{pack_slug}", ext=payload["image_format"]):
                    yield r
            except Exception as e:
                yield self._plain(event, f"生成表情包失败: {e}")
            return

        yield self._plain(event, f"未知子命令: {sub}，请发送 /meme-stickers help 查看说明")

    @filter.command("pjsk")
    async def pjsk_cmd(self, event: AstrMessageEvent):
        """快捷制作 Project Sekai 贴纸"""
        if hasattr(event, "stop_event"):
            event.stop_event()
        async for r in self._handle_shortcut_cmd(event, "pjsk"):
            yield r

    @filter.command("arc", alias={"arcaea"})
    async def arc_cmd(self, event: AstrMessageEvent):
        """快捷制作 Arcaea 贴纸"""
        if hasattr(event, "stop_event"):
            event.stop_event()
        async for r in self._handle_shortcut_cmd(event, "arcaea"):
            yield r

    async def _handle_shortcut_cmd(self, event: AstrMessageEvent, default_slug: str):
        msg = event.get_message_str().strip()
        parts = msg.split()
        args = parts[1:] if len(parts) > 1 else []

        # 1. 快捷参数模式：/pjsk <贴纸名> <文字> 或 /pjsk <文字>
        if len(args) >= 2:
            sticker_name = args[0]
            opts, text_parts = self._parse_generate_args(args[1:])
            text = " ".join(text_parts).strip()
            if text:
                payload = {
                    "pack_slug": default_slug,
                    "sticker_name": sticker_name,
                    "text": text,
                    "image_format": opts.get("image_format", self.default_format),
                    **opts,
                }
                try:
                    img_data = await self._call_generate_api(payload)
                    async for r in self._send_image(event, img_data, f"{default_slug}_quick", ext=payload["image_format"]):
                        yield r
                    return
                except Exception as e:
                    yield self._plain(event, f"快捷生成失败: {e}")
                    return

        # 2. 交互式制作模式
        try:
            packs = await self._fetch_packs()
        except Exception as e:
            yield self._plain(event, f"无法连接到渲染服务获取贴纸包: {e}")
            return

        pack = packs.get(default_slug)
        if not pack:
            yield self._plain(event, f"未找到贴纸包: {default_slug}")
            return

        # 如果贴纸包禁用了分类选择（如 Arcaea），直接一步展示所有表情
        if pack.get("disable_category_select"):
            sid = self._sid(event)
            self._get_sessions()[sid] = self._new_session(
                mode="shortcut",
                step="pick_sticker",
                pack_slug=default_slug,
            )
            try:
                grid_bytes = await self._call_grid_api(default_slug)
                async for r in self._send_image(event, grid_bytes, f"pick_sticker_{default_slug}", ext="jpeg"):
                    yield r
            except Exception as e:
                logger.error(f"获取全量贴纸预览网格失败: {e}", exc_info=True)
                yield self._plain(
                    event,
                    f"⚠️ 贴纸预览图生成失败（{e}）。\n提示：你仍可直接发送贴纸名称或序号进行制作：",
                )
            yield self._plain(
                event,
                f"已进入 {pack.get('name', default_slug)} 贴纸选择，请发送名称或序号（输入 0 退出）",
            )
            return

        categories = sorted(pack.get("categories", {}).keys())
        if not categories:
            yield self._plain(event, f"贴纸包 {default_slug} 中暂无分类")
            return

        sid = self._sid(event)
        self._get_sessions()[sid] = self._new_session(
            mode="shortcut",
            step="pick_category",
            pack_slug=default_slug,
        )

        try:
            grid_bytes = await self._call_grid_api(default_slug)
            async for r in self._send_image(event, grid_bytes, f"pick_category_{default_slug}", ext="jpeg"):
                yield r
        except Exception as e:
            logger.error(f"获取分类预览网格失败: {e}", exc_info=True)
            yield self._plain(
                event,
                f"⚠️ 分类预览图生成失败（{e}）。\n提示：你仍可直接发送角色名称或序号进行选择：",
            )

        yield self._plain(
            event,
            f"已进入 {pack.get('name', default_slug)} 角色选择，请发送名称或序号（输入 0 退出）",
        )

    @filter.event_message_type(filter.EventMessageType.ALL, priority=50)
    async def on_message(self, event: AstrMessageEvent):
        # 1. 禁用状态检查
        if getattr(self, "_terminated", False):
            return

        # 2. 快速短路：防守性获取会话字典，绝不抛出 AttributeError 影响正常消息流水线
        sessions = getattr(self, "sessions", None)
        if not sessions:
            if not hasattr(self, "sessions") or self.sessions is None:
                self.sessions = {}
            return

        sid = self._sid(event)
        st = sessions.get(sid)
        if not st:
            return

        txt = event.get_message_str().strip()
        if not txt:
            return

        # 3. 会话过期检查
        if st.expires_at and self._now() > st.expires_at:
            sessions.pop(sid, None)
            return

        # 4. 指令前缀检查（用户在制作过程中输入了其他指令，立即放行并退出会话）
        COMMAND_PREFIXES = ("/", "!", "！", "#", ".", "。", "、", "~", "$")
        txt_lower = txt.lower()
        if txt.startswith(COMMAND_PREFIXES) or txt_lower in {
            "pjsk", "arc", "arcaea", "meme-stickers", "stickers", "help", "菜单", "帮助"
        }:
            sessions.pop(sid, None)
            return

        # 5. 退出指令检查
        if self._is_exit(txt):
            sessions.pop(sid, None)
            if hasattr(event, "stop_event"):
                event.stop_event()
            yield self._plain(event, "已退出表情包制作")
            return

        # 6. 命中当前会话交互，阻止事件向后传播至 LLM 或其他插件
        if hasattr(event, "stop_event"):
            event.stop_event()

        packs = await self._fetch_packs()
        pack = packs.get(st.pack_slug or "pjsk")
        if not pack:
            sessions.pop(sid, None)
            yield self._plain(event, "贴纸包不可用，制作已结束。")
            return

        # 步骤 1：选择分类
        if st.step == "pick_category":
            categories = sorted(pack.get("categories", {}).keys())
            chosen_cat = None
            if txt.isdigit() and 1 <= int(txt) <= len(categories):
                chosen_cat = categories[int(txt) - 1]
            if not chosen_cat:
                chosen_cat = next((c for c in categories if c.lower() == txt.lower()), None)

            if not chosen_cat:
                st.invalid_count += 1
                if st.invalid_count >= 2:
                    sessions.pop(sid, None)
                    yield self._plain(event, "未匹配到分类，已自动退出表情包制作。")
                    return
                yield self._plain(event, "未找到该分类，请重新输入序号或分类名称（输入 0 退出）")
                return

            st.invalid_count = 0
            self._touch_session(st)
            st.category = chosen_cat
            stickers = pack["categories"][chosen_cat]

            if len(stickers) == 1:
                st.sticker_name = stickers[0]["name"]
                st.step = "input_text"
                yield self._plain(event, f"分类【{chosen_cat}】仅有 1 张贴纸，请直接输入要添加的文字（输入 0 退出）:")
                return

            st.step = "pick_sticker"
            try:
                grid_bytes = await self._call_grid_api(st.pack_slug or "pjsk", category=chosen_cat)
                async for r in self._send_image(event, grid_bytes, "pick_sticker", ext="jpeg"):
                    yield r
            except Exception as e:
                logger.error(f"获取贴纸预览网格失败: {e}", exc_info=True)
                yield self._plain(
                    event,
                    f"⚠️ 贴纸预览图生成失败（{e}）。\n提示：你仍可直接发送贴纸名称或序号：",
                )
            yield self._plain(event, "请输入贴纸名称或序号（输入 r 返回分类，0 退出）")
            return

        # 步骤 2：选择表情
        if st.step == "pick_sticker":
            if self._is_back(txt):
                if pack.get("disable_category_select"):
                    sessions.pop(sid, None)
                    yield self._plain(event, "已退出表情包制作")
                    return
                st.step = "pick_category"
                st.invalid_count = 0
                self._touch_session(st)
                try:
                    grid_bytes = await self._call_grid_api(st.pack_slug or "pjsk")
                    async for r in self._send_image(event, grid_bytes, "pick_category", ext="jpeg"):
                        yield r
                except Exception as e:
                    logger.warning(f"获取分类预览网格失败: {e}")
                yield self._plain(event, "已返回角色分类选择，请发送名称或序号（输入 0 退出）")
                return

            if pack.get("disable_category_select"):
                stickers = []
                for cat, s_list in pack.get("categories", {}).items():
                    stickers.extend(s_list)
            else:
                stickers = pack.get("categories", {}).get(st.category or "", [])
            chosen_sticker = None
            if txt.isdigit() and 1 <= int(txt) <= len(stickers):
                chosen_sticker = stickers[int(txt) - 1]
            if not chosen_sticker:
                chosen_sticker = next((s for s in stickers if s.get("name", "").lower() == txt.lower()), None)

            if not chosen_sticker:
                st.invalid_count += 1
                if st.invalid_count >= 2:
                    sessions.pop(sid, None)
                    yield self._plain(event, "未匹配到表情，已自动退出表情包制作。")
                    return
                yield self._plain(event, "未找到该表情，请重新输入序号或表情名称（输入 0 退出）")
                return

            st.invalid_count = 0
            self._touch_session(st)
            st.sticker_name = chosen_sticker.get("name")
            st.step = "input_text"
            yield self._plain(event, f"已选择表情【{st.sticker_name}】，请输入要添加的表情包文字（输入 0 退出）:")
            return

        # 步骤 3：输入文字并生成
        if st.step == "input_text":
            user_text = txt.strip()
            if not user_text:
                return

            payload = {
                "pack_slug": st.pack_slug,
                "sticker_name": st.sticker_name,
                "text": user_text,
                "image_format": self.default_format,
            }
            try:
                img_data = await self._call_generate_api(payload)
                async for r in self._send_image(event, img_data, "interactive", ext=self.default_format):
                    yield r
            except Exception as e:
                yield self._plain(event, f"生成表情包失败: {e}")
            finally:
                sessions.pop(sid, None)

    def _register_web_apis(self):
        if not hasattr(self.context, "register_web_api"):
            return
        apis = [
            (f"/{self.PLUGIN_NAME}/status", self.web_get_status, ["GET"], "获取API插件与后端状态"),
            (f"/{self.PLUGIN_NAME}/packs", self.web_get_packs_detail, ["GET"], "获取贴纸包详情树"),
            (f"/{self.PLUGIN_NAME}/generate", self.web_generate, ["POST"], "Playground生成贴纸图片"),
            (f"/{self.PLUGIN_NAME}/sticker_image", self.web_get_sticker_image, ["GET"], "获取贴纸底图"),
            (f"/{self.PLUGIN_NAME}/font/primary", self.web_get_primary_font, ["GET"], "获取主字体"),
            (f"/{self.PLUGIN_NAME}/reload", self.web_reload_packs, ["POST"], "重载贴纸包"),
            (f"/{self.PLUGIN_NAME}/switch_mirror", self.web_switch_mirror, ["POST"], "切换镜像源预设"),
        ]
        for route, handler, methods, desc in apis:
            try:
                self.context.register_web_api(route, handler, methods, desc)
            except Exception as e:
                logger.warning(f"注册 Web API {route} 失败: {e}")

    @staticmethod
    async def _parse_request_json(req):
        if req is None:
            return {}
        if hasattr(req, "json"):
            j = getattr(req, "json")
            if callable(j):
                try:
                    res = j()
                    if asyncio.iscoroutine(res):
                        res = await res
                    if isinstance(res, dict):
                        return res
                except Exception:
                    pass
            elif isinstance(j, dict):
                return j
        if hasattr(req, "get_json"):
            gj = getattr(req, "get_json")
            if callable(gj):
                try:
                    res = gj()
                    if asyncio.iscoroutine(res):
                        res = await res
                    if isinstance(res, dict):
                        return res
                except Exception:
                    pass
        for attr in ("body", "data", "_body"):
            if hasattr(req, attr):
                val = getattr(req, attr)
                if isinstance(val, (bytes, str)):
                    import json
                    try:
                        res = json.loads(val)
                        if isinstance(res, dict):
                            return res
                    except Exception:
                        pass
                elif isinstance(val, dict):
                    return val
        return {}

    @staticmethod
    def _parse_query_params(req, *args, **kwargs):
        r = kwargs.get("request") or (args[0] if args else req)
        if not r:
            return {}
        if hasattr(r, "query_params"):
            return dict(r.query_params)
        if hasattr(r, "args"):
            return dict(r.args)
        if hasattr(r, "query"):
            return dict(r.query)
        if hasattr(r, "url"):
            try:
                from urllib.parse import parse_qs, urlparse
                u = urlparse(str(r.url))
                q = parse_qs(u.query)
                return {k: v[0] for k, v in q.items() if v}
            except Exception:
                pass
        return {}

    async def web_get_status(self, *args, **kwargs):
        try:
            backend_data = {}
            backend_online = False
            latency_ms = 0
            backend_err = ""
            t0 = time.time()
            try:
                # 状态探测使用短超时（至多 5 秒），避免长时间挂起
                async with httpx.AsyncClient(timeout=min(self.timeout, 5.0), trust_env=not self._is_local) as client:
                    resp = await client.get(f"{self.server_url}/api/status")
                    if resp.status_code == 200:
                        backend_data = resp.json()
                        backend_online = True
                        latency_ms = int((time.time() - t0) * 1000)
                    else:
                        backend_err = f"HTTP {resp.status_code}"
            except Exception as e:
                backend_err = str(e)
                logger.warning(f"web_get_status 获取后端状态异常: {e}")

            packs = {}
            if backend_online:
                try:
                    packs = await self._fetch_packs()
                except Exception as e:
                    backend_err = str(e)
                    logger.warning(f"web_get_status 获取贴纸列表异常: {e}")

            packs_data = []
            for slug, p in packs.items():
                cat_keys = list(p.get("categories", {}).keys())
                st_count = sum(len(l) for l in p.get("categories", {}).values())
                packs_data.append({
                    "slug": slug,
                    "name": p.get("name", slug),
                    "description": p.get("description", ""),
                    "stickers_count": st_count,
                    "categories": cat_keys,
                    "disabled": False,
                    "unavailable": False,
                })

            return json_response({
                "status": "ok",
                "data": {
                    "installed_packs": packs_data,
                    "total_packs": len(packs_data),
                    "available_packs_count": len(packs_data),
                    "server_url": self.server_url,
                    "backend_online": backend_online,
                    "backend_error": backend_err,
                    "backend_latency_ms": latency_ms,
                    "backend": backend_data,
                    "emoji_font": {
                        "name": "NotoColorEmoji.ttf",
                        "exists": True,
                        "size_mb": 0,
                    },
                    "primary_font": {
                        "name": "YurukaFangTang.ttf",
                        "exists": True,
                    },
                    "config": {
                        "server_url": self.server_url,
                        "quote_reply": self.quote_reply,
                        "timeout": self.timeout,
                        "default_format": self.default_format,
                    },
                    "bundled_fonts": ["YurukaFangTang"],
                }
            })
        except Exception as e:
            logger.error(f"web_get_status 出错: {e}", exc_info=True)
            return error_response(f"获取状态失败: {e}", status_code=500)

    async def web_get_packs_detail(self, *args, **kwargs):
        try:
            packs = await self._fetch_packs(force=True)
            return json_response({"status": "ok", "data": packs})
        except Exception as e:
            logger.warning(f"web_get_packs_detail 出错: {e}")
            return json_response({"status": "ok", "data": {}})

    async def web_generate(self, *args, **kwargs):
        try:
            req = kwargs.get("request") or (args[0] if args else request)
            body = await self._parse_request_json(req)
            url = f"{self.server_url}/api/generate"
            async with self._create_client() as client:
                resp = await client.post(url, json=body)
                if resp.status_code != 200:
                    try:
                        err_j = resp.json()
                        msg = err_j.get("message") or err_j.get("error") or resp.text
                    except Exception:
                        msg = resp.text
                    return error_response(f"后端生成失败 ({resp.status_code}): {msg}", status_code=resp.status_code)
                return json_response(resp.json())
        except Exception as e:
            logger.error(f"web_generate 出错: {e}", exc_info=True)
            return error_response(f"生成表情包失败: {e}", status_code=500)

    async def web_get_sticker_image(self, *args, **kwargs):
        try:
            req = kwargs.get("request") or (args[0] if args else request)
            q = self._parse_query_params(req, *args, **kwargs)
            pack_slug = q.get("pack")
            file_name = q.get("file")
            if not pack_slug or not file_name:
                return error_response("缺少 pack 或 file 参数", status_code=400)
            urls = [
                f"{self.server_url}/packs/{pack_slug}/{file_name}",
                f"https://cdn.jsdelivr.net/gh/lgc-NB2Dev/meme-stickers-hub@main/{pack_slug}/{file_name}",
                f"https://ghfast.top/https://raw.githubusercontent.com/lgc-NB2Dev/meme-stickers-hub@main/{pack_slug}/{file_name}",
            ]
            async with self._create_client() as client:
                for u in urls:
                    try:
                        resp = await client.get(u)
                        if resp.status_code == 200 and len(resp.content) > 100:
                            b64 = base64.b64encode(resp.content).decode("ascii")
                            mime = resp.headers.get("content-type") or "image/png"
                            return json_response({
                                "status": "ok",
                                "data": {
                                    "data_uri": f"data:{mime};base64,{b64}"
                                }
                            })
                    except Exception:
                        pass
            return error_response(f"未找到贴纸底图: {file_name}", status_code=404)
        except Exception as e:
            logger.error(f"web_get_sticker_image 出错: {e}", exc_info=True)
            return error_response(f"获取底图失败: {e}", status_code=500)

    async def web_get_primary_font(self, *args, **kwargs):
        try:
            urls = [
                f"{self.server_url}/fonts/YurukaFangTang.ttf",
                "https://cdn.jsdelivr.net/gh/kyuphoenix/astrbot_plugin_meme_stickers@main/astrbot_plugin_meme_stickers/meme_stickers_core/fonts/YurukaFangTang.ttf",
            ]
            async with self._create_client() as client:
                for u in urls:
                    try:
                        resp = await client.get(u)
                        if resp.status_code == 200 and len(resp.content) > 1000:
                            b64 = base64.b64encode(resp.content).decode("ascii")
                            return json_response({
                                "status": "ok",
                                "data": {
                                    "data_uri": f"data:font/ttf;base64,{b64}"
                                }
                            })
                    except Exception:
                        pass
            return error_response("未获取到主字体", status_code=404)
        except Exception as e:
            logger.error(f"web_get_primary_font 出错: {e}", exc_info=True)
            return error_response(f"获取主字体失败: {e}", status_code=500)

    async def web_reload_packs(self, *args, **kwargs):
        self._packs_cache = None
        self._packs_cache_time = 0.0
        packs = await self._fetch_packs(force=True)
        return json_response({
            "status": "ok",
            "data": { "total": len(packs) }
        })

    async def web_switch_mirror(self, *args, **kwargs):
        return json_response({
            "status": "ok",
            "data": { "message": "API版使用后端集中式镜像调度，已同步刷新" }
        })
