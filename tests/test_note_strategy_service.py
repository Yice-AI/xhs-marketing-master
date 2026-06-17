import pytest

from backend.services import note_strategy_service
from backend.services.note_strategy_service import NoteStrategyService


class NoInitNoteStrategyService(NoteStrategyService):
    def __init__(self):
        pass


class CapturingStrategyService(NoInitNoteStrategyService):
    def __init__(self, product_usage_mode="product_main"):
        self.product_usage_mode = product_usage_mode
        self.prompts = []
        self.call_kwargs = []

    def diagnose_benchmark_fit(self, **kwargs):
        return {
            "fit_level": "strong_fit" if self.product_usage_mode == "product_main" else "research_only",
            "product_usage_mode": self.product_usage_mode,
            "confidence": 88,
            "core_viral_driver": "测试爆点",
            "product_fit_reason": "测试原因",
            "risk_if_product_inserted": "",
            "allowed_product_usage": "测试允许方式",
            "forbidden_moves": [],
            "transferable_assets": ["标题风格", "卡片节奏"],
        }

    def _call_json(self, prompt, **kwargs):
        self.prompts.append(prompt)
        self.call_kwargs.append(kwargs)
        return {
            "selected_strategy_id": "strategy_a",
            "strategies": [
                {
                    "id": "strategy_a",
                    "label": "场景决策版",
                    "summary": "围绕一个具体购买/使用场景做决策说明。",
                    "targetAudience": "正在评估工具的人",
                    "corePainPoints": ["不知道是否适合自己"],
                    "coreBenefits": ["更快判断价值"],
                    "contentAngle": "场景决策型",
                    "noteGoal": "让用户理解适用场景",
                    "visualDirection": "benefit",
                    "recommendedCardPlan": ["封面卡", "场景卡", "证明卡", "收口卡"],
                    "suggestedTitle": "先看这个场景适不适合你",
                }
            ],
        }


class FailingStrategyService(CapturingStrategyService):
    def __init__(self):
        super().__init__()
        self.calls = 0

    def _call_json(self, prompt, **kwargs):
        self.calls += 1
        raise RuntimeError("500 server_error")


def test_no_benchmark_keeps_product_main_research_strategy():
    service = NoInitNoteStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "微伴助手",
            "summary": "企业微信私域 SCRM 工具",
            "target_audience_insights": ["企业老板"],
            "core_features": ["客户分层", "SOP 跟进"],
            "use_cases": ["私域转化"],
            "differentiators": ["合规风控"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=False,
    )

    assert result["product_usage_mode"] == "product_main"
    assert result["benchmark_fit"]["fit_level"] == "research_only"
    assert result["strategies"][0]["productUsageMode"] == "product_main"
    assert result["strategies"][0]["label"] == "教程拆解"


def test_explicit_no_product_feedback_locks_no_product_strategy():
    service = NoInitNoteStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "Uplog",
            "summary": "创作者效率工具",
            "target_audience_insights": ["小编"],
            "core_features": ["AI写作", "一键导入"],
            "use_cases": ["内容生产"],
        },
        benchmark_note={
            "title": "流量上不去？这套爆款笔记逻辑直接照搬",
            "desc": "第一招做封面，第二招写标题，第三招看内容形式。",
            "content_category": "教程",
        },
        strategy_mode="benchmark_first",
        strategy_feedback="不要参考产品信息，只复刻原文结构",
        use_model=False,
    )

    assert result["product_usage_mode"] == "no_product"
    assert result["benchmark_fit"]["confidence"] == 100
    assert result["strategies"][0]["productUsageMode"] == "no_product"
    assert result["strategies"][0]["label"] == "纯结构复刻"
    assert "产品" not in "".join(result["strategies"][0]["recommendedCardPlan"])


