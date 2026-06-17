from backend.api.routes import visual


def test_no_benchmark_strategy_rewrite_passes_note_strategy_to_generator(monkeypatch):
    captured = {}

    class FakeGenerator:
        def generate_strategy_direct_session(self, **kwargs):
            captured.update(kwargs)
            return {
                "title_candidates": ["旧稿翻新不是改内容最费时"],
                "final_body": "旧稿翻新最费时的不是改内容，而是排版返工。把旧稿导入后先统一正文格式，再修标题、引用和分割线样式，最后处理配图和收束，这样旧内容复用才不会像库存稿。",
                "tags": ["公众号运营"],
                "final_body_source": "strategy_direct",
            }

        def generate_rewrite_session(self, **kwargs):
            raise AssertionError("无对标策略生文应走策略直写链路")

    monkeypatch.setattr(visual, "build_note_visual_plan", lambda **kwargs: {"card_plan": []})
    monkeypatch.setattr("backend.services.viral_content_generator.ViralContentGenerator", lambda: FakeGenerator())

    note_strategy = {
        "id": "strategy_a",
        "label": "旧文翻新不重做型",
        "summary": "抓住旧稿重发时排版返工的痛点。",
        "suggestedTitle": "旧文重发最崩溃的，不是改内容，是格式又要重做一遍",
        "contentAngle": "旧稿翻新实录型",
        "corePainPoints": ["旧稿复制进后台后格式散掉"],
        "coreBenefits": ["用样式中心和一键排版统一观感"],
        "recommendedCardPlan": ["旧稿返工痛点", "统一基础格式", "修层级样式", "处理配图", "完整收束"],
        "productUsageMode": "product_main",
    }

    response = visual._generate_content_blocking(
        visual.GenerateContentRequest(
            product_name="壹伴助手",
            target_audience="公众号编辑",
            product_features="一键排版、样式中心、样式收藏、图片处理",
            benchmark_note=None,
            note_strategy=note_strategy,
        )
    )

    assert response.success is True
    assert captured["note_strategy"] == note_strategy
    assert captured["benchmark_note"]["content_category"] == "旧文翻新不重做型"
    assert response.rewrite_session["final_body_source"] == "strategy_direct"


def test_no_benchmark_strategy_rewrite_failure_returns_error_without_local_fallback(monkeypatch):
    called = {}

    class FakeGenerator:
        def generate_strategy_direct_session(self, **kwargs):
            called["direct_count"] = called.get("direct_count", 0) + 1
            called["direct"] = kwargs
            raise RuntimeError("Connection error.")

        def generate_content(self, **kwargs):
            raise AssertionError("有策略的生文失败后不应进入旧 generate_content 链路")

        def generate_rewrite_session(self, **kwargs):
            raise AssertionError("有策略的生文失败后不应进入旧 rewrite 链路")

    monkeypatch.setattr(visual, "build_note_visual_plan", lambda **kwargs: {"card_plan": []})
    monkeypatch.setattr("backend.services.viral_content_generator.ViralContentGenerator", lambda: FakeGenerator())

    note_strategy = {
        "id": "strategy_b",
        "label": "团队动作标准化",
        "summary": "把个人跟进经验沉淀成团队流程。",
        "suggestedTitle": "同样客户为什么换个人结果差很多",
        "contentAngle": "管理复盘型",
        "corePainPoints": ["客户跟进靠个人习惯，团队结果不稳定"],
        "coreBenefits": ["用SOP和标签让关键动作可复制"],
        "recommendedCardPlan": ["客户漏跟场景", "拆关键动作", "SOP沉淀", "复盘收束"],
        "productUsageMode": "product_main",
    }

    try:
        visual._generate_content_blocking(
            visual.GenerateContentRequest(
                product_name="微伴助手",
                target_audience="私域运营负责人",
                product_features="客户标签、企微SOP、客户跟进提醒",
                benchmark_note=None,
                note_strategy=note_strategy,
            )
        )
    except visual.HTTPException as error:
        caught = error
    else:
        raise AssertionError("模型重试耗尽后应返回 502，而不是本地兜底稿")

    assert "direct" in called
    assert called["direct_count"] == visual.STRATEGY_DIRECT_SYNC_MAX_ATTEMPTS
    assert caught.status_code == 502
    assert "策略正文模型生成失败" in str(caught.detail)


def test_no_benchmark_strategy_rewrite_retries_until_model_success(monkeypatch):
    called = {"direct_count": 0}

    class FakeGenerator:
        def generate_strategy_direct_session(self, **kwargs):
            called["direct_count"] += 1
            if called["direct_count"] == 1:
                raise RuntimeError("Connection error.")
            return {
                "title_candidates": ["老板复盘先看关键动作"],
                "final_body": "客户跟进不能只靠个人经验。先把关键动作拆清楚，再用客户标签和企微SOP沉淀成团队流程，最后复盘哪一步断掉。这样老板看到的不是聊天很热闹，而是关键动作有没有完成。",
                "tags": ["私域运营"],
                "final_body_source": "strategy_direct_repair",
                "revision_notes": ["重试后成功"],
            }

        def generate_content(self, **kwargs):
            raise AssertionError("有策略的生文不应进入旧 generate_content 链路")

        def generate_rewrite_session(self, **kwargs):
            raise AssertionError("有策略的生文不应进入旧 rewrite 链路")

    monkeypatch.setattr(visual.time, "sleep", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(visual, "build_note_visual_plan", lambda **kwargs: {"card_plan": []})
    monkeypatch.setattr("backend.services.viral_content_generator.ViralContentGenerator", lambda: FakeGenerator())

    response = visual._generate_content_blocking(
        visual.GenerateContentRequest(
            product_name="微伴助手",
            target_audience="私域运营负责人",
            product_features="客户标签、企微SOP、客户跟进提醒",
            benchmark_note=None,
            note_strategy={
                "id": "strategy_b",
                "label": "团队动作标准化",
                "summary": "把个人跟进经验沉淀成团队流程。",
                "suggestedTitle": "同样客户为什么换个人结果差很多",
                "contentAngle": "管理复盘型",
                "corePainPoints": ["客户跟进靠个人习惯，团队结果不稳定"],
                "coreBenefits": ["用SOP和标签让关键动作可复制"],
                "recommendedCardPlan": ["客户漏跟场景", "拆关键动作", "SOP沉淀", "复盘收束"],
                "productUsageMode": "product_main",
            },
        )
    )

    assert response.success is True
    assert called["direct_count"] == 2
    assert response.rewrite_session["final_body_source"] == "strategy_direct_repair"
    assert "策略直写模型第 2 次调用成功" in response.rewrite_session["revision_notes"][0]
