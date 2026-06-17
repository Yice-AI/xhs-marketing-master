import unittest
from unittest.mock import AsyncMock, patch

from backend.services.smart_interview_agent import InterviewServiceError, SmartInterviewAgent


class SmartInterviewAgentTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.agent = SmartInterviewAgent(
            user_id="user-test",
            api_key="test-key",
            base_url="https://api.openai.com/v1",
            model="gpt-5.4",
        )
        self.agent.collected_info_snapshot = {
            "marketing_goal": "获取咨询",
            "real_motivation": "最近线索质量下滑",
            "target_scene": "企业微信客户运营",
            "action_goal": "引导咨询",
            "product_name": "Uplog",
            "core_features": "会话存档和活码",
            "target_audience": "企业私域运营",
            "style_preference": "真实、专业",
        }
        self.agent.title_options_snapshot = [
            {"id": 1, "title": "标题一", "style": "专业", "rationale": "理由一"},
            {"id": 2, "title": "标题二", "style": "痛点", "rationale": "理由二"},
        ]
        self.agent.phase = "title_selection"

    async def test_handle_message_routes_title_selection_to_explicit_completion(self):
        with patch.object(self.agent, "_generate_final_content", new=AsyncMock(return_value={
            "action": "complete",
            "message": {"type": "text", "content": "完美！这是为你生成的小红书内容："},
            "result": {
                "title": "标题一",
                "content": "正文",
                "collected_info": self.agent.collected_info_snapshot,
            },
        })) as mocked_generate:
            response = await self.agent.handle_message("[选择标题] 标题一")

        self.assertEqual(response["action"], "complete")
        self.assertEqual(self.agent.selected_title["title"], "标题一")
        mocked_generate.assert_awaited_once_with(feedback="")

    async def test_handle_message_rejects_invalid_title_selection(self):
        with self.assertRaises(InterviewServiceError) as error:
            await self.agent.handle_message("[选择标题] 不存在的标题")

        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(error.exception.kind, "invalid_title_selection")

    async def test_generate_final_content_returns_fixed_complete_payload(self):
        self.agent.selected_title = self.agent.title_options_snapshot[0]
        self.agent.raw_context_notes = ["最近线索质量掉得很明显", "客户经常问会不会丢聊天记录"]

        with patch("backend.services.viral_content_generator.ViralContentGenerator.generate_content_from_interview", return_value={
            "title": "优化后的标题一",
            "content": "这是最终正文",
            "tags": ["私域运营"],
            "estimated_engagement": "高",
            "rationale": "基于访谈上下文生成",
            "rewrite_session": {
                "final_body": "这是最终正文",
                "final_body_source": "candidate_judge",
            },
            "note_strategy": {
                "label": "访谈策略",
            },
        }):
            response = await self.agent._generate_final_content(feedback="")

        self.assertEqual(response["action"], "complete")
        self.assertEqual(response["result"]["title"], "优化后的标题一")
        self.assertEqual(response["result"]["content"], "这是最终正文")
        self.assertEqual(response["result"]["collected_info"]["product_name"], "Uplog")
        self.assertEqual(response["result"]["rewrite_session"]["final_body_source"], "candidate_judge")
        self.assertEqual(response["result"]["note_strategy"]["label"], "访谈策略")

    async def test_generate_final_content_maps_truncated_output_to_readable_error(self):
        self.agent.selected_title = self.agent.title_options_snapshot[0]

        with patch(
            "backend.services.viral_content_generator.ViralContentGenerator.generate_content_from_interview",
            side_effect=RuntimeError("文案模型全部回退失败: 模型输出被截断"),
        ):
            with self.assertRaises(InterviewServiceError) as error:
                await self.agent._generate_final_content(feedback="")

        self.assertEqual(error.exception.status_code, 502)
        self.assertEqual(error.exception.kind, "incomplete_content")
        self.assertIn("拦截残稿", error.exception.message)

    async def test_regenerate_titles_updates_snapshot_without_clearing_context(self):
        self.agent.raw_context_notes = ["我们想做更强一点的问题切口"]

        with patch("backend.services.viral_content_generator.ViralContentGenerator.generate_title_options_from_interview", return_value=[
            {"id": 1, "title": "新标题一", "style": "问题切口", "rationale": "更痛一点"},
            {"id": 2, "title": "新标题二", "style": "收益感", "rationale": "更像成交笔记"},
        ]):
            response = await self.agent.handle_message("[重新生成标题] 想再痛一点")

        self.assertEqual(response["action"], "show_titles")
        self.assertEqual(self.agent.phase, "title_selection")
        self.assertEqual(self.agent.title_options_snapshot[0]["title"], "新标题一")
        self.assertEqual(self.agent.collected_info_snapshot["product_name"], "Uplog")

    async def test_regenerate_content_requires_selected_title(self):
        self.agent.selected_title = None

        with self.assertRaises(InterviewServiceError) as error:
            await self.agent.handle_message("[重新生成正文] 再口语一点")

        self.assertEqual(error.exception.kind, "missing_selected_title")

    async def test_regenerate_content_reuses_selected_title(self):
        self.agent.selected_title = self.agent.title_options_snapshot[1]

        with patch.object(self.agent, "_generate_final_content", new=AsyncMock(return_value={
            "action": "complete",
            "message": {"type": "text", "content": "完美！这是为你生成的小红书内容："},
            "result": {
                "title": "标题二",
                "content": "新的正文",
                "collected_info": self.agent.collected_info_snapshot,
            },
        })) as mocked_generate:
            response = await self.agent.handle_message("[重新生成正文] 再口语一点")

        self.assertEqual(response["result"]["title"], "标题二")
        mocked_generate.assert_awaited_once_with(feedback="再口语一点")

    async def test_show_titles_is_blocked_when_interview_context_is_too_thin(self):
        self.agent.raw_context_notes = ["我不知道写什么才能让大家评论关注我"]
        self.agent.collected_info_snapshot = {
            "product_name": "Uplog",
            "core_features": "一键导入、模板套用、自动分页、水印、敏感词检测",
            "target_audience": "小编，自媒体",
        }
        thin_show_titles = {
            "action": "show_titles",
            "title_options": [{"id": 1, "title": "做小红书别硬扛"}],
            "collected_info": {
                "marketing_goal": "让更多小编意识到做图文能省时间",
                "real_motivation": "不知道写什么才能带来评论和关注",
                "target_scene": "经常做小红书图文、每天赶内容的小编",
                "action_goal": "引导读者在评论区聊问题",
            },
        }

        response = self.agent._enforce_readiness_gate(thin_show_titles)

        self.assertEqual(response["action"], "ask")
        self.assertIn("最真实的卡点", response["message"]["content"])
        self.assertEqual(response["progress"], 75)

    async def test_title_selection_asks_followup_when_existing_session_is_not_ready(self):
        self.agent.raw_context_notes = ["不知道写什么才能有评论"]
        self.agent.collected_info_snapshot = {
            "product_name": "Uplog",
            "core_features": "一键导入、模板套用、自动分页、水印、敏感词检测",
            "target_audience": "小编，自媒体",
            "marketing_goal": "互动",
            "real_motivation": "不知道写什么",
            "target_scene": "小红书小编",
            "action_goal": "评论关注",
        }

        response = await self.agent.handle_message("[选择标题] 标题一")

        self.assertEqual(response["action"], "ask")
        self.assertEqual(self.agent.phase, "asking")
        self.assertEqual(self.agent.selected_title["title"], "标题一")

    async def test_regenerate_content_uses_revision_for_local_edit(self):
        long_body = (
            "最近线索质量掉得很明显，很多运营第一反应是继续加预算。\n\n"
            "但真正卡住的地方，往往是客户进来之后没人及时接住。\n\n"
            "可以先看来源、标签和跟进记录有没有串起来，再决定要不要换素材。\n\n"
            "如果你也遇到类似情况，可以先从这三个点自查。"
        )
        self.agent.selected_title = self.agent.title_options_snapshot[0]
        self.agent.final_result_snapshot = {
            "title": "标题一",
            "content": long_body,
            "collected_info": self.agent.collected_info_snapshot,
            "rewrite_session": {"final_body": long_body},
        }

        with patch("backend.services.viral_content_generator.ViralContentGenerator.revise_confirmation_note", return_value={
            "detected_scope": "closing",
            "updated_fields": {
                "title": "标题一",
                "opening": "最近线索质量掉得很明显，很多运营第一反应是继续加预算。",
                "body": (
                    "但真正卡住的地方，往往是客户进来之后没人及时接住。\n\n"
                    "可以先看来源、标签和跟进记录有没有串起来，再决定要不要换素材。"
                ),
                "closing": "如果你也遇到类似情况，先从这三个点自查一下。",
            },
            "updated_rewrite_session": {"final_body": long_body, "final_body_source": "custom_revision"},
        }) as mocked_revision, patch.object(self.agent, "_generate_final_content", new=AsyncMock()) as mocked_generate:
            response = await self.agent.handle_message("[重新生成正文] 结尾更口语一点")

        self.assertEqual(response["action"], "complete")
        self.assertIn("先从这三个点自查一下", response["result"]["content"])
        self.assertEqual(response["result"]["rewrite_session"]["final_body"], response["result"]["content"])
        mocked_revision.assert_called_once()
        mocked_generate.assert_not_awaited()

    def test_snapshot_roundtrip_restores_agent_state(self):
        self.agent.conversation_history = [
            {"role": "user", "content": "想做获客"},
            {"role": "assistant", "content": "{\"action\":\"show_titles\"}"},
        ]
        self.agent.phase = "title_selection"
        self.agent.selected_title = self.agent.title_options_snapshot[0]
        self.agent.final_result_snapshot = {"title": "标题一", "content": "正文"}
        self.agent.raw_context_notes = ["最近线索质量下滑"]

        restored = SmartInterviewAgent.from_snapshot(
            self.agent.to_snapshot(),
            api_key="test-key",
            base_url="https://api.openai.com/v1",
            model="gpt-5.4",
        )

        self.assertEqual(restored.phase, "title_selection")
        self.assertEqual(restored.conversation_history[0]["content"], "想做获客")
        self.assertEqual(restored.selected_title["title"], "标题一")
        self.assertEqual(restored.final_result_snapshot["content"], "正文")
        self.assertEqual(restored.raw_context_notes, ["最近线索质量下滑"])


if __name__ == "__main__":
    unittest.main()
