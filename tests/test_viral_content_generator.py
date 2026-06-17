from backend.config import settings
from backend.services.content_analyzer import is_retryable_text_generation_error
from backend.services.viral_content_generator import (
    XHS_BODY_MAX_CHARS,
    XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
    XHS_TITLE_MAX_CHARS,
    ViralContentGenerator,
    _body_publish_quality_flags,
    _body_has_visible_change,
    _body_has_meaningful_change,
    _build_safe_minimal_polish,
    _build_dynamic_xhs_style_guide,
    _build_strategy_expression_seed,
    _build_strategy_direct_title_fallbacks,
    _derive_publish_tags,
    _evaluate_polished_body,
    _extract_required_terms,
    _finalize_publish_body_limit,
    _format_product_usage_constraints,
    _get_note_strategy_product_usage_mode,
    _ensure_product_assist_bridge,
    _finalize_body_complete_guard,
    _build_product_assist_bridge_paragraph,
    _is_structurally_incomplete_publish_body,
    _polish_xhs_emoji_layout,
    _rank_publish_title_candidates,
    _strip_trailing_hashtag_block,
    _title_publish_quality_score,
    _xhs_layout_emoji_count,
)


def _long_xhs_body(prefix: str = "很多运营改笔记，卡住的不是不会写。") -> str:
    return "\n\n".join([
        prefix,
        "第一步先把真实场景写清楚。用户看到的不是功能清单，而是自己每天会遇到的麻烦，所以开头要先把那个卡点说出来。比如一篇笔记从选题到发布，中间会经过找素材、改标题、排版、检查风险这些小动作，每一步都可能让人停下来。",
        "第二步再给出判断。比如哪里最容易断、为什么以前的方法不好用、读者现在应该先检查哪一步，这样正文才不会像泛泛而谈。真正能让人评论的内容，通常不是一句大道理，而是读者看到后觉得“这不就是我昨天遇到的问题吗”。",
        "第三步再自然带到产品。产品只解决一个明确问题，不要一上来就堆卖点，读者更容易接受这种表达。你可以把功能翻译成场景里的动作，比如少复制一次、少改一次格式、发布前少漏一次敏感词。",
        "最后给一个具体行动。可以让用户先对照自己的流程查一遍，再决定要不要咨询或试用。这样结尾不是硬推销，而是把评论区的话题留出来，让读者愿意说说自己最卡在哪一步。整篇笔记也会更像一次真实经验分享，而不是把产品说明书换了个说法发出去。",
    ])


def test_required_terms_ignore_benchmark_hook_words_not_used_by_draft():
    product_info = {
        "product_name": "微伴助手",
        "product_features": "线索接待, 客户分层, SOP 跟进",
        "must_include": "私域运营",
    }
    benchmark_note = {"title": "做私域很多老板踩的坑不是不会做而是每天都在打执行仗"}
    draft = "微伴助手可以把私域运营里的线索接待、客户分层和 SOP 跟进串起来。"

    terms = _extract_required_terms(product_info, benchmark_note, source_text=draft)

    assert "微伴助手" in terms
    assert "私域运营" in terms
    assert "线索接待" in terms
    assert "不是" not in terms
    assert "每天都在打执行仗" not in terms


def test_product_usage_constraints_do_not_apply_without_strategy():
    assert _get_note_strategy_product_usage_mode(None) == ""
    assert _format_product_usage_constraints(None) == ""


def test_product_main_does_not_add_rewrite_constraint():
    note_strategy = {
        "productUsageMode": "product_main",
        "benchmarkFit": {"product_usage_mode": "product_main", "fit_level": "strong_fit"},
    }

    assert _get_note_strategy_product_usage_mode(note_strategy) == "product_main"
    assert _format_product_usage_constraints(note_strategy) == ""


def test_restrictive_product_usage_modes_keep_constraints():
    assist_strategy = {
        "productUsageMode": "product_assist",
        "benchmarkFit": {"product_usage_mode": "product_assist", "fit_level": "soft_fit"},
    }
    no_product_strategy = {
        "productUsageMode": "no_product",
        "benchmarkFit": {"product_usage_mode": "no_product", "fit_level": "no_fit"},
    }

    assist_constraints = _format_product_usage_constraints(assist_strategy)
    no_product_constraints = _format_product_usage_constraints(no_product_strategy)

    assert "产品介入约束：product_assist" in assist_constraints
    assert "产品只可作为辅助承接" in assist_constraints
    assert "产品介入约束：no_product" in no_product_constraints
    assert "禁止出现产品名" in no_product_constraints


def test_strategy_expression_seed_adapts_to_content_tool():
    seed = _build_strategy_expression_seed(
        {
            "product_name": "Uplog",
            "product_features": "一键导入公众号文章，模板自动分页，一键添加水印，违规检测，AI写作助手",
            "target_audience": "小编，自媒体",
        },
        {
            "label": "小编工作流提效",
            "contentAngle": "从复制粘贴到发布前检查的真实工作流",
            "corePainPoints": ["复制粘贴麻烦", "排版慢", "敏感词不敢发"],
            "coreBenefits": ["模板套用", "自动分页", "违规检测"],
        },
        {"title": "小红书笔记发布前检查清单"},
    )
    guide = _build_dynamic_xhs_style_guide({}, seed)

    assert seed["product_category_hint"] == "内容工具/写作效率"
    assert "小编" in guide
    assert "✍️" in guide
    assert "社群" not in seed["emoji_style_hint"]


def test_polished_body_passes_when_only_benchmark_hook_words_are_missing():
    product_info = {
        "product_name": "微伴助手",
        "product_features": "线索接待, 客户分层, SOP 跟进",
        "must_include": "私域运营",
    }
    benchmark_note = {"title": "做私域很多老板踩的坑不是不会做而是每天都在打执行仗"}
    draft = "\n\n".join(
        [
            "微伴助手可以把私域运营里的线索接待、客户分层和 SOP 跟进串起来，前端活动、后端转化和数据复盘不会断成几张表。",
            "销售不用在表格里来回翻，管理者也能看到每条线索到了哪一步，哪类客户需要继续跟，哪类客户可以先沉淀。",
            "适合已经有企微基础，但流程还靠人盯人的团队，先把重复动作交给系统，团队精力才能放回真实沟通。",
        ]
    )
    polished = draft.replace("销售不用在表格里来回翻", "销售不用反复翻表格")

    ok, reason = _evaluate_polished_body(
        body_draft=draft,
        polished_body=polished,
        product_info=product_info,
        benchmark_note=benchmark_note,
        tags=["私域运营", "企微"],
        minimum_ratio=0.78,
        max_paragraph_drop=0,
        missing_term_threshold=3,
        enforce_tag_semantics=False,
    )

    assert ok, reason


def test_safe_minimal_polish_keeps_structure_and_replaces_ai_markers():
    draft = "\n\n".join(
        [
            "家人们谁懂，微伴助手这个线索接待真的绝了。",
            "客户分层、SOP 跟进都在一个流程里，销售不用每天手动追。",
        ]
    )

    polished, notes = _build_safe_minimal_polish(draft)

    assert len(polished.split("\n\n")) == 2
    assert "家人们谁懂" not in polished
    assert "真的绝了" not in polished
    assert "微伴助手" in polished
    assert notes


def test_safe_minimal_polish_splits_long_formula_sentence():
    draft = (
        "微伴助手能够提供线索接待、客户分层、SOP 跟进、数据复盘这些能力，"
        "让私域运营团队减少重复动作，把时间放回真实客户沟通。"
    )

    polished, notes = _build_safe_minimal_polish(draft)

    assert polished != draft
    assert "能够" not in polished
    assert "给到" in polished
    assert notes


def test_safe_minimal_polish_changes_common_written_phrases():
    draft = "微伴助手可以帮助团队使用 SOP 进行客户跟进，同时提升私域运营效率。"

    polished, notes = _build_safe_minimal_polish(draft)

    assert _body_has_visible_change(draft, polished)
    assert polished != draft
    assert notes


def test_strip_trailing_hashtag_block_removes_duplicate_publish_tags():
    body = "第一段讲痛点。\n\n第二段讲方案。\n\n#私域运营 #客户跟进 #微伴助手"

    cleaned, tags = _strip_trailing_hashtag_block(body, ["私域运营", "#企微"])

    assert cleaned == "第一段讲痛点。\n\n第二段讲方案。"
    assert tags == ["私域运营", "企微", "客户跟进", "微伴助手"]


def test_strip_trailing_hashtag_block_keeps_inline_topic_text():
    body = "正文里自然提到 #私域运营 这个话题，但不是发布标签块。"

    cleaned, tags = _strip_trailing_hashtag_block(body, ["私域运营"])

    assert cleaned == body
    assert tags == ["私域运营"]


def test_meaningful_change_rejects_tiny_suffix_edit():
    draft = "微伴助手能把客户分层、SOP提醒和复盘链路放到一个流程里。" * 18
    candidate = draft + "哈啊"

    assert _body_has_visible_change(draft, candidate)
    assert not _body_has_meaningful_change(
        draft,
        candidate,
        min_ratio=0.06,
        min_changed_chars=60,
    )


def test_publish_limit_fit_rewrites_instead_of_truncating():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            pass

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            return {
                "title_candidates": ["私域运营别再硬扛"],
                "body": "自然压缩后的正文。" * 20,
                "notes": ["合并重复铺垫"],
            }

    long_title = "这是一个明显超过二十个字的小红书标题需要自然重写"
    long_body = "这是一段很长的正文，" * 120
    result = FakeGenerator()._fit_to_xhs_publish_limits(
        title_candidates=[long_title],
        body=long_body,
        product_info={"product_name": "微伴助手"},
        note_strategy="保留核心卖点",
    )

    assert result["changed"] is True
    assert len(result["title_candidates"][0]) <= XHS_TITLE_MAX_CHARS
    assert len(result["body"]) <= XHS_BODY_MAX_CHARS
    assert result["body"] != long_body[:XHS_BODY_MAX_CHARS]


def test_publish_limit_fit_keeps_model_paragraph_layout_without_backend_reflow():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            pass

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            return {
                "title_candidates": ["私域运营别硬扛"],
                "body": "第一段保留场景。\n\n✅第一条能力\n✅第二条能力\n\n最后一段行动引导。",
                "notes": ["保留分段"],
            }

    long_body = "这是一段很长的正文，" * 120

    result = FakeGenerator()._fit_to_xhs_publish_limits(
        title_candidates=["这是一个明显超过二十个字的小红书标题需要自然重写"],
        body=long_body,
        product_info={"product_name": "微伴助手"},
        note_strategy="保留阅读节奏",
    )

    assert result["changed"] is True
    assert "\n\n" in result["body"]
    assert "✅第一条能力\n✅第二条能力" in result["body"]
    assert len(result["body"]) <= XHS_BODY_MAX_CHARS


def test_publish_limit_fit_prompt_requires_xhs_title_hook():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompt = ""

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompt = prompt
            return {
                "title_candidates": ["客户一来就乱了？"],
                "body": "自然压缩后的正文。",
                "notes": ["优化标题钩子"],
            }

    generator = FakeGenerator()
    generator._fit_to_xhs_publish_limits(
        title_candidates=["这是一个明显超过二十个字的小红书标题需要自然重写"],
        body="这是一段很长的正文，" * 120,
        product_info={"product_name": "微伴助手"},
        note_strategy="保留核心卖点",
    )

    assert "具体痛点" in generator.prompt
    assert "反差观点" in generator.prompt
    assert "不要只写抽象词" in generator.prompt
    assert "即使原标题已合规" in generator.prompt


def test_publish_title_rank_prefers_keyword_and_collection_value():
    ranked = _rank_publish_title_candidates(
        ["客户加了不少，为啥没沉淀？", "企业微信私域0-1框架", "老板先搭这6步"],
        benchmark_title="企业微信社群私域 | 从0到1搭建保姆级指南",
        strategy_title="企业微信私域从0到1，不是先拉群，而是先把这6步搭好",
        body="企业微信私域从0到1搭建，重点是先把流程和框架跑顺。",
    )

    assert ranked[0] == "企业微信私域0-1框架"
    assert all(len(title) <= XHS_TITLE_MAX_CHARS for title in ranked)