def test_writing_tutorial_benchmark_uses_product_assist_not_product_main():
    service = NoInitNoteStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "Uplog",
            "summary": "面向小编和自媒体的创作者工具",
            "target_audience_insights": ["小编", "自媒体"],
            "core_features": ["AI写作", "一键导入", "模板一键套用", "自动分页"],
            "use_cases": ["内容生产提效"],
            "differentiators": ["减少复制粘贴和排版返工"],
        },
        benchmark_note={
            "title": "培养优质网感！爆款笔记宝典请查收",
            "desc": "最近很多薯宝想知道如何让笔记的小眼睛更多，第一招封面图，第二招标题神助攻，第三招内容形式决定文案长度。",
            "content_category": "小红书写作教程",
            "tags": ["爆款笔记", "如何做博主"],
        },
        strategy_mode="benchmark_first",
        use_model=False,
    )

    assert result["product_usage_mode"] == "product_assist"
    assert result["benchmark_fit"]["fit_level"] == "soft_fit"
    assert result["strategies"][0]["productUsageMode"] == "product_assist"
    assert "轻承接" in result["strategies"][0]["label"]
    first_strategy_text = " ".join([
        result["strategies"][0]["summary"],
        result["strategies"][0]["noteGoal"],
        " ".join(result["strategies"][0]["recommendedCardPlan"]),
    ])
    assert "Uplog" in first_strategy_text
    assert "产品轻承接页" in first_strategy_text
    assert "辅助" in first_strategy_text


def test_business_benchmark_keeps_product_main():
    service = NoInitNoteStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "微伴助手",
            "summary": "企业微信私域增长和 SCRM 工具",
            "target_audience_insights": ["企业老板"],
            "core_features": ["客户分层", "跟进 SOP", "会话存档"],
            "use_cases": ["私域转化", "客户管理"],
            "differentiators": ["合规风控", "销售协同"],
        },
        benchmark_note={
            "title": "客户都在企微，为什么还要换智能SCRM？",
            "desc": "传统企微打法太靠人工，客户分层、跟进、复购都容易断。",
            "content_category": "私域运营",
            "tags": ["企业微信", "SCRM", "私域转化"],
        },
        strategy_mode="benchmark_first",
        use_model=False,
    )

    assert result["product_usage_mode"] == "product_main"
    assert result["benchmark_fit"]["fit_level"] == "strong_fit"
    assert result["strategies"][0]["label"] == "对标结构跟写"


