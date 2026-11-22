import asyncio
import base64
from dataclasses import dataclass
from pathlib import Path
import tempfile
import time
from typing import Optional, Dict, Any, List

import httpx

try:
    from astrbot.api.event import filter, AstrMessageEvent
    from astrbot.api.all import Star, Context, AstrBotConfig, logger
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
    expires_at: float = 0.0
    invalid_count: int = 0


class MemeStickersApiPlugin(Star):
    SESSION_TIMEOUT_SECONDS = 90

    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config or {}
        raw_url = str(self.config.get("server_url") or "http://127.0.0.1:3000").strip()
        self.server_url = raw_url.rstrip("/")
        self.quote_reply = bool(self.config.get("quote_reply", True))
        self.timeout = float(self.config.get("timeout", 15))
        self.default_format = str(self.config.get("default_format", "png")).lower()
        
        self.sessions: Dict[str, SessionState] = {}
        self._packs_cache: Optional[Dict[str, Any]] = None
        self._packs_cache_time: float = 0.0
        self._cache_ttl: float = 300.0  # 缓存 5 分钟
        # 若是本地地址，禁用系统环境变量代理以避免 127.0.0.1 请求被本地梯子拦截
        self._is_local = "127.0.0.1" in self.server_url or "localhost" in self.server_url

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
            if len(args) < 4:
                yield self._plain(event, "用法: /meme-stickers generate <pack_slug> <贴纸名> <文本> [参数]")
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
            all_stickers = []
            for cat, s_list in pack.get("categories", {}).items():
                all_stickers.extend(s_list)
            sid = self._sid(event)
            self.sessions[sid] = self._new_session(
                mode="shortcut",
                step="pick_sticker",
                pack_slug=default_slug,
            )
            lines = [f"🎨 已进入 {pack.get('name', default_slug)} 贴纸制作，请选择表情:"]
            for i, st_item in enumerate(all_stickers, 1):
                lines.append(f"{i}. {st_item.get('name', '')}")
            lines.append("\n请输入表情序号或名称（输入 0 或'退出'取消）:")
            yield self._plain(event, "\n".join(lines))
            return

        categories = sorted(pack.get("categories", {}).keys())
        if not categories:
            yield self._plain(event, f"贴纸包 {default_slug} 中暂无分类")
            return

        sid = self._sid(event)
        self.sessions[sid] = self._new_session(
            mode="shortcut",
            step="pick_category",
            pack_slug=default_slug,
        )

        lines = [f"🎨 已进入 {pack.get('name', default_slug)} 贴纸制作，请选择角色分类:"]
        for i, cat in enumerate(categories, 1):
            count = len(pack["categories"][cat])
            lines.append(f"{i}. {cat} ({count} 个表情)")
        lines.append("\n请输入分类序号或名称（输入 0 或'退出'取消）:")
        yield self._plain(event, "\n".join(lines))

    @filter.event_message_type(filter.EventMessageType.ALL, priority=50)
    async def on_message(self, event: AstrMessageEvent):
        if not self.sessions:
            return

        sid = self._sid(event)
        st = self.sessions.get(sid)
        if not st:
            return

        txt = event.get_message_str().strip()
        if not txt:
            return

        if st.expires_at and self._now() > st.expires_at:
            self.sessions.pop(sid, None)
            return

        COMMAND_PREFIXES = ("/", "!", "！", "#", ".", "。", "、", "~", "$")
        txt_lower = txt.lower()
        if txt.startswith(COMMAND_PREFIXES) or txt_lower in {
            "pjsk", "arc", "arcaea", "meme-stickers", "stickers", "help", "菜单", "帮助"
        }:
            self.sessions.pop(sid, None)
            return

        if self._is_exit(txt):
            self.sessions.pop(sid, None)
            if hasattr(event, "stop_event"):
                event.stop_event()
            yield self._plain(event, "已退出表情包制作")
            return

        if hasattr(event, "stop_event"):
            event.stop_event()

        packs = await self._fetch_packs()
        pack = packs.get(st.pack_slug or "pjsk")
        if not pack:
            self.sessions.pop(sid, None)
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
                    self.sessions.pop(sid, None)
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
            lines = [f"已选择【{chosen_cat}】，请选择具体表情:"]
            for i, s in enumerate(stickers, 1):
                sname = s.get("name", f"贴纸{i}")
                lines.append(f"{i}. {sname}")
            lines.append("\n请输入表情序号或名称（输入 r 返回分类，0 退出）:")
            yield self._plain(event, "\n".join(lines))
            return

        # 步骤 2：选择表情
        if st.step == "pick_sticker":
            if self._is_back(txt):
                if pack.get("disable_category_select"):
                    self.sessions.pop(sid, None)
                    yield self._plain(event, "已退出表情包制作")
                    return
                st.step = "pick_category"
                st.invalid_count = 0
                self._touch_session(st)
                categories = sorted(pack.get("categories", {}).keys())
                lines = ["已返回分类选择，请选择分类序号:"]
                for i, cat in enumerate(categories, 1):
                    lines.append(f"{i}. {cat}")
                yield self._plain(event, "\n".join(lines))
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
                    self.sessions.pop(sid, None)
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
                self.sessions.pop(sid, None)