def test_body_publish_quality_flags_catch_function_checklist_overload():
    body = "\n".join(
        [
            "很多老板做企微私域，一开始就急着拉群。",
            "1️⃣员工信息设置",
            "✅ 统一员工名片",
            "✅ 设置欢迎语",
            "✅ 配好自动回复",
            "2️⃣引流",
            "✅ 渠道活码",
            "✅ 裂变活动",
            "✅ 区域活码",
            "3️⃣社群",
            "✅ 群欢迎语",
            "✅ 群规则",
            "✅ 自动回复",
            "✅ 防骚扰",
        ]
    )

    flags = _body_publish_quality_flags(
        body,
        title_candidates=["客户一来就乱？老板先搭这6步"],
        benchmark_title="企业微信社群私域 | 从0到1搭建保姆级指南",
        strategy_title="企业微信私域从0到1，不是先拉群，而是先把这6步搭好",
    )

    assert "checklist_overload" in flags
    assert "bare_function_list" in flags


def test_structural_guard_catches_long_body_missing_strategy_steps():
    body = (
        "很多老板做企业微信私域，前面铺垫很多，看起来已经是一篇长稿，但结构只写到第四步。"
        * 18
        + "\n\n1️⃣ 先区分客户来源\n客户从哪里来要先分清。\n\n"
        + "2️⃣ 再做基础标签\n标签是后续跟进的基础。\n\n"
        + "3️⃣ 群规则先立住\n群不是拉起来就结束。\n\n"
        + "4️⃣ 跟进动作统一\n不要全靠员工感觉。\n\n"
        + "如果要把动作固定下来，可以用工具辅助团队沉淀流程。"
    )

    assert len(body) >= 800
    assert _is_structurally_incomplete_publish_body(
        body,
        contract={
            "strict_structure_units": True,
            "structure_units": [
                "先讲私域误区",
                "区分客户来源",
                "建立客户标签",
                "统一社群规则",
                "固定跟进SOP",
                "处理交接和复盘",
            ]
        },
    )


def test_title_score_penalizes_promised_steps_missing_in_body():
    body = (
        "1️⃣ 先区分客户来源\n客户从哪里来要先分清。\n\n"
        "2️⃣ 再做基础标签\n标签是后续跟进的基础。\n\n"
        "3️⃣ 群规则先立住\n群不是拉起来就结束。\n\n"
        "4️⃣ 跟进动作统一\n不要全靠员工感觉。"
    )

    promised_score = _title_publish_quality_score("老板复盘私域先查这6步", body=body)
    honest_score = _title_publish_quality_score("私域从0到1先搭底盘", body=body)

    assert honest_score > promised_score


def test_finalize_publish_body_keeps_safe_limit_and_complete_sentence():
    body = "这是完整前文。" * 65 + "最后这句会被截断，导致结尾不稳，不容。"

    finalized, notes = _finalize_publish_body_limit(body, soft_limit=120, hard_limit=140)

    assert len(finalized) <= 120
    assert finalized.endswith("。")
    assert "不容。" not in finalized
    assert notes


def test_body_publish_quality_flags_catch_plain_xhs_layout():
    base_body = (
        "很多老板做企业微信私域，一开始以为重点是多拉群、多加人，真正做下来才发现，"
        "私域能不能沉淀，先看客户进来后有没有被接住。\n\n"
        "从0到1搭框架时，先别急着堆功能，可以先把6个基础动作跑顺：员工形象、引流入口、"
        "社群规则、用户分层、风险交接和后续运营。\n\n"
        "员工名片、欢迎语和自动回复，看起来是小配置，其实决定客户加上企微后的第一印象："
        "你专不专业、回得快不快、有没有人接住。\n\n"
        "引流这一步也别只看加了多少人，更要分清客户从哪里来。渠道、裂变、门店入口分开，"
        "后面复盘才知道哪条链路值得继续投。\n\n"
        "社群不是人越多越好，而是欢迎、规则、答疑和内容节奏先立住。这样员工不用反复救火，"
        "用户也知道这个群到底有什么价值。\n\n"
        "最后再看分层、交接和风险。说到底，企业微信私域不是多一个工具，而是把客户资产、"
        "团队动作和经营结果串起来。"
    )
    body = f"{base_body}\n\n{base_body}"

    flags = _body_publish_quality_flags(
        body,
        title_candidates=["企业微信私域0-1框架"],
        benchmark_title="企业微信社群私域 | 从0到1搭建保姆级指南",
        strategy_title="企业微信私域从0到1，不是先拉群，而是先把这6步搭好",
    )

    assert len(body) >= 650
    assert _xhs_layout_emoji_count(body) == 0
    assert "layout_too_plain" in flags


def test_body_publish_quality_flags_catch_weak_emoji_style():
    base_body = (
        "如果你是老板或运营负责人，先别急着研究活动玩法。企微社群私域从0到1，先把最小闭环搭出来："
        "账号设置、引流入口、社群承接、用户分层、风险管控、日常运营。📌\n\n"
        "1️⃣先做账号和员工信息统一\n"
        "先把头像、昵称、职位、门店业务信息定规范，别让客户一进来看到一堆风格不一的个人号。\n\n"
        "2️⃣先把引流入口分清楚\n"
        "不同渠道来的客户，后面跟进节奏完全不一样。入口分清，复盘时才知道哪条链路更值得继续放大。\n\n"
        "3️⃣社群搭建先设规则\n"
        "欢迎语、群规、常见问题回复、群内容节奏都要提前设好，用户进来才知道这个群有什么价值。✨\n\n"
        "4️⃣用户分层要跟动作绑定\n"
        "只打标签不跟进没有意义，要让不同客户进入不同话术、内容和转化路径，团队执行才不会乱。\n\n"
        "5️⃣风险管控别等出事才补\n"
        "员工离职、客户交接、敏感词、服务记录，都要提前留痕，别让客户资产跟着个人流走。📌"
    )
    body = f"{base_body}\n\n{base_body}"

    flags = _body_publish_quality_flags(
        body,
        title_candidates=["企业微信私域0-1框架"],
        benchmark_title="企业微信社群私域 | 从0到1搭建保姆级指南",
        strategy_title="企业微信私域从0到1，不是先拉群，而是先把这6步搭好",
    )

    assert len(body) >= 650
    assert _xhs_layout_emoji_count(body) >= 3
    assert "layout_too_plain" not in flags
    assert "emoji_style_weak" in flags


def test_polish_xhs_emoji_layout_adds_contextual_emojis_without_rewriting():
    body = (
        "如果老板只盯着投了多少钱带来多少客户，其实还不够，更关键的是客户到底从哪里来，"
        "哪条链路效果更好，后面能不能持续放大。\n\n"
        "3️⃣ 社群搭建：从建群到活跃，规则先行\n"
        "自动欢迎语：新人进群不迷茫\n"
        "群内自动回复：客户提问秒响应\n"
        "防骚扰规则：社群环境干干净净\n\n"
        "建群时就要把欢迎语、群规则、常见问题回复、群内容节奏都设好。"
        "这样用户一进来就知道这是个什么群，有什么价值，也能减少员工重复答疑的时间。\n\n"
        "后续再通过红包、签到、活动、定期清理无效成员这些动作，把活跃和提纯一起做，"
        "社群才不会慢慢变成死群。\n\n"
        "4️⃣ 用户分层：精准运营，不做无效触达"
    )

    polished, notes = _polish_xhs_emoji_layout(body, max_chars=len(body) + 10)
    normalized = polished
    for emoji in [" 💡", " 👥", " ✅", " 🔥", " 🎯", " ⚠️", " 👇"]:
        normalized = normalized.replace(emoji, "")

    assert normalized == body
    assert "持续放大。 💡" in polished
    assert "3️⃣ 社群搭建：从建群到活跃，规则先行 👥" in polished
    assert "社群才不会慢慢变成死群。 🔥" in polished
    assert "4️⃣ 用户分层：精准运营，不做无效触达 🎯" in polished
    assert notes


def test_polish_xhs_emoji_layout_uses_content_tool_profile():
    body = (
        "小编最怕的不是不会写，而是一篇公众号文章要搬到小红书时，复制、删改、排版、检查全靠手动。\n\n"
        "1️⃣ 先把文章一键导入\n"
        "不用来回复制粘贴，先把原文结构完整带进来。\n\n"
        "2️⃣ 再套模板自动分页\n"
        "标题、正文、分段和卡片节奏先排顺，减少反复调格式的时间。\n\n"
        "3️⃣ 发布前做违规检测\n"
        "敏感词和风险提示提前看一遍，不要等发出去才发现要重改。"
    )
    style_profile = {"product_category_hint": "内容工具/写作效率", "opening_emoji": "✍️"}

    polished, notes = _polish_xhs_emoji_layout(body, max_chars=len(body) + 20, style_profile=style_profile)
    normalized = polished
    for emoji in [" ✍️", " 📝", " ✅", " ⚠️", " 👇", " 💡"]:
        normalized = normalized.replace(emoji, "")

    assert normalized == body
    assert "全靠手动。 ✍️" in polished
    assert "2️⃣ 再套模板自动分页 📝" in polished
    assert "3️⃣ 发布前做违规检测 ⚠️" in polished
    assert "👥" not in polished
    assert notes


def test_derive_publish_tags_from_title_body_and_product_info():
    tags = _derive_publish_tags(
        title="企业微信社群私域从0到1保姆级指南",
        body="这篇讲企业微信私域、社群运营、客户分层和转化复盘。",
        product_info={"product_name": "微伴助手", "target_audience": "老板", "must_include": "企微私域"},
        benchmark_note={"tags": ["企业微信", "私域运营"]},
        note_strategy={"coreBenefits": ["客户管理", "自动化运营"]},
    )

    assert "企业微信" in tags
    assert "私域运营" in tags
    assert tags


def test_product_assist_quality_flags_require_light_bridge():
    body = _long_xhs_body("发公众号前，很多细节不是不会做，而是忙起来就会漏。")

    missing_flags = _body_publish_quality_flags(
        body,
        title_candidates=["发文前这几项别漏"],
        product_usage_mode="product_assist",
        product_info={
            "product_name": "壹伴助手",
            "product_features": "公众号排版、敏感词检查、素材管理、AI辅助写作",
        },
    )

    bridged_flags = _body_publish_quality_flags(
        body + "\n\n壹伴助手适合放在最后做辅助承接，把排版、敏感词检查和素材管理这些发布前动作固定下来。",
        title_candidates=["发文前这几项别漏"],
        product_usage_mode="product_assist",
        product_info={
            "product_name": "壹伴助手",
            "product_features": "公众号排版、敏感词检查、素材管理、AI辅助写作",
        },
    )

    assert "product_assist_missing_bridge" in missing_flags
    assert "product_assist_missing_bridge" not in bridged_flags


def test_product_assist_bridge_must_be_in_tail_not_earlier_body():
    body = (
        "壹伴助手可以辅助公众号排版和敏感词检查。\n\n"
        + _long_xhs_body("发公众号前，很多细节不是不会做，而是忙起来就会漏。")
        + "\n\n4️⃣ 工具的作用，是帮标准落地，不是替你定标准。"
    )

    flags = _body_publish_quality_flags(
        body,
        title_candidates=["账号风格老变，先查标准"],
        product_usage_mode="product_assist",
        product_info={
            "product_name": "壹伴助手",
            "product_features": "公众号排版、敏感词检查、素材管理、AI辅助写作",
        },
    )

    assert "product_assist_missing_bridge" in flags


def test_ensure_product_assist_bridge_adds_short_deterministic_bridge():
    body = _long_xhs_body("发公众号前，很多细节不是不会做，而是忙起来就会漏。")

    bridged, notes = _ensure_product_assist_bridge(
        body,
        {
            "product_name": "壹伴助手",
            "product_features": "公众号排版、敏感词检查、素材管理、AI辅助写作",
        },
        max_chars=XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
    )
    flags = _body_publish_quality_flags(
        bridged,
        title_candidates=["发文前这几项别漏"],
        product_usage_mode="product_assist",
        product_info={
            "product_name": "壹伴助手",
            "product_features": "公众号排版、敏感词检查、素材管理、AI辅助写作",
        },
    )

    assert len(bridged) <= XHS_STRATEGY_BODY_TARGET_MAX_CHARS
    assert "壹伴助手" in bridged
    assert "product_assist_missing_bridge" not in flags
    assert notes


def test_finalize_body_complete_guard_clips_to_complete_sentence():
    body = _long_xhs_body("追热点前，先想清楚账号定位。") + "\n\n如果你也有追完热点更乱"

    guarded, notes = _finalize_body_complete_guard(body)

    assert guarded.endswith(("。", "！", "？", "!", "?"))
    assert "更乱" not in guarded
    assert notes


