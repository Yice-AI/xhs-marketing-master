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


class PersonalIpMixedStrategyService(CapturingStrategyService):
    def _call_json(self, prompt, **kwargs):
        self.prompts.append(prompt)
        self.call_kwargs.append(kwargs)
        return {
            "selected_strategy_id": "opinion",
            "strategies": [
                {
                    "id": "opinion",
                    "label": "我为什么先停掉投放复盘自动化",
                    "summary": "讲一次具体投放复盘里先保留人工判断的经历。",
                    "targetAudience": "想用AI改造业务流程的人",
                    "corePainPoints": ["容易把判断交给AI"],
                    "coreBenefits": ["先找对该自动化的动作"],
                    "contentAngle": "个人IP判断复盘",
                    "noteGoal": "观点收束",
                    "visualDirection": "general",
                    "recommendedCardPlan": ["封面", "冲突", "判断", "过程", "收束"],
                    "suggestedTitle": "我为什么先停掉投放复盘自动化",
                    "contentIntent": "case_record",
                    "productRole": "none",
                },
                {
                    "id": "demo",
                    "label": "发布一个内容改写Demo",
                    "summary": "发布作品并征集反馈。",
                    "targetAudience": "内容运营",
                    "corePainPoints": ["改写慢"],
                    "coreBenefits": ["减少重复动作"],
                    "contentAngle": "项目发布",
                    "noteGoal": "反馈征集",
                    "visualDirection": "general",
                    "recommendedCardPlan": ["封面", "场景", "Demo", "反馈"],
                    "suggestedTitle": "我把内容改写Demo先放出来试试",
                    "contentIntent": "launch",
                    "productRole": "demo",
                },
            ],
        }


class FailingStrategyService(CapturingStrategyService):
    def __init__(self):
        super().__init__()
        self.calls = 0

    def _call_json(self, prompt, **kwargs):
        self.calls += 1
        raise RuntimeError("500 server_error")


class AbstractLabelStrategyService(CapturingStrategyService):
    def _call_json(self, prompt, **kwargs):
        self.prompts.append(prompt)
        self.call_kwargs.append(kwargs)
        return {
            "selected_strategy_id": "s1",
            "strategies": [
                {
                    "id": "s1",
                    "label": "渠道追踪失真型｜老板终于看清哪路客户更值钱",
                    "summary": "用投放复盘场景拆清渠道、客户和成交结果之间的关系。",
                    "targetAudience": "企业老板和市场负责人",
                    "corePainPoints": ["不同渠道都说带来客户，但后续成交时团队说不清谁更值钱"],
                    "coreBenefits": ["把渠道来源、客户标签和成交结果连起来复盘"],
                    "contentAngle": "经营复盘型问题解决内容：用一个老板最常见的投放误判场景，拆出为什么私域获客复盘总失真",
                    "noteGoal": "让老板知道私域复盘不能只看加了多少人",
                    "visualDirection": "benefit",
                    "recommendedCardPlan": ["封面", "问题", "复盘", "解决", "收束"],
                    "suggestedTitle": "不是线索少，是你根本不知道哪路客户真的能成交",
                },
                {
                    "id": "s2",
                    "label": "分群触达失灵型",
                    "summary": "从客户不回复切入，讲清为什么群发内容和客户阶段对不上。",
                    "targetAudience": "私域负责人",
                    "corePainPoints": ["客户明明沉淀在企微里，但群发越多回复越少"],
                    "coreBenefits": ["按标签、画像和生命周期安排触达动作"],
                    "contentAngle": "触达策略诊断型：围绕为什么很多企业私域看起来很勤奋，实际转化却越来越差",
                    "noteGoal": "让运营负责人重新检查触达动作",
                    "visualDirection": "general",
                    "recommendedCardPlan": ["封面", "错位", "分层", "动作", "收束"],
                    "suggestedTitle": "客户不是不回你，是你每次都把内容发错了人",
                },
            ],
        }


