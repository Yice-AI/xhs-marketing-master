import json
import re
import logging
from typing import Any, Dict, List, Optional, Union

logger = logging.getLogger(__name__)


def _extract_balanced_json_fragment(text: str) -> Optional[str]:
    start_positions = [idx for idx in (text.find("{"), text.find("[")) if idx != -1]
    if not start_positions:
        return None

    start = min(start_positions)
    opening = text[start]
    closing = "}" if opening == "{" else "]"
    depth = 0
    in_string = False
    escape = False

    for index in range(start, len(text)):
        char = text[index]
        if escape:
            escape = False
            continue
        if char == "\\":
            escape = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return text[start:].strip() or None


def _repair_json_with_regex(cleaned: str) -> str:
    repaired = cleaned.strip()
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
    repaired = re.sub(r"(?<!\\)\n", r"\\n", repaired)
    repaired = re.sub(r"(?<!\\)\r", "", repaired)
    repaired = re.sub(r"(?<!\\)\t", r"\\t", repaired)
    repaired = re.sub(r'(?<=[:\[,]\s*)"([^"\\]*(?:\\.[^"\\]*)*)"(?=\s*"[^"]+"\s*:)', r'"\1",', repaired)

    if repaired.startswith("{") and not repaired.endswith("}"):
        repaired += "}"
    elif repaired.startswith("[") and not repaired.endswith("]"):
        repaired += "]"

    return repaired

def _unescape_literal_newlines(obj: Any) -> Any:
    """
    递归处理解析后的 JSON 对象，将字符串中残留的字面量 '\\n' 和 '\\r' 替换为真实的换行符。
    （某些 AI 模型在生成 JSON 时会错误地输出 '\\\\n'，导致解析后得到包含 '\\n' 字面量的字符串）
    """
    if isinstance(obj, str):
        return obj.replace("\\n", "\n").replace("\\r", "")
    elif isinstance(obj, list):
        return [_unescape_literal_newlines(item) for item in obj]
    elif isinstance(obj, dict):
        return {k: _unescape_literal_newlines(v) for k, v in obj.items()}
    return obj

def clean_and_parse_ai_json(text: str) -> Any:
    """
    通用 AI JSON 解析工具，支持：
    1. 剥离 <think>...</think> 标签 (MiniMax-M2.5 等推理模型)
    2. 提取 ```json ... ``` 代码块
    3. 自动定位 { ... } 或 [ ... ] 结构
    4. 修复常见 JSON 语法错误
    """
    if not text:
        return None
        
    cleaned = text.strip()
    
    # 1. 处理 <think> 标签
    if "<think>" in cleaned:
        # 优先寻找最后一个 </think> 标签，取其后的内容
        if "</think>" in cleaned:
            last_think_end = cleaned.rfind("</think>")
            # 记录被剥离的内容（可选）
            # thought_process = cleaned[:last_think_end + 8]
            cleaned = cleaned[last_think_end + 8:].strip()
        else:
            # 如果只有开始标签没有结束标签，尝试移除开始标签及其后的一段内容
            # 或者如果 JSON 在后面，尝试正则匹配 JSON
            pass

    # 2. 处理 Markdown 代码块
    if "```json" in cleaned:
        cleaned = cleaned.split("```json")[1].split("```")[0].strip()
    elif "```" in cleaned:
        parts = cleaned.split("```")
        if len(parts) >= 2:
            # 找到最像 JSON 的那一部分
            for part in parts:
                p = part.strip()
                if (p.startswith("{") and p.endswith("}")) or (p.startswith("[") and p.endswith("]")):
                    cleaned = p
                    break

    # 3. 定位 JSON 结构
    if not ((cleaned.startswith("{") and cleaned.endswith("}")) or (cleaned.startswith("[") and cleaned.endswith("]"))):
        fragment = _extract_balanced_json_fragment(cleaned)
        if fragment:
            cleaned = fragment

    # 4. 修复常见全角字符和控制字符（注：移除了全局中文标点替换，以避免破坏正常的小红书文案）
    cleaned = cleaned.replace('“', '"').replace('”', '"').replace('‘', "'").replace('’', "'")
    cleaned = re.sub(r'[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]', '', cleaned)
    
    # 5. 尝试解析
    parsed_obj = None
    try:
        parsed_obj = json.loads(cleaned)
    except json.JSONDecodeError as e:
        # 尝试使用 json_repair (如果安装了)
        try:
            from json_repair import repair_json
            repaired = repair_json(cleaned)
            parsed_obj = json.loads(repaired)
        except Exception:
            # 次级修复：做轻量正则修补
            try:
                fixed = _repair_json_with_regex(cleaned)
                fixed = re.sub(r'\\(?!["\\/bfnrtu])', r'\\\\', fixed)
                parsed_obj = json.loads(fixed)
            except Exception:
                logger.error(f"JSON 解析失败. 原始长度: {len(text)}, 清理后长度: {len(cleaned)}")
                logger.error(f"清理后的内容片段: {cleaned[:500]}...")
                raise e

    # 6. 后处理：处理转义过度的换行符
    return _unescape_literal_newlines(parsed_obj)

def extract_json_list(data: Any) -> List[Dict[str, Any]]:
    """
    从解析后的数据中提取列表结构
    """
    if isinstance(data, list):
        return data
    elif isinstance(data, dict):
        # 寻找第一个列表类型的字段
        for value in data.values():
            if isinstance(value, list):
                return value
    return []