def test_product_assist_bridge_respects_product_category():
    private_domain_bridge = _build_product_assist_bridge_paragraph(
        {
            "product_name": "微伴助手",
            "target_audience": "私域团队、销售管理者",
            "product_features": "客户记录、会话留痕、客户标签、SOP跟进",
        }
    )
    content_tool_bridge = _build_product_assist_bridge_paragraph(
        {
            "product_name": "壹伴助手",
            "target_audience": "公众号运营者、新媒体编辑",
            "product_features": "公众号排版、敏感词检查、素材管理、AI辅助写作",
        }
    )

    assert "客户承接流程" in private_domain_bridge
    assert "重复询问" in private_domain_bridge
    assert "发布前固定流程" not in private_domain_bridge
    assert "决定内容" not in private_domain_bridge
    assert "内容发布前" in content_tool_bridge
    assert "临发前漏项" in content_tool_bridge


def test_candidate_judge_rewrite_session_repairs_checklist_and_finalizes_title(monkeypatch):
    monkeypatch.setattr(settings, "TEXT_GENERATION_CANDIDATE_JUDGE_ENABLED", True)

    bad_body = "\n".join(
        [
            "很多老板做企微私域，一开始就急着拉群，客户越多越乱。",
            "1️⃣员工信息设置：先把门面搭好",
            "✅ 统一员工名片",
            "✅ 设置欢迎语",
            "✅ 配好自动回复",
            "2️⃣引流：先分来源",
            "✅ 渠道活码",
            "✅ 裂变活动",
            "✅ 区域活码",
            "3️⃣社群搭建：先立规则",
            "✅ 群欢迎语",
            "✅ 群规则",
            "✅ 常见问题自动回复",
            "✅ 防骚扰机制",
        ]
    )
    repaired_body = (
        "很多老板做企业微信私域，一开始以为重点是多拉群、多加人，真正做下来才发现，"
        "私域能不能沉淀，先看客户进来后有没有被接住。✨\n\n"
        "从0到1搭框架时，先别急着堆功能，可以先把6个基础动作跑顺：员工形象、引流入口、"
        "社群规则、用户分层、风险交接和后续运营。\n\n"
        "员工名片、欢迎语和自动回复，看起来是小配置，其实决定客户加上企微后的第一印象："
        "你专不专业、回得快不快、有没有人接住。\n\n"
        "引流这一步也别只看加了多少人，更要分清客户从哪里来。渠道、裂变、门店入口分开，"
        "后面复盘才知道哪条链路值得继续投。\n\n"
        "社群不是人越多越好，而是欢迎、规则、答疑和内容节奏先立住。这样员工不用反复救火，"
        "用户也知道这个群到底有什么价值。\n\n"
        "最后再看分层、交接和风险。说到底，企业微信私域不是多一个工具，而是把客户资产、"
        "团队动作和经营结果串起来。微伴助手这类工具适合放在后面做标准化承接，先把流程跑顺更重要。\n\n"
        "如果你现在已经加了不少客户，但成交和复购一直不稳定，可以先不用急着换打法。"
        "把入口、标签、社群、交接、跟进这几步重新过一遍，看看客户到底是从哪里开始没人接住。"
        "流程一旦顺起来，工具才会真正帮团队省力，而不是变成又一套没人坚持用的后台。\n\n"
        "这也是我更推荐先搭底层秩序、再谈增长动作的原因。客户承接稳了，后面的活动、社群和复购动作才有地方落。"
    )

    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "写作蓝图与候选路线任务" in prompt:
                return {
                    "expression_contract": {
                        "content_type": "收藏教程型",
                        "must_keep": ["6步结构", "老板视角", "产品轻承接"],
                        "avoid": ["裸功能清单", "产品教程"],
                        "structure_units": ["开场判断", "6步框架", "产品轻承接"],
                        "product_role": "结尾轻承接",
                        "title_requirements": ["企业微信", "私域", "0-1"],
                        "quality_bar": ["把功能翻译成业务价值"],
                    },
                    "content_atoms": [
                        {"role": "judgment", "text": "私域不是先拉群，而是先搭框架", "priority": 1, "why_keep": "主线"},
                        {"role": "action", "text": "员工形象、入口、社群、分层、风险、运营", "priority": 1, "why_keep": "6步结构"},
                    ],
                    "compression_rules": ["合并功能清单"],
                    "route_candidates": [
                        {
                            "variant": "收藏教程型",
                            "title_candidates": ["客户一来就乱？老板先搭这6步"],
                            "opening_hook": "客户越多越乱，先讲老板最容易忽略的承接顺序。",
                            "content_outline": ["开场判断", "6步框架", "产品轻承接"],
                            "product_bridge": "结尾轻承接微伴助手",
                            "closing": "让读者自查私域基础动作",
                            "rationale": "结构完整但容易清单化",
                            "risk": "功能清单太多",
                        },
                        {
                            "variant": "经验分享型",
                            "title_candidates": ["企业微信私域0-1框架"],
                            "opening_hook": "从老板复盘角度讲私域基础动作。",
                            "content_outline": ["先讲误区", "再讲基础动作", "最后轻承接产品"],
                            "product_bridge": "最后作为标准化承接工具",
                            "closing": "提醒先跑顺流程",
                            "rationale": "表达更像经验",
                            "risk": "可能太轻",
                        },
                    ]
                }
            if "候选路线裁判任务" in prompt:
                return {
                    "selected_index": 0,
                    "title_candidates": ["企业微信私域0-1框架", "企微私域从0到1搭建"],
                    "needs_attention": True,
                    "attention_points": ["功能清单太多，合并成价值句"],
                    "scores": [{"index": 0, "total": 70}, {"index": 1, "total": 88}],
                    "reasoning_summary": "选择后返修，保留6步结构但降低清单感。",
                }
            if "基于已选路线写出" in prompt:
                return {
                    "final_title": "客户一来就乱？老板先搭这6步",
                    "title_candidates": ["客户一来就乱？老板先搭这6步"],
                    "body": bad_body,
                    "tags": ["企业微信", "私域运营"],
                    "rationale": "按路线生成初稿",
                }
            if "候选路线返修编辑器" in prompt:
                return {
                    "title_candidates": ["企业微信私域0-1框架", "企微私域从0到1搭建"],
                    "body": repaired_body,
                    "tags": ["企业微信", "私域运营", "社群运营"],
                    "repair_notes": ["合并裸功能清单", "强化价值解释"],
                }
            raise AssertionError("unexpected prompt")

    result = FakeGenerator().generate_rewrite_session(
        benchmark_note={"title": "企业微信社群私域 | 从0到1搭建保姆级指南", "desc": "对标正文"},
        product_info={
            "product_name": "微伴助手",
            "product_features": "企业微信私域, 客户标签, 会话留痕",
            "target_audience": "老板",
        },
        note_strategy={
            "id": "s1",
            "label": "从0到1搭建型",
            "summary": "主线讲老板最容易忽略的私域基础搭建顺序，微伴助手仅作为最后的落地辅助。",
            "suggestedTitle": "企业微信私域从0到1，不是先拉群，而是先把这6步搭好",
            "productUsageMode": "product_assist",
            "recommendedCardPlan": ["6步框架", "产品轻承接"],
        },
    )

    assert result["final_body_source"] == "candidate_judge"
    assert result["selected_title"] in {"企业微信私域0-1框架", "企微私域从0到1搭建"}
    assert len(result["selected_title"]) <= XHS_TITLE_MAX_CHARS
    assert len(result["final_body"]) <= XHS_BODY_MAX_CHARS
    assert result["tags"]
    assert "私域运营" in result["tags"]
    assert "合并裸功能清单" in " ".join(result["revision_notes"])
    assert "checklist_overload" not in result["candidate_judge_quality_flags"]


def test_candidate_judge_prompts_use_strategy_expression_contract_for_uplog(monkeypatch):
    monkeypatch.setattr(settings, "TEXT_GENERATION_CANDIDATE_JUDGE_ENABLED", True)

    content_tool_body = (
        "小编把公众号文章改成小红书，最怕的不是不会写，而是复制、删改、排版、检查全靠手动。✍️\n\n"
        "1️⃣ 先把原文一键导入\n"
        "不用在多个窗口来回复制，先把文章结构完整带进来。原文里哪些是观点、哪些是案例、哪些适合变成卡片，先保留下来，后面改写才不会越改越散。\n\n"
        "2️⃣ 再套模板和自动分页 📝\n"
        "标题、正文、分段和卡片节奏先排顺，减少反复调格式的时间。很多小编不是卡在一句话怎么写，而是卡在每次都要重新拆结构、调版式、对齐封面和内容页。\n\n"
        "3️⃣ 发布前做违规检测 ⚠️\n"
        "敏感词和风险提示提前看一遍，发出去前就能少返工。尤其是品牌词、绝对化表达、引导语这些地方，看起来很小，但临发前漏一次就很麻烦。\n\n"
        "我自己会把这一步当成发布前的最后一道保险：标题是不是太满，正文有没有重复，卡片页的重点有没有对齐，评论引导会不会显得生硬。"
        "这些检查不一定复杂，但每次都靠人记，很容易忙起来就漏掉。\n\n"
        "尤其是多账号、多同事协作时，标准一旦没有沉淀下来，每个人都在用自己的习惯处理细节，最后读者看到的就是风格不统一、重点不稳定。"
        "工具真正有价值的地方，是把这些重复但关键的检查动作固定住。\n\n"
        "所以我更建议把这套流程固定下来：先导入，再改写，再排版，最后检查。Uplog 适合放在这个工作流里做辅助，不是替你决定选题，而是把重复操作压短，让小编把精力放回判断和表达上。✅"
    )

    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "写作蓝图与候选路线任务" in prompt:
                return {
                    "expression_contract": {
                        "content_type": "真实工作流教程",
                        "product_category": "内容工具/写作效率",
                        "reader_identity": "像内容运营写给小编和自媒体人看",
                        "must_keep": ["复制粘贴痛点", "模板分页", "违规检测", "产品轻承接"],
                        "avoid": ["写成私域经营复盘", "写成产品说明书"],
                        "structure_units": ["工作流痛点", "导入", "模板分页", "发布前检查", "轻承接"],
                        "writing_structure": "小编真实工作流 + 前后对比 + 步骤清单",
                        "product_role": "辅助工具",
                        "title_style": "标题要落到小编改笔记、省步骤、发布前检查",
                        "emoji_style": "写作/改写用 ✍️，模板/排版用 📝，检测风险用 ⚠️，省时间用 ✅",
                        "tag_style": "内容运营、小红书运营、自媒体工具、AI写作、效率工具",
                        "title_requirements": ["小编", "小红书", "省步骤"],
                        "quality_bar": ["像真实工作流，不像私域SOP"],
                    },
                    "content_atoms": [
                        {"role": "pain_point", "text": "复制、删改、排版、检查全靠手动", "priority": 1, "why_keep": "真实痛点"},
                        {"role": "action", "text": "一键导入、模板分页、违规检测", "priority": 1, "why_keep": "核心工作流"},
                    ],
                    "compression_rules": ["产品只轻承接"],
                    "route_candidates": [
                        {
                            "variant": "真实工作流教程",
                            "title_candidates": ["小编改笔记别再复制粘贴"],
                            "opening_hook": "小编改稿卡在复制、删改、排版、检查。",
                            "content_outline": ["工作流痛点", "导入", "模板分页", "发布前检查", "轻承接"],
                            "product_bridge": "结尾作为辅助工具轻承接",
                            "closing": "让读者自查发布前流程",
                            "rationale": "贴合小编工作流",
                            "risk": "不要写成私域SOP",
                        }
                    ]
                }
            if "候选路线裁判任务" in prompt:
                return {
                    "selected_index": 0,
                    "title_candidates": ["小编改小红书省这几步", "公众号转小红书省这几步"],
                    "needs_attention": False,
                    "attention_points": [],
                    "scores": [{"index": 0, "total": 92}],
                    "reasoning_summary": "内容工具语境清楚，产品轻承接。",
                }
            if "基于已选路线写出" in prompt:
                return {
                    "final_title": "小编改小红书省这几步",
                    "title_candidates": ["小编改小红书省这几步", "公众号转小红书省这几步"],
                    "body": content_tool_body,
                    "tags": ["内容运营", "小红书运营", "自媒体工具"],
                    "rationale": "贴合小编工作流",
                }
            if "候选路线返修编辑器" in prompt:
                raise AssertionError("unexpected repair prompt")
            raise AssertionError("unexpected prompt")

    generator = FakeGenerator()
    result = generator.generate_rewrite_session(
        benchmark_note={"title": "小红书笔记发布前检查清单", "desc": "写完别急着发，先检查标题、排版和违规词。"},
        product_info={
            "product_name": "Uplog",
            "product_features": "一键导入，模板自动分页，一键添加水印，违规检测，AI写作助手",
            "target_audience": "小编，自媒体",
        },
        note_strategy={
            "id": "uplog_workflow",
            "label": "小编工作流提效",
            "summary": "围绕小编从文章导入到发布前检查的重复工作流，Uplog只做辅助承接。",
            "suggestedTitle": "小编改小红书别再复制粘贴",
            "contentAngle": "真实工作流提效",
            "corePainPoints": ["复制粘贴麻烦", "排版慢", "敏感词风险"],
            "coreBenefits": ["一键导入", "模板分页", "违规检测"],
            "recommendedCardPlan": ["痛点页", "导入页", "模板分页页", "发布前检查页"],
            "productUsageMode": "product_assist",
        },
    )

    joined_prompts = "\n".join(generator.prompts)
    assert len(result["selected_title"]) <= XHS_TITLE_MAX_CHARS
    assert "小编" in result["selected_title"]
    assert "小红书" in result["selected_title"]
    assert result["expression_contract"]["product_category"] == "内容工具/写作效率"
    assert "内容运营" in result["tags"]
    assert "策略表达执行规则" in joined_prompts
    assert "小编真实工作流" in joined_prompts
    assert "✍️" in joined_prompts
    assert "不要把某一类产品的写法硬套给另一类产品" in joined_prompts