class CompressedLabelStrategyService(CapturingStrategyService):
    def _call_json(self, prompt, **kwargs):
        self.prompts.append(prompt)
        self.call_kwargs.append(kwargs)
        return {
            "selected_strategy_id": "s1",
            "strategies": [
                {
                    "id": "s1",
                    "label": "投了渠道却接不住客户",
                    "summary": "从线索来了但没人及时接的断点切入。",
                    "targetAudience": "企业老板",
                    "corePainPoints": ["客户加了企微但后续没人持续跟进"],
                    "coreBenefits": ["把渠道、客户和成交串成可复盘链路"],
                    "contentAngle": "问题解决型",
                    "noteGoal": "让老板看清线索承接问题",
                    "visualDirection": "benefit",
                    "recommendedCardPlan": ["封面", "断点", "误区", "解决", "收束"],
                    "suggestedTitle": "客户都加企微了，为什么还是成交不了？",
                }
            ],
        }


class AwkwardLabelStrategyService(CapturingStrategyService):
    def _call_json(self, prompt, **kwargs):
        self.prompts.append(prompt)
        self.call_kwargs.append(kwargs)
        return {
            "selected_strategy_id": "s1",
            "strategies": [
                {
                    "id": "s1",
                    "label": "多账号一起更最容易出事",
                    "summary": "从公众号团队多人协作更新的混乱切入。",
                    "targetAudience": "新媒体负责人",
                    "corePainPoints": ["多个账号同时更新时，审核、排期和发布责任容易断层"],
                    "coreBenefits": ["把多账号发布流程、内容状态和协作节点统一管理"],
                    "contentAngle": "团队协作问题解决型",
                    "noteGoal": "让新媒体负责人意识到多账号管理不能靠群聊盯",
                    "visualDirection": "benefit",
                    "recommendedCardPlan": ["封面", "混乱", "断点", "解决", "收束"],
                    "suggestedTitle": "多个公众号一起更新，最容易出事的不是排期，是没人盯进度",
                }
            ],
        }


class AwkwardPhraseStrategyService(CapturingStrategyService):
    def _call_json(self, prompt, **kwargs):
        self.prompts.append(prompt)
        self.call_kwargs.append(kwargs)
        return {
            "selected_strategy_id": "s1",
            "strategies": [
                {
                    "id": "s1",
                    "label": "为什么投了很多渠道，最后还是说不清哪个客户能成交？",
                    "summary": "渠道热闹但成交安静，说明复盘只看前端获客量。",
                    "targetAudience": "企业老板",
                    "corePainPoints": ["渠道热闹但成交安静，继续凭感觉投放会不断烧预算"],
                    "coreBenefits": ["把渠道来源、客户跟进和最终成交串起来"],
                    "contentAngle": "数据复盘型问题解决内容",
                    "noteGoal": "让老板看清渠道复盘为什么失真",
                    "visualDirection": "benefit",
                    "recommendedCardPlan": ["封面", "渠道热闹但成交安静", "断点", "解决", "收束"],
                    "suggestedTitle": "为什么投了很多渠道，最后还是说不清哪个客户能成交？",
                }
            ],
        }


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


