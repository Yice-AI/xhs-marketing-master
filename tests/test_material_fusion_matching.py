import unittest

from backend.api.routes.visual import (
    MATERIAL_FUSION_MAX_IMAGE_COUNT,
    _extract_material_asset_detail_tags,
    _extract_material_keywords,
    _resolve_material_fusion_plan_items,
    _sanitize_organized_asset_tags,
    _validate_material_fusion_primary_match,
)


class MaterialFusionMatchingTest(unittest.TestCase):
    def test_generic_flow_does_not_trigger_sop_keyword(self):
        self.assertNotIn("SOP", _extract_material_keywords("4步流程讲清楚销售订单页面怎么用"))
        self.assertIn("SOP", _extract_material_keywords("自动化SOP配置页面"))

    def test_uplog_feature_synonyms_normalize_for_matching(self):
        self.assertIn("智能排版", _extract_material_keywords("一键排版后自动生成正文结构"))
        self.assertIn("自动分页", _extract_material_keywords("模板分页页展示卡片分页效果"))
        self.assertIn("违规检测", _extract_material_keywords("发布检查里有发前检查和风险检测"))
        self.assertIn("AI写作", _extract_material_keywords("AI整理表达和写作工具栏"))
        self.assertIn("一键导入", _extract_material_keywords("文章导入页支持复制粘贴"))

    def test_asset_detail_tags_use_specific_feature_labels(self):
        tags = _extract_material_asset_detail_tags("一键排版 模板分页 发前检查 AI整理表达 文章导入")

        self.assertIn("智能排版", tags)
        self.assertIn("自动分页", tags)
        self.assertIn("违规检测", tags)
        self.assertIn("AI写作", tags)
        self.assertIn("一键导入", tags)
        self.assertNotIn("SOP", _extract_material_asset_detail_tags("普通流程说明页"))

    def test_sanitize_organized_tags_augments_generic_tags_from_asset_text(self):
        tags = _sanitize_organized_asset_tags(
            ["功能截图"],
            {
                "original_name": "uplog_模板分页_发前检查.png",
                "display_name": "",
                "note": "",
                "ai_hint": "",
                "tags": [],
            },
            {"display_name": "Uplog 发布检查页", "tags": ["功能截图"], "ai_hint": ""},
        )

        self.assertIn("功能截图", tags)
        self.assertIn("自动分页", tags)
        self.assertIn("违规检测", tags)

    def test_manual_selection_can_continue_on_keyword_mismatch(self):
        ok, reason = _validate_material_fusion_primary_match(
            {
                "id": "2-feature",
                "title": "一键导入素材",
                "requiredKeywords": ["一键导入"],
                "selectionSource": "manual",
                "matchScore": 0,
            },
            {
                "id": "asset-sales-order",
                "display_name": "销售订单管理后台页面",
                "tags": ["销售订单", "后台页面"],
                "ai_hint": "销售订单管理列表截图",
            },
        )

        self.assertTrue(ok)
        self.assertIn("手动选择", reason)

    def test_logo_cannot_be_primary_even_when_manual(self):
        ok, reason = _validate_material_fusion_primary_match(
            {
                "id": "1-cover",
                "title": "产品首页",
                "requiredKeywords": ["产品首页"],
                "selectionSource": "manual",
            },
            {
                "id": "asset-logo",
                "display_name": "微伴助手 Logo",
                "tags": ["logo", "品牌标识"],
                "ai_hint": "品牌 logo",
            },
        )

        self.assertFalse(ok)
        self.assertIn("Logo", reason)

    def test_auto_validation_accepts_partial_required_keyword_overlap(self):
        ok, reason = _validate_material_fusion_primary_match(
            {
                "id": "2-feature",
                "title": "一键导入后自动排版",
                "requiredKeywords": ["一键导入", "智能排版"],
                "selectionSource": "auto",
                "matchScore": 16,
            },
            {
                "id": "asset-import",
                "display_name": "Uplog 文章导入页",
                "tags": ["功能截图", "一键导入"],
                "ai_hint": "这是 Uplog 文章导入功能截图",
            },
        )

        self.assertTrue(ok, reason)

    def test_material_fusion_plan_items_are_not_limited_to_four(self):
        plan = [
            {"id": f"{index}-feature", "primaryAssetId": f"asset-{index}"}
            for index in range(1, MATERIAL_FUSION_MAX_IMAGE_COUNT + 1)
        ]

        items = _resolve_material_fusion_plan_items(plan, [])

        self.assertEqual(len(items), MATERIAL_FUSION_MAX_IMAGE_COUNT)


if __name__ == "__main__":
    unittest.main()