def test_candidate_judge_final_guard_repairs_short_body(monkeypatch):
    monkeypatch.setattr(settings, "TEXT_GENERATION_CANDIDATE_JUDGE_ENABLED", True)

    short_body = "客户进来后没人接住，最后就会流失。"
    guarded_body = (
        _long_xhs_body("客户不是没人跟，而是每次交接都要重新讲一遍。")
        + "\n\n这类问题最怕只靠员工自己记。销售、客服、售后每个人都很忙，客户说过什么、卡在哪一步、下一次应该怎么跟，如果没有被记录下来，换一个人接手就会重新问一遍。微伴助手这类工具更适合放在这里做辅助，把客户记录、会话留痕和后续提醒串起来，让团队先把承接链路补完整。"
    )

    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "写作蓝图与候选路线任务" in prompt:
                return {
                    "expression_contract": {
                        "content_type": "问题诊断型",
                        "product_category": "私域/SCRM/B2B运营",
                        "reader_identity": "像私域运营负责人写给老板看",
                        "structure_units": ["客户重讲开场", "交接断层诊断", "工具轻承接", "自查收束"],
                        "product_role": "辅助承接客户信息",
                        "title_style": "落到客户重讲和交接断层",
                        "quality_bar": ["场景具体", "结尾完整"],
                    },
                    "content_atoms": [
                        {"role": "pain_point", "text": "客户每次换人都要重讲", "priority": 1, "why_keep": "主痛点"},
                        {"role": "product_bridge", "text": "微伴助手辅助记录和交接", "priority": 1, "why_keep": "产品承接"},
                    ],
                    "compression_rules": ["少写泛泛私域概念"],
                    "route_candidates": [
                        {
                            "variant": "问题诊断型",
                            "title_candidates": ["客户总重讲，问题在哪"],
                            "opening_hook": "客户每次换人都要重讲。",
                            "content_outline": ["开场痛点", "交接断层", "工具轻承接", "自查结尾"],
                            "product_bridge": "后半段轻带微伴助手",
                            "closing": "引导自查承接链路",
                            "rationale": "场景清楚",
                            "risk": "容易写短",
                        }
                    ],
                }
            if "候选路线裁判任务" in prompt:
                return {
                    "selected_index": 0,
                    "title_candidates": ["客户总重讲，问题在哪"],
                    "scores": [{"index": 0, "total": 90}],
                    "reasoning_summary": "选择客户重讲路线。",
                }
            if "基于已选路线写出" in prompt:
                return {
                    "final_title": "客户总重讲，问题在哪",
                    "title_candidates": ["客户总重讲，问题在哪"],
                    "body": short_body,
                    "tags": ["私域运营"],
                    "rationale": "短稿",
                }
            if "候选路线返修编辑器" in prompt:
                return {
                    "title_candidates": ["客户总重讲，问题在哪"],
                    "body": short_body,
                    "tags": ["私域运营"],
                    "repair_notes": ["尝试补全文"],
                }
            if "最后守门编辑" in prompt:
                return {
                    "title_candidates": ["客户总重讲，问题在哪"],
                    "body": guarded_body,
                    "tags": ["私域运营", "客户管理"],
                    "repair_notes": ["补足完整场景和收束"],
                }
            raise AssertionError("unexpected prompt")

    generator = FakeGenerator()
    result = generator.generate_rewrite_session(
        benchmark_note={"title": "客户跟进总断层", "desc": "对标正文"},
        product_info={
            "product_name": "微伴助手",
            "product_features": "客户记录, 会话留痕, SOP 跟进",
            "target_audience": "私域团队",
        },
        note_strategy={
            "id": "handoff_gap",
            "label": "交接断层诊断",
            "suggestedTitle": "客户总重讲，问题在哪",
            "productUsageMode": "product_assist",
            "coreBenefits": ["客户记录", "会话留痕"],
        },
    )

    assert len(result["final_body"]) >= 520
    assert len(result["final_body"]) <= XHS_BODY_MAX_CHARS
    assert len(result["selected_title"]) <= XHS_TITLE_MAX_CHARS
    assert "body_incomplete_or_too_short" not in result["candidate_judge_quality_flags"]
    assert "补足完整场景和收束" in " ".join(result["revision_notes"])
    assert any("最后守门编辑" in prompt for prompt in generator.prompts)


def test_candidate_judge_final_guard_repairs_structural_half_draft(monkeypatch):
    monkeypatch.setattr(settings, "TEXT_GENERATION_CANDIDATE_JUDGE_ENABLED", True)

    half_body = (
        "这周要把一篇去年的常青文重新发一版，我原本以为改几个信息就够，结果最费时间的还是排版整理。"
        "旧文章不是不能再发，最崩溃的是每次重发都像把排版重做一遍。明明真正要改的，往往只是日期、案例、配图和几处时效信息，"
        "但旧稿一复制进微信公众号后台编辑页，格式就开始散。⚠️\n\n"
        "最常见的乱，不是那种一眼看不出来的问题，而是编辑最耗神的细碎返工：一级标题和二级标题不像一套层级，正文间距忽大忽小，"
        "引用块颜色还是上一次活动的，分割线风格混着用，图片有的偏窄有的撑满屏，发出去像不同人写的号。"
        "旧文复用不是偷懒，真正影响质感的也不是内容老，而是整理得太粗糙。 ✍️\n\n"
        "我现在的做法是，先把旧稿导入到公众号后台，再统一处理基础格式，而不是一段一段手动修。这里我会直接在后台编辑页里用壹伴助手，"
        "不是为了把它当什么全流程平台，而是单纯拿它做旧稿翻新的排版加速器。先用一键排版或AI一键排版，把正文的字体、段距、页边距先拉齐，"
        "这一步很关键，因为如果底层格式没统一，后面改标题、引用、分割线只会越修越乱。✍️\n\n"
        "1️⃣ 先拉齐正文基础格式 📝\n"
        "把导入后散掉的正文先统一，不再逐段点格式。这样做的好处是，文章先恢复\"能看\"的状态，后续才好判断哪些地方需要保留、哪些地方需要改。 📝\n\n"
        "2️⃣ 再修层级和固定样式\n"
        "我会把常用的标题样式、引用样式、分割线样式直接从样式中心里挑固定几套，用顺手的就收进样式收藏。"
    )
    guarded_body = _long_xhs_body("旧稿翻新最费时的不是改内容，而是把散掉的格式重新拉回统一。")

    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "写作蓝图与候选路线任务" in prompt:
                return {
                    "expression_contract": {
                        "content_type": "旧稿翻新实录型",
                        "product_category": "内容工具/写作效率",
                        "reader_identity": "公众号编辑",
                        "structure_units": ["旧稿返工痛点", "导入后台", "统一基础格式", "修层级样式", "处理配图", "完整收束"],
                        "product_role": "主解决方案",
                        "quality_bar": ["完整写完旧稿翻新流程", "不能停在步骤中间"],
                    },
                    "content_atoms": [
                        {"role": "pain_point", "text": "旧稿重发格式散掉", "priority": 1, "why_keep": "主痛点"},
                    ],
                    "compression_rules": [],
                    "route_candidates": [
                        {
                            "variant": "旧稿翻新实录型",
                            "title_candidates": ["旧稿翻新不是改内容最费时"],
                            "opening_hook": "旧稿重发最烦的是格式散。",
                            "content_outline": ["旧稿返工痛点", "导入后台", "统一基础格式", "修层级样式", "处理配图", "完整收束"],
                            "product_bridge": "壹伴助手作为后台排版加速器",
                            "closing": "旧内容复用不等于低质重发",
                            "rationale": "贴合策略",
                            "risk": "容易写成只到步骤中间的残稿",
                        }
                    ],
                }
            if "候选路线裁判任务" in prompt:
                return {
                    "selected_index": 0,
                    "title_candidates": ["旧稿翻新不是改内容最费时"],
                    "scores": [{"index": 0, "total": 90}],
                    "reasoning_summary": "选择旧稿翻新实录型。",
                }
            if "基于已选路线写出" in prompt:
                return {
                    "final_title": "旧稿翻新不是改内容最费时",
                    "title_candidates": ["旧稿翻新不是改内容最费时"],
                    "body": half_body,
                    "tags": ["公众号运营"],
                    "rationale": "半截坏样本回放",
                }
            if "候选路线返修编辑器" in prompt:
                return {
                    "title_candidates": ["旧稿翻新不是改内容最费时"],
                    "body": half_body,
                    "tags": ["公众号运营"],
                    "repair_notes": ["尝试补全文"],
                }
            if "最后守门编辑" in prompt:
                return {
                    "title_candidates": ["旧稿翻新不是改内容最费时"],
                    "body": guarded_body,
                    "tags": ["公众号运营", "排版工具"],
                    "repair_notes": ["补足剩余步骤和完整收束"],
                }
            raise AssertionError("unexpected prompt")

    generator = FakeGenerator()
    result = generator.generate_rewrite_session(
        benchmark_note={"title": "旧文重发最崩溃的，不是改内容，是格式又要重做一遍", "desc": "策略合成对标"},
        product_info={
            "product_name": "壹伴助手",
            "product_features": "一键排版、样式中心、样式收藏、图片处理",
            "target_audience": "公众号编辑",
        },
        note_strategy={
            "id": "strategy_a",
            "label": "旧文翻新不重做型",
            "suggestedTitle": "旧文重发最崩溃的，不是改内容，是格式又要重做一遍",
            "productUsageMode": "product_main",
        },
    )

    assert len(half_body) >= 520
    assert len(result["final_body"]) <= XHS_BODY_MAX_CHARS
    assert "补足剩余步骤和完整收束" in " ".join(result["revision_notes"])
    assert any("候选路线返修编辑器" in prompt for prompt in generator.prompts)
    assert any("最后守门编辑" in prompt for prompt in generator.prompts)


def test_structural_incomplete_guard_catches_long_body_ending_at_step_heading():
    body = (
        "前两天我重发一篇公众号旧文，本来真觉得这活很轻：更新下数据，顺手改几句，应该十几分钟就能结束。结果一复制进公众号后台，半小时直接没了。"
        "不是内容难改，是格式先散了：段落间距乱了、加粗丢了、字号不齐，连列表和空行都开始各走各的。那一刻我又被提醒一次，旧稿翻新最耗时的，往往不是改内容，而是后面这一整串排版返工。✍️\n\n"
        "做公众号的应该都很熟这个场面：文案其实没怎么动，但视觉秩序像重做一遍。尤其标题、引用、分割线这些层级，一进后台就容易不统一。"
        "你一边补格式一边改字，表面上在推进，实际上是在来回返工。更麻烦的是，旧稿如果版面收得不干净，读起来就很像库存稿：结构松、层级飘、配图风格也不齐。\n\n"
        "我后来把返工顺序改了，时间才真的省下来。📝\n\n"
        "1️⃣ 先导入后台，先拉齐正文骨架。\n"
        "以前我最容易犯的错，就是一进后台就边改内容边补样式，结果同一段要修三次。现在我会先把正文整体过一遍，把字号、段距、对齐这些基础格式先统一，让文章至少先站稳。"
        "这一步看着不显眼，其实最重要，因为骨架不齐，后面修什么都像打补丁。我现在会用壹伴助手先把基础排版拉到一致，它不是替我决定怎么写，只是把这些重复又机械的手动动作先收掉。✅\n\n"
        "2️⃣ 再修层级，别从头一个个找样式。👇\n"
        "基础格式稳了以后，再去看标题、引用、分割线这些层级感强的地方。旧稿翻新特别耗时的一点，就是样式明明常用，但每次还是要重新翻、重新试。"
        "后来我把常用标题样式、引用样式和分割线固定下来，翻旧稿时直接套自己那几套常用的。这样做不是为了花哨，而是为了让一篇文的层级更清楚。💡\n\n"
        "3️⃣ 配图不要最后随手补，集中处理更省事。\n"
        "我以前总把图片放到最后，结果越接近发布越容易崩。旧图来源杂的时候尤其明显：有的横图有的竖图，有的偏灰有的偏亮，尺寸还不一样，整篇文章一下就很像临时拼出来的库存稿。"
        "所以我现在会在层级修完后，专门留一轮处理配图，先把尺寸统一，再把风格尽量拉近。壹伴在这一步对我来说最有用的，是能少掉逐张来回调整的重复动作。⚠️\n\n"
        "4️⃣ 临发前再检查一次，少走回头路。"
    )

    assert len(body) >= 800
    assert _is_structurally_incomplete_publish_body(
        body,
        selected_route={"content_outline": ["旧稿返工痛点", "导入后台", "统一基础格式", "修层级样式", "处理配图", "完整收束"]},
    )


