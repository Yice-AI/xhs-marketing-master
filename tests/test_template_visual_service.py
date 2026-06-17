from backend.services.template_visual_service import build_note_visual_plan


def test_build_note_visual_plan_keeps_four_feature_cards_for_uplog_workflow():
    plan = build_note_visual_plan(
        title="Uplog 从导入到发布检查",
        content="复制粘贴很麻烦，Uplog 可以一键导入、AI整理表达、模板分页、发布前检查。",
        product_name="Uplog",
        target_audience="小红书运营和公众号小编",
        product_features="一键导入，AI写作，模板分页，违规检测",
        note_strategy={
            "coreBenefits": ["一键导入", "AI整理表达", "模板分页", "发布前检查"],
            "recommendedCardPlan": ["封面", "导入页", "AI写作页", "模板分页页", "发布检查页"],
        },
    )

    card_titles = [item["title"] for item in plan["card_plan"]]

    assert len(plan["card_plan"]) == 6
    assert card_titles[0].startswith("Uplog")
    assert "一键导入" in card_titles
    assert "AI写作" in card_titles
    assert "自动分页" in card_titles
    assert "违规检测" in card_titles