def test_saas_research_first_normalizes_abstract_user_visible_labels():
    service = AbstractLabelStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "微伴助手",
            "summary": "企业微信私域 SCRM 工具",
            "target_audience_insights": ["企业老板", "市场负责人"],
            "core_features": ["客户分层", "渠道追踪", "SOP 跟进"],
            "use_cases": ["私域转化", "活动复盘"],
            "differentiators": ["合规风控"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    first, second = result["strategies"][:2]
    assert first["label"] == "渠道追踪失真型｜老板终于看清哪路客户更值钱"
    assert second["label"] == "分群触达失灵型"
    assert first["suggestedTitle"] == "不是线索少，是你根本不知道哪路客户真的能成交"
    assert second["suggestedTitle"] == "客户不是不回你，是你每次都把内容发错了人"
    assert first["contentAngle"].startswith("经营复盘型")
    assert "投放误判场景" in first["contentAngle"]
    assert second["contentAngle"].startswith("触达策略诊断型")
    assert "为什么很多企业私域" in second["contentAngle"]
    assert '"label": "策略卡片名：一句具体业务矛盾或策划判断，不是小红书正文标题"' in service.prompts[-1]
    assert '"contentAngle": "清晰可执行的内容角度，例如教程型/卖点种草型/问题解决型/功能推荐型；也可自由命名，但不能抽象黑话"' in service.prompts[-1]
    assert "label 是前端策略卡片名，也是生文里的策略名称" in service.prompts[-1]
    assert "suggestedTitle 才是小红书标题方向" in service.prompts[-1]


def test_saas_research_first_prefers_suggested_title_for_compressed_label():
    service = CompressedLabelStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "微伴助手",
            "summary": "企业微信私域 SCRM 工具",
            "target_audience_insights": ["企业老板", "市场负责人"],
            "core_features": ["客户分层", "渠道追踪", "SOP 跟进"],
            "use_cases": ["私域转化", "活动复盘"],
            "differentiators": ["合规风控"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    strategy = result["strategies"][0]
    assert strategy["label"] == "客户都加企微了，为什么还是成交不了？"
    assert "投了渠道却接不住客户" not in strategy["label"]
    assert "一句具体业务矛盾或策划判断" in service.prompts[-1]
    assert "投了渠道却接不住客户" in service.prompts[-1]


def test_saas_research_first_prefers_suggested_title_for_awkward_label():
    service = AwkwardLabelStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "壹伴",
            "summary": "公众号运营协作工具",
            "target_audience_insights": ["新媒体负责人", "内容团队"],
            "core_features": ["多账号管理", "内容排期", "团队协作"],
            "use_cases": ["公众号矩阵运营", "内容审核发布"],
            "differentiators": ["浏览器插件协作"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    strategy = result["strategies"][0]
    assert strategy["label"] == "多个公众号一起更新，最容易出事的不是排期，是没人盯进度"
    assert "更最容易" not in strategy["label"]
    assert strategy["contentAngle"] == "团队协作问题解决型"


def test_saas_research_first_rewrites_known_awkward_visible_phrases():
    service = AwkwardPhraseStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "微伴助手",
            "summary": "企业微信私域 SCRM 工具",
            "target_audience_insights": ["企业老板", "市场负责人"],
            "core_features": ["渠道追踪", "客户标签", "成交归因"],
            "use_cases": ["投放复盘", "活动复盘"],
            "differentiators": ["把客户来源、跟进动作和成交结果串起来"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    strategy = result["strategies"][0]
    visible_text = " ".join(
        [
            str(strategy["summary"]),
            " ".join(strategy["corePainPoints"]),
            " ".join(strategy["recommendedCardPlan"]),
        ]
    )
    assert "渠道热闹但成交安静" not in visible_text
    assert "渠道数据看着热闹，但真正成交的客户不清楚" in visible_text


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
    assert result["strategies"][0]["label"] == "方法主线执行版"
    first_strategy_text = " ".join([
        result["strategies"][0]["summary"],
        result["strategies"][0]["noteGoal"],
        " ".join(result["strategies"][0]["recommendedCardPlan"]),
    ])
    assert "Uplog" in first_strategy_text
    assert "工具动作页" in first_strategy_text
    assert "具体执行卡点" in first_strategy_text
    assert "产品轻承接页" not in first_strategy_text
    assert "辅助" not in first_strategy_text


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
    assert "【统一策略质量底线】" in prompt
    assert "像真实业务现场、真实人会点开的选题" in prompt
    assert "recommendedCardPlan 要有推进感" in prompt
    assert "【账号/内容类型路由】" not in prompt
    assert "路由结果：普通SaaS/产品" not in prompt
    assert '"accountType"' not in prompt
    assert '"productRole"' not in prompt
    assert '"contentIntent"' not in prompt
    assert '"closingGoal"' not in prompt
    assert "【对标锚点优先级】" not in prompt
    assert "contentAngle" in prompt
    assert "清晰可执行的内容角度" in prompt
    assert '"label": "策略卡片名：一句具体业务矛盾或策划判断，不是小红书正文标题"' in prompt
    assert "label 是前端策略卡片名，也是生文里的策略名称" in prompt
    assert "suggestedTitle 才是小红书标题方向" in prompt
    assert "用户可见策略名：必须是具体场景/矛盾/标题式短句" not in prompt
    assert "不能以“型/法/框架/路径/模型/模板”结尾" not in prompt
    assert "可用“XX型：一段完整策划角度”" not in prompt
    assert result["strategies"][0]["accountType"] == "saas"
    assert result["strategies"][0]["productRole"] == "solution"
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


def test_personal_ip_research_first_routes_to_concrete_topic_boundaries():
    service = CapturingStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "一策｜从增长信号到AI产品资产",
            "summary": "记录者型AI个人IP，围绕增长、投放、内容、运营中的真实问题，用AI与vibe coding做出可复用资产。",
            "target_audience_insights": ["想用AI改造业务流程的人", "准备做个人产品或个人IP的人"],
            "core_features": ["AI博主个人IP", "真实构建日志", "判断复盘", "踩坑修正"],
            "use_cases": ["解释AI热点并给出实践者判断", "记录从业务问题到AI小工具的构建过程"],
            "differentiators": ["不是工具搬运号", "人设是正在做的人"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    prompt = service.prompts[-1]
    strategy = result["strategies"][0]
    assert "内容类型判断：个人IP" in prompt
    assert "内容主角是人的经历、判断、冲突、过程和观点" in prompt
    assert "这个边界只决定产品、账号资产或链接怎么出现，不替代原有策略主引擎" in prompt
    assert '"accountType"' not in prompt
    assert '"productRole"' not in prompt
    assert "多样化在“真实项目过程、判断变化、踩坑复盘、砍功能、发布 Demo、热点观点、从业务问题长出工具”里展开" in prompt
    assert result["product_usage_mode"] == "no_product"
    assert strategy["accountType"] == "personal_ip"
    assert strategy["productRole"] == "none"


def test_personal_ip_github_material_signal_does_not_force_open_source_route():
    service = CapturingStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "一策｜从增长信号到AI产品资产",
            "summary": "记录者型AI个人IP，围绕增长、投放、内容、运营中的真实问题做判断复盘。",
            "target_audience_insights": ["想用AI改造业务流程的人"],
            "core_features": ["AI博主个人IP", "真实构建日志", "判断复盘", "踩坑修正"],
            "use_cases": ["解释AI热点并给出实践者判断", "记录从业务问题到AI小工具的构建过程"],
            "differentiators": ["不是工具搬运号", "人设是正在做的人"],
            "material_signals": ["热点观点文默认不带产品名", "发布作品时才带GitHub/Demo链接"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    prompt = service.prompts[-1]
    strategy = result["strategies"][0]
    assert "内容类型判断：个人IP" in prompt
    assert "accountType=open_source_project" not in prompt
    assert '"accountType"' not in prompt
    assert '"productRole"' not in prompt
    assert result["product_usage_mode"] == "no_product"
    assert strategy["accountType"] == "personal_ip"
    assert strategy["productRole"] == "none"


def test_personal_ip_with_demo_and_mvp_language_still_routes_personal_ip():
    service = CapturingStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "一策｜从增长信号到 AI 产品资产",
            "summary": "一个记录者型 AI 个人 IP，围绕增长、投放、内容、运营中的真实问题，用 AI 与 vibe coding 做出可复用资产。",
            "target_audience_insights": ["准备做个人产品、独立项目或个人 IP，但不想只停留在概念层的人"],
            "core_features": [
                "以 AI 博主个人 IP 形态输出，不是标准产品种草号",
                "尽量附带可验证产出，如工具、模板、prompt、工作流、检查表、页面、复盘",
            ],
            "use_cases": [
                "从业务问题中提取需求，快速做出 AI 工具第一版并验证",
                "记录个人产品或独立项目从需求发现到 MVP 搭建的全过程",
            ],
            "differentiators": ["区别于炫技 demo：强调能否落地、能否复用、能否形成资产"],
            "material_signals": ["适合积累工作流截图、prompt 迭代记录、页面原型"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    prompt = service.prompts[-1]
    strategy = result["strategies"][0]
    assert "内容类型判断：个人IP" in prompt
    assert "accountType=open_source_project" not in prompt
    assert '"accountType"' not in prompt
    assert '"productRole"' not in prompt
    assert result["product_usage_mode"] == "no_product"
    assert strategy["accountType"] == "personal_ip"
    assert strategy["productRole"] == "none"


def test_personal_ip_response_usage_follows_selected_strategy_not_demo_candidate():
    service = PersonalIpMixedStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "一策｜从增长信号到AI产品资产",
            "summary": "记录者型AI个人IP，围绕增长、投放、内容、运营中的真实问题做判断复盘。",
            "target_audience_insights": ["想用AI改造业务流程的人"],
            "core_features": ["AI博主个人IP", "真实构建日志", "判断复盘", "踩坑修正"],
            "use_cases": ["解释AI热点并给出实践者判断"],
            "differentiators": ["不是工具搬运号", "人设是正在做的人"],
            "material_signals": ["发布作品时才带GitHub/Demo链接"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    prompt = service.prompts[-1]
    assert "至少两套必须是 no_product 的观点/复盘/判断内容" in prompt
    assert "禁止使用 XX、某个、某一步、这一步、那一步" in prompt
    assert result["selected_strategy_id"] == "opinion"
    assert result["product_usage_mode"] == "no_product"
    assert result["strategies"][0]["productRole"] == "none"
    assert result["strategies"][0]["productUsageMode"] == "no_product"
    assert result["strategies"][1]["productRole"] == "demo"
    assert result["strategies"][1]["productUsageMode"] == "product_assist"


def test_personal_ip_conditional_demo_material_does_not_make_all_strategies_launch():
    service = CapturingStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "一策｜从增长信号到AI产品资产",
            "summary": "记录者型AI个人IP，平常写判断复盘和真实构建过程，只有发布 Demo、GitHub 或作品时才自然带链接。",
            "target_audience_insights": ["想用AI改造业务流程的人"],
            "core_features": ["AI博主个人IP", "真实构建日志", "判断复盘"],
            "use_cases": ["解释AI热点并给出实践者判断"],
            "differentiators": ["不是工具搬运号", "人设是正在做的人"],
            "material_signals": ["热点观点文默认不带产品名", "发布作品时才带 GitHub/Demo 链接"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    strategy = result["strategies"][0]
    assert result["product_usage_mode"] == "no_product"
    assert strategy["accountType"] == "personal_ip"
    assert strategy["productRole"] == "none"
    assert strategy["productUsageMode"] == "no_product"


def test_open_source_personal_project_allows_launch_role_without_hard_ad():
    service = CapturingStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "PatchPilot 开源CLI",
            "summary": "独立开发者做的开源命令行工具，帮助开发者把本地改动整理成可读PR说明。",
            "target_audience_insights": ["独立开发者", "开源维护者"],
            "core_features": ["读取git diff", "生成PR说明", "风险点提醒", "GitHub链接"],
            "use_cases": ["每次提交前不知道怎么写PR描述", "维护开源项目时需要快速解释改动"],
            "differentiators": ["开源可审计", "本地运行"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    prompt = service.prompts[-1]
    strategy = result["strategies"][0]
    assert "内容类型判断：个人IP宣传自己的项目/开源工具" in prompt
    assert "允许出现 Demo/GitHub/开源工具，但必须像项目进展或经验复盘" in prompt
    assert '"accountType"' not in prompt
    assert '"productRole"' not in prompt
    assert result["product_usage_mode"] == "product_assist"
    assert strategy["accountType"] == "open_source_project"
    assert strategy["productRole"] == "launch"


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
    assert "【账号/内容类型路由】" not in prompt
    assert "路由结果：普通SaaS/产品" not in prompt
    assert '"accountType"' not in prompt
    assert '"productRole"' not in prompt
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


def test_tool_product_assist_requires_concrete_action_bridge_not_internal_language():
    service = CapturingStrategyService(product_usage_mode="product_assist")

    service.build_note_strategies(
        research_context={
            "product_name": "Uplog",
            "summary": "面向小红书创作者的发布前工作流工具",
            "target_audience_insights": ["小红书创作者", "内容团队"],
            "core_features": ["一键导入内容", "分页排版", "统一水印", "违规检查"],
            "use_cases": ["写完内容后卡在导入和排版", "临发前反复检查漏项"],
            "differentiators": ["减少复制粘贴和排版返工"],
        },
        benchmark_note={
            "title": "小红书爆款内容5大密码",
            "desc": "标题、画面、分享点、发布时间和互动口都要设计好。",
            "content_category": "教程",
            "tags": ["小红书运营", "爆款笔记"],
        },
        strategy_mode="benchmark_first",
        use_model=True,
    )

    prompt = service.prompts[-1]
    assert "内容类型判断：工具/App" in prompt
    assert '"accountType"' not in prompt
    assert '"productRole"' not in prompt
    assert "如果产品只接住其中一环，必须写成用户正在做的具体动作" in prompt
    assert "产品接入必须翻译成用户能读懂的具体动作桥" in prompt
    assert "内容主线 + 具体工具动作接入" in prompt
    assert "产品轻承接页/工具辅助页" not in prompt
    assert "适合放在最后" not in prompt
    assert "当前产品资料里的真实工作流" in prompt
    assert "一键导入内容" in prompt
    assert "分页排版" in prompt
    assert "统一水印" in prompt
    assert "违规检查" in prompt


def test_tool_route_prompt_does_not_inject_fixed_uplog_workflow_terms():
    route = note_strategy_service._infer_account_content_route(
        {
            "product_name": "壹伴",
            "summary": "公众号运营浏览器插件和内容协作工具",
            "core_features": ["公众号排版增强", "素材采集", "多账号管理", "团队协作与审核"],
            "use_cases": ["多个公众号同时更新", "内容审核发布", "团队靠群聊催稿"],
            "differentiators": ["贴在公众号编辑器旁边的工作流"],
        },
        product_usage_mode="product_main",
        normalized_strategy_mode="research_first",
    )

    assert route["account_type"] == "tool"
    assert "导入、分页、统一水印、违规检查" not in route["diversity_boundary"]
    assert "当前产品资料" in route["diversity_boundary"]


def test_local_service_route_adds_boundary_without_schema_expansion():
    service = CapturingStrategyService()

    result = service.build_note_strategies(
        research_context={
            "product_name": "甜屿手作蛋糕",
            "summary": "社区手作蛋糕店，主打低甜生日蛋糕、下午茶小蛋糕和节日礼盒，支持附近自提。",
            "target_audience_insights": ["附近上班族", "给家人朋友订生日蛋糕的人"],
            "core_features": ["低甜奶油", "当日现做", "附近自提", "顾客反馈真实"],
            "use_cases": ["临时送礼", "生日聚会", "下午茶"],
            "differentiators": ["口味稳定", "不腻", "取货方便"],
        },
        benchmark_note=None,
        strategy_mode="research_first",
        use_model=True,
    )

    prompt = service.prompts[-1]
    strategy = result["strategies"][0]
    assert "内容类型判断：本地门店/服务" in prompt
    assert "消费场景、信任理由和收藏/到店/下单动作" in prompt
    assert "不要写成泛运营方法论" in prompt
    assert "生日、下午茶、节日礼盒、低甜口味、附近自提、真实反馈、临时送礼" in prompt
    assert '"accountType"' not in prompt
    assert '"productRole"' not in prompt
    assert strategy["accountType"] == "service"
    assert strategy["productRole"] == "solution"