def test_candidate_judge_final_guard_repairs_missing_product_assist_bridge(monkeypatch):
    monkeypatch.setattr(settings, "TEXT_GENERATION_CANDIDATE_JUDGE_ENABLED", True)

    no_bridge_body = _long_xhs_body("发公众号前，很多细节不是不会做，而是忙起来就会漏。")
    guarded_body = (
        no_bridge_body
        + "\n\n壹伴助手更适合放在这一步做辅助承接，把公众号排版、敏感词检查和素材管理这些发布前动作固定下来。它不是替编辑决定内容，而是帮团队少靠临场记忆，把容易漏的细节变成每次都能复用的检查流程。"
    )

    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "写作蓝图与候选路线任务" in prompt:
                return {
                    "expression_contract": {
                        "content_type": "真实工作流型",
                        "product_category": "内容工具/写作效率",
                        "reader_identity": "公众号运营者",
                        "structure_units": ["发布前检查", "产品轻承接"],
                        "product_role": "发布前辅助检查",
                        "quality_bar": ["产品必须自然承接"],
                    },
                    "content_atoms": [
                        {"role": "pain_point", "text": "发布前细节容易漏", "priority": 1, "why_keep": "主痛点"},
                        {"role": "product_bridge", "text": "壹伴助手辅助排版和敏感词检查", "priority": 1, "why_keep": "产品承接"},
                    ],
                    "route_candidates": [
                        {
                            "variant": "真实工作流型",
                            "title_candidates": ["发文前这几项别漏"],
                            "opening_hook": "发文前细节容易漏。",
                            "content_outline": ["检查排版", "检查措辞", "检查风险", "产品轻承接"],
                            "product_bridge": "最后轻带壹伴助手",
                            "closing": "自查发布流程",
                            "rationale": "场景清楚",
                            "risk": "产品承接可能被压掉",
                        }
                    ],
                }
            if "候选路线裁判任务" in prompt:
                return {
                    "selected_index": 0,
                    "title_candidates": ["发文前这几项别漏"],
                    "scores": [{"index": 0, "total": 90}],
                    "reasoning_summary": "选择发布检查路线。",
                }
            if "基于已选路线写出" in prompt:
                return {
                    "final_title": "发文前这几项别漏",
                    "title_candidates": ["发文前这几项别漏"],
                    "body": no_bridge_body,
                    "tags": ["公众号运营"],
                    "rationale": "初稿漏了产品承接",
                }
            if "候选路线返修编辑器" in prompt:
                return {
                    "title_candidates": ["发文前这几项别漏"],
                    "body": no_bridge_body,
                    "tags": ["公众号运营"],
                    "repair_notes": ["没有修好产品承接"],
                }
            if "最后守门编辑" in prompt:
                assert "product_assist_missing_bridge" in prompt
                return {
                    "title_candidates": ["发文前这几项别漏"],
                    "body": guarded_body,
                    "tags": ["公众号运营", "内容运营"],
                    "repair_notes": ["补回产品轻承接"],
                }
            raise AssertionError("unexpected prompt")

    generator = FakeGenerator()
    result = generator.generate_rewrite_session(
        benchmark_note={"title": "发公众号前别漏检查", "desc": "对标正文"},
        product_info={
            "product_name": "壹伴助手",
            "product_features": "公众号排版, 敏感词检查, 素材管理, AI辅助写作",
            "target_audience": "公众号运营者",
        },
        note_strategy={
            "id": "publish_check",
            "label": "发布前检查",
            "suggestedTitle": "发文前这几项别漏",
            "productUsageMode": "product_assist",
            "coreBenefits": ["公众号排版", "敏感词检查"],
        },
    )

    assert "product_assist_missing_bridge" not in result["candidate_judge_quality_flags"]
    assert "壹伴助手" in result["final_body"]
    assert any("最后守门编辑" in prompt for prompt in generator.prompts)
    assert "补回产品轻承接" in " ".join(result["revision_notes"])


def test_candidate_judge_keeps_complete_body_when_final_guard_returns_short(monkeypatch):
    monkeypatch.setattr(settings, "TEXT_GENERATION_CANDIDATE_JUDGE_ENABLED", True)

    complete_body = (
        _long_xhs_body("发公众号前，很多细节不是不会做，而是忙起来就会漏。")
        + "\n\n我会把检查顺序固定成几个动作：先看版式和图片，再看标题措辞，最后看风险表达和素材版本。这样做不是为了多一道流程，而是让每个编辑都能按同一套标准收尾，账号看起来才不会忽高忽低。"
    )
    short_guard_body = "发公众号前先看排版。"

    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "写作蓝图与候选路线任务" in prompt:
                return {
                    "expression_contract": {"content_type": "发布检查型", "product_role": "轻承接"},
                    "content_atoms": [{"role": "product_bridge", "text": "壹伴助手辅助检查", "priority": 1}],
                    "route_candidates": [
                        {
                            "variant": "发布检查型",
                            "title_candidates": ["发文前这几项别漏"],
                            "opening_hook": "发文前容易漏细节。",
                            "content_outline": ["排版", "措辞", "风险", "产品轻承接"],
                            "product_bridge": "最后轻带壹伴助手",
                            "closing": "自查发布流程",
                            "rationale": "清楚",
                            "risk": "可能返短",
                        }
                    ],
                }
            if "候选路线裁判任务" in prompt:
                return {
                    "selected_index": 0,
                    "title_candidates": ["发文前这几项别漏"],
                    "scores": [{"index": 0, "total": 90}],
                    "reasoning_summary": "选择发布检查路线。",
                }
            if "基于已选路线写出" in prompt:
                return {
                    "final_title": "发文前这几项别漏",
                    "title_candidates": ["发文前这几项别漏"],
                    "body": complete_body,
                    "tags": ["公众号运营"],
                    "rationale": "完整稿",
                }
            if "候选路线返修编辑器" in prompt:
                return {
                    "title_candidates": ["发文前这几项别漏"],
                    "body": complete_body,
                    "tags": ["公众号运营"],
                    "repair_notes": ["保留完整稿"],
                }
            if "最后守门编辑" in prompt:
                return {
                    "title_candidates": ["发文前这几项别漏"],
                    "body": short_guard_body,
                    "tags": ["公众号运营"],
                    "repair_notes": ["错误返回短稿"],
                }
            raise AssertionError("unexpected prompt")

    result = FakeGenerator().generate_rewrite_session(
        benchmark_note={"title": "发公众号前别漏检查", "desc": "对标正文"},
        product_info={
            "product_name": "壹伴助手",
            "product_features": "公众号排版, 敏感词检查, 素材管理, AI辅助写作",
            "target_audience": "公众号运营者",
        },
        note_strategy={
            "id": "publish_check",
            "label": "发布前检查",
            "suggestedTitle": "发文前这几项别漏",
            "productUsageMode": "product_assist",
        },
    )

    assert len(result["final_body"]) >= 520
    assert short_guard_body not in result["final_body"]
    assert "壹伴助手" in result["final_body"]
    assert "最终守门返回短稿" in " ".join(result["revision_notes"])


def test_candidate_judge_falls_back_when_final_body_remains_short(monkeypatch):
    monkeypatch.setattr(settings, "TEXT_GENERATION_CANDIDATE_JUDGE_ENABLED", True)

    short_body = "小红书爆款内容有5个密码：选题、标题、封面、结构和复盘。每一步都做好，内容表现会更稳定。"
    fallback_body = (
        _long_xhs_body("小红书爆款内容不是靠灵感撞出来的，而是靠一套能反复检查的发布流程。")
        + "\n\n最后我会把选题、标题、封面、正文结构和复盘放在同一张表里看。这样下一篇不是重新猜，而是沿着已经验证过的信号继续优化。"
    )

    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "写作蓝图与候选路线任务" in prompt:
                return {
                    "expression_contract": {"content_type": "教程型干货清单", "product_role": "不强推产品"},
                    "content_atoms": [{"role": "action", "text": "5个爆款密码", "priority": 1}],
                    "route_candidates": [
                        {
                            "variant": "教程型干货清单",
                            "title_candidates": ["爆款内容5个密码"],
                            "opening_hook": "内容爆不爆，先看基础动作。",
                            "content_outline": ["选题", "标题", "封面", "结构", "复盘"],
                            "product_bridge": "",
                            "closing": "提醒持续复盘",
                            "rationale": "贴合策略",
                            "risk": "容易写短",
                        }
                    ],
                }
            if "候选路线裁判任务" in prompt:
                return {
                    "selected_index": 0,
                    "title_candidates": ["爆款内容5个密码"],
                    "scores": [{"index": 0, "total": 86}],
                    "reasoning_summary": "选择5点清单。",
                }
            if "基于已选路线写出" in prompt:
                return {
                    "final_title": "爆款内容5个密码",
                    "title_candidates": ["爆款内容5个密码"],
                    "body": short_body,
                    "tags": ["小红书运营"],
                    "rationale": "短稿",
                }
            if "候选路线返修编辑器" in prompt or "最后守门编辑" in prompt:
                return {
                    "title_candidates": ["爆款内容5个密码"],
                    "body": short_body,
                    "tags": ["小红书运营"],
                    "repair_notes": ["仍然过短"],
                }
            if "写出一篇可以直接发布的小红书正文" in prompt:
                return {
                    "final_title": "爆款内容5个密码",
                    "title_candidates": ["爆款内容5个密码"],
                    "body": fallback_body,
                    "tags": ["小红书运营", "内容运营"],
                    "rationale": "旧链路完整稿",
                }
            raise AssertionError("unexpected prompt")

    result = FakeGenerator().generate_rewrite_session(
        benchmark_note={"title": "小红书爆款内容5大密码", "desc": "对标正文"},
        product_info={
            "product_name": "Uplog",
            "product_features": "发布整理, 内容复盘",
            "target_audience": "内容创作者",
        },
        note_strategy={
            "id": "hot_5_keys",
            "label": "爆款内容5大密码",
            "suggestedTitle": "小红书爆款内容5大密码",
            "productUsageMode": "no_product",
        },
    )

    assert result["final_body"] == fallback_body
    assert result["final_body_source"] != "candidate_judge"
    assert "多候选裁判链路失败，已回退旧链路" in " ".join(result["guardrail_repairs_applied"])
    assert len(result["final_body"]) >= XHS_STRATEGY_BODY_MIN_COMPLETE_CHARS


