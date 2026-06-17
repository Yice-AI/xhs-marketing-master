import unittest

from backend.services.image2_prompt_engine import (
    apply_image2_dynamic_intent_guardrails,
    build_image2_dynamic_system_prompt,
    build_image2_dynamic_user_message,
)


class Image2DynamicPromptEngineTest(unittest.TestCase):
    def _sample_prompts(self):
        return [
            {
                "id": 1,
                "type": "Cover",
                "role": "cover",
                "title": "小红书图文排版4步速通",
                "prompt": (
                    "生成一张小红书软件工具类封面图。\n"
                    "产品特点：一键导入，无需复制粘贴；自动分页；模板一键套用；发布前检查\n"
                    "笔记正文：封面只突出 4 步速通。"
                ),
            },
            {
                "id": 2,
                "type": "Content",
                "role": "step",
                "title": "排版步骤",
                "prompt": "生成一张小红书软件工具类内容图。\n笔记正文：展示排版步骤。",
            },
            {
                "id": 3,
                "type": "Summary",
                "role": "ending",
                "title": "收藏领取模板",
                "prompt": "生成一张小红书软件工具类结尾图。\n笔记正文：总结并引导收藏。",
            },
        ]

    def test_dynamic_without_intent_keeps_default_path_clean(self):
        message = build_image2_dynamic_user_message(
            title="小红书图文排版4步速通",
            content="正文",
            product_brief={
                "product_name": "Uplog",
                "target_audience": "小编，自媒体",
                "product_features": "一键导入，无需复制粘贴；自动分页",
            },
            dynamic_style_params=None,
        )

        self.assertIn("默认采用清晰、高级、适合软件/工具类小红书的信息型视觉", message)
        self.assertNotIn("补充意图处理方式", message)
        self.assertNotIn("补充意图只用于内容策略", message)

    def test_dynamic_system_prompt_allows_six_without_quota_filling(self):
        prompt = build_image2_dynamic_system_prompt()

        self.assertIn("最多 6 张", prompt)
        self.assertIn("禁止为了凑满而重复出图", prompt)
        self.assertIn("简单内容不要硬拆 5-6 张", prompt)
        self.assertIn("只有内容本身有足够层级时才生成 5-6 张", prompt)

    def test_style_expression_preset_guides_dynamic_user_message(self):
        message = build_image2_dynamic_user_message(
            title="私域 SOP 怎么搭",
            content="正文",
            dynamic_style_params={"style_preset": "运营干货手绘卡"},
        )

        self.assertIn("风格表达预设", message)
        self.assertIn("运营干货手绘卡", message)
        self.assertIn("饱和青绿色背景", message)
        self.assertIn("白色/浅奶白撕纸质感大纸张", message)
        self.assertIn("珊瑚红收藏贴纸", message)
        self.assertIn("同一风格系统", message)
        self.assertIn("必须先按笔记内容规划每张图角色", message)
        self.assertIn("保持动态表达现有小红书软件/工具类图片质量", message)

    def test_dynamic_intent_is_content_guidance_not_style_rewrite(self):
        intent = (
            "封面优化：精简信息，将核心卖点浓缩为1-2个；"
            "加入评论区互动话术；结尾增加关注收藏福利。"
        )

        message = build_image2_dynamic_user_message(
            title="小红书图文排版4步速通",
            content="正文",
            product_brief={
                "product_name": "Uplog",
                "target_audience": "小编，自媒体",
                "product_features": "一键导入，无需复制粘贴；自动分页",
            },
            dynamic_style_params={"intent": intent},
        )

        self.assertIn(f"- 补充意图: {intent}", message)
        self.assertIn("补充意图处理方式", message)
        self.assertIn("先判断补充意图的作用范围", message)
        self.assertIn("明确提到配色、密度、版式或画风时，才把它作为视觉约束", message)
        self.assertIn("不要把内容型补充意图当成新的视觉风格", message)
        self.assertIn("让每张图“说什么”更贴合，不让它“长什么样”被重写", message)
        self.assertIn("互动话术和福利优先放在内容页或结尾页", message)

    def test_dynamic_style_preferences_do_not_trigger_intent_guidance(self):
        message = build_image2_dynamic_user_message(
            title="小红书图文排版4步速通",
            content="正文",
            dynamic_style_params={"color": "蓝白", "layout": "卡片"},
        )

        self.assertIn("- 颜色偏好: 蓝白", message)
        self.assertIn("- 版式偏好: 卡片", message)
        self.assertNotIn("补充意图处理方式", message)

    def test_dynamic_intent_guardrails_append_to_final_cover_prompt(self):
        intent = "封面精简，移除“神器”“300%+”，改用“省时50%”；结尾增加关注收藏福利。"
        prompts = [
            {
                "id": 1,
                "type": "Cover",
                "role": "cover",
                "title": "小红书图文排版4步速通",
                "prompt": (
                    "生成一张小红书软件工具类封面图。\n"
                    "产品特点：一键导入，无需复制粘贴；自动分页；模板一键套用；发布前检查\n"
                    "笔记正文：封面只突出 4 步速通和省时。"
                ),
            }
        ]

        guarded = apply_image2_dynamic_intent_guardrails(prompts, {"intent": intent})
        prompt_text = guarded[0]["prompt"]

        self.assertIn("用户补充意图落图约束", prompt_text)
        self.assertIn("最终送图硬约束", prompt_text)
        self.assertIn("不要自行生成百分比、倍数", prompt_text)
        self.assertIn("80%+", prompt_text)
        self.assertIn("300%+", prompt_text)
        self.assertIn("禁止出现这些可见文案：神器、300%+", prompt_text)
        self.assertNotIn("禁止出现这些可见文案：神器、300%+、省时50%", prompt_text)
        self.assertIn("产品特点（背景信息，封面最多选 1-2 个相关点，不要全部上屏）：一键导入；无需复制粘贴", prompt_text)
        self.assertNotIn("产品特点：一键导入，无需复制粘贴；自动分页；模板一键套用；发布前检查", prompt_text)
        self.assertIn("封面可见文案最多：1 个主标题 + 1 个副文案/数据点 + 产品名或 Logo", prompt_text)
        self.assertIn("不要展开步骤清单、功能清单、底部多栏目卖点区", prompt_text)
        self.assertIn("若标题或笔记出现步骤数量", prompt_text)
        self.assertNotIn("封面不要画成 4 个功能卡片", prompt_text)

    def test_external_api_logo_guardrail_requires_explicit_api_marker(self):
        intent = "品牌 Logo 视觉约束：\n- 严禁在 Logo/品牌区写成：「微伴」。\n- Logo 图标必须使用壹伴官方风格：绿色圆形底，中间是白色几何 Y 形/折角标识；不要画成叶子。"

        guarded = apply_image2_dynamic_intent_guardrails(
            self._sample_prompts()[:1],
            {"intent": intent},
        )

        prompt_text = guarded[0]["prompt"]
        self.assertIn("用户补充意图落图约束", prompt_text)
        self.assertNotIn("外部 API Logo 最终硬约束", prompt_text)
        self.assertNotIn("不要画成叶子", prompt_text)

    def test_external_api_logo_guardrail_appends_full_logo_constraints(self):
        intent = "品牌 Logo 视觉约束：\n- 严禁在 Logo/品牌区写成：「微伴」。\n- Logo 图标必须使用壹伴官方风格：绿色圆形底，中间是白色几何 Y 形/折角标识；不要画成叶子。"

        guarded = apply_image2_dynamic_intent_guardrails(
            self._sample_prompts()[:1],
            {
                "intent": intent,
                "external_api_logo_guardrail": intent,
            },
        )

        prompt_text = guarded[0]["prompt"]
        self.assertIn("外部 API Logo 最终硬约束", prompt_text)
        self.assertIn("严禁在 Logo/品牌区写成：「微伴」", prompt_text)
        self.assertIn("白色几何 Y 形", prompt_text)
        self.assertIn("不要画成叶子", prompt_text)

    def test_style_expression_preset_guardrail_appends_to_final_prompts(self):
        guarded = apply_image2_dynamic_intent_guardrails(
            self._sample_prompts()[:1],
            {"style_preset": "运营干货手绘卡"},
        )

        prompt_text = guarded[0]["prompt"]
        self.assertIn("风格表达预设落图约束", prompt_text)
        self.assertIn("运营干货手绘卡", prompt_text)
        self.assertIn("青绿外底", prompt_text)
        self.assertIn("白/奶白撕纸", prompt_text)
        self.assertIn("粗黑手写标题", prompt_text)
        self.assertIn("红色收藏贴纸", prompt_text)
        self.assertIn("同组图片要保持统一色板", prompt_text)
        self.assertEqual(guarded[0]["style_preset"], "handdrawn_operations")
        self.assertEqual(guarded[0]["style_preset_label"], "运营干货手绘卡")

    def test_dynamic_intent_guardrails_do_not_change_no_intent_prompts(self):
        prompts = [{"id": 1, "type": "Cover", "prompt": "原始 prompt"}]

        self.assertIs(apply_image2_dynamic_intent_guardrails(prompts, None), prompts)
        self.assertIs(apply_image2_dynamic_intent_guardrails(prompts, {"intent": ""}), prompts)

    def test_dynamic_intent_guardrails_are_idempotent(self):
        prompts = [{
            "id": 1,
            "type": "Cover",
            "prompt": "原始 prompt\n\n# 用户补充意图落图约束:\n- 已存在",
        }]

        guarded = apply_image2_dynamic_intent_guardrails(prompts, {"intent": "封面精简"})

        self.assertEqual(guarded[0]["prompt"].count("用户补充意图落图约束"), 1)

    def test_global_color_intent_applies_to_every_prompt(self):
        guarded = apply_image2_dynamic_intent_guardrails(
            self._sample_prompts(),
            {"intent": "整体配色改成紫白色"},
        )

        for prompt in guarded:
            prompt_text = prompt["prompt"]
            self.assertIn("全组配色硬约束", prompt_text)
            self.assertIn("紫白", prompt_text)

    def test_cover_only_color_and_density_do_not_affect_other_pages(self):
        guarded = apply_image2_dynamic_intent_guardrails(
            self._sample_prompts(),
            {"intent": "封面配色改成紫白色，信息更精简"},
        )

        self.assertIn("封面配色硬约束", guarded[0]["prompt"])
        self.assertIn("封面密度硬约束", guarded[0]["prompt"])
        self.assertNotIn("配色硬约束", guarded[1]["prompt"])
        self.assertNotIn("密度硬约束", guarded[1]["prompt"])
        self.assertNotIn("配色硬约束", guarded[2]["prompt"])
        self.assertNotIn("密度硬约束", guarded[2]["prompt"])

    def test_global_density_intent_applies_to_cover_content_and_ending(self):
        guarded = apply_image2_dynamic_intent_guardrails(
            self._sample_prompts(),
            {"intent": "整体画面密度不要那么高，减少模块，多留白"},
        )

        for prompt in guarded:
            prompt_text = prompt["prompt"]
            self.assertIn("全组密度硬约束", prompt_text)
            self.assertIn("增加留白", prompt_text)
            self.assertIn("减少模块数量", prompt_text)

    def test_ending_benefit_intent_is_not_inserted_into_cover(self):
        guarded = apply_image2_dynamic_intent_guardrails(
            self._sample_prompts(),
            {"intent": "封面精简信息；结尾增加福利，关注+收藏，送Uplog模板合集"},
        )

        self.assertNotIn("结尾福利表达", guarded[0]["prompt"])
        self.assertIn("结尾福利表达", guarded[2]["prompt"])
        self.assertIn("关注+收藏", guarded[2]["prompt"])

    def test_content_interaction_intent_goes_to_content_and_ending_not_cover(self):
        guarded = apply_image2_dynamic_intent_guardrails(
            self._sample_prompts(),
            {"intent": "内容优化：加入引导互动话术，比如你遇到过这些排版难题吗？评论区聊聊"},
        )

        self.assertNotIn("内容页互动话术：可轻量放入", guarded[0]["prompt"])
        self.assertIn("内容页互动话术：可轻量放入", guarded[1]["prompt"])
        self.assertIn("内容页互动话术：可轻量放入", guarded[2]["prompt"])

    def test_last_page_is_not_forced_to_ending_without_ending_signal(self):
        prompts = [
            {"id": 1, "type": "Cover", "role": "cover", "title": "封面", "prompt": "封面"},
            {"id": 2, "type": "Content", "role": "step", "title": "步骤一", "prompt": "步骤一"},
            {"id": 3, "type": "Content", "role": "step", "title": "步骤二", "prompt": "步骤二"},
        ]

        guarded = apply_image2_dynamic_intent_guardrails(
            prompts,
            {"intent": "整体画面密度不要那么高"},
        )

        self.assertIn("内容页可见文字控制在 3-5 个短句", guarded[2]["prompt"])
        self.assertNotIn("结尾页可见文字控制在 3-5 个短句", guarded[2]["prompt"])


if __name__ == "__main__":
    unittest.main()