def test_research_first_prompt_adds_diversity_instruction_without_changing_schema():
    service = CapturingStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "微伴助手",
            "summary": "企业微信私域 SCRM 工具",
            "target_audience_insights": ["企业老板"],
            "core_features": ["客户分层", "SOP 跟进"],
            "use_cases": ["私域转化"],
            "differentiators": ["合规风控"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    prompt = service.prompts[-1]
    assert result["fallback_used"] is False
    assert "【本轮创意批次】" in prompt
    assert "creative_run_id:" in prompt
    assert "内部先从产品资料/对标内容里挖出 6-8 个“具体矛盾命题”" in prompt
    assert "不是“老板诊断/增长链路/合规风控/教程/种草”这类大类型标签" in prompt
    assert "底层逻辑差异最大的 3 个命题" in prompt
    assert "最终只输出原有策略字段" in prompt
    assert "不能只是同一个方向换词" in prompt
    assert "没有对标笔记时，三套策略仍然必须以产品研究为核心" in prompt
    assert "不要只生成“教程/种草/问题解决”三个固定壳" in prompt
    assert "【对标锚点优先级】" not in prompt
    assert "contentAngle" in prompt
    assert "清晰可执行的内容角度" in prompt
    assert service.call_kwargs[-1]["temperature"] == 0.72
    assert service.call_kwargs[-1]["max_tokens"] == 2600


def test_note_strategy_model_failure_retries_then_raises_without_local_fallback(monkeypatch):
    service = FailingStrategyService()
    monkeypatch.setattr(note_strategy_service.time, "sleep", lambda *_args, **_kwargs: None)

    with pytest.raises(RuntimeError, match="笔记策略模型生成失败"):
        service.build_note_strategies(
            research_context={
                "product_name": "微伴助手",
                "summary": "企业微信私域 SCRM 工具",
                "target_audience_insights": ["企业老板"],
                "core_features": ["客户分层", "SOP 跟进"],
                "use_cases": ["私域转化"],
                "differentiators": ["合规风控"],
            },
            benchmark_note=None,
            strategy_mode="research_first",
            use_model=True,
        )

    assert service.calls == note_strategy_service.NOTE_STRATEGY_MODEL_MAX_ATTEMPTS


def test_research_first_prompt_uses_recent_strategy_signals_as_light_avoidance():
    service = CapturingStrategyService()

    service.build_note_strategies(
        research_context={
            "product_name": "微伴助手",
            "summary": "企业微信私域 SCRM 工具",
            "target_audience_insights": ["企业老板"],
            "core_features": ["客户分层", "SOP 跟进"],
            "use_cases": ["私域转化"],
            "differentiators": ["合规风控"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        recent_strategy_signals=[
            "老板视角｜经营诊断型｜先拆老板为什么没长出来",
            "合规增长｜风险场景拆解型｜强调会话留痕和风险预警",
        ],
        use_model=True,
    )

    prompt = service.prompts[-1]
    assert "近期已覆盖的高层方向" in prompt
    assert "老板视角｜经营诊断型｜先拆老板为什么没长出来" in prompt
    assert "合规增长｜风险场景拆解型｜强调会话留痕和风险预警" in prompt
    assert "本轮不要把三套策略全部落回这些高层方向" in prompt
    assert "其余策略必须从更具体的新矛盾命题中展开" in prompt


def test_product_main_benchmark_prompt_keeps_product_main_but_requires_diverse_paths():
    service = CapturingStrategyService(product_usage_mode="product_main")

    service.build_note_strategies(
        research_context={
            "product_name": "微伴助手",
            "summary": "企业微信私域增长和 SCRM 工具",
            "target_audience_insights": ["企业老板"],
            "core_features": ["客户分层", "跟进 SOP", "会话存档"],
            "use_cases": ["私域转化", "客户管理"],
            "differentiators": ["合规风控", "销售协同"],
        },
        benchmark_note={
            "title": "客户都在企微，为什么还要换智能SCRM？",
            "desc": "传统企微打法太靠人工，客户分层、跟进、复购都容易断。",
            "content_category": "私域运营",
            "tags": ["企业微信", "SCRM", "私域转化"],
        },
        strategy_mode="benchmark_first",
        use_model=True,
    )

    prompt = service.prompts[-1]
    assert "当前策略模式：benchmark_first" in prompt
    assert "三套策略都可以产品主导" in prompt
    assert "不能统一写成“前面铺垫、最后才提产品”" in prompt
    assert "自行决定产品在标题、开头、正文、卡片中的自然呈现方式" in prompt
    assert "先找三个不同的具体矛盾命题" in prompt
    assert "不能改变前端、生文、生图依赖的字段结构" in prompt
    assert "【对标锚点优先级】" in prompt
    assert "对标相似度优先于近期避重和多样化" in prompt
    assert "必须至少有 1 套“对标主线贴近版”" in prompt
    assert "近期已覆盖方向只能避免标题、案例和分页原样重复" in prompt
    assert "如果近期方向与对标锚点冲突，优先保留对标锚点" in prompt
    assert "对标标题锚点：客户都在企微，为什么还要换智能SCRM？" in prompt


def test_benchmark_recent_signals_cannot_override_anchor_priority():
    service = CapturingStrategyService(product_usage_mode="product_assist")

    service.build_note_strategies(
        research_context={
            "product_name": "微伴助手",
            "summary": "企业微信私域增长和 SCRM 工具",
            "target_audience_insights": ["企业老板"],
            "core_features": ["客户分层", "跟进 SOP"],
            "use_cases": ["私域搭建"],
            "differentiators": ["合规风控"],
        },
        benchmark_note={
            "title": "企业微信社群私域 | 从0到1搭建保姆级指南",
            "desc": "新手如何从0到1搭建企业微信社群私域，按步骤完成基础设置、引流、首聊和社群维护。",
            "content_category": "企业微信教程",
            "tags": ["企业微信", "社群私域", "从0到1", "保姆级指南"],
        },
        strategy_mode="benchmark_first",
        recent_strategy_signals=[
            "从0到1搭建型｜保姆级搭建清单型｜延续对标的保姆级卡片教程节奏",
        ],
        use_model=True,
    )

    prompt = service.prompts[-1]
    assert "从0到1搭建型｜保姆级搭建清单型｜延续对标的保姆级卡片教程节奏" in prompt
    assert "对标标题锚点：企业微信社群私域 | 从0到1搭建保姆级指南" in prompt
    assert "近期已覆盖方向只能避免标题、案例和分页原样重复" in prompt
    assert "不能让你避开对标笔记的核心主题" in prompt
    assert "第二、第三套可以多样化" in prompt