def test_strategy_direct_session_uses_single_model_call_for_complete_body():
    complete_body = (
        "旧稿重发最容易被低估的，不是改几句话，而是格式一散，整篇文章的质感都会掉下来。✍️\n\n"
        "我以前也觉得，翻一篇去年的公众号旧文很快：标题换一下，案例补两句，配图重新找一张就行。真正进后台才发现，最耗时间的是那些看起来不起眼的细节。段距不统一、引用样式变了、分割线像从几篇文章里拼出来的，读者不一定说得出哪里怪，但会觉得这篇像临时翻出来的库存稿。\n\n"
        "现在我会先把旧稿当成一篇新内容重新过流程，而不是边改内容边修格式。第一步先导入后台，把正文的字号、行距和留白拉齐。这个动作不是为了好看，而是先让文章恢复稳定骨架，后面改标题和配图才不会反复返工。📝\n\n"
        "第二步再处理标题、引用和固定样式。我会把常用的标题样式、重点句样式、分割线样式固定下来，翻旧稿时直接套同一套视觉规则。这样读者看到的是一篇重新整理过的内容，不是旧内容换个日期又发了一遍。\n\n"
        "第三步集中看图片和风险词。旧图尺寸不一、颜色不一，很容易让文章显得散；发布前再顺手查一遍敏感词和绝对化表达，也能少掉临发前的返工。⚠️\n\n"
        "壹伴助手适合放在这个流程里做加速：一键排版、样式中心、图片处理这些动作，不替编辑决定内容，但能把重复整理的时间压短。对我来说，旧文翻新真正要省的不是思考时间，而是那些每次都要重新点一遍的手工活。✅\n\n"
        "还有一个细节我现在会提前做：先想清楚这篇旧稿为什么值得再发。是节点又到了，案例有了新变化，还是读者最近又在问同类问题？这个理由补进开头或结尾，整篇就不会只像换了个排版壳。\n\n"
        "最后我会用读者视角再扫一遍：标题有没有说清这次的新价值，正文有没有旧信息残留，配图会不会像几次活动拼在一起。旧稿翻新不是把历史内容搬回来，而是把还能用的内容重新整理到今天的语境里。\n\n"
        "所以旧稿不是不能再发，关键是别让读者看出它是被随手搬回来的。内容更新一点，格式重新收紧一点，再补一个这次重发的理由，旧文章才像一次认真复用，而不是一次低质重发。"
    )

    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            assert "候选路线裁判任务" not in prompt
            assert "写作蓝图与候选路线任务" not in prompt
            return {
                "final_title": "旧文重发一键排版避坑",
                "title_candidates": ["旧文重发一键排版避坑", "旧文重发先别急着改字"],
                "body": complete_body,
                "tags": ["公众号运营", "内容运营", "排版工具"],
                "rationale": "贴合旧稿翻新痛点",
            }

    generator = FakeGenerator()
    result = generator.generate_strategy_direct_session(
        benchmark_note={"title": "旧文重发最崩溃的，不是改内容，是格式又要重做一遍", "desc": "策略合成对标"},
        product_info={
            "product_name": "壹伴助手",
            "product_features": "一键排版、样式中心、样式收藏、图片处理、敏感词检测",
            "target_audience": "公众号编辑",
        },
        note_strategy={
            "id": "strategy_a",
            "label": "旧文翻新不重做型",
            "summary": "抓住旧稿重发时排版返工的痛点。",
            "suggestedTitle": "旧文重发最崩溃的，不是改内容，是格式又要重做一遍",
            "contentAngle": "旧稿翻新实录型",
            "corePainPoints": ["旧稿复制进后台后格式散掉"],
            "coreBenefits": ["用样式中心和一键排版统一观感"],
            "recommendedCardPlan": ["旧稿返工痛点", "统一基础格式", "修层级样式", "处理配图", "完整收束"],
            "productUsageMode": "product_main",
        },
    )

    assert len(generator.prompts) == 1
    assert result["final_body_source"] == "strategy_direct"
    assert result["candidate_judge_enabled"] is False
    assert len(result["selected_title"]) <= XHS_TITLE_MAX_CHARS
    assert len(result["final_body"]) <= 950
    assert "body_incomplete_or_too_short" not in result["candidate_judge_quality_flags"]


def test_strategy_direct_session_repairs_half_draft_once():
    half_body = (
        "旧稿翻新最费时的不是改内容，而是格式一散，整篇都要重新收。✍️\n\n"
        "我以前翻旧文，总以为只要把日期和案例换掉就行。后来才发现，真正拖慢进度的是后台里那些细碎格式：段距不一样，标题层级不统一，引用块颜色还是旧活动，图片尺寸也对不上。\n\n"
        "1️⃣ 先拉齐正文基础格式 📝\n"
        "把导入后散掉的正文统一起来，先让文章恢复能看的状态。\n\n"
        "2️⃣ 再修标题和引用样式\n"
        "固定几套常用样式，不要每次从头找。\n\n"
        "3️⃣ 配图不要最后随手补"
    )
    repaired_body = (
        "旧稿翻新最容易被低估的，不是改几句话，而是格式一散，整篇文章的质感都会掉下来。✍️\n\n"
        "我以前也觉得，重发一篇去年的公众号旧文很快：标题换一下，案例补两句，配图重新找一张就行。真正进后台才发现，最耗时间的是那些看起来不起眼的细节。段距不统一、引用样式变了、分割线像从几篇文章里拼出来的，读者不一定说得出哪里怪，但会觉得这篇像临时翻出来的库存稿。\n\n"
        "现在我会先把旧稿当成一篇新内容重新过流程，而不是边改内容边修格式。第一步先导入后台，把正文的字号、行距和留白拉齐。这个动作不是为了好看，而是先让文章恢复稳定骨架，后面改标题和配图才不会反复返工。📝\n\n"
        "第二步再处理标题、引用和固定样式。我会把常用标题、重点句和分割线样式固定下来，翻旧稿时直接套同一套视觉规则。这样读者看到的是一篇重新整理过的内容，不是旧内容换个日期又发了一遍。\n\n"
        "第三步集中看图片和发布风险。旧图尺寸不一、颜色不一，很容易让文章显得散；发布前再查一遍敏感词和绝对化表达，也能少掉临发前返工。⚠️\n\n"
        "壹伴助手适合放在这个流程里做加速：一键排版、样式中心、图片处理这些动作，不替编辑决定内容，但能把重复整理的时间压短。对我来说，旧文翻新真正要省的不是思考时间，而是那些每次都要重新点一遍的手工活。✅\n\n"
        "还有一个细节很容易漏：旧稿翻新前最好先看它这次为什么值得再发。是节日节点到了，还是旧案例有了新变化，或者读者最近又开始问同类问题？这个理由想清楚后，正文里补进去，整篇就不会只像换了个排版壳。\n\n"
        "最后再看一遍读者能不能感受到新价值。如果只看见旧图、旧案例和旧表达，哪怕内容没有错，也会让人觉得敷衍。旧稿翻新要做的是把还能用的经验重新整理到今天的语境里。\n\n"
        "所以旧稿不是不能再发，关键是别让读者看出它是被随手搬回来的。内容更新一点，格式重新收紧一点，再补一个这次重发的理由，旧文章才像一次认真复用，而不是一次低质重发。"
    )

    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "策略直写返修编辑" in prompt:
                assert "body_incomplete_or_too_short" in prompt
                return {
                    "title_candidates": ["旧文重发一键排版避坑"],
                    "body": repaired_body,
                    "tags": ["公众号运营", "排版工具"],
                    "repair_notes": ["补足未完成步骤和结尾"],
                }
            return {
                "final_title": "旧文重发一键排版避坑",
                "title_candidates": ["旧文重发一键排版避坑"],
                "body": half_body,
                "tags": ["公众号运营"],
                "rationale": "半截坏样本",
            }

    generator = FakeGenerator()
    result = generator.generate_strategy_direct_session(
        benchmark_note={"title": "旧文重发最崩溃的，不是改内容，是格式又要重做一遍", "desc": "策略合成对标"},
        product_info={
            "product_name": "壹伴助手",
            "product_features": "一键排版、样式中心、样式收藏、图片处理",
            "target_audience": "公众号编辑",
        },
        note_strategy={
            "id": "strategy_a",
            "label": "旧文翻新不重做型",
            "suggestedTitle": "旧文重发最崩溃的，不是改内容，是格式又要重做一遍",
            "recommendedCardPlan": ["旧稿返工痛点", "导入后台", "统一基础格式", "修层级样式", "处理配图", "完整收束"],
            "productUsageMode": "product_main",
        },
    )

    assert len(generator.prompts) == 2
    assert result["final_body_source"] == "strategy_direct_repair"
    assert len(result["final_body"]) <= 950
    assert "补足未完成步骤和结尾" in " ".join(result["revision_notes"])
    assert "body_incomplete_or_too_short" not in result["candidate_judge_quality_flags"]


def test_strategy_direct_session_tail_repairs_near_limit_bare_step_heading():
    complete_body = "\n\n".join([
        "旧稿翻新最怕的不是内容过时，而是复制进后台以后，格式先散了一半。✍️",
        "我以前重发公众号旧文，总觉得只是把标题和日期换一下。真正赶到发布前才发现，最耗时间的是排版细节：标题层级不统一，引用块颜色还是旧活动，图片尺寸也对不上，读者看不出你改了什么，只会觉得这篇像临时翻出来的库存稿。",
        "还有一个问题更隐蔽：旧文章里的例子、截图和结论，可能都还对，但它们放在今天的语境里少了一个解释。比如去年写的是活动复盘，今年读者关心的可能是同样活动还能不能再做；去年强调的是增长，今年老板更关心成本和交付。",
        "后来我会先判断这篇旧文为什么值得今天再发。是节点又到了，还是案例有了新变化，或者用户最近又开始问同类问题。这个理由不想清楚，后面排版再漂亮，也只是把旧内容换个壳。💡",
        "第一步先把正文基础格式拉齐。把旧稿导入后台后，先统一字号、行距、页边距和正文留白，让文章恢复稳定骨架。这个动作不是为了追求好看，而是先把后面会反复返工的地方压住。📝",
        "第二步再修标题、引用和固定样式。我会把常用标题、重点句和分割线样式固定下来，翻旧稿时直接套同一套视觉规则。这样读者看到的是重新整理过的内容，不是旧内容换个日期又发了一遍。✅",
        "第三步集中看图片和发布风险。旧图尺寸不一、颜色不一，很容易让文章显得散；发布前再查一遍敏感词和绝对化表达，也能少掉临发前返工。壹伴助手适合放在这里做加速，一键排版、样式中心、图片处理这些动作，不替编辑决定内容，但能把重复整理的时间压短。⚠️",
        "我还会把最后检查拆成两轮：第一轮只看内容有没有新信息，第二轮只看视觉和发布风险。这样不会一边改标题一边调样式，改到最后自己也忘了原本想解决什么问题。",
        "如果团队里有多人接手同一个公众号，这个流程更重要。因为每个人手里的模板、图片习惯和标题写法都不一样，旧稿一旦没有统一入口，就很容易越翻越散。",
        "最后再看一遍读者能不能感受到新价值。如果只看见旧图、旧案例和旧表达，哪怕内容没有错，也会让人觉得敷衍。旧稿翻新要做的是把还能用的经验重新整理到今天的语境里。",
        "所以旧稿不是不能再发，关键是别让读者看出它是被随手搬回来的。内容更新一点，格式重新收紧一点，再补一个这次重发的理由，旧文章才像一次认真复用，而不是一次低质重发。",
    ])
    near_limit_incomplete_body = complete_body[:925] + "\n\n4️⃣ 发布前再查风险。"

    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "发布稿尾段修复编辑" in prompt:
                assert "bare_step_heading_tail" in prompt
                assert "不要扩写大段" in prompt
                return {
                    "title_candidates": ["旧文重发别只改内容"],
                    "body": complete_body,
                    "tags": ["公众号运营", "旧文翻新", "排版工具"],
                    "repair_notes": ["补完发布前风险步骤并压缩收束"],
                }
            if "策略直写返修编辑" in prompt or "策略直写终稿补全编辑" in prompt:
                return {
                    "title_candidates": ["旧文重发别只改内容"],
                    "body": near_limit_incomplete_body,
                    "tags": ["公众号运营"],
                    "repair_notes": ["仍停在步骤标题"],
                }
            return {
                "final_title": "旧文重发别只改内容",
                "title_candidates": ["旧文重发别只改内容"],
                "body": near_limit_incomplete_body,
                "tags": ["公众号运营"],
                "rationale": "接近上限但尾部未完成",
            }

    generator = FakeGenerator()
    result = generator.generate_strategy_direct_session(
        benchmark_note={"title": "旧文重发别只改内容", "desc": "策略合成对标"},
        product_info={
            "product_name": "壹伴助手",
            "product_features": "一键排版、样式中心、图片处理、敏感词检测",
            "target_audience": "公众号编辑",
        },
        note_strategy={
            "id": "strategy_tail",
            "label": "旧文翻新不重做型",
            "suggestedTitle": "旧文重发别只改内容",
            "recommendedCardPlan": ["旧稿返工痛点", "统一基础格式", "修层级样式", "处理配图", "发布风险检查", "完整收束"],
            "productUsageMode": "product_main",
        },
    )

    assert len(generator.prompts) == 4
    assert len(result["final_body"]) <= 950
    assert "模型尾段窄修复已执行" in " ".join(result["revision_notes"])
    assert "body_incomplete_or_too_short" not in result["candidate_judge_quality_flags"]


