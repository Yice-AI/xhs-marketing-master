import asyncio
from unittest.mock import patch

from backend.api.routes import visual


def test_generate_note_strategy_saves_best_effort_log():
    captured = {}
    captured_strategy_kwargs = {}

    async def passthrough(func, *args, **kwargs):
        kwargs.pop("timeout_seconds", None)
        captured_strategy_kwargs.update(kwargs)
        return func(*args, use_model=False, **kwargs)

    def fake_save(payload):
        captured.update(payload)
        return "log-1"

    request = visual.StrategyRequest(
        research_context={
            "product_name": "微伴助手",
            "summary": "企业微信私域 SCRM 工具",
            "target_audience_insights": ["企业老板"],
            "core_features": ["客户分层"],
            "use_cases": ["私域转化"],
            "differentiators": ["合规风控"],
        },
        benchmark_note=None,
        real_phrases=["客户跟进"],
        strategy_mode="research_first",
        strategy_feedback="三套方向差异大一点",
    )

    with patch("backend.api.routes.visual._run_strategy_blocking_with_timeout", side_effect=passthrough), \
        patch("backend.api.routes.visual.list_recent_note_strategy_signals", return_value=["老板诊断｜经营问题拆解"]), \
        patch("backend.api.routes.visual.save_note_strategy_log", side_effect=fake_save):
        response = asyncio.run(visual._generate_note_strategy_for_user(
            request,
            "api:external-api:test:operator-a",
        ))

    assert response.success is True
    assert response.data["product_usage_mode"] == "product_main"
    assert captured["user_id"] == "api:external-api:test:operator-a"
    assert captured["product_name"] == "微伴助手"
    assert captured["strategy_mode"] == "research_first"
    assert captured["real_phrases"] == ["客户跟进"]
    assert captured["strategy_feedback"] == "三套方向差异大一点"
    assert captured["response_payload"]["selected_strategy_id"]
    assert captured["response_payload"]["strategies"]
    assert captured_strategy_kwargs["recent_strategy_signals"] == ["老板诊断｜经营问题拆解"]