def test_strategy_direct_title_fallbacks_respect_product_context():
    body = (
        "我写资料型笔记时经常会同时打开很多网页和小红书案例，最后卡住的不是表达，而是证据链断了。"
        "有些内容需要复制原文里的依据，也需要把高亮和收藏整理成资料库，再生成笔记。"
    )

    titles = _build_strategy_direct_title_fallbacks(
        body=body,
        product_info={
            "product_name": "YouMind",
            "product_features": "网页收藏、资料高亮、知识库整理、AI总结、基于资料生成文章和笔记",
        },
        note_strategy={
            "label": "先别急着写，先把证据链捋顺",
            "contentAngle": "问题解决型：围绕资料很多但写不出来",
            "summary": "资料型创作者需要先建立证据链。",
        },
    )

    assert "改小红书别再复制粘贴" not in titles
    assert any("证据链" in title or "资料" in title for title in titles)


def test_strategy_direct_title_ranking_prefers_strategy_pain_over_generic_feature_template():
    body = (
        "资料越多越写不出来，核心不是网页收藏不够快，而是证据链没有捋顺。"
        "先把资料、高亮和依据放回同一个主题，再让 AI 基于这些资料生成框架。"
    )

    ranked = _rank_publish_title_candidates(
        ["网页收藏省时流程", "写之前先捋证据链"],
        benchmark_title="为什么你明明查了很多资料，还是写不出一篇像样的内容",
        strategy_title="为什么你明明查了很多资料，还是写不出一篇像样的内容",
        body=body,
        product_info={
            "product_name": "YouMind",
            "product_features": "网页收藏、资料高亮、知识库整理、AI总结、基于资料生成文章和笔记",
        },
    )

    assert ranked[0] == "写之前先捋证据链"


def test_title_ranking_rejects_sentence_fragment_title():
    body = (
        "老板复盘时最怕看不清团队忙的是不是关键动作。客户跟进如果只靠个人习惯，"
        "复盘就只能看结果，没法判断到底是哪一步断了。"
    )

    ranked = _rank_publish_title_candidates(
        ["却很难确认忙的是不是关", "老板复盘先查关键动作"],
        benchmark_title="同样客户为什么换个人结果差很多",
        strategy_title="同样客户为什么换个人结果差很多",
        body=body,
        product_info={
            "product_name": "微伴助手",
            "product_features": "客户标签、企微SOP、客户跟进提醒、销售过程管理、数据复盘",
        },
    )

    assert ranked[0] == "老板复盘先查关键动作"


def test_title_ranking_rejects_feature_list_title():
    body = (
        "公众号旧文转小红书，真正卡住的不是有没有标题生成和卡片大纲，"
        "而是团队还在靠人肉复制粘贴，每个平台都重做一遍。"
    )

    ranked = _rank_publish_title_candidates(
        ["支持标题生成、卡片大纲", "公众号转小红书别硬搬"],
        benchmark_title="你不是没内容发，你是把公众号旧文全浪费了",
        strategy_title="你不是没内容发，你是把公众号旧文全浪费了",
        body=body,
        product_info={
            "product_name": "Uplog",
            "product_features": "公众号文章转小红书笔记、多平台改写、标题生成、卡片大纲、批量内容复用",
        },
    )

    assert ranked[0] == "公众号转小红书别硬搬"


def test_publish_limit_fit_hard_clips_when_model_still_over_limit():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            pass

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            return {
                "title_candidates": ["私域运营别硬扛"],
                "body": "模型还是写超了，" * 180,
                "notes": ["尝试压缩"],
            }

    result = FakeGenerator()._fit_to_xhs_publish_limits(
        title_candidates=["这是一个明显超过二十个字的小红书标题需要自然重写"],
        body="这是一段很长的正文，" * 150,
        product_info={"product_name": "微伴助手"},
        note_strategy="保留核心卖点",
    )

    assert len(result["body"]) <= XHS_BODY_MAX_CHARS
    assert "兜底压到发布长度内" in " ".join(result["notes"])


def test_interview_content_uses_direct_prompt_contract_not_strategy_pipeline():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def generate_rewrite_session(self, **kwargs):
            raise AssertionError("访谈正文不应调用策略生文重链路")

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            return {
                "final_title": "流量上不去怎么办",
                "title_candidates": ["流量上不去怎么办", "小红书复盘先看这点"],
                "expression_contract": {
                    "content_type": "问题诊断型",
                    "reader_identity": "小红书运营写给同类运营",
                    "writing_structure": "场景痛点-判断-方法-工具承接-行动",
                    "product_role": "辅助复盘",
                    "quality_bar": ["围绕访谈信息", "不堆功能"],
                },
                "content_atoms": [
                    {"role": "pain_point", "text": "最近笔记流量不好"},
                    {"role": "product_bridge", "text": "用爆款笔记分析做复盘"},
                ],
                "opening_candidates": ["最近笔记流量不好，先别急着重写。"],
                "content_outline": ["先看流量卡点", "再复盘标题和选题", "最后用工具承接"],
                "content": _long_xhs_body("最近笔记流量不好，先别急着重写。"),
                "tags": ["小红书运营"],
                "rationale": "贴合访谈中的流量复盘目标",
            }

    generator = FakeGenerator()
    result = generator.generate_content_from_interview(
        selected_title="流量上不去怎么办",
        collected_info={
            "product_name": "Uplog",
            "core_features": "爆款笔记分析",
            "target_audience": "小红书运营",
            "marketing_goal": "获取咨询",
            "real_motivation": "最近笔记流量不好",
            "target_scene": "内容复盘",
            "action_goal": "引导试用",
        },
    )

    assert len(generator.prompts) == 1
    joined_prompts = "\n".join(generator.prompts)
    assert "表达契约" in joined_prompts
    assert "内容原子" in joined_prompts
    assert "策略表达执行规则" in joined_prompts
    assert "\"expression_contract\"" not in joined_prompts
    assert "\"content_atoms\"" not in joined_prompts
    assert result["content"] == _long_xhs_body("最近笔记流量不好，先别急着重写。")
    assert result["rewrite_session"]["final_body_source"] == "interview_direct"
    assert result["rewrite_session"]["candidate_judge_enabled"] is False
    assert result["rewrite_session"]["expression_contract"]["content_type"] == "访谈提炼型小红书笔记"


def test_interview_content_retries_when_first_body_is_short():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if len(self.prompts) == 1:
                return {
                    "final_title": "做小红书别硬扛",
                    "title_candidates": ["做小红书别硬扛"],
                    "content": "做小红书最累的不是写文案，而是不知道发什么。",
                    "tags": ["小红书运营"],
                }
            return {
                "final_title": "做小红书别硬扛",
                "title_candidates": ["做小红书别硬扛"],
                "content": _long_xhs_body("做小红书最累的不是写文案，而是每天卡在选题和排版。"),
                "tags": ["小红书运营"],
                "rationale": "围绕访谈里的真实卡点展开",
            }

    generator = FakeGenerator()
    result = generator.generate_content_from_interview(
        selected_title="做小红书别硬扛",
        collected_info={
            "product_name": "Uplog",
            "core_features": "一键导入、模板套用、自动分页、水印、敏感词检测",
            "target_audience": "小编，自媒体",
            "marketing_goal": "让小编意识到图文笔记可以省时间",
            "real_motivation": "不知道写什么才能带来评论和关注",
            "target_scene": "每天赶小红书图文的小编",
            "action_goal": "引导读者在评论区聊自己发小红书遇到的问题",
            "content_specifics": "复制粘贴、排版分页、水印和敏感词检查都要反复处理",
        },
    )

    assert len(generator.prompts) == 2
    assert "重要重写要求" in generator.prompts[1]
    assert result["content"] == _long_xhs_body("做小红书最累的不是写文案，而是每天卡在选题和排版。")


def test_call_json_rejects_truncated_model_output(monkeypatch):
    class FakeMessage:
        content = '{"title":"标题","content":"半截正文'

    class FakeChoice:
        finish_reason = "length"
        message = FakeMessage()

    class FakeResponse:
        choices = [FakeChoice()]

    class FakeCompletions:
        def create(self, **kwargs):
            return FakeResponse()

    class FakeChat:
        completions = FakeCompletions()

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.chat = FakeChat()

    monkeypatch.setattr("backend.services.viral_content_generator.OpenAI", FakeOpenAI)

    generator = ViralContentGenerator(api_key="key", base_url="https://example.com/v1", model="model")
    try:
        generator._call_json("prompt", max_tokens=10)
    except RuntimeError as error:
        assert "模型输出被截断" in str(error)
        assert is_retryable_text_generation_error(error)
    else:
        raise AssertionError("截断输出不应被当作成功 JSON")


def test_interview_content_rejects_short_incomplete_body():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            pass

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            return {
                "final_title": "流量上不去怎么办",
                "title_candidates": ["流量上不去怎么办"],
                "content": "先把标题改得更有吸引力，",
                "tags": ["小红书运营"],
            }

    generator = FakeGenerator()
    try:
        generator.generate_content_from_interview(
            selected_title="流量上不去怎么办",
            collected_info={
                "product_name": "Uplog",
                "core_features": "爆款笔记分析",
                "target_audience": "小红书运营",
            },
        )
    except ValueError as error:
        assert "访谈正文不完整" in str(error)
    else:
        raise AssertionError("短残稿不应作为访谈正文返回")


def test_revision_keeps_original_body_when_model_returns_fragment():
    original_body = _long_xhs_body()

    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            pass

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            if "定向改写编辑器" in prompt:
                return {
                    "detected_scope": "body",
                    "reasoning_summary": "按用户要求调整正文",
                    "updated_fields": {
                        "body": "语气更活泼一点，",
                    },
                    "updated_rewrite_session": {
                        "title_candidates": ["改笔记别只看模板"],
                        "opening_candidates": ["很多运营改笔记，卡住的不是不会写。"],
                        "content_outline": ["场景", "判断", "行动"],
                        "final_body": "语气更活泼一点，",
                        "revision_notes": ["本次改得更活泼"],
                    },
            }
            return {
                "title_candidates": ["改笔记别只看模板"],
                "body": original_body,
                "notes": [],
            }

        def _fit_to_xhs_publish_limits(self, **kwargs):
            return {
                "title_candidates": kwargs.get("title_candidates", []),
                "body": kwargs.get("body", ""),
                "changed": False,
                "notes": [],
            }

    result = FakeGenerator().revise_confirmation_note(
        title="改笔记别只看模板",
        opening="很多运营改笔记，卡住的不是不会写。",
        outline=["场景", "判断", "行动"],
        body=original_body,
        instruction="语气更活泼一点",
    )

    assert result["updated_fields"]["body"] == original_body
    assert result["updated_rewrite_session"]["final_body"] == original_body
    assert "疑似不完整" in " ".join(result["updated_rewrite_session"]["revision_notes"])


def test_rewrite_session_keeps_de_ai_when_length_fit_fails():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            pass

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            if "结构迁移" in prompt:
                return {
                    "title_frameworks": ["客户跟进别靠猜"],
                    "opening_hooks": ["客户一多，问题就来了。"],
                    "content_outline": ["痛点", "方案", "行动"],
                    "ending_options": ["先检查流程"],
                    "rewrite_strategy": "保留客户跟进场景",
                }
            if "可发前主稿" in prompt:
                return {
                    "title_candidates": ["客户跟进别靠猜"],
                    "opening_candidates": ["客户一多，问题就来了。"],
                    "body_draft": "微伴助手能够帮助团队进行客户跟进，同时提升私域运营效率。客户一多，销售很容易漏掉后续动作，老板复盘时也看不清问题卡在哪里。它能把来源记录、标签判断、SOP 提醒和复盘数据放到同一个流程里，减少靠人工记忆硬扛的情况，也方便管理者看到每一步是否有人接住。",
                    "replacement_phrases": [],
                    "tags": ["私域运营"],
                    "rationale": "围绕客户跟进痛点",
                }
            if "去 AI 味轻改编辑器" in prompt:
                return {
                    "minimal_polish_body": "微伴助手能帮团队把客户跟进这件事捋顺，也能让私域运营少一点手忙脚乱。客户一多，销售容易漏掉后续动作，老板复盘时也能更快看清问题卡在哪里。来源记录、标签判断、SOP 提醒和复盘数据放到一个流程里后，就不用总靠人工记忆硬扛，管理者也能看到每一步有没有人接住。",
                    "polished_openings": ["客户一多，问题就来了。"],
                    "de_ai_report": {"summary": "改掉书面表达"},
                    "revision_notes": ["把能够改成能", "把提升改成少一点手忙脚乱"],
                    "high_risk_ai_sentences": [],
                }
            return {}

        def _fit_to_xhs_publish_limits(self, **kwargs):
            raise RuntimeError("length fit unavailable")

    result = FakeGenerator().generate_rewrite_session(
        benchmark_note={"title": "客户一多就乱套", "desc": "客户跟进总漏。"},
        product_info={
            "product_name": "微伴助手",
            "product_features": "客户跟进, 私域运营",
            "target_audience": "老板",
        },
    )

    assert result["final_body_source"] == "minimal_polish"
    assert "能帮团队" in result["final_body"]
    assert result["final_body"] != result["body_draft"]
    assert "发布长度/标题适配失败" in " ".join(result["guardrail_repairs_applied"])


def test_rewrite_session_injects_selected_strategy_into_benchmark_prompts():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "结构迁移" in prompt:
                return {
                    "title_frameworks": ["618复利增长别乱做"],
                    "opening_hooks": ["618 前最怕流量来了接不住。"],
                    "content_outline": ["618大促痛点", "复利增长方案", "行动"],
                    "ending_options": ["先检查链路"],
                    "rewrite_strategy": "保留618复利增长策略",
                }
            if "可发前主稿" in prompt:
                return {
                    "title_candidates": ["618私域别乱冲"],
                    "opening_candidates": ["618 前最怕流量来了接不住。"],
                    "body_draft": "618 大促前，微伴助手适合先把客户分层、SOP提醒和复盘链路搭好，让每一波新增流量都能沉淀成后续复利增长。",
                    "replacement_phrases": [],
                    "tags": ["618私域"],
                    "rationale": "围绕618复利增长",
                }
            if "去 AI 味轻改编辑器" in prompt:
                return {
                    "minimal_polish_body": "618 大促前，微伴助手更适合先把客户分层、SOP提醒和复盘链路搭好，让新增流量不只是冲一波，而是沉淀成后续复利增长。",
                    "polished_openings": ["618 前最怕流量来了接不住。"],
                    "de_ai_report": {"summary": "保留618策略锚点"},
                    "revision_notes": ["保留618策略"],
                    "high_risk_ai_sentences": [],
                }
            if "去 AI 味深改编辑器" in prompt:
                return {
                    "deep_polish_body": "说真的，618 大促前别只盯着加人。微伴助手更适合先把客户分层、SOP提醒和复盘链路搭好，让新增流量不只是冲一波，而是能慢慢变成后续复利增长。",
                    "polished_openings": ["618 前别只盯着加人。"],
                    "de_ai_report": {"summary": "深改保留618策略"},
                    "revision_notes": ["强化618"],
                    "high_risk_ai_sentences": [],
                }
            return {"title_candidates": ["618私域别乱冲"], "body": "618 私域正文", "notes": []}

    generator = FakeGenerator()
    generator.generate_rewrite_session(
        benchmark_note={"title": "618私域打法", "desc": "618期间要把流量接住。"},
        product_info={
            "product_name": "微伴助手",
            "product_features": "客户分层, SOP提醒, 私域复盘",
            "target_audience": "私域团队",
        },
        note_strategy={
            "label": "618复利增长版",
            "summary": "围绕618大促承接流量，沉淀后续复利增长。",
            "suggestedTitle": "618别只看新增",
            "contentAngle": "大促复利增长",
            "corePainPoints": ["618流量接不住"],
            "coreBenefits": ["把大促新增沉淀成复利增长"],
            "recommendedCardPlan": ["618封面", "流量承接", "复利增长"],
        },
    )

    joined_prompts = "\n".join(generator.prompts[:2])
    assert "618复利增长版" in joined_prompts
    assert "策略锚点词必须" in joined_prompts
    assert "618" in joined_prompts


def test_rewrite_session_does_not_inject_product_main_constraints():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "结构迁移" in prompt:
                return {
                    "title_frameworks": ["客户跟进别靠猜"],
                    "opening_hooks": ["客户一多，问题就来了。"],
                    "content_outline": ["痛点", "方案", "行动"],
                    "ending_options": ["先检查流程"],
                    "rewrite_strategy": "保留客户跟进场景",
                }
            if "可发前主稿" in prompt:
                return {
                    "title_candidates": ["客户跟进别靠猜"],
                    "opening_candidates": ["客户一多，问题就来了。"],
                    "body_draft": "微伴助手适合把客户标签、SOP提醒和复盘数据放进同一条私域链路里。",
                    "replacement_phrases": [],
                    "tags": ["私域运营"],
                    "rationale": "围绕客户跟进痛点",
                }
            if "去 AI 味轻改编辑器" in prompt:
                return {
                    "minimal_polish_body": "微伴助手能把客户标签、SOP提醒和复盘数据放进同一条私域链路里。",
                    "polished_openings": ["客户一多，问题就来了。"],
                    "de_ai_report": {"summary": "轻改"},
                    "revision_notes": ["轻改"],
                    "high_risk_ai_sentences": [],
                }
            if "去 AI 味深改编辑器" in prompt:
                return {
                    "deep_polish_body": "",
                    "polished_openings": [],
                    "de_ai_report": {"summary": "跳过深改"},
                    "revision_notes": [],
                    "high_risk_ai_sentences": [],
                }
            return {"title_candidates": ["客户跟进别靠猜"], "body": "正文", "notes": []}

        def _fit_to_xhs_publish_limits(self, **kwargs):
            return {
                "changed": False,
                "title_candidates": kwargs.get("title_candidates", []),
                "body": kwargs.get("body", ""),
                "notes": [],
            }

    generator = FakeGenerator()
    generator.generate_rewrite_session(
        benchmark_note={"title": "客户一多就乱套", "desc": "客户跟进总漏。"},
        product_info={
            "product_name": "微伴助手",
            "product_features": "客户标签, SOP提醒, 复盘数据",
            "target_audience": "老板",
        },
        note_strategy={
            "label": "私域经营系统",
            "summary": "围绕客户跟进痛点展开。",
            "suggestedTitle": "客户跟进别靠猜",
            "contentAngle": "问题解决型",
            "corePainPoints": ["客户跟进总漏"],
            "coreBenefits": ["客户标签", "SOP提醒"],
            "recommendedCardPlan": ["痛点页", "方案页"],
            "productUsageMode": "product_main",
            "benchmarkFit": {"product_usage_mode": "product_main", "fit_level": "strong_fit"},
        },
    )

    joined_prompts = "\n".join(generator.prompts)
    assert "产品介入约束" not in joined_prompts
    assert "仍要保留对标笔记的标题风格" not in joined_prompts


def test_rewrite_session_keeps_restrictive_product_usage_constraints():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "结构迁移" in prompt:
                return {
                    "title_frameworks": ["爆款笔记先看结构"],
                    "opening_hooks": ["先别急着塞产品。"],
                    "content_outline": ["方法", "提醒", "互动"],
                    "ending_options": ["问读者卡点"],
                    "rewrite_strategy": "保留方法结构",
                }
            if "可发前主稿" in prompt:
                return {
                    "title_candidates": ["爆款笔记先看结构"],
                    "opening_candidates": ["先别急着塞产品。"],
                    "body_draft": "先看标题、封面和正文节奏，再决定要不要放工具辅助。",
                    "replacement_phrases": [],
                    "tags": ["小红书运营"],
                    "rationale": "方法主线",
                }
            if "去 AI 味轻改编辑器" in prompt:
                return {
                    "minimal_polish_body": "先看标题、封面和正文节奏，再决定要不要放工具辅助。",
                    "polished_openings": ["先别急着塞产品。"],
                    "de_ai_report": {"summary": "轻改"},
                    "revision_notes": ["轻改"],
                    "high_risk_ai_sentences": [],
                }
            if "去 AI 味深改编辑器" in prompt:
                return {
                    "deep_polish_body": "",
                    "polished_openings": [],
                    "de_ai_report": {"summary": "跳过深改"},
                    "revision_notes": [],
                    "high_risk_ai_sentences": [],
                }
            return {"title_candidates": ["爆款笔记先看结构"], "body": "正文", "notes": []}

        def _fit_to_xhs_publish_limits(self, **kwargs):
            return {
                "changed": False,
                "title_candidates": kwargs.get("title_candidates", []),
                "body": kwargs.get("body", ""),
                "notes": [],
            }

    generator = FakeGenerator()
    generator.generate_rewrite_session(
        benchmark_note={"title": "爆款笔记结构", "desc": "封面标题正文节奏。"},
        product_info={
            "product_name": "Uplog",
            "product_features": "AI写作, 模板",
            "target_audience": "小红书运营",
        },
        note_strategy={
            "label": "内容主线轻承接",
            "summary": "先保留方法主线，产品只轻带。",
            "suggestedTitle": "爆款笔记先看结构",
            "contentAngle": "方法复刻型",
            "corePainPoints": ["不会写笔记"],
            "coreBenefits": ["辅助执行"],
            "recommendedCardPlan": ["方法页", "产品轻承接页"],
            "productUsageMode": "product_assist",
            "benchmarkFit": {"product_usage_mode": "product_assist", "fit_level": "soft_fit"},
        },
    )

    joined_prompts = "\n".join(generator.prompts)
    assert "产品介入约束：product_assist" in joined_prompts
    assert "产品只可作为辅助承接" in joined_prompts


def test_rewrite_session_does_not_force_placeholder_strategy_anchor():
    class FakeGenerator(ViralContentGenerator):
        def __init__(self):
            self.prompts = []

        def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200):
            self.prompts.append(prompt)
            if "结构迁移" in prompt:
                return {
                    "title_frameworks": ["老板做企微别只加人"],
                    "opening_hooks": ["很多老板卡住的不是工具。"],
                    "content_outline": ["私域失控感", "三个断层", "系统化承接"],
                    "ending_options": ["问当前最卡的环节"],
                    "rewrite_strategy": "围绕老板私域卡点展开",
                }
            if "可发前主稿" in prompt:
                return {
                    "title_candidates": ["做企微别只看加人"],
                    "opening_candidates": ["很多老板卡住的不是工具。"],
                    "body_draft": (
                        "很多老板做企微，卡住的不是不会用软件，而是客户进来后没人真正接住。\n\n"
                        "前面流量在投，中间销售在跟，后面复购却总是断掉。微伴助手更适合把渠道来源、客户标签、SOP提醒和复盘数据放进同一条链路里，让团队不用只靠个人记忆硬扛。\n\n"
                        "如果你们现在最难的是获客、跟进还是复购，可以先从这条链路开始查。"
                    ),
                    "replacement_phrases": [],
                    "tags": ["企微私域"],
                    "rationale": "围绕老板私域卡点",
                }
            if "去 AI 味轻改编辑器" in prompt:
                return {
                    "minimal_polish_body": (
                        "很多老板做企微，卡住的其实不是软件不会用，而是客户进来后没人真正接住。\n\n"
                        "前面流量在投，中间销售在跟，后面复购却总是断掉。微伴助手更适合把渠道来源、客户标签、SOP提醒和复盘数据放进同一条链路里，让团队不用只靠个人记忆硬扛。\n\n"
                        "如果你们现在最难的是获客、跟进还是复购，可以先从这条链路开始查。\n\n"
                        "暂无"
                    ),
                    "polished_openings": ["很多老板卡住的不是软件。"],
                    "de_ai_report": {"summary": "轻改表达"},
                    "revision_notes": ["保留CTA和策略锚点词\"暂无\""],
                    "high_risk_ai_sentences": [],
                }
            if "去 AI 味深改编辑器" in prompt:
                return {
                    "deep_polish_body": "",
                    "polished_openings": [],
                    "de_ai_report": {"summary": "跳过深改"},
                    "revision_notes": [],
                    "high_risk_ai_sentences": [],
                }
            return {"title_candidates": ["做企微别只看加人"], "body": "正文", "notes": []}

        def _fit_to_xhs_publish_limits(self, **kwargs):
            return {
                "changed": False,
                "title_candidates": kwargs.get("title_candidates", []),
                "body": kwargs.get("body", ""),
                "notes": [],
            }

    generator = FakeGenerator()
    result = generator.generate_rewrite_session(
        benchmark_note={"title": "老板私域复盘", "desc": "客户进来后要接住。"},
        product_info={
            "product_name": "微伴助手",
            "product_features": "客户标签, SOP提醒, 复盘数据",
            "target_audience": "老板",
        },
        note_strategy={
            "label": "老板视角",
            "summary": "围绕老板私域卡点诊断。",
            "suggestedTitle": "",
            "contentAngle": "",
            "corePainPoints": [],
            "coreBenefits": [],
            "recommendedCardPlan": [],
        },
    )

    joined_prompts = "\n".join(generator.prompts)
    assert "策略锚点词必须自然出现，尤其是：暂无" not in joined_prompts
    assert "不要把“暂无”“无”等占位词写入标题或正文" in joined_prompts
    assert not result["final_body"].endswith("暂无")
    assert "暂无" not in result["minimal_polish_body"]
